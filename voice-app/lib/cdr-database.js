/**
 * Call Detail Record (CDR) Database
 * SQLite-based persistent storage for call logs and transcripts
 */

const crypto = require('crypto');
const logger = require('./logger');

let Database;
try {
  Database = require('better-sqlite3');
} catch (err) {
  logger.error('better-sqlite3 not available', { error: err.message });
}

class CdrDatabase {
  constructor(dbPath) {
    if (!Database) {
      throw new Error('better-sqlite3 is required for call logging');
    }

    this.dbPath = dbPath || '/data/calls.db';
    this.db = new Database(this.dbPath);

    // Enable WAL mode for better concurrent read/write
    this.db.pragma('journal_mode = WAL');

    this._createTables();
    this._prepareStatements();
    logger.info('CDR database initialized', { path: this.dbPath });
  }

  _createTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        call_uuid TEXT UNIQUE NOT NULL,
        direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
        caller_id TEXT,
        dialed_ext TEXT,
        device_name TEXT,
        start_time TEXT NOT NULL DEFAULT (datetime('now')),
        end_time TEXT,
        duration_seconds REAL,
        status TEXT NOT NULL DEFAULT 'active',
        turn_count INTEGER DEFAULT 0,
        end_reason TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS transcripts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        call_uuid TEXT NOT NULL,
        turn_number INTEGER NOT NULL,
        speaker TEXT NOT NULL CHECK(speaker IN ('caller', 'eve')),
        text TEXT NOT NULL,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (call_uuid) REFERENCES calls(call_uuid)
      );

      CREATE INDEX IF NOT EXISTS idx_calls_start_time ON calls(start_time);
      CREATE INDEX IF NOT EXISTS idx_calls_caller_id ON calls(caller_id);
      CREATE INDEX IF NOT EXISTS idx_calls_status ON calls(status);
      CREATE INDEX IF NOT EXISTS idx_transcripts_call_uuid ON transcripts(call_uuid);
    `);
  }

  _prepareStatements() {
    this._stmtStartCall = this.db.prepare(`
      INSERT INTO calls (call_uuid, direction, caller_id, dialed_ext, device_name, start_time, status)
      VALUES (?, ?, ?, ?, ?, datetime('now'), 'active')
    `);

    this._stmtEndCall = this.db.prepare(`
      UPDATE calls
      SET end_time = datetime('now'),
          duration_seconds = ROUND((julianday(datetime('now')) - julianday(start_time)) * 86400, 1),
          status = ?,
          turn_count = ?,
          end_reason = ?
      WHERE call_uuid = ?
    `);

    this._stmtLogTranscript = this.db.prepare(`
      INSERT INTO transcripts (call_uuid, turn_number, speaker, text, timestamp)
      VALUES (?, ?, ?, ?, datetime('now'))
    `);

    this._stmtBlockedCall = this.db.prepare(`
      INSERT INTO calls (call_uuid, direction, caller_id, dialed_ext, start_time, end_time, duration_seconds, status, end_reason)
      VALUES (?, 'inbound', ?, ?, datetime('now'), datetime('now'), 0, 'blocked', ?)
    `);

    this._stmtGetTranscript = this.db.prepare(`
      SELECT * FROM transcripts WHERE call_uuid = ? ORDER BY turn_number, id
    `);

    this._stmtHistoryAll = this.db.prepare(`
      SELECT * FROM calls ORDER BY start_time DESC LIMIT ?
    `);

    this._stmtHistorySince = this.db.prepare(`
      SELECT * FROM calls WHERE start_time >= ? ORDER BY start_time DESC LIMIT ?
    `);

    this._stmtStatsToday = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN direction = 'inbound' THEN 1 ELSE 0 END) as inbound,
        SUM(CASE WHEN direction = 'outbound' THEN 1 ELSE 0 END) as outbound,
        SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) as blocked,
        ROUND(AVG(CASE WHEN duration_seconds > 0 THEN duration_seconds END), 1) as avg_duration
      FROM calls
      WHERE start_time >= date('now')
    `);

    this._stmtStatsAll = this.db.prepare(`
      SELECT COUNT(*) as total FROM calls
    `);
  }

  /**
   * Log a new call start
   */
  startCall({ callUuid, direction, callerId, dialedExt, deviceName }) {
    try {
      this._stmtStartCall.run(callUuid, direction, callerId || 'unknown', dialedExt || null, deviceName || null);
      logger.info('CDR: Call started', { callUuid, direction, callerId });
    } catch (err) {
      logger.error('CDR: Failed to log call start', { callUuid, error: err.message });
    }
  }

  /**
   * Log call end
   */
  endCall({ callUuid, status, turnCount, endReason }) {
    try {
      this._stmtEndCall.run(status || 'completed', turnCount || 0, endReason || null, callUuid);
      logger.info('CDR: Call ended', { callUuid, status, turnCount });
    } catch (err) {
      logger.error('CDR: Failed to log call end', { callUuid, error: err.message });
    }
  }

  /**
   * Log a transcript entry (caller utterance or Eve response)
   */
  logTranscript({ callUuid, turnNumber, speaker, text }) {
    try {
      this._stmtLogTranscript.run(callUuid, turnNumber, speaker, text);
    } catch (err) {
      logger.error('CDR: Failed to log transcript', { callUuid, turnNumber, error: err.message });
    }
  }

  /**
   * Log a blocked/rejected call (no conversation, just the attempt)
   */
  logBlockedCall({ callerId, dialedExt, reason }) {
    try {
      const callUuid = 'blocked-' + Date.now() + '-' + crypto.randomBytes(6).toString('hex');
      this._stmtBlockedCall.run(callUuid, callerId, dialedExt, reason);
      logger.info('CDR: Blocked call logged', { callerId, reason });
    } catch (err) {
      logger.error('CDR: Failed to log blocked call', { callerId, error: err.message });
    }
  }

  /**
   * Get recent call history (metadata only; use getTranscript for full text)
   */
  getHistory({ limit = 50, since = null } = {}) {
    try {
      if (since) {
        return this._stmtHistorySince.all(since, limit);
      }
      return this._stmtHistoryAll.all(limit);
    } catch (err) {
      logger.error('CDR: Failed to get history', { error: err.message });
      return [];
    }
  }

  /**
   * Get transcript for a specific call
   */
  getTranscript(callUuid) {
    try {
      return this._stmtGetTranscript.all(callUuid);
    } catch (err) {
      logger.error('CDR: Failed to get transcript', { callUuid, error: err.message });
      return [];
    }
  }

  /**
   * Get call stats summary
   */
  getStats() {
    try {
      const today = this._stmtStatsToday.get();
      const allTime = this._stmtStatsAll.get();
      return { today, allTime: allTime.total };
    } catch (err) {
      logger.error('CDR: Failed to get stats', { error: err.message });
      return { today: {}, allTime: 0 };
    }
  }

  close() {
    if (this.db) {
      this.db.close();
      logger.info('CDR database closed');
    }
  }
}

module.exports = CdrDatabase;
