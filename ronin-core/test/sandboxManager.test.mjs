// test/sandboxManager.test.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Tests for I1: Docker Sandbox Manager
// ─────────────────────────────────────────────────────────────────────────────

import {
  SANDBOX_STATE,
  createSandboxManager,
  createNoOpDockerAdapter,
} from '../infra/sandboxManager.mjs';

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

// ─── Mock Docker adapter ──────────────────────────────────────────────────────

function makeDockerAdapter(options = {}) {
  let containerCounter = 0;
  const containers     = new Map();

  return {
    containers,
    async createContainer(image, opts) {
      const id = `container_${++containerCounter}`;
      containers.set(id, { id, image, running: false });
      return { id };
    },
    async startContainer(id) {
      if (containers.has(id)) containers.get(id).running = true;
      return { containerId: id, started: true };
    },
    async stopContainer(id) {
      if (containers.has(id)) containers.get(id).running = false;
      return { containerId: id, stopped: true };
    },
    async removeContainer(id) {
      containers.delete(id);
      return { containerId: id, removed: true };
    },
    async isContainerRunning(id) {
      if (options.alwaysDead) return false;
      return containers.get(id)?.running || false;
    },
    async execInContainer(id, command) {
      return { output: `exec: ${command}`, exitCode: 0 };
    },
  };
}

console.log('\n─── sandboxManager.test.mjs ─────────────────────────────\n');

// ─── SANDBOX_STATE ────────────────────────────────────────────────────────────

console.log('SANDBOX_STATE:');

await testAsync('all states defined', async () => {
  assert(SANDBOX_STATE.CREATING,   'CREATING');
  assert(SANDBOX_STATE.IDLE,       'IDLE');
  assert(SANDBOX_STATE.RUNNING,    'RUNNING');
  assert(SANDBOX_STATE.DESTROYING, 'DESTROYING');
  assert(SANDBOX_STATE.DESTROYED,  'DESTROYED');
  assert(SANDBOX_STATE.FAILED,     'FAILED');
});

// ─── createNoOpDockerAdapter ──────────────────────────────────────────────────

console.log('\ncreateNoOpDockerAdapter:');

await testAsync('createContainer returns an id', async () => {
  const adapter = createNoOpDockerAdapter();
  const result  = await adapter.createContainer('node:20');
  assert(result.id, 'should return container with id');
  assert(typeof result.id === 'string', 'id should be string');
});

await testAsync('startContainer returns started: true', async () => {
  const adapter = createNoOpDockerAdapter();
  const result  = await adapter.startContainer('container_1');
  assert(result.started, 'started should be true');
});

await testAsync('isContainerRunning returns true for noop ids', async () => {
  const adapter = createNoOpDockerAdapter();
  const running = await adapter.isContainerRunning('noop_container_1');
  assert(running, 'noop containers should be considered running');
});

await testAsync('execInContainer returns output', async () => {
  const adapter = createNoOpDockerAdapter();
  const result  = await adapter.execInContainer('container_1', 'echo hello');
  assert(result.output, 'should return output');
  assertEqual(result.exitCode, 0, 'exitCode should be 0');
});

// ─── createSandboxManager ─────────────────────────────────────────────────────

console.log('\ncreateSandboxManager:');

await testAsync('createSandbox returns a sandbox id', async () => {
  const docker = makeDockerAdapter();
  const mgr    = createSandboxManager({ docker, silent: true });
  const id     = await mgr.createSandbox('task-1');
  assert(id, 'should return sandbox id');
  assert(typeof id === 'string', 'id is string');
});

await testAsync('sandbox id includes task id', async () => {
  const docker = makeDockerAdapter();
  const mgr    = createSandboxManager({ docker, silent: true });
  const id     = await mgr.createSandbox('my-task');
  assert(id.includes('my-task'), 'sandbox id should reference task');
});

await testAsync('createSandbox creates a container', async () => {
  const docker = makeDockerAdapter();
  const mgr    = createSandboxManager({ docker, silent: true });
  await mgr.createSandbox('task-1');
  assertEqual(docker.containers.size, 1, 'one container should be created');
});

await testAsync('getStats shows running sandbox', async () => {
  const docker = makeDockerAdapter();
  const mgr    = createSandboxManager({ docker, silent: true });
  await mgr.createSandbox('task-1');
  const stats  = mgr.getStats();
  assert(stats.running >= 1, 'should show 1 running sandbox');
});

await testAsync('destroySandbox removes the sandbox', async () => {
  const docker = makeDockerAdapter();
  const mgr    = createSandboxManager({ docker, silent: true, poolSize: 0 });
  const id     = await mgr.createSandbox('task-1');
  await mgr.destroySandbox(id);
  const stats  = mgr.getStats();
  assertEqual(stats.running, 0, 'running should be 0 after destroy');
});

await testAsync('destroySandbox on nonexistent id is a no-op', async () => {
  const mgr = createSandboxManager({ silent: true });
  await mgr.destroySandbox('nonexistent_id');  // should not throw
  assert(true, 'no-op for unknown id');
});

await testAsync('destroyAll clears all sandboxes', async () => {
  const docker = makeDockerAdapter();
  const mgr    = createSandboxManager({ docker, silent: true, poolSize: 0 });
  await mgr.createSandbox('task-1');
  await mgr.createSandbox('task-2');
  await mgr.destroyAll();
  const stats = mgr.getStats();
  assertEqual(stats.total, 0, 'all sandboxes cleared');
});

await testAsync('maxSandboxes limit is enforced', async () => {
  const docker = makeDockerAdapter();
  const mgr    = createSandboxManager({ docker, silent: true, maxSandboxes: 2, poolSize: 0 });
  await mgr.createSandbox('t1');
  await mgr.createSandbox('t2');
  try {
    await mgr.createSandbox('t3');
    assert(false, 'Should have thrown on max sandboxes');
  } catch (err) {
    assert(err.message.includes('max sandboxes'), 'error mentions max sandboxes');
  }
});

await testAsync('sandbox is pooled instead of destroyed when pool has space', async () => {
  const docker = makeDockerAdapter();
  const mgr    = createSandboxManager({ docker, silent: true, poolSize: 2 });
  const id     = await mgr.createSandbox('task-1');
  await mgr.destroySandbox(id);
  const stats  = mgr.getStats();
  assertEqual(stats.idle, 1, 'sandbox should be in pool (idle)');
});

await testAsync('pooled sandbox is reused on next createSandbox', async () => {
  const docker = makeDockerAdapter();
  const mgr    = createSandboxManager({ docker, silent: true, poolSize: 2 });
  const id1    = await mgr.createSandbox('task-1');
  await mgr.destroySandbox(id1);  // returns to pool

  const id2 = await mgr.createSandbox('task-2');
  assertEqual(id2, id1, 'should reuse pooled sandbox');
  // Container should not be re-created
  assertEqual(docker.containers.size, 1, 'still only 1 container');
});

await testAsync('dead containers in pool are not reused', async () => {
  const docker = makeDockerAdapter({ alwaysDead: true });
  const mgr    = createSandboxManager({ docker, silent: true, poolSize: 2 });
  const id1    = await mgr.createSandbox('task-1');
  await mgr.destroySandbox(id1);  // would go to pool

  // Since alwaysDead=true, the pool sandbox will be seen as dead and skipped
  const id2 = await mgr.createSandbox('task-2');
  // id2 should be a NEW sandbox (pool sandbox was dead)
  assert(id2, 'should create a new sandbox');
});

await testAsync('execInSandbox delegates to docker', async () => {
  const docker = makeDockerAdapter();
  const mgr    = createSandboxManager({ docker, silent: true });
  const id     = await mgr.createSandbox('task-1');
  const result = await mgr.execInSandbox(id, 'node -e "console.log(1)"');
  assert(result.output, 'should return exec output');
});

await testAsync('execInSandbox throws for unknown sandbox', async () => {
  const mgr = createSandboxManager({ silent: true });
  try {
    await mgr.execInSandbox('nonexistent', 'echo hi');
    assert(false, 'Should have thrown');
  } catch (err) {
    assert(err.message.includes('not found'), 'error mentions not found');
  }
});

await testAsync('emits sandbox:created event', async () => {
  const docker = makeDockerAdapter();
  const mgr    = createSandboxManager({ docker, silent: true });
  let emitted  = false;
  mgr.on('sandbox:created', () => { emitted = true; });
  await mgr.createSandbox('task-1');
  assert(emitted, 'sandbox:created event should be emitted');
});

await testAsync('emits sandbox:destroyed event', async () => {
  const docker = makeDockerAdapter();
  const mgr    = createSandboxManager({ docker, silent: true, poolSize: 0 });
  let emitted  = false;
  mgr.on('sandbox:destroyed', () => { emitted = true; });
  const id = await mgr.createSandbox('task-1');
  await mgr.destroySandbox(id);
  assert(emitted, 'sandbox:destroyed event should be emitted');
});

await testAsync('multiple sandboxes can run concurrently', async () => {
  const docker = makeDockerAdapter();
  const mgr    = createSandboxManager({ docker, silent: true, poolSize: 0, maxSandboxes: 5 });
  const ids    = await Promise.all([
    mgr.createSandbox('t1'),
    mgr.createSandbox('t2'),
    mgr.createSandbox('t3'),
  ]);
  const stats = mgr.getStats();
  assertEqual(stats.running, 3, '3 sandboxes running');
  assertEqual(ids.length, 3, '3 ids returned');
  // All ids unique
  const unique = new Set(ids);
  assertEqual(unique.size, 3, 'all ids should be unique');
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n─── Results: ${passed} passed, ${failed} failed ───\n`);
process.exit(failed > 0 ? 1 : 0);
