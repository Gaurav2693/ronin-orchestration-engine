// test/byokMiddleware.test.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Tests for RONIN BYOK Middleware
// ─────────────────────────────────────────────────────────────────────────────

import { createByokMiddleware } from '../middleware/byokMiddleware.mjs';
import { BYOKRegistry } from '../config/byokRegistry.mjs';

let passed = 0;
let failed = 0;

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

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeNext() {
  let called = false;
  return {
    fn: async () => { called = true; },
    get called() { return called; },
  };
}

const VALID_KEYS = {
  anthropic: 'sk-ant-api03-test1234567890abcdefghijklmno',
  openai:    'sk-proj-test1234567890abcdefghijklmnopqrstuv',
  groq:      'gsk_test1234567890abcdefghijklmno',
  gemini:    'AIzaSyTest1234567890abcdefghij',
};

function freshSetup() {
  const reg = new BYOKRegistry({ secret: 'test-secret-1234567890abcdef' });
  const { middleware, getProviderForRequest } = createByokMiddleware(reg, { silent: true });
  return { reg, middleware, getProviderForRequest };
}

console.log('\n─── byokMiddleware.test.mjs ─────────────────────────────\n');

// ─── No-op cases (pass-through) ──────────────────────────────────────────────

console.log('Pass-through (no BYOK):');

await testAsync('calls next() when no userId on request', async () => {
  const { middleware } = freshSetup();
  const request = {};
  const next = makeNext();
  await middleware(request, next.fn);
  assert(next.called);
  assertEqual(request._byok, null);
});

await testAsync('calls next() when userId has no registered keys', async () => {
  const { middleware } = freshSetup();
  const request = { userId: 'unknown-user' };
  const next = makeNext();
  await middleware(request, next.fn);
  assert(next.called);
  assertEqual(request._byok, null);
});

await testAsync('handles request.user.id format', async () => {
  const { middleware } = freshSetup();
  const request = { user: { id: 'no-keys-user' } };
  const next = makeNext();
  await middleware(request, next.fn);
  assertEqual(request._byok, null);
});

await testAsync('handles request.operatorId format', async () => {
  const { middleware } = freshSetup();
  const request = { operatorId: 'no-keys-operator' };
  const next = makeNext();
  await middleware(request, next.fn);
  assertEqual(request._byok, null);
});

// ─── BYOK injection ──────────────────────────────────────────────────────────

console.log('\nBYOK injection:');

await testAsync('attaches _byok to request when user has keys', async () => {
  const { reg, middleware } = freshSetup();
  reg.register('user-1', { anthropic: VALID_KEYS.anthropic });
  const request = { userId: 'user-1' };
  const next = makeNext();
  await middleware(request, next.fn);
  assert(next.called);
  assert(request._byok !== null);
  assertEqual(request._byok._isByok, true);
});

await testAsync('_byok contains provider instances', async () => {
  const { reg, middleware } = freshSetup();
  reg.register('user-1', { anthropic: VALID_KEYS.anthropic, groq: VALID_KEYS.groq });
  const request = { userId: 'user-1' };
  await middleware(request, async () => {});
  assert(request._byok.anthropic, 'should have anthropic provider');
  assert(request._byok.groq, 'should have groq provider');
  assert(!request._byok.openai, 'should not have openai provider');
});

await testAsync('_byok providers have _byok flag', async () => {
  const { reg, middleware } = freshSetup();
  reg.register('user-1', { anthropic: VALID_KEYS.anthropic });
  const request = { userId: 'user-1' };
  await middleware(request, async () => {});
  assertEqual(request._byok.anthropic._byok, true);
});

await testAsync('_isByok and _userId set correctly', async () => {
  const { reg, middleware } = freshSetup();
  reg.register('user-1', { openai: VALID_KEYS.openai });
  const request = { userId: 'user-1' };
  await middleware(request, async () => {});
  assertEqual(request._byok._isByok, true);
  assertEqual(request._byok._userId, 'user-1');
});

await testAsync('still calls next() when BYOK active', async () => {
  const { reg, middleware } = freshSetup();
  reg.register('user-1', { anthropic: VALID_KEYS.anthropic });
  const request = { userId: 'user-1' };
  const next = makeNext();
  await middleware(request, next.fn);
  assert(next.called);
});

// ─── User ID resolution priority ─────────────────────────────────────────────

console.log('\nUserId resolution:');

await testAsync('prefers request.userId over request.user.id', async () => {
  const { reg, middleware } = freshSetup();
  reg.register('primary-user', { anthropic: VALID_KEYS.anthropic });
  const request = {
    userId: 'primary-user',
    user: { id: 'nested-user' },
  };
  await middleware(request, async () => {});
  assert(request._byok !== null, 'Should use primary userId');
  assertEqual(request._byok._userId, 'primary-user');
});

await testAsync('falls back to request.user.id when no userId', async () => {
  const { reg, middleware } = freshSetup();
  reg.register('nested-user', { anthropic: VALID_KEYS.anthropic });
  const request = { user: { id: 'nested-user' } };
  await middleware(request, async () => {});
  assert(request._byok !== null);
});

// ─── Error resilience ─────────────────────────────────────────────────────────

console.log('\nError resilience:');

await testAsync('still calls next() if registry throws', async () => {
  const badReg = {
    has: () => true,
    getProviders: async () => { throw new Error('Registry exploded!'); },
  };
  const { middleware } = createByokMiddleware(badReg, { silent: true });
  const request = { userId: 'user-1' };
  const next = makeNext();
  await middleware(request, next.fn);  // should not throw
  assert(next.called);
  assertEqual(request._byok, null);   // falls back to null
});

// ─── getProviderForRequest ─────────────────────────────────────────────────────

console.log('\ngetProviderForRequest():');

await testAsync('returns BYOK provider when available', async () => {
  const { reg, middleware, getProviderForRequest } = freshSetup();
  reg.register('user-1', { groq: VALID_KEYS.groq });
  const request = { userId: 'user-1' };
  await middleware(request, async () => {});

  const provider = getProviderForRequest('groq', request);
  assert(provider._byok === true, 'Should return BYOK provider');
});

await testAsync('falls back to system provider when no BYOK', async () => {
  const { getProviderForRequest } = freshSetup();
  const request = { _byok: null };

  const provider = getProviderForRequest('anthropic', request);
  // System provider does not have _byok flag
  assert(provider._byok !== true, 'Should return system provider');
  assertEqual(provider.name, 'anthropic');
});

await testAsync('falls back when BYOK exists but not for this provider', async () => {
  const { reg, middleware, getProviderForRequest } = freshSetup();
  reg.register('user-1', { groq: VALID_KEYS.groq });
  const request = { userId: 'user-1' };
  await middleware(request, async () => {});

  // user has groq key but NOT anthropic
  const provider = getProviderForRequest('anthropic', request);
  assert(provider._byok !== true, 'Should fall back to system');
  assertEqual(provider.name, 'anthropic');
});

await testAsync('handles null request gracefully', async () => {
  const { getProviderForRequest } = freshSetup();
  const provider = getProviderForRequest('gemini', null);
  assertEqual(provider.name, 'gemini');
});

await testAsync('handles undefined _byok gracefully', async () => {
  const { getProviderForRequest } = freshSetup();
  const provider = getProviderForRequest('openai', { _byok: undefined });
  assertEqual(provider.name, 'openai');
});

// ─── Multiple users independence ──────────────────────────────────────────────

console.log('\nMulti-user isolation:');

await testAsync('two users get different provider instances', async () => {
  const { reg, middleware } = freshSetup();
  reg.register('alice', { anthropic: VALID_KEYS.anthropic });
  reg.register('bob', { anthropic: VALID_KEYS.anthropic });

  const reqAlice = { userId: 'alice' };
  const reqBob   = { userId: 'bob' };
  await middleware(reqAlice, async () => {});
  await middleware(reqBob, async () => {});

  assert(reqAlice._byok.anthropic !== reqBob._byok.anthropic, 'Should be different instances');
  assertEqual(reqAlice._byok._userId, 'alice');
  assertEqual(reqBob._byok._userId, 'bob');
});

await testAsync('removing user keys stops BYOK on next request', async () => {
  const { reg, middleware } = freshSetup();
  reg.register('user-1', { anthropic: VALID_KEYS.anthropic });

  const req1 = { userId: 'user-1' };
  await middleware(req1, async () => {});
  assert(req1._byok !== null, 'First request should have BYOK');

  reg.remove('user-1');

  const req2 = { userId: 'user-1' };
  await middleware(req2, async () => {});
  assertEqual(req2._byok, null, 'After removal, should have no BYOK');
});

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\n─── Results: ${passed} passed, ${failed} failed ───\n`);
process.exit(failed > 0 ? 1 : 0);
