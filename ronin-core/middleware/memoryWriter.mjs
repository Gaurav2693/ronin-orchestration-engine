// ─── middleware/memoryWriter.mjs ─────────────────────────────────────────────
// RONIN Middleware #12 — Memory Writer (M7)
//
// Purpose: After each response, queues the conversation turn for async memory
// update. Does NOT block the main conversation. Debounced — batches writes
// every N ms. Feeds the nightly compressor.
//
// How it works:
//   1. Response comes through the pipeline
//   2. Memory Writer extracts the turn (user message + assistant response)
//   3. Queues the turn for async write
//   4. Returns immediately — never blocks
//   5. On timer tick (or flush), executes batched writes
//
// Integration: Uses existing memoryManager.mjs (V8) as the storage backend.
//
// Invariants:
//   - Never blocks the response pipeline
//   - Debounced writes (default 30s interval)
//   - Batch multiple turns into one write
//   - Queue is bounded (max 100 pending turns)
//   - flush() forces all pending writes immediately
// ─────────────────────────────────────────────────────────────────────────────

// ─── Constants ──────────────────────────────────────────────────────────────

export const DEFAULT_DEBOUNCE_MS = 30000; // 30 seconds
export const DEFAULT_MAX_QUEUE = 100;

// ─── Queue ──────────────────────────────────────────────────────────────────

function createWriteQueue(maxSize = DEFAULT_MAX_QUEUE) {
  const items = [];

  return {
    push(item) {
      if (items.length >= maxSize) {
        items.shift(); // drop oldest if full
      }
      items.push(item);
    },
    drain() {
      return items.splice(0, items.length);
    },
    size() {
      return items.length;
    },
    clear() {
      items.length = 0;
    },
  };
}

// ─── Turn Extraction ────────────────────────────────────────────────────────

/**
 * Extract a memory-writable turn from request and response.
 */
export function extractTurn(request, response) {
  return {
    session_id: request?.session_id || 'default',
    timestamp: Date.now(),
    user_message: request?.message || request?.content || '',
    assistant_response: response?.content || response?.text || '',
    classification: request?.classification || null,
    taste_injected: request?._taste_injected || false,
    skills_loaded: request?._skills_loaded || [],
  };
}

// ─── Middleware Factory ─────────────────────────────────────────────────────

/**
 * Creates the Memory Writer middleware.
 *
 * @param {Object} memoryManager - object with async write(key, data) method
 * @param {Object} config - { debounceMs, maxQueue }
 * @returns {Function} middleware(request, next) => response
 */
export function createMemoryWriter(memoryManager = null, config = {}) {
  const debounceMs = config.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const maxQueue = config.maxQueue ?? DEFAULT_MAX_QUEUE;
  const queue = createWriteQueue(maxQueue);

  let debounceTimer = null;
  let writeInProgress = false;

  const metrics = {
    turnsQueued: 0,
    turnsWritten: 0,
    flushes: 0,
    writeErrors: 0,
    droppedTurns: 0,
  };

  // ── Debounced Writer ──────────────────────────────────────────────

  function scheduleWrite() {
    if (debounceTimer) return; // already scheduled
    if (debounceMs <= 0) return; // disabled

    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      _executeWrite();
    }, debounceMs);
  }

  async function _executeWrite() {
    if (writeInProgress) return;
    if (queue.size() === 0) return;

    writeInProgress = true;
    const batch = queue.drain();

    try {
      if (memoryManager && typeof memoryManager.write === 'function') {
        // Write each turn
        for (const turn of batch) {
          const key = `memory:turn:${turn.session_id}:${turn.timestamp}`;
          await memoryManager.write(key, turn);
        }
        metrics.turnsWritten += batch.length;
      } else {
        // No backend — turns are dropped silently
        metrics.droppedTurns += batch.length;
      }
    } catch (err) {
      metrics.writeErrors++;
      // Put failed turns back in queue? No — drop them to avoid infinite retry
      metrics.droppedTurns += batch.length;
    } finally {
      writeInProgress = false;
    }
  }

  // ── Public flush ──────────────────────────────────────────────────

  async function flush() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    metrics.flushes++;
    await _executeWrite();
  }

  // ── Middleware ─────────────────────────────────────────────────────

  async function middleware(request, next) {
    // Pass through to get the response first
    let response;
    if (typeof next === 'function') {
      response = await next(request);
    } else {
      response = request;
    }

    // Queue the turn (non-blocking)
    const turn = extractTurn(request, response);
    queue.push(turn);
    metrics.turnsQueued++;

    // Schedule a debounced write
    scheduleWrite();

    // Return the response immediately — never block
    return response;
  }

  // ── Shutdown ──────────────────────────────────────────────────────

  function shutdown() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    queue.clear();
  }

  // ── Attach control methods ────────────────────────────────────────

  middleware.flush = flush;
  middleware.getQueueDepth = () => queue.size();
  middleware.getMetrics = () => ({ ...metrics });
  middleware.shutdown = shutdown;

  return middleware;
}
