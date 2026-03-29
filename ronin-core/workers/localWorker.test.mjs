// ─── workers/localWorker.test.mjs ─────────────────────────────────────────────
// Tests for RONIN Local Worker (W6)
// Run: node localWorker.test.mjs 2>&1
// ─────────────────────────────────────────────────────────────────────────────

import { createLocalWorker, buildLocalMessages, detectEscalation } from './localWorker.mjs';
import { WORKER_STATES } from './workerInterface.mjs';

let testCount = 0;
let passCount = 0;
let failCount = 0;

function test(name, fn) {
  testCount++;
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(() => { passCount++; console.log(`✓ ${name}`); })
        .catch(e => { failCount++; console.error(`✗ ${name}\n  ${e.message}`); });
    }
    passCount++;
    console.log(`✓ ${name}`);
  } catch (e) {
    failCount++;
    console.error(`✗ ${name}\n  ${e.message}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }
function assertEqual(a, b, m) { if (a !== b) throw new Error(m || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

// ─── Mock Ollama Client ─────────────────────────────────────────────────

function mockOllamaClient(response = 'Local response.', available = true) {
  const calls = [];
  return {
    calls,
    isAvailable: async () => available,
    complete: async (messages, opts) => {
      calls.push({ messages, opts });
      return { content: response, usage: { inputTokens: 50, outputTokens: 30 } };
    },
  };
}

function unavailableClient() {
  return {
    isAvailable: async () => false,
    complete: async () => { throw new Error('Ollama not running'); },
  };
}

// ─── createLocalWorker ──────────────────────────────────────────────────

console.log('\n── createLocalWorker ──');

test('creates worker with type local', () => {
  const w = createLocalWorker(mockOllamaClient());
  assertEqual(w.type, 'local');
});

await test('executes locally when available', async () => {
  const client = mockOllamaClient('const x = 42;');
  const w = createLocalWorker(client);
  const result = await w.execute({ message: 'Create a constant' });

  assertEqual(result.result, 'const x = 42;');
  assertEqual(result.cost, 0);
  assertEqual(result.local, true);
  assertEqual(result.worker, 'local');
  assertEqual(result.model_hidden, true);
});

await test('returns fallback when unavailable', async () => {
  const w = createLocalWorker(unavailableClient());
  const result = await w.execute({ message: 'test' });

  assertEqual(result.unavailable, true);
  assertEqual(result.fallback, 'fast');
  assertEqual(result.cost, 0);
});

await test('uses correct model', async () => {
  const client = mockOllamaClient();
  const w = createLocalWorker(client);
  await w.execute({ message: 'test' });

  assertEqual(client.calls[0].opts.model, 'qwen2.5-coder:7b');
});

await test('respects custom model', async () => {
  const client = mockOllamaClient();
  const w = createLocalWorker(client, { model: 'codellama:13b' });
  await w.execute({ message: 'test' });

  assertEqual(client.calls[0].opts.model, 'codellama:13b');
});

await test('cost is always 0', async () => {
  const w = createLocalWorker(mockOllamaClient());
  await w.execute({ message: 'a' });
  await w.execute({ message: 'b' });
  assertEqual(w.getMetrics().totalCost, 0);
});

await test('detects escalation need', async () => {
  const client = mockOllamaClient('This task needs a larger model to handle properly.');
  const w = createLocalWorker(client);
  const result = await w.execute({ message: 'Explain distributed consensus' });

  assertEqual(result.needsEscalation, true);
});

await test('no escalation for normal response', async () => {
  const client = mockOllamaClient('Here is the config file update.');
  const w = createLocalWorker(client);
  const result = await w.execute({ message: 'Update the config' });

  assertEqual(result.needsEscalation, false);
});

// ─── Availability Caching ───────────────────────────────────────────────

console.log('\n── Availability Caching ──');

await test('caches availability check', async () => {
  let checkCount = 0;
  const client = {
    isAvailable: async () => { checkCount++; return true; },
    complete: async () => ({ content: 'ok', usage: {} }),
  };

  const w = createLocalWorker(client, { healthCheckIntervalMs: 10_000 });
  await w.execute({ message: 'a' });
  await w.execute({ message: 'b' });
  await w.execute({ message: 'c' });

  assertEqual(checkCount, 1); // only checked once due to cache
});

await test('clearAvailabilityCache forces re-check', async () => {
  let checkCount = 0;
  const client = {
    isAvailable: async () => { checkCount++; return true; },
    complete: async () => ({ content: 'ok', usage: {} }),
  };

  const w = createLocalWorker(client, { healthCheckIntervalMs: 60_000 });
  await w.execute({ message: 'a' });
  w.clearAvailabilityCache();
  await w.execute({ message: 'b' });

  assertEqual(checkCount, 2);
});

await test('handles health check throwing', async () => {
  const client = {
    isAvailable: async () => { throw new Error('network error'); },
    complete: async () => ({ content: 'ok', usage: {} }),
  };

  const w = createLocalWorker(client);
  const result = await w.execute({ message: 'test' });
  assertEqual(result.unavailable, true);
  assertEqual(result.fallback, 'fast');
});

// ─── getFallbackWorker / getModel ───────────────────────────────────────

console.log('\n── Worker Methods ──');

test('getFallbackWorker returns fast', () => {
  const w = createLocalWorker(mockOllamaClient());
  assertEqual(w.getFallbackWorker(), 'fast');
});

test('getModel returns configured model', () => {
  const w = createLocalWorker(mockOllamaClient(), { model: 'deepseek-coder:6.7b' });
  assertEqual(w.getModel(), 'deepseek-coder:6.7b');
});

test('getModel returns default', () => {
  const w = createLocalWorker(mockOllamaClient());
  assertEqual(w.getModel(), 'qwen2.5-coder:7b');
});

// ─── buildLocalMessages ─────────────────────────────────────────────────

console.log('\n── buildLocalMessages ──');

test('includes system prompt', () => {
  const msgs = buildLocalMessages({ message: 'hi' }, {}, 'Be fast.');
  assertEqual(msgs[0].role, 'system');
  assertEqual(msgs[0].content, 'Be fast.');
});

test('includes only last 4 history messages (2 turns)', () => {
  const history = Array.from({ length: 8 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `msg-${i}`,
  }));
  const msgs = buildLocalMessages({ message: 'now' }, { history }, 'sys');
  assert(!msgs.some(m => m.content === 'msg-0'));
  assert(msgs.some(m => m.content === 'msg-4'));
});

test('handles string task', () => {
  const msgs = buildLocalMessages('quick edit', {}, 'sys');
  assert(msgs.some(m => m.role === 'user' && m.content === 'quick edit'));
});

// ─── detectEscalation ───────────────────────────────────────────────────

console.log('\n── detectEscalation ──');

test('detects "needs a larger model"', () => {
  assert(detectEscalation('This needs a larger model.'));
});

test('detects "too complex"', () => {
  assert(detectEscalation('This is too complex for me.'));
});

test('no escalation for normal text', () => {
  assert(!detectEscalation('Here is the updated config.'));
});

test('no escalation for null', () => {
  assert(!detectEscalation(null));
});

// ─── Alternative Client Interfaces ──────────────────────────────────────

console.log('\n── Alternative Client Interfaces ──');

await test('works with chat() method', async () => {
  const client = {
    isAvailable: async () => true,
    chat: async (messages, opts) => ({ content: 'via chat', usage: {} }),
  };
  const w = createLocalWorker(client);
  const result = await w.execute({ message: 'test' });
  assertEqual(result.result, 'via chat');
});

await test('works with callable client', async () => {
  const client = {
    isAvailable: async () => true,
    complete: async (messages, opts) => ({ content: 'via callable', usage: {} }),
  };
  const w = createLocalWorker(client);
  const result = await w.execute({ message: 'test' });
  assertEqual(result.result, 'via callable');
});

// ─── Metrics ────────────────────────────────────────────────────────────

console.log('\n── Metrics ──');

await test('tracks calls', async () => {
  const w = createLocalWorker(mockOllamaClient());
  await w.execute({ message: 'a' });
  await w.execute({ message: 'b' });
  assertEqual(w.getMetrics().calls, 2);
});

await test('health stays healthy', async () => {
  const w = createLocalWorker(mockOllamaClient());
  await w.execute({ message: 'test' });
  assertEqual(w.getHealth().status, WORKER_STATES.HEALTHY);
});

// ─── Summary ────────────────────────────────────────────────────────────

await new Promise(r => setTimeout(r, 100));
console.log(`\n${'─'.repeat(60)}`);
console.log(`LocalWorker: ${passCount}/${testCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
