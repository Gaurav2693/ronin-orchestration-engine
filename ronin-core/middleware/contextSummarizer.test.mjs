// ─── middleware/contextSummarizer.test.mjs ───────────────────────────────────
// Test suite for M6 RONIN Context Summarizer
// Target: 30+ tests, 0 failures
// Run: node contextSummarizer.test.mjs 2>&1
// ─────────────────────────────────────────────────────────────────────────────

import {
  createContextSummarizer,
  shouldSummarize,
  splitHistory,
  summarize,
  estimateTokens,
  estimateHistoryTokens,
  buildSummaryPrompt,
  DEFAULT_TOKEN_LIMIT,
  DEFAULT_PRESERVE_RECENT,
  TOKEN_CHAR_RATIO,
} from './contextSummarizer.mjs';

// ─── Test utilities ──────────────────────────────────────────────────────

let testCount = 0;
let passCount = 0;
let failCount = 0;

function test(name, fn) {
  testCount++;
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(() => {
        passCount++;
        console.log(`✓ ${name}`);
      }).catch(error => {
        failCount++;
        console.error(`✗ ${name}`);
        console.error(`  ${error.message}`);
      });
    }
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

// ─── Helpers ────────────────────────────────────────────────────────────

function makeMessages(count, charsEach = 100) {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `Message ${i}: ${'x'.repeat(charsEach)}`,
  }));
}

// ─── Tests: estimateTokens ──────────────────────────────────────────────

console.log('\n── estimateTokens ──');

test('empty → 0', () => assertEqual(estimateTokens(''), 0));
test('null → 0', () => assertEqual(estimateTokens(null), 0));
test('4 chars → 1', () => assertEqual(estimateTokens('abcd'), 1));
test('400 chars → 100', () => assertEqual(estimateTokens('a'.repeat(400)), 100));

// ─── Tests: estimateHistoryTokens ───────────────────────────────────────

console.log('\n── estimateHistoryTokens ──');

test('empty array → 0', () => assertEqual(estimateHistoryTokens([]), 0));
test('null → 0', () => assertEqual(estimateHistoryTokens(null), 0));

test('counts content + role overhead', () => {
  const msgs = [{ role: 'user', content: 'a'.repeat(400) }];
  const tokens = estimateHistoryTokens(msgs);
  assertEqual(tokens, 102); // 100 content + 2 role
});

test('sums multiple messages', () => {
  const msgs = makeMessages(5, 40);
  const tokens = estimateHistoryTokens(msgs);
  assert(tokens > 50); // each ~12 tokens content + overhead
});

// ─── Tests: shouldSummarize ─────────────────────────────────────────────

console.log('\n── shouldSummarize ──');

test('under limit → false', () => {
  assertEqual(shouldSummarize(makeMessages(3, 10), 1000), false);
});

test('over limit → true', () => {
  assertEqual(shouldSummarize(makeMessages(100, 500), 100), true);
});

test('null → false', () => {
  assertEqual(shouldSummarize(null), false);
});

test('exactly at limit → false', () => {
  const msgs = makeMessages(1, 40);
  const tokens = estimateHistoryTokens(msgs);
  assertEqual(shouldSummarize(msgs, tokens), false); // exact = not over
});

// ─── Tests: splitHistory ────────────────────────────────────────────────

console.log('\n── splitHistory ──');

test('fewer than preserveRecent → all recent', () => {
  const msgs = makeMessages(5);
  const { old, recent } = splitHistory(msgs, 10);
  assertEqual(old.length, 0);
  assertEqual(recent.length, 5);
});

test('exactly preserveRecent → all recent', () => {
  const msgs = makeMessages(10);
  const { old, recent } = splitHistory(msgs, 10);
  assertEqual(old.length, 0);
  assertEqual(recent.length, 10);
});

test('more than preserveRecent → splits correctly', () => {
  const msgs = makeMessages(20);
  const { old, recent } = splitHistory(msgs, 5);
  assertEqual(old.length, 15);
  assertEqual(recent.length, 5);
  // Recent should be the last 5
  assertEqual(recent[0].content, msgs[15].content);
});

test('preserveRecent=3 with 7 messages', () => {
  const msgs = makeMessages(7);
  const { old, recent } = splitHistory(msgs, 3);
  assertEqual(old.length, 4);
  assertEqual(recent.length, 3);
});

// ─── Tests: buildSummaryPrompt ──────────────────────────────────────────

console.log('\n── buildSummaryPrompt ──');

test('includes message content', () => {
  const msgs = [{ role: 'user', content: 'Hello world' }];
  const prompt = buildSummaryPrompt(msgs);
  assert(prompt.includes('Hello world'));
  assert(prompt.includes('[user]'));
});

test('includes target token count', () => {
  const prompt = buildSummaryPrompt([{ role: 'user', content: 'test' }], 300);
  assert(prompt.includes('300'));
});

// ─── Tests: summarize ───────────────────────────────────────────────────

console.log('\n── summarize ──');

await test('empty messages → empty string', async () => {
  const result = await summarize([], null);
  assertEqual(result, '');
});

await test('no provider → fallback summary', async () => {
  const msgs = [{ role: 'user', content: 'Test message' }];
  const result = await summarize(msgs, null);
  assert(result.includes('Context summary'));
  assert(result.includes('1 messages'));
});

await test('provider returns summary', async () => {
  const mockProvider = async () => 'User discussed button design and chose blue.';
  const msgs = [{ role: 'user', content: 'Make the button blue' }];
  const result = await summarize(msgs, mockProvider);
  assertEqual(result, 'User discussed button design and chose blue.');
});

await test('provider error → fallback', async () => {
  const mockProvider = async () => { throw new Error('timeout'); };
  const msgs = [{ role: 'user', content: 'Test' }];
  const result = await summarize(msgs, mockProvider);
  assert(result.includes('unavailable'));
  assert(result.includes('timeout'));
});

// ─── Tests: createContextSummarizer (middleware) ─────────────────────────

console.log('\n── createContextSummarizer (middleware) ──');

await test('creates middleware function', async () => {
  const mw = createContextSummarizer();
  assertEqual(typeof mw, 'function');
});

await test('passthrough when under limit', async () => {
  const mw = createContextSummarizer(null, { tokenLimit: 10000 });
  const request = { messages: makeMessages(3, 10) };
  const result = await mw(request, (req) => req);
  assertEqual(result._context_summarized, undefined);
  assertEqual(mw.getMetrics().passthroughs, 1);
});

await test('summarizes when over limit', async () => {
  const mockProvider = async () => 'Compressed context here.';
  const mw = createContextSummarizer(mockProvider, { tokenLimit: 50, preserveRecent: 2 });
  const request = { messages: makeMessages(10, 100) };
  const result = await mw(request, (req) => req);
  assertEqual(result._context_summarized, true);
  assert(result._messages_compressed > 0);
  assert(result._tokens_saved > 0);
  // Recent messages preserved
  assertEqual(result.messages[result.messages.length - 1].content, request.messages[9].content);
  // First message is the summary
  assertEqual(result.messages[0]._summarized, true);
});

await test('tracks metrics across calls', async () => {
  const mockProvider = async () => 'Summary.';
  const mw = createContextSummarizer(mockProvider, { tokenLimit: 50, preserveRecent: 2 });
  const next = (req) => req;

  await mw({ messages: makeMessages(2, 10) }, next); // under limit
  await mw({ messages: makeMessages(10, 100) }, next); // over limit

  const m = mw.getMetrics();
  assertEqual(m.passthroughs, 1);
  assertEqual(m.summarizations, 1);
  assert(m.messagesSummarized > 0);
});

await test('preserves request fields', async () => {
  const mw = createContextSummarizer(null, { tokenLimit: 50, preserveRecent: 1 });
  const request = { messages: makeMessages(5, 100), custom: 'keep' };
  const result = await mw(request, (req) => req);
  assertEqual(result.custom, 'keep');
});

await test('returns enriched request when no next', async () => {
  const mw = createContextSummarizer(null, { tokenLimit: 10000 });
  const result = await mw({ messages: makeMessages(2, 10) });
  assert(result.messages !== undefined);
});

await test('uses history field as alternative to messages', async () => {
  const mw = createContextSummarizer(null, { tokenLimit: 50, preserveRecent: 1 });
  const request = { history: makeMessages(5, 100) };
  const result = await mw(request, (req) => req);
  assertEqual(result._context_summarized, true);
});

// ─── Summary ─────────────────────────────────────────────────────────────

await new Promise(r => setTimeout(r, 50));

console.log(`\n${'─'.repeat(60)}`);
console.log(`M6 contextSummarizer: ${passCount}/${testCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
