/**
 * Voicemail Detector
 * Detects voicemail greetings by listening to audio after call connects.
 *
 * Strategy:
 * - Fork audio immediately after call connects
 * - Listen for speech patterns that indicate a voicemail greeting
 * - A voicemail greeting: speech starts quickly and plays continuously for 3+ seconds
 * - A human answer: short utterance ("Hello?") then silence
 * - Wait for the greeting to finish (silence after speech), then signal ready
 *
 * Returns: { isVoicemail: boolean, waitedMs: number }
 */

const logger = require('./logger');

// Detection thresholds
const GREETING_MIN_MS = 3000;         // Voicemail greetings are at least 3s
const POST_GREETING_SILENCE_MS = 1500; // Wait 1.5s of silence after greeting ends
const MAX_WAIT_MS = 30000;            // Give up after 30s
const RECENT_SPEECH_MS = 2000;        // Speech within last 2s = "still talking"
const HUMAN_DECISION_MS = 6000;       // Wait at least 6s before deciding "human"

/**
 * Detect whether a voicemail system answered and wait for the greeting to finish.
 *
 * @param {Object} endpoint - FreeSWITCH endpoint (already connected)
 * @param {Object} audioForkServer - AudioForkServer instance
 * @param {string} callUuid - Unique call identifier (from endpoint)
 * @param {Object} [options]
 * @param {number} [options.wsPort=3001] - WebSocket port for audio fork
 * @param {number} [options.maxWaitMs=30000] - Max time to wait for greeting to end
 * @returns {Promise<{ isVoicemail: boolean, waitedMs: number }>}
 */
async function detectVoicemail(endpoint, audioForkServer, callUuid, options) {
  options = options || {};
  const wsPort = options.wsPort || 3001;
  const maxWaitMs = options.maxWaitMs || MAX_WAIT_MS;

  const startTime = Date.now();

  logger.info('Starting voicemail detection', { callUuid, maxWaitMs });

  // Set up audio fork to listen to what the remote party is saying
  const wsUrl = 'ws://127.0.0.1:' + wsPort + '/' + encodeURIComponent(callUuid);

  let sessionPromise;
  try {
    sessionPromise = audioForkServer.expectSession(callUuid, { timeoutMs: 10000 });
  } catch (err) {
    logger.warn('Failed to set up voicemail detection session', {
      callUuid,
      error: err.message
    });
    return { isVoicemail: false, waitedMs: Date.now() - startTime };
  }

  await endpoint.forkAudioStart({
    wsUrl: wsUrl,
    mixType: 'mono',
    sampling: '16k'
  });

  let session;
  try {
    session = await sessionPromise;
    logger.info('Voicemail detection audio fork connected', { callUuid });
  } catch (err) {
    logger.warn('Voicemail detection audio fork failed', {
      callUuid,
      error: err.message
    });
    if (audioForkServer.cancelExpectation) {
      audioForkServer.cancelExpectation(callUuid);
    }
    try { await endpoint.forkAudioStop(); } catch (e) { /* ignore */ }
    return { isVoicemail: false, waitedMs: Date.now() - startTime };
  }

  // Now listen to the audio stream and detect patterns
  try {
    const result = await listenForGreeting(session, callUuid, maxWaitMs);

    // Stop the audio fork
    try { await endpoint.forkAudioStop(); } catch (e) { /* ignore */ }

    const waitedMs = Date.now() - startTime;

    logger.info('Voicemail detection complete', {
      callUuid,
      isVoicemail: result.isVoicemail,
      speechDurationMs: result.speechDurationMs,
      waitedMs
    });

    return { isVoicemail: result.isVoicemail, waitedMs };

  } catch (err) {
    logger.warn('Voicemail detection error', {
      callUuid,
      error: err.message
    });
    try { await endpoint.forkAudioStop(); } catch (e) { /* ignore */ }
    return { isVoicemail: false, waitedMs: Date.now() - startTime };
  }
}

/**
 * Listen to the audio fork session and determine if it's a voicemail greeting.
 *
 * We track speech/silence transitions:
 * - If we hear continuous speech for 3+ seconds, it's likely a greeting
 * - Once the greeting speech stops (silence for 1.5s+), the greeting is done
 * - If we hear short speech (<2.5s) then silence, it's a human
 *
 * @param {Object} session - AudioForkSession
 * @param {string} callUuid - Call ID for logging
 * @param {number} maxWaitMs - Maximum wait time
 * @returns {Promise<{ isVoicemail: boolean, speechDurationMs: number }>}
 */
function listenForGreeting(session, callUuid, maxWaitMs) {
  return new Promise(function(resolve) {
    const startTime = Date.now();
    let lastSpeechTime = null;       // Last time we heard ANY speech
    let firstSpeechTime = null;      // When speech first started
    let totalSpeechChunks = 0;       // Count of chunks that had speech
    let totalChunks = 0;             // Total audio chunks received
    let resolved = false;

    // Disable the session's normal utterance detection
    session.setCaptureEnabled(false);

    function cleanup() {
      clearTimeout(maxTimer);
      clearInterval(checkInterval);
    }

    function finish(isVoicemail, reason) {
      if (resolved) return;
      resolved = true;
      cleanup();

      var elapsedMs = firstSpeechTime ? (lastSpeechTime || Date.now()) - firstSpeechTime : 0;
      logger.info('Voicemail detection decided', {
        callUuid,
        isVoicemail,
        reason,
        speechSpanMs: elapsedMs,
        speechChunks: totalSpeechChunks,
        totalChunks: totalChunks,
        elapsed: Date.now() - startTime
      });

      resolve({ isVoicemail, speechDurationMs: elapsedMs });
    }

    // Max wait timeout
    var maxTimer = setTimeout(function() {
      var speechSpan = firstSpeechTime ? (lastSpeechTime || Date.now()) - firstSpeechTime : 0;
      finish(speechSpan >= GREETING_MIN_MS, 'max_wait');
    }, maxWaitMs);

    // Process raw audio for VAD
    session.ws.removeAllListeners('message');
    session.ws.on('message', function(data) {
      if (resolved) return;

      // Handle metadata strings
      if (typeof data === 'string') {
        try {
          var meta = JSON.parse(data);
          if (meta && meta.sampleRate && Number.isFinite(Number(meta.sampleRate))) {
            session.sampleRate = Number(meta.sampleRate);
          }
        } catch (e) { /* ignore */ }
        return;
      }

      if (!Buffer.isBuffer(data) || data.length < 2) return;

      totalChunks++;

      // Detect endianness on first chunk
      if (!session._pcmEndian) {
        session._pcmEndian = session._detectEndian(data);
      }

      if (session._isSpeech(data)) {
        totalSpeechChunks++;
        if (!firstSpeechTime) firstSpeechTime = Date.now();
        lastSpeechTime = Date.now();
      }
    });

    // Periodic decision check (every 500ms)
    var checkInterval = setInterval(function() {
      if (resolved) return;

      var now = Date.now();
      var elapsed = now - startTime;
      var speechSpan = firstSpeechTime ? (lastSpeechTime || now) - firstSpeechTime : 0;
      var timeSinceLastSpeech = lastSpeechTime ? now - lastSpeechTime : Infinity;
      var recentlySpeaking = timeSinceLastSpeech < RECENT_SPEECH_MS;

      // Don't decide anything if speech is still happening
      if (recentlySpeaking) return;

      // Speech has stopped for 2+ seconds — time to decide

      if (speechSpan >= GREETING_MIN_MS && timeSinceLastSpeech >= POST_GREETING_SILENCE_MS) {
        // Long speech followed by silence = voicemail greeting finished
        finish(true, 'greeting_ended');
        return;
      }

      if (elapsed >= HUMAN_DECISION_MS && speechSpan < GREETING_MIN_MS) {
        // 6+ seconds elapsed, speech was short or absent, and nobody's talking = human
        finish(false, 'human_short_speech');
        return;
      }
    }, 500);

    // Handle session close
    session.on('close', function() {
      if (resolved) return;
      var speechSpan = firstSpeechTime ? (lastSpeechTime || Date.now()) - firstSpeechTime : 0;
      finish(speechSpan >= GREETING_MIN_MS, 'session_closed');
    });

    session.on('error', function() {
      finish(false, 'session_error');
    });
  });
}

module.exports = { detectVoicemail };
