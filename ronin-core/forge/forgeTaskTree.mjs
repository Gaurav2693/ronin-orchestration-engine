// ─── forge/forgeTaskTree.mjs ───────────────────────────────────────────────────
// RONIN Forge Engine — Phase 11B (B3)
//
// Task Tree Manager: Manages hierarchical task state for Forge sessions.
// Each task can have subtasks. Tracks execution state, timing, and dependencies.
// Emits SSE events for changes so the Build Tree widget stays in sync.
//
// Task states: queued → running → completed|failed|blocked
// Tree structure: root { id, children: [ { id, children: [...] } ] }
//
// SSE event types:
// - task:created { taskId, parentId, name, timestamp }
// - task:started { taskId, timestamp }
// - task:completed { taskId, result, duration, timestamp }
// - task:failed { taskId, error, duration, timestamp }
// - task:blocked { taskId, reason, timestamp }
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID } from 'crypto';

// ─── Task States ──────────────────────────────────────────────────────────────

export const TASK_STATES = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  BLOCKED: 'blocked',
});

// ─── Task Tree Factory ────────────────────────────────────────────────────────

export function createForgeTaskTree(config = {}) {
  const tasks = new Map();
  const eventListeners = new Set();
  const rootTasks = [];

  // ─── Create Task ──────────────────────────────────────────────────────────

  function createTask(name, parentId = null, config = {}) {
    const taskId = randomUUID();
    const now = new Date();

    const task = {
      id: taskId,
      name,
      parentId,
      status: TASK_STATES.QUEUED,
      children: [],
      createdAt: now,
      startedAt: null,
      completedAt: null,
      result: null,
      error: null,
      blockedReason: null,
      durationMs: 0,
      costUsd: 0,
      metadata: config.metadata || {},
      dependencies: config.dependencies || [],
    };

    tasks.set(taskId, task);

    // Add to parent or root
    if (parentId) {
      const parent = tasks.get(parentId);
      if (parent) {
        parent.children.push(taskId);
      } else {
        throw new Error(`[forgeTaskTree] Parent task not found: ${parentId}`);
      }
    } else {
      rootTasks.push(taskId);
    }

    // Emit event
    emitEvent('task:created', {
      taskId,
      parentId,
      name,
      timestamp: now,
    });

    return taskId;
  }

  // ─── Get Task ─────────────────────────────────────────────────────────────

  function getTask(taskId) {
    const task = tasks.get(taskId);
    if (!task) return null;

    // Return public view
    return {
      id: task.id,
      name: task.name,
      parentId: task.parentId,
      status: task.status,
      children: task.children,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      result: task.result,
      error: task.error,
      blockedReason: task.blockedReason,
      durationMs: task.durationMs,
      costUsd: task.costUsd,
    };
  }

  // ─── Update Task Status ───────────────────────────────────────────────────

  function startTask(taskId) {
    const task = tasks.get(taskId);
    if (!task) throw new Error(`[forgeTaskTree] Task not found: ${taskId}`);
    if (task.status !== TASK_STATES.QUEUED) {
      throw new Error(`[forgeTaskTree] Cannot start task in status: ${task.status}`);
    }

    const now = new Date();
    task.status = TASK_STATES.RUNNING;
    task.startedAt = now;

    emitEvent('task:started', {
      taskId,
      timestamp: now,
    });
  }

  function completeTask(taskId, result = null, costUsd = 0) {
    const task = tasks.get(taskId);
    if (!task) throw new Error(`[forgeTaskTree] Task not found: ${taskId}`);
    if (task.status !== TASK_STATES.RUNNING) {
      throw new Error(`[forgeTaskTree] Cannot complete task in status: ${task.status}`);
    }

    const now = new Date();
    task.status = TASK_STATES.COMPLETED;
    task.completedAt = now;
    task.result = result;
    task.costUsd = costUsd;
    task.durationMs = now - task.startedAt;

    emitEvent('task:completed', {
      taskId,
      result,
      duration: task.durationMs,
      cost: costUsd,
      timestamp: now,
    });
  }

  function failTask(taskId, error = null) {
    const task = tasks.get(taskId);
    if (!task) throw new Error(`[forgeTaskTree] Task not found: ${taskId}`);
    if (![TASK_STATES.QUEUED, TASK_STATES.RUNNING].includes(task.status)) {
      throw new Error(`[forgeTaskTree] Cannot fail task in status: ${task.status}`);
    }

    const now = new Date();
    task.status = TASK_STATES.FAILED;
    task.completedAt = now;
    task.error = error;
    task.durationMs = task.startedAt ? now - task.startedAt : 0;

    emitEvent('task:failed', {
      taskId,
      error,
      duration: task.durationMs,
      timestamp: now,
    });
  }

  function blockTask(taskId, reason = null) {
    const task = tasks.get(taskId);
    if (!task) throw new Error(`[forgeTaskTree] Task not found: ${taskId}`);

    const now = new Date();
    task.status = TASK_STATES.BLOCKED;
    task.blockedReason = reason;

    emitEvent('task:blocked', {
      taskId,
      reason,
      timestamp: now,
    });
  }

  // ─── Get Task Subtree ─────────────────────────────────────────────────────

  function getSubtree(taskId) {
    const task = tasks.get(taskId);
    if (!task) return null;

    return {
      id: task.id,
      name: task.name,
      status: task.status,
      children: task.children.map(childId => getSubtree(childId)),
      durationMs: task.durationMs,
    };
  }

  // ─── Get All Root Tasks ───────────────────────────────────────────────────

  function getRoots() {
    return rootTasks.map(taskId => getTask(taskId));
  }

  // ─── Get Task Path (lineage from root) ─────────────────────────────────────

  function getTaskPath(taskId) {
    const path = [];
    let current = tasks.get(taskId);

    while (current) {
      path.unshift({
        id: current.id,
        name: current.name,
        status: current.status,
      });

      if (current.parentId) {
        current = tasks.get(current.parentId);
      } else {
        break;
      }
    }

    return path;
  }

  // ─── Get All Tasks ────────────────────────────────────────────────────────

  function getAllTasks() {
    const result = [];
    const visited = new Set();

    function traverse(taskId) {
      if (visited.has(taskId)) return;
      visited.add(taskId);

      const task = tasks.get(taskId);
      if (task) {
        result.push(getTask(taskId));
        for (const childId of task.children) {
          traverse(childId);
        }
      }
    }

    for (const rootId of rootTasks) {
      traverse(rootId);
    }

    return result;
  }

  // ─── Delete Task (and children) ────────────────────────────────────────────

  function deleteTask(taskId) {
    const task = tasks.get(taskId);
    if (!task) throw new Error(`[forgeTaskTree] Task not found: ${taskId}`);

    // Recursively delete children
    for (const childId of task.children) {
      deleteTask(childId);
    }

    // Remove from parent
    if (task.parentId) {
      const parent = tasks.get(task.parentId);
      if (parent) {
        parent.children = parent.children.filter(id => id !== taskId);
      }
    } else {
      // Remove from roots
      rootTasks.splice(rootTasks.indexOf(taskId), 1);
    }

    // Remove task
    tasks.delete(taskId);

    emitEvent('task:deleted', {
      taskId,
      timestamp: new Date(),
    });
  }

  // ─── Get Task Stats ───────────────────────────────────────────────────────

  function getStats() {
    const stats = {
      total: tasks.size,
      byStatus: {
        [TASK_STATES.QUEUED]: 0,
        [TASK_STATES.RUNNING]: 0,
        [TASK_STATES.COMPLETED]: 0,
        [TASK_STATES.FAILED]: 0,
        [TASK_STATES.BLOCKED]: 0,
      },
      totalCost: 0,
      totalDuration: 0,
    };

    for (const task of tasks.values()) {
      stats.byStatus[task.status]++;
      stats.totalCost += task.costUsd;
      stats.totalDuration += task.durationMs;
    }

    return stats;
  }

  // ─── Get Subtree Stats ────────────────────────────────────────────────────

  function getSubtreeStats(taskId) {
    const stats = {
      taskId,
      total: 0,
      byStatus: {
        [TASK_STATES.QUEUED]: 0,
        [TASK_STATES.RUNNING]: 0,
        [TASK_STATES.COMPLETED]: 0,
        [TASK_STATES.FAILED]: 0,
        [TASK_STATES.BLOCKED]: 0,
      },
      totalCost: 0,
      totalDuration: 0,
    };

    function traverse(id) {
      const task = tasks.get(id);
      if (!task) return;

      stats.total++;
      stats.byStatus[task.status]++;
      stats.totalCost += task.costUsd;
      stats.totalDuration += task.durationMs;

      for (const childId of task.children) {
        traverse(childId);
      }
    }

    traverse(taskId);
    return stats;
  }

  // ─── SSE Event System ──────────────────────────────────────────────────────

  function addEventListener(listener) {
    if (typeof listener !== 'function') {
      throw new Error('[forgeTaskTree] Listener must be a function');
    }
    eventListeners.add(listener);
  }

  function removeEventListener(listener) {
    eventListeners.delete(listener);
  }

  function emitEvent(eventType, data) {
    const event = {
      type: eventType,
      data,
      timestamp: new Date(),
    };

    for (const listener of eventListeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('[forgeTaskTree] Listener error:', err.message);
      }
    }
  }

  // ─── Get Event Stream ─────────────────────────────────────────────────────

  function createEventStream() {
    const events = [];
    let closed = false;

    const listener = (event) => {
      if (!closed) {
        events.push(event);
      }
    };

    addEventListener(listener);

    return {
      getEvents: () => {
        const result = [...events];
        events.length = 0; // Clear
        return result;
      },
      close: () => {
        closed = true;
        removeEventListener(listener);
      },
      isClosed: () => closed,
    };
  }

  // ─── Return Manager Interface ──────────────────────────────────────────────

  return {
    createTask,
    getTask,
    startTask,
    completeTask,
    failTask,
    blockTask,
    deleteTask,
    getSubtree,
    getTaskPath,
    getRoots,
    getAllTasks,
    getStats,
    getSubtreeStats,
    addEventListener,
    removeEventListener,
    emitEvent,
    createEventStream,
  };
}

// ─── Export ────────────────────────────────────────────────────────────────────

export default createForgeTaskTree;
