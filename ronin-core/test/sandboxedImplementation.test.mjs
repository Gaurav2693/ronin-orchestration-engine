// test/sandboxedImplementation.test.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Tests for Gate 05: Sandboxed Parallel Implementation
// ─────────────────────────────────────────────────────────────────────────────

import {
  TASK_TYPES,
  decomposeToManifest,
  resolveExecutionOrder,
  executeManifest,
} from '../gates/sandboxedImplementation.mjs';

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

function assert(cond, msg)      { if (!cond) throw new Error(msg || 'Assertion failed'); }
function assertEqual(a, b, msg) { if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

// ─── Mock Codex worker ────────────────────────────────────────────────────────

function makeCodexWorker(options = {}) {
  let callCount = 0;
  const failSet = new Set(options.failTasks || []);

  return {
    get callCount() { return callCount; },
    async execute(payload) {
      callCount++;
      const taskId = payload.task?.id || 'unknown';
      if (failSet.has(taskId)) throw new Error(`Task ${taskId} execution failed`);
      return {
        result: `\`\`\`tsx // src/components/${taskId}.tsx\nexport function ${taskId}() { return null; }\n\`\`\``,
        files:  {},
        cost:   0.001,
        tokens: 100,
      };
    },
  };
}

function makeSandboxManager(options = {}) {
  let sandboxCount = 0;
  return {
    get sandboxCount() { return sandboxCount; },
    async createSandbox(taskId) {
      sandboxCount++;
      return `sandbox_${taskId}_${sandboxCount}`;
    },
    async destroySandbox(id) {
      // no-op
    },
  };
}

const SAMPLE_PLAN = {
  domain: 'react',
  dependencies: [{ name: 'react', version: '^18', reason: 'core' }],
  acceptanceCriteria: ['renders without errors'],
  taskManifest: [
    { id: 'T1', description: 'Create Button', type: TASK_TYPES.COMPONENT, files: ['src/Button.tsx'], critical: true },
    { id: 'T2', description: 'Create Card',   type: TASK_TYPES.COMPONENT, files: ['src/Card.tsx'],   critical: true,  dependencies: ['T1'] },
    { id: 'T3', description: 'Write tests',   type: TASK_TYPES.TEST,      files: ['src/Button.test.tsx'], critical: false, dependencies: ['T1'] },
  ],
};

console.log('\n─── sandboxedImplementation.test.mjs ───────────────────\n');

// ─── TASK_TYPES ───────────────────────────────────────────────────────────────

console.log('TASK_TYPES:');

await testAsync('all task types are defined', async () => {
  assert(TASK_TYPES.COMPONENT,   'COMPONENT');
  assert(TASK_TYPES.UTILITY,     'UTILITY');
  assert(TASK_TYPES.TEST,        'TEST');
  assert(TASK_TYPES.CONFIG,      'CONFIG');
  assert(TASK_TYPES.STYLE,       'STYLE');
  assert(TASK_TYPES.INTEGRATION, 'INTEGRATION');
});

// ─── decomposeToManifest ──────────────────────────────────────────────────────

console.log('\ndecomposeToManifest:');

await testAsync('throws if plan has no taskManifest', async () => {
  try {
    decomposeToManifest({});
    assert(false, 'Should have thrown');
  } catch (err) {
    assert(err.message.includes('taskManifest'));
  }
});

await testAsync('throws if taskManifest is empty', async () => {
  try {
    decomposeToManifest({ taskManifest: [] });
    assert(false, 'Should have thrown');
  } catch (err) {
    assert(err.message.includes('non-empty'));
  }
});

await testAsync('normalizes tasks with defaults', async () => {
  const manifest = decomposeToManifest(SAMPLE_PLAN);
  assertEqual(manifest.length, 3, 'should have 3 tasks');
  for (const task of manifest) {
    assert(task.id, 'task.id');
    assert(task.description, 'task.description');
    assert(task.type, 'task.type');
    assert(Array.isArray(task.files), 'task.files is array');
    assert(Array.isArray(task.dependencies), 'task.dependencies is array');
    assertEqual(task.status, 'pending', 'initial status is pending');
    assertEqual(task.result, null, 'initial result is null');
  }
});

await testAsync('auto-generates id if missing', async () => {
  const plan     = { taskManifest: [{ description: 'no id task', type: 'component' }] };
  const manifest = decomposeToManifest(plan);
  assert(manifest[0].id, 'should generate an id');
  assert(manifest[0].id.startsWith('T'), 'id should start with T');
});

await testAsync('default critical is true', async () => {
  const plan     = { taskManifest: [{ id: 'T1', description: 'task' }] };
  const manifest = decomposeToManifest(plan);
  assertEqual(manifest[0].critical, true, 'critical defaults to true');
});

await testAsync('critical: false is respected', async () => {
  const plan     = { taskManifest: [{ id: 'T1', description: 'task', critical: false }] };
  const manifest = decomposeToManifest(plan);
  assertEqual(manifest[0].critical, false, 'critical: false');
});

// ─── resolveExecutionOrder ────────────────────────────────────────────────────

console.log('\nresolveExecutionOrder:');

await testAsync('tasks with no deps are in level 0', async () => {
  const manifest = decomposeToManifest(SAMPLE_PLAN);
  const levels   = resolveExecutionOrder(manifest);
  assert(levels[0].includes('T1'), 'T1 should be in level 0');
});

await testAsync('tasks with deps are in later levels', async () => {
  const manifest = decomposeToManifest(SAMPLE_PLAN);
  const levels   = resolveExecutionOrder(manifest);
  // T2 and T3 depend on T1 — should be in level 1
  assert(!levels[0].includes('T2'), 'T2 should NOT be in level 0');
  assert(levels[1]?.includes('T2') || levels.some(l => l.includes('T2')), 'T2 in later level');
});

await testAsync('independent tasks are in the same level', async () => {
  const manifest = decomposeToManifest(SAMPLE_PLAN);
  const levels   = resolveExecutionOrder(manifest);
  // T2 and T3 both depend only on T1 — should be in the same level
  const t2Level  = levels.findIndex(l => l.includes('T2'));
  const t3Level  = levels.findIndex(l => l.includes('T3'));
  assertEqual(t2Level, t3Level, 'T2 and T3 should be in the same level');
});

await testAsync('handles circular dependencies gracefully (no infinite loop)', async () => {
  const plan = {
    taskManifest: [
      { id: 'A', description: 'A', dependencies: ['B'] },
      { id: 'B', description: 'B', dependencies: ['A'] },
    ],
  };
  const manifest = decomposeToManifest(plan);
  const levels   = resolveExecutionOrder(manifest);  // Should not hang
  assert(levels.length > 0, 'should still return levels');
  assert(levels.some(l => l.includes('A') || l.includes('B')), 'A and B placed');
});

await testAsync('single task returns one level', async () => {
  const manifest = decomposeToManifest({ taskManifest: [{ id: 'T1', description: 'solo' }] });
  const levels   = resolveExecutionOrder(manifest);
  assertEqual(levels.length, 1, 'single task = single level');
  assertEqual(levels[0][0], 'T1', 'T1 in level 0');
});

// ─── executeManifest ──────────────────────────────────────────────────────────

console.log('\nexecuteManifest:');

await testAsync('throws if manifest is empty', async () => {
  const worker = makeCodexWorker();
  try {
    await executeManifest([], worker, null, SAMPLE_PLAN);
    assert(false, 'Should have thrown');
  } catch (err) {
    assert(err.message.includes('manifest'));
  }
});

await testAsync('throws if codexWorker has no execute()', async () => {
  const manifest = decomposeToManifest(SAMPLE_PLAN);
  try {
    await executeManifest(manifest, {}, null, SAMPLE_PLAN);
    assert(false, 'Should have thrown');
  } catch (err) {
    assert(err.message.includes('execute'));
  }
});

await testAsync('executes all tasks and returns results', async () => {
  const manifest = decomposeToManifest(SAMPLE_PLAN);
  const worker   = makeCodexWorker();
  const result   = await executeManifest(manifest, worker, null, SAMPLE_PLAN);
  assertEqual(result.results.length, 3, 'should have 3 results');
});

await testAsync('qualityReport.passed is true when all critical tasks succeed', async () => {
  const manifest = decomposeToManifest(SAMPLE_PLAN);
  const worker   = makeCodexWorker();
  const result   = await executeManifest(manifest, worker, null, SAMPLE_PLAN);
  assert(result.qualityReport.passed, 'qualityReport should pass');
});

await testAsync('returns mergedOutput files', async () => {
  const manifest = decomposeToManifest(SAMPLE_PLAN);
  const worker   = makeCodexWorker();
  const result   = await executeManifest(manifest, worker, null, SAMPLE_PLAN);
  assert(typeof result.mergedOutput === 'object', 'mergedOutput should be object');
});

await testAsync('returns meta with cost, duration, tasks', async () => {
  const manifest = decomposeToManifest(SAMPLE_PLAN);
  const worker   = makeCodexWorker();
  const result   = await executeManifest(manifest, worker, null, SAMPLE_PLAN);
  assert(result.meta, 'meta exists');
  assert(typeof result.meta.totalCost === 'number', 'totalCost');
  assert(typeof result.meta.totalDuration === 'number', 'totalDuration');
  assert(result.meta.tasksExecuted > 0, 'tasksExecuted > 0');
});

await testAsync('stops on critical task failure by default', async () => {
  const manifest = decomposeToManifest(SAMPLE_PLAN);
  const worker   = makeCodexWorker({ failTasks: ['T1'] });   // T1 is critical
  const result   = await executeManifest(manifest, worker, null, SAMPLE_PLAN);
  // T2 depends on T1 and is critical — should not execute
  const t2Result = result.results.find(r => r.id === 'T2');
  assert(!t2Result || t2Result.status !== 'completed', 'T2 should not complete if T1 critical failure stopped pipeline');
  assert(!result.qualityReport.passed, 'qualityReport should fail');
});

await testAsync('continueOnFailure: true runs all tasks despite failure', async () => {
  // Make T3 fail (non-critical) and continue
  const plan2 = {
    ...SAMPLE_PLAN,
    taskManifest: [
      { id: 'T1', description: 'Create Button', type: TASK_TYPES.COMPONENT, critical: false },
      { id: 'T2', description: 'Create Card',   type: TASK_TYPES.COMPONENT, critical: false },
    ],
  };
  const manifest = decomposeToManifest(plan2);
  const worker   = makeCodexWorker({ failTasks: ['T1'] });
  const result   = await executeManifest(manifest, worker, null, plan2, { continueOnFailure: true });
  assertEqual(result.results.length, 2, 'both tasks attempted');
});

await testAsync('creates sandbox per task when sandboxManager provided', async () => {
  const manifest = decomposeToManifest(SAMPLE_PLAN);
  const worker   = makeCodexWorker();
  const sandbox  = makeSandboxManager();
  await executeManifest(manifest, worker, sandbox, SAMPLE_PLAN);
  assert(sandbox.sandboxCount >= 1, 'sandbox should have been created');
});

await testAsync('meta.parallelLevels matches execution level count', async () => {
  const manifest = decomposeToManifest(SAMPLE_PLAN);
  const worker   = makeCodexWorker();
  const result   = await executeManifest(manifest, worker, null, SAMPLE_PLAN);
  // T1 alone in level 0, T2+T3 in level 1 = 2 levels
  assertEqual(result.meta.parallelLevels, 2, 'should have 2 parallel levels');
});

// ─── File extraction from code blocks ────────────────────────────────────────

console.log('\nFile extraction:');

await testAsync('extracts files from ```lang // path code blocks', async () => {
  const rawWorker = {
    async execute() {
      return {
        result: '```tsx // src/Button.tsx\nexport const Button = () => null;\n```',
        cost: 0,
      };
    },
  };
  const manifest = decomposeToManifest({ taskManifest: [{ id: 'T1', description: 'create button' }] });
  const result   = await executeManifest(manifest, rawWorker, null, {});
  const t1Result = result.results[0];
  assert(t1Result.files['src/Button.tsx'], 'should extract file from code block');
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n─── Results: ${passed} passed, ${failed} failed ───\n`);
process.exit(failed > 0 ? 1 : 0);
