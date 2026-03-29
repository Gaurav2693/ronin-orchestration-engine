// ─── gateway/auth.test.mjs ────────────────────────────────────────────────────
// Test suite for G5 RONIN Device Token Auth
// Target: 35+ tests, 0 failures
// Run: node auth.test.mjs 2>&1
// ─────────────────────────────────────────────────────────────────────────────

import {
  createAuthStore,
  generateTokenString,
} from './auth.mjs';

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
  try { fn(); throw new Error('Expected throw'); }
  catch (e) { if (substring && !e.message.includes(substring)) throw new Error(`Expected "${substring}" in "${e.message}"`); }
}

// ─── Tests: Token Generation ─────────────────────────────────────────────

console.log('\n── Token Generation ──');

test('generateTokenString produces rtk_ prefixed string', () => {
  const token = generateTokenString();
  assert(token.startsWith('rtk_'));
});

test('generateTokenString produces 68-char token (4 prefix + 64 hex)', () => {
  assertEqual(generateTokenString().length, 68);
});

test('generateTokenString produces unique tokens', () => {
  const tokens = new Set();
  for (let i = 0; i < 100; i++) tokens.add(generateTokenString());
  assertEqual(tokens.size, 100);
});

// ─── Tests: Root Initialization ──────────────────────────────────────────

console.log('\n── Root Initialization ──');

test('initializeRoot creates root token', () => {
  const auth = createAuthStore();
  const result = auth.initializeRoot('dev_mac');
  assert(result.token.startsWith('rtk_'));
  assertEqual(result.device_id, 'dev_mac');
});

test('initializeRoot marks store as initialized', () => {
  const auth = createAuthStore();
  assertEqual(auth.isRootInitialized(), false);
  auth.initializeRoot('dev_mac');
  assertEqual(auth.isRootInitialized(), true);
});

test('initializeRoot sets root device id', () => {
  const auth = createAuthStore();
  auth.initializeRoot('dev_mac');
  assertEqual(auth.getRootDeviceId(), 'dev_mac');
});

test('initializeRoot throws on second call', () => {
  const auth = createAuthStore();
  auth.initializeRoot('dev_mac');
  assertThrows(() => auth.initializeRoot('dev_mac2'), 'already initialized');
});

test('initializeRoot throws for empty deviceId', () => {
  const auth = createAuthStore();
  assertThrows(() => auth.initializeRoot(''), 'non-empty');
});

test('root token validates successfully', () => {
  const auth = createAuthStore();
  const { token } = auth.initializeRoot('dev_mac');
  const result = auth.validateToken(token);
  assertEqual(result.valid, true);
  assertEqual(result.device_id, 'dev_mac');
  assertEqual(result.is_root, true);
});

// ─── Tests: Device Token Generation ──────────────────────────────────────

console.log('\n── Device Token Generation ──');

test('generateDeviceToken creates token for new device', () => {
  const auth = createAuthStore();
  auth.initializeRoot('dev_mac');
  const result = auth.generateDeviceToken('dev_mac', 'dev_ios', 'iPhone');
  assert(result.token.startsWith('rtk_'));
  assertEqual(result.device_id, 'dev_ios');
});

test('generated token validates', () => {
  const auth = createAuthStore();
  auth.initializeRoot('dev_mac');
  const { token } = auth.generateDeviceToken('dev_mac', 'dev_ios');
  const result = auth.validateToken(token);
  assertEqual(result.valid, true);
  assertEqual(result.device_id, 'dev_ios');
  assertEqual(result.is_root, false);
});

test('unauthenticated device cannot generate tokens', () => {
  const auth = createAuthStore();
  auth.initializeRoot('dev_mac');
  assertThrows(
    () => auth.generateDeviceToken('dev_stranger', 'dev_new'),
    'not authenticated'
  );
});

test('generating token for existing device replaces old token', () => {
  const auth = createAuthStore();
  auth.initializeRoot('dev_mac');
  const old = auth.generateDeviceToken('dev_mac', 'dev_ios');
  const newer = auth.generateDeviceToken('dev_mac', 'dev_ios');

  assertEqual(auth.validateToken(old.token).valid, false); // old revoked
  assertEqual(auth.validateToken(newer.token).valid, true); // new works
});

test('requires both requestingDeviceId and newDeviceId', () => {
  const auth = createAuthStore();
  auth.initializeRoot('dev_mac');
  assertThrows(() => auth.generateDeviceToken('dev_mac', ''), 'required');
  assertThrows(() => auth.generateDeviceToken('', 'dev_new'), 'required');
});

// ─── Tests: Validation ───────────────────────────────────────────────────

console.log('\n── Validation ──');

test('validateToken rejects null', () => {
  const auth = createAuthStore();
  assertEqual(auth.validateToken(null).valid, false);
});

test('validateToken rejects empty string', () => {
  const auth = createAuthStore();
  assertEqual(auth.validateToken('').valid, false);
});

test('validateToken rejects unknown token', () => {
  const auth = createAuthStore();
  const result = auth.validateToken('rtk_fake');
  assertEqual(result.valid, false);
  assertEqual(result.reason, 'Unknown token');
});

test('validateToken detects revoked tokens', () => {
  const auth = createAuthStore();
  auth.initializeRoot('dev_mac');
  const { token } = auth.generateDeviceToken('dev_mac', 'dev_ios');
  auth.revokeToken('dev_ios');
  const result = auth.validateToken(token);
  assertEqual(result.valid, false);
  assert(result.reason.includes('revoked'));
});

// ─── Tests: Revocation ───────────────────────────────────────────────────

console.log('\n── Revocation ──');

test('revokeToken removes device access', () => {
  const auth = createAuthStore();
  auth.initializeRoot('dev_mac');
  auth.generateDeviceToken('dev_mac', 'dev_ios');
  assertEqual(auth.revokeToken('dev_ios'), true);
  assertEqual(auth.isDeviceAuthenticated('dev_ios'), false);
});

test('revokeToken returns false for unknown device', () => {
  const auth = createAuthStore();
  assertEqual(auth.revokeToken('ghost'), false);
});

test('revokeAllExcept keeps only specified device', () => {
  const auth = createAuthStore();
  auth.initializeRoot('dev_mac');
  auth.generateDeviceToken('dev_mac', 'dev_ios');
  auth.generateDeviceToken('dev_mac', 'dev_web');
  auth.generateDeviceToken('dev_mac', 'dev_cli');

  const revoked = auth.revokeAllExcept('dev_mac');
  assertEqual(revoked, 3); // ios + web + cli
  assertEqual(auth.getActiveDeviceCount(), 1);
  assertEqual(auth.isDeviceAuthenticated('dev_mac'), true);
  assertEqual(auth.isDeviceAuthenticated('dev_ios'), false);
});

test('revoked tokens appear in revoked list', () => {
  const auth = createAuthStore();
  auth.initializeRoot('dev_mac');
  auth.generateDeviceToken('dev_mac', 'dev_ios', 'iPhone');
  auth.revokeToken('dev_ios');

  const revoked = auth.listRevokedTokens();
  assertEqual(revoked.length, 1);
  assertEqual(revoked[0].device_id, 'dev_ios');
  assertEqual(revoked[0].reason, 'manual');
});

// ─── Tests: Reset ────────────────────────────────────────────────────────

console.log('\n── Reset ──');

test('resetRoot clears everything', () => {
  const auth = createAuthStore();
  auth.initializeRoot('dev_mac');
  auth.generateDeviceToken('dev_mac', 'dev_ios');
  auth.resetRoot();

  assertEqual(auth.isRootInitialized(), false);
  assertEqual(auth.getActiveDeviceCount(), 0);
  assertEqual(auth.getRootDeviceId(), null);
});

test('resetRoot allows re-initialization', () => {
  const auth = createAuthStore();
  auth.initializeRoot('dev_mac');
  auth.resetRoot();
  const result = auth.initializeRoot('dev_mac_2');
  assertEqual(result.device_id, 'dev_mac_2');
  assertEqual(auth.isRootInitialized(), true);
});

test('resetRoot puts old tokens in revoked list', () => {
  const auth = createAuthStore();
  auth.initializeRoot('dev_mac');
  auth.generateDeviceToken('dev_mac', 'dev_ios');
  auth.resetRoot();

  const revoked = auth.listRevokedTokens();
  assertEqual(revoked.length, 2); // root + ios
  assert(revoked.every(r => r.reason === 'root_reset'));
});

// ─── Tests: Queries ──────────────────────────────────────────────────────

console.log('\n── Queries ──');

test('listActiveTokens returns all active devices', () => {
  const auth = createAuthStore();
  auth.initializeRoot('dev_mac');
  auth.generateDeviceToken('dev_mac', 'dev_ios');
  auth.generateDeviceToken('dev_mac', 'dev_web');

  const active = auth.listActiveTokens();
  assertEqual(active.length, 3);
});

test('listActiveTokens does NOT expose token values', () => {
  const auth = createAuthStore();
  auth.initializeRoot('dev_mac');
  const active = auth.listActiveTokens();
  for (const entry of active) {
    assert(!('token' in entry), 'Token value should not be exposed');
    assert(entry.device_id !== undefined);
  }
});

test('getActiveDeviceCount tracks correct count', () => {
  const auth = createAuthStore();
  assertEqual(auth.getActiveDeviceCount(), 0);
  auth.initializeRoot('dev_mac');
  assertEqual(auth.getActiveDeviceCount(), 1);
  auth.generateDeviceToken('dev_mac', 'dev_ios');
  assertEqual(auth.getActiveDeviceCount(), 2);
  auth.revokeToken('dev_ios');
  assertEqual(auth.getActiveDeviceCount(), 1);
});

test('isDeviceAuthenticated returns correct status', () => {
  const auth = createAuthStore();
  auth.initializeRoot('dev_mac');
  assertEqual(auth.isDeviceAuthenticated('dev_mac'), true);
  assertEqual(auth.isDeviceAuthenticated('dev_ios'), false);
});

test('getDeviceTokenInfo returns metadata without token', () => {
  const auth = createAuthStore();
  auth.initializeRoot('dev_mac');
  auth.generateDeviceToken('dev_mac', 'dev_ios', 'My iPhone');

  const info = auth.getDeviceTokenInfo('dev_ios');
  assertEqual(info.device_id, 'dev_ios');
  assertEqual(info.label, 'My iPhone');
  assertEqual(info.created_by, 'dev_mac');
  assertEqual(info.is_root, false);
  assert(!('token' in info));
});

test('getDeviceTokenInfo returns null for unknown device', () => {
  const auth = createAuthStore();
  assertEqual(auth.getDeviceTokenInfo('ghost'), null);
});

// ─── Summary ─────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`G5 auth: ${passCount}/${testCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
