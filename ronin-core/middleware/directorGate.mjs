// ─── middleware/directorGate.mjs ─────────────────────────────────────────────
// RONIN Middleware #9 — Director Gate (M3)
//
// Purpose: Intercepts requests that invoke the Creative Director (Opus).
// The Director is RONIN's second seat — the expensive, opinionated advisor
// called only when the operator explicitly asks for a second opinion.
//
// Trigger patterns:
//   - /director <message>
//   - /opus <message>
//   - "get the director's take"
//   - "what would the director say"
//   - "ask the creative director"
//   - "second opinion on this"
//
// When triggered:
//   1. Extracts the actual query from the trigger
//   2. Builds a consultant brief (structured prompt for Opus)
//   3. Routes to Opus provider instead of the normal pipeline
//   4. Returns the Director's response — short-circuits remaining middleware
//
// Invariants:
//   - Normal messages pass through completely unchanged
//   - Director calls are tracked separately for cost
//   - Model identity never leaks — response is attributed to "RONIN Director"
//   - Enforces ADR-002 (two-seat model: Sonnet primary, Opus on-demand)
// ─────────────────────────────────────────────────────────────────────────────

// ─── Director Trigger Patterns ──────────────────────────────────────────────

const COMMAND_TRIGGERS = [
  /^\/director\s+/i,
  /^\/opus\s+/i,
  /^\/creative\s+/i,
];

const PHRASE_TRIGGERS = [
  /\b(get|ask|hear|want)\s+(the\s+)?director'?s?\s+(take|opinion|view|perspective|thoughts?)\b/i,
  /\b(what would|what does)\s+(the\s+)?director\s+(say|think|suggest|recommend)\b/i,
  /\bask\s+(the\s+)?(creative\s+)?director\b/i,
  /\bsecond opinion\s+(on|about|for)\b/i,
  /\bdirector,?\s+(what|how|should|can|could|would)\b/i,
];

// ─── Director Detection ─────────────────────────────────────────────────────

/**
 * Check if a message is a Director invocation.
 * Returns { isDirector, query, trigger } or { isDirector: false }.
 */
export function isDirectorInvocation(message) {
  if (!message || typeof message !== 'string') {
    return { isDirector: false };
  }

  const text = message.trim();

  // Check command triggers first (highest confidence)
  for (const pattern of COMMAND_TRIGGERS) {
    if (pattern.test(text)) {
      const query = text.replace(pattern, '').trim();
      return {
        isDirector: true,
        query: query || text,
        trigger: 'command',
        pattern: pattern.source,
      };
    }
  }

  // Check phrase triggers
  for (const pattern of PHRASE_TRIGGERS) {
    if (pattern.test(text)) {
      return {
        isDirector: true,
        query: text,
        trigger: 'phrase',
        pattern: pattern.source,
      };
    }
  }

  return { isDirector: false };
}

// ─── Consultant Brief ───────────────────────────────────────────────────────

/**
 * Build a consultant brief for the Director (Opus).
 * This is the structured prompt that frames Opus as an opinionated advisor.
 */
export function buildConsultantBrief(query, context = {}) {
  const parts = [];

  parts.push('You are the RONIN Creative Director — an opinionated, senior advisor.');
  parts.push('The operator has explicitly invoked you for a considered opinion.');
  parts.push('Be direct. Be specific. Push back if the approach is wrong.');
  parts.push('Do NOT hedge or give lists of options — give your actual recommendation.');
  parts.push('');

  // Taste context (if available)
  if (context.taste_narrative) {
    parts.push('## Operator Taste Profile');
    parts.push(context.taste_narrative);
    parts.push('');
  }

  // Current project context
  if (context.project) {
    parts.push(`## Current Project: ${context.project}`);
  }

  if (context.current_gate) {
    parts.push(`## Current Gate: ${context.current_gate}`);
  }

  // Conversation summary (if available)
  if (context.conversation_summary) {
    parts.push('## Recent Conversation');
    parts.push(context.conversation_summary);
    parts.push('');
  }

  parts.push('## Operator Query');
  parts.push(query);

  return parts.join('\n');
}

// ─── Director Response Wrapper ──────────────────────────────────────────────

/**
 * Wrap the Director's raw response to ensure model identity is hidden.
 */
export function wrapDirectorResponse(rawResponse) {
  if (!rawResponse || typeof rawResponse !== 'string') {
    return {
      content: 'The Director has no opinion on this.',
      source: 'director',
      model_hidden: true,
    };
  }

  return {
    content: rawResponse,
    source: 'director',
    model_hidden: true,
  };
}

// ─── Middleware Factory ─────────────────────────────────────────────────────

/**
 * Creates the Director Gate middleware.
 *
 * @param {Function|null} opusProvider - async (prompt) => response string
 * @param {Object} config - { maxTokens }
 * @returns {Function} middleware(request, next) => response
 */
export function createDirectorGate(opusProvider = null, config = {}) {
  const metrics = {
    directorInvocations: 0,
    directorPassthroughs: 0,
    directorErrors: 0,
    totalCost: 0,
  };

  async function middleware(request, next) {
    const message = request?.message || request?.content || '';
    const detection = isDirectorInvocation(message);

    if (!detection.isDirector) {
      metrics.directorPassthroughs++;
      if (typeof next === 'function') {
        return next(request);
      }
      return request;
    }

    // ── Director invocation — short-circuit the pipeline ────────
    metrics.directorInvocations++;

    if (!opusProvider || typeof opusProvider !== 'function') {
      return {
        ...wrapDirectorResponse('The Director is currently unavailable. No Opus provider configured.'),
        _director_invoked: true,
        _director_available: false,
      };
    }

    const context = {
      taste_narrative: request?.system_prompt_taste || request?._taste_narrative || '',
      project: request?.project || '',
      current_gate: request?.current_gate || '',
      conversation_summary: request?.conversation_summary || '',
    };

    const brief = buildConsultantBrief(detection.query, context);

    try {
      const startTime = Date.now();
      const rawResponse = await opusProvider(brief);
      const duration = Date.now() - startTime;

      // Estimate cost (Opus: ~$15/MTok input, ~$75/MTok output)
      const estimatedCost = (brief.length / 4 * 15 + (rawResponse?.length || 0) / 4 * 75) / 1_000_000;
      metrics.totalCost += estimatedCost;

      const response = wrapDirectorResponse(rawResponse);

      return {
        ...response,
        _director_invoked: true,
        _director_available: true,
        _director_duration: duration,
        _director_cost: estimatedCost,
        _director_trigger: detection.trigger,
      };
    } catch (err) {
      metrics.directorErrors++;
      return {
        content: `The Director encountered an error: ${err.message}`,
        source: 'director',
        model_hidden: true,
        _director_invoked: true,
        _director_error: err.message,
      };
    }
  }

  middleware.getMetrics = () => ({ ...metrics });

  return middleware;
}
