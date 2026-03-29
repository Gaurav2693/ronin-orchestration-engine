// ─── middleware/contextSummarizer.mjs ────────────────────────────────────────
// RONIN Middleware #7 — Context Summarizer (M6)
//
// Purpose: When conversation history approaches the token limit, compresses
// older messages using Flash-Lite (free tier). Preserves the most recent N
// messages verbatim, summarizes the rest.
//
// Evolves the existing context-compressor.mjs into middleware form.
//
// How it works:
//   1. Count tokens in conversation history
//   2. If under limit → passthrough (zero cost)
//   3. If over limit → split into "old" and "recent" segments
//   4. Summarize old messages via Flash-Lite
//   5. Replace old messages with summary + keep recent verbatim
//
// Cost model: Flash-Lite is free tier. This middleware costs $0 always.
//
// Invariants:
//   - Recent messages (last N) are NEVER compressed
//   - System prompt is NEVER compressed
//   - Under-limit → zero processing, zero latency
//   - Summarization preserves key facts, decisions, and context
//   - Token estimation: 1 token ≈ 4 characters
// ─────────────────────────────────────────────────────────────────────────────

// ─── Constants ──────────────────────────────────────────────────────────────

export const DEFAULT_TOKEN_LIMIT = 100000; // ~100K tokens
export const DEFAULT_PRESERVE_RECENT = 10; // keep last 10 messages verbatim
export const DEFAULT_SUMMARY_TARGET = 500; // target ~500 tokens for summary
export const TOKEN_CHAR_RATIO = 4; // 1 token ≈ 4 chars

// ─── Token Estimation ───────────────────────────────────────────────────────

export function estimateTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  return Math.ceil(text.length / TOKEN_CHAR_RATIO);
}

export function estimateHistoryTokens(messages) {
  if (!messages || !Array.isArray(messages)) return 0;
  let total = 0;
  for (const msg of messages) {
    total += estimateTokens(msg.content || msg.text || '');
    if (msg.role) total += 2; // role token overhead
  }
  return total;
}

// ─── Summarization Decision ─────────────────────────────────────────────────

/**
 * Determine if summarization is needed.
 */
export function shouldSummarize(history, tokenLimit = DEFAULT_TOKEN_LIMIT) {
  if (!history || !Array.isArray(history)) return false;
  return estimateHistoryTokens(history) > tokenLimit;
}

// ─── History Splitting ──────────────────────────────────────────────────────

/**
 * Split history into "old" (to summarize) and "recent" (to preserve).
 */
export function splitHistory(history, preserveRecent = DEFAULT_PRESERVE_RECENT) {
  if (!history || history.length <= preserveRecent) {
    return { old: [], recent: history || [] };
  }

  const splitPoint = history.length - preserveRecent;
  return {
    old: history.slice(0, splitPoint),
    recent: history.slice(splitPoint),
  };
}

// ─── Summarization ──────────────────────────────────────────────────────────

/**
 * Build the summarization prompt for Flash-Lite.
 */
export function buildSummaryPrompt(oldMessages, targetTokens = DEFAULT_SUMMARY_TARGET) {
  const conversation = oldMessages.map(m => {
    const role = m.role || 'unknown';
    const content = m.content || m.text || '';
    return `[${role}]: ${content}`;
  }).join('\n');

  return `Summarize this conversation history into a concise ~${targetTokens}-token summary.
Preserve: key decisions, important facts, user preferences, task context.
Drop: greetings, filler, repeated information, verbose explanations.

Conversation:
${conversation}

Summary:`;
}

/**
 * Summarize old messages using a provider (Flash-Lite).
 * Returns the summary string.
 */
export async function summarize(oldMessages, provider) {
  if (!oldMessages || oldMessages.length === 0) {
    return '';
  }

  if (!provider || typeof provider !== 'function') {
    // Fallback: just concatenate and truncate
    const texts = oldMessages.map(m => {
      const role = m.role || '?';
      const content = (m.content || m.text || '').substring(0, 100);
      return `[${role}]: ${content}`;
    });
    return `[Context summary - ${oldMessages.length} messages]: ${texts.join(' | ').substring(0, DEFAULT_SUMMARY_TARGET * TOKEN_CHAR_RATIO)}`;
  }

  const prompt = buildSummaryPrompt(oldMessages);
  try {
    const summary = await provider(prompt);
    return summary || '';
  } catch (err) {
    // Fallback on error
    return `[Summary unavailable: ${err.message}. ${oldMessages.length} earlier messages omitted.]`;
  }
}

// ─── Middleware Factory ─────────────────────────────────────────────────────

/**
 * Creates the Context Summarizer middleware.
 *
 * @param {Function|null} flashLiteProvider - async (prompt) => response string
 * @param {Object} config - { tokenLimit, preserveRecent, summaryTarget }
 * @returns {Function} middleware(request, next) => response
 */
export function createContextSummarizer(flashLiteProvider = null, config = {}) {
  const tokenLimit = config.tokenLimit ?? DEFAULT_TOKEN_LIMIT;
  const preserveRecent = config.preserveRecent ?? DEFAULT_PRESERVE_RECENT;
  const summaryTarget = config.summaryTarget ?? DEFAULT_SUMMARY_TARGET;

  const metrics = {
    passthroughs: 0,
    summarizations: 0,
    tokensBeforeSummary: 0,
    tokensAfterSummary: 0,
    messagesSummarized: 0,
  };

  async function middleware(request, next) {
    const history = request?.messages || request?.history || [];

    if (!shouldSummarize(history, tokenLimit)) {
      metrics.passthroughs++;
      if (typeof next === 'function') {
        return next(request);
      }
      return request;
    }

    // Split and summarize
    const tokensBefore = estimateHistoryTokens(history);
    metrics.tokensBeforeSummary += tokensBefore;

    const { old, recent } = splitHistory(history, preserveRecent);
    const summary = await summarize(old, flashLiteProvider);

    metrics.summarizations++;
    metrics.messagesSummarized += old.length;

    // Build compressed history
    const compressedHistory = [
      { role: 'system', content: summary, _summarized: true, _original_count: old.length },
      ...recent,
    ];

    const tokensAfter = estimateHistoryTokens(compressedHistory);
    metrics.tokensAfterSummary += tokensAfter;

    const enriched = {
      ...request,
      messages: compressedHistory,
      _context_summarized: true,
      _messages_compressed: old.length,
      _tokens_saved: tokensBefore - tokensAfter,
    };

    if (typeof next === 'function') {
      return next(enriched);
    }
    return enriched;
  }

  middleware.getMetrics = () => ({ ...metrics });

  return middleware;
}
