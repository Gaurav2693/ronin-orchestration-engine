// ─── middleware/pipeline.mjs ─────────────────────────────────────────────────
// RONIN Middleware Pipeline — Phase 7 CAPSTONE (M8)
//
// Purpose: Wires all 13 middlewares in exact order. Implements the pipeline
// runner: request enters at middleware #1, flows through each in sequence,
// response exits at #13. Each middleware can short-circuit or pass through.
//
// The 13-Middleware Pipeline (order is sacred):
//
//   #1  Surface Adapter       — reads device capabilities, enriches request
//   #2  Thread Data           — injects workspace/uploads paths (STUB)
//   #3  Taste Memory Injector — loads operator taste, injects into prompt
//   #4  Warm Start            — session continuity context (STUB)
//   #5  Skill Loader          — progressive skill loading by domain
//   #6  Dangling Tool Patch   — patches missing ToolMessages (STUB)
//   #7  Context Summarizer    — compresses old messages near token limit
//   #8  Pre-Classifier        — Flash-Lite classifies message for routing
//   #9  Director Gate         — routes /director invocations to Opus
//   #10 Worker Dispatch       — routes to worker based on classification (STUB)
//   #11 Loop Detection        — detects and breaks tool call loops
//   #12 Memory Writer         — queues turn for async memory persistence
//   #13 Response Formatter    — formats response for target surface fidelity
//
// STUB middlewares (#2, #4, #6, #10) are placeholders — they pass through
// without modification. They'll be implemented when their dependencies are
// built (thread system, warm start cache, worker system).
//
// Invariants:
//   - Order is fixed. Changing it breaks the system.
//   - Each middleware follows (request, next) => response contract
//   - Error in one middleware doesn't crash the pipeline — graceful degradation
//   - Director Gate can short-circuit (skips #10-#13)
//   - Timing tracked per middleware
//   - Total cost tracked across the full pipeline
// ─────────────────────────────────────────────────────────────────────────────

// ─── Middleware Slot Names ──────────────────────────────────────────────────

export const PIPELINE_SLOTS = Object.freeze([
  'surfaceAdapter',      // #1
  'threadData',          // #2
  'tasteInjector',       // #3
  'warmStart',           // #4
  'skillLoader',         // #5
  'danglingToolPatch',   // #6
  'contextSummarizer',   // #7
  'preClassifier',       // #8
  'directorGate',        // #9
  'workerDispatch',      // #10
  'loopDetection',       // #11
  'memoryWriter',        // #12
  'responseFormatter',   // #13
]);

// ─── Stub Middleware (passthrough) ──────────────────────────────────────────

function createStub(name) {
  async function stub(request, next) {
    if (typeof next === 'function') {
      return next(request);
    }
    return request;
  }
  stub._isStub = true;
  stub._name = name;
  stub.getMetrics = () => ({ stub: true, name });
  return stub;
}

// ─── Pipeline Runner ────────────────────────────────────────────────────────

/**
 * Execute a chain of middleware functions in order.
 * Each middleware calls next() to pass to the next one.
 * If a middleware doesn't call next(), it short-circuits.
 */
function runChain(middlewares, request) {
  let index = 0;

  function next(req) {
    if (index >= middlewares.length) {
      return req; // End of chain — return the request as-is
    }

    const currentIndex = index;
    const mw = middlewares[currentIndex];
    index++;

    return mw.fn(req, next);
  }

  return next(request);
}

// ─── Pipeline Factory ───────────────────────────────────────────────────────

/**
 * Creates the RONIN Middleware Pipeline.
 *
 * @param {Object} config - Middleware instances or null for stubs
 *   {
 *     surfaceAdapter,       // from gateway/middleware/surfaceAdapter.mjs
 *     threadData,           // stub
 *     tasteInjector,        // from middleware/tasteInjector.mjs
 *     warmStart,            // stub
 *     skillLoader,          // from middleware/skillLoader.mjs
 *     danglingToolPatch,    // stub
 *     contextSummarizer,    // from middleware/contextSummarizer.mjs
 *     preClassifier,        // from middleware/preClassifier.mjs
 *     directorGate,         // from middleware/directorGate.mjs
 *     workerDispatch,       // stub (until Phase 8)
 *     loopDetection,        // from middleware/loopDetection.mjs
 *     memoryWriter,         // from middleware/memoryWriter.mjs
 *     responseFormatter,    // from gateway/middleware/responseFormatter.mjs
 *   }
 * @returns {Object} pipeline API
 */
export function createMiddlewarePipeline(config = {}) {
  // Build the ordered middleware chain
  const chain = PIPELINE_SLOTS.map(slot => ({
    name: slot,
    fn: config[slot] || createStub(slot),
    isStub: !config[slot],
  }));

  // Per-middleware timing
  const timing = {};
  for (const slot of PIPELINE_SLOTS) {
    timing[slot] = { calls: 0, totalMs: 0, errors: 0 };
  }

  // Pipeline-level metrics
  const pipelineMetrics = {
    totalRuns: 0,
    totalErrors: 0,
    shortCircuits: 0,
  };

  // Track short-circuits per run (not per middleware)
  let currentRunShortCircuited = false;

  // Wrap each middleware with timing and error handling
  const instrumentedChain = chain.map(({ name, fn, isStub }) => ({
    name,
    isStub,
    fn: async (request, next) => {
      const start = Date.now();
      timing[name].calls++;

      try {
        const result = await fn(request, next);

        const duration = Date.now() - start;
        timing[name].totalMs += duration;

        // Detect short-circuit: if _director_invoked or _loop_detected,
        // count once per pipeline run, not per middleware
        if ((result?._director_invoked || result?._loop_detected) && !currentRunShortCircuited) {
          pipelineMetrics.shortCircuits++;
          currentRunShortCircuited = true;
        }

        return result;
      } catch (err) {
        timing[name].errors++;
        pipelineMetrics.totalErrors++;

        // Graceful degradation: skip this middleware, pass to next
        if (typeof next === 'function') {
          return next({ ...request, [`_${name}_error`]: err.message });
        }
        return { ...request, [`_${name}_error`]: err.message };
      }
    },
  }));

  // ── Run Pipeline ──────────────────────────────────────────────────

  async function runPipeline(request, context = {}) {
    pipelineMetrics.totalRuns++;
    currentRunShortCircuited = false;

    const enrichedRequest = {
      ...request,
      _pipeline_start: Date.now(),
      ...(context || {}),
    };

    const result = await runChain(instrumentedChain, enrichedRequest);

    return {
      ...result,
      _pipeline_duration: Date.now() - enrichedRequest._pipeline_start,
      _pipeline_run: pipelineMetrics.totalRuns,
    };
  }

  // ── Metrics ───────────────────────────────────────────────────────

  function getPipelineMetrics() {
    return {
      ...pipelineMetrics,
      perMiddleware: { ...timing },
    };
  }

  function getSlotInfo() {
    return chain.map(({ name, isStub }) => ({
      name,
      position: PIPELINE_SLOTS.indexOf(name) + 1,
      isStub,
    }));
  }

  // ── Slot Replacement (for dynamic wiring) ─────────────────────────

  function replaceSlot(slotName, newMiddleware) {
    const idx = instrumentedChain.findIndex(m => m.name === slotName);
    if (idx === -1) throw new Error(`Unknown pipeline slot: ${slotName}`);

    const original = instrumentedChain[idx];
    instrumentedChain[idx] = {
      ...original,
      isStub: false,
      fn: async (request, next) => {
        const start = Date.now();
        timing[slotName].calls++;
        try {
          const result = await newMiddleware(request, next);
          timing[slotName].totalMs += Date.now() - start;
          if (result?._director_invoked || result?._loop_detected) {
            pipelineMetrics.shortCircuits++;
          }
          return result;
        } catch (err) {
          timing[slotName].errors++;
          pipelineMetrics.totalErrors++;
          if (typeof next === 'function') {
            return next({ ...request, [`_${slotName}_error`]: err.message });
          }
          return { ...request, [`_${slotName}_error`]: err.message };
        }
      },
    };
  }

  // ── Shutdown ──────────────────────────────────────────────────────

  function shutdown() {
    for (const { fn } of instrumentedChain) {
      if (fn.shutdown) fn.shutdown();
    }
    // Also check originals
    for (const slot of PIPELINE_SLOTS) {
      const mw = config[slot];
      if (mw && mw.shutdown) mw.shutdown();
    }
  }

  // ── Public API ────────────────────────────────────────────────────

  return {
    runPipeline,
    getPipelineMetrics,
    getSlotInfo,
    replaceSlot,
    shutdown,
    SLOTS: PIPELINE_SLOTS,
  };
}
