// ─── gateway/deviceRegistry.test.mjs ─────────────────────────────────────────
// Test suite for G2 RONIN Device Registry
// Target: 45+ tests, 0 failures
// Run: node deviceRegistry.test.mjs 2>&1
// ─────────────────────────────────────────────────────────────────────────────

import {
  createDeviceRegistry,
  normalizeCapabilities,
  PLATFORM_DEFAULTS,
} from './deviceRegistry.mjs';

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

function assertThrows(fn, substring) {
  try {
    fn();
    throw new Error('Expected function to throw');
  } catch (e) {
    if (substring && !e.message.includes(substring)) {
      throw new Error(`Expected error to include "${substring}", got "${e.message}"`);
    }
  }
}

// ─── Tests: Platform Defaults ────────────────────────────────────────────

console.log('\n── Platform Defaults ──');

test('PLATFORM_DEFAULTS has 8 platforms', () => {
  assertEqual(Object.keys(PLATFORM_DEFAULTS).length, 8);
});

test('macOS defaults: fidelity 100, artifacts true', () => {
  assertEqual(PLATFORM_DEFAULTS.macos.fidelity_score, 100);
  assertEqual(PLATFORM_DEFAULTS.macos.has_artifacts, true);
});

test('iOS defaults: fidelity 70, haptics true', () => {
  assertEqual(PLATFORM_DEFAULTS.ios.fidelity_score, 70);
  assertEqual(PLATFORM_DEFAULTS.ios.has_haptics, true);
});

test('CLI defaults: fidelity 30, artifacts false, voice false', () => {
  assertEqual(PLATFORM_DEFAULTS.cli.fidelity_score, 30);
  assertEqual(PLATFORM_DEFAULTS.cli.has_artifacts, false);
  assertEqual(PLATFORM_DEFAULTS.cli.has_voice, false);
});

test('watchOS defaults: fidelity 15', () => {
  assertEqual(PLATFORM_DEFAULTS.watchos.fidelity_score, 15);
});

test('KAGE defaults: fidelity 40, voice true', () => {
  assertEqual(PLATFORM_DEFAULTS.kage.fidelity_score, 40);
  assertEqual(PLATFORM_DEFAULTS.kage.has_voice, true);
});

test('ambient defaults: fidelity 10, voice false, artifacts false', () => {
  assertEqual(PLATFORM_DEFAULTS.ambient.fidelity_score, 10);
  assertEqual(PLATFORM_DEFAULTS.ambient.has_voice, false);
  assertEqual(PLATFORM_DEFAULTS.ambient.has_artifacts, false);
});

// ─── Tests: normalizeCapabilities ────────────────────────────────────────

console.log('\n── normalizeCapabilities ──');

test('normalizes empty object with unknown platform defaults', () => {
  const caps = normalizeCapabilities({});
  assertEqual(caps.platform, 'unknown');
  assertEqual(caps.fidelity_score, 0);
  assertEqual(caps.has_voice, false);
});

test('normalizes macos platform with defaults', () => {
  const caps = normalizeCapabilities({ platform: 'macos' });
  assertEqual(caps.fidelity_score, 100);
  assertEqual(caps.has_artifacts, true);
  assertEqual(caps.has_voice, true);
});

test('explicit overrides beat platform defaults', () => {
  const caps = normalizeCapabilities({
    platform: 'macos',
    has_artifacts: false,
    fidelity_score: 50,
  });
  assertEqual(caps.has_artifacts, false);
  assertEqual(caps.fidelity_score, 50);
});

test('clamps fidelity to 0-100', () => {
  assertEqual(normalizeCapabilities({ fidelity_score: -10 }).fidelity_score, 0);
  assertEqual(normalizeCapabilities({ fidelity_score: 200 }).fidelity_score, 100);
  assertEqual(normalizeCapabilities({ fidelity_score: 55.7 }).fidelity_score, 56);
});

test('handles NaN fidelity as 0', () => {
  assertEqual(normalizeCapabilities({ fidelity_score: NaN }).fidelity_score, 0);
  assertEqual(normalizeCapabilities({ fidelity_score: 'bad' }).fidelity_score, 0);
});

test('platform is lowercased', () => {
  assertEqual(normalizeCapabilities({ platform: 'MacOS' }).platform, 'macos');
  assertEqual(normalizeCapabilities({ platform: 'IOS' }).platform, 'ios');
});

test('includes registered_at timestamp', () => {
  const before = Date.now();
  const caps = normalizeCapabilities({ platform: 'web' });
  assert(caps.registered_at >= before);
});

// ─── Tests: Registration ─────────────────────────────────────────────────

console.log('\n── Registration ──');

test('registerDevice stores device', () => {
  const reg = createDeviceRegistry();
  reg.registerDevice('dev_1', 'ses_1', { platform: 'macos' });
  assertEqual(reg.isRegistered('dev_1'), true);
});

test('registerDevice returns deviceId, sessionId, capabilities', () => {
  const reg = createDeviceRegistry();
  const result = reg.registerDevice('dev_1', 'ses_1', { platform: 'ios' });
  assertEqual(result.deviceId, 'dev_1');
  assertEqual(result.sessionId, 'ses_1');
  assertEqual(result.capabilities.platform, 'ios');
  assertEqual(result.capabilities.fidelity_score, 70);
});

test('registerDevice throws for empty deviceId', () => {
  const reg = createDeviceRegistry();
  assertThrows(() => reg.registerDevice('', 'ses_1'), 'deviceId');
});

test('registerDevice throws for empty sessionId', () => {
  const reg = createDeviceRegistry();
  assertThrows(() => reg.registerDevice('dev_1', ''), 'sessionId');
});

test('registerDevice adds device to session', () => {
  const reg = createDeviceRegistry();
  reg.registerDevice('dev_1', 'ses_1', { platform: 'macos' });
  assertEqual(reg.getSessionDeviceCount('ses_1'), 1);
});

test('re-registering device in same session updates capabilities', () => {
  const reg = createDeviceRegistry();
  reg.registerDevice('dev_1', 'ses_1', { platform: 'macos', fidelity_score: 100 });
  reg.registerDevice('dev_1', 'ses_1', { platform: 'macos', fidelity_score: 80 });
  assertEqual(reg.getDeviceCapabilities('dev_1').fidelity_score, 80);
  assertEqual(reg.getSessionDeviceCount('ses_1'), 1); // not duplicated
});

test('re-registering device in different session transfers it', () => {
  const reg = createDeviceRegistry();
  reg.registerDevice('dev_1', 'ses_old');
  reg.registerDevice('dev_1', 'ses_new');
  assertEqual(reg.getDeviceSession('dev_1'), 'ses_new');
  assertEqual(reg.getSessionDeviceCount('ses_old'), 0);
  assertEqual(reg.getSessionDeviceCount('ses_new'), 1);
});

// ─── Tests: Deregistration ───────────────────────────────────────────────

console.log('\n── Deregistration ──');

test('deregisterDevice removes device', () => {
  const reg = createDeviceRegistry();
  reg.registerDevice('dev_1', 'ses_1');
  assertEqual(reg.deregisterDevice('dev_1'), true);
  assertEqual(reg.isRegistered('dev_1'), false);
});

test('deregisterDevice returns false for unknown device', () => {
  const reg = createDeviceRegistry();
  assertEqual(reg.deregisterDevice('ghost'), false);
});

test('deregisterDevice removes from session', () => {
  const reg = createDeviceRegistry();
  reg.registerDevice('dev_1', 'ses_1');
  reg.deregisterDevice('dev_1');
  assertEqual(reg.getSessionDeviceCount('ses_1'), 0);
});

test('deregisterDevice cleans up empty session', () => {
  const reg = createDeviceRegistry();
  reg.registerDevice('dev_1', 'ses_solo');
  reg.deregisterDevice('dev_1');
  assertEqual(reg.getSessionCount(), 0);
});

// ─── Tests: Queries ──────────────────────────────────────────────────────

console.log('\n── Queries ──');

test('getDeviceCapabilities returns copy (not reference)', () => {
  const reg = createDeviceRegistry();
  reg.registerDevice('dev_1', 'ses_1', { platform: 'macos' });
  const caps = reg.getDeviceCapabilities('dev_1');
  caps.fidelity_score = 999;
  assertEqual(reg.getDeviceCapabilities('dev_1').fidelity_score, 100); // unchanged
});

test('getDeviceCapabilities returns null for unknown device', () => {
  const reg = createDeviceRegistry();
  assertEqual(reg.getDeviceCapabilities('ghost'), null);
});

test('getSessionDevices returns all devices in session', () => {
  const reg = createDeviceRegistry();
  reg.registerDevice('dev_mac', 'ses_1', { platform: 'macos' });
  reg.registerDevice('dev_ios', 'ses_1', { platform: 'ios' });
  const devices = reg.getSessionDevices('ses_1');
  assertEqual(devices.length, 2);
});

test('getSessionDevices returns empty for unknown session', () => {
  const reg = createDeviceRegistry();
  assertEqual(reg.getSessionDevices('ghost').length, 0);
});

test('getHighestFidelityDevice returns macOS over others', () => {
  const reg = createDeviceRegistry();
  reg.registerDevice('dev_cli', 'ses_1', { platform: 'cli' });
  reg.registerDevice('dev_mac', 'ses_1', { platform: 'macos' });
  reg.registerDevice('dev_ios', 'ses_1', { platform: 'ios' });

  const best = reg.getHighestFidelityDevice('ses_1');
  assertEqual(best.device_id, 'dev_mac');
  assertEqual(best.capabilities.fidelity_score, 100);
});

test('getHighestFidelityDevice returns null for empty session', () => {
  const reg = createDeviceRegistry();
  assertEqual(reg.getHighestFidelityDevice('ghost'), null);
});

test('getLowestFidelityDevice returns ambient over others', () => {
  const reg = createDeviceRegistry();
  reg.registerDevice('dev_mac', 'ses_1', { platform: 'macos' });
  reg.registerDevice('dev_ambient', 'ses_1', { platform: 'ambient' });
  reg.registerDevice('dev_ios', 'ses_1', { platform: 'ios' });

  const worst = reg.getLowestFidelityDevice('ses_1');
  assertEqual(worst.device_id, 'dev_ambient');
  assertEqual(worst.capabilities.fidelity_score, 10);
});

test('getDevicesWithCapability filters by has_voice', () => {
  const reg = createDeviceRegistry();
  reg.registerDevice('dev_mac', 'ses_1', { platform: 'macos' });
  reg.registerDevice('dev_cli', 'ses_1', { platform: 'cli' }); // no voice
  reg.registerDevice('dev_kage', 'ses_1', { platform: 'kage' });

  const voiceDevices = reg.getDevicesWithCapability('ses_1', 'has_voice');
  assertEqual(voiceDevices.length, 2); // mac + kage
});

test('getDevicesWithCapability filters by has_artifacts', () => {
  const reg = createDeviceRegistry();
  reg.registerDevice('dev_mac', 'ses_1', { platform: 'macos' });
  reg.registerDevice('dev_watch', 'ses_1', { platform: 'watchos' });

  const artifactDevices = reg.getDevicesWithCapability('ses_1', 'has_artifacts');
  assertEqual(artifactDevices.length, 1);
  assertEqual(artifactDevices[0].device_id, 'dev_mac');
});

test('getDeviceSession returns correct session', () => {
  const reg = createDeviceRegistry();
  reg.registerDevice('dev_1', 'ses_42');
  assertEqual(reg.getDeviceSession('dev_1'), 'ses_42');
});

test('getDeviceSession returns null for unknown device', () => {
  const reg = createDeviceRegistry();
  assertEqual(reg.getDeviceSession('ghost'), null);
});

// ─── Tests: Transfer ─────────────────────────────────────────────────────

console.log('\n── Transfer ──');

test('transferDevice moves device between sessions', () => {
  const reg = createDeviceRegistry();
  reg.registerDevice('dev_1', 'ses_old');
  const result = reg.transferDevice('dev_1', 'ses_new');
  assertEqual(result.from, 'ses_old');
  assertEqual(result.to, 'ses_new');
  assertEqual(reg.getDeviceSession('dev_1'), 'ses_new');
  assertEqual(reg.getSessionDeviceCount('ses_old'), 0);
  assertEqual(reg.getSessionDeviceCount('ses_new'), 1);
});

test('transferDevice returns false for unknown device', () => {
  const reg = createDeviceRegistry();
  assertEqual(reg.transferDevice('ghost', 'ses_new'), false);
});

test('transferDevice returns false for invalid sessionId', () => {
  const reg = createDeviceRegistry();
  reg.registerDevice('dev_1', 'ses_1');
  assertEqual(reg.transferDevice('dev_1', ''), false);
});

test('transferDevice cleans up empty old session', () => {
  const reg = createDeviceRegistry();
  reg.registerDevice('dev_1', 'ses_solo');
  reg.transferDevice('dev_1', 'ses_new');
  assertEqual(reg.getSessionCount(), 1); // only ses_new
});

// ─── Tests: Touch ────────────────────────────────────────────────────────

console.log('\n── Touch ──');

test('touchDevice updates lastSeen', () => {
  const reg = createDeviceRegistry();
  reg.registerDevice('dev_1', 'ses_1');
  const before = reg.getSessionDevices('ses_1')[0].lastSeen;

  // Tiny delay to ensure timestamp changes
  const spinUntil = Date.now() + 2;
  while (Date.now() < spinUntil) {}

  reg.touchDevice('dev_1');
  const after = reg.getSessionDevices('ses_1')[0].lastSeen;
  assert(after >= before);
});

test('touchDevice returns false for unknown device', () => {
  const reg = createDeviceRegistry();
  assertEqual(reg.touchDevice('ghost'), false);
});

// ─── Tests: Counts ───────────────────────────────────────────────────────

console.log('\n── Counts ──');

test('getDeviceCount tracks total devices', () => {
  const reg = createDeviceRegistry();
  assertEqual(reg.getDeviceCount(), 0);
  reg.registerDevice('a', 'ses_1');
  reg.registerDevice('b', 'ses_1');
  assertEqual(reg.getDeviceCount(), 2);
});

test('getSessionCount tracks total sessions', () => {
  const reg = createDeviceRegistry();
  reg.registerDevice('a', 'ses_1');
  reg.registerDevice('b', 'ses_2');
  assertEqual(reg.getSessionCount(), 2);
});

test('getSessionDeviceCount returns count for specific session', () => {
  const reg = createDeviceRegistry();
  reg.registerDevice('a', 'ses_1');
  reg.registerDevice('b', 'ses_1');
  reg.registerDevice('c', 'ses_2');
  assertEqual(reg.getSessionDeviceCount('ses_1'), 2);
  assertEqual(reg.getSessionDeviceCount('ses_2'), 1);
  assertEqual(reg.getSessionDeviceCount('ses_3'), 0);
});

// ─── Tests: Bulk ─────────────────────────────────────────────────────────

console.log('\n── Bulk ──');

test('getAllDevices returns all registered devices', () => {
  const reg = createDeviceRegistry();
  reg.registerDevice('a', 'ses_1', { platform: 'macos' });
  reg.registerDevice('b', 'ses_2', { platform: 'ios' });
  const all = reg.getAllDevices();
  assertEqual(all.length, 2);
  assert(all.some(d => d.device_id === 'a'));
  assert(all.some(d => d.device_id === 'b'));
});

test('getAllSessions returns all sessions with device counts', () => {
  const reg = createDeviceRegistry();
  reg.registerDevice('a', 'ses_1');
  reg.registerDevice('b', 'ses_1');
  reg.registerDevice('c', 'ses_2');
  const all = reg.getAllSessions();
  assertEqual(all.length, 2);
  const s1 = all.find(s => s.session_id === 'ses_1');
  assertEqual(s1.device_count, 2);
});

// ─── Tests: Clear ────────────────────────────────────────────────────────

console.log('\n── Clear ──');

test('clear removes all state', () => {
  const reg = createDeviceRegistry();
  reg.registerDevice('a', 'ses_1');
  reg.registerDevice('b', 'ses_2');
  reg.clear();
  assertEqual(reg.getDeviceCount(), 0);
  assertEqual(reg.getSessionCount(), 0);
});

// ─── Summary ─────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`G2 deviceRegistry: ${passCount}/${testCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
