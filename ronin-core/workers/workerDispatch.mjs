// ─── workers/workerDispatch.mjs ───────────────────────────────────────────────
// RONIN Worker System — Phase 8 (W8) — CAPSTONE
//
// Worker Dispatch: Middleware #10 in the pipeline. Connects the pre-classifier's
// routing decision to actual worker execution. Receives the classification,
// selects the appropriate worker from the registry, executes, and returns
// the result to the pipeline.
//
// This is the invisible routing layer. The operator never knows which worker
// handled their request. Model identity is NEVER exposed (ADR-010).
//
// Dispatch Logic:
//   1. Read classification from request._classification (set by pre-classifier)
//   2. Determine target worker type from classification.suggestedWorker
//   3. Try to get healthy worker from registry (with fallback chain)
//   4. If worker returns fallback signal (local → fast), re-dispatch
//   5. If worker returns escalation signal, re-dispatch to more capable worker
//   6. Track dispatch metrics per worker type
//   7. Attach result to request for downstream middleware
// ─────────────────────────────────────────────────────────────────────────────

import { WORKER_TYPES, WORKER_STATES } from './workerInterface.mjs';

// ─── Escalation Map ───────────────────────────────────────────────────────────
// When a worker says "this needs deeper analysis", escalate to the next tier.

const ESCALATION_MAP = Object.freeze({
  fast: 'agent',
  local: 'fast',
  vision: 'agent',
  agent: 'deep',
  codex: 'agent',
  deep: null, // nowhere to escalate — fail with quality warning
});

// ─── Worker Dispatch Factory ──────────────────────────────────────────────────

export function createWorkerDispatch(workerRegistry, config = {}) {
  const maxEscalations = config.maxEscalations || 2;
  const enableEscalation = config.enableEscalation !== false;
  const costGuardrail = config.costGuardrail || null; // optional cost check

  // ── Dispatch Metrics ─────────────────────────────────────────────

  const metrics = {
    totalDispatches: 0,
    workerCounts: {},
    fallbackCount: 0,
    escalationCount: 0,
    totalCost: 0,
    errors: 0,
  };

  // ── Middleware Function ──────────────────────────────────────────

  async function middleware(request) {
    metrics.totalDispatches++;

    const classification = request._classification || {};
    const targetWorker = classification.suggestedWorker || WORKER_TYPES.FAST;

    try {
      const result = await dispatch(targetWorker, request, 0);

      // Attach result to request for downstream middleware
      return {
        ...request,
        _worker_result: result.result,
        _worker_cost: result.cost,
        _worker_type: result.resolvedWorker,
        _worker_duration: result.duration,
        _worker_metadata: result.metadata || {},
        _dispatched: true,
      };
    } catch (err) {
      metrics.errors++;
      return {
        ...request,
        _worker_error: err.message,
        _dispatched: false,
      };
    }
  }

  // ── Core Dispatch Logic ──────────────────────────────────────────

  async function dispatch(workerType, request, escalationDepth, _visited = new Set()) {
    // Prevent infinite dispatch loops
    if (_visited.has(workerType)) {
      throw new Error(`[workerDispatch] Circular dispatch detected: ${[..._visited, workerType].join(' → ')}`);
    }
    _visited.add(workerType);

    // Get worker with fallback chain
    const { worker, resolvedType, fellBack } = resolveWorker(workerType);

    if (fellBack) {
      metrics.fallbackCount++;
    }

    // Cost guardrail check
    if (costGuardrail && typeof costGuardrail.canAfford === 'function') {
      const canAfford = await costGuardrail.canAfford(resolvedType);
      if (!canAfford) {
        // Downgrade to cheapest available
        const cheapWorker = findCheapestWorker();
        if (cheapWorker && cheapWorker !== resolvedType) {
          return dispatch(cheapWorker, request, escalationDepth, _visited);
        }
      }
    }

    // Build task from request
    const task = buildTask(request);
    const context = buildContext(request);

    // Execute
    const result = await worker.execute(task, context);

    // Track metrics
    metrics.workerCounts[resolvedType] = (metrics.workerCounts[resolvedType] || 0) + 1;
    metrics.totalCost += result.cost || 0;

    // Handle fallback signal from local worker
    if (result.unavailable && result.fallback) {
      metrics.fallbackCount++;
      return dispatch(result.fallback, request, escalationDepth, _visited);
    }

    // Handle escalation
    if (enableEscalation && result.needsEscalation && escalationDepth < maxEscalations) {
      const escalateTo = ESCALATION_MAP[resolvedType];
      if (escalateTo) {
        metrics.escalationCount++;
        return dispatch(escalateTo, request, escalationDepth + 1, _visited);
      }
    }

    return {
      result: result.result,
      cost: result.cost || 0,
      resolvedWorker: resolvedType,
      requestedWorker: workerType,
      fellBack,
      escalated: escalationDepth > 0,
      escalationDepth,
      duration: result.duration || 0,
      async: result.async || false,
      jobId: result.jobId || null,
      metadata: {
        model_hidden: true,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        ...(result.analysis ? { analysis: result.analysis } : {}),
        ...(result.toolCalls ? { toolCalls: result.toolCalls } : {}),
        ...(result.artifacts ? { artifacts: result.artifacts } : {}),
      },
    };
  }

  // ── Worker Resolution ────────────────────────────────────────────

  function resolveWorker(workerType) {
    try {
      return workerRegistry.getWorkerWithFallback(workerType);
    } catch {
      // No worker in chain — try fast as ultimate fallback
      if (workerType !== WORKER_TYPES.FAST && workerRegistry.hasWorker(WORKER_TYPES.FAST)) {
        return {
          worker: workerRegistry.getWorker(WORKER_TYPES.FAST),
          resolvedType: WORKER_TYPES.FAST,
          fellBack: true,
        };
      }
      throw new Error(`[workerDispatch] No worker available for "${workerType}"`);
    }
  }

  function findCheapestWorker() {
    const FREE_WORKERS = [WORKER_TYPES.LOCAL, WORKER_TYPES.FAST, WORKER_TYPES.VISION];
    for (const type of FREE_WORKERS) {
      if (workerRegistry.hasWorker(type)) {
        const worker = workerRegistry.getWorker(type);
        if (worker.getHealth().status !== WORKER_STATES.UNHEALTHY) {
          return type;
        }
      }
    }
    return null;
  }

  // ── Task/Context Builders ────────────────────────────────────────

  function buildTask(request) {
    return {
      message: request.message || request.content || '',
      image: request.image || null,
      frames: request.frames || null,
      manifest: request.manifest || null,
      commands: request.commands || null,
      mode: request._classification?.modality || 'general',
      existingCode: request.existingCode || null,
      fileStructure: request.fileStructure || null,
    };
  }

  function buildContext(request) {
    return {
      history: request.history || [],
      taste_block: request._taste_block || null,
      skills: request._loaded_skills || null,
      session_id: request.session_id || null,
    };
  }

  // ── Metrics ──────────────────────────────────────────────────────

  function getDispatchMetrics() {
    return { ...metrics };
  }

  function resetMetrics() {
    metrics.totalDispatches = 0;
    metrics.workerCounts = {};
    metrics.fallbackCount = 0;
    metrics.escalationCount = 0;
    metrics.totalCost = 0;
    metrics.errors = 0;
  }

  return {
    middleware,
    dispatch,
    getDispatchMetrics,
    resetMetrics,
    _resolveWorker: resolveWorker,
    _findCheapestWorker: findCheapestWorker,
  };
}
