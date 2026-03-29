// ─── workers/fastWorker.test.mjs ──────────────────────────────────────────────
// Tests for RONIN Fast Worker (W2)
// Run: node fastWorker.test.mjs 2>&1
// ─────────────────────────────────────────────────────────────────────────────

import { createFastWorker, buildMessages, detectEscalation } from './fastWorker.mjs';
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

// ─── Mock Provider ──────────────────────────────────────────────────────

function mockProvider(response = 'Hello!', usage = {}) {
  const calls = [];
  return {
    calls,
    complete: async (messages, opts) => {
      calls.push({ messages, opts });
      return { content: response, usage };
    },
  };
}

function failingProvider(errorMessage = 'API error') {
  return {
    complete: async () => { throw new Error(errorMessage); },
  };
}

// ─── createFastWorker ───────────────────────────────────────────────────

console.log('\n── createFastWorker ──');

test('creates worker with type fast', () => {
  const w = createFastWorker(mockProvider());
  assertEqual(w.type, 'fast');
});

await test('executes simple query', async () => {
  const provider = mockProvider('The capital of France is Paris.');
  const w = createFastWorker(provider);
  const result = await w.execute({ message: 'What is the capital of France?' });

  assertEqual(result.result, 'The capital of France is Paris.');
  assertEqual(result.cost, 0);
  assertEqual(result.worker, 'fast');
  assertEqual(result.model_hidden, true);
});

await test('uses correct model', async () => {
  const provider = mockProvider('ok');
  const w = createFastWorker(provider);
  await w.execute({ message: 'test' });

  assertEqual(provider.calls[0].opts.model, 'gemini-2.5-flash-lite');
});

await test('respects custom model', async () => {
  const provider = mockProvider('ok');
  const w = createFastWorker(provider, { model: 'custom-flash' });
  await w.execute({ message: 'test' });

  assertEqual(provider.calls[0].opts.model, 'custom-flash');
});

await test('respects custom maxTokens', async () => {
  const provider = mockProvider('ok');
  const w = createFastWorker(provider, { maxTokens: 500 });
  await w.execute({ message: 'test' });

  assertEqual(provider.calls[0].opts.maxTokens, 500);
});

await test('tracks token usage from provider', async () => {
  const provider = mockProvider('response', { inputTokens: 100, outputTokens: 50 });
  const w = createFastWorker(provider);
  const result = await w.execute({ message: 'test' });

  assertEqual(result.inputTokens, 100);
  assertEqual(result.outputTokens, 50);
});

await test('estimates tokens when provider omits usage', async () => {
  const provider = mockProvider('response');
  const w = createFastWorker(provider);
  const result = await w.execute({ message: 'test' });

  assert(result.inputTokens > 0);
  assert(result.outputTokens > 0);
});

await test('cost is always 0 (free tier)', async () => {
  const provider = mockProvider('response');
  const w = createFastWorker(provider);
  const result = await w.execute({ message: 'test' });

  assertEqual(result.cost, 0);
  assertEqual(w.getMetrics().totalCost, 0);
});

await test('detects escalation need', async () => {
  const provider = mockProvider('This needs deeper analysis to answer properly.');
  const w = createFastWorker(provider);
  const result = await w.execute({ message: 'Explain quantum entanglement' });

  assertEqual(result.needsEscalation, true);
});

await test('no escalation for normal response', async () => {
  const provider = mockProvider('The answer is 42.');
  const w = createFastWorker(provider);
  const result = await w.execute({ message: 'What is 6 * 7?' });

  assertEqual(result.needsEscalation, false);
});

await test('accepts string task', async () => {
  const provider = mockProvider('ok');
  const w = createFastWorker(provider);
  await w.execute('simple string query');

  const msgs = provider.calls[0].messages;
  assert(msgs.some(m => m.content === 'simple string query'));
});

await test('accepts task with content field', async () => {
  const provider = mockProvider('ok');
  const w = createFastWorker(provider);
  await w.execute({ content: 'content field query' });

  const msgs = provider.calls[0].messages;
  assert(msgs.some(m => m.content === 'content field query'));
});

// ─── Fallback Provider ──────────────────────────────────────────────────

console.log('\n── Fallback ──');

await test('falls back to secondary provider on rate limit', async () => {
  const primary = failingProvider('429 rate limit exceeded');
  const fallback = mockProvider('fallback response');
  const w = createFastWorker(primary, { fallbackProvider: fallback });

  const result = await w.execute({ message: 'test' });
  assertEqual(result.result, 'fallback response');
  assertEqual(result.usedFallback, true);
  assertEqual(result.cost, 0); // Groq is also free
});

await test('falls back on "too many requests"', async () => {
  const primary = failingProvider('Too Many Requests');
  const fallback = mockProvider('fallback ok');
  const w = createFastWorker(primary, { fallbackProvider: fallback });

  const result = await w.execute({ message: 'test' });
  assertEqual(result.usedFallback, true);
});

await test('does NOT fallback on non-rate-limit error', async () => {
  const primary = failingProvider('Internal server error');
  const fallback = mockProvider('fallback');
  const w = createFastWorker(primary, { fallbackProvider: fallback });

  let threw = false;
  try { await w.execute({ message: 'test' }); }
  catch { threw = true; }
  assert(threw, 'Should have thrown non-rate-limit error');
});

await test('throws when no fallback and rate limited', async () => {
  const primary = failingProvider('rate limit exceeded');
  const w = createFastWorker(primary); // no fallback

  let threw = false;
  try { await w.execute({ message: 'test' }); }
  catch { threw = true; }
  assert(threw);
});

// ─── buildMessages ──────────────────────────────────────────────────────

console.log('\n── buildMessages ──');

test('includes system prompt', () => {
  const msgs = buildMessages({ message: 'hi' }, {}, 'Be concise.');
  assertEqual(msgs[0].role, 'system');
  assertEqual(msgs[0].content, 'Be concise.');
});

test('includes user message', () => {
  const msgs = buildMessages({ message: 'hello' }, {}, 'sys');
  const userMsg = msgs.find(m => m.role === 'user');
  assert(userMsg !== undefined);
  assertEqual(userMsg.content, 'hello');
});

test('includes taste block', () => {
  const msgs = buildMessages({ message: 'hi' }, { taste_block: 'Prefers teal.' }, 'sys');
  assert(msgs.some(m => m.content === 'Prefers teal.'));
});

test('includes recent history (max 6 messages = 3 turns)', () => {
  const history = [
    { role: 'user', content: 'old1' }, { role: 'assistant', content: 'old2' },
    { role: 'user', content: 'old3' }, { role: 'assistant', content: 'old4' },
    { role: 'user', content: 'recent1' }, { role: 'assistant', content: 'recent2' },
    { role: 'user', content: 'recent3' }, { role: 'assistant', content: 'recent4' },
  ];
  const msgs = buildMessages({ message: 'now' }, { history }, 'sys');
  // Should include last 6 of history + system + user = 8
  assert(!msgs.some(m => m.content === 'old1'));
  assert(!msgs.some(m => m.content === 'old2'));
  assert(msgs.some(m => m.content === 'recent1'));
});

test('handles empty history', () => {
  const msgs = buildMessages({ message: 'hi' }, { history: [] }, 'sys');
  assertEqual(msgs.length, 2); // system + user
});

// ─── detectEscalation ───────────────────────────────────────────────────

console.log('\n── detectEscalation ──');

test('detects "needs deeper analysis"', () => {
  assert(detectEscalation('This needs deeper analysis to provide a good answer.'));
});

test('detects "beyond my scope"', () => {
  assert(detectEscalation('This is beyond my scope as a quick assistant.'));
});

test('detects "requires more detailed"', () => {
  assert(detectEscalation('This requires more detailed investigation.'));
});

test('no escalation for normal text', () => {
  assert(!detectEscalation('The answer is 42.'));
});

test('no escalation for null/empty', () => {
  assert(!detectEscalation(null));
  assert(!detectEscalation(''));
});

// ─── Metrics ────────────────────────────────────────────────────────────

console.log('\n── Metrics ──');

await test('tracks call count', async () => {
  const w = createFastWorker(mockProvider('ok'));
  await w.execute({ message: 'a' });
  await w.execute({ message: 'b' });
  assertEqual(w.getMetrics().calls, 2);
});

await test('health stays healthy on success', async () => {
  const w = createFastWorker(mockProvider('ok'));
  await w.execute({ message: 'test' });
  assertEqual(w.getHealth().status, WORKER_STATES.HEALTHY);
});

await test('callable provider works', async () => {
  const provider = async (msgs, opts) => ({ content: 'callable ok', usage: {} });
  const w = createFastWorker({ complete: provider });
  const result = await w.execute({ message: 'test' });
  assertEqual(result.result, 'callable ok');
});

// ─── Summary ────────────────────────────────────────────────────────────

await new Promise(r => setTimeout(r, 100));
console.log(`\n${'─'.repeat(60)}`);
console.log(`FastWorker: ${passCount}/${testCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
