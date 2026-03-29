// test/durableBuild.test.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Tests for Gate 07: Durable Build Pipeline
// ─────────────────────────────────────────────────────────────────────────────

import {
  BUILD_STAGES,
  createCheckpoint,
  InMemoryCheckpointStore,
  createBuildPipeline,
  createDefaultPipeline,
  getDefaultCheckpointStore,
} from '../gates/durableBuild.mjs';

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

const SAMPLE_ARTIFACTS = { 'src/App.tsx': 'export function App() {}' };

console.log('\n─── durableBuild.test.mjs ───────────────────────────────\n');

// ─── BUILD_STAGES ─────────────────────────────────────────────────────────────

console.log('BUILD_STAGES:');

await testAsync('all stages defined', async () => {
  assert(BUILD_STAGES.INIT,    'INIT');
  assert(BUILD_STAGES.PREPARE, 'PREPARE');
  assert(BUILD_STAGES.COMPILE, 'COMPILE');
  assert(BUILD_STAGES.BUNDLE,  'BUNDLE');
  assert(BUILD_STAGES.TEST,    'TEST');
  assert(BUILD_STAGES.PACKAGE, 'PACKAGE');
  assert(BUILD_STAGES.DONE,    'DONE');
  assert(BUILD_STAGES.FAILED,  'FAILED');
});

// ─── InMemoryCheckpointStore ──────────────────────────────────────────────────

console.log('\nInMemoryCheckpointStore:');

await testAsync('save assigns an id and returns it', async () => {
  const store = new InMemoryCheckpointStore();
  const ckpt  = createCheckpoint({ artifacts: {}, context: {} });
  const id    = await store.save(ckpt);
  assert(id, 'id should be truthy');
  assert(typeof id === 'string', 'id should be string');
});

await testAsync('load returns saved checkpoint', async () => {
  const store = new InMemoryCheckpointStore();
  const ckpt  = createCheckpoint({ stage: BUILD_STAGES.COMPILE });
  const id    = await store.save(ckpt);
  const loaded = await store.load(id);
  assert(loaded, 'should load checkpoint');
  assertEqual(loaded.stage, BUILD_STAGES.COMPILE, 'stage preserved');
});

await testAsync('load returns null for unknown id', async () => {
  const store = new InMemoryCheckpointStore();
  const result = await store.load('nonexistent');
  assertEqual(result, null, 'should return null');
});

await testAsync('delete removes checkpoint', async () => {
  const store = new InMemoryCheckpointStore();
  const id    = await store.save(createCheckpoint({}));
  await store.delete(id);
  assertEqual(await store.load(id), null, 'should be gone');
});

await testAsync('list returns all checkpoints', async () => {
  const store = new InMemoryCheckpointStore();
  await store.save(createCheckpoint({ stage: BUILD_STAGES.INIT }));
  await store.save(createCheckpoint({ stage: BUILD_STAGES.COMPILE }));
  const list = await store.list();
  assertEqual(list.length, 2, 'should list 2 checkpoints');
});

await testAsync('size property counts saved checkpoints', async () => {
  const store = new InMemoryCheckpointStore();
  assertEqual(store.size, 0, 'starts at 0');
  await store.save(createCheckpoint({}));
  assertEqual(store.size, 1, 'after save: 1');
});

// ─── createCheckpoint ─────────────────────────────────────────────────────────

console.log('\ncreateCheckpoint:');

await testAsync('creates checkpoint with defaults', async () => {
  const ckpt = createCheckpoint();
  assertEqual(ckpt.stage, BUILD_STAGES.INIT, 'default stage');
  assert(Array.isArray(ckpt.completedStages), 'completedStages is array');
  assert(typeof ckpt.artifacts === 'object', 'artifacts is object');
  assert(ckpt.createdAt, 'createdAt set');
});

// ─── createBuildPipeline ──────────────────────────────────────────────────────

console.log('\ncreateBuildPipeline:');

await testAsync('successful build returns passed: true', async () => {
  const store    = new InMemoryCheckpointStore();
  const pipeline = createBuildPipeline({}, store);
  const result   = await pipeline.run(SAMPLE_ARTIFACTS, {});
  assert(result.passed, 'should pass');
  assertEqual(result.stage, BUILD_STAGES.DONE, 'stage should be DONE');
});

await testAsync('checkpointId is returned', async () => {
  const store    = new InMemoryCheckpointStore();
  const pipeline = createBuildPipeline({}, store);
  const result   = await pipeline.run(SAMPLE_ARTIFACTS, {});
  assert(result.checkpointId, 'checkpointId should be set');
});

await testAsync('stage handlers are called in order', async () => {
  const callOrder = [];
  const handlers  = {
    [BUILD_STAGES.INIT]:    async (a) => { callOrder.push('init');    return { artifacts: a }; },
    [BUILD_STAGES.PREPARE]: async (a) => { callOrder.push('prepare'); return { artifacts: a }; },
    [BUILD_STAGES.COMPILE]: async (a) => { callOrder.push('compile'); return { artifacts: a }; },
  };
  const store    = new InMemoryCheckpointStore();
  const pipeline = createBuildPipeline(handlers, store);
  await pipeline.run(SAMPLE_ARTIFACTS, {});
  assert(callOrder.indexOf('init') < callOrder.indexOf('prepare'), 'init before prepare');
  assert(callOrder.indexOf('prepare') < callOrder.indexOf('compile'), 'prepare before compile');
});

await testAsync('failed stage sets passed: false', async () => {
  const store = new InMemoryCheckpointStore();
  const pipeline = createBuildPipeline({
    [BUILD_STAGES.COMPILE]: async () => { throw new Error('compile error'); },
  }, store);
  const result = await pipeline.run(SAMPLE_ARTIFACTS, {});
  assert(!result.passed, 'should not pass');
  assertEqual(result.stage, BUILD_STAGES.COMPILE, 'failed at compile');
  assert(result.error?.includes('compile error'), 'error message preserved');
});

await testAsync('checkpoint saved on failure for resume', async () => {
  const store    = new InMemoryCheckpointStore();
  const pipeline = createBuildPipeline({
    [BUILD_STAGES.BUNDLE]: async () => { throw new Error('bundle failed'); },
  }, store);
  const result   = await pipeline.run(SAMPLE_ARTIFACTS, {});
  assert(!result.passed, 'should fail');
  assert(result.checkpointId, 'checkpointId should be set for resume');
  const stored = await store.load(result.checkpointId);
  assertEqual(stored.stage, BUILD_STAGES.FAILED, 'stored as FAILED');
});

await testAsync('resume from checkpoint resumes at failed stage', async () => {
  const store      = new InMemoryCheckpointStore();
  let bundleCalls  = 0;
  let compileCalls = 0;

  const pipeline = createBuildPipeline({
    [BUILD_STAGES.COMPILE]: async (a) => { compileCalls++; return { artifacts: a }; },
    [BUILD_STAGES.BUNDLE]:  async (a) => {
      bundleCalls++;
      if (bundleCalls === 1) throw new Error('first attempt fails');
      return { artifacts: a };
    },
  }, store);

  const failResult = await pipeline.run(SAMPLE_ARTIFACTS, {});
  assert(!failResult.passed, 'first run fails');
  assertEqual(bundleCalls, 1, 'bundle called once');

  // Resume
  const resumeResult = await pipeline.resume(failResult.checkpointId);
  assert(resumeResult.passed, 'resume should succeed');
  // compile should NOT be re-run (it was already done)
  assertEqual(compileCalls, 1, 'compile should not be re-run on resume');
});

await testAsync('resume throws if checkpointId not found', async () => {
  const pipeline = createBuildPipeline({}, new InMemoryCheckpointStore());
  try {
    await pipeline.resume('nonexistent_id');
    assert(false, 'Should have thrown');
  } catch (err) {
    assert(err.message.includes('not found'));
  }
});

await testAsync('stage output is accumulated in stageOutputs', async () => {
  const store    = new InMemoryCheckpointStore();
  const pipeline = createBuildPipeline({
    [BUILD_STAGES.COMPILE]: async (a) => ({ artifacts: a, output: { compiled: true } }),
  }, store);
  const result   = await pipeline.run(SAMPLE_ARTIFACTS, {});
  assert(result.stageOutputs[BUILD_STAGES.COMPILE], 'compile output stored');
  assertEqual(result.stageOutputs[BUILD_STAGES.COMPILE].compiled, true, 'compile output value');
});

await testAsync('artifacts flow through stages (later stage receives updated artifacts)', async () => {
  const store    = new InMemoryCheckpointStore();
  let receivedArtifacts = null;
  const pipeline = createBuildPipeline({
    [BUILD_STAGES.INIT]:    async () => ({ artifacts: { 'out/bundle.js': 'compiled!' } }),
    [BUILD_STAGES.PREPARE]: async (a) => { receivedArtifacts = a; return { artifacts: a }; },
  }, store);
  await pipeline.run(SAMPLE_ARTIFACTS, {});
  assert(receivedArtifacts?.['out/bundle.js'], 'prepare should receive artifacts from init');
});

await testAsync('meta.resumable is true on failure', async () => {
  const store    = new InMemoryCheckpointStore();
  const pipeline = createBuildPipeline({
    [BUILD_STAGES.TEST]: async () => { throw new Error('test fail'); },
  }, store);
  const result = await pipeline.run(SAMPLE_ARTIFACTS, {});
  assert(result.meta.resumable, 'should be resumable');
});

// ─── createDefaultPipeline ────────────────────────────────────────────────────

console.log('\ncreateDefaultPipeline:');

await testAsync('default pipeline passes with no-op handlers', async () => {
  const store    = new InMemoryCheckpointStore();
  const pipeline = createDefaultPipeline({}, store);
  const result   = await pipeline.run(SAMPLE_ARTIFACTS, {});
  assert(result.passed, 'default pipeline should pass');
});

await testAsync('accepts handler overrides', async () => {
  let customCalled = false;
  const store    = new InMemoryCheckpointStore();
  const pipeline = createDefaultPipeline({
    [BUILD_STAGES.BUNDLE]: async (a) => { customCalled = true; return { artifacts: a }; },
  }, store);
  await pipeline.run(SAMPLE_ARTIFACTS, {});
  assert(customCalled, 'custom bundle handler should be called');
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n─── Results: ${passed} passed, ${failed} failed ───\n`);
process.exit(failed > 0 ? 1 : 0);
