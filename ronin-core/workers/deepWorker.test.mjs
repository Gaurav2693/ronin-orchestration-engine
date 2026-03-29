// ─── workers/deepWorker.test.mjs ──────────────────────────────────────────────
// Tests for RONIN Deep Worker (W7)
// Run: node deepWorker.test.mjs 2>&1
// ─────────────────────────────────────────────────────────────────────────────

import { createDeepWorker, createJobStore, buildDeepMessages, JOB_STATES } from './deepWorker.mjs';
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

function mockProvider(response = 'Deep analysis complete.', delayMs = 10) {
  const calls = [];
  return {
    calls,
    complete: async (messages, opts) => {
      calls.push({ messages, opts });
      await new Promise(r => setTimeout(r, delayMs));
      return {
        content: response,
        usage: { inputTokens: 2000, outputTokens: 1500 },
      };
    },
  };
}

function failingProvider(error = 'API error') {
  return {
    complete: async () => { throw new Error(error); },
  };
}

function slowProvider(delayMs) {
  return {
    complete: async () => {
      await new Promise(r => setTimeout(r, delayMs));
      return { content: 'Late response', usage: { inputTokens: 100, outputTokens: 50 } };
    },
  };
}

// ─── createJobStore ─────────────────────────────────────────────────────

console.log('\n── createJobStore ──');

test('creates empty store', () => {
  const store = createJobStore();
  assertEqual(store.getActiveCount(), 0);
});

test('createJob adds job', () => {
  const store = createJobStore();
  const job = store.createJob('j1', { message: 'test' }, {});
  assertEqual(job.id, 'j1');
  assertEqual(job.state, JOB_STATES.QUEUED);
  assert(job.createdAt > 0);
});

test('getJob retrieves job', () => {
  const store = createJobStore();
  store.createJob('j1', {}, {});
  const job = store.getJob('j1');
  assertEqual(job.id, 'j1');
});

test('getJob returns null for unknown', () => {
  const store = createJobStore();
  assertEqual(store.getJob('nope'), null);
});

test('updateJob modifies job', () => {
  const store = createJobStore();
  store.createJob('j1', {}, {});
  store.updateJob('j1', { state: JOB_STATES.RUNNING, progress: 50 });
  const job = store.getJob('j1');
  assertEqual(job.state, JOB_STATES.RUNNING);
  assertEqual(job.progress, 50);
});

test('updateJob throws for unknown job', () => {
  const store = createJobStore();
  let threw = false;
  try { store.updateJob('nope', {}); } catch { threw = true; }
  assert(threw);
});

test('listJobs returns all jobs sorted by creation', () => {
  const store = createJobStore();
  store.createJob('j1', {}, {});
  store.createJob('j2', {}, {});
  store.createJob('j3', {}, {});
  const jobs = store.listJobs();
  assertEqual(jobs.length, 3);
});

test('listJobs filters by state', () => {
  const store = createJobStore();
  store.createJob('j1', {}, {});
  store.createJob('j2', {}, {});
  store.updateJob('j1', { state: JOB_STATES.COMPLETED });
  const completed = store.listJobs({ state: JOB_STATES.COMPLETED });
  assertEqual(completed.length, 1);
  assertEqual(completed[0].id, 'j1');
});

test('deleteJob removes job', () => {
  const store = createJobStore();
  store.createJob('j1', {}, {});
  store.deleteJob('j1');
  assertEqual(store.getJob('j1'), null);
});

test('getActiveCount counts queued + running', () => {
  const store = createJobStore();
  store.createJob('j1', {}, {}); // queued
  store.createJob('j2', {}, {}); // queued
  store.updateJob('j1', { state: JOB_STATES.RUNNING });
  assertEqual(store.getActiveCount(), 2);
  store.updateJob('j2', { state: JOB_STATES.COMPLETED });
  assertEqual(store.getActiveCount(), 1);
});

test('clear removes all jobs', () => {
  const store = createJobStore();
  store.createJob('j1', {}, {});
  store.createJob('j2', {}, {});
  store.clear();
  assertEqual(store.listJobs().length, 0);
});

// ─── JOB_STATES ─────────────────────────────────────────────────────────

console.log('\n── JOB_STATES ──');

test('has all 5 states', () => {
  assertEqual(Object.keys(JOB_STATES).length, 5);
  assert(JOB_STATES.QUEUED === 'queued');
  assert(JOB_STATES.RUNNING === 'running');
  assert(JOB_STATES.COMPLETED === 'completed');
  assert(JOB_STATES.FAILED === 'failed');
  assert(JOB_STATES.TIMED_OUT === 'timed_out');
});

// ─── createDeepWorker ───────────────────────────────────────────────────

console.log('\n── createDeepWorker ──');

test('creates worker with type deep', () => {
  const w = createDeepWorker(mockProvider(), createJobStore());
  assertEqual(w.type, 'deep');
});

await test('returns job immediately (non-blocking)', async () => {
  const provider = mockProvider('analysis', 50);
  const store = createJobStore();
  const w = createDeepWorker(provider, store);

  const start = Date.now();
  const result = await w.execute({ message: 'Analyze the architecture' });
  const elapsed = Date.now() - start;

  assert(result.async === true);
  assert(result.jobId !== undefined);
  assertEqual(result.state, JOB_STATES.RUNNING);
  assert(result.estimatedMs > 0);
  assert(elapsed < 40, `Should return immediately, took ${elapsed}ms`);
});

await test('job completes in background', async () => {
  const provider = mockProvider('Deep result', 20);
  const store = createJobStore();
  const w = createDeepWorker(provider, store);

  const result = await w.execute({ message: 'Analyze' });

  // Wait for async job to complete
  await new Promise(r => setTimeout(r, 100));

  const poll = w.pollJob(result.jobId);
  assertEqual(poll.state, JOB_STATES.COMPLETED);
  assertEqual(poll.result, 'Deep result');
  assert(poll.cost > 0);
});

await test('uses correct model', async () => {
  const provider = mockProvider('ok', 5);
  const store = createJobStore();
  const w = createDeepWorker(provider, store);
  await w.execute({ message: 'test' });

  await new Promise(r => setTimeout(r, 50));
  assertEqual(provider.calls[0].opts.model, 'o3-mini');
});

await test('respects custom model', async () => {
  const provider = mockProvider('ok', 5);
  const store = createJobStore();
  const w = createDeepWorker(provider, store, { model: 'gpt-5.2-thinking' });
  await w.execute({ message: 'test' });

  await new Promise(r => setTimeout(r, 50));
  assertEqual(provider.calls[0].opts.model, 'gpt-5.2-thinking');
});

await test('handles provider failure', async () => {
  const store = createJobStore();
  const w = createDeepWorker(failingProvider('API down'), store);

  const result = await w.execute({ message: 'test' });
  await new Promise(r => setTimeout(r, 50));

  const poll = w.pollJob(result.jobId);
  assertEqual(poll.state, JOB_STATES.FAILED);
  assert(poll.error.includes('API down'));
});

await test('handles timeout', async () => {
  const store = createJobStore();
  const w = createDeepWorker(slowProvider(200), store, { timeoutMs: 50 });

  const result = await w.execute({ message: 'test' });
  await new Promise(r => setTimeout(r, 150));

  const poll = w.pollJob(result.jobId);
  assertEqual(poll.state, JOB_STATES.TIMED_OUT);
});

await test('respects concurrency limit', async () => {
  const store = createJobStore();
  const w = createDeepWorker(mockProvider('ok', 100), store, { maxConcurrentJobs: 2 });

  await w.execute({ message: 'job1' });
  await w.execute({ message: 'job2' });
  const result3 = await w.execute({ message: 'job3' });

  // Third job should be queued, not running
  assertEqual(result3.state, JOB_STATES.QUEUED);
  assert(result3.message.includes('ahead'));

  await new Promise(r => setTimeout(r, 200));
  store.clear();
});

await test('calls onJobComplete callback', async () => {
  let completedJob = null;
  const store = createJobStore();
  const w = createDeepWorker(mockProvider('analysis', 10), store, {
    onJobComplete: (job) => { completedJob = job; },
  });

  await w.execute({ message: 'test' });
  await new Promise(r => setTimeout(r, 100));

  assert(completedJob !== null, 'Callback was not called');
  assertEqual(completedJob.state, JOB_STATES.COMPLETED);
  assertEqual(completedJob.result, 'analysis');
});

// ─── pollJob / listJobs ─────────────────────────────────────────────────

console.log('\n── pollJob / listJobs ──');

await test('pollJob returns null for unknown', async () => {
  const w = createDeepWorker(mockProvider(), createJobStore());
  assertEqual(w.pollJob('nope'), null);
});

await test('pollJob returns progress', async () => {
  const store = createJobStore();
  const w = createDeepWorker(mockProvider('ok', 50), store);

  const result = await w.execute({ message: 'test' });
  await new Promise(r => setTimeout(r, 10));

  const poll = w.pollJob(result.jobId);
  assert(poll.state === JOB_STATES.RUNNING || poll.state === JOB_STATES.COMPLETED);
  assert(poll.elapsed >= 0);
});

await test('listJobs returns jobs', async () => {
  const store = createJobStore();
  const w = createDeepWorker(mockProvider('ok', 5), store);

  await w.execute({ message: 'a' });
  await w.execute({ message: 'b' });

  const jobs = w.listJobs();
  assertEqual(jobs.length, 2);
  await new Promise(r => setTimeout(r, 50));
});

// ─── buildDeepMessages ──────────────────────────────────────────────────

console.log('\n── buildDeepMessages ──');

test('includes system prompt', () => {
  const msgs = buildDeepMessages({ message: 'analyze' }, {}, 'Think deeply.');
  assertEqual(msgs[0].role, 'system');
  assertEqual(msgs[0].content, 'Think deeply.');
});

test('includes taste block', () => {
  const msgs = buildDeepMessages({ message: 'test' }, { taste_block: 'Prefers thorough.' }, 'sys');
  assert(msgs.some(m => m.content === 'Prefers thorough.'));
});

test('includes last 20 history messages (10 turns)', () => {
  const history = Array.from({ length: 24 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `msg-${i}`,
  }));
  const msgs = buildDeepMessages({ message: 'now' }, { history }, 'sys');
  assert(!msgs.some(m => m.content === 'msg-0'));
  assert(msgs.some(m => m.content === 'msg-4'));
  assert(msgs.some(m => m.content === 'msg-23'));
});

test('handles string task', () => {
  const msgs = buildDeepMessages('deep question', {}, 'sys');
  assert(msgs.some(m => m.role === 'user' && m.content === 'deep question'));
});

// ─── Metrics ────────────────────────────────────────────────────────────

console.log('\n── Metrics ──');

await test('tracks calls', async () => {
  const w = createDeepWorker(mockProvider('ok', 5), createJobStore());
  await w.execute({ message: 'a' });
  await w.execute({ message: 'b' });
  assertEqual(w.getMetrics().calls, 2);
});

await test('health stays healthy', async () => {
  const w = createDeepWorker(mockProvider('ok', 5), createJobStore());
  await w.execute({ message: 'test' });
  assertEqual(w.getHealth().status, WORKER_STATES.HEALTHY);
});

// ─── Summary ────────────────────────────────────────────────────────────

await new Promise(r => setTimeout(r, 300));
console.log(`\n${'─'.repeat(60)}`);
console.log(`DeepWorker: ${passCount}/${testCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
