// ─── middleware/loopDetection.test.mjs ───────────────────────────────────────
// Test suite for M5 RONIN Loop Detection
// Target: 35+ tests, 0 failures
// Run: node loopDetection.test.mjs 2>&1
// ─────────────────────────────────────────────────────────────────────────────

import {
  createLoopDetector,
  detectLoop,
  fingerprint,
  DEFAULT_DUPLICATE_THRESHOLD,
  DEFAULT_CONSECUTIVE_LIMIT,
  DEFAULT_CYCLE_THRESHOLD,
} from './loopDetection.mjs';

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

// ─── Tests: Constants ───────────────────────────────────────────────────

console.log('\n── Constants ──');

test('DEFAULT_DUPLICATE_THRESHOLD is 3', () => {
  assertEqual(DEFAULT_DUPLICATE_THRESHOLD, 3);
});

test('DEFAULT_CONSECUTIVE_LIMIT is 10', () => {
  assertEqual(DEFAULT_CONSECUTIVE_LIMIT, 10);
});

test('DEFAULT_CYCLE_THRESHOLD is 3', () => {
  assertEqual(DEFAULT_CYCLE_THRESHOLD, 3);
});

// ─── Tests: fingerprint ─────────────────────────────────────────────────

console.log('\n── fingerprint ──');

test('creates fingerprint from tool + args', () => {
  const fp = fingerprint('readFile', { path: '/test.js' });
  assert(fp.includes('readFile'));
  assert(fp.includes('/test.js'));
});

test('same tool + args = same fingerprint', () => {
  const a = fingerprint('search', { query: 'foo' });
  const b = fingerprint('search', { query: 'foo' });
  assertEqual(a, b);
});

test('different args = different fingerprint', () => {
  const a = fingerprint('search', { query: 'foo' });
  const b = fingerprint('search', { query: 'bar' });
  assert(a !== b);
});

test('null args handled', () => {
  const fp = fingerprint('ping', null);
  assert(fp.startsWith('ping::'));
});

// ─── Tests: detectLoop — Duplicates ─────────────────────────────────────

console.log('\n── detectLoop: Duplicates ──');

test('no loop for empty history', () => {
  const r = detectLoop([]);
  assertEqual(r.isLoop, false);
});

test('no loop for 2 identical calls (below threshold)', () => {
  const history = [
    { tool: 'readFile', args: { path: 'a.js' } },
    { tool: 'readFile', args: { path: 'a.js' } },
  ];
  assertEqual(detectLoop(history).isLoop, false);
});

test('3 identical calls → duplicate loop', () => {
  const history = [
    { tool: 'readFile', args: { path: 'a.js' } },
    { tool: 'readFile', args: { path: 'a.js' } },
    { tool: 'readFile', args: { path: 'a.js' } },
  ];
  const r = detectLoop(history);
  assertEqual(r.isLoop, true);
  assertEqual(r.pattern, 'duplicate');
  assertEqual(r.count, 3);
  assert(r.suggestion.includes('readFile'));
});

test('different args = no duplicate', () => {
  const history = [
    { tool: 'readFile', args: { path: 'a.js' } },
    { tool: 'readFile', args: { path: 'b.js' } },
    { tool: 'readFile', args: { path: 'c.js' } },
  ];
  assertEqual(detectLoop(history).isLoop, false);
});

test('custom threshold = 2', () => {
  const history = [
    { tool: 'search', args: { q: 'test' } },
    { tool: 'search', args: { q: 'test' } },
  ];
  const r = detectLoop(history, { duplicateThreshold: 2 });
  assertEqual(r.isLoop, true);
});

// ─── Tests: detectLoop — Consecutive ────────────────────────────────────

console.log('\n── detectLoop: Consecutive ──');

test('9 consecutive calls = no loop', () => {
  const history = Array.from({ length: 9 }, (_, i) => ({
    tool: `tool_${i}`, args: { i },
  }));
  assertEqual(detectLoop(history).isLoop, false);
});

test('10 consecutive calls → consecutive loop', () => {
  const history = Array.from({ length: 10 }, (_, i) => ({
    tool: `tool_${i}`, args: { i },
  }));
  const r = detectLoop(history);
  assertEqual(r.isLoop, true);
  assertEqual(r.pattern, 'consecutive');
  assertEqual(r.count, 10);
});

test('custom consecutive limit = 5', () => {
  const history = Array.from({ length: 5 }, (_, i) => ({
    tool: `tool_${i}`, args: { i },
  }));
  const r = detectLoop(history, { consecutiveLimit: 5 });
  assertEqual(r.isLoop, true);
  assertEqual(r.pattern, 'consecutive');
});

// ─── Tests: detectLoop — Cycle ──────────────────────────────────────────

console.log('\n── detectLoop: Cycle ──');

test('A→B→A→B→A→B → cycle detected (with unique args)', () => {
  // Each call has unique args so duplicate detection doesn't fire
  const history = [
    { tool: 'read', args: { n: 1 } },
    { tool: 'write', args: { n: 2 } },
    { tool: 'read', args: { n: 3 } },
    { tool: 'write', args: { n: 4 } },
    { tool: 'read', args: { n: 5 } },
    { tool: 'write', args: { n: 6 } },
  ];
  const r = detectLoop(history);
  assertEqual(r.isLoop, true);
  assertEqual(r.pattern, 'cycle');
  assert(r.suggestion.includes('read'));
  assert(r.suggestion.includes('write'));
});

test('A→B→C→A→B→C→A→B→C → 3-step cycle (with unique args)', () => {
  const tools = ['a', 'b', 'c'];
  const history = [];
  for (let i = 0; i < 9; i++) {
    history.push({ tool: tools[i % 3], args: { i } });
  }
  const r = detectLoop(history);
  assertEqual(r.isLoop, true);
  assertEqual(r.pattern, 'cycle');
});

test('A→B→A→C → no cycle', () => {
  const history = [
    { tool: 'a', args: null },
    { tool: 'b', args: null },
    { tool: 'a', args: null },
    { tool: 'c', args: null },
  ];
  assertEqual(detectLoop(history).isLoop, false);
});

test('mixed tools without pattern = no loop', () => {
  const history = [
    { tool: 'a', args: null },
    { tool: 'b', args: null },
    { tool: 'c', args: null },
    { tool: 'd', args: null },
    { tool: 'e', args: null },
  ];
  assertEqual(detectLoop(history).isLoop, false);
});

// ─── Tests: createLoopDetector (middleware) ──────────────────────────────

console.log('\n── createLoopDetector (middleware) ──');

await test('creates middleware function', async () => {
  const mw = createLoopDetector();
  assertEqual(typeof mw, 'function');
});

await test('passes through when no tool calls', async () => {
  const mw = createLoopDetector();
  const request = { message: 'hello', session_id: 'ses1' };
  const result = await mw(request, (req) => ({ ...req, passed: true }));
  assertEqual(result.passed, true);
});

await test('detects duplicate tool calls', async () => {
  const mw = createLoopDetector();
  const call = { tool: 'readFile', args: { path: 'x.js' } };
  const next = (req) => req;

  await mw({ session_id: 's1', tool_calls: [call] }, next);
  await mw({ session_id: 's1', tool_calls: [call] }, next);
  const result = await mw({ session_id: 's1', tool_calls: [call] }, next);

  assertEqual(result._loop_detected, true);
  assertEqual(result._loop_pattern, 'duplicate');
});

await test('resets on user message', async () => {
  const mw = createLoopDetector();
  const call = { tool: 'readFile', args: { path: 'x.js' } };
  const next = (req) => req;

  await mw({ session_id: 's2', tool_calls: [call] }, next);
  await mw({ session_id: 's2', tool_calls: [call] }, next);
  // User speaks — resets
  await mw({ session_id: 's2', type: 'user', message: 'ok' }, next);
  // Same tool call again — should NOT loop (reset)
  const result = await mw({ session_id: 's2', tool_calls: [call] }, next);
  assertEqual(result._loop_detected, undefined);
});

await test('separate sessions are independent', async () => {
  const mw = createLoopDetector();
  const call = { tool: 'test', args: {} };
  const next = (req) => req;

  await mw({ session_id: 'a', tool_calls: [call] }, next);
  await mw({ session_id: 'a', tool_calls: [call] }, next);
  await mw({ session_id: 'b', tool_calls: [call] }, next);

  // Session 'a' has 2 calls, 'b' has 1 — neither is a loop
  const resultA = await mw({ session_id: 'a', tool_calls: [call] }, next);
  assertEqual(resultA._loop_detected, true); // 3rd call for session a

  const resultB = await mw({ session_id: 'b', tool_calls: [call] }, next);
  assertEqual(resultB._loop_detected, undefined); // only 2nd for session b
});

await test('tracks metrics', async () => {
  const mw = createLoopDetector();
  const call = { tool: 'x', args: {} };
  const next = (req) => req;

  await mw({ session_id: 'm', tool_calls: [call] }, next);
  await mw({ session_id: 'm', tool_calls: [call] }, next);
  await mw({ session_id: 'm', tool_calls: [call] }, next);

  const m = mw.getMetrics();
  assertEqual(m.loopsDetected, 1);
  assertEqual(m.duplicateLoops, 1);
  assert(m.totalChecks >= 3);
});

await test('resetSession clears tracking', async () => {
  const mw = createLoopDetector();
  const call = { tool: 'x', args: {} };
  const next = (req) => req;

  await mw({ session_id: 'r', tool_calls: [call] }, next);
  await mw({ session_id: 'r', tool_calls: [call] }, next);
  mw.resetSession('r');
  const result = await mw({ session_id: 'r', tool_calls: [call] }, next);
  assertEqual(result._loop_detected, undefined); // reset means fresh start
});

await test('handles role=user as reset trigger', async () => {
  const mw = createLoopDetector();
  const call = { tool: 'y', args: {} };
  const next = (req) => req;

  await mw({ session_id: 'u', tool_calls: [call] }, next);
  await mw({ session_id: 'u', tool_calls: [call] }, next);
  await mw({ session_id: 'u', role: 'user', message: 'hi' }, next);
  const result = await mw({ session_id: 'u', tool_calls: [call] }, next);
  assertEqual(result._loop_detected, undefined);
});

await test('returns request when no next function', async () => {
  const mw = createLoopDetector();
  const result = await mw({ message: 'test' });
  assertEqual(result.message, 'test');
});

await test('consecutive loop detection in middleware', async () => {
  const mw = createLoopDetector({ consecutiveLimit: 5 });
  const next = (req) => req;

  for (let i = 0; i < 4; i++) {
    await mw({ session_id: 'c', tool_calls: [{ tool: `t${i}`, args: { i } }] }, next);
  }
  const result = await mw({ session_id: 'c', tool_calls: [{ tool: 't4', args: { i: 4 } }] }, next);
  assertEqual(result._loop_detected, true);
  assertEqual(result._loop_pattern, 'consecutive');
});

// ─── Summary ─────────────────────────────────────────────────────────────

await new Promise(r => setTimeout(r, 50));

console.log(`\n${'─'.repeat(60)}`);
console.log(`M5 loopDetection: ${passCount}/${testCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
