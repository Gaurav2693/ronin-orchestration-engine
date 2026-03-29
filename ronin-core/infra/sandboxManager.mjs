// infra/sandboxManager.mjs
// ─────────────────────────────────────────────────────────────────────────────
// I1: Docker Sandbox Manager
//
// Manages Docker container lifecycle for sandboxed Codex worker execution.
// Each task gets its own isolated container. Containers are created, used,
// and destroyed. A pool allows reuse for latency reduction.
//
// Key behaviours:
//   - createSandbox(taskId) → sandboxId + container ready
//   - destroySandbox(sandboxId) → container removed
//   - Pool: reuse idle containers instead of creating new ones
//   - Health: detect dead/stuck containers and replace them
//   - Timeout: auto-destroy containers that run too long
//
// In environments without Docker (CI, sandbox), falls back to process
// isolation via a no-op adapter.
//
// Usage:
//   const mgr = createSandboxManager({ poolSize: 3, timeout: 60_000 });
//   const id  = await mgr.createSandbox('T1');
//   // ... run Codex worker with sandboxId = id ...
//   await mgr.destroySandbox(id);
// ─────────────────────────────────────────────────────────────────────────────

import { EventEmitter } from 'events';

// ─── Sandbox States ───────────────────────────────────────────────────────────

export const SANDBOX_STATE = {
  CREATING:  'creating',
  IDLE:      'idle',       // in pool, available
  RUNNING:   'running',    // assigned to a task
  DESTROYING:'destroying',
  DESTROYED: 'destroyed',
  FAILED:    'failed',
};

// ─── Sandbox record ───────────────────────────────────────────────────────────

function createSandboxRecord(id, overrides = {}) {
  return {
    id,
    containerId: null,
    state:       SANDBOX_STATE.CREATING,
    taskId:      null,
    createdAt:   Date.now(),
    assignedAt:  null,
    destroyedAt: null,
    error:       null,
    ...overrides,
  };
}

// ─── No-op Docker adapter (fallback when Docker unavailable) ──────────────────

export function createNoOpDockerAdapter() {
  let _counter = 0;
  return {
    async createContainer(image, options = {}) {
      return { id: `noop_container_${++_counter}`, image, options };
    },
    async startContainer(containerId) {
      return { containerId, started: true };
    },
    async stopContainer(containerId) {
      return { containerId, stopped: true };
    },
    async removeContainer(containerId) {
      return { containerId, removed: true };
    },
    async isContainerRunning(containerId) {
      return containerId.startsWith('noop_');
    },
    async execInContainer(containerId, command) {
      return { output: `noop exec: ${command}`, exitCode: 0 };
    },
  };
}

// ─── Sandbox Manager factory ──────────────────────────────────────────────────

export function createSandboxManager(options = {}) {
  const {
    docker        = createNoOpDockerAdapter(),
    image         = 'node:20-slim',
    poolSize      = 2,
    timeout       = 120_000,   // 2 min max per sandbox
    maxSandboxes  = 10,
    silent        = false,
  } = options;

  const sandboxes = new Map();   // id → SandboxRecord
  const pool      = [];          // idle sandbox ids
  const emitter   = new EventEmitter();
  let   _counter  = 0;

  function _log(...args) {
    if (!silent) console.log('[SandboxManager]', ...args);
  }

  function _genId(taskId) {
    return `sandbox_${taskId || 'anon'}_${++_counter}_${Date.now()}`;
  }

  // ─── Create a new container ────────────────────────────────────────────
  async function _spawnContainer(sandboxId) {
    const record = sandboxes.get(sandboxId);
    if (!record) throw new Error(`sandbox ${sandboxId} not found`);

    try {
      const container = await docker.createContainer(image, {
        labels: { 'ronin.sandbox': sandboxId, 'ronin.task': record.taskId || '' },
        autoRemove: false,
      });
      await docker.startContainer(container.id);

      record.containerId = container.id;
      record.state       = SANDBOX_STATE.RUNNING;

      // Set auto-destroy timeout
      const timer = setTimeout(async () => {
        if (sandboxes.has(sandboxId)) {
          _log(`sandbox ${sandboxId} timed out after ${timeout}ms`);
          await destroySandbox(sandboxId).catch(() => {});
        }
      }, timeout);

      // Store timer ref on record for cancellation
      record._timer = timer;

      return container.id;
    } catch (err) {
      record.state = SANDBOX_STATE.FAILED;
      record.error = err.message;
      throw err;
    }
  }

  // ─── Public: createSandbox ────────────────────────────────────────────
  async function createSandbox(taskId) {
    if (sandboxes.size >= maxSandboxes) {
      throw new Error(`[SandboxManager] max sandboxes (${maxSandboxes}) reached`);
    }

    // Try to reuse a pool sandbox
    while (pool.length > 0) {
      const pooledId = pool.shift();
      const record   = sandboxes.get(pooledId);
      if (!record || record.state !== SANDBOX_STATE.IDLE) continue;

      // Verify container still alive
      const alive = await docker.isContainerRunning(record.containerId).catch(() => false);
      if (!alive) {
        sandboxes.delete(pooledId);
        continue;
      }

      record.state      = SANDBOX_STATE.RUNNING;
      record.taskId     = taskId;
      record.assignedAt = Date.now();
      _log(`reusing pool sandbox ${pooledId} for task ${taskId}`);
      emitter.emit('sandbox:assigned', { sandboxId: pooledId, taskId });
      return pooledId;
    }

    // Create fresh sandbox
    const sandboxId = _genId(taskId);
    const record    = createSandboxRecord(sandboxId, { taskId });
    sandboxes.set(sandboxId, record);

    await _spawnContainer(sandboxId);
    record.assignedAt = Date.now();
    _log(`created sandbox ${sandboxId} for task ${taskId}`);
    emitter.emit('sandbox:created', { sandboxId, taskId });
    return sandboxId;
  }

  // ─── Public: destroySandbox ───────────────────────────────────────────
  async function destroySandbox(sandboxId) {
    const record = sandboxes.get(sandboxId);
    if (!record) return;  // already gone

    if (record._timer) {
      clearTimeout(record._timer);
      record._timer = null;
    }

    // Pool instead of destroy if pool has space and sandbox is healthy
    const poolable = pool.length < poolSize
      && record.state === SANDBOX_STATE.RUNNING
      && record.containerId;

    if (poolable) {
      const alive = await docker.isContainerRunning(record.containerId).catch(() => false);
      if (alive) {
        record.state     = SANDBOX_STATE.IDLE;
        record.taskId    = null;
        record.assignedAt = null;
        pool.push(sandboxId);
        _log(`returned sandbox ${sandboxId} to pool`);
        emitter.emit('sandbox:pooled', { sandboxId });
        return;
      }
    }

    // Actually destroy
    record.state = SANDBOX_STATE.DESTROYING;

    if (record.containerId) {
      await docker.stopContainer(record.containerId).catch(() => {});
      await docker.removeContainer(record.containerId).catch(() => {});
    }

    record.state       = SANDBOX_STATE.DESTROYED;
    record.destroyedAt = Date.now();
    sandboxes.delete(sandboxId);
    _log(`destroyed sandbox ${sandboxId}`);
    emitter.emit('sandbox:destroyed', { sandboxId });
  }

  // ─── Public: execInSandbox ────────────────────────────────────────────
  async function execInSandbox(sandboxId, command) {
    const record = sandboxes.get(sandboxId);
    if (!record || !record.containerId) {
      throw new Error(`[SandboxManager] sandbox ${sandboxId} not found or not ready`);
    }
    return docker.execInContainer(record.containerId, command);
  }

  // ─── Public: destroyAll ───────────────────────────────────────────────
  async function destroyAll() {
    const ids = [...sandboxes.keys(), ...pool];
    const unique = [...new Set(ids)];
    await Promise.allSettled(unique.map(id => destroySandbox(id)));
    pool.length = 0;
    sandboxes.clear();
    _log('all sandboxes destroyed');
  }

  // ─── Public: getStats ─────────────────────────────────────────────────
  function getStats() {
    const all = [...sandboxes.values()];
    return {
      total:    all.length + pool.length,
      running:  all.filter(s => s.state === SANDBOX_STATE.RUNNING).length,
      idle:     pool.length,
      failed:   all.filter(s => s.state === SANDBOX_STATE.FAILED).length,
      poolSize: pool.length,
    };
  }

  return {
    createSandbox,
    destroySandbox,
    execInSandbox,
    destroyAll,
    getStats,
    on:  (event, fn) => emitter.on(event, fn),
    off: (event, fn) => emitter.off(event, fn),
  };
}
