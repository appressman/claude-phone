/**
 * SIP Call Handler
 * v13: Uses shared conversation-loop.js, CDR logging, rate limiting
 */

const logger = require('./logger');
const { runConversationLoop } = require('./conversation-loop');

function extractCallerId(req) {
  var from = req.get("From") || "";
  var match = from.match(/sip:([+\d]+)@/);
  if (match) return match[1];
  var numMatch = from.match(/<sip:(\d+)@/);
  if (numMatch) return numMatch[1];
  return "unknown";
}

/**
 * Extract dialed extension from SIP To header
 */
function extractDialedExtension(req) {
  var to = req.get("To") || "";
  var match = to.match(/sip:([\w-]+)@/);
  if (match) {
    return match[1];
  }
  return null;
}

/**
 * Strip video tracks from SDP (FreeSWITCH doesn't support H.261 and rejects with 488)
 * Keeps only audio tracks to ensure codec negotiation succeeds
 */
function stripVideoFromSdp(sdp) {
  if (!sdp) return sdp;

  const lines = sdp.split('\r\n');
  const result = [];
  let inVideoSection = false;

  for (const line of lines) {
    if (line.startsWith('m=video')) {
      inVideoSection = true;
      continue;
    }

    if (line.startsWith('m=') && !line.startsWith('m=video')) {
      inVideoSection = false;
    }

    if (inVideoSection) {
      continue;
    }

    result.push(line);
  }

  return result.join('\r\n');
}

/**
 * Handle incoming SIP INVITE
 */
async function handleInvite(req, res, options) {
  const { mediaServer, deviceRegistry, rateLimiter, cdrDatabase } = options;

  const callerId = extractCallerId(req);
  const dialedExt = extractDialedExtension(req);

  logger.info('Incoming call', { callerId, dialedExt: dialedExt || 'unknown' });

  // Rate limiting check
  if (rateLimiter) {
    const rateCheck = rateLimiter.check(callerId);
    if (!rateCheck.allowed) {
      logger.warn('Call blocked by rate limiter', { callerId, reason: rateCheck.reason, count: rateCheck.count });
      if (cdrDatabase) {
        cdrDatabase.logBlockedCall({ callerId, dialedExt, reason: rateCheck.reason });
      }
      try { res.send(486); } catch (e) {}
      return null;
    }
  }

  // Look up device config
  let deviceConfig = null;
  if (deviceRegistry && dialedExt) {
    deviceConfig = deviceRegistry.get(dialedExt);
    if (deviceConfig) {
      logger.info('Device matched', { device: deviceConfig.name, ext: dialedExt });
    } else {
      logger.info('Unknown extension, using default', { ext: dialedExt });
      deviceConfig = deviceRegistry.getDefault();
    }
  }

  try {
    // Strip video from SDP to avoid FreeSWITCH 488 error
    const originalSdp = req.body;
    const audioOnlySdp = stripVideoFromSdp(originalSdp);
    if (originalSdp !== audioOnlySdp) {
      logger.info('Stripped video track from SDP');
    }

    const result = await mediaServer.connectCaller(req, res, { remoteSdp: audioOnlySdp });
    const { endpoint, dialog } = result;
    const callUuid = endpoint.uuid;

    logger.info('Call connected', { callUuid });

    // Log call start to CDR
    if (cdrDatabase) {
      cdrDatabase.startCall({
        callUuid,
        direction: 'inbound',
        callerId,
        dialedExt,
        deviceName: deviceConfig ? deviceConfig.name : 'default'
      });
    }

    dialog.on('destroy', function() {
      logger.info('Call ended (dialog destroyed)', { callUuid });
      if (endpoint) endpoint.destroy().catch(function() {});
    });

    // Use shared conversation loop (same as outbound calls)
    await runConversationLoop(endpoint, dialog, callUuid, {
      audioForkServer: options.audioForkServer,
      whisperClient: options.whisperClient,
      claudeBridge: options.claudeBridge,
      ttsService: options.ttsService,
      wsPort: options.wsPort,
      deviceConfig,
      cdrDatabase
    });

    return { endpoint, dialog, callerId, callUuid };

  } catch (error) {
    logger.error('Call error', { error: error.message });
    try { res.send(500); } catch (e) {}
    throw error;
  }
}

module.exports = {
  handleInvite: handleInvite,
  extractCallerId: extractCallerId,
  extractDialedExtension: extractDialedExtension
};
