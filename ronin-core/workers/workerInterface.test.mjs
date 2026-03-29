// ─── workers/workerInterface.test.mjs ─────────────────────────────────────────
// Tests for RONIN Worker Interface + Registry (W1)
// Run: node workerInterface.test.mjs 2>&1
// ─────────────────────────────────────────────────────────────────────────────

import {
  WORKER_TYPES,
  WORKER_STATES,
  FALLBACK_CHAINS,
  validateWorkerContract,
  createBaseWorker,
  createWorkerRegistry,
} from './workerInterface.mjs';

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
function assertThrows(fn, msg) {
  try { fn(); throw new Error('Expected to throw'); }
  catch (e) { if (e.message === 'Expected to throw') throw e; if (msg) assert(e.message.includes(msg), `Expected "${msg}" in "${e.message}"`); }
}

// ─── WORKER_TYPES ───────────────────────────────────────────────────────

console.log('\n── WORKER_TYPES ──');

test('has all 6 worker types', () => {
  assertEqual(Object.keys(WORKER_TYPES).length, 6);
  assert(WORKER_TYPES.FAST === 'fast');
  assert(WORKER_TYPES.VISION === 'vision');
  assert(WORKER_TYPES.AGENT === 'agent');
  assert(WORKER_TYPES.DEEP === 'deep');
  assert(WORKER_TYPES.CODEX === 'codex');
  assert(WORKER_TYPES.LOCAL === 'local');
});

test('WORKER_TYPES is frozen', () => {
  assertThrows(() => { WORKER_TYPES.NEW = 'new'; });
});

test('WORKER_STATES has 3 states', () => {
  assertEqual(Object.keys(WORKER_STATES).length, 3);
  assert(WORKER_STATES.HEALTHY === 'healthy');
  assert(WORKER_STATES.DEGRADED === 'degraded');
  assert(WORKER_STATES.UNHEALTHY === 'unhealthy');
});

test('FALLBACK_CHAINS defined for all types', () => {
  for (const type of Object.values(WORKER_TYPES)) {
    assert(FALLBACK_CHAINS[type] !== undefined, `Missing fallback chain for ${type}`);
    assert(Array.isArray(FALLBACK_CHAINS[type]));
  }
});

// ─── validateWorkerContract ─────────────────────────────────────────────

console.log('\n── validateWorkerContract ──');

test('valid worker passes', () => {
  const worker = {
    type: 'fast',
    execute: async () => {},
    getHealth: () => ({ status: 'healthy' }),
    getMetrics: () => ({ calls: 0 }),
  };
  const result = validateWorkerContract(worker, 'fast');
  assert(result.valid);
  assertEqual(result.errors.length, 0);
});

test('null worker fails', () => {
  const result = validateWorkerContract(null, 'fast');
  assert(!result.valid);
  assert(result.errors[0].includes('non-null'));
});

test('missing execute fails', () => {
  const worker = { type: 'fast', getHealth: () => {}, getMetrics: () => {} };
  const result = validateWorkerContract(worker, 'fast');
  assert(!result.valid);
  assert(result.errors.some(e => e.includes('execute')));
});

test('missing getHealth fails', () => {
  const worker = { type: 'fast', execute: async () => {}, getMetrics: () => {} };
  const result = validateWorkerContract(worker, 'fast');
  assert(!result.valid);
  assert(result.errors.some(e => e.includes('getHealth')));
});

test('missing getMetrics fails', () => {
  const worker = { type: 'fast', execute: async () => {}, getHealth: () => {} };
  const result = validateWorkerContract(worker, 'fast');
  assert(!result.valid);
  assert(result.errors.some(e => e.includes('getMetrics')));
});

test('wrong type fails', () => {
  const worker = { type: 'vision', execute: async () => {}, getHealth: () => {}, getMetrics: () => {} };
  const result = validateWorkerContract(worker, 'fast');
  assert(!result.valid);
  assert(result.errors.some(e => e.includes('"fast"')));
});

test('multiple errors reported', () => {
  const worker = { type: 'wrong' };
  const result = validateWorkerContract(worker, 'fast');
  assert(!result.valid);
  assert(result.errors.length >= 3);
});

// ─── createBaseWorker ───────────────────────────────────────────────────

console.log('\n── createBaseWorker ──');

test('creates worker with correct type', () => {
  const w = createBaseWorker('fast', async () => ({ result: 'ok', cost: 0 }));
  assertEqual(w.type, 'fast');
});

test('implements full contract', () => {
  const w = createBaseWorker('fast', async () => ({ result: 'ok', cost: 0 }));
  const validation = validateWorkerContract(w, 'fast');
  assert(validation.valid, validation.errors.join('; '));
});

await test('execute tracks metrics', async () => {
  const w = createBaseWorker('fast', async () => ({ result: 'hello', cost: 0.001 }));
  await w.execute({ message: 'test' });
  const m = w.getMetrics();
  assertEqual(m.calls, 1);
  assertEqual(m.successes, 1);
  assertEqual(m.errors, 0);
  assertEqual(m.totalCost, 0.001);
  assert(m.avgDurationMs >= 0);
});

await test('execute returns result with worker type', async () => {
  const w = createBaseWorker('vision', async () => ({ result: 'analyzed', cost: 0 }));
  const r = await w.execute({ image: 'base64...' });
  assertEqual(r.result, 'analyzed');
  assertEqual(r.worker, 'vision');
  assertEqual(r.model_hidden, true); // ADR-010
});

await test('execute tracks duration', async () => {
  const w = createBaseWorker('fast', async () => {
    await new Promise(r => setTimeout(r, 20));
    return { result: 'ok', cost: 0 };
  });
  const r = await w.execute({ message: 'test' });
  assert(r.duration >= 15, `Duration too low: ${r.duration}`);
});

await test('execute tracks errors', async () => {
  const w = createBaseWorker('agent', async () => { throw new Error('API down'); });
  try { await w.execute({ task: 'build' }); } catch {}
  const m = w.getMetrics();
  assertEqual(m.calls, 1);
  assertEqual(m.errors, 1);
  assertEqual(m.successes, 0);
});

await test('consecutive errors degrade health', async () => {
  const w = createBaseWorker('agent', async () => { throw new Error('fail'); }, { maxConsecutiveErrors: 3 });

  // First error — still healthy
  try { await w.execute({}); } catch {}
  assertEqual(w.getHealth().status, WORKER_STATES.HEALTHY);

  // Second error — degraded (>= ceil(3/2) = 2)
  try { await w.execute({}); } catch {}
  assertEqual(w.getHealth().status, WORKER_STATES.DEGRADED);

  // Third error — unhealthy
  try { await w.execute({}); } catch {}
  assertEqual(w.getHealth().status, WORKER_STATES.UNHEALTHY);
});

await test('success after errors recovers from degraded', async () => {
  let shouldFail = true;
  const w = createBaseWorker('fast', async () => {
    if (shouldFail) throw new Error('fail');
    return { result: 'ok', cost: 0 };
  }, { maxConsecutiveErrors: 4 });

  try { await w.execute({}); } catch {}
  try { await w.execute({}); } catch {}
  assertEqual(w.getHealth().status, WORKER_STATES.DEGRADED);

  shouldFail = false;
  await w.execute({});
  assertEqual(w.getHealth().status, WORKER_STATES.HEALTHY);
});

test('getHealth returns structure', () => {
  const w = createBaseWorker('fast', async () => ({ result: 'ok', cost: 0 }));
  const h = w.getHealth();
  assertEqual(h.status, WORKER_STATES.HEALTHY);
  assertEqual(h.consecutiveErrors, 0);
  assert(h.lastCheck > 0);
});

test('setHealth changes status', () => {
  const w = createBaseWorker('fast', async () => ({ result: 'ok', cost: 0 }));
  w.setHealth(WORKER_STATES.DEGRADED);
  assertEqual(w.getHealth().status, WORKER_STATES.DEGRADED);
});

test('setHealth rejects invalid status', () => {
  const w = createBaseWorker('fast', async () => ({ result: 'ok', cost: 0 }));
  assertThrows(() => w.setHealth('broken'), 'Invalid health status');
});

test('setHealth to HEALTHY resets consecutive errors', () => {
  const w = createBaseWorker('fast', async () => ({ result: 'ok', cost: 0 }));
  w.setHealth(WORKER_STATES.UNHEALTHY);
  w.setHealth(WORKER_STATES.HEALTHY);
  assertEqual(w.getHealth().consecutiveErrors, 0);
});

test('getMetrics returns zero state initially', () => {
  const w = createBaseWorker('fast', async () => ({}));
  const m = w.getMetrics();
  assertEqual(m.calls, 0);
  assertEqual(m.totalCost, 0);
  assertEqual(m.avgDurationMs, 0);
  assertEqual(m.errorRate, 0);
  assertEqual(m.type, 'fast');
});

await test('getMetrics computes error rate', async () => {
  let count = 0;
  const w = createBaseWorker('fast', async () => {
    count++;
    if (count <= 1) throw new Error('fail');
    return { result: 'ok', cost: 0 };
  }, { maxConsecutiveErrors: 10 });

  try { await w.execute({}); } catch {}
  await w.execute({});
  const m = w.getMetrics();
  assertEqual(m.errorRate, 0.5);
});

test('resetMetrics clears everything', () => {
  const w = createBaseWorker('fast', async () => ({ result: 'ok', cost: 1.0 }));
  w.resetMetrics();
  const m = w.getMetrics();
  assertEqual(m.calls, 0);
  assertEqual(m.totalCost, 0);
  assertEqual(w.getHealth().status, WORKER_STATES.HEALTHY);
});

await test('multiple calls accumulate cost', async () => {
  const w = createBaseWorker('agent', async () => ({ result: 'ok', cost: 0.01 }));
  await w.execute({});
  await w.execute({});
  await w.execute({});
  assertEqual(w.getMetrics().totalCost, 0.03);
  assertEqual(w.getMetrics().calls, 3);
});

// ─── createWorkerRegistry ───────────────────────────────────────────────

console.log('\n── createWorkerRegistry ──');

function makeMockWorker(type, opts = {}) {
  return createBaseWorker(type, async (task) => {
    if (opts.fail) throw new Error(opts.fail);
    return { result: opts.result || `${type}-result`, cost: opts.cost || 0 };
  }, opts);
}

test('creates empty registry', () => {
  const reg = createWorkerRegistry();
  assertEqual(reg.getRegisteredCount(), 0);
  assertEqual(reg.listWorkers().length, 0);
});

test('register and get worker', () => {
  const reg = createWorkerRegistry();
  const w = makeMockWorker('fast');
  reg.register('fast', w);
  const got = reg.getWorker('fast');
  assertEqual(got.type, 'fast');
});

test('register rejects unknown type', () => {
  const reg = createWorkerRegistry();
  assertThrows(() => reg.register('quantum', {}), 'Unknown worker type');
});

test('register rejects invalid contract', () => {
  const reg = createWorkerRegistry();
  assertThrows(() => reg.register('fast', { type: 'fast' }), 'Invalid worker');
});

test('getWorker throws for unregistered type', () => {
  const reg = createWorkerRegistry();
  assertThrows(() => reg.getWorker('vision'), 'No worker registered');
});

test('hasWorker returns boolean', () => {
  const reg = createWorkerRegistry();
  assertEqual(reg.hasWorker('fast'), false);
  reg.register('fast', makeMockWorker('fast'));
  assertEqual(reg.hasWorker('fast'), true);
});

test('deregister removes worker', () => {
  const reg = createWorkerRegistry();
  reg.register('fast', makeMockWorker('fast'));
  assert(reg.hasWorker('fast'));
  reg.deregister('fast');
  assert(!reg.hasWorker('fast'));
});

test('listWorkers returns all registered types', () => {
  const reg = createWorkerRegistry();
  reg.register('fast', makeMockWorker('fast'));
  reg.register('vision', makeMockWorker('vision'));
  reg.register('agent', makeMockWorker('agent'));
  const list = reg.listWorkers();
  assertEqual(list.length, 3);
  assert(list.includes('fast'));
  assert(list.includes('vision'));
  assert(list.includes('agent'));
});

test('getRegisteredCount', () => {
  const reg = createWorkerRegistry();
  assertEqual(reg.getRegisteredCount(), 0);
  reg.register('fast', makeMockWorker('fast'));
  assertEqual(reg.getRegisteredCount(), 1);
  reg.register('vision', makeMockWorker('vision'));
  assertEqual(reg.getRegisteredCount(), 2);
});

test('getHealthStatus returns all workers health', () => {
  const reg = createWorkerRegistry();
  reg.register('fast', makeMockWorker('fast'));
  reg.register('agent', makeMockWorker('agent'));
  const health = reg.getHealthStatus();
  assertEqual(health.fast.status, WORKER_STATES.HEALTHY);
  assertEqual(health.agent.status, WORKER_STATES.HEALTHY);
});

await test('getAllMetrics returns per-worker metrics', async () => {
  const reg = createWorkerRegistry();
  const fast = makeMockWorker('fast', { cost: 0 });
  const agent = makeMockWorker('agent', { cost: 0.01 });
  reg.register('fast', fast);
  reg.register('agent', agent);

  await fast.execute({});
  await fast.execute({});
  await agent.execute({});

  const metrics = reg.getAllMetrics();
  assertEqual(metrics.fast.calls, 2);
  assertEqual(metrics.agent.calls, 1);
  assertEqual(metrics.agent.totalCost, 0.01);
});

await test('getTotalCost sums across workers', async () => {
  const reg = createWorkerRegistry();
  const fast = makeMockWorker('fast', { cost: 0 });
  const agent = makeMockWorker('agent', { cost: 0.05 });
  reg.register('fast', fast);
  reg.register('agent', agent);

  await fast.execute({});
  await agent.execute({});
  await agent.execute({});

  assertEqual(reg.getTotalCost(), 0.10);
});

// ─── Fallback Chains ────────────────────────────────────────────────────

console.log('\n── Fallback Chains ──');

test('getWorkerWithFallback returns healthy worker', () => {
  const reg = createWorkerRegistry();
  reg.register('fast', makeMockWorker('fast'));
  const { worker, resolvedType, fellBack } = reg.getWorkerWithFallback('fast');
  assertEqual(resolvedType, 'fast');
  assertEqual(fellBack, false);
});

test('getWorkerWithFallback falls back when unhealthy', () => {
  const reg = createWorkerRegistry();
  const local = makeMockWorker('local');
  local.setHealth(WORKER_STATES.UNHEALTHY);
  reg.register('local', local);
  reg.register('fast', makeMockWorker('fast'));

  const { resolvedType, fellBack } = reg.getWorkerWithFallback('local');
  assertEqual(resolvedType, 'fast');
  assertEqual(fellBack, true);
});

test('getWorkerWithFallback allows degraded workers', () => {
  const reg = createWorkerRegistry();
  const agent = makeMockWorker('agent');
  agent.setHealth(WORKER_STATES.DEGRADED);
  reg.register('agent', agent);
  reg.register('fast', makeMockWorker('fast'));

  const { resolvedType } = reg.getWorkerWithFallback('agent');
  assertEqual(resolvedType, 'agent'); // degraded is OK, not unhealthy
});

test('getWorkerWithFallback throws when all unavailable', () => {
  const reg = createWorkerRegistry();
  assertThrows(() => reg.getWorkerWithFallback('vision'), 'No healthy worker');
});

test('getWorkerWithFallback forced when all unhealthy', () => {
  const reg = createWorkerRegistry();
  const vision = makeMockWorker('vision');
  vision.setHealth(WORKER_STATES.UNHEALTHY);
  reg.register('vision', vision);

  const { resolvedType, forced } = reg.getWorkerWithFallback('vision');
  assertEqual(resolvedType, 'vision');
  assertEqual(forced, true);
});

// ─── Shutdown ───────────────────────────────────────────────────────────

console.log('\n── Shutdown ──');

test('shutdown calls worker shutdown and clears', () => {
  const reg = createWorkerRegistry();
  let shutdownCalled = false;
  const w = makeMockWorker('fast');
  w.shutdown = () => { shutdownCalled = true; };
  reg.register('fast', w);

  reg.shutdown();
  assert(shutdownCalled);
  assertEqual(reg.getRegisteredCount(), 0);
});

test('shutdown handles workers without shutdown method', () => {
  const reg = createWorkerRegistry();
  reg.register('fast', makeMockWorker('fast'));
  reg.shutdown(); // should not throw
  assertEqual(reg.getRegisteredCount(), 0);
});

// ─── Summary ────────────────────────────────────────────────────────────

await new Promise(r => setTimeout(r, 100));
console.log(`\n${'─'.repeat(60)}`);
console.log(`WorkerInterface: ${passCount}/${testCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
