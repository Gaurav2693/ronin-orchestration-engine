// ─── observability/dashboard.test.mjs ────────────────────────────────────────
// Test suite for RONIN Cost & Token Dashboard
// Run: node dashboard.test.mjs 2>&1
// ─────────────────────────────────────────────────────────────────────────────

import { createStatsCollector, simulateTaskCost, startDashboard } from './dashboard.mjs';

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

// ─── Stats Collector ────────────────────────────────────────────────────

console.log('\n── StatsCollector ──');

test('creates with zero state', () => {
  const c = createStatsCollector();
  const s = c.getSnapshot();
  assertEqual(s.totalCost, 0);
  assertEqual(s.requestCount, 0);
  assertEqual(s.totalInputTokens, 0);
});

test('records a task', () => {
  const c = createStatsCollector();
  c.recordTask({ model: 'claude-sonnet-4-6', inputTokens: 1000, outputTokens: 500, cost: 0.0105, duration: 800, worker: 'agent' });
  const s = c.getSnapshot();
  assertEqual(s.requestCount, 1);
  assertEqual(s.totalInputTokens, 1000);
  assertEqual(s.totalOutputTokens, 500);
  assert(s.totalCost > 0);
});

test('tracks model usage breakdown', () => {
  const c = createStatsCollector();
  c.recordTask({ model: 'gemini-2.5-flash-lite', inputTokens: 500, outputTokens: 100, cost: 0, worker: 'fast' });
  c.recordTask({ model: 'gemini-2.5-flash-lite', inputTokens: 300, outputTokens: 50, cost: 0, worker: 'fast' });
  c.recordTask({ model: 'claude-sonnet-4-6', inputTokens: 2000, outputTokens: 1000, cost: 0.021, worker: 'agent' });

  const s = c.getSnapshot();
  assertEqual(s.modelUsage['gemini-2.5-flash-lite'].calls, 2);
  assertEqual(s.modelUsage['gemini-2.5-flash-lite'].inputTokens, 800);
  assertEqual(s.modelUsage['claude-sonnet-4-6'].calls, 1);
});

test('tracks worker distribution', () => {
  const c = createStatsCollector();
  c.recordTask({ model: 'x', worker: 'fast', cost: 0 });
  c.recordTask({ model: 'x', worker: 'fast', cost: 0 });
  c.recordTask({ model: 'x', worker: 'vision', cost: 0 });
  c.recordTask({ model: 'x', worker: 'agent', cost: 0.01 });

  const s = c.getSnapshot();
  assertEqual(s.workerDistribution.fast, 2);
  assertEqual(s.workerDistribution.vision, 1);
  assertEqual(s.workerDistribution.agent, 1);
});

test('computes average cost per request', () => {
  const c = createStatsCollector();
  c.recordTask({ model: 'a', cost: 0.01 });
  c.recordTask({ model: 'b', cost: 0.03 });
  const s = c.getSnapshot();
  assertEqual(s.avgCostPerRequest, 0.02);
});

test('computes budget percentage', () => {
  const c = createStatsCollector();
  c.recordTask({ model: 'a', cost: 5.0 });
  const s = c.getSnapshot();
  assertEqual(s.dailyBudgetUsed, 20.0); // 5/25 = 20%
});

test('keeps last 100 tasks (bounded)', () => {
  const c = createStatsCollector();
  for (let i = 0; i < 120; i++) {
    c.recordTask({ model: 'x', cost: 0 });
  }
  assertEqual(c.getSnapshot().recentTasks.length, 20); // snapshot returns last 20
  assertEqual(c.getSnapshot().requestCount, 120);
});

test('reset clears all state', () => {
  const c = createStatsCollector();
  c.recordTask({ model: 'x', cost: 1.0, inputTokens: 500 });
  c.reset();
  const s = c.getSnapshot();
  assertEqual(s.totalCost, 0);
  assertEqual(s.requestCount, 0);
});

test('uptime is formatted', () => {
  const c = createStatsCollector();
  assert(c.getSnapshot().uptime.length > 0);
});

test('records pipeline run', () => {
  const c = createStatsCollector();
  c.recordPipelineRun({});
  c.recordPipelineRun({ error: true });
  assertEqual(c.getSnapshot().pipelineRuns, 2);
  assertEqual(c.getSnapshot().pipelineErrors, 1);
});

test('duration tracked per model', () => {
  const c = createStatsCollector();
  c.recordTask({ model: 'fast-model', cost: 0, duration: 50 });
  c.recordTask({ model: 'fast-model', cost: 0, duration: 150 });
  assertEqual(c.getSnapshot().modelUsage['fast-model'].totalMs, 200);
});

// ─── simulateTaskCost ───────────────────────────────────────────────────

console.log('\n── simulateTaskCost ──');

test('returns breakdown for all models', () => {
  const result = simulateTaskCost('Write a button component', 1000, 500);
  assert(result.breakdown['claude-sonnet-4-6'] !== undefined);
  assert(result.breakdown['gemini-2.5-flash-lite'] !== undefined);
});

test('free models show cost 0', () => {
  const result = simulateTaskCost('test', 1000, 500);
  assertEqual(result.breakdown['gemini-2.5-flash-lite'].totalCost, 0);
  assertEqual(result.breakdown['gemini-2.5-flash-lite'].free, true);
});

test('paid models show actual cost', () => {
  const result = simulateTaskCost('test', 1000, 500);
  assert(result.breakdown['claude-sonnet-4-6'].totalCost > 0);
  assertEqual(result.breakdown['claude-sonnet-4-6'].free, false);
});

test('includes input and output cost separately', () => {
  const result = simulateTaskCost('test', 1000000, 500000);
  const sonnet = result.breakdown['claude-sonnet-4-6'];
  assertEqual(sonnet.inputCost, 3.0);   // 1M * $3/MTok
  assertEqual(sonnet.outputCost, 7.5);  // 500K * $15/MTok
});

// ─── Dashboard Server ───────────────────────────────────────────────────

console.log('\n── Dashboard Server ──');

await test('starts and serves HTML', async () => {
  const { server, collector } = startDashboard({ port: 0 }); // random port
  const addr = server.address();

  const res = await fetch(`http://localhost:${addr.port}/`);
  assertEqual(res.status, 200);
  const html = await res.text();
  assert(html.includes('RONIN'));
  assert(html.includes('COST WINDOW'));

  server.close();
});

await test('serves /api/stats', async () => {
  const collector = createStatsCollector();
  collector.recordTask({ model: 'test-model', cost: 0.005, inputTokens: 100, outputTokens: 50, worker: 'fast' });

  const { server } = startDashboard({ port: 0, collector });
  const addr = server.address();

  const res = await fetch(`http://localhost:${addr.port}/api/stats`);
  const data = await res.json();
  assertEqual(data.requestCount, 1);
  assertEqual(data.totalInputTokens, 100);

  server.close();
});

await test('serves /api/models', async () => {
  const { server } = startDashboard({ port: 0 });
  const addr = server.address();

  const res = await fetch(`http://localhost:${addr.port}/api/models`);
  const data = await res.json();
  assert(data.models['claude-sonnet-4-6'] !== undefined);
  assert(data.rateLimits !== undefined);

  server.close();
});

await test('POST /api/simulate works', async () => {
  const { server } = startDashboard({ port: 0 });
  const addr = server.address();

  const res = await fetch(`http://localhost:${addr.port}/api/simulate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task: 'Build a component', inputTokens: 2000, outputTokens: 1000 }),
  });
  const data = await res.json();
  assert(data.breakdown !== undefined);
  assert(data.breakdown['claude-sonnet-4-6'].totalCost > 0);

  server.close();
});

await test('POST /api/reset clears stats', async () => {
  const collector = createStatsCollector();
  collector.recordTask({ model: 'x', cost: 1.0 });

  const { server } = startDashboard({ port: 0, collector });
  const addr = server.address();

  await fetch(`http://localhost:${addr.port}/api/reset`, { method: 'POST' });
  const res = await fetch(`http://localhost:${addr.port}/api/stats`);
  const data = await res.json();
  assertEqual(data.totalCost, 0);

  server.close();
});

await test('404 for unknown routes', async () => {
  const { server } = startDashboard({ port: 0 });
  await new Promise(r => setTimeout(r, 50)); // wait for listen
  const addr = server.address();

  const res = await fetch(`http://localhost:${addr.port}/nope`);
  assertEqual(res.status, 404);

  server.close();
});

// ─── Summary ─────────────────────────────────────────────────────────────

await new Promise(r => setTimeout(r, 100));
console.log(`\n${'─'.repeat(60)}`);
console.log(`Dashboard: ${passCount}/${testCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
