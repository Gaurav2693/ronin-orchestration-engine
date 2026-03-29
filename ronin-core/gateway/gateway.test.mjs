// ─── gateway/gateway.test.mjs ─────────────────────────────────────────────────
// Test suite for G6 RONIN Gateway CAPSTONE
// Target: 50+ tests, 0 failures
// Run: node gateway.test.mjs 2>&1
// ─────────────────────────────────────────────────────────────────────────────

import { createGateway } from './gateway.mjs';
import { MESSAGE_TYPES } from './syncServer.mjs';

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

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
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

// ─── Helper: set up an authenticated gateway with a connected device ─────

function setupGateway() {
  const gw = createGateway({ disableHeartbeat: true });
  const auth = gw.getAuth();

  // Initialize root
  const { token: rootToken } = auth.initializeRoot('dev_mac');
  const macSocket = createMockSocket();

  // Connect macOS
  const macResult = gw.connectDevice(macSocket, 'dev_mac', rootToken, {
    platform: 'macos',
    has_voice: true,
    has_screen: true,
    has_artifacts: true,
    fidelity_score: 100,
  }, 'ses_main');

  return { gw, auth, rootToken, macSocket, macResult };
}

function addDevice(gw, rootToken, deviceId, platform, fidelity, sessionId) {
  const auth = gw.getAuth();
  const { token } = auth.generateDeviceToken('dev_mac', deviceId, deviceId);
  const socket = createMockSocket();

  const capsMap = {
    ios: { platform: 'ios', has_voice: true, has_screen: true, has_artifacts: true, has_haptics: true, fidelity_score: 70 },
    cli: { platform: 'cli', has_voice: false, has_screen: true, has_artifacts: false, fidelity_score: 30 },
    kage: { platform: 'kage', has_voice: true, has_screen: true, has_artifacts: false, fidelity_score: 40 },
    watchos: { platform: 'watchos', has_voice: true, has_screen: true, has_artifacts: false, has_haptics: true, fidelity_score: 15 },
    ambient: { platform: 'ambient', has_voice: false, has_screen: true, has_artifacts: false, fidelity_score: 10 },
  };

  const caps = capsMap[platform] || { platform, fidelity_score: fidelity || 50 };
  gw.connectDevice(socket, deviceId, token, caps, sessionId || 'ses_main');
  return socket;
}

// ─── Tests: Gateway Creation ─────────────────────────────────────────────

console.log('\n── Gateway Creation ──');

test('createGateway returns gateway with all public methods', () => {
  const gw = createGateway({ disableHeartbeat: true });
  assert(typeof gw.connectDevice === 'function');
  assert(typeof gw.disconnectDevice === 'function');
  assert(typeof gw.processMessage === 'function');
  assert(typeof gw.onMessage === 'function');
  assert(typeof gw.sendResponse === 'function');
  assert(typeof gw.broadcastResponse === 'function');
  assert(typeof gw.streamToken === 'function');
  assert(typeof gw.notifyJob === 'function');
  assert(typeof gw.getMetrics === 'function');
  assert(typeof gw.getRegistry === 'function');
  assert(typeof gw.getAuth === 'function');
  assert(typeof gw.shutdown === 'function');
  gw.shutdown();
});

test('gateway subsystems are accessible', () => {
  const gw = createGateway({ disableHeartbeat: true });
  assert(gw.getRegistry() !== null);
  assert(gw.getAuth() !== null);
  assert(gw.getSyncServer() !== null);
  gw.shutdown();
});

// ─── Tests: Connection Flow ──────────────────────────────────────────────

console.log('\n── Connection Flow ──');

test('connectDevice succeeds with valid token', () => {
  const { gw, macResult } = setupGateway();
  assertEqual(macResult.success, true);
  assertEqual(macResult.device_id, 'dev_mac');
  assertEqual(macResult.session_id, 'ses_main');
  assert(macResult.capabilities !== null);
  gw.shutdown();
});

test('connectDevice fails with invalid token', () => {
  const gw = createGateway({ disableHeartbeat: true });
  gw.getAuth().initializeRoot('dev_mac');
  const socket = createMockSocket();
  const result = gw.connectDevice(socket, 'dev_hack', 'rtk_fake', {});
  assertEqual(result.success, false);
  assert(result.error.includes('Auth failed'));
  gw.shutdown();
});

test('connectDevice fails when token belongs to different device', () => {
  const { gw, auth, rootToken } = setupGateway();
  const socket = createMockSocket();
  // Try to use mac's token for a different device_id
  const result = gw.connectDevice(socket, 'dev_impersonator', rootToken, {});
  assertEqual(result.success, false);
  assert(result.error.includes('does not match'));
  gw.shutdown();
});

test('connectDevice registers in both syncServer and registry', () => {
  const { gw } = setupGateway();
  const reg = gw.getRegistry();

  assertEqual(reg.isRegistered('dev_mac'), true);
  assertEqual(reg.getDeviceCapabilities('dev_mac').platform, 'macos');
  assertEqual(gw.getSyncServer().isDeviceRegistered('dev_mac'), true);
  gw.shutdown();
});

test('connectDevice increments auth failures on bad token', () => {
  const gw = createGateway({ disableHeartbeat: true });
  gw.getAuth().initializeRoot('dev_mac');
  gw.connectDevice(createMockSocket(), 'dev_bad', 'rtk_wrong', {});
  assert(gw.getMetrics().authFailures >= 1);
  gw.shutdown();
});

test('multiple devices connect to same session', () => {
  const { gw, auth } = setupGateway();
  addDevice(gw, null, 'dev_ios', 'ios', 70, 'ses_main');

  const reg = gw.getRegistry();
  assertEqual(reg.getSessionDeviceCount('ses_main'), 2);
  gw.shutdown();
});

test('disconnectDevice removes from both systems', () => {
  const { gw } = setupGateway();
  gw.disconnectDevice('dev_mac');
  assertEqual(gw.getRegistry().isRegistered('dev_mac'), false);
  gw.shutdown();
});

// ─── Tests: Message Processing ───────────────────────────────────────────

console.log('\n── Message Processing ──');

test('processMessage enriches chat.send with surface context', () => {
  const { gw } = setupGateway();

  let received = null;
  gw.onMessage('chat.send', (enriched) => {
    received = enriched;
    return { handled: true };
  });

  gw.processMessage('dev_mac', {
    type: 'chat.send',
    device_id: 'dev_mac',
    session_id: 'ses_main',
    payload: { content: 'build me a login page' },
  });

  assert(received !== null);
  assert(received.surface !== undefined);
  assertEqual(received.surface.platform, 'macos');
  assertEqual(received.surface.artifacts_enabled, true);
  gw.shutdown();
});

test('processMessage routes messagesRouted metric', () => {
  const { gw } = setupGateway();
  gw.onMessage('chat.send', () => {});
  gw.processMessage('dev_mac', {
    type: 'chat.send', device_id: 'dev_mac', session_id: 'ses_main', payload: {},
  });
  assert(gw.getMetrics().messagesRouted >= 1);
  gw.shutdown();
});

test('processMessage handles protocol messages (ping)', () => {
  const { gw, macSocket } = setupGateway();
  macSocket.clearSent();

  const result = gw.processMessage('dev_mac', {
    type: 'presence.ping', device_id: 'dev_mac', session_id: 'ses_main', payload: {},
  });

  assertEqual(result.type, 'presence.ping');
  // Should have received a presence.status response
  const lastMsg = macSocket.getLastSent();
  assertEqual(lastMsg.type, 'presence.status');
  gw.shutdown();
});

test('processMessage returns error for invalid frame', () => {
  const { gw } = setupGateway();
  const result = gw.processMessage('dev_mac', '{broken}');
  assertEqual(result.handled, false);
  gw.shutdown();
});

// ─── Tests: Response Delivery ────────────────────────────────────────────

console.log('\n── Response Delivery ──');

test('sendResponse formats for macOS (full mode)', () => {
  const { gw, macSocket } = setupGateway();
  macSocket.clearSent();

  const response = {
    content: 'Here is your component.\n\n```artifact\n<div>Login</div>\n```',
    artifacts: [{ id: 'a1' }],
    suggestions: ['Add tests'],
  };

  const sent = gw.sendResponse('dev_mac', response);
  assertEqual(sent, true);

  const msg = macSocket.getLastSent();
  assertEqual(msg.type, 'chat.complete');
  assertEqual(msg.payload.format, 'full');
  assert(msg.payload.formatted.includes('artifact'));
  gw.shutdown();
});

test('sendResponse formats for CLI (text mode, no artifacts)', () => {
  const { gw } = setupGateway();
  const cliSocket = addDevice(gw, null, 'dev_cli', 'cli', 30, 'ses_main');
  cliSocket.clearSent();

  gw.sendResponse('dev_cli', {
    content: 'Here is the answer.\n\n```artifact\n<div>Strip me</div>\n```',
    artifacts: [{ id: 'a1' }],
  });

  const msg = cliSocket.getLastSent();
  assertEqual(msg.type, 'chat.complete');
  assertEqual(msg.payload.format, 'text');
  assert(!msg.payload.formatted.includes('```artifact'));
  gw.shutdown();
});

test('sendResponse formats for KAGE (voice mode)', () => {
  const { gw } = setupGateway();
  const kageSocket = addDevice(gw, null, 'dev_kage', 'kage', 40, 'ses_main');
  kageSocket.clearSent();

  gw.sendResponse('dev_kage', { content: 'Hello operator.' });

  const msg = kageSocket.getLastSent();
  assertEqual(msg.type, 'chat.complete');
  assertEqual(msg.payload.format, 'voice');
  assert(msg.payload.formatted.includes('<speak>'));
  gw.shutdown();
});

test('sendResponse returns false for unknown device', () => {
  const { gw } = setupGateway();
  assertEqual(gw.sendResponse('ghost', { content: 'hi' }), false);
  gw.shutdown();
});

test('sendResponse increments responsesFormatted metric', () => {
  const { gw } = setupGateway();
  gw.sendResponse('dev_mac', { content: 'test' });
  assert(gw.getMetrics().responsesFormatted >= 1);
  gw.shutdown();
});

// ─── Tests: Broadcast ────────────────────────────────────────────────────

console.log('\n── Broadcast ──');

test('broadcastResponse sends to all devices in session', () => {
  const { gw } = setupGateway();
  const iosSocket = addDevice(gw, null, 'dev_ios', 'ios', 70, 'ses_main');
  const cliSocket = addDevice(gw, null, 'dev_cli', 'cli', 30, 'ses_main');

  // Clear so we can count new messages
  iosSocket.clearSent();
  cliSocket.clearSent();

  const sent = gw.broadcastResponse('ses_main', {
    content: 'Build complete.',
    artifacts: [],
  });

  assert(sent >= 2); // at least ios + cli (mac too)
  gw.shutdown();
});

test('broadcastResponse formats differently per surface', () => {
  const { gw, macSocket } = setupGateway();
  const cliSocket = addDevice(gw, null, 'dev_cli', 'cli', 30, 'ses_main');

  macSocket.clearSent();
  cliSocket.clearSent();

  gw.broadcastResponse('ses_main', {
    content: 'Test.\n\n```artifact\n<code/>\n```',
    artifacts: [{ id: 'x' }],
  });

  const macMsg = macSocket.getLastSent();
  const cliMsg = cliSocket.getLastSent();

  assertEqual(macMsg.payload.format, 'full');
  assertEqual(cliMsg.payload.format, 'text');
  gw.shutdown();
});

// ─── Tests: Streaming ────────────────────────────────────────────────────

console.log('\n── Streaming ──');

test('streamToken sends chat.token to all session devices', () => {
  const { gw, macSocket } = setupGateway();
  const iosSocket = addDevice(gw, null, 'dev_ios', 'ios', 70, 'ses_main');

  macSocket.clearSent();
  iosSocket.clearSent();

  const sent = gw.streamToken('ses_main', 'Hello', 'Hello');
  assert(sent >= 2);

  const macMsg = macSocket.getLastSent();
  assertEqual(macMsg.type, 'chat.token');
  assertEqual(macMsg.payload.content, 'Hello');
  gw.shutdown();
});

// ─── Tests: Job Notifications ────────────────────────────────────────────

console.log('\n── Job Notifications ──');

test('notifyJob sends job.submitted', () => {
  const { gw, macSocket } = setupGateway();
  macSocket.clearSent();

  gw.notifyJob('ses_main', 'submitted', { job_id: 'j_1', estimated_ms: 5000 });
  assertEqual(macSocket.getLastSent().type, 'job.submitted');
  gw.shutdown();
});

test('notifyJob sends job.progress', () => {
  const { gw, macSocket } = setupGateway();
  macSocket.clearSent();

  gw.notifyJob('ses_main', 'progress', { job_id: 'j_1', percent: 50 });
  assertEqual(macSocket.getLastSent().type, 'job.progress');
  gw.shutdown();
});

test('notifyJob sends job.complete', () => {
  const { gw, macSocket } = setupGateway();
  macSocket.clearSent();

  gw.notifyJob('ses_main', 'complete', { job_id: 'j_1', result: 'done' });
  assertEqual(macSocket.getLastSent().type, 'job.complete');
  gw.shutdown();
});

test('notifyJob returns 0 for unknown event type', () => {
  const { gw } = setupGateway();
  assertEqual(gw.notifyJob('ses_main', 'bogus', {}), 0);
  gw.shutdown();
});

// ─── Tests: Metrics ──────────────────────────────────────────────────────

console.log('\n── Metrics ──');

test('getMetrics combines sync server and gateway metrics', () => {
  const { gw } = setupGateway();
  const m = gw.getMetrics();
  assert('totalConnections' in m);    // from sync server
  assert('totalMessages' in m);       // from sync server
  assert('authFailures' in m);        // from gateway
  assert('messagesRouted' in m);      // from gateway
  assert('responsesFormatted' in m);  // from gateway
  gw.shutdown();
});

// ─── Tests: Shutdown ─────────────────────────────────────────────────────

console.log('\n── Shutdown ──');

test('shutdown clears all state', () => {
  const { gw } = setupGateway();
  addDevice(gw, null, 'dev_ios', 'ios', 70, 'ses_main');
  gw.shutdown();
  assertEqual(gw.getRegistry().getDeviceCount(), 0);
});

// ─── Tests: End-to-End Flow ──────────────────────────────────────────────

console.log('\n── End-to-End Flow ──');

test('full flow: connect → send → receive formatted response', () => {
  const { gw, macSocket } = setupGateway();
  const cliSocket = addDevice(gw, null, 'dev_cli', 'cli', 30, 'ses_main');

  // Register a chat handler that returns a response
  gw.onMessage('chat.send', (enriched) => {
    // Verify surface context was attached
    assert(enriched.surface !== undefined);

    // Simulate intelligence pipeline producing a response
    gw.broadcastResponse(enriched.session_id, {
      content: 'The login page is ready.\n\n```artifact\n<form>...</form>\n```',
      artifacts: [{ id: 'login_form' }],
    });

    return { handled: true };
  });

  macSocket.clearSent();
  cliSocket.clearSent();

  // Send a chat message
  gw.processMessage('dev_mac', {
    type: 'chat.send',
    device_id: 'dev_mac',
    session_id: 'ses_main',
    payload: { content: 'build a login page' },
  });

  // macOS should get full response with artifacts
  const macMsg = macSocket.getLastSent();
  assertEqual(macMsg.type, 'chat.complete');
  assertEqual(macMsg.payload.format, 'full');
  assert(macMsg.payload.formatted.includes('artifact'));

  // CLI should get text-only response
  const cliMsg = cliSocket.getLastSent();
  assertEqual(cliMsg.type, 'chat.complete');
  assertEqual(cliMsg.payload.format, 'text');
  assert(!cliMsg.payload.formatted.includes('```artifact'));

  gw.shutdown();
});

test('full flow: streaming tokens + final response', () => {
  const { gw, macSocket } = setupGateway();
  macSocket.clearSent();

  // Stream 3 tokens
  gw.streamToken('ses_main', 'Hello', 'Hello');
  gw.streamToken('ses_main', ' world', 'Hello world');
  gw.streamToken('ses_main', '!', 'Hello world!');

  // Then send final response
  gw.sendResponse('dev_mac', { content: 'Hello world!' });

  const messages = macSocket.getSent();
  // Should have 3 tokens + 1 complete
  const tokenMsgs = messages.filter(m => m.type === 'chat.token');
  const completeMsgs = messages.filter(m => m.type === 'chat.complete');
  assertEqual(tokenMsgs.length, 3);
  assertEqual(completeMsgs.length, 1);
  assertEqual(tokenMsgs[2].payload.accumulated, 'Hello world!');
  gw.shutdown();
});

test('full flow: async job notification to all surfaces', () => {
  const { gw, macSocket } = setupGateway();
  const iosSocket = addDevice(gw, null, 'dev_ios', 'ios', 70, 'ses_main');

  macSocket.clearSent();
  iosSocket.clearSent();

  gw.notifyJob('ses_main', 'submitted', { job_id: 'j_deep', desc: 'Deep analysis' });
  gw.notifyJob('ses_main', 'progress', { job_id: 'j_deep', percent: 50 });
  gw.notifyJob('ses_main', 'complete', { job_id: 'j_deep', result: 'Analysis complete' });

  const macMsgs = macSocket.getSent();
  const iosMsgs = iosSocket.getSent();

  // Both should get all 3 job events
  assertEqual(macMsgs.filter(m => m.type.startsWith('job.')).length, 3);
  assertEqual(iosMsgs.filter(m => m.type.startsWith('job.')).length, 3);
  gw.shutdown();
});

// ─── Summary ─────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`G6 gateway (CAPSTONE): ${passCount}/${testCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
