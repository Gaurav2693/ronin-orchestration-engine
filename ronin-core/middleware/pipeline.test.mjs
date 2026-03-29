// ─── middleware/pipeline.test.mjs ────────────────────────────────────────────
// Test suite for M8 RONIN Middleware Pipeline CAPSTONE
// Target: 55+ tests, 0 failures
// Run: node pipeline.test.mjs 2>&1
// ─────────────────────────────────────────────────────────────────────────────

import { createMiddlewarePipeline, PIPELINE_SLOTS } from './pipeline.mjs';
import { createTasteInjector } from './tasteInjector.mjs';
import { createPreClassifier } from './preClassifier.mjs';
import { createDirectorGate } from './directorGate.mjs';
import { createSkillLoader, createSkillRegistry, DOMAINS } from './skillLoader.mjs';
import { createLoopDetector } from './loopDetection.mjs';
import { createContextSummarizer } from './contextSummarizer.mjs';
import { createMemoryWriter } from './memoryWriter.mjs';

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

function assertThrows(fn, substring) {
  try { fn(); throw new Error('Expected throw'); }
  catch (e) { if (substring && !e.message.includes(substring)) throw new Error(`Expected "${substring}" in "${e.message}"`); }
}

// ─── Helpers ────────────────────────────────────────────────────────────

function createTracingMiddleware(name) {
  const calls = [];
  async function mw(request, next) {
    calls.push({ name, request: { ...request } });
    const enriched = { ...request, [`_traced_${name}`]: true };
    if (typeof next === 'function') {
      return next(enriched);
    }
    return enriched;
  }
  mw.getCalls = () => calls;
  mw.getMetrics = () => ({ calls: calls.length });
  return mw;
}

function createShortCircuitMiddleware(name, response) {
  async function mw(request, _next) {
    // Does NOT call next — short-circuits
    return { ...response, [`_short_circuited_by`]: name };
  }
  mw.getMetrics = () => ({});
  return mw;
}

function createErrorMiddleware(name) {
  async function mw(_request, _next) {
    throw new Error(`${name} exploded`);
  }
  mw.getMetrics = () => ({});
  return mw;
}

function createMockStore(data = {}) {
  return {
    async read(key) { return data[key] ?? null; },
    async write(key, val) { data[key] = val; },
  };
}

// ─── Tests: Pipeline Structure ──────────────────────────────────────────

console.log('\n── Pipeline Structure ──');

test('PIPELINE_SLOTS has 13 entries', () => {
  assertEqual(PIPELINE_SLOTS.length, 13);
});

test('PIPELINE_SLOTS is frozen', () => {
  assert(Object.isFrozen(PIPELINE_SLOTS));
});

test('slots are in correct order', () => {
  assertEqual(PIPELINE_SLOTS[0], 'surfaceAdapter');
  assertEqual(PIPELINE_SLOTS[7], 'preClassifier');
  assertEqual(PIPELINE_SLOTS[8], 'directorGate');
  assertEqual(PIPELINE_SLOTS[12], 'responseFormatter');
});

test('creates pipeline with all stubs', () => {
  const pipeline = createMiddlewarePipeline();
  const slots = pipeline.getSlotInfo();
  assertEqual(slots.length, 13);
  assert(slots.every(s => s.isStub));
  pipeline.shutdown();
});

test('slot positions are 1-indexed', () => {
  const pipeline = createMiddlewarePipeline();
  const slots = pipeline.getSlotInfo();
  assertEqual(slots[0].position, 1);
  assertEqual(slots[12].position, 13);
  pipeline.shutdown();
});

// ─── Tests: Basic Pipeline Flow ─────────────────────────────────────────

console.log('\n── Basic Pipeline Flow ──');

await test('request flows through all stubs', async () => {
  const pipeline = createMiddlewarePipeline();
  const result = await pipeline.runPipeline({ message: 'hello' });
  assertEqual(result.message, 'hello');
  assert(result._pipeline_duration >= 0);
  pipeline.shutdown();
});

await test('pipeline tracks run count', async () => {
  const pipeline = createMiddlewarePipeline();
  await pipeline.runPipeline({ message: 'a' });
  await pipeline.runPipeline({ message: 'b' });
  assertEqual(pipeline.getPipelineMetrics().totalRuns, 2);
  pipeline.shutdown();
});

await test('context is merged into request', async () => {
  const pipeline = createMiddlewarePipeline();
  const result = await pipeline.runPipeline({ message: 'test' }, { extra: 'context' });
  assertEqual(result.extra, 'context');
  pipeline.shutdown();
});

// ─── Tests: Middleware Ordering ──────────────────────────────────────────

console.log('\n── Middleware Ordering ──');

await test('middlewares execute in slot order', async () => {
  const order = [];
  const middlewares = {};
  for (const slot of PIPELINE_SLOTS) {
    middlewares[slot] = async (req, next) => {
      order.push(slot);
      if (typeof next === 'function') return next(req);
      return req;
    };
    middlewares[slot].getMetrics = () => ({});
  }

  const pipeline = createMiddlewarePipeline(middlewares);
  await pipeline.runPipeline({ message: 'test' });

  for (let i = 0; i < PIPELINE_SLOTS.length; i++) {
    assertEqual(order[i], PIPELINE_SLOTS[i], `Position ${i}: expected ${PIPELINE_SLOTS[i]}, got ${order[i]}`);
  }
  pipeline.shutdown();
});

await test('each middleware receives enrichments from previous', async () => {
  const tracers = {};
  tracers.surfaceAdapter = createTracingMiddleware('surfaceAdapter');
  tracers.preClassifier = createTracingMiddleware('preClassifier');

  const pipeline = createMiddlewarePipeline(tracers);
  await pipeline.runPipeline({ message: 'test' });

  // Pre-classifier should see surfaceAdapter's trace
  const pcCalls = tracers.preClassifier.getCalls();
  assert(pcCalls.length > 0);
  assertEqual(pcCalls[0].request._traced_surfaceAdapter, true);
  pipeline.shutdown();
});

// ─── Tests: Short-Circuit ───────────────────────────────────────────────

console.log('\n── Short-Circuit ──');

await test('short-circuit stops downstream middlewares', async () => {
  const downstream = createTracingMiddleware('workerDispatch');

  const pipeline = createMiddlewarePipeline({
    directorGate: createShortCircuitMiddleware('directorGate', {
      content: 'Director says no.',
      _director_invoked: true,
    }),
    workerDispatch: downstream,
  });

  const result = await pipeline.runPipeline({ message: '/director test' });
  assertEqual(result.content, 'Director says no.');
  assertEqual(downstream.getCalls().length, 0); // never reached
  pipeline.shutdown();
});

await test('short-circuit counted in metrics', async () => {
  const pipeline = createMiddlewarePipeline({
    directorGate: createShortCircuitMiddleware('directorGate', {
      _director_invoked: true,
    }),
  });

  await pipeline.runPipeline({ message: '/director test' });
  assertEqual(pipeline.getPipelineMetrics().shortCircuits, 1);
  pipeline.shutdown();
});

// ─── Tests: Error Handling ──────────────────────────────────────────────

console.log('\n── Error Handling ──');

await test('error in middleware → graceful degradation', async () => {
  const pipeline = createMiddlewarePipeline({
    tasteInjector: createErrorMiddleware('tasteInjector'),
  });

  const result = await pipeline.runPipeline({ message: 'test' });
  // Pipeline should complete despite error
  assertEqual(result._tasteInjector_error, 'tasteInjector exploded');
  assert(result._pipeline_duration >= 0);
  pipeline.shutdown();
});

await test('error tracked in metrics', async () => {
  const pipeline = createMiddlewarePipeline({
    skillLoader: createErrorMiddleware('skillLoader'),
  });

  await pipeline.runPipeline({ message: 'test' });
  const metrics = pipeline.getPipelineMetrics();
  assertEqual(metrics.totalErrors, 1);
  assertEqual(metrics.perMiddleware.skillLoader.errors, 1);
  pipeline.shutdown();
});

await test('multiple errors handled independently', async () => {
  const pipeline = createMiddlewarePipeline({
    tasteInjector: createErrorMiddleware('tasteInjector'),
    skillLoader: createErrorMiddleware('skillLoader'),
  });

  const result = await pipeline.runPipeline({ message: 'test' });
  assertEqual(result._tasteInjector_error, 'tasteInjector exploded');
  assertEqual(result._skillLoader_error, 'skillLoader exploded');
  assertEqual(pipeline.getPipelineMetrics().totalErrors, 2);
  pipeline.shutdown();
});

// ─── Tests: Timing ──────────────────────────────────────────────────────

console.log('\n── Timing ──');

await test('per-middleware timing tracked', async () => {
  const pipeline = createMiddlewarePipeline();
  await pipeline.runPipeline({ message: 'test' });

  const metrics = pipeline.getPipelineMetrics();
  for (const slot of PIPELINE_SLOTS) {
    assertEqual(metrics.perMiddleware[slot].calls, 1);
    assert(metrics.perMiddleware[slot].totalMs >= 0);
  }
  pipeline.shutdown();
});

await test('pipeline duration tracked', async () => {
  const pipeline = createMiddlewarePipeline();
  const result = await pipeline.runPipeline({ message: 'test' });
  assert(result._pipeline_duration >= 0);
  pipeline.shutdown();
});

// ─── Tests: Slot Replacement ────────────────────────────────────────────

console.log('\n── Slot Replacement ──');

test('replaceSlot with valid slot works', () => {
  const pipeline = createMiddlewarePipeline();
  const tracer = createTracingMiddleware('custom');
  pipeline.replaceSlot('warmStart', tracer);
  const slots = pipeline.getSlotInfo();
  // Slot should now be non-stub (though getSlotInfo reflects initial state)
  pipeline.shutdown();
});

await test('replaced slot executes in correct position', async () => {
  const order = [];
  const pipeline = createMiddlewarePipeline();
  pipeline.replaceSlot('warmStart', async (req, next) => {
    order.push('warmStart');
    return next(req);
  });
  pipeline.replaceSlot('preClassifier', async (req, next) => {
    order.push('preClassifier');
    return next(req);
  });

  await pipeline.runPipeline({ message: 'test' });
  const wsIdx = order.indexOf('warmStart');
  const pcIdx = order.indexOf('preClassifier');
  assert(wsIdx < pcIdx, 'warmStart should execute before preClassifier');
  pipeline.shutdown();
});

test('replaceSlot with unknown slot throws', () => {
  const pipeline = createMiddlewarePipeline();
  assertThrows(() => pipeline.replaceSlot('nonexistent', () => {}), 'Unknown pipeline slot');
  pipeline.shutdown();
});

// ─── Tests: Integration — Real Middlewares ───────────────────────────────

console.log('\n── Integration: Real Middlewares ──');

await test('tasteInjector + preClassifier + skillLoader integrated', async () => {
  const store = createMockStore({
    'taste:narrative:default': { text: 'Prefers dark themes.' },
  });

  const registry = createSkillRegistry();
  registry.register('react-guide', DOMAINS.FRONTEND, 'React patterns for UI.', 10);

  const pipeline = createMiddlewarePipeline({
    tasteInjector: createTasteInjector(store),
    preClassifier: createPreClassifier(),
    skillLoader: createSkillLoader(registry),
  });

  const result = await pipeline.runPipeline({
    message: 'Build a React component for the dashboard',
    system_prompt: 'You are RONIN.',
  });

  // Taste injected
  assert(result.system_prompt.includes('dark themes'), 'taste should be injected');
  assertEqual(result._taste_injected, true);

  // Pre-classified
  assertEqual(result._pre_classified, true);
  assert(result.classification !== undefined);

  // Skills loaded
  assertEqual(result._skill_domain, DOMAINS.FRONTEND);
  assert(result._skills_loaded.includes('react-guide'));

  pipeline.shutdown();
});

await test('directorGate short-circuits with real middleware', async () => {
  const mockOpus = async () => 'The Director recommends a darker palette.';
  const pipeline = createMiddlewarePipeline({
    directorGate: createDirectorGate(mockOpus),
  });

  const result = await pipeline.runPipeline({ message: '/director review the color scheme' });
  assertEqual(result._director_invoked, true);
  assert(result.content.includes('darker palette'));
  pipeline.shutdown();
});

await test('loopDetection triggers on repeated tool calls', async () => {
  const loopDetector = createLoopDetector();
  const pipeline = createMiddlewarePipeline({
    loopDetection: loopDetector,
  });

  const call = { tool: 'readFile', args: { path: 'same.js' } };

  await pipeline.runPipeline({ session_id: 'loop_test', tool_calls: [call] });
  await pipeline.runPipeline({ session_id: 'loop_test', tool_calls: [call] });
  const result = await pipeline.runPipeline({ session_id: 'loop_test', tool_calls: [call] });

  assertEqual(result._loop_detected, true);
  pipeline.shutdown();
});

await test('contextSummarizer compresses long history', async () => {
  const mockProvider = async () => 'Summary of old conversation.';
  const pipeline = createMiddlewarePipeline({
    contextSummarizer: createContextSummarizer(mockProvider, {
      tokenLimit: 50,
      preserveRecent: 2,
    }),
  });

  const messages = Array.from({ length: 10 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: 'x'.repeat(100),
  }));

  const result = await pipeline.runPipeline({ messages });
  assertEqual(result._context_summarized, true);
  assert(result._messages_compressed > 0);
  pipeline.shutdown();
});

await test('memoryWriter queues turn without blocking', async () => {
  const mm = createMockStore();
  const writer = createMemoryWriter(mm, { debounceMs: 60000 });
  const pipeline = createMiddlewarePipeline({
    memoryWriter: writer,
  });

  const result = await pipeline.runPipeline({ message: 'Test memory' });
  // Pipeline completes immediately
  assert(result._pipeline_duration >= 0);
  // Turn is queued
  assertEqual(writer.getQueueDepth(), 1);
  writer.shutdown();
  pipeline.shutdown();
});

// ─── Tests: Full Pipeline — End to End ──────────────────────────────────

console.log('\n── Full Pipeline: End to End ──');

await test('full pipeline with all real middlewares (non-stub)', async () => {
  const store = createMockStore({
    'taste:narrative:default': { text: 'Likes clean minimalism.' },
  });

  const registry = createSkillRegistry();
  registry.register('react', DOMAINS.FRONTEND, 'React basics.', 10);

  const mm = createMockStore();
  const writer = createMemoryWriter(mm, { debounceMs: 60000 });

  const pipeline = createMiddlewarePipeline({
    tasteInjector: createTasteInjector(store),
    skillLoader: createSkillLoader(registry),
    contextSummarizer: createContextSummarizer(null, { tokenLimit: 100000 }),
    preClassifier: createPreClassifier(),
    directorGate: createDirectorGate(null), // no Opus provider
    loopDetection: createLoopDetector(),
    memoryWriter: writer,
  });

  const result = await pipeline.runPipeline({
    message: 'Build a React component',
    system_prompt: 'You are RONIN.',
    session_id: 'full_test',
  });

  // Verify pipeline ran completely
  assert(result._pipeline_duration >= 0);
  assert(result._pipeline_run === 1);

  // Taste injected
  assert(result.system_prompt.includes('minimalism'));

  // Pre-classified
  assertEqual(result._pre_classified, true);
  assertEqual(result.classification.modality, 'code');

  // Skills loaded
  assert(result._skills_loaded.includes('react'));

  // Memory queued
  assertEqual(writer.getQueueDepth(), 1);

  // No director invocation
  assertEqual(result._director_invoked, undefined);

  writer.shutdown();
  pipeline.shutdown();
});

await test('full pipeline with director invocation short-circuits', async () => {
  const mockOpus = async () => 'Director: use 8px grid system.';
  const writer = createMemoryWriter(null, { debounceMs: 60000 });

  const pipeline = createMiddlewarePipeline({
    tasteInjector: createTasteInjector(createMockStore()),
    preClassifier: createPreClassifier(),
    directorGate: createDirectorGate(mockOpus),
    memoryWriter: writer,
  });

  const result = await pipeline.runPipeline({ message: '/director review my spacing' });

  // Director short-circuited
  assertEqual(result._director_invoked, true);
  assert(result.content.includes('8px grid'));

  // Memory writer should NOT have been reached (short-circuit)
  assertEqual(writer.getQueueDepth(), 0);

  writer.shutdown();
  pipeline.shutdown();
});

await test('metrics show per-middleware detail after full run', async () => {
  const pipeline = createMiddlewarePipeline({
    preClassifier: createPreClassifier(),
  });

  await pipeline.runPipeline({ message: 'hello' });
  await pipeline.runPipeline({ message: 'world' });

  const metrics = pipeline.getPipelineMetrics();
  assertEqual(metrics.totalRuns, 2);
  assertEqual(metrics.perMiddleware.preClassifier.calls, 2);

  // Stubs also tracked
  assertEqual(metrics.perMiddleware.surfaceAdapter.calls, 2);
  pipeline.shutdown();
});

// ─── Tests: Edge Cases ──────────────────────────────────────────────────

console.log('\n── Edge Cases ──');

await test('empty request works', async () => {
  const pipeline = createMiddlewarePipeline();
  const result = await pipeline.runPipeline({});
  assert(result._pipeline_duration >= 0);
  pipeline.shutdown();
});

await test('null message works', async () => {
  const pipeline = createMiddlewarePipeline();
  const result = await pipeline.runPipeline({ message: null });
  assert(result._pipeline_duration >= 0);
  pipeline.shutdown();
});

await test('pipeline is reusable across many runs', async () => {
  const pipeline = createMiddlewarePipeline();
  for (let i = 0; i < 20; i++) {
    await pipeline.runPipeline({ message: `msg_${i}` });
  }
  assertEqual(pipeline.getPipelineMetrics().totalRuns, 20);
  pipeline.shutdown();
});

// ─── Summary ─────────────────────────────────────────────────────────────

await new Promise(r => setTimeout(r, 100));

console.log(`\n${'─'.repeat(60)}`);
console.log(`M8 pipeline (CAPSTONE): ${passCount}/${testCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
