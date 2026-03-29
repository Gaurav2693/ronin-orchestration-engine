// ─── gateway/syncServer.test.mjs ─────────────────────────────────────────────
// Test suite for G1 RONIN Sync Protocol — WebSocket Server
// Target: 50+ tests, 0 failures
// Run: node syncServer.test.mjs 2>&1
// ─────────────────────────────────────────────────────────────────────────────

import {
  createSyncServer,
  validateFrame,
  createFrame,
  parseFrame,
  MESSAGE_TYPES,
  HEARTBEAT_INTERVAL_MS,
  MISSED_HEARTBEAT_LIMIT,
} from './syncServer.mjs';

// ─── Test utilities ──────────────────────────────────────────────────────

let testCount = 0;
let passCount = 0;
let failCount = 0;

function test(name, fn) {
  testCount++;
  try {
    fn();
    passCount++;
    console.log(`✓ ${name}`);
  } catch (error) {
    failCount++;
    console.error(`✗ ${name}`);
    console.error(`  ${error.message}`);
  }
}

async function testAsync(name, fn) {
  testCount++;
  try {
    await fn();
    passCount++;
    console.log(`✓ ${name}`);
  } catch (error) {
    failCount++;
    console.error(`✗ ${name}`);
    console.error(`  ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertDeepEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ─── Mock Socket ─────────────────────────────────────────────────────────

function createMockSocket() {
  const sent = [];
  return {
    send(data) { sent.push(typeof data === 'string' ? JSON.parse(data) : data); },
    getSent() { return sent; },
    getLastSent() { return sent[sent.length - 1]; },
    clearSent() { sent.length = 0; },
  };
}

// ─── Helper: register a device ───────────────────────────────────────────

function registerDevice(server, deviceId, sessionId, caps = {}) {
  const socket = createMockSocket();
  server.handleConnection(socket, deviceId);
  const frame = {
    type: MESSAGE_TYPES.DEVICE_REGISTER,
    device_id: deviceId,
    payload: {
      session_id: sessionId,
      capabilities: {
        platform: caps.platform || 'macos',
        has_voice: caps.has_voice ?? true,
        has_screen: caps.has_screen ?? true,
        has_artifacts: caps.has_artifacts ?? true,
        has_haptics: caps.has_haptics ?? false,
        fidelity_score: caps.fidelity_score ?? 100,
        ...caps,
      },
    },
  };
  server.handleMessage(deviceId, frame);
  return socket;
}

// ─── Tests: Constants ────────────────────────────────────────────────────

console.log('\n── Constants ──');

test('HEARTBEAT_INTERVAL_MS is 30000', () => {
  assertEqual(HEARTBEAT_INTERVAL_MS, 30_000);
});

test('MISSED_HEARTBEAT_LIMIT is 3', () => {
  assertEqual(MISSED_HEARTBEAT_LIMIT, 3);
});

test('MESSAGE_TYPES has 18 message types (17 protocol + device.revoke)', () => {
  assertEqual(Object.keys(MESSAGE_TYPES).length, 18);
});

test('MESSAGE_TYPES is frozen', () => {
  assert(Object.isFrozen(MESSAGE_TYPES));
});

test('MESSAGE_TYPES includes all client→gateway types', () => {
  assert(MESSAGE_TYPES.CHAT_SEND === 'chat.send');
  assert(MESSAGE_TYPES.VOICE_START === 'voice.start');
  assert(MESSAGE_TYPES.PRESENCE_PING === 'presence.ping');
  assert(MESSAGE_TYPES.SESSION_HANDOFF === 'session.handoff');
  assert(MESSAGE_TYPES.DEVICE_REGISTER === 'device.register');
  assert(MESSAGE_TYPES.DEVICE_REVOKE === 'device.revoke');
});

test('MESSAGE_TYPES includes all gateway→client types', () => {
  assert(MESSAGE_TYPES.CHAT_TOKEN === 'chat.token');
  assert(MESSAGE_TYPES.CHAT_COMPLETE === 'chat.complete');
  assert(MESSAGE_TYPES.ARTIFACT_STREAM === 'artifact.stream');
  assert(MESSAGE_TYPES.ARTIFACT_COMPLETE === 'artifact.complete');
  assert(MESSAGE_TYPES.JOB_SUBMITTED === 'job.submitted');
  assert(MESSAGE_TYPES.JOB_PROGRESS === 'job.progress');
  assert(MESSAGE_TYPES.JOB_COMPLETE === 'job.complete');
  assert(MESSAGE_TYPES.PRESENCE_STATUS === 'presence.status');
  assert(MESSAGE_TYPES.SESSION_SYNC === 'session.sync');
  assert(MESSAGE_TYPES.MEMORY_UPDATE === 'memory.update');
});

// ─── Tests: Frame Validation ─────────────────────────────────────────────

console.log('\n── Frame Validation ──');

test('validateFrame rejects null', () => {
  const r = validateFrame(null);
  assertEqual(r.valid, false);
  assert(r.error.includes('non-null'));
});

test('validateFrame rejects non-object', () => {
  assertEqual(validateFrame('hello').valid, false);
  assertEqual(validateFrame(42).valid, false);
});

test('validateFrame rejects missing type', () => {
  const r = validateFrame({ device_id: 'a', session_id: 'b' });
  assertEqual(r.valid, false);
  assert(r.error.includes('type'));
});

test('validateFrame rejects unknown type', () => {
  const r = validateFrame({ type: 'bogus.type', device_id: 'a', session_id: 'b' });
  assertEqual(r.valid, false);
  assert(r.error.includes('Unknown'));
});

test('validateFrame rejects missing device_id', () => {
  const r = validateFrame({ type: 'chat.send', session_id: 'b' });
  assertEqual(r.valid, false);
  assert(r.error.includes('device_id'));
});

test('validateFrame rejects missing session_id for non-register types', () => {
  const r = validateFrame({ type: 'chat.send', device_id: 'a' });
  assertEqual(r.valid, false);
  assert(r.error.includes('session_id'));
});

test('validateFrame allows missing session_id for device.register', () => {
  const r = validateFrame({ type: 'device.register', device_id: 'a' });
  assertEqual(r.valid, true);
});

test('validateFrame accepts valid chat.send frame', () => {
  const r = validateFrame({
    type: 'chat.send',
    device_id: 'dev_1',
    session_id: 'ses_1',
    payload: { content: 'hello' },
  });
  assertEqual(r.valid, true);
  assertEqual(r.error, null);
});

// ─── Tests: Frame Creation ───────────────────────────────────────────────

console.log('\n── Frame Creation ──');

test('createFrame produces valid structure', () => {
  const f = createFrame('chat.token', 'ses_1', 'dev_1', { content: 'hi' });
  assertEqual(f.type, 'chat.token');
  assertEqual(f.session_id, 'ses_1');
  assertEqual(f.device_id, 'dev_1');
  assertEqual(f.payload.content, 'hi');
  assert(typeof f.ts === 'number');
});

test('createFrame defaults payload to empty object', () => {
  const f = createFrame('chat.complete', 'ses_1', 'dev_1');
  assertDeepEqual(f.payload, {});
});

test('createFrame timestamps are recent', () => {
  const before = Date.now();
  const f = createFrame('chat.token', 'ses_1', 'dev_1');
  const after = Date.now();
  assert(f.ts >= before && f.ts <= after);
});

// ─── Tests: Frame Parsing ────────────────────────────────────────────────

console.log('\n── Frame Parsing ──');

test('parseFrame parses valid JSON string', () => {
  const { parsed, error } = parseFrame('{"type":"chat.send","device_id":"d1"}');
  assertEqual(error, null);
  assertEqual(parsed.type, 'chat.send');
});

test('parseFrame rejects invalid JSON', () => {
  const { parsed, error } = parseFrame('{bad json}');
  assertEqual(parsed, null);
  assertEqual(error, 'Invalid JSON');
});

test('parseFrame passes through objects directly', () => {
  const obj = { type: 'chat.send', device_id: 'd1' };
  const { parsed, error } = parseFrame(obj);
  assertEqual(error, null);
  assertEqual(parsed, obj);
});

test('parseFrame rejects non-string non-object', () => {
  const { parsed, error } = parseFrame(42);
  assertEqual(parsed, null);
  assert(error.includes('Unsupported'));
});

// ─── Tests: Server Creation ──────────────────────────────────────────────

console.log('\n── Server Creation ──');

test('createSyncServer returns server with all public methods', () => {
  const server = createSyncServer({ disableHeartbeat: true });
  assert(typeof server.handleConnection === 'function');
  assert(typeof server.handleDisconnection === 'function');
  assert(typeof server.handleMessage === 'function');
  assert(typeof server.broadcast === 'function');
  assert(typeof server.sendToDevice === 'function');
  assert(typeof server.getConnectedDevices === 'function');
  assert(typeof server.getSessionDevices === 'function');
  assert(typeof server.isDeviceRegistered === 'function');
  assert(typeof server.getMetrics === 'function');
  assert(typeof server.on === 'function');
  assert(typeof server.off === 'function');
  assert(typeof server.shutdown === 'function');
  server.shutdown();
});

// ─── Tests: Connection Lifecycle ─────────────────────────────────────────

console.log('\n── Connection Lifecycle ──');

test('handleConnection accepts a socket and returns deviceId', () => {
  const server = createSyncServer({ disableHeartbeat: true });
  const socket = createMockSocket();
  const deviceId = server.handleConnection(socket, 'dev_test');
  assertEqual(deviceId, 'dev_test');
  server.shutdown();
});

test('handleConnection auto-generates deviceId if not provided', () => {
  const server = createSyncServer({ disableHeartbeat: true });
  const socket = createMockSocket();
  const deviceId = server.handleConnection(socket);
  assert(deviceId.startsWith('dev_'));
  assert(deviceId.length > 4);
  server.shutdown();
});

test('handleConnection increments totalConnections metric', () => {
  const server = createSyncServer({ disableHeartbeat: true });
  server.handleConnection(createMockSocket(), 'a');
  server.handleConnection(createMockSocket(), 'b');
  assertEqual(server.getMetrics().totalConnections, 2);
  server.shutdown();
});

test('handleDisconnection removes device from state', () => {
  const server = createSyncServer({ disableHeartbeat: true });
  server.handleConnection(createMockSocket(), 'dev_x');
  server.handleDisconnection('dev_x');
  assertEqual(server.isDeviceRegistered('dev_x'), false);
  server.shutdown();
});

test('handleDisconnection increments totalDisconnections metric', () => {
  const server = createSyncServer({ disableHeartbeat: true });
  server.handleConnection(createMockSocket(), 'dev_x');
  server.handleDisconnection('dev_x');
  assertEqual(server.getMetrics().totalDisconnections, 1);
  server.shutdown();
});

test('handleDisconnection is safe for unknown deviceId', () => {
  const server = createSyncServer({ disableHeartbeat: true });
  server.handleDisconnection('nonexistent'); // should not throw
  server.shutdown();
});

// ─── Tests: Registration ─────────────────────────────────────────────────

console.log('\n── Registration ──');

test('device.register marks device as registered', () => {
  const server = createSyncServer({ disableHeartbeat: true });
  registerDevice(server, 'dev_1', 'ses_1');
  assertEqual(server.isDeviceRegistered('dev_1'), true);
  server.shutdown();
});

test('device.register adds device to session', () => {
  const server = createSyncServer({ disableHeartbeat: true });
  registerDevice(server, 'dev_1', 'ses_1');
  const devices = server.getSessionDevices('ses_1');
  assertEqual(devices.length, 1);
  assertEqual(devices[0].device_id, 'dev_1');
  server.shutdown();
});

test('device.register sends SESSION_SYNC confirmation', () => {
  const server = createSyncServer({ disableHeartbeat: true });
  const socket = registerDevice(server, 'dev_1', 'ses_1');
  const msg = socket.getLastSent();
  assertEqual(msg.type, 'session.sync');
  assertEqual(msg.payload.registered, true);
  assertEqual(msg.payload.assigned_session, 'ses_1');
  server.shutdown();
});

test('multiple devices can join the same session', () => {
  const server = createSyncServer({ disableHeartbeat: true });
  registerDevice(server, 'dev_mac', 'ses_1', { platform: 'macos', fidelity_score: 100 });
  registerDevice(server, 'dev_ios', 'ses_1', { platform: 'ios', fidelity_score: 70 });
  const devices = server.getSessionDevices('ses_1');
  assertEqual(devices.length, 2);
  server.shutdown();
});

test('device.register stores capabilities', () => {
  const server = createSyncServer({ disableHeartbeat: true });
  registerDevice(server, 'dev_1', 'ses_1', {
    platform: 'ios',
    has_voice: true,
    has_artifacts: false,
    fidelity_score: 70,
  });
  const devices = server.getConnectedDevices();
  const dev = devices.get('dev_1');
  assertEqual(dev.capabilities.platform, 'ios');
  assertEqual(dev.capabilities.has_voice, true);
  assertEqual(dev.capabilities.has_artifacts, false);
  assertEqual(dev.capabilities.fidelity_score, 70);
  server.shutdown();
});

test('unregistered device cannot send chat.send', () => {
  const server = createSyncServer({ disableHeartbeat: true });
  server.handleConnection(createMockSocket(), 'dev_unreg');
  const result = server.handleMessage('dev_unreg', {
    type: 'chat.send',
    device_id: 'dev_unreg',
    session_id: 'ses_1',
    payload: { content: 'hi' },
  });
  assertEqual(result.handled, false);
  assert(result.error.includes('register'));
  server.shutdown();
});

// ─── Tests: Message Handling ─────────────────────────────────────────────

console.log('\n── Message Handling ──');

test('handleMessage increments totalMessages', () => {
  const server = createSyncServer({ disableHeartbeat: true });
  registerDevice(server, 'dev_1', 'ses_1');
  server.handleMessage('dev_1', {
    type: 'chat.send',
    device_id: 'dev_1',
    session_id: 'ses_1',
    payload: { content: 'test' },
  });
  assert(server.getMetrics().totalMessages >= 2); // registration + chat
  server.shutdown();
});

test('handleMessage rejects invalid JSON string', () => {
  const server = createSyncServer({ disableHeartbeat: true });
  registerDevice(server, 'dev_1', 'ses_1');
  const result = server.handleMessage('dev_1', '{not json}');
  assertEqual(result.handled, false);
  assert(result.error.includes('JSON'));
  server.shutdown();
});

test('handleMessage dispatches to registered handler', () => {
  const server = createSyncServer({ disableHeartbeat: true });
  registerDevice(server, 'dev_1', 'ses_1');

  let received = null;
  server.on('chat.send', (deviceId, frame) => {
    received = { deviceId, frame };
  });

  server.handleMessage('dev_1', {
    type: 'chat.send',
    device_id: 'dev_1',
    session_id: 'ses_1',
    payload: { content: 'hello RONIN' },
  });

  assert(received !== null);
  assertEqual(received.deviceId, 'dev_1');
  assertEqual(received.frame.payload.content, 'hello RONIN');
  server.shutdown();
});

test('handler can be unregistered with off()', () => {
  const server = createSyncServer({ disableHeartbeat: true });
  registerDevice(server, 'dev_1', 'ses_1');

  let callCount = 0;
  const handler = () => { callCount++; };
  server.on('chat.send', handler);

  const frame = { type: 'chat.send', device_id: 'dev_1', session_id: 'ses_1', payload: {} };
  server.handleMessage('dev_1', frame);
  assertEqual(callCount, 1);

  server.off('chat.send', handler);
  server.handleMessage('dev_1', frame);
  assertEqual(callCount, 1); // should not increment
  server.shutdown();
});

test('on() returns an unsubscribe function', () => {
  const server = createSyncServer({ disableHeartbeat: true });
  registerDevice(server, 'dev_1', 'ses_1');

  let callCount = 0;
  const unsub = server.on('chat.send', () => { callCount++; });

  const frame = { type: 'chat.send', device_id: 'dev_1', session_id: 'ses_1', payload: {} };
  server.handleMessage('dev_1', frame);
  assertEqual(callCount, 1);

  unsub();
  server.handleMessage('dev_1', frame);
  assertEqual(callCount, 1);
  server.shutdown();
});

test('handleMessage returns error for unknown device', () => {
  const server = createSyncServer({ disableHeartbeat: true });
  const result = server.handleMessage('ghost', { type: 'chat.send', device_id: 'ghost', session_id: 'x' });
  assertEqual(result.handled, false);
  server.shutdown();
});

// ─── Tests: Broadcasting ─────────────────────────────────────────────────

console.log('\n── Broadcasting ──');

test('broadcast sends to all devices in session', () => {
  const server = createSyncServer({ disableHeartbeat: true });
  const sock1 = registerDevice(server, 'dev_1', 'ses_shared');
  const sock2 = registerDevice(server, 'dev_2', 'ses_shared');

  const msg = createFrame('chat.token', 'ses_shared', 'server', { content: 'hello everyone' });
  const sent = server.broadcast('ses_shared', msg);

  assertEqual(sent, 2);
  assertEqual(sock1.getLastSent().payload.content, 'hello everyone');
  assertEqual(sock2.getLastSent().payload.content, 'hello everyone');
  server.shutdown();
});

test('broadcast returns 0 for empty session', () => {
  const server = createSyncServer({ disableHeartbeat: true });
  assertEqual(server.broadcast('nonexistent', {}), 0);
  server.shutdown();
});

test('broadcast does not leak to other sessions', () => {
  const server = createSyncServer({ disableHeartbeat: true });
  const sock1 = registerDevice(server, 'dev_1', 'ses_A');
  const sock2 = registerDevice(server, 'dev_2', 'ses_B');

  sock1.clearSent();
  sock2.clearSent();

  const msg = createFrame('chat.token', 'ses_A', 'server', { content: 'private' });
  server.broadcast('ses_A', msg);

  assertEqual(sock1.getSent().length, 1);
  assertEqual(sock2.getSent().length, 0); // different session — nothing received
  server.shutdown();
});

test('broadcast increments totalBroadcasts metric', () => {
  const server = createSyncServer({ disableHeartbeat: true });
  registerDevice(server, 'dev_1', 'ses_1');
  server.broadcast('ses_1', {});
  server.broadcast('ses_1', {});
  assertEqual(server.getMetrics().totalBroadcasts, 2);
  server.shutdown();
});

// ─── Tests: Targeted Delivery ────────────────────────────────────────────

console.log('\n── Targeted Delivery ──');

test('sendToDevice delivers to specific device', () => {
  const server = createSyncServer({ disableHeartbeat: true });
  const sock = registerDevice(server, 'dev_1', 'ses_1');
  sock.clearSent();

  const msg = createFrame('job.complete', 'ses_1', 'dev_1', { job_id: 'j_42' });
  const result = server.sendToDevice('dev_1', msg);
  assertEqual(result, true);
  assertEqual(sock.getLastSent().payload.job_id, 'j_42');
  server.shutdown();
});

test('sendToDevice returns false for unknown device', () => {
  const server = createSyncServer({ disableHeartbeat: true });
  assertEqual(server.sendToDevice('ghost', {}), false);
  server.shutdown();
});

// ─── Tests: Session Handoff ──────────────────────────────────────────────

console.log('\n── Session Handoff ──');

test('session.handoff moves device to new session', () => {
  const server = createSyncServer({ disableHeartbeat: true });
  registerDevice(server, 'dev_1', 'ses_old');

  server.handleMessage('dev_1', {
    type: 'session.handoff',
    device_id: 'dev_1',
    session_id: 'ses_old',
    payload: { target_session_id: 'ses_new' },
  });

  const oldDevices = server.getSessionDevices('ses_old');
  const newDevices = server.getSessionDevices('ses_new');
  assertEqual(oldDevices.length, 0);
  assertEqual(newDevices.length, 1);
  assertEqual(newDevices[0].device_id, 'dev_1');
  server.shutdown();
});

test('session.handoff sends SESSION_SYNC confirmation', () => {
  const server = createSyncServer({ disableHeartbeat: true });
  const socket = registerDevice(server, 'dev_1', 'ses_old');
  socket.clearSent();

  server.handleMessage('dev_1', {
    type: 'session.handoff',
    device_id: 'dev_1',
    session_id: 'ses_old',
    payload: { target_session_id: 'ses_new' },
  });

  const msg = socket.getLastSent();
  assertEqual(msg.type, 'session.sync');
  assertEqual(msg.payload.handoff, true);
  assertEqual(msg.payload.from_session, 'ses_old');
  assertEqual(msg.payload.to_session, 'ses_new');
  server.shutdown();
});

test('session.handoff requires target_session_id', () => {
  const server = createSyncServer({ disableHeartbeat: true });
  registerDevice(server, 'dev_1', 'ses_1');

  const result = server.handleMessage('dev_1', {
    type: 'session.handoff',
    device_id: 'dev_1',
    session_id: 'ses_1',
    payload: {},
  });

  assertEqual(result.handled, false);
  assert(result.error.includes('target_session_id'));
  server.shutdown();
});

test('session.handoff cleans up empty old session', () => {
  const server = createSyncServer({ disableHeartbeat: true });
  registerDevice(server, 'dev_1', 'ses_lonely');

  server.handleMessage('dev_1', {
    type: 'session.handoff',
    device_id: 'dev_1',
    session_id: 'ses_lonely',
    payload: { target_session_id: 'ses_new' },
  });

  assertEqual(server.getSessionDevices('ses_lonely').length, 0);
  server.shutdown();
});

// ─── Tests: Device Revocation ────────────────────────────────────────────

console.log('\n── Device Revocation ──');

test('device.revoke disconnects target device', () => {
  const server = createSyncServer({ disableHeartbeat: true });
  registerDevice(server, 'dev_mac', 'ses_1');
  registerDevice(server, 'dev_stolen', 'ses_1');

  server.handleMessage('dev_mac', {
    type: 'device.revoke',
    device_id: 'dev_mac',
    session_id: 'ses_1',
    payload: { target_device_id: 'dev_stolen' },
  });

  assertEqual(server.isDeviceRegistered('dev_stolen'), false);
  assertEqual(server.isDeviceRegistered('dev_mac'), true);
  server.shutdown();
});

test('device.revoke sends revocation notice before disconnecting', () => {
  const server = createSyncServer({ disableHeartbeat: true });
  registerDevice(server, 'dev_mac', 'ses_1');
  const stolenSock = registerDevice(server, 'dev_stolen', 'ses_1');

  server.handleMessage('dev_mac', {
    type: 'device.revoke',
    device_id: 'dev_mac',
    session_id: 'ses_1',
    payload: { target_device_id: 'dev_stolen' },
  });

  // Last message to stolen device should be revocation notice
  const lastMsg = stolenSock.getLastSent();
  assertEqual(lastMsg.type, 'presence.status');
  assertEqual(lastMsg.payload.status, 'revoked');
  assertEqual(lastMsg.payload.revoked_by, 'dev_mac');
  server.shutdown();
});

test('device.revoke requires target_device_id', () => {
  const server = createSyncServer({ disableHeartbeat: true });
  registerDevice(server, 'dev_1', 'ses_1');
  const result = server.handleMessage('dev_1', {
    type: 'device.revoke',
    device_id: 'dev_1',
    session_id: 'ses_1',
    payload: {},
  });
  assertEqual(result.handled, false);
  assert(result.error.includes('target_device_id'));
  server.shutdown();
});

test('device.revoke handles already-disconnected target', () => {
  const server = createSyncServer({ disableHeartbeat: true });
  registerDevice(server, 'dev_1', 'ses_1');
  const result = server.handleMessage('dev_1', {
    type: 'device.revoke',
    device_id: 'dev_1',
    session_id: 'ses_1',
    payload: { target_device_id: 'ghost_device' },
  });
  assertEqual(result.handled, true);
  assert(result.already_disconnected === true);
  server.shutdown();
});

// ─── Tests: Presence Ping ────────────────────────────────────────────────

console.log('\n── Presence Ping ──');

test('presence.ping resets missed heartbeats', () => {
  const server = createSyncServer({ disableHeartbeat: true });
  const socket = registerDevice(server, 'dev_1', 'ses_1');

  server.handleMessage('dev_1', {
    type: 'presence.ping',
    device_id: 'dev_1',
    session_id: 'ses_1',
    payload: { battery: 85, connectivity: 'wifi' },
  });

  const devices = server.getConnectedDevices();
  assertEqual(devices.get('dev_1').missedHeartbeats, 0);
  server.shutdown();
});

test('presence.ping sends PRESENCE_STATUS response', () => {
  const server = createSyncServer({ disableHeartbeat: true });
  const socket = registerDevice(server, 'dev_1', 'ses_1');
  socket.clearSent();

  server.handleMessage('dev_1', {
    type: 'presence.ping',
    device_id: 'dev_1',
    session_id: 'ses_1',
    payload: {},
  });

  const msg = socket.getLastSent();
  assertEqual(msg.type, 'presence.status');
  assertEqual(msg.payload.status, 'online');
  assert(typeof msg.payload.connected_devices === 'number');
  server.shutdown();
});

// ─── Tests: Queries ──────────────────────────────────────────────────────

console.log('\n── Queries ──');

test('getConnectedDevices returns only registered devices', () => {
  const server = createSyncServer({ disableHeartbeat: true });
  server.handleConnection(createMockSocket(), 'unreg');
  registerDevice(server, 'reg', 'ses_1');

  const devices = server.getConnectedDevices();
  assertEqual(devices.size, 1);
  assert(devices.has('reg'));
  assert(!devices.has('unreg'));
  server.shutdown();
});

test('getSessionDevices returns devices with capabilities', () => {
  const server = createSyncServer({ disableHeartbeat: true });
  registerDevice(server, 'dev_1', 'ses_1', { platform: 'macos', fidelity_score: 100 });

  const devices = server.getSessionDevices('ses_1');
  assertEqual(devices.length, 1);
  assertEqual(devices[0].device_id, 'dev_1');
  assertEqual(devices[0].capabilities.platform, 'macos');
  server.shutdown();
});

test('getSessionDevices returns empty array for unknown session', () => {
  const server = createSyncServer({ disableHeartbeat: true });
  assertDeepEqual(server.getSessionDevices('ghost'), []);
  server.shutdown();
});

// ─── Tests: Disconnection cleanup ────────────────────────────────────────

console.log('\n── Disconnection Cleanup ──');

test('disconnected device removed from session', () => {
  const server = createSyncServer({ disableHeartbeat: true });
  registerDevice(server, 'dev_1', 'ses_1');
  registerDevice(server, 'dev_2', 'ses_1');

  server.handleDisconnection('dev_1');
  const devices = server.getSessionDevices('ses_1');
  assertEqual(devices.length, 1);
  assertEqual(devices[0].device_id, 'dev_2');
  server.shutdown();
});

test('empty session cleaned up after last device disconnects', () => {
  const server = createSyncServer({ disableHeartbeat: true });
  registerDevice(server, 'dev_1', 'ses_solo');
  server.handleDisconnection('dev_1');
  assertEqual(server.getSessionDevices('ses_solo').length, 0);
  server.shutdown();
});

// ─── Tests: Shutdown ─────────────────────────────────────────────────────

console.log('\n── Shutdown ──');

test('shutdown clears all state', () => {
  const server = createSyncServer({ disableHeartbeat: true });
  registerDevice(server, 'dev_1', 'ses_1');
  registerDevice(server, 'dev_2', 'ses_1');
  server.shutdown();
  assertEqual(server.getConnectedDevices().size, 0);
  assertEqual(server.getSessionDevices('ses_1').length, 0);
});

// ─── Tests: Metrics ──────────────────────────────────────────────────────

console.log('\n── Metrics ──');

test('metrics tracks all counters', () => {
  const server = createSyncServer({ disableHeartbeat: true });
  registerDevice(server, 'dev_1', 'ses_1');
  server.handleMessage('dev_1', {
    type: 'chat.send', device_id: 'dev_1', session_id: 'ses_1', payload: {},
  });
  server.broadcast('ses_1', {});
  server.handleDisconnection('dev_1');

  const m = server.getMetrics();
  assert(m.totalConnections >= 1);
  assert(m.totalMessages >= 2);
  assert(m.totalBroadcasts >= 1);
  assert(m.totalDisconnections >= 1);
  server.shutdown();
});

test('metrics totalErrors increments on invalid frames', () => {
  const server = createSyncServer({ disableHeartbeat: true });
  registerDevice(server, 'dev_1', 'ses_1');
  server.handleMessage('dev_1', '{broken json}');
  assert(server.getMetrics().totalErrors >= 1);
  server.shutdown();
});

// ─── Summary ─────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`G1 syncServer: ${passCount}/${testCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
