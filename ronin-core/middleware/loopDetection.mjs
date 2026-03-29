// ─── middleware/loopDetection.mjs ────────────────────────────────────────────
// RONIN Middleware #11 — Loop Detection (M5)
//
// Purpose: Monitors tool call patterns across a conversation. If the same
// tool is called with identical arguments 3+ times, or if more than N
// consecutive tool calls occur without user interaction, the middleware
// breaks the loop and returns a structured error for recovery.
//
// Why this matters:
//   Agent workers can enter infinite loops — calling the same tool
//   repeatedly, or cycling through tool calls without making progress.
//   This middleware catches it before the cost spirals.
//
// Detection strategies:
//   1. Duplicate detection: same tool + same args → 3 strikes = loop
//   2. Consecutive count: 10+ tool calls without user message = probable loop
//   3. Cycle detection: A→B→A→B pattern repeated 3+ times = loop
//
// Invariants:
//   - Never blocks legitimate long tool chains (10 is generous)
//   - Resets on user interaction
//   - Provides structured recovery suggestion
//   - Per-session tracking (no cross-session contamination)
// ─────────────────────────────────────────────────────────────────────────────

// ─── Constants ──────────────────────────────────────────────────────────────

export const DEFAULT_DUPLICATE_THRESHOLD = 3;
export const DEFAULT_CONSECUTIVE_LIMIT = 10;
export const DEFAULT_CYCLE_THRESHOLD = 3;

// ─── Loop Detection Logic ───────────────────────────────────────────────────

/**
 * Create a fingerprint for a tool call (tool name + stringified args).
 */
export function fingerprint(toolName, args) {
  const argsStr = args != null ? JSON.stringify(args) : '';
  return `${toolName}::${argsStr}`;
}

/**
 * Detect loops in a tool call history.
 *
 * @param {Array} history - Array of { tool, args } objects
 * @param {Object} config - thresholds
 * @returns {{ isLoop: boolean, pattern: string|null, suggestion: string }}
 */
export function detectLoop(history, config = {}) {
  const dupThreshold = config.duplicateThreshold ?? DEFAULT_DUPLICATE_THRESHOLD;
  const consecutiveLimit = config.consecutiveLimit ?? DEFAULT_CONSECUTIVE_LIMIT;
  const cycleThreshold = config.cycleThreshold ?? DEFAULT_CYCLE_THRESHOLD;

  if (!history || history.length === 0) {
    return { isLoop: false, pattern: null, suggestion: null };
  }

  // ── Strategy 1: Duplicate detection ─────────────────────────────
  const fpCounts = new Map();
  for (const call of history) {
    const fp = fingerprint(call.tool, call.args);
    fpCounts.set(fp, (fpCounts.get(fp) || 0) + 1);
  }

  for (const [fp, count] of fpCounts) {
    if (count >= dupThreshold) {
      const toolName = fp.split('::')[0];
      return {
        isLoop: true,
        pattern: 'duplicate',
        tool: toolName,
        count,
        suggestion: `Tool "${toolName}" called ${count} times with identical arguments. Try a different approach or modify the arguments.`,
      };
    }
  }

  // ── Strategy 2: Consecutive count ───────────────────────────────
  if (history.length >= consecutiveLimit) {
    return {
      isLoop: true,
      pattern: 'consecutive',
      count: history.length,
      suggestion: `${history.length} consecutive tool calls without user interaction. Break the chain and summarize progress so far.`,
    };
  }

  // ── Strategy 3: Cycle detection (A→B→A→B pattern) ───────────────
  if (history.length >= 4) {
    const cycle = detectCycle(history, cycleThreshold);
    if (cycle) {
      return {
        isLoop: true,
        pattern: 'cycle',
        cycle: cycle.sequence,
        repetitions: cycle.repetitions,
        suggestion: `Detected repeating cycle: ${cycle.sequence.join(' → ')}. Break the pattern by trying a fundamentally different approach.`,
      };
    }
  }

  return { isLoop: false, pattern: null, suggestion: null };
}

/**
 * Detect A→B→A→B style cycles in tool call history.
 */
function detectCycle(history, threshold) {
  // Try cycle lengths from 2 up to half the history
  const maxCycleLen = Math.floor(history.length / 2);

  for (let cycleLen = 2; cycleLen <= maxCycleLen; cycleLen++) {
    const cycle = history.slice(history.length - cycleLen).map(c => c.tool);
    let repetitions = 0;

    // Count how many times this cycle repeats at the end of history
    for (let offset = history.length - cycleLen; offset >= 0; offset -= cycleLen) {
      const segment = history.slice(offset, offset + cycleLen).map(c => c.tool);
      if (segment.length === cycle.length && segment.every((t, i) => t === cycle[i])) {
        repetitions++;
      } else {
        break;
      }
    }

    if (repetitions >= threshold) {
      return { sequence: cycle, repetitions };
    }
  }

  return null;
}

// ─── Session Tracker ────────────────────────────────────────────────────────

function createSessionTracker() {
  // sessionId → { toolCalls: [], lastUserMessage: timestamp }
  const sessions = new Map();

  function getOrCreate(sessionId) {
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, { toolCalls: [], lastUserMessage: Date.now() });
    }
    return sessions.get(sessionId);
  }

  function addToolCall(sessionId, tool, args) {
    const session = getOrCreate(sessionId);
    session.toolCalls.push({ tool, args, ts: Date.now() });
  }

  function onUserMessage(sessionId) {
    const session = getOrCreate(sessionId);
    session.toolCalls = []; // Reset on user interaction
    session.lastUserMessage = Date.now();
  }

  function getHistory(sessionId) {
    return getOrCreate(sessionId).toolCalls;
  }

  function reset(sessionId) {
    sessions.delete(sessionId);
  }

  function clear() {
    sessions.clear();
  }

  function sessionCount() {
    return sessions.size;
  }

  return { addToolCall, onUserMessage, getHistory, reset, clear, sessionCount };
}

// ─── Middleware Factory ─────────────────────────────────────────────────────

/**
 * Creates the Loop Detection middleware.
 *
 * @param {Object} config - { duplicateThreshold, consecutiveLimit, cycleThreshold }
 * @returns {Function} middleware(request, next) => response
 */
export function createLoopDetector(config = {}) {
  const tracker = createSessionTracker();

  const metrics = {
    loopsDetected: 0,
    duplicateLoops: 0,
    consecutiveLoops: 0,
    cycleLoops: 0,
    totalChecks: 0,
  };

  async function middleware(request, next) {
    const sessionId = request?.session_id || 'default';

    // If this is a user message, reset the tool call history
    if (request?.type === 'user' || request?.role === 'user') {
      tracker.onUserMessage(sessionId);
    }

    // If this request includes tool calls, track them
    const toolCalls = request?.tool_calls || [];
    for (const call of toolCalls) {
      tracker.addToolCall(sessionId, call.tool || call.name, call.args || call.arguments);
    }

    // Check for loops
    const history = tracker.getHistory(sessionId);
    metrics.totalChecks++;

    if (history.length > 0) {
      const detection = detectLoop(history, config);

      if (detection.isLoop) {
        metrics.loopsDetected++;
        if (detection.pattern === 'duplicate') metrics.duplicateLoops++;
        else if (detection.pattern === 'consecutive') metrics.consecutiveLoops++;
        else if (detection.pattern === 'cycle') metrics.cycleLoops++;

        // Reset the session to break the loop
        tracker.onUserMessage(sessionId);

        // Return structured error for recovery
        return {
          _loop_detected: true,
          _loop_pattern: detection.pattern,
          _loop_suggestion: detection.suggestion,
          error: `Loop detected (${detection.pattern}): ${detection.suggestion}`,
          content: detection.suggestion,
        };
      }
    }

    if (typeof next === 'function') {
      return next(request);
    }
    return request;
  }

  middleware.getMetrics = () => ({ ...metrics });
  middleware.getTracker = () => tracker;
  middleware.resetSession = (sessionId) => tracker.reset(sessionId);

  return middleware;
}
