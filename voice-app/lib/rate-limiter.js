/**
 * Rate Limiter for SIP calls
 * In-memory sliding window rate limiter to block spam callers
 */

const logger = require('./logger');

class RateLimiter {
  /**
   * @param {Object} options
   * @param {number} options.maxCalls - Max calls per window (default: 5)
   * @param {number} options.windowMs - Window size in ms (default: 60000 = 1 minute)
   * @param {string[]} options.whitelist - Phone numbers that bypass rate limiting
   */
  constructor(options = {}) {
    this.maxCalls = options.maxCalls || 5;
    this.windowMs = options.windowMs || 60000;
    this.whitelist = new Set(options.whitelist || []);

    // Map of callerId -> array of timestamps
    this._attempts = new Map();

    // Cleanup stale entries every 5 minutes
    this._cleanupInterval = setInterval(() => this._cleanup(), 5 * 60 * 1000);
  }

  /**
   * Add a number to the whitelist
   */
  addWhitelist(number) {
    this.whitelist.add(number);
    // Also add without +1 prefix for matching flexibility
    if (number.startsWith('+1')) {
      this.whitelist.add(number.slice(2));
    }
    if (number.startsWith('1') && number.length === 11) {
      this.whitelist.add('+' + number);
    }
  }

  /**
   * Check if a caller is allowed (not rate limited)
   * @param {string} callerId - The caller's phone number
   * @returns {{ allowed: boolean, reason?: string, count?: number }}
   */
  check(callerId) {
    if (!callerId || callerId === 'unknown') {
      // Allow unknown callers but log it
      return { allowed: true };
    }

    // Normalize: strip + prefix for comparison
    const normalized = callerId.replace(/^\+/, '');

    // Check whitelist
    if (this.whitelist.has(callerId) || this.whitelist.has(normalized) || this.whitelist.has('+' + normalized)) {
      return { allowed: true };
    }

    const now = Date.now();
    const windowStart = now - this.windowMs;

    // Get or create attempts array
    let attempts = this._attempts.get(normalized) || [];

    // Filter to only attempts within window
    attempts = attempts.filter(ts => ts > windowStart);

    // Check rate
    if (attempts.length >= this.maxCalls) {
      logger.warn('Rate limit exceeded', {
        callerId,
        count: attempts.length,
        maxCalls: this.maxCalls,
        windowMs: this.windowMs
      });

      return {
        allowed: false,
        reason: 'rate_limit_exceeded',
        count: attempts.length
      };
    }

    // Record this attempt
    attempts.push(now);
    this._attempts.set(normalized, attempts);

    return { allowed: true, count: attempts.length };
  }

  /**
   * Get current rate limit status for all tracked callers
   */
  getStatus() {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    const status = {};

    for (const [callerId, attempts] of this._attempts.entries()) {
      const recent = attempts.filter(ts => ts > windowStart);
      if (recent.length > 0) {
        status[callerId] = {
          count: recent.length,
          limited: recent.length >= this.maxCalls,
          oldestAttempt: new Date(Math.min(...recent)).toISOString()
        };
      }
    }

    return status;
  }

  /**
   * Cleanup stale entries
   */
  _cleanup() {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    let removed = 0;

    for (const [callerId, attempts] of this._attempts.entries()) {
      const recent = attempts.filter(ts => ts > windowStart);
      if (recent.length === 0) {
        this._attempts.delete(callerId);
        removed++;
      } else {
        this._attempts.set(callerId, recent);
      }
    }

    if (removed > 0) {
      logger.debug('Rate limiter cleanup', { removed });
    }
  }

  stop() {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
    }
  }
}

module.exports = RateLimiter;
