// ─── gateway/middleware/surfaceAdapter.test.mjs ──────────────────────────────
// Test suite for G3 Surface Adapter — Middleware #1
// Target: 35+ tests, 0 failures
// Run: node surfaceAdapter.test.mjs 2>&1
// ─────────────────────────────────────────────────────────────────────────────

import {
  createSurfaceAdapter,
  buildSurfaceContext,
  shouldStripArtifacts,
  shouldAddVoiceMarkup,
  getMaxTokens,
  getResponseMode,
  FIDELITY_THRESHOLDS,
  TOKEN_LIMITS,
} from './surfaceAdapter.mjs';

import { createDeviceRegistry } from '../deviceRegistry.mjs';

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

// ─── Tests: Constants ────────────────────────────────────────────────────

console.log('\n── Constants ──');

test('FIDELITY_THRESHOLDS.ARTIFACTS_MIN is 50', () => {
  assertEqual(FIDELITY_THRESHOLDS.ARTIFACTS_MIN, 50);
});

test('TOKEN_LIMITS.FULL is null (no limit)', () => {
  assertEqual(TOKEN_LIMITS.FULL, null);
});

test('TOKEN_LIMITS.MINIMAL is 100', () => {
  assertEqual(TOKEN_LIMITS.MINIMAL, 100);
});

test('TOKEN_LIMITS.AMBIENT is 50', () => {
  assertEqual(TOKEN_LIMITS.AMBIENT, 50);
});

// ─── Tests: buildSurfaceContext ──────────────────────────────────────────

console.log('\n── buildSurfaceContext ──');

test('macOS gets full capabilities', () => {
  const ctx = buildSurfaceContext({
    platform: 'macos', has_voice: true, has_screen: true,
    has_artifacts: true, has_haptics: false, fidelity_score: 100,
  });
  assertEqual(ctx.artifacts_enabled, true);
  assertEqual(ctx.max_tokens, null);
  assertEqual(ctx.response_mode, 'full');
  assertEqual(ctx.voice_markup, false);
});

test('iOS gets artifacts but no voice markup', () => {
  const ctx = buildSurfaceContext({
    platform: 'ios', has_voice: true, has_screen: true,
    has_artifacts: true, has_haptics: true, fidelity_score: 70,
  });
  assertEqual(ctx.artifacts_enabled, true);
  assertEqual(ctx.haptic_feedback, true);
  assertEqual(ctx.voice_markup, false);
});

test('CLI gets no artifacts, short response', () => {
  const ctx = buildSurfaceContext({
    platform: 'cli', has_voice: false, has_screen: true,
    has_artifacts: false, fidelity_score: 30,
  });
  assertEqual(ctx.artifacts_enabled, false);
  assertEqual(ctx.response_mode, 'text');
  assertEqual(ctx.max_tokens, null); // fidelity 30 is >= 30, no cap
});

test('KAGE gets voice markup', () => {
  const ctx = buildSurfaceContext({
    platform: 'kage', has_voice: true, has_screen: true,
    has_artifacts: false, fidelity_score: 40,
  });
  assertEqual(ctx.voice_markup, true);
  assertEqual(ctx.artifacts_enabled, false);
  assertEqual(ctx.response_mode, 'text');
});

test('watchOS gets minimal tokens and voice markup', () => {
  const ctx = buildSurfaceContext({
    platform: 'watchos', has_voice: true, has_screen: true,
    has_artifacts: false, fidelity_score: 15,
  });
  assertEqual(ctx.max_tokens, 100);
  assertEqual(ctx.voice_markup, true);
  assertEqual(ctx.response_mode, 'minimal');
});

test('ambient gets status mode and 50 token limit', () => {
  const ctx = buildSurfaceContext({
    platform: 'ambient', has_voice: false, has_screen: true,
    has_artifacts: false, fidelity_score: 10,
  });
  assertEqual(ctx.response_mode, 'status');
  assertEqual(ctx.max_tokens, 50);
  assertEqual(ctx.artifacts_enabled, false);
});

test('fidelity < 50 disables artifacts', () => {
  const ctx = buildSurfaceContext({ platform: 'web', fidelity_score: 49, has_artifacts: true });
  assertEqual(ctx.artifacts_enabled, false);
});

test('fidelity >= 50 enables artifacts (if has_artifacts)', () => {
  const ctx = buildSurfaceContext({ platform: 'web', fidelity_score: 50, has_artifacts: true });
  assertEqual(ctx.artifacts_enabled, true);
});

test('fidelity < 30 caps tokens at 500', () => {
  const ctx = buildSurfaceContext({ platform: 'generic', fidelity_score: 20 });
  assertEqual(ctx.max_tokens, 500);
});

test('null capabilities fall back to minimal', () => {
  const ctx = buildSurfaceContext(null);
  assertEqual(ctx.platform, 'unknown');
  assertEqual(ctx.fidelity, 0);
  assertEqual(ctx.artifacts_enabled, false);
});

test('surface context includes capabilities copy', () => {
  const caps = { platform: 'macos', fidelity_score: 100 };
  const ctx = buildSurfaceContext(caps);
  assertEqual(ctx.capabilities.platform, 'macos');
});

// ─── Tests: Middleware Factory ────────────────────────────────────────────

console.log('\n── Middleware Factory ──');

test('createSurfaceAdapter throws without registry', () => {
  assertThrows(() => createSurfaceAdapter(null), 'registry');
});

test('middleware enriches request with surface context', () => {
  const reg = createDeviceRegistry();
  reg.registerDevice('dev_mac', 'ses_1', { platform: 'macos', fidelity_score: 100 });

  const adapter = createSurfaceAdapter(reg);
  const result = adapter({ device_id: 'dev_mac', message: 'hello' });

  assert(result.surface !== undefined);
  assertEqual(result.surface.platform, 'macos');
  assertEqual(result.surface.artifacts_enabled, true);
  assertEqual(result.message, 'hello'); // original preserved
});

test('middleware uses fallback for unknown device', () => {
  const reg = createDeviceRegistry();
  const adapter = createSurfaceAdapter(reg);
  const result = adapter({ device_id: 'ghost', message: 'hi' });

  assertEqual(result.surface.platform, 'unknown');
  assertEqual(result.surface.fidelity, 0);
  assertEqual(result.surface.artifacts_enabled, false);
});

test('middleware calls next() with enriched request', () => {
  const reg = createDeviceRegistry();
  reg.registerDevice('dev_ios', 'ses_1', { platform: 'ios', fidelity_score: 70 });

  const adapter = createSurfaceAdapter(reg);
  let passedRequest = null;
  adapter({ device_id: 'dev_ios' }, (req) => { passedRequest = req; });

  assert(passedRequest !== null);
  assertEqual(passedRequest.surface.platform, 'ios');
});

test('middleware returns enriched request when no next()', () => {
  const reg = createDeviceRegistry();
  reg.registerDevice('dev_1', 'ses_1', { platform: 'cli' });

  const adapter = createSurfaceAdapter(reg);
  const result = adapter({ device_id: 'dev_1' });
  assertEqual(result.surface.platform, 'cli');
});

test('middleware does NOT modify original message content', () => {
  const reg = createDeviceRegistry();
  reg.registerDevice('dev_1', 'ses_1', { platform: 'ambient' });

  const adapter = createSurfaceAdapter(reg);
  const original = { device_id: 'dev_1', message: 'original' };
  const result = adapter(original);

  assertEqual(result.message, 'original');
  assert(result !== original); // new object
  assert(!('surface' in original)); // original untouched
});

// ─── Tests: Utility Functions ────────────────────────────────────────────

console.log('\n── Utility Functions ──');

test('shouldStripArtifacts returns true for CLI', () => {
  const ctx = buildSurfaceContext({ platform: 'cli', fidelity_score: 30 });
  assertEqual(shouldStripArtifacts(ctx), true);
});

test('shouldStripArtifacts returns false for macOS', () => {
  const ctx = buildSurfaceContext({ platform: 'macos', fidelity_score: 100, has_artifacts: true });
  assertEqual(shouldStripArtifacts(ctx), false);
});

test('shouldAddVoiceMarkup returns true for KAGE', () => {
  const ctx = buildSurfaceContext({ platform: 'kage', has_voice: true, fidelity_score: 40 });
  assertEqual(shouldAddVoiceMarkup(ctx), true);
});

test('shouldAddVoiceMarkup returns false for macOS', () => {
  const ctx = buildSurfaceContext({ platform: 'macos', has_voice: true, fidelity_score: 100 });
  assertEqual(shouldAddVoiceMarkup(ctx), false);
});

test('getMaxTokens returns null for full fidelity', () => {
  const ctx = buildSurfaceContext({ platform: 'macos', fidelity_score: 100 });
  assertEqual(getMaxTokens(ctx), null);
});

test('getMaxTokens returns 50 for ambient', () => {
  const ctx = buildSurfaceContext({ platform: 'ambient', fidelity_score: 10 });
  assertEqual(getMaxTokens(ctx), 50);
});

test('getResponseMode returns full for macOS', () => {
  const ctx = buildSurfaceContext({ platform: 'macos', fidelity_score: 100, has_artifacts: true });
  assertEqual(getResponseMode(ctx), 'full');
});

test('getResponseMode returns status for ambient', () => {
  const ctx = buildSurfaceContext({ platform: 'ambient', fidelity_score: 10 });
  assertEqual(getResponseMode(ctx), 'status');
});

test('getResponseMode returns text for non-artifact surfaces', () => {
  const ctx = buildSurfaceContext({ platform: 'cli', fidelity_score: 30, has_artifacts: false });
  assertEqual(getResponseMode(ctx), 'text');
});

// ─── Summary ─────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`G3 surfaceAdapter: ${passCount}/${testCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
