// ─── gateway/gateway.mjs ──────────────────────────────────────────────────────
// RONIN Gateway — Phase 6 CAPSTONE (G6)
//
// Purpose: The unified entry point for RONIN Everywhere. Wires the Sync Server,
// Device Registry, Auth Store, Surface Adapter (middleware #1), and Response
// Formatter (middleware #13) into a single cohesive Gateway.
//
// This is the spine. Every surface connects here. Every message flows through
// here. The Gateway coordinates:
//
//   1. Connection → Auth validation → Device registration
//   2. Inbound message → Surface Adapter enrichment → handler dispatch
//   3. Response → Response Formatter → delivery to target surface(s)
//   4. Session handoff, device revocation, presence tracking
//
// The Gateway does NOT contain intelligence logic. It does NOT route to models.
// It receives formatted responses from the middleware pipeline and delivers
// them to the right surfaces in the right format.
//
// Invariants:
//   - Unauthenticated connections are rejected at the door
//   - Every registered device has a capability manifest in the registry
//   - The Surface Adapter runs BEFORE any handler sees the message
//   - The Response Formatter runs AFTER the intelligence pipeline produces output
//   - Model identity NEVER appears in any outbound message
//   - Metrics are always available (connections, messages, errors, broadcasts)
// ─────────────────────────────────────────────────────────────────────────────

import { createSyncServer, MESSAGE_TYPES, createFrame } from './syncServer.mjs';
import { createDeviceRegistry } from './deviceRegistry.mjs';
import { createAuthStore } from './auth.mjs';
import { createSurfaceAdapter } from './middleware/surfaceAdapter.mjs';
import { createResponseFormatter, formatForSurface } from './middleware/responseFormatter.mjs';

// ─── Gateway Factory ─────────────────────────────────────────────────────────

export function createGateway(config = {}) {
  // ── Core subsystems ────────────────────────────────────────────────
  const syncServer = createSyncServer({
    disableHeartbeat: config.disableHeartbeat ?? false,
    heartbeatInterval: config.heartbeatInterval,
  });
  const registry = createDeviceRegistry();
  const auth = createAuthStore();
  const surfaceAdapter = createSurfaceAdapter(registry);
  const responseFormatter = createResponseFormatter(registry);

  // ── Message handlers registered by consumers ───────────────────────
  const messageHandlers = new Map();

  // ── Gateway-level metrics ──────────────────────────────────────────
  const gatewayMetrics = {
    authFailures: 0,
    messagesRouted: 0,
    responsesFormatted: 0,
  };

  // ── Connection Flow ────────────────────────────────────────────────

  /**
   * Full connection flow:
   *   1. Socket connects → syncServer.handleConnection
   *   2. Client sends device.register with token → validate → register
   *   3. On success: device is in registry, sync server, and auth store
   */
  function connectDevice(socket, deviceId, token, capabilities = {}, sessionId) {
    // Step 1: Validate token
    const authResult = auth.validateToken(token);
    if (!authResult.valid) {
      gatewayMetrics.authFailures++;
      return {
        success: false,
        error: `Auth failed: ${authResult.reason}`,
      };
    }

    // Step 2: Ensure token matches the claimed device
    if (authResult.device_id !== deviceId) {
      gatewayMetrics.authFailures++;
      return {
        success: false,
        error: 'Token does not match device_id',
      };
    }

    // Step 3: Register in sync server
    syncServer.handleConnection(socket, deviceId);

    // Step 4: Send registration frame through sync server
    const assignedSession = sessionId || `ses_${Date.now().toString(36)}`;
    syncServer.handleMessage(deviceId, {
      type: MESSAGE_TYPES.DEVICE_REGISTER,
      device_id: deviceId,
      payload: {
        session_id: assignedSession,
        capabilities,
      },
    });

    // Step 5: Register in device registry (with normalized capabilities)
    registry.registerDevice(deviceId, assignedSession, capabilities);

    return {
      success: true,
      device_id: deviceId,
      session_id: assignedSession,
      capabilities: registry.getDeviceCapabilities(deviceId),
    };
  }

  function disconnectDevice(deviceId) {
    syncServer.handleDisconnection(deviceId);
    registry.deregisterDevice(deviceId);
  }

  // ── Message Processing ─────────────────────────────────────────────

  /**
   * Process an inbound message through the gateway:
   *   1. Parse and validate (handled by syncServer)
   *   2. Enrich with surface context (Surface Adapter)
   *   3. Dispatch to registered handler
   */
  function processMessage(deviceId, rawMessage) {
    // Let sync server handle parsing and protocol-level messages
    const syncResult = syncServer.handleMessage(deviceId, rawMessage);

    // Protocol messages (register, ping, handoff, revoke) are handled by syncServer
    if (syncResult.type === MESSAGE_TYPES.DEVICE_REGISTER ||
        syncResult.type === MESSAGE_TYPES.PRESENCE_PING ||
        syncResult.type === MESSAGE_TYPES.SESSION_HANDOFF ||
        syncResult.type === MESSAGE_TYPES.DEVICE_REVOKE) {
      return syncResult;
    }

    if (!syncResult.handled && syncResult.error) {
      return syncResult;
    }

    // For content messages (chat.send, voice.*, etc.), enrich with surface context
    const parsed = typeof rawMessage === 'string' ? JSON.parse(rawMessage) : rawMessage;
    const enriched = surfaceAdapter({
      ...parsed,
      device_id: deviceId,
    });

    gatewayMetrics.messagesRouted++;

    // Dispatch to registered handler
    const handler = messageHandlers.get(parsed.type);
    if (handler) {
      return handler(enriched);
    }

    return { handled: true, enriched };
  }

  // ── Response Delivery ──────────────────────────────────────────────

  /**
   * Send a response to a specific device, formatted for its surface.
   */
  function sendResponse(deviceId, response) {
    const capabilities = registry.getDeviceCapabilities(deviceId);
    const surfaceCtx = capabilities ? {
      response_mode: capabilities.fidelity_score >= 50 && capabilities.has_artifacts ? 'full' :
                     capabilities.fidelity_score <= 15 ? 'minimal' :
                     capabilities.platform === 'ambient' ? 'status' : 'text',
      voice_markup: capabilities.has_voice && (capabilities.platform === 'kage' || capabilities.platform === 'watchos'),
      artifacts_enabled: capabilities.fidelity_score >= 50 && capabilities.has_artifacts,
      max_tokens: capabilities.platform === 'ambient' ? 50 :
                  capabilities.platform === 'watchos' ? 100 : null,
    } : null;

    const formatted = formatForSurface(response, surfaceCtx);
    gatewayMetrics.responsesFormatted++;

    const frame = createFrame(
      MESSAGE_TYPES.CHAT_COMPLETE,
      registry.getDeviceSession(deviceId),
      deviceId,
      formatted
    );

    return syncServer.sendToDevice(deviceId, frame);
  }

  /**
   * Broadcast a response to all devices in a session, each formatted
   * for its own surface fidelity.
   */
  function broadcastResponse(sessionId, response) {
    const devices = registry.getSessionDevices(sessionId);
    let sent = 0;

    for (const device of devices) {
      if (sendResponse(device.device_id, response)) {
        sent++;
      }
    }

    return sent;
  }

  /**
   * Stream a token to all devices in a session.
   */
  function streamToken(sessionId, content, accumulated) {
    const frame = createFrame(
      MESSAGE_TYPES.CHAT_TOKEN,
      sessionId,
      'gateway',
      { content, accumulated }
    );
    return syncServer.broadcast(sessionId, frame);
  }

  /**
   * Notify all surfaces of a job event.
   */
  function notifyJob(sessionId, eventType, jobData) {
    const type = eventType === 'submitted' ? MESSAGE_TYPES.JOB_SUBMITTED :
                 eventType === 'progress'  ? MESSAGE_TYPES.JOB_PROGRESS :
                 eventType === 'complete'  ? MESSAGE_TYPES.JOB_COMPLETE :
                 null;
    if (!type) return 0;

    const frame = createFrame(type, sessionId, 'gateway', jobData);
    return syncServer.broadcast(sessionId, frame);
  }

  // ── Handler Registration ───────────────────────────────────────────

  function onMessage(messageType, handler) {
    messageHandlers.set(messageType, handler);
  }

  // ── Queries ────────────────────────────────────────────────────────

  function getMetrics() {
    return {
      ...syncServer.getMetrics(),
      ...gatewayMetrics,
    };
  }

  function getRegistry() {
    return registry;
  }

  function getAuth() {
    return auth;
  }

  function getSyncServer() {
    return syncServer;
  }

  // ── Shutdown ───────────────────────────────────────────────────────

  function shutdown() {
    syncServer.shutdown();
    registry.clear();
    auth.resetRoot();
    messageHandlers.clear();
  }

  // ── Public API ─────────────────────────────────────────────────────

  return {
    // Connection lifecycle
    connectDevice,
    disconnectDevice,

    // Message processing
    processMessage,
    onMessage,

    // Response delivery
    sendResponse,
    broadcastResponse,
    streamToken,
    notifyJob,

    // Subsystem access
    getRegistry,
    getAuth,
    getSyncServer,

    // Observability
    getMetrics,

    // Lifecycle
    shutdown,
  };
}
