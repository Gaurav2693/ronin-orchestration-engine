// ─── workers/workerInterface.mjs ──────────────────────────────────────────────
// RONIN Worker System — Phase 8 (W1)
//
// Purpose: Defines the universal worker contract and the worker registry.
// Every worker implements the same interface. The registry maps worker types
// to implementations and handles health checks, metrics, and fallback chains.
//
// Contract: Every worker must implement:
//   async execute(task, context) → { result, cost, duration, model, metadata }
//
// Workers are invisible sub-agents (ADR-010). The operator never sees them.
// Sonnet orchestrates; workers execute. Model identity is NEVER exposed.
//
// Worker Types:
//   FAST   — Gemini Flash-Lite (free) — simple queries, status checks
//   VISION — Gemini 2.5 Flash (free) — screenshots, Figma, image input
//   AGENT  — GPT-4o ($) — multi-step build tasks, file operations
//   DEEP   — o3-mini ($$) — complex reasoning, async only
//   CODEX  — GPT-4o-mini ($) — multi-file code gen, sandboxed execution
//   LOCAL  — Ollama (free) — simple edits, boilerplate, home network only
// ─────────────────────────────────────────────────────────────────────────────

// ─── Worker Types ─────────────────────────────────────────────────────────────

export const WORKER_TYPES = Object.freeze({
  FAST: 'fast',
  VISION: 'vision',
  AGENT: 'agent',
  DEEP: 'deep',
  CODEX: 'codex',
  LOCAL: 'local',
});

// ─── Worker States ────────────────────────────────────────────────────────────

export const WORKER_STATES = Object.freeze({
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  UNHEALTHY: 'unhealthy',
});

// ─── Default Fallback Chain ───────────────────────────────────────────────────
// When preferred worker is unavailable, try the next in chain.
// Cost-first: always try free before paid.

export const FALLBACK_CHAINS = Object.freeze({
  fast:   ['fast'],                    // flash-lite only — local is explicit via pre-classifier
  vision: ['vision'],                  // no fallback — vision is unique
  agent:  ['agent', 'fast'],          // downgrade to fast if agent unhealthy
  deep:   ['deep', 'agent'],          // downgrade to agent if deep unavailable
  codex:  ['codex', 'agent'],         // downgrade to agent if sandbox unavailable
  local:  ['local', 'fast'],          // if ollama down, use flash-lite
});

// ─── Validate Worker Implementation ───────────────────────────────────────────

export function validateWorkerContract(worker, type) {
  const errors = [];

  if (typeof worker !== 'object' || worker === null) {
    return { valid: false, errors: ['Worker must be a non-null object'] };
  }

  if (typeof worker.execute !== 'function') {
    errors.push('Worker must implement async execute(task, context)');
  }

  if (typeof worker.getHealth !== 'function') {
    errors.push('Worker must implement getHealth() → { status, latency, lastCheck }');
  }

  if (typeof worker.getMetrics !== 'function') {
    errors.push('Worker must implement getMetrics() → { calls, totalCost, avgDuration, errors }');
  }

  if (worker.type !== type) {
    errors.push(`Worker.type must be "${type}", got "${worker.type}"`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// ─── Create Base Worker ───────────────────────────────────────────────────────
// Factory that provides common metrics tracking + health monitoring.
// Concrete workers wrap their provider-specific logic around this base.

export function createBaseWorker(type, executeFn, config = {}) {
  const metrics = {
    calls: 0,
    successes: 0,
    errors: 0,
    totalCost: 0,
    totalDurationMs: 0,
    lastCallAt: null,
    lastErrorAt: null,
    lastError: null,
  };

  let healthStatus = WORKER_STATES.HEALTHY;
  let lastHealthCheck = Date.now();
  let consecutiveErrors = 0;
  const maxConsecutiveErrors = config.maxConsecutiveErrors || 3;
  const healthCheckIntervalMs = config.healthCheckIntervalMs || 60_000;

  // ── Execute with metrics tracking ────────────────────────────────

  async function execute(task, context = {}) {
    metrics.calls++;
    metrics.lastCallAt = Date.now();
    const start = Date.now();

    try {
      const result = await executeFn(task, context);
      const duration = Date.now() - start;

      metrics.successes++;
      metrics.totalDurationMs += duration;
      metrics.totalCost += result.cost || 0;
      consecutiveErrors = 0;

      if (healthStatus === WORKER_STATES.DEGRADED) {
        healthStatus = WORKER_STATES.HEALTHY;
      }

      return {
        ...result,
        duration: result.duration || duration,
        worker: type,
        model_hidden: true, // ADR-010: never expose model identity
      };
    } catch (err) {
      const duration = Date.now() - start;
      metrics.errors++;
      metrics.totalDurationMs += duration;
      metrics.lastErrorAt = Date.now();
      metrics.lastError = err.message;
      consecutiveErrors++;

      if (consecutiveErrors >= maxConsecutiveErrors) {
        healthStatus = WORKER_STATES.UNHEALTHY;
      } else if (consecutiveErrors >= Math.ceil(maxConsecutiveErrors / 2)) {
        healthStatus = WORKER_STATES.DEGRADED;
      }

      throw err;
    }
  }

  // ── Health check ─────────────────────────────────────────────────

  function getHealth() {
    lastHealthCheck = Date.now();
    return {
      status: healthStatus,
      consecutiveErrors,
      lastCallAt: metrics.lastCallAt,
      lastErrorAt: metrics.lastErrorAt,
      lastError: metrics.lastError,
      lastCheck: lastHealthCheck,
    };
  }

  function setHealth(status) {
    if (!Object.values(WORKER_STATES).includes(status)) {
      throw new Error(`Invalid health status: ${status}`);
    }
    healthStatus = status;
    if (status === WORKER_STATES.HEALTHY) {
      consecutiveErrors = 0;
    }
  }

  // ── Metrics ──────────────────────────────────────────────────────

  function getMetrics() {
    return {
      type,
      calls: metrics.calls,
      successes: metrics.successes,
      errors: metrics.errors,
      totalCost: metrics.totalCost,
      avgDurationMs: metrics.calls > 0
        ? Math.round(metrics.totalDurationMs / metrics.calls)
        : 0,
      errorRate: metrics.calls > 0
        ? (metrics.errors / metrics.calls)
        : 0,
      lastCallAt: metrics.lastCallAt,
    };
  }

  function resetMetrics() {
    metrics.calls = 0;
    metrics.successes = 0;
    metrics.errors = 0;
    metrics.totalCost = 0;
    metrics.totalDurationMs = 0;
    metrics.lastCallAt = null;
    metrics.lastErrorAt = null;
    metrics.lastError = null;
    consecutiveErrors = 0;
    healthStatus = WORKER_STATES.HEALTHY;
  }

  return {
    type,
    execute,
    getHealth,
    setHealth,
    getMetrics,
    resetMetrics,
  };
}

// ─── Worker Registry ──────────────────────────────────────────────────────────

export function createWorkerRegistry(config = {}) {
  const workers = new Map();
  const fallbackChains = config.fallbackChains || FALLBACK_CHAINS;

  // ── Register ─────────────────────────────────────────────────────

  function register(type, worker) {
    if (!Object.values(WORKER_TYPES).includes(type)) {
      throw new Error(`[workerRegistry] Unknown worker type: "${type}". Valid: ${Object.values(WORKER_TYPES).join(', ')}`);
    }

    const validation = validateWorkerContract(worker, type);
    if (!validation.valid) {
      throw new Error(`[workerRegistry] Invalid worker for "${type}": ${validation.errors.join('; ')}`);
    }

    workers.set(type, worker);
  }

  // ── Get worker (with fallback chain) ─────────────────────────────

  function getWorker(type) {
    const worker = workers.get(type);
    if (!worker) {
      throw new Error(`[workerRegistry] No worker registered for type: "${type}". Registered: ${[...workers.keys()].join(', ') || 'none'}`);
    }
    return worker;
  }

  function getWorkerWithFallback(type) {
    const chain = fallbackChains[type] || [type];

    for (const candidateType of chain) {
      const worker = workers.get(candidateType);
      if (!worker) continue;

      const health = worker.getHealth();
      if (health.status !== WORKER_STATES.UNHEALTHY) {
        return { worker, resolvedType: candidateType, fellBack: candidateType !== type };
      }
    }

    // All workers in chain unhealthy — return first registered anyway
    const firstRegistered = workers.get(chain[0]) || workers.get(type);
    if (firstRegistered) {
      return { worker: firstRegistered, resolvedType: firstRegistered.type, fellBack: true, forced: true };
    }

    throw new Error(`[workerRegistry] No healthy worker in fallback chain for "${type}"`);
  }

  // ── Has ──────────────────────────────────────────────────────────

  function hasWorker(type) {
    return workers.has(type);
  }

  // ── Deregister ───────────────────────────────────────────────────

  function deregister(type) {
    return workers.delete(type);
  }

  // ── Health status ────────────────────────────────────────────────

  function getHealthStatus() {
    const status = {};
    for (const [type, worker] of workers) {
      status[type] = worker.getHealth();
    }
    return status;
  }

  // ── Aggregate metrics ────────────────────────────────────────────

  function getAllMetrics() {
    const metrics = {};
    for (const [type, worker] of workers) {
      metrics[type] = worker.getMetrics();
    }
    return metrics;
  }

  function getTotalCost() {
    let total = 0;
    for (const [_, worker] of workers) {
      total += worker.getMetrics().totalCost;
    }
    return total;
  }

  // ── List ─────────────────────────────────────────────────────────

  function listWorkers() {
    return [...workers.keys()];
  }

  function getRegisteredCount() {
    return workers.size;
  }

  // ── Shutdown ─────────────────────────────────────────────────────

  function shutdown() {
    for (const [type, worker] of workers) {
      if (typeof worker.shutdown === 'function') {
        worker.shutdown();
      }
    }
    workers.clear();
  }

  return {
    register,
    getWorker,
    getWorkerWithFallback,
    hasWorker,
    deregister,
    getHealthStatus,
    getAllMetrics,
    getTotalCost,
    listWorkers,
    getRegisteredCount,
    shutdown,
  };
}
