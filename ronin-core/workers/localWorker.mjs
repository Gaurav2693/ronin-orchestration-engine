// ─── workers/localWorker.mjs ──────────────────────────────────────────────────
// RONIN Worker System — Phase 8 (W6)
//
// Local Worker: Ollama. Zero marginal cost. Only available when on the home
// tailnet (or localhost). Handles simple edits, config changes, boilerplate.
// Falls back to cloud Fast worker when unavailable.
//
// Cost: $0 (runs on local hardware)
// Latency: depends on model + hardware (M-series Mac: ~200ms first token)
// Default model: qwen2.5-coder:7b
//
// The worker checks Ollama availability via a health endpoint before each call.
// If Ollama is down or unreachable, it returns a fallback signal so the
// dispatcher can route to the Fast worker instead.
// ─────────────────────────────────────────────────────────────────────────────

import { createBaseWorker } from './workerInterface.mjs';

// ─── Default Config ───────────────────────────────────────────────────────────

const DEFAULT_OLLAMA_HOST = 'http://localhost:11434';
const DEFAULT_MODEL = 'qwen2.5-coder:7b';
const HEALTH_CHECK_INTERVAL_MS = 30_000; // cache availability for 30s
const FALLBACK_WORKER = 'fast';

const LOCAL_SYSTEM_PROMPT = `You are a fast local coding assistant. Keep responses concise.
Focus on: config edits, boilerplate generation, simple refactors, file operations.
If the task is too complex for a 7B model, say: "This task needs a larger model."`;

// ─── Local Worker Factory ─────────────────────────────────────────────────────

export function createLocalWorker(ollamaClient, config = {}) {
  const model = config.model || DEFAULT_MODEL;
  const maxTokens = config.maxTokens || 1500;
  const systemPrompt = config.systemPrompt || LOCAL_SYSTEM_PROMPT;
  const ollamaHost = config.ollamaHost || DEFAULT_OLLAMA_HOST;
  const healthCheckIntervalMs = config.healthCheckIntervalMs || HEALTH_CHECK_INTERVAL_MS;

  let lastHealthCheck = 0;
  let cachedAvailability = null;

  async function executeFn(task, context = {}) {
    // Check availability first
    const available = await isAvailable();
    if (!available) {
      return {
        result: null,
        cost: 0,
        model: null,
        fallback: FALLBACK_WORKER,
        unavailable: true,
        reason: 'Ollama is not running or unreachable',
      };
    }

    const messages = buildLocalMessages(task, context, systemPrompt);

    const response = await callOllama(ollamaClient, messages, model, maxTokens);

    return {
      result: response.content,
      cost: 0, // always free
      model,
      local: true,
      inputTokens: response.usage?.inputTokens || estimateTokens(messages),
      outputTokens: response.usage?.outputTokens || estimateTokens(response.content),
      needsEscalation: detectEscalation(response.content),
    };
  }

  // ── Availability Check ───────────────────────────────────────────

  async function isAvailable() {
    const now = Date.now();
    if (cachedAvailability !== null && (now - lastHealthCheck) < healthCheckIntervalMs) {
      return cachedAvailability;
    }

    try {
      if (typeof ollamaClient.isAvailable === 'function') {
        cachedAvailability = await ollamaClient.isAvailable();
      } else if (typeof ollamaClient.health === 'function') {
        cachedAvailability = await ollamaClient.health();
      } else {
        cachedAvailability = true; // assume available if no health check
      }
    } catch {
      cachedAvailability = false;
    }

    lastHealthCheck = now;
    return cachedAvailability;
  }

  function getFallbackWorker() {
    return FALLBACK_WORKER;
  }

  function getModel() {
    return model;
  }

  function clearAvailabilityCache() {
    cachedAvailability = null;
    lastHealthCheck = 0;
  }

  const worker = createBaseWorker('local', executeFn, config);

  // Attach local-specific methods
  worker.isAvailable = isAvailable;
  worker.getFallbackWorker = getFallbackWorker;
  worker.getModel = getModel;
  worker.clearAvailabilityCache = clearAvailabilityCache;

  return worker;
}

// ─── Message Builder ──────────────────────────────────────────────────────────

export function buildLocalMessages(task, context, systemPrompt) {
  const messages = [];

  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }

  // Minimal context — local models have small context windows
  const history = context.history || [];
  messages.push(...history.slice(-4)); // Last 2 turns only

  const userMessage = typeof task === 'string' ? task : (task.message || task.content || '');
  if (userMessage) {
    messages.push({ role: 'user', content: userMessage });
  }

  return messages;
}

// ─── Escalation Detection ─────────────────────────────────────────────────────

export function detectEscalation(content) {
  if (!content || typeof content !== 'string') return false;
  const lower = content.toLowerCase();
  return (
    lower.includes('needs a larger model') ||
    lower.includes('too complex') ||
    lower.includes('beyond my capabilities') ||
    lower.includes('cannot handle this')
  );
}

// ─── Ollama Call ──────────────────────────────────────────────────────────────

async function callOllama(client, messages, model, maxTokens) {
  if (typeof client.complete === 'function') {
    return client.complete(messages, { model, maxTokens });
  }
  if (typeof client.chat === 'function') {
    return client.chat(messages, { model, maxTokens });
  }
  if (typeof client === 'function') {
    return client(messages, { model, maxTokens });
  }
  throw new Error('[localWorker] Ollama client must implement complete(), chat(), or be callable');
}

// ─── Token Estimation ─────────────────────────────────────────────────────────

function estimateTokens(input) {
  if (!input) return 0;
  const text = typeof input === 'string' ? input : JSON.stringify(input);
  return Math.ceil(text.length / 4);
}
