// ─── gateway/syncServer.mjs ──────────────────────────────────────────────────
// RONIN Sync Protocol — WebSocket Server (G1)
//
// Purpose: The spine of RONIN Everywhere. Every surface — macOS, iOS, Android,
// Web, CLI, watchOS, KAGE, Ambient — connects through this single WebSocket
// server. No third-party channels. No webhook ingress. One protocol.
//
// Responsibilities:
//   1. Connection lifecycle — accept, authenticate, heartbeat, disconnect
//   2. Message routing — parse RONIN Sync frames, dispatch to handlers
//   3. Session multiplexing — multiple devices in one session
//   4. Broadcasting — send to all devices in a session
//   5. Targeted delivery — send to a specific device
//
// Message Frame (RONIN Sync Protocol):
//   { type, session_id, device_id, payload, ts }
//
// Invariants:
//   - Every message has a type. Invalid type → reject with error frame.
//   - Device must register (device.register) before sending any other message.
//   - Heartbeat interval is 30s. 3 missed heartbeats → auto-disconnect.
//   - Session ID is the universal key. Multiple devices can share one session.
//   - Server NEVER exposes model identity in any outbound message (ADR-006).
//
// Provider Injection:
//   createSyncServer({ wsProvider }) — for testing without real WebSocket.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'crypto';

// ─── Constants ───────────────────────────────────────────────────────────────

export const HEARTBEAT_INTERVAL_MS = 30_000;
export const MISSED_HEARTBEAT_LIMIT = 3;

export const MESSAGE_TYPES = Object.freeze({
  // Client → Gateway
  CHAT_SEND:        'chat.send',
  VOICE_START:      'voice.start',
  VOICE_CHUNK:      'voice.chunk',
  VOICE_END:        'voice.end',
  PRESENCE_PING:    'presence.ping',
  SESSION_HANDOFF:  'session.handoff',
  DEVICE_REGISTER:  'device.register',
  DEVICE_REVOKE:    'device.revoke',

  // Gateway → Client
  CHAT_TOKEN:       'chat.token',
  CHAT_COMPLETE:    'chat.complete',
  ARTIFACT_STREAM:  'artifact.stream',
  ARTIFACT_COMPLETE:'artifact.complete',
  JOB_SUBMITTED:    'job.submitted',
  JOB_PROGRESS:     'job.progress',
  JOB_COMPLETE:     'job.complete',
  PRESENCE_STATUS:  'presence.status',
  SESSION_SYNC:     'session.sync',
  MEMORY_UPDATE:    'memory.update',
});

// Bidirectional types (can go either direction)
const BIDIRECTIONAL = new Set([
  MESSAGE_TYPES.VOICE_CHUNK,
  MESSAGE_TYPES.VOICE_END,
]);

// Types that require registration first
const REQUIRES_REGISTRATION = new Set(
  Object.values(MESSAGE_TYPES).filter(t => t !== MESSAGE_TYPES.DEVICE_REGISTER)
);

// ─── Frame Validation ────────────────────────────────────────────────────────

export function validateFrame(frame) {
  if (!frame || typeof frame !== 'object') {
    return { valid: false, error: 'Frame must be a non-null object' };
  }
  if (!frame.type || typeof frame.type !== 'string') {
    return { valid: false, error: 'Frame must have a string "type" field' };
  }
  if (!Object.values(MESSAGE_TYPES).includes(frame.type)) {
    return { valid: false, error: `Unknown message type: ${frame.type}` };
  }
  if (!frame.device_id || typeof frame.device_id !== 'string') {
    return { valid: false, error: 'Frame must have a string "device_id" field' };
  }
  // session_id is optional for device.register (assigned after registration)
  if (frame.type !== MESSAGE_TYPES.DEVICE_REGISTER) {
    if (!frame.session_id || typeof frame.session_id !== 'string') {
      return { valid: false, error: 'Frame must have a string "session_id" field' };
    }
  }
  return { valid: true, error: null };
}

export function createFrame(type, sessionId, deviceId, payload = {}) {
  return {
    type,
    session_id: sessionId,
    device_id: deviceId,
    payload,
    ts: Date.now(),
  };
}

export function parseFrame(raw) {
  if (typeof raw === 'string') {
    try {
      return { parsed: JSON.parse(raw), error: null };
    } catch (e) {
      return { parsed: null, error: 'Invalid JSON' };
    }
  }
  if (typeof raw === 'object' && raw !== null) {
    return { parsed: raw, error: null };
  }
  return { parsed: null, error: 'Unsupported frame format' };
}

// ─── Connection State ────────────────────────────────────────────────────────

function createConnectionState() {
  return {
    // deviceId → { socket, sessionId, registered, capabilities, missedHeartbeats, lastPing }
    devices: new Map(),
    // sessionId → Set<deviceId>
    sessions: new Map(),
    // messageType → Set<handler>
    handlers: new Map(),
    // Metrics
    metrics: {
      totalConnections: 0,
      totalDisconnections: 0,
      totalMessages: 0,
      totalErrors: 0,
      totalBroadcasts: 0,
    },
  };
}

// ─── Sync Server ─────────────────────────────────────────────────────────────

export function createSyncServer(options = {}) {
  const state = createConnectionState();
  const heartbeatTimers = new Map(); // deviceId → timer

  // ── Connection Management ──────────────────────────────────────────────

  function handleConnection(socket, deviceId) {
    if (!deviceId) {
      deviceId = `dev_${crypto.randomUUID().slice(0, 8)}`;
    }

    state.devices.set(deviceId, {
      socket,
      sessionId: null,
      registered: false,
      capabilities: null,
      missedHeartbeats: 0,
      lastPing: Date.now(),
    });

    state.metrics.totalConnections++;

    // Start heartbeat monitor
    _startHeartbeatMonitor(deviceId);

    return deviceId;
  }

  function handleDisconnection(deviceId) {
    const device = state.devices.get(deviceId);
    if (!device) return;

    // Remove from session
    if (device.sessionId) {
      const sessionDevices = state.sessions.get(device.sessionId);
      if (sessionDevices) {
        sessionDevices.delete(deviceId);
        if (sessionDevices.size === 0) {
          state.sessions.delete(device.sessionId);
        }
      }
    }

    // Clear heartbeat timer
    _stopHeartbeatMonitor(deviceId);

    state.devices.delete(deviceId);
    state.metrics.totalDisconnections++;
  }

  // ── Message Handling ───────────────────────────────────────────────────

  function handleMessage(deviceId, raw) {
    state.metrics.totalMessages++;

    // Parse
    const { parsed, error: parseError } = parseFrame(raw);
    if (parseError) {
      _sendError(deviceId, parseError);
      state.metrics.totalErrors++;
      return { handled: false, error: parseError };
    }

    // Validate frame structure
    const validation = validateFrame(parsed);
    if (!validation.valid) {
      _sendError(deviceId, validation.error);
      state.metrics.totalErrors++;
      return { handled: false, error: validation.error };
    }

    // Check registration requirement
    const device = state.devices.get(deviceId);
    if (!device) {
      state.metrics.totalErrors++;
      return { handled: false, error: 'Unknown device' };
    }

    if (REQUIRES_REGISTRATION.has(parsed.type) && !device.registered) {
      const err = 'Device must send device.register before any other message';
      _sendError(deviceId, err);
      state.metrics.totalErrors++;
      return { handled: false, error: err };
    }

    // Handle registration specially
    if (parsed.type === MESSAGE_TYPES.DEVICE_REGISTER) {
      return _handleRegistration(deviceId, parsed);
    }

    // Handle presence ping (heartbeat)
    if (parsed.type === MESSAGE_TYPES.PRESENCE_PING) {
      return _handlePresencePing(deviceId, parsed);
    }

    // Handle session handoff
    if (parsed.type === MESSAGE_TYPES.SESSION_HANDOFF) {
      return _handleSessionHandoff(deviceId, parsed);
    }

    // Handle device revocation
    if (parsed.type === MESSAGE_TYPES.DEVICE_REVOKE) {
      return _handleDeviceRevoke(deviceId, parsed);
    }

    // Dispatch to registered handlers
    const handlers = state.handlers.get(parsed.type);
    if (handlers && handlers.size > 0) {
      for (const handler of handlers) {
        try {
          handler(deviceId, parsed);
        } catch (err) {
          state.metrics.totalErrors++;
        }
      }
      return { handled: true, type: parsed.type };
    }

    return { handled: true, type: parsed.type };
  }

  // ── Registration ───────────────────────────────────────────────────────

  function _handleRegistration(deviceId, frame) {
    const device = state.devices.get(deviceId);
    if (!device) return { handled: false, error: 'Unknown device' };

    const capabilities = frame.payload?.capabilities || {};
    const sessionId = frame.payload?.session_id || `ses_${crypto.randomUUID().slice(0, 8)}`;

    device.registered = true;
    device.capabilities = {
      platform: capabilities.platform || 'unknown',
      has_voice: capabilities.has_voice ?? false,
      has_screen: capabilities.has_screen ?? true,
      has_artifacts: capabilities.has_artifacts ?? false,
      has_haptics: capabilities.has_haptics ?? false,
      fidelity_score: capabilities.fidelity_score ?? 0,
      ...capabilities,
    };
    device.sessionId = sessionId;

    // Add to session
    if (!state.sessions.has(sessionId)) {
      state.sessions.set(sessionId, new Set());
    }
    state.sessions.get(sessionId).add(deviceId);

    // Send registration confirmation
    _sendToDevice(deviceId, createFrame(
      MESSAGE_TYPES.SESSION_SYNC,
      sessionId,
      deviceId,
      {
        registered: true,
        assigned_session: sessionId,
        capabilities: device.capabilities,
      }
    ));

    return { handled: true, type: MESSAGE_TYPES.DEVICE_REGISTER, sessionId };
  }

  // ── Presence / Heartbeat ───────────────────────────────────────────────

  function _handlePresencePing(deviceId, frame) {
    const device = state.devices.get(deviceId);
    if (!device) return { handled: false, error: 'Unknown device' };

    device.missedHeartbeats = 0;
    device.lastPing = Date.now();

    // Echo back with server status
    _sendToDevice(deviceId, createFrame(
      MESSAGE_TYPES.PRESENCE_STATUS,
      device.sessionId,
      deviceId,
      {
        status: 'online',
        connected_devices: _getSessionDeviceCount(device.sessionId),
        server_ts: Date.now(),
        ...(frame.payload || {}),
      }
    ));

    return { handled: true, type: MESSAGE_TYPES.PRESENCE_PING };
  }

  function _startHeartbeatMonitor(deviceId) {
    // In production, setInterval. For testing, this is injectable.
    if (options.disableHeartbeat) return;

    const timer = setInterval(() => {
      const device = state.devices.get(deviceId);
      if (!device) {
        clearInterval(timer);
        return;
      }

      device.missedHeartbeats++;
      if (device.missedHeartbeats >= MISSED_HEARTBEAT_LIMIT) {
        handleDisconnection(deviceId);
      }
    }, options.heartbeatInterval || HEARTBEAT_INTERVAL_MS);

    heartbeatTimers.set(deviceId, timer);
  }

  function _stopHeartbeatMonitor(deviceId) {
    const timer = heartbeatTimers.get(deviceId);
    if (timer) {
      clearInterval(timer);
      heartbeatTimers.delete(deviceId);
    }
  }

  // ── Session Handoff ────────────────────────────────────────────────────

  function _handleSessionHandoff(deviceId, frame) {
    const device = state.devices.get(deviceId);
    if (!device) return { handled: false, error: 'Unknown device' };

    const targetSessionId = frame.payload?.target_session_id;
    if (!targetSessionId) {
      _sendError(deviceId, 'session.handoff requires target_session_id in payload');
      return { handled: false, error: 'Missing target_session_id' };
    }

    // Remove from old session
    const oldSessionId = device.sessionId;
    if (oldSessionId) {
      const oldSessionDevices = state.sessions.get(oldSessionId);
      if (oldSessionDevices) {
        oldSessionDevices.delete(deviceId);
        if (oldSessionDevices.size === 0) {
          state.sessions.delete(oldSessionId);
        }
      }
    }

    // Add to new session
    device.sessionId = targetSessionId;
    if (!state.sessions.has(targetSessionId)) {
      state.sessions.set(targetSessionId, new Set());
    }
    state.sessions.get(targetSessionId).add(deviceId);

    // Confirm handoff
    _sendToDevice(deviceId, createFrame(
      MESSAGE_TYPES.SESSION_SYNC,
      targetSessionId,
      deviceId,
      {
        handoff: true,
        from_session: oldSessionId,
        to_session: targetSessionId,
      }
    ));

    return { handled: true, type: MESSAGE_TYPES.SESSION_HANDOFF, from: oldSessionId, to: targetSessionId };
  }

  // ── Device Revocation ──────────────────────────────────────────────────

  function _handleDeviceRevoke(deviceId, frame) {
    const targetDeviceId = frame.payload?.target_device_id;
    if (!targetDeviceId) {
      _sendError(deviceId, 'device.revoke requires target_device_id in payload');
      return { handled: false, error: 'Missing target_device_id' };
    }

    const targetDevice = state.devices.get(targetDeviceId);
    if (!targetDevice) {
      return { handled: true, type: MESSAGE_TYPES.DEVICE_REVOKE, already_disconnected: true };
    }

    // Send revocation notice to target before disconnecting
    _sendToDevice(targetDeviceId, createFrame(
      MESSAGE_TYPES.PRESENCE_STATUS,
      targetDevice.sessionId,
      targetDeviceId,
      { status: 'revoked', revoked_by: deviceId }
    ));

    // Disconnect the target device
    handleDisconnection(targetDeviceId);

    return { handled: true, type: MESSAGE_TYPES.DEVICE_REVOKE, revoked: targetDeviceId };
  }

  // ── Broadcasting & Delivery ────────────────────────────────────────────

  function broadcast(sessionId, message) {
    const devices = state.sessions.get(sessionId);
    if (!devices || devices.size === 0) return 0;

    let sent = 0;
    for (const devId of devices) {
      if (_sendToDevice(devId, message)) {
        sent++;
      }
    }
    state.metrics.totalBroadcasts++;
    return sent;
  }

  function sendToDevice(deviceId, message) {
    return _sendToDevice(deviceId, message);
  }

  function _sendToDevice(deviceId, message) {
    const device = state.devices.get(deviceId);
    if (!device || !device.socket) return false;

    try {
      const payload = typeof message === 'string' ? message : JSON.stringify(message);
      device.socket.send(payload);
      return true;
    } catch {
      return false;
    }
  }

  function _sendError(deviceId, errorMessage) {
    _sendToDevice(deviceId, createFrame(
      'error',
      null,
      deviceId,
      { error: errorMessage }
    ));
  }

  // ── Queries ────────────────────────────────────────────────────────────

  function getConnectedDevices() {
    const result = new Map();
    for (const [deviceId, device] of state.devices) {
      if (device.registered) {
        result.set(deviceId, {
          sessionId: device.sessionId,
          capabilities: device.capabilities,
          lastPing: device.lastPing,
          missedHeartbeats: device.missedHeartbeats,
        });
      }
    }
    return result;
  }

  function getSessionDevices(sessionId) {
    const deviceIds = state.sessions.get(sessionId);
    if (!deviceIds) return [];

    return Array.from(deviceIds).map(id => {
      const device = state.devices.get(id);
      return {
        device_id: id,
        capabilities: device?.capabilities,
        lastPing: device?.lastPing,
      };
    });
  }

  function _getSessionDeviceCount(sessionId) {
    const devices = state.sessions.get(sessionId);
    return devices ? devices.size : 0;
  }

  function isDeviceRegistered(deviceId) {
    const device = state.devices.get(deviceId);
    return device?.registered ?? false;
  }

  function getMetrics() {
    return { ...state.metrics };
  }

  // ── Handler Registration ───────────────────────────────────────────────

  function on(messageType, handler) {
    if (!state.handlers.has(messageType)) {
      state.handlers.set(messageType, new Set());
    }
    state.handlers.get(messageType).add(handler);
    return () => state.handlers.get(messageType)?.delete(handler);
  }

  function off(messageType, handler) {
    state.handlers.get(messageType)?.delete(handler);
  }

  // ── Shutdown ───────────────────────────────────────────────────────────

  function shutdown() {
    for (const [deviceId] of state.devices) {
      _stopHeartbeatMonitor(deviceId);
    }
    state.devices.clear();
    state.sessions.clear();
    state.handlers.clear();
    heartbeatTimers.clear();
  }

  // ── Public API ─────────────────────────────────────────────────────────

  return {
    // Connection lifecycle
    handleConnection,
    handleDisconnection,
    handleMessage,

    // Delivery
    broadcast,
    sendToDevice,

    // Queries
    getConnectedDevices,
    getSessionDevices,
    isDeviceRegistered,
    getMetrics,

    // Handler registration
    on,
    off,

    // Lifecycle
    shutdown,
  };
}
