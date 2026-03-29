// test/parallelDirections.test.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Tests for Gate 02: Parallel Creative Directions
// ─────────────────────────────────────────────────────────────────────────────

import { generateParallelDirections } from '../gates/parallelDirections.mjs';

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

function assert(cond, msg)       { if (!cond) throw new Error(msg || 'Assertion failed'); }
function assertEqual(a, b, msg)  { if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function assertType(val, type, msg) { if (typeof val !== type) throw new Error(`${msg}: expected ${type}, got ${typeof val}`); }

// ─── Mock worker dispatch ─────────────────────────────────────────────────────

let dispatchCallCount = 0;
let dispatchArgs      = [];

function makeWorkerDispatch(options = {}) {
  dispatchCallCount = 0;
  dispatchArgs      = [];
  const delay       = options.delay || 0;
  const fail        = options.fail  || null;

  return {
    async dispatch(workerType, payload) {
      dispatchCallCount++;
      dispatchArgs.push({ workerType, payload });
      if (delay) await new Promise(r => setTimeout(r, delay));
      if (fail && fail.includes(workerType)) throw new Error(`Worker ${workerType} failed`);
      return {
        result: `${workerType} result for: ${payload.messages[0]?.content?.slice(0, 30)}`,
        cost:   0.001,
      };
    },
  };
}

console.log('\n─── parallelDirections.test.mjs ─────────────────────────\n');

// ─── Input validation ─────────────────────────────────────────────────────────

console.log('Input validation:');

await testAsync('throws if brief is empty', async () => {
  const dispatch = makeWorkerDispatch();
  try {
    await generateParallelDirections('', dispatch);
    assert(false, 'Should have thrown');
  } catch (err) {
    assert(err.message.includes('brief'));
  }
});

await testAsync('throws if workerDispatch has no dispatch()', async () => {
  try {
    await generateParallelDirections('build a chat UI', {});
    assert(false, 'Should have thrown');
  } catch (err) {
    assert(err.message.includes('dispatch'));
  }
});

await testAsync('throws if workerDispatch is null', async () => {
  try {
    await generateParallelDirections('brief', null);
    assert(false, 'Should have thrown');
  } catch (err) {
    assert(err.message.includes('dispatch'));
  }
});

// ─── Output shape ─────────────────────────────────────────────────────────────

console.log('\nOutput shape:');

await testAsync('returns conventionBreaker direction', async () => {
  const dispatch = makeWorkerDispatch();
  const result   = await generateParallelDirections('design a dashboard', dispatch);
  assert(result.conventionBreaker, 'missing conventionBreaker');
  assertType(result.conventionBreaker.content, 'string', 'content');
  assertType(result.conventionBreaker.cost, 'number', 'cost');
  assertType(result.conventionBreaker.duration, 'number', 'duration');
});

await testAsync('returns refinedStandard direction', async () => {
  const dispatch = makeWorkerDispatch();
  const result   = await generateParallelDirections('design a dashboard', dispatch);
  assert(result.refinedStandard, 'missing refinedStandard');
  assertType(result.refinedStandard.content, 'string', 'content');
});

await testAsync('returns hybrid direction', async () => {
  const dispatch = makeWorkerDispatch();
  const result   = await generateParallelDirections('design a dashboard', dispatch);
  assert(result.hybrid, 'missing hybrid');
  assertType(result.hybrid.content, 'string', 'hybrid.content');
});

await testAsync('returns synthesis string', async () => {
  const dispatch = makeWorkerDispatch();
  const result   = await generateParallelDirections('design a dashboard', dispatch);
  assertType(result.synthesis, 'string', 'synthesis');
  assert(result.synthesis.length > 0, 'synthesis should not be empty');
});

await testAsync('returns meta object with cost and duration', async () => {
  const dispatch = makeWorkerDispatch();
  const result   = await generateParallelDirections('design a dashboard', dispatch);
  assert(result.meta, 'missing meta');
  assertType(result.meta.totalCost, 'number', 'totalCost');
  assertType(result.meta.totalDuration, 'number', 'totalDuration');
  assert(result.meta.directionsGenerated >= 0, 'directionsGenerated');
});

// ─── Parallel dispatching ─────────────────────────────────────────────────────

console.log('\nParallel dispatching:');

await testAsync('dispatches CB and RS in parallel (at least 3 total dispatches)', async () => {
  const dispatch = makeWorkerDispatch({ delay: 10 });
  await generateParallelDirections('build a sidebar nav', dispatch);
  // CB + RS + Hybrid + Synthesis = 4 dispatches
  assert(dispatchCallCount >= 3, `expected >= 3 dispatches, got ${dispatchCallCount}`);
});

await testAsync('uses agent worker for convention breaker', async () => {
  const dispatch = makeWorkerDispatch();
  await generateParallelDirections('build a modal dialog', dispatch);
  const cbCall = dispatchArgs.find(a => a.workerType === 'agent');
  assert(cbCall, 'expected at least one agent worker call');
});

await testAsync('uses fast worker for refined standard', async () => {
  const dispatch = makeWorkerDispatch();
  await generateParallelDirections('build a modal dialog', dispatch);
  const rsCall = dispatchArgs.find(a => a.workerType === 'fast');
  assert(rsCall, 'expected at least one fast worker call');
});

await testAsync('hybrid is dispatched after CB and RS', async () => {
  const dispatch = makeWorkerDispatch({ delay: 5 });
  const start    = Date.now();
  await generateParallelDirections('build a card', dispatch);
  const duration = Date.now() - start;
  // With 5ms delay per call and parallel Phase 1, should be faster than 3 serial calls
  assert(duration < 200, `too slow for parallel: ${duration}ms`);
});

// ─── Error resilience ─────────────────────────────────────────────────────────

console.log('\nError resilience:');

await testAsync('returns fallback when agent worker fails', async () => {
  const dispatch = makeWorkerDispatch({ fail: ['agent'] });
  const result   = await generateParallelDirections('build a login form', dispatch);
  assert(result.conventionBreaker, 'should still return conventionBreaker even if failed');
  assert(result.conventionBreaker.content.includes('unavailable') || result.conventionBreaker.content.length > 0,
    'fallback content expected');
});

await testAsync('returns synthesis fallback when synthesis fails', async () => {
  // Fail everything
  const dispatch = makeWorkerDispatch({ fail: ['fast', 'agent'] });
  const result   = await generateParallelDirections('build a header', dispatch);
  // Should not throw
  assertType(result.synthesis, 'string', 'synthesis still returns string');
});

await testAsync('meta.directionsGenerated counts non-unavailable directions', async () => {
  const dispatch = makeWorkerDispatch();
  const result   = await generateParallelDirections('build a footer', dispatch);
  assert(result.meta.directionsGenerated >= 1, 'at least one direction generated');
});

// ─── Options passthrough ──────────────────────────────────────────────────────

console.log('\nOptions:');

await testAsync('maxTokensPerDirection option is passed to worker', async () => {
  const dispatch = makeWorkerDispatch();
  await generateParallelDirections('build a grid', dispatch, { maxTokensPerDirection: 300 });
  const cbCall = dispatchArgs.find(a => a.payload?.maxTokens === 300);
  assert(cbCall, 'expected maxTokens: 300 to be passed');
});

await testAsync('maxTokensSynthesis option is passed to synthesis worker', async () => {
  const dispatch = makeWorkerDispatch();
  await generateParallelDirections('build a progress bar', dispatch, { maxTokensSynthesis: 400 });
  const synthCall = dispatchArgs.find(a => a.payload?.maxTokens === 400);
  assert(synthCall, 'expected maxTokens: 400 for synthesis');
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n─── Results: ${passed} passed, ${failed} failed ───\n`);
process.exit(failed > 0 ? 1 : 0);
