// intelligence/costGuardrail.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Cost Guardrail Auto-Downgrade
//
// Monitors daily spend in real-time and automatically downgrades routing
// when thresholds are approached. This prevents end-of-day budget overruns
// without requiring manual intervention.
//
// How it works:
//   - Checks current daily spend against tier thresholds
//   - Returns a routing override: which models are still allowed
//   - Sends a ronin.state event to the UI when entering conserve mode
//
// Tiers (progressive downgrade):
//   - Green:  < 60% of daily budget → all models available
//   - Yellow: 60-80% → block Opus, prefer cheaper models
//   - Orange: 80-95% → block Opus + GPT-4o, only Sonnet/Haiku/free
//   - Red:    > 95% → free models only (Groq, Gemini)
//
// The operator sees a "conserve" indicator in the UI when downgrade is active,
// but NEVER knows which specific model was blocked. They just see RONIN
// being more conservative — which is the correct UX.
// ─────────────────────────────────────────────────────────────────────────────

import { COST_THRESHOLDS, MODELS } from '../config/modelConfig.mjs';

// ─── Configuration ──────────────────────────────────────────────────────────

const CONFIG = {
  TIERS: {
    green:  { maxPercent: 0.60, label: null },
    yellow: { maxPercent: 0.80, label: 'conserving' },
    orange: { maxPercent: 0.95, label: 'conserving' },
    red:    { maxPercent: 1.00, label: 'conserving — free models only' },
  },

  // Models blocked at each tier (cumulative — red includes all above)
  BLOCKED_MODELS: {
    green:  [],
    yellow: ['claude-opus-4-6'],
    orange: ['claude-opus-4-6', 'gpt-4o', 'o3-mini'],
    red:    ['claude-opus-4-6', 'gpt-4o', 'o3-mini', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'gpt-4o-mini'],
  },

  // Fallback model when the routed model is blocked
  DOWNGRADE_MAP: {
    'claude-opus-4-6': 'claude-sonnet-4-6',
    'gpt-4o': 'claude-sonnet-4-6',
    'o3-mini': 'claude-sonnet-4-6',
    'claude-sonnet-4-6': 'claude-haiku-4-5-20251001',
    'claude-haiku-4-5-20251001': 'llama-3.3-70b-versatile',
    'gpt-4o-mini': 'llama-3.3-70b-versatile',
  },
};

// ─── getTier(dailySpend) ────────────────────────────────────────────────────
// Determine the current cost tier based on daily spend.
//
// Arguments:
//   dailySpend — current total daily spend in USD
//
// Returns: {
//   tier: 'green' | 'yellow' | 'orange' | 'red',
//   percentUsed: number,   — 0.0 to 1.0+
//   label: string | null,  — UI label (null = no indicator)
//   budget: number,        — total daily budget
//   remaining: number,     — USD remaining
// }

export function getTier(dailySpend) {
  const budget = COST_THRESHOLDS.daily.total;
  const percentUsed = budget > 0 ? dailySpend / budget : 0;
  const remaining = Math.max(0, budget - dailySpend);

  let tier = 'green';
  if (percentUsed >= CONFIG.TIERS.orange.maxPercent) {
    tier = 'red';        // >= 95% of budget
  } else if (percentUsed >= CONFIG.TIERS.yellow.maxPercent) {
    tier = 'orange';     // >= 80%
  } else if (percentUsed >= CONFIG.TIERS.green.maxPercent) {
    tier = 'yellow';     // >= 60%
  }

  return {
    tier,
    percentUsed: Math.round(percentUsed * 100) / 100,
    label: CONFIG.TIERS[tier].label,
    budget,
    remaining: Math.round(remaining * 100) / 100,
  };
}

// ─── isModelAllowed(modelId, dailySpend) ────────────────────────────────────
// Check if a specific model is allowed at the current spend level.
//
// Returns: boolean

export function isModelAllowed(modelId, dailySpend) {
  const { tier } = getTier(dailySpend);
  const blocked = CONFIG.BLOCKED_MODELS[tier];
  return !blocked.includes(modelId);
}

// ─── getDowngrade(modelId, dailySpend) ──────────────────────────────────────
// If a model is blocked, return the downgrade target.
// If the model is allowed, return the original.
// Chains downgrades until an allowed model is found.
//
// Returns: {
//   modelId: string,         — the model to use (original or downgraded)
//   downgraded: boolean,     — true if a different model was selected
//   originalModelId: string, — what was originally requested
//   tier: string,            — current cost tier
//   label: string | null,    — UI label for the conserve state
// }

export function getDowngrade(modelId, dailySpend) {
  const tierInfo = getTier(dailySpend);
  const { tier, label } = tierInfo;
  const blocked = CONFIG.BLOCKED_MODELS[tier];

  // If model is allowed, return as-is
  if (!blocked.includes(modelId)) {
    return {
      modelId,
      downgraded: false,
      originalModelId: modelId,
      tier,
      label,
    };
  }

  // Chase the downgrade chain until we find an allowed model
  let current = modelId;
  let hops = 0;
  const maxHops = 6; // Safety valve

  while (blocked.includes(current) && hops < maxHops) {
    const next = CONFIG.DOWNGRADE_MAP[current];
    if (!next) break; // No further downgrade available
    current = next;
    hops++;
  }

  // If we're still blocked after chasing, fall back to free model
  if (blocked.includes(current)) {
    current = 'llama-3.3-70b-versatile'; // Ultimate fallback: free Groq
  }

  return {
    modelId: current,
    downgraded: true,
    originalModelId: modelId,
    tier,
    label,
  };
}

// ─── getAvailableModels(dailySpend) ─────────────────────────────────────────
// Returns list of all models available at the current spend level.
// Useful for the router to know which models it can pick from.

export function getAvailableModels(dailySpend) {
  const { tier } = getTier(dailySpend);
  const blocked = new Set(CONFIG.BLOCKED_MODELS[tier]);

  return Object.keys(MODELS).filter((id) => !blocked.has(id));
}

// ─── getBudgetReport(dailySpend) ────────────────────────────────────────────
// Human-readable budget status. Used for logging and diagnostics.
//
// Returns: string

export function getBudgetReport(dailySpend) {
  const { tier, percentUsed, budget, remaining, label } = getTier(dailySpend);
  const available = getAvailableModels(dailySpend);
  const blocked = CONFIG.BLOCKED_MODELS[tier];

  return [
    `Budget: $${dailySpend.toFixed(2)} / $${budget.toFixed(2)} (${Math.round(percentUsed * 100)}%)`,
    `Tier: ${tier.toUpperCase()}${label ? ` — ${label}` : ''}`,
    `Remaining: $${remaining.toFixed(2)}`,
    `Available models: ${available.length}`,
    blocked.length > 0 ? `Blocked: ${blocked.join(', ')}` : 'All models available',
  ].join(' | ');
}

// ─── Exports ────────────────────────────────────────────────────────────────

export { CONFIG };

export default {
  getTier,
  isModelAllowed,
  getDowngrade,
  getAvailableModels,
  getBudgetReport,
  CONFIG,
};
