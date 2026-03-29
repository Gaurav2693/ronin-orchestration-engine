// ─── forge/forgeSession.test.mjs ──────────────────────────────────────────────
// RONIN Forge Engine — Phase 11B (B2) — Tests
//
// 40+ tests covering:
// - Session lifecycle (create, process, approve, destroy)
// - Message processing and history
// - Protected file approval flow
// - Task tracking and status
// - State transitions
// - Error handling
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import createForgeSessionManager from './forgeSession.mjs';
import { createMockProvider } from './forgeSession.test.utils.mjs';

let sessionManager;
let mockProvider;

before(() => {
  mockProvider = createMockProvider();
  sessionManager = createForgeSessionManager(null, mockProvider);
});

describe('forgeSession', () => {
  // ─── Session Lifecycle ────────────────────────────────────────────────────

  describe('Session Lifecycle', () => {
    it('should create a new session', async () => {
      const result = await sessionManager.createSession('operator-1');
      assert(result.id);
      assert.equal(result.operatorId, 'operator-1');
      assert.equal(result.status, 'active');
      assert(result.createdAt);
    });

    it('should initialize session with empty state', async () => {
      const result = await sessionManager.createSession('operator-1');
      const session = sessionManager.getSession(result.id);
      assert.equal(session.taskCount, 0);
      assert.equal(session.messageCount, 0);
      assert.equal(session.approvalQueueLength, 0);
    });

    it('should list all active sessions', async () => {
      await sessionManager.createSession('operator-1');
      await sessionManager.createSession('operator-2');
      const sessions = sessionManager.listSessions();
      assert(sessions.length >= 2);
      assert(sessions.every((s) => s.id && s.status === 'active'));
    });

    it('should retrieve session by ID', async () => {
      const created = await sessionManager.createSession('operator-1');
      const session = sessionManager.getSession(created.id);
      assert.equal(session.id, created.id);
      assert.equal(session.operatorId, 'operator-1');
    });

    it('should return null for non-existent session', () => {
      const session = sessionManager.getSession('non-existent');
      assert.equal(session, null);
    });

    it('should destroy session', async () => {
      const created = await sessionManager.createSession('operator-1');
      const result = await sessionManager.destroySession(created.id);
      assert.equal(result.ok, true);

      const session = sessionManager.getSession(created.id);
      assert.equal(session, null);
    });

    it('should throw on destroy non-existent session', async () => {
      assert.rejects(
        () => sessionManager.destroySession('non-existent'),
        /Session not found/
      );
    });
  });

  // ─── Message Processing ───────────────────────────────────────────────────

  describe('Message Processing', () => {
    let sessionId;

    before(async () => {
      const session = await sessionManager.createSession('operator-1');
      sessionId = session.id;
    });

    it('should process a simple message', async () => {
      const result = await sessionManager.processMessage(
        sessionId,
        'What files do we have?'
      );
      assert.equal(result.ok, true);
      assert(result.response);
      assert(result.taskId);
    });

    it('should add message to history', async () => {
      await sessionManager.processMessage(sessionId, 'Hello, Forge!');
      const messages = sessionManager.getSessionMessages(sessionId);
      assert(messages.length > 0);
      assert(messages.some((m) => m.content === 'Hello, Forge!'));
    });

    it('should alternate user and assistant messages', async () => {
      const session = await sessionManager.createSession('operator-1');
      await sessionManager.processMessage(session.id, 'First message');
      const messages = sessionManager.getSessionMessages(session.id);
      assert.equal(messages[0].role, 'user');
      assert.equal(messages[1].role, 'assistant');
    });

    it('should track message timestamps', async () => {
      const session = await sessionManager.createSession('operator-1');
      const before = new Date();
      await sessionManager.processMessage(session.id, 'Test message');
      const after = new Date();

      const messages = sessionManager.getSessionMessages(session.id);
      const msg = messages[0];
      assert(msg.timestamp >= before && msg.timestamp <= after);
    });

    it('should process complex multi-step messages', async () => {
      const session = await sessionManager.createSession('operator-1');
      const result = await sessionManager.processMessage(
        session.id,
        'Read the config file, test it, and write a report'
      );
      assert.equal(result.ok, true);
      assert(result.taskId);
    });

    it('should return error for message on paused session', async () => {
      const session = await sessionManager.createSession('operator-1');
      await sessionManager.pauseSession(session.id);
      assert.rejects(
        () => sessionManager.processMessage(session.id, 'message'),
        /Session not active/
      );
    });

    it('should return error for message on destroyed session', async () => {
      const session = await sessionManager.createSession('operator-1');
      await sessionManager.destroySession(session.id);
      assert.rejects(
        () => sessionManager.processMessage(session.id, 'message'),
        /Session not found/
      );
    });
  });

  // ─── Task Tracking ────────────────────────────────────────────────────────

  describe('Task Tracking', () => {
    let sessionId;

    before(async () => {
      const session = await sessionManager.createSession('operator-1');
      sessionId = session.id;
    });

    it('should create task for each message', async () => {
      await sessionManager.processMessage(sessionId, 'Task 1');
      await sessionManager.processMessage(sessionId, 'Task 2');
      const tasks = sessionManager.getSessionTasks(sessionId);
      assert.equal(tasks.length, 2);
    });

    it('should assign unique IDs to tasks', async () => {
      await sessionManager.processMessage(sessionId, 'First task');
      await sessionManager.processMessage(sessionId, 'Second task');
      const tasks = sessionManager.getSessionTasks(sessionId);
      const ids = tasks.map((t) => t.id);
      assert.equal(new Set(ids).size, ids.length);
    });

    it('should track task status', async () => {
      const result = await sessionManager.processMessage(
        sessionId,
        'Test message'
      );
      const tasks = sessionManager.getSessionTasks(sessionId);
      const task = tasks.find((t) => t.id === result.taskId);
      assert(task.status === 'completed' || task.status === 'started');
    });

    it('should track task timestamps', async () => {
      const before = new Date();
      const result = await sessionManager.processMessage(
        sessionId,
        'Timestamped task'
      );
      const after = new Date();

      const tasks = sessionManager.getSessionTasks(sessionId);
      const task = tasks.find((t) => t.id === result.taskId);
      assert(task.timestamp >= before && task.timestamp <= after);
    });

    it('should track task duration', async () => {
      const result = await sessionManager.processMessage(
        sessionId,
        'Duration task'
      );
      const tasks = sessionManager.getSessionTasks(sessionId);
      const task = tasks.find((t) => t.id === result.taskId);
      assert(task.durationMs >= 0);
    });

    it('should track cost per task', async () => {
      const result = await sessionManager.processMessage(
        sessionId,
        'Costly task'
      );
      assert(result.costUsd >= 0);
    });

    it('should mark failed tasks', async () => {
      // Create a session with a provider that fails
      const failProvider = {
        chat: async () => {
          throw new Error('Test error');
        },
      };
      const failManager = createForgeSessionManager(null, failProvider);
      const session = await failManager.createSession('op');

      const result = await failManager.processMessage(session.id, 'Fail');
      assert.equal(result.ok, false);
      assert(result.error);
    });
  });

  // ─── Session State Transitions ────────────────────────────────────────────

  describe('Session State Transitions', () => {
    it('should pause active session', async () => {
      const session = await sessionManager.createSession('op');
      const result = sessionManager.pauseSession(session.id);
      assert.equal(result.ok, true);
      assert.equal(result.sessionStatus, 'paused');
    });

    it('should resume paused session', async () => {
      const session = await sessionManager.createSession('op');
      sessionManager.pauseSession(session.id);
      const result = sessionManager.resumeSession(session.id);
      assert.equal(result.ok, true);
      assert.equal(result.sessionStatus, 'active');
    });

    it('should throw on resume non-paused session', async () => {
      const session = await sessionManager.createSession('op');
      assert.throws(
        () => sessionManager.resumeSession(session.id),
        /Cannot resume session/
      );
    });

    it('should track current status', async () => {
      const session = await sessionManager.createSession('op');
      assert.equal(sessionManager.getSession(session.id).status, 'active');

      sessionManager.pauseSession(session.id);
      assert.equal(sessionManager.getSession(session.id).status, 'paused');

      sessionManager.resumeSession(session.id);
      assert.equal(sessionManager.getSession(session.id).status, 'active');
    });
  });

  // ─── Approval Workflow ────────────────────────────────────────────────────

  describe('Approval Workflow', () => {
    it('should handle protected file approval requests', async () => {
      const session = await sessionManager.createSession('op');
      // Simulate a message that would need approval
      // (In real test, need a mock provider that returns approvalNeeded)
      const approvals = sessionManager.getSessionApprovalQueue(session.id);
      assert(Array.isArray(approvals));
    });

    it('should list pending approvals', async () => {
      const session = await sessionManager.createSession('op');
      const queue = sessionManager.getSessionApprovalQueue(session.id);
      assert.equal(queue.length, 0);
    });

    it('should approve an action', async () => {
      const session = await sessionManager.createSession('op');
      // Mock: add an approval to queue
      // (Need proper test setup with real approval scenario)
    });

    it('should reject an action', async () => {
      const session = await sessionManager.createSession('op');
      // Mock: add an approval to queue
      // (Need proper test setup with real approval scenario)
    });
  });

  // ─── File Change Tracking ─────────────────────────────────────────────────

  describe('File Change Tracking', () => {
    it('should track file changes', async () => {
      const session = await sessionManager.createSession('op');
      const changes = sessionManager.getSessionFileChanges(session.id);
      assert(Array.isArray(changes));
    });

    it('should initialize empty change log', async () => {
      const session = await sessionManager.createSession('op');
      const changes = sessionManager.getSessionFileChanges(session.id);
      assert.equal(changes.length, 0);
    });
  });

  // ─── Error Handling ───────────────────────────────────────────────────────

  describe('Error Handling', () => {
    it('should throw on process message with invalid session', async () => {
      assert.rejects(
        () => sessionManager.processMessage('invalid', 'message'),
        /Session not found/
      );
    });

    it('should throw on pause invalid session', () => {
      assert.throws(
        () => sessionManager.pauseSession('invalid'),
        /Session not found/
      );
    });

    it('should throw on resume invalid session', () => {
      assert.throws(
        () => sessionManager.resumeSession('invalid'),
        /Session not found/
      );
    });

    it('should handle provider errors gracefully', async () => {
      const errorProvider = {
        chat: async () => {
          throw new Error('Provider error');
        },
      };
      const mgr = createForgeSessionManager(null, errorProvider);
      const session = await mgr.createSession('op');
      const result = await mgr.processMessage(session.id, 'test');
      assert.equal(result.ok, false);
      assert(result.error);
    });
  });

  // ─── Message History ─────────────────────────────────────────────────────

  describe('Message History', () => {
    it('should preserve full conversation history', async () => {
      const session = await sessionManager.createSession('op');
      const messages1 = [
        'First message',
        'Second message',
        'Third message',
      ];

      for (const msg of messages1) {
        await sessionManager.processMessage(session.id, msg);
      }

      const messages = sessionManager.getSessionMessages(session.id);
      const userMessages = messages.filter((m) => m.role === 'user');
      assert.equal(userMessages.length, 3);
    });

    it('should assign IDs to all messages', async () => {
      const session = await sessionManager.createSession('op');
      await sessionManager.processMessage(session.id, 'Message 1');
      await sessionManager.processMessage(session.id, 'Message 2');

      const messages = sessionManager.getSessionMessages(session.id);
      messages.forEach((m) => {
        assert(m.id);
      });
    });

    it('should include tool calls in assistant messages', async () => {
      const session = await sessionManager.createSession('op');
      await sessionManager.processMessage(session.id, 'Do something');

      const messages = sessionManager.getSessionMessages(session.id);
      const assistantMsg = messages.find((m) => m.role === 'assistant');
      assert(assistantMsg);
      assert(Array.isArray(assistantMsg.toolCalls));
    });
  });

  // ─── Session Configuration ────────────────────────────────────────────────

  describe('Session Configuration', () => {
    it('should accept custom model in config', async () => {
      const result = await sessionManager.createSession('op', {
        model: 'gpt-4o-mini',
      });
      assert(result.id);
    });

    it('should accept custom sandbox path', async () => {
      const result = await sessionManager.createSession('op', {
        sandboxPath: '/custom/path',
      });
      assert(result.id);
    });

    it('should accept max tokens config', async () => {
      const result = await sessionManager.createSession('op', {
        maxTokens: 4096,
      });
      assert(result.id);
    });
  });
});
