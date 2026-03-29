// ─── workers/workerDispatch.test.mjs ──────────────────────────────────────────
// Tests for RONIN Worker Dispatch CAPSTONE (W8)
// Run: node workerDispatch.test.mjs 2>&1
// ─────────────────────────────────────────────────────────────────────────────

import { createWorkerDispatch } from './workerDispatch.mjs';
import { createWorkerRegistry, createBaseWorker, WORKER_TYPES, WORKER_STATES } from './workerInterface.mjs';

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

// ─── Mock Workers ───────────────────────────────────────────────────────

function makeWorker(type, opts = {}) {
  return createBaseWorker(type, async (task) => {
    if (opts.fail) throw new Error(opts.fail);
    return {
      result: opts.result || `${type}-response`,
      cost: opts.cost || 0,
      inputTokens: 100,
      outputTokens: 50,
      needsEscalation: opts.needsEscalation || false,
      unavailable: opts.unavailable || false,
      fallback: opts.fallback || null,
    };
  });
}

function makeRegistry(...types) {
  const reg = createWorkerRegistry();
  for (const type of types) {
    reg.register(type, makeWorker(type));
  }
  return reg;
}

function makeRequest(message, classification = {}) {
  return {
    message,
    _classification: {
      suggestedWorker: classification.worker || 'fast',
      modality: classification.modality || 'text',
      urgency: classification.urgency || 'low',
      complexity: classification.complexity || 'trivial',
      ...classification,
    },
  };
}

// ─── Basic Dispatch ─────────────────────────────────────────────────────

console.log('\n── Basic Dispatch ──');

await test('dispatches to fast worker', async () => {
  const reg = makeRegistry('fast');
  const dispatch = createWorkerDispatch(reg);

  const result = await dispatch.middleware(makeRequest('What time is it?'));

  assertEqual(result._dispatched, true);
  assertEqual(result._worker_type, 'fast');
  assertEqual(result._worker_result, 'fast-response');
  assertEqual(result._worker_cost, 0);
});

await test('dispatches to vision worker', async () => {
  const reg = makeRegistry('fast', 'vision');
  const dispatch = createWorkerDispatch(reg);

  const result = await dispatch.middleware(makeRequest('Analyze screenshot', { worker: 'vision' }));

  assertEqual(result._worker_type, 'vision');
  assertEqual(result._worker_result, 'vision-response');
});

await test('dispatches to agent worker', async () => {
  const reg = makeRegistry('fast', 'agent');
  const dispatch = createWorkerDispatch(reg);

  const result = await dispatch.middleware(makeRequest('Build a login page', { worker: 'agent' }));

  assertEqual(result._worker_type, 'agent');
});

await test('dispatches to codex worker', async () => {
  const reg = makeRegistry('fast', 'codex');
  const dispatch = createWorkerDispatch(reg);

  const result = await dispatch.middleware(makeRequest('Generate the file', { worker: 'codex' }));

  assertEqual(result._worker_type, 'codex');
});

await test('dispatches to deep worker', async () => {
  const reg = makeRegistry('fast', 'deep');
  const dispatch = createWorkerDispatch(reg);

  const result = await dispatch.middleware(makeRequest('Deep analysis', { worker: 'deep' }));

  assertEqual(result._worker_type, 'deep');
});

await test('dispatches to local worker', async () => {
  const reg = makeRegistry('fast', 'local');
  const dispatch = createWorkerDispatch(reg);

  const result = await dispatch.middleware(makeRequest('Quick edit', { worker: 'local' }));

  assertEqual(result._worker_type, 'local');
});

await test('defaults to fast when no classification', async () => {
  const reg = makeRegistry('fast');
  const dispatch = createWorkerDispatch(reg);

  const result = await dispatch.middleware({ message: 'hello' });

  assertEqual(result._worker_type, 'fast');
});

await test('model identity always hidden', async () => {
  const reg = makeRegistry('fast');
  const dispatch = createWorkerDispatch(reg);

  const result = await dispatch.middleware(makeRequest('test'));

  assertEqual(result._worker_metadata.model_hidden, true);
});

// ─── Fallback Chains ────────────────────────────────────────────────────

console.log('\n── Fallback Chains ──');

await test('falls back when preferred worker unhealthy', async () => {
  const reg = createWorkerRegistry();
  const agent = makeWorker('agent');
  agent.setHealth(WORKER_STATES.UNHEALTHY);
  reg.register('agent', agent);
  reg.register('fast', makeWorker('fast'));

  const dispatch = createWorkerDispatch(reg);
  const result = await dispatch.middleware(makeRequest('Build something', { worker: 'agent' }));

  assertEqual(result._worker_type, 'fast');
  assert(dispatch.getDispatchMetrics().fallbackCount > 0);
});

await test('falls back to fast as ultimate fallback', async () => {
  const reg = createWorkerRegistry();
  const deep = makeWorker('deep');
  deep.setHealth(WORKER_STATES.UNHEALTHY);
  reg.register('deep', deep);
  reg.register('fast', makeWorker('fast'));

  const dispatch = createWorkerDispatch(reg);
  const result = await dispatch.middleware(makeRequest('Deep question', { worker: 'deep' }));

  assertEqual(result._dispatched, true);
});

await test('handles local worker unavailable signal', async () => {
  const reg = createWorkerRegistry();
  reg.register('local', createBaseWorker('local', async () => ({
    result: null,
    cost: 0,
    unavailable: true,
    fallback: 'fast',
  })));
  reg.register('fast', makeWorker('fast'));

  const dispatch = createWorkerDispatch(reg);
  const result = await dispatch.middleware(makeRequest('quick edit', { worker: 'local' }));

  assertEqual(result._worker_type, 'fast');
  assertEqual(result._worker_result, 'fast-response');
});

await test('error when no workers available', async () => {
  const reg = createWorkerRegistry();
  const dispatch = createWorkerDispatch(reg);

  const result = await dispatch.middleware(makeRequest('test', { worker: 'agent' }));

  assertEqual(result._dispatched, false);
  assert(result._worker_error.includes('No worker available'));
});

// ─── Escalation ─────────────────────────────────────────────────────────

console.log('\n── Escalation ──');

await test('escalates fast → agent on needsEscalation', async () => {
  const reg = createWorkerRegistry();
  reg.register('fast', createBaseWorker('fast', async () => ({
    result: 'This needs deeper analysis.',
    cost: 0,
    needsEscalation: true,
  })));
  reg.register('agent', makeWorker('agent', { result: 'Agent handled it.' }));

  const dispatch = createWorkerDispatch(reg);
  const result = await dispatch.middleware(makeRequest('complex question'));

  assertEqual(result._worker_result, 'Agent handled it.');
  assertEqual(result._worker_type, 'agent');
  assertEqual(dispatch.getDispatchMetrics().escalationCount, 1);
});

await test('escalates agent → deep', async () => {
  const reg = createWorkerRegistry();
  reg.register('fast', makeWorker('fast'));
  reg.register('agent', createBaseWorker('agent', async () => ({
    result: 'Too complex.',
    cost: 0.01,
    needsEscalation: true,
  })));
  reg.register('deep', makeWorker('deep', { result: 'Deep analysis.' }));

  const dispatch = createWorkerDispatch(reg);
  const result = await dispatch.middleware(makeRequest('architecture', { worker: 'agent' }));

  assertEqual(result._worker_result, 'Deep analysis.');
  assertEqual(result._worker_type, 'deep');
});

await test('respects maxEscalations', async () => {
  const reg = createWorkerRegistry();
  // Every worker escalates
  reg.register('fast', createBaseWorker('fast', async () => ({ result: 'esc', cost: 0, needsEscalation: true })));
  reg.register('agent', createBaseWorker('agent', async () => ({ result: 'esc', cost: 0, needsEscalation: true })));
  reg.register('deep', makeWorker('deep', { result: 'finally deep' }));

  const dispatch = createWorkerDispatch(reg, { maxEscalations: 2 });
  const result = await dispatch.middleware(makeRequest('test'));

  // fast → agent → deep (2 escalations)
  assertEqual(result._worker_result, 'finally deep');
});

await test('stops escalation at maxEscalations limit', async () => {
  const reg = createWorkerRegistry();
  reg.register('fast', createBaseWorker('fast', async () => ({ result: 'esc1', cost: 0, needsEscalation: true })));
  reg.register('agent', createBaseWorker('agent', async () => ({ result: 'esc2', cost: 0, needsEscalation: true })));
  reg.register('deep', createBaseWorker('deep', async () => ({ result: 'esc3', cost: 0, needsEscalation: true })));

  const dispatch = createWorkerDispatch(reg, { maxEscalations: 1 });
  const result = await dispatch.middleware(makeRequest('test'));

  // fast → agent (1 escalation), agent would escalate but maxEscalations=1
  assertEqual(result._worker_result, 'esc2');
});

await test('disables escalation when configured', async () => {
  const reg = createWorkerRegistry();
  reg.register('fast', createBaseWorker('fast', async () => ({ result: 'needs help', cost: 0, needsEscalation: true })));
  reg.register('agent', makeWorker('agent'));

  const dispatch = createWorkerDispatch(reg, { enableEscalation: false });
  const result = await dispatch.middleware(makeRequest('test'));

  assertEqual(result._worker_result, 'needs help');
  assertEqual(dispatch.getDispatchMetrics().escalationCount, 0);
});

// ─── Cost Guardrail ─────────────────────────────────────────────────────

console.log('\n── Cost Guardrail ──');

await test('downgrades when budget exceeded', async () => {
  const reg = createWorkerRegistry();
  reg.register('agent', makeWorker('agent', { cost: 0.10 }));
  reg.register('fast', makeWorker('fast'));

  const dispatch = createWorkerDispatch(reg, {
    costGuardrail: {
      canAfford: async (type) => type !== 'agent', // can't afford agent
    },
  });

  const result = await dispatch.middleware(makeRequest('build', { worker: 'agent' }));

  // Should downgrade to fast (cheapest)
  assertEqual(result._worker_type, 'fast');
});

await test('allows dispatch when budget ok', async () => {
  const reg = makeRegistry('fast', 'agent');
  const dispatch = createWorkerDispatch(reg, {
    costGuardrail: {
      canAfford: async () => true,
    },
  });

  const result = await dispatch.middleware(makeRequest('build', { worker: 'agent' }));
  assertEqual(result._worker_type, 'agent');
});

// ─── Middleware Integration ─────────────────────────────────────────────

console.log('\n── Middleware Integration ──');

await test('attaches all required fields to request', async () => {
  const reg = makeRegistry('fast');
  const dispatch = createWorkerDispatch(reg);

  const result = await dispatch.middleware(makeRequest('test'));

  assert(result._dispatched !== undefined);
  assert(result._worker_result !== undefined);
  assert(result._worker_cost !== undefined);
  assert(result._worker_type !== undefined);
  assert(result._worker_duration !== undefined);
  assert(result._worker_metadata !== undefined);
});

await test('preserves original request fields', async () => {
  const reg = makeRegistry('fast');
  const dispatch = createWorkerDispatch(reg);

  const original = makeRequest('test');
  original.session_id = 'sess-123';
  original.custom_field = 'preserved';

  const result = await dispatch.middleware(original);

  assertEqual(result.session_id, 'sess-123');
  assertEqual(result.custom_field, 'preserved');
  assertEqual(result.message, 'test');
});

await test('handles worker error gracefully', async () => {
  const reg = createWorkerRegistry();
  reg.register('fast', createBaseWorker('fast', async () => {
    throw new Error('Provider timeout');
  }));

  const dispatch = createWorkerDispatch(reg);
  const result = await dispatch.middleware(makeRequest('test'));

  assertEqual(result._dispatched, false);
  assert(result._worker_error.includes('Provider timeout'));
  assertEqual(dispatch.getDispatchMetrics().errors, 1);
});

// ─── Dispatch Metrics ───────────────────────────────────────────────────

console.log('\n── Dispatch Metrics ──');

await test('tracks total dispatches', async () => {
  const reg = makeRegistry('fast');
  const dispatch = createWorkerDispatch(reg);

  await dispatch.middleware(makeRequest('a'));
  await dispatch.middleware(makeRequest('b'));
  await dispatch.middleware(makeRequest('c'));

  assertEqual(dispatch.getDispatchMetrics().totalDispatches, 3);
});

await test('tracks per-worker counts', async () => {
  const reg = makeRegistry('fast', 'agent', 'vision');
  const dispatch = createWorkerDispatch(reg);

  await dispatch.middleware(makeRequest('a', { worker: 'fast' }));
  await dispatch.middleware(makeRequest('b', { worker: 'fast' }));
  await dispatch.middleware(makeRequest('c', { worker: 'agent' }));
  await dispatch.middleware(makeRequest('d', { worker: 'vision' }));

  const m = dispatch.getDispatchMetrics();
  assertEqual(m.workerCounts.fast, 2);
  assertEqual(m.workerCounts.agent, 1);
  assertEqual(m.workerCounts.vision, 1);
});

await test('tracks total cost', async () => {
  const reg = createWorkerRegistry();
  reg.register('fast', makeWorker('fast', { cost: 0 }));
  reg.register('agent', makeWorker('agent', { cost: 0.05 }));

  const dispatch = createWorkerDispatch(reg);

  await dispatch.middleware(makeRequest('a'));
  await dispatch.middleware(makeRequest('b', { worker: 'agent' }));

  assertEqual(dispatch.getDispatchMetrics().totalCost, 0.05);
});

await test('resetMetrics clears all', async () => {
  const reg = makeRegistry('fast');
  const dispatch = createWorkerDispatch(reg);

  await dispatch.middleware(makeRequest('a'));
  dispatch.resetMetrics();

  const m = dispatch.getDispatchMetrics();
  assertEqual(m.totalDispatches, 0);
  assertEqual(m.totalCost, 0);
  assertEqual(Object.keys(m.workerCounts).length, 0);
});

// ─── Direct Dispatch ────────────────────────────────────────────────────

console.log('\n── Direct Dispatch ──');

await test('dispatch() returns structured result', async () => {
  const reg = makeRegistry('fast');
  const wd = createWorkerDispatch(reg);

  const result = await wd.dispatch('fast', makeRequest('test'), 0);

  assertEqual(result.resolvedWorker, 'fast');
  assertEqual(result.requestedWorker, 'fast');
  assertEqual(result.result, 'fast-response');
  assertEqual(result.cost, 0);
  assertEqual(result.fellBack, false);
  assertEqual(result.escalated, false);
  assertEqual(result.metadata.model_hidden, true);
});

await test('dispatch() reports escalation depth', async () => {
  const reg = createWorkerRegistry();
  reg.register('fast', createBaseWorker('fast', async () => ({ result: 'esc', cost: 0, needsEscalation: true })));
  reg.register('agent', makeWorker('agent', { result: 'handled' }));

  const wd = createWorkerDispatch(reg);
  const result = await wd.dispatch('fast', makeRequest('test'), 0);

  assertEqual(result.escalated, true);
  assertEqual(result.escalationDepth, 1);
});

// ─── Internal Helpers ───────────────────────────────────────────────────

console.log('\n── Internal Helpers ──');

test('_findCheapestWorker returns free tier', () => {
  const reg = makeRegistry('fast', 'agent', 'vision');
  const wd = createWorkerDispatch(reg);
  const cheapest = wd._findCheapestWorker();
  // local > fast > vision priority
  assert(['local', 'fast', 'vision'].includes(cheapest));
});

test('_findCheapestWorker skips unhealthy', () => {
  const reg = createWorkerRegistry();
  const local = makeWorker('local');
  local.setHealth(WORKER_STATES.UNHEALTHY);
  reg.register('local', local);
  reg.register('fast', makeWorker('fast'));

  const wd = createWorkerDispatch(reg);
  assertEqual(wd._findCheapestWorker(), 'fast');
});

test('_findCheapestWorker returns null when none available', () => {
  const reg = createWorkerRegistry();
  const wd = createWorkerDispatch(reg);
  assertEqual(wd._findCheapestWorker(), null);
});

// ─── Summary ────────────────────────────────────────────────────────────

await new Promise(r => setTimeout(r, 100));
console.log(`\n${'─'.repeat(60)}`);
console.log(`WorkerDispatch: ${passCount}/${testCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
