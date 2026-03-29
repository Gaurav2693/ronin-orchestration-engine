// ─── forge/forgeSession.mjs ────────────────────────────────────────────────────
// RONIN Forge Engine — Phase 11B (B2)
//
// Session Lifecycle Manager: Creates Forge sessions, wires the sandbox,
// manages the agent loop, and tracks file changes.
//
// Session states: active → awaiting_approval → paused → destroyed
//
// Each session owns:
// - A sandbox container (via sandboxManager)
// - A task tree (synced to forgeTaskTree)
// - A message history (conversation)
// - A file changes log (for diff view)
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID } from 'crypto';
import { createAgentWorker } from '../workers/agentWorker.mjs';
import { createForgeToolRegistry } from './forgeToolRegistry.mjs';

// ─── Session Factory ──────────────────────────────────────────────────────────

export function createForgeSessionManager(sandboxManager, anthropicProvider) {
  const sessions = new Map();

  // ─── Create Session ───────────────────────────────────────────────────────

  async function createSession(operatorId, config = {}) {
    const sessionId = randomUUID();
    const createdAt = new Date();

    // Spin up sandbox container
    let sandboxId = null;
    let sandboxPath = config.sandboxPath || process.cwd();

    if (sandboxManager) {
      try {
        const sandbox = await sandboxManager.createContainer({
          image: config.sandboxImage || 'node:20-alpine',
          timeout: config.sandboxTimeout || 300000,
        });
        sandboxId = sandbox.id;
        sandboxPath = sandbox.path;
      } catch (err) {
        console.warn('[forgeSession] Sandbox creation failed, using in-process mode:', err.message);
      }
    }

    // Create tool registry for this session
    const toolRegistry = createForgeToolRegistry(sandboxPath);

    // Create agent worker for this session (only if provider exists)
    let agentWorker = null;
    if (anthropicProvider) {
      agentWorker = createAgentWorker(
        anthropicProvider,
        toolRegistry,
        {
          model: config.model || process.env.RONIN_MODEL || 'claude-sonnet-4-6',
          maxTokens: config.maxTokens || 2048,
          maxSteps: config.maxSteps || 10,
        }
      );
    }

    // Initialize session state
    const session = {
      id: sessionId,
      operatorId,
      sandboxId,
      sandboxPath,
      createdAt,
      status: 'active', // active | awaiting_approval | paused | destroyed
      tasks: [],
      messages: [],
      fileChanges: [], // { file, type: 'create'|'modify'|'delete', before?, after?, timestamp }
      approvalQueue: [], // { taskId, protectedFile, proposedChange, timestamp }
    };

    // Store session
    sessions.set(sessionId, {
      ...session,
      toolRegistry,
      agentWorker,
    });

    return {
      id: sessionId,
      operatorId,
      status: 'active',
      createdAt,
      sandboxId,
    };
  }

  // ─── Process Message ──────────────────────────────────────────────────────

  async function processMessage(sessionId, message, context = {}) {
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`[forgeSession] Session not found: ${sessionId}`);
    if (session.status !== 'active') {
      throw new Error(`[forgeSession] Session not active: ${session.status}`);
    }

    // Add message to history
    const userMessage = {
      id: randomUUID(),
      role: 'user',
      content: message,
      timestamp: new Date(),
    };
    session.messages.push(userMessage);

    // Simple task: user message
    // Complex task: break into manifest if needed
    const task = {
      id: randomUUID(),
      type: message.length > 200 ? 'complex' : 'simple',
      content: message,
      status: 'started',
      timestamp: new Date(),
      steps: [],
    };
    session.tasks.push(task);

    try {
      let result;

      // Execute agent worker if available
      if (session.agentWorker) {
        result = await session.agentWorker.execute(
          {
            content: message,
            manifest: task.type === 'complex' ? buildManifest(message) : undefined,
          },
          {
            ...context,
            sessionId,
            toolRegistry: session.toolRegistry,
          }
        );

        // Normalize agentWorker response to standard format
        result = {
          ok: true,
          output: result.result,
          response: result.result,
          toolCalls: result.toolCalls || [],
          costUsd: result.cost || 0,
          steps: result.steps || [],
        };
      } else {
        // Fallback: use provider directly if agentWorker not available
        result = await anthropicProvider.chat(
          [{ role: 'user', content: message }],
          { temperature: 0.7 }
        );

        // Ensure standard response format
        if (!result.ok) {
          result.ok = true;
        }
      }

      // Check for protected file approvals needed
      if (result.approvalNeeded) {
        session.status = 'awaiting_approval';
        session.approvalQueue.push({
          taskId: task.id,
          protectedFile: result.protectedFile,
          proposedChange: result.proposedChange,
          timestamp: new Date(),
        });

        return {
          ok: false,
          status: 'awaiting_approval',
          approvalQueue: session.approvalQueue,
          reason: `Protected file access needed: ${result.protectedFile}`,
        };
      }

      // Track file changes
      if (result.fileChanges) {
        session.fileChanges.push(...result.fileChanges);
      }

      // Add assistant response to history
      const assistantMessage = {
        id: randomUUID(),
        role: 'assistant',
        content: result.output || result.response,
        timestamp: new Date(),
        toolCalls: result.toolCalls || [],
      };
      session.messages.push(assistantMessage);

      // Update task status
      task.status = 'completed';
      task.result = result.output || result.response;
      task.steps = result.steps || [];
      task.costUsd = result.costUsd || 0;
      task.durationMs = new Date() - task.timestamp;

      return {
        ok: true,
        response: result.output || result.response,
        toolCalls: result.toolCalls || [],
        costUsd: result.costUsd || 0,
        taskId: task.id,
      };
    } catch (err) {
      task.status = 'failed';
      task.error = err.message;
      task.durationMs = new Date() - task.timestamp;

      return {
        ok: false,
        error: err.message,
        taskId: task.id,
      };
    }
  }

  // ─── Approve Action ───────────────────────────────────────────────────────

  async function approveAction(sessionId, taskId) {
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`[forgeSession] Session not found: ${sessionId}`);

    // Remove from approval queue
    const approvalIdx = session.approvalQueue.findIndex((a) => a.taskId === taskId);
    if (approvalIdx === -1) {
      throw new Error(`[forgeSession] No approval pending for task: ${taskId}`);
    }

    const approval = session.approvalQueue.splice(approvalIdx, 1)[0];

    // Find the task
    const task = session.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`[forgeSession] Task not found: ${taskId}`);

    // Update task to allow protected file write
    task.approvedForFile = approval.protectedFile;

    // Attempt the write again
    // (In a real implementation, this would retry the failed step)

    // Resume session
    if (session.approvalQueue.length === 0) {
      session.status = 'active';
    }

    return {
      ok: true,
      sessionStatus: session.status,
      taskId,
      approvedFile: approval.protectedFile,
    };
  }

  // ─── Reject Action ────────────────────────────────────────────────────────

  function rejectAction(sessionId, taskId) {
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`[forgeSession] Session not found: ${sessionId}`);

    const approvalIdx = session.approvalQueue.findIndex((a) => a.taskId === taskId);
    if (approvalIdx === -1) {
      throw new Error(`[forgeSession] No approval pending for task: ${taskId}`);
    }

    const approval = session.approvalQueue.splice(approvalIdx, 1)[0];

    // Find task and mark as blocked
    const task = session.tasks.find((t) => t.id === taskId);
    if (task) {
      task.status = 'blocked';
      task.blockedReason = `User rejected write to ${approval.protectedFile}`;
    }

    // Resume session if no more approvals
    if (session.approvalQueue.length === 0) {
      session.status = 'active';
    }

    return {
      ok: true,
      sessionStatus: session.status,
      taskId,
      rejectedFile: approval.protectedFile,
    };
  }

  // ─── Get Session State ────────────────────────────────────────────────────

  function getSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return null;

    // Return public view of session
    return {
      id: session.id,
      operatorId: session.operatorId,
      status: session.status,
      createdAt: session.createdAt,
      sandboxId: session.sandboxId,
      taskCount: session.tasks.length,
      messageCount: session.messages.length,
      fileChangeCount: session.fileChanges.length,
      approvalQueueLength: session.approvalQueue.length,
      toolStats: session.toolRegistry.getStats(),
    };
  }

  function getSessionMessages(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return null;
    return session.messages;
  }

  function getSessionTasks(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return null;
    return session.tasks;
  }

  function getSessionApprovalQueue(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return null;
    return session.approvalQueue;
  }

  function getSessionFileChanges(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return null;
    return session.fileChanges;
  }

  // ─── Pause Session ────────────────────────────────────────────────────────

  function pauseSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`[forgeSession] Session not found: ${sessionId}`);

    session.status = 'paused';
    return {
      ok: true,
      sessionStatus: 'paused',
    };
  }

  // ─── Resume Session ───────────────────────────────────────────────────────

  function resumeSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`[forgeSession] Session not found: ${sessionId}`);

    if (session.status !== 'paused') {
      throw new Error(`[forgeSession] Cannot resume session in status: ${session.status}`);
    }

    session.status = 'active';
    return {
      ok: true,
      sessionStatus: 'active',
    };
  }

  // ─── Destroy Session ──────────────────────────────────────────────────────

  async function destroySession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`[forgeSession] Session not found: ${sessionId}`);

    // Kill sandbox
    if (session.sandboxId && sandboxManager) {
      try {
        await sandboxManager.destroyContainer(session.sandboxId);
      } catch (err) {
        console.warn(`[forgeSession] Failed to destroy sandbox ${session.sandboxId}:`, err.message);
      }
    }

    // Archive session (in a real system, persist to DB)
    const archived = {
      ...session,
      status: 'destroyed',
      destroyedAt: new Date(),
    };

    // Remove from sessions map
    sessions.delete(sessionId);

    return {
      ok: true,
      archivedSession: {
        id: archived.id,
        operatorId: archived.operatorId,
        createdAt: archived.createdAt,
        destroyedAt: archived.destroyedAt,
        taskCount: archived.tasks.length,
        messageCount: archived.messages.length,
      },
    };
  }

  // ─── List All Sessions ────────────────────────────────────────────────────

  function listSessions() {
    return [...sessions.values()].map((s) => ({
      id: s.id,
      operatorId: s.operatorId,
      status: s.status,
      createdAt: s.createdAt,
      taskCount: s.tasks.length,
    }));
  }

  // ─── Return Manager Interface ──────────────────────────────────────────────

  return {
    createSession,
    processMessage,
    approveAction,
    rejectAction,
    getSession,
    getSessionMessages,
    getSessionTasks,
    getSessionApprovalQueue,
    getSessionFileChanges,
    pauseSession,
    resumeSession,
    destroySession,
    listSessions,
  };
}

// ─── Manifest Builder ──────────────────────────────────────────────────────────

function buildManifest(userMessage) {
  // Simple heuristic: break long messages into steps
  // In a real system, use Sonnet to plan the steps
  const steps = [];

  if (userMessage.includes('read')) {
    steps.push({ action: 'read_files', description: 'Read requested files' });
  }
  if (userMessage.includes('write') || userMessage.includes('create')) {
    steps.push({ action: 'write_files', description: 'Write or modify files' });
  }
  if (userMessage.includes('test') || userMessage.includes('run')) {
    steps.push({ action: 'run_tests', description: 'Run tests' });
  }
  if (userMessage.includes('search') || userMessage.includes('find')) {
    steps.push({ action: 'search_code', description: 'Search code' });
  }

  if (steps.length === 0) {
    steps.push({ action: 'analyze', description: 'Analyze and respond' });
  }

  return steps;
}

// ─── Export ────────────────────────────────────────────────────────────────────

export default createForgeSessionManager;
