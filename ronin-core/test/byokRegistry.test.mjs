// test/byokRegistry.test.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Tests for RONIN BYOK Registry
// ─────────────────────────────────────────────────────────────────────────────

import { BYOKRegistry, validateKey, BYOK_PROVIDERS } from '../config/byokRegistry.mjs';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'Mismatch'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

function assertDeepEqual(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg || 'Deep mismatch'}:\n  expected: ${JSON.stringify(b)}\n  got: ${JSON.stringify(a)}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

// Shared valid keys for tests
const VALID_KEYS = {
  anthropic: 'sk-ant-api03-test1234567890abcdefghijklmno',
  openai:    'sk-proj-test1234567890abcdefghijklmnopqrstuv',
  groq:      'gsk_test1234567890abcdefghijklmno',
  gemini:    'AIzaSyTest1234567890abcdefghij',
};

function freshRegistry() {
  return new BYOKRegistry({ secret: 'test-secret-1234567890abcdef' });
}

console.log('\n─── byokRegistry.test.mjs ───────────────────────────────\n');

// ─── validateKey ─────────────────────────────────────────────────────────────

console.log('validateKey():');

test('valid Anthropic key', () => {
  const r = validateKey('anthropic', VALID_KEYS.anthropic);
  assertEqual(r.valid, true);
});

test('valid OpenAI key', () => {
  const r = validateKey('openai', VALID_KEYS.openai);
  assertEqual(r.valid, true);
});

test('valid Groq key', () => {
  const r = validateKey('groq', VALID_KEYS.groq);
  assertEqual(r.valid, true);
});

test('valid Gemini key', () => {
  const r = validateKey('gemini', VALID_KEYS.gemini);
  assertEqual(r.valid, true);
});

test('unknown provider returns error', () => {
  const r = validateKey('cohere', 'some-key');
  assertEqual(r.valid, false);
  assert(r.error.includes('Unknown'));
});

test('null key returns error', () => {
  const r = validateKey('anthropic', null);
  assertEqual(r.valid, false);
});

test('empty string key returns error', () => {
  const r = validateKey('anthropic', '');
  assertEqual(r.valid, false);
});

test('wrong prefix returns error', () => {
  const r = validateKey('anthropic', 'sk-openai-wrong-prefix-key-here');
  assertEqual(r.valid, false);
  assert(r.error.includes('prefix'));
});

test('too-short key returns error', () => {
  const r = validateKey('anthropic', 'sk-ant-short');
  assertEqual(r.valid, false);
  assert(r.error.includes('short'));
});

// ─── BYOK_PROVIDERS metadata ─────────────────────────────────────────────────

console.log('\nBYOK_PROVIDERS:');

test('has all 4 providers', () => {
  const keys = Object.keys(BYOK_PROVIDERS);
  assert(keys.includes('anthropic'));
  assert(keys.includes('openai'));
  assert(keys.includes('groq'));
  assert(keys.includes('gemini'));
  assertEqual(keys.length, 4);
});

test('each provider has required fields', () => {
  for (const [name, def] of Object.entries(BYOK_PROVIDERS)) {
    assert(def.envKey, `${name} missing envKey`);
    assert(def.prefix, `${name} missing prefix`);
    assert(def.minLength > 0, `${name} missing minLength`);
    assert(def.description, `${name} missing description`);
  }
});

// ─── register ────────────────────────────────────────────────────────────────

console.log('\nregister():');

test('registers a single key', () => {
  const reg = freshRegistry();
  const result = reg.register('user-1', { anthropic: VALID_KEYS.anthropic });
  assert(result.registered.includes('anthropic'));
  assertEqual(result.registered.length, 1);
  assertEqual(reg.has('user-1'), true);
});

test('registers multiple keys at once', () => {
  const reg = freshRegistry();
  const result = reg.register('user-1', VALID_KEYS);
  assertEqual(result.registered.length, 4);
  assertEqual(reg.has('user-1'), true);
});

test('skips null/undefined keys', () => {
  const reg = freshRegistry();
  const result = reg.register('user-1', { anthropic: VALID_KEYS.anthropic, openai: null });
  assert(result.registered.includes('anthropic'));
  assert(result.skipped.includes('openai'));
});

test('throws on invalid key in strict mode (default)', () => {
  const reg = freshRegistry();
  let threw = false;
  try {
    reg.register('user-1', { anthropic: 'bad-key' });
  } catch (err) {
    threw = true;
    assert(err.message.includes('validation failed'));
  }
  assert(threw);
});

test('partial mode saves valid keys and reports errors', () => {
  const reg = freshRegistry();
  const result = reg.register('user-1',
    { anthropic: VALID_KEYS.anthropic, openai: 'bad-key' },
    { partial: true }
  );
  assert(result.registered.includes('anthropic'));
  assert('openai' in result.errors);
  assertEqual(reg.has('user-1'), true);
});

test('throws on missing userId', () => {
  const reg = freshRegistry();
  let threw = false;
  try { reg.register('', { anthropic: VALID_KEYS.anthropic }); } catch { threw = true; }
  assert(threw);
});

test('throws on null keys object', () => {
  const reg = freshRegistry();
  let threw = false;
  try { reg.register('user-1', null); } catch { threw = true; }
  assert(threw);
});

test('throws when no valid keys provided', () => {
  const reg = freshRegistry();
  let threw = false;
  try { reg.register('user-1', { openai: null, groq: null }); } catch { threw = true; }
  assert(threw);
});

test('merges new keys with existing', () => {
  const reg = freshRegistry();
  reg.register('user-1', { anthropic: VALID_KEYS.anthropic });
  reg.register('user-1', { openai: VALID_KEYS.openai });
  const providers = reg.listProviders('user-1');
  assert(providers.includes('anthropic'));
  assert(providers.includes('openai'));
});

test('overrides existing key for same provider', () => {
  const reg = freshRegistry();
  const key1 = 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const key2 = 'sk-ant-api03-bbbbbbbbbbbbbbbbbbbbbbbbbbb';
  reg.register('user-1', { anthropic: key1 });
  reg.register('user-1', { anthropic: key2 });
  // Verify by listing (we can't read raw key values)
  assertEqual(reg.listProviders('user-1').includes('anthropic'), true);
});

// ─── has / hasProvider ────────────────────────────────────────────────────────

console.log('\nhas() / hasProvider():');

test('has() returns false for unknown user', () => {
  const reg = freshRegistry();
  assertEqual(reg.has('ghost'), false);
});

test('has() returns true after registration', () => {
  const reg = freshRegistry();
  reg.register('user-1', { anthropic: VALID_KEYS.anthropic });
  assertEqual(reg.has('user-1'), true);
});

test('hasProvider() returns false for unknown user', () => {
  const reg = freshRegistry();
  assertEqual(reg.hasProvider('ghost', 'anthropic'), false);
});

test('hasProvider() returns true for registered provider', () => {
  const reg = freshRegistry();
  reg.register('user-1', { anthropic: VALID_KEYS.anthropic });
  assertEqual(reg.hasProvider('user-1', 'anthropic'), true);
});

test('hasProvider() returns false for unregistered provider', () => {
  const reg = freshRegistry();
  reg.register('user-1', { anthropic: VALID_KEYS.anthropic });
  assertEqual(reg.hasProvider('user-1', 'openai'), false);
});

// ─── listProviders ────────────────────────────────────────────────────────────

console.log('\nlistProviders():');

test('returns empty array for unknown user', () => {
  const reg = freshRegistry();
  assertDeepEqual(reg.listProviders('ghost'), []);
});

test('returns list of registered provider names', () => {
  const reg = freshRegistry();
  reg.register('user-1', { anthropic: VALID_KEYS.anthropic, groq: VALID_KEYS.groq });
  const list = reg.listProviders('user-1');
  assert(list.includes('anthropic'));
  assert(list.includes('groq'));
  assertEqual(list.length, 2);
});

// ─── remove ───────────────────────────────────────────────────────────────────

console.log('\nremove():');

test('remove all keys for a user', () => {
  const reg = freshRegistry();
  reg.register('user-1', VALID_KEYS);
  const removed = reg.remove('user-1');
  assertEqual(removed, true);
  assertEqual(reg.has('user-1'), false);
});

test('remove returns false for unknown user', () => {
  const reg = freshRegistry();
  assertEqual(reg.remove('ghost'), false);
});

test('remove a single provider key', () => {
  const reg = freshRegistry();
  reg.register('user-1', { anthropic: VALID_KEYS.anthropic, openai: VALID_KEYS.openai });
  reg.remove('user-1', 'anthropic');
  assertEqual(reg.hasProvider('user-1', 'anthropic'), false);
  assertEqual(reg.hasProvider('user-1', 'openai'), true);
});

test('remove last provider deletes user entry', () => {
  const reg = freshRegistry();
  reg.register('user-1', { anthropic: VALID_KEYS.anthropic });
  reg.remove('user-1', 'anthropic');
  assertEqual(reg.has('user-1'), false);
});

// ─── getStats ─────────────────────────────────────────────────────────────────

console.log('\ngetStats():');

test('empty registry stats', () => {
  const reg = freshRegistry();
  const stats = reg.getStats();
  assertEqual(stats.totalUsers, 0);
  assertDeepEqual(stats.byProvider, {});
});

test('stats count users per provider', () => {
  const reg = freshRegistry();
  reg.register('user-1', { anthropic: VALID_KEYS.anthropic, openai: VALID_KEYS.openai });
  reg.register('user-2', { anthropic: VALID_KEYS.anthropic });
  const stats = reg.getStats();
  assertEqual(stats.totalUsers, 2);
  assertEqual(stats.byProvider.anthropic, 2);
  assertEqual(stats.byProvider.openai, 1);
  assert(!stats.byProvider.groq);
});

// ─── clear ────────────────────────────────────────────────────────────────────

console.log('\nclear():');

test('clear removes all users', () => {
  const reg = freshRegistry();
  reg.register('user-1', { anthropic: VALID_KEYS.anthropic });
  reg.register('user-2', { openai: VALID_KEYS.openai });
  const count = reg.clear();
  assertEqual(count, 2);
  assertEqual(reg.getStats().totalUsers, 0);
});

// ─── getProviders (provider instances) ────────────────────────────────────────

console.log('\ngetProviders():');

await testAsync('returns null for unknown user', async () => {
  const reg = freshRegistry();
  const result = await reg.getProviders('ghost');
  assertEqual(result, null);
});

await testAsync('returns provider instances for registered user', async () => {
  const reg = freshRegistry();
  reg.register('user-1', { anthropic: VALID_KEYS.anthropic, openai: VALID_KEYS.openai });
  const providers = await reg.getProviders('user-1');
  assert(providers !== null);
  assertEqual(providers._isByok, true);
  assertEqual(providers._userId, 'user-1');
  assert(providers.anthropic, 'should have anthropic');
  assert(providers.openai, 'should have openai');
  assert(!providers.groq, 'should not have groq');
});

await testAsync('providers have _byok flag set', async () => {
  const reg = freshRegistry();
  reg.register('user-1', { anthropic: VALID_KEYS.anthropic });
  const providers = await reg.getProviders('user-1');
  assertEqual(providers.anthropic._byok, true);
});

await testAsync('each call returns fresh provider instances', async () => {
  const reg = freshRegistry();
  reg.register('user-1', { anthropic: VALID_KEYS.anthropic });
  const p1 = await reg.getProviders('user-1');
  const p2 = await reg.getProviders('user-1');
  // Should be different object references (fresh instances)
  assert(p1.anthropic !== p2.anthropic, 'Should be fresh instances');
});

await testAsync('provider has correct name property', async () => {
  const reg = freshRegistry();
  reg.register('user-1', { anthropic: VALID_KEYS.anthropic, groq: VALID_KEYS.groq });
  const providers = await reg.getProviders('user-1');
  assertEqual(providers.anthropic.name, 'anthropic');
  assertEqual(providers.groq.name, 'groq');
});

// ─── Key isolation (users don't share key stores) ─────────────────────────────

console.log('\nKey isolation:');

test('different users have independent key stores', () => {
  const reg = freshRegistry();
  reg.register('alice', { anthropic: VALID_KEYS.anthropic });
  reg.register('bob', { openai: VALID_KEYS.openai });
  assertEqual(reg.hasProvider('alice', 'anthropic'), true);
  assertEqual(reg.hasProvider('alice', 'openai'), false);
  assertEqual(reg.hasProvider('bob', 'anthropic'), false);
  assertEqual(reg.hasProvider('bob', 'openai'), true);
});

test('removing one user does not affect another', () => {
  const reg = freshRegistry();
  reg.register('alice', { anthropic: VALID_KEYS.anthropic });
  reg.register('bob', { openai: VALID_KEYS.openai });
  reg.remove('alice');
  assertEqual(reg.has('alice'), false);
  assertEqual(reg.has('bob'), true);
});

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\n─── Results: ${passed} passed, ${failed} failed ───\n`);
process.exit(failed > 0 ? 1 : 0);
