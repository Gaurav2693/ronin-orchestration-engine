// config/modelConfig.mjs
// ─────────────────────────────────────────────────────────────────────────────
// The single source of truth for every model in RONIN.
//
// Rules:
//   1. No model ID string exists anywhere in the codebase except this file.
//   2. Every other file imports from here: MODELS, RATE_LIMITS, COST_THRESHOLDS, ESCALATION_CHAIN.
//   3. If a model is added, removed, or repriced — this is the only file that changes.
//
// Structure per model:
//   provider        — which SDK to use ('anthropic' | 'openai' | 'groq' | 'gemini')
//   lane            — queue priority ('fast' | 'standard' | 'specialist' | 'director' | 'background')
//   seat            — which named role this model fills (see RONIN_ARCHITECTURE.md §4)
//   maxTokens       — output cap per call (keeps cost + latency predictable)
//   firstTokenMs    — expected time to first streamed token (drives UI thinking states)
//   thinkingLabel   — if set, operator sees "RONIN is [label]..." while waiting
//   cost            — per 1M tokens, input + output (0 = free tier)
// ─────────────────────────────────────────────────────────────────────────────

export const MODELS = {

  // ─── Anthropic ──────────────────────────────────────────────────────────────

  'claude-sonnet-4-6': {
    provider: 'anthropic',
    lane: 'standard',
    seat: 'core',
    maxTokens: 4096,
    firstTokenMs: 700,
    thinkingLabel: null,
    cost: { input: 3.00, output: 15.00 },
  },

  'claude-haiku-4-5-20251001': {
    provider: 'anthropic',
    lane: 'fast',
    seat: 'ops',
    maxTokens: 1500,
    firstTokenMs: 350,
    thinkingLabel: null,
    cost: { input: 0.25, output: 1.25 },
  },

  'claude-opus-4-6': {
    provider: 'anthropic',
    lane: 'director',
    seat: 'director',
    maxTokens: 8192,
    firstTokenMs: 1500,
    thinkingLabel: 'reviewing',
    cost: { input: 15.00, output: 75.00 },
  },

  // ─── OpenAI ─────────────────────────────────────────────────────────────────

  'gpt-4o': {
    provider: 'openai',
    lane: 'specialist',
    seat: 'specialist-vision',
    maxTokens: 2048,
    firstTokenMs: 1100,
    thinkingLabel: null,
    cost: { input: 2.50, output: 10.00 },
  },

  'o3-mini': {
    provider: 'openai',
    lane: 'specialist',
    seat: 'specialist-reasoner',
    maxTokens: 8192,
    firstTokenMs: 2500,
    thinkingLabel: 'thinking',
    cost: { input: 1.10, output: 4.40 },
  },

  'gpt-4o-mini': {
    provider: 'openai',
    lane: 'specialist',
    seat: 'specialist-scribe',
    maxTokens: 2000,
    firstTokenMs: 500,
    thinkingLabel: null,
    cost: { input: 0.15, output: 0.60 },
  },

  // ─── Groq (free tier) ──────────────────────────────────────────────────────

  'llama-3.3-70b-versatile': {
    provider: 'groq',
    lane: 'fast',
    seat: 'ops',
    maxTokens: 1500,
    firstTokenMs: 120,
    thinkingLabel: null,
    cost: { input: 0, output: 0 },
  },

  'llama-3.1-8b-instant': {
    provider: 'groq',
    lane: 'fast',
    seat: 'ops',
    maxTokens: 800,
    firstTokenMs: 60,
    thinkingLabel: null,
    cost: { input: 0, output: 0 },
  },

  // ─── Gemini (free tier) ────────────────────────────────────────────────────

  'gemini-2.5-flash-lite': {
    provider: 'gemini',
    lane: 'background',
    seat: 'analyst',
    maxTokens: 2000,
    firstTokenMs: 400,
    thinkingLabel: null,
    cost: { input: 0, output: 0 },
  },

  'gemini-2.5-flash': {
    provider: 'gemini',
    lane: 'background',
    seat: 'analyst',
    maxTokens: 3000,
    firstTokenMs: 600,
    thinkingLabel: null,
    cost: { input: 0, output: 0 },
  },

  'text-embedding-004': {
    provider: 'gemini',
    lane: 'background',
    seat: 'memory',
    maxTokens: null,          // embedding model — no text output
    firstTokenMs: 50,
    thinkingLabel: null,
    cost: { input: 0, output: 0 },
  },
};


// ─── Rate Limits (free tier providers only) ──────────────────────────────────
// Paid providers (Anthropic, OpenAI) have high enough limits that we don't
// track them here. These are the ceilings that actually constrain us.

export const RATE_LIMITS = {
  groq:          { rpm: 30,   rpd: 14400 },
  gemini_flash:  { rpm: 10,   rpd: 250   },
  gemini_lite:   { rpm: 15,   rpd: 1000  },
  gemini_embed:  { tpm: 10_000_000       },
};


// ─── Cost Thresholds (daily spend guardrails) ────────────────────────────────
// Checked before every call to expensive models.
// If exceeded → costTracker.canAfford() returns false → router downgrades.

export const COST_THRESHOLDS = {
  daily: {
    'claude-opus-4-6': 5.00,    // max $5/day on Director calls
    'gpt-4o':          10.00,   // max $10/day on vision tasks
    total:             25.00,   // hard daily cap across ALL models
  },
};


// ─── Escalation Chain ────────────────────────────────────────────────────────
// When a model fails validation → try the next model in the chain.
// Chain ends at Sonnet. Beyond that, fail loudly with structured error.
// Opus is NEVER in this chain — it's /director only.

export const ESCALATION_CHAIN = {
  'llama-3.3-70b-versatile': 'gemini-2.5-flash',
  'gemini-2.5-flash':        'claude-sonnet-4-6',
  'claude-sonnet-4-6':       null,  // end of chain — throw
};


// ─── Helper: look up a model by ID ──────────────────────────────────────────
// Convenience for other modules that receive a modelId string.

export function getModelConfig(modelId) {
  const config = MODELS[modelId];
  if (!config) {
    throw new Error(`[modelConfig] Unknown model ID: "${modelId}"`);
  }
  return { modelId, ...config };
}


// ─── Helper: get all models for a specific seat ─────────────────────────────
// Useful for the router when it needs to know what's available for a seat.

export function getModelsBySeat(seat) {
  return Object.entries(MODELS)
    .filter(([_, config]) => config.seat === seat)
    .map(([modelId, config]) => ({ modelId, ...config }));
}


// ─── Helper: get all models for a specific provider ─────────────────────────
// Useful for rateLimitGuard when checking provider-level limits.

export function getModelsByProvider(provider) {
  return Object.entries(MODELS)
    .filter(([_, config]) => config.provider === provider)
    .map(([modelId, config]) => ({ modelId, ...config }));
}
