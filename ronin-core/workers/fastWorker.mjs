// ─── workers/fastWorker.mjs ───────────────────────────────────────────────────
// RONIN Worker System — Phase 8 (W2)
//
// Fast Worker: Gemini Flash-Lite. Free tier. For simple queries, status checks,
// quick lookups, trivial classification. Bypasses Sonnet entirely for cheap tasks.
//
// Cost: $0 (free tier — 15 RPM, 1000 RPD)
// Latency: ~400ms first token
// Context: 2000 token output cap
//
// Fallback: If Gemini rate-limited, falls back to Groq Llama (also free).
// ─────────────────────────────────────────────────────────────────────────────

import { createBaseWorker } from './workerInterface.mjs';

// ─── System Prompt (minimal — keeps context lean) ─────────────────────────────

const FAST_SYSTEM_PROMPT = `You are a fast-response assistant. Answer concisely and directly.
Do not use markdown formatting unless explicitly asked. Keep responses under 200 words.
If the question requires deep analysis or multi-step reasoning, say: "This needs deeper analysis."`;

// ─── Fast Worker Factory ──────────────────────────────────────────────────────

export function createFastWorker(provider, config = {}) {
  const model = config.model || 'gemini-2.5-flash-lite';
  const maxTokens = config.maxTokens || 2000;
  const systemPrompt = config.systemPrompt || FAST_SYSTEM_PROMPT;
  const fallbackProvider = config.fallbackProvider || null;

  async function executeFn(task, context = {}) {
    const messages = buildMessages(task, context, systemPrompt);
    const targetProvider = provider;

    try {
      const response = await callProvider(targetProvider, messages, model, maxTokens);
      return {
        result: response.content,
        cost: 0, // free tier
        model,
        inputTokens: response.usage?.inputTokens || estimateTokens(messages),
        outputTokens: response.usage?.outputTokens || estimateTokens(response.content),
        needsEscalation: detectEscalation(response.content),
      };
    } catch (err) {
      // Rate limited — try fallback
      if (fallbackProvider && isRateLimited(err)) {
        const fallbackModel = config.fallbackModel || 'llama-3.3-70b-versatile';
        const response = await callProvider(fallbackProvider, messages, fallbackModel, maxTokens);
        return {
          result: response.content,
          cost: 0, // Groq is also free
          model: fallbackModel,
          inputTokens: response.usage?.inputTokens || 0,
          outputTokens: response.usage?.outputTokens || 0,
          usedFallback: true,
          needsEscalation: detectEscalation(response.content),
        };
      }
      throw err;
    }
  }

  return createBaseWorker('fast', executeFn, config);
}

// ─── Message Builder ──────────────────────────────────────────────────────────

export function buildMessages(task, context, systemPrompt) {
  const messages = [];

  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }

  // Inject taste if available
  if (context.taste_block) {
    messages.push({ role: 'system', content: context.taste_block });
  }

  // Add conversation history (last 3 turns max for fast worker)
  const history = context.history || [];
  const recentHistory = history.slice(-6); // 3 turns = 6 messages
  messages.push(...recentHistory);

  // Add the current message
  const userMessage = typeof task === 'string' ? task : (task.message || task.content || '');
  if (userMessage) {
    messages.push({ role: 'user', content: userMessage });
  }

  return messages;
}

// ─── Provider Call (abstracted for injection) ─────────────────────────────────

async function callProvider(provider, messages, model, maxTokens) {
  if (typeof provider.complete === 'function') {
    return provider.complete(messages, { model, maxTokens });
  }
  if (typeof provider === 'function') {
    return provider(messages, { model, maxTokens });
  }
  throw new Error('[fastWorker] Provider must implement complete() or be callable');
}

// ─── Escalation Detection ─────────────────────────────────────────────────────
// If the fast worker says "this needs deeper analysis", signal to the pipeline
// that the task should be re-routed to a more capable worker.

export function detectEscalation(content) {
  if (!content || typeof content !== 'string') return false;
  const lower = content.toLowerCase();
  return (
    lower.includes('needs deeper analysis') ||
    lower.includes('requires more detailed') ||
    lower.includes('beyond my scope') ||
    lower.includes('complex question that requires') ||
    lower.includes('i cannot fully answer')
  );
}

// ─── Rate Limit Detection ─────────────────────────────────────────────────────

function isRateLimited(err) {
  const msg = (err.message || '').toLowerCase();
  return (
    msg.includes('rate limit') ||
    msg.includes('429') ||
    msg.includes('too many requests') ||
    msg.includes('quota exceeded')
  );
}

// ─── Token Estimation ─────────────────────────────────────────────────────────

function estimateTokens(input) {
  if (!input) return 0;
  const text = typeof input === 'string' ? input : JSON.stringify(input);
  return Math.ceil(text.length / 4);
}
