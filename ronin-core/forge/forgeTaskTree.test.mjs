// ─── forge/forgeTaskTree.test.mjs ──────────────────────────────────────────────
// RONIN Forge Engine — Phase 11B (B3) — Tests
//
// 35+ tests covering:
// - Task creation and CRUD
// - Task state transitions
// - Hierarchical tree structure
// - Task navigation
// - Event emission
// - Event streaming
// - Statistics
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import createForgeTaskTree, { TASK_STATES } from './forgeTaskTree.mjs';

let taskTree;

before(() => {
  taskTree = createForgeTaskTree();
});

describe('forgeTaskTree', () => {
  // ─── Task Creation ────────────────────────────────────────────────────────

  describe('Task Creation', () => {
    it('should create a root task', () => {
      const taskId = taskTree.createTask('Root task');
      assert(taskId);
      assert.strictEqual(typeof taskId, 'string');
    });

    it('should create a subtask', () => {
      const rootId = taskTree.createTask('Root');
      const subtaskId = taskTree.createTask('Subtask', rootId);
      assert(subtaskId);
      assert.notEqual(subtaskId, rootId);
    });

    it('should assign unique IDs', () => {
      const id1 = taskTree.createTask('Task 1');
      const id2 = taskTree.createTask('Task 2');
      assert.notEqual(id1, id2);
    });

    it('should throw on creating subtask with invalid parent', () => {
      assert.throws(
        () => taskTree.createTask('Orphan', 'non-existent'),
        /Parent task not found/
      );
    });

    it('should include createdAt timestamp', () => {
      const taskId = taskTree.createTask('Timestamped');
      const task = taskTree.getTask(taskId);
      assert(task.createdAt);
      assert(task.createdAt instanceof Date);
    });

    it('should initialize task in queued state', () => {
      const taskId = taskTree.createTask('New task');
      const task = taskTree.getTask(taskId);
      assert.equal(task.status, TASK_STATES.QUEUED);
    });

    it('should initialize with empty children', () => {
      const taskId = taskTree.createTask('Parent');
      const task = taskTree.getTask(taskId);
      assert(Array.isArray(task.children));
      assert.equal(task.children.length, 0);
    });

    it('should link subtask to parent', () => {
      const parentId = taskTree.createTask('Parent');
      const subtaskId = taskTree.createTask('Child', parentId);
      const parent = taskTree.getTask(parentId);
      assert(parent.children.includes(subtaskId));
    });

    it('should support multiple subtasks per parent', () => {
      const parentId = taskTree.createTask('Parent');
      const child1 = taskTree.createTask('Child1', parentId);
      const child2 = taskTree.createTask('Child2', parentId);
      const parent = taskTree.getTask(parentId);
      assert.equal(parent.children.length, 2);
      assert(parent.children.includes(child1));
      assert(parent.children.includes(child2));
    });
  });

  // ─── Task State Transitions ────────────────────────────────────────────────

  describe('Task State Transitions', () => {
    it('should transition from queued to running', () => {
      const taskId = taskTree.createTask('Task');
      taskTree.startTask(taskId);
      const task = taskTree.getTask(taskId);
      assert.equal(task.status, TASK_STATES.RUNNING);
    });

    it('should set startedAt when starting', () => {
      const taskId = taskTree.createTask('Task');
      const before = new Date();
      taskTree.startTask(taskId);
      const after = new Date();
      const task = taskTree.getTask(taskId);
      assert(task.startedAt >= before && task.startedAt <= after);
    });

    it('should transition from running to completed', () => {
      const taskId = taskTree.createTask('Task');
      taskTree.startTask(taskId);
      taskTree.completeTask(taskId, 'Success');
      const task = taskTree.getTask(taskId);
      assert.equal(task.status, TASK_STATES.COMPLETED);
    });

    it('should store result on completion', () => {
      const taskId = taskTree.createTask('Task');
      taskTree.startTask(taskId);
      taskTree.completeTask(taskId, 'Custom result');
      const task = taskTree.getTask(taskId);
      assert.equal(task.result, 'Custom result');
    });

    it('should calculate duration on completion', () => {
      const taskId = taskTree.createTask('Task');
      taskTree.startTask(taskId);
      taskTree.completeTask(taskId);
      const task = taskTree.getTask(taskId);
      assert(task.durationMs >= 0);
    });

    it('should transition from queued to failed', () => {
      const taskId = taskTree.createTask('Task');
      taskTree.failTask(taskId, 'Error message');
      const task = taskTree.getTask(taskId);
      assert.equal(task.status, TASK_STATES.FAILED);
    });

    it('should store error on failure', () => {
      const taskId = taskTree.createTask('Task');
      taskTree.failTask(taskId, 'Test error');
      const task = taskTree.getTask(taskId);
      assert.equal(task.error, 'Test error');
    });

    it('should block a task', () => {
      const taskId = taskTree.createTask('Task');
      taskTree.blockTask(taskId, 'Waiting for approval');
      const task = taskTree.getTask(taskId);
      assert.equal(task.status, TASK_STATES.BLOCKED);
      assert.equal(task.blockedReason, 'Waiting for approval');
    });

    it('should throw on invalid state transition', () => {
      const taskId = taskTree.createTask('Task');
      taskTree.startTask(taskId);
      assert.throws(
        () => taskTree.startTask(taskId),
        /Cannot start task in status/
      );
    });

    it('should track cost on completion', () => {
      const taskId = taskTree.createTask('Task');
      taskTree.startTask(taskId);
      taskTree.completeTask(taskId, 'Result', 0.042);
      const task = taskTree.getTask(taskId);
      assert.equal(task.costUsd, 0.042);
    });
  });

  // ─── Task Retrieval ───────────────────────────────────────────────────────

  describe('Task Retrieval', () => {
    it('should retrieve task by ID', () => {
      const taskId = taskTree.createTask('Find me');
      const task = taskTree.getTask(taskId);
      assert.equal(task.id, taskId);
      assert.equal(task.name, 'Find me');
    });

    it('should return null for non-existent task', () => {
      const task = taskTree.getTask('non-existent');
      assert.equal(task, null);
    });

    it('should get all root tasks', () => {
      const roots = taskTree.getRoots();
      assert(Array.isArray(roots));
      assert(roots.length > 0);
    });

    it('should get task path (lineage)', () => {
      const root = taskTree.createTask('Root');
      const mid = taskTree.createTask('Middle', root);
      const leaf = taskTree.createTask('Leaf', mid);
      const path = taskTree.getTaskPath(leaf);
      assert.equal(path.length, 3);
      assert.equal(path[0].id, root);
      assert.equal(path[1].id, mid);
      assert.equal(path[2].id, leaf);
    });

    it('should get subtree', () => {
      const parent = taskTree.createTask('Parent');
      const child1 = taskTree.createTask('Child1', parent);
      const child2 = taskTree.createTask('Child2', parent);
      const subtree = taskTree.getSubtree(parent);
      assert.equal(subtree.id, parent);
      assert.equal(subtree.children.length, 2);
    });

    it('should get all tasks', () => {
      const tasks = taskTree.getAllTasks();
      assert(Array.isArray(tasks));
      assert(tasks.length > 0);
    });
  });

  // ─── Task Deletion ────────────────────────────────────────────────────────

  describe('Task Deletion', () => {
    it('should delete a task', () => {
      const taskId = taskTree.createTask('Delete me');
      taskTree.deleteTask(taskId);
      const task = taskTree.getTask(taskId);
      assert.equal(task, null);
    });

    it('should delete task from parent children', () => {
      const parent = taskTree.createTask('Parent');
      const child = taskTree.createTask('Child', parent);
      taskTree.deleteTask(child);
      const parentTask = taskTree.getTask(parent);
      assert(!parentTask.children.includes(child));
    });

    it('should recursively delete children', () => {
      const parent = taskTree.createTask('Parent');
      const child = taskTree.createTask('Child', parent);
      const grandchild = taskTree.createTask('Grandchild', child);
      taskTree.deleteTask(parent);
      assert.equal(taskTree.getTask(parent), null);
      assert.equal(taskTree.getTask(child), null);
      assert.equal(taskTree.getTask(grandchild), null);
    });

    it('should throw on deleting non-existent task', () => {
      assert.throws(
        () => taskTree.deleteTask('non-existent'),
        /Task not found/
      );
    });
  });

  // ─── Task Statistics ──────────────────────────────────────────────────────

  describe('Task Statistics', () => {
    it('should count total tasks', () => {
      const tree = createForgeTaskTree();
      tree.createTask('Task1');
      tree.createTask('Task2');
      const count = tree.getAllTasks().length;
      const stats = tree.getStats();
      assert.equal(stats.total, count);
    });

    it('should count tasks by status', () => {
      const stats = taskTree.getStats();
      assert(stats.byStatus[TASK_STATES.QUEUED] >= 0);
      assert(stats.byStatus[TASK_STATES.RUNNING] >= 0);
      assert(stats.byStatus[TASK_STATES.COMPLETED] >= 0);
      assert(stats.byStatus[TASK_STATES.FAILED] >= 0);
      assert(stats.byStatus[TASK_STATES.BLOCKED] >= 0);
    });

    it('should accumulate cost', () => {
      const stats = taskTree.getStats();
      assert(stats.totalCost >= 0);
    });

    it('should get subtree stats', () => {
      const parent = taskTree.createTask('Parent');
      const child = taskTree.createTask('Child', parent);
      const stats = taskTree.getSubtreeStats(parent);
      assert.equal(stats.taskId, parent);
      assert(stats.total >= 1);
    });
  });

  // ─── Event System ─────────────────────────────────────────────────────────

  describe('Event System', () => {
    it('should emit task:created event', () => {
      const tree = createForgeTaskTree();
      let eventFired = false;

      tree.addEventListener((event) => {
        if (event.type === 'task:created') {
          eventFired = true;
          assert.equal(event.data.name, 'Test');
        }
      });

      tree.createTask('Test');
      assert(eventFired);
    });

    it('should emit task:started event', () => {
      const tree = createForgeTaskTree();
      let eventFired = false;

      tree.addEventListener((event) => {
        if (event.type === 'task:started') {
          eventFired = true;
        }
      });

      const taskId = tree.createTask('Task');
      tree.startTask(taskId);
      assert(eventFired);
    });

    it('should emit task:completed event', () => {
      const tree = createForgeTaskTree();
      let eventFired = false;

      tree.addEventListener((event) => {
        if (event.type === 'task:completed') {
          eventFired = true;
          assert.equal(event.data.result, 'Success');
        }
      });

      const taskId = tree.createTask('Task');
      tree.startTask(taskId);
      tree.completeTask(taskId, 'Success');
      assert(eventFired);
    });

    it('should emit task:failed event', () => {
      const tree = createForgeTaskTree();
      let eventFired = false;

      tree.addEventListener((event) => {
        if (event.type === 'task:failed') {
          eventFired = true;
          assert.equal(event.data.error, 'Failure');
        }
      });

      const taskId = tree.createTask('Task');
      tree.failTask(taskId, 'Failure');
      assert(eventFired);
    });

    it('should support multiple listeners', () => {
      const tree = createForgeTaskTree();
      let count = 0;

      tree.addEventListener(() => count++);
      tree.addEventListener(() => count++);

      tree.createTask('Task');
      assert.equal(count, 2);
    });

    it('should remove event listener', () => {
      const tree = createForgeTaskTree();
      let count = 0;

      const listener = () => count++;
      tree.addEventListener(listener);
      tree.createTask('Task 1');
      assert.equal(count, 1);

      tree.removeEventListener(listener);
      tree.createTask('Task 2');
      assert.equal(count, 1);
    });

    it('should handle listener errors gracefully', () => {
      const tree = createForgeTaskTree();
      tree.addEventListener(() => {
        throw new Error('Listener error');
      });

      // Should not throw
      assert.doesNotThrow(() => {
        tree.createTask('Task');
      });
    });
  });

  // ─── Event Streaming ──────────────────────────────────────────────────────

  describe('Event Streaming', () => {
    it('should create event stream', () => {
      const tree = createForgeTaskTree();
      const stream = tree.createEventStream();
      assert(stream);
      assert.equal(typeof stream.getEvents, 'function');
      assert.equal(typeof stream.close, 'function');
    });

    it('should collect events in stream', () => {
      const tree = createForgeTaskTree();
      const stream = tree.createEventStream();

      tree.createTask('Task 1');
      tree.createTask('Task 2');

      const events = stream.getEvents();
      assert(events.length >= 2);
    });

    it('should clear events after getEvents', () => {
      const tree = createForgeTaskTree();
      const stream = tree.createEventStream();

      tree.createTask('Task');
      const events1 = stream.getEvents();
      const events2 = stream.getEvents();

      assert(events1.length > 0);
      assert.equal(events2.length, 0);
    });

    it('should not collect events after close', () => {
      const tree = createForgeTaskTree();
      const stream = tree.createEventStream();

      tree.createTask('Task 1');
      stream.close();
      tree.createTask('Task 2');

      const events = stream.getEvents();
      assert.equal(events.length, 1);
    });

    it('should report closed status', () => {
      const tree = createForgeTaskTree();
      const stream = tree.createEventStream();
      assert.equal(stream.isClosed(), false);
      stream.close();
      assert.equal(stream.isClosed(), true);
    });
  });

  // ─── Error Handling ───────────────────────────────────────────────────────

  describe('Error Handling', () => {
    it('should throw on invalid listener', () => {
      const tree = createForgeTaskTree();
      assert.throws(
        () => tree.addEventListener('not a function'),
        /Listener must be a function/
      );
    });

    it('should throw on completing non-running task', () => {
      const tree = createForgeTaskTree();
      const taskId = tree.createTask('Task');
      assert.throws(
        () => tree.completeTask(taskId),
        /Cannot complete task in status/
      );
    });

    it('should throw on failing blocked task', () => {
      const tree = createForgeTaskTree();
      const taskId = tree.createTask('Task');
      tree.blockTask(taskId);
      assert.throws(
        () => tree.failTask(taskId),
        /Cannot fail task in status/
      );
    });
  });
});
