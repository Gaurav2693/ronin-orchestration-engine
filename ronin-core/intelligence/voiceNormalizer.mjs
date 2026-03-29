// ─── intelligence/voiceNormalizer.mjs ────────────────────────────────────────
// RONIN Voice Normalizer — the last mile before the operator sees a response.
//
// This module is the bridge between raw model output and RONIN's voice.
// It runs after every model response, following this decision tree:
//
//   raw response
//       │
//       ▼
//   validateVoice() ──── score ≥ 0.7 ──── PASS THROUGH (no rewrite, 0 cost)
//       │
//       │ score < 0.7
//       ▼
//   Haiku rewrite pass ──── normalized response (cheap, fast)
//       │
//       ▼
//   validateVoice() again ──── log improvement delta
//       │
//       ▼
//   return to operator
//
// ─── Cost Model ──────────────────────────────────────────────────────────────
//
//   Step                          Tokens           Latency      Cost
//   ──────────────────────────────────────────────────────────────────────
//   extractSignals()              0 (regex only)   <1ms         $0
//   updateProfile()               0 (math only)    <1ms         $0
//   profileToPromptFragment()     0 (string only)  <1ms         $0
//   validateVoice()               0 (regex only)   <1ms         $0
//   Haiku rewrite (when needed)   ~800 in + out    200-400ms    ~$0.0002
//   ──────────────────────────────────────────────────────────────────────
//
//   Best case (clean response):  0 tokens, <2ms, $0
//   Worst case (dirty response): ~800 tokens, ~400ms, $0.0002
//
//   At 1000 responses/day with 30% needing normalization:
//     300 rewrites × $0.0002 = $0.06/day
//     700 pass-throughs × $0 = $0
//     Total: $0.06/day for voice consistency
//
// ─────────────────────────────────────────────────────────────────────────────

import { validateVoice, generateNormalizerPrompt, generateSystemPrompt } from './voiceSchema.mjs';
import { extractSignals, updateProfile, profileToPromptFragment, createDefaultProfile } from './operatorProfile.mjs';

// ─── Provider Injection ──────────────────────────────────────────────────────
// Same pattern as consensus.mjs — we inject the provider function to avoid
// circular dependency with runTask.

let _providerFn = null;
let _profileStore = new Map();  // operatorId → profile (in-memory, replaceable with RAG)

export function _setProvider(fn) {
  _providerFn = fn;
}

export function _setProfileStore(store) {
  _profileStore = store;
}

// ─── Profile Management ──────────────────────────────────────────────────────

export function getProfile(operatorId) {
  if (!_profileStore.has(operatorId)) {
    _profileStore.set(operatorId, createDefaultProfile(operatorId));
  }
  return _profileStore.get(operatorId);
}

export function saveProfile(profile) {
  _profileStore.set(profile.operatorId, profile);
  return profile;
}

// ─── The Normalizer Prompt (cached) ──────────────────────────────────────────

const NORMALIZER_PROMPT = generateNormalizerPrompt();

// ─── Cost Tracking for Voice Module ──────────────────────────────────────────

const stats = {
  totalResponses: 0,
  passedValidation: 0,
  needsNormalization: 0,
  normalizationErrors: 0,
  totalTokensUsed: 0,
  totalLatencyMs: 0,
  avgScoreBefore: 0,
  avgScoreAfter: 0,
};

export function getStats() {
  return { ...stats };
}

export function resetStats() {
  stats.totalResponses = 0;
  stats.passedValidation = 0;
  stats.needsNormalization = 0;
  stats.normalizationErrors = 0;
  stats.totalTokensUsed = 0;
  stats.totalLatencyMs = 0;
  stats.avgScoreBefore = 0;
  stats.avgScoreAfter = 0;
}

// ─── Estimate Tokens ─────────────────────────────────────────────────────────
// Rough estimate: 1 token ≈ 4 characters (English)

function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

// ─── The Main Normalizer ─────────────────────────────────────────────────────
// This is the function that runTask calls after getting a model response.
//
// It does three things:
//   1. Learns from the operator's message (updates profile)
//   2. Validates the model's response against voice schema
//   3. If validation fails, rewrites via Haiku
//
// Returns: {
//   response: string,       // the final response (original or rewritten)
//   normalized: boolean,    // true if Haiku rewrote it
//   voiceScore: number,     // pre-normalization score (0-1)
//   voiceScoreAfter: number, // post-normalization score (or same if passed)
//   violations: array,      // what was wrong (empty if clean)
//   profileUpdate: object,  // the updated operator profile
//   cost: {
//     tokens: number,       // tokens consumed by normalization (0 if skipped)
//     estimatedUsd: number, // cost of normalization (0 if skipped)
//     latencyMs: number,    // time spent on normalization (0 if skipped)
//   }
// }

export async function normalizeResponse({
  response,
  operatorMessage,
  operatorId,
  skipRewrite = false,   // for testing: validate only, don't call Haiku
}) {
  const startTime = Date.now();
  stats.totalResponses++;

  // ── Step 1: Learn from operator's message ──────────────────────────────
  let profile = getProfile(operatorId || 'default');
  if (operatorMessage) {
    const signals = extractSignals(operatorMessage);
    if (signals) {
      profile = updateProfile(profile, signals);
      saveProfile(profile);
    }
  }

  // ── Step 2: Validate response against voice schema ─────────────────────
  const validation = validateVoice(response);
  const scoreBefore = validation.score;

  // Update running average
  stats.avgScoreBefore = (stats.avgScoreBefore * (stats.totalResponses - 1) + scoreBefore) / stats.totalResponses;

  // ── Step 3: If clean, pass through ─────────────────────────────────────
  if (validation.pass) {
    stats.passedValidation++;
    stats.avgScoreAfter = (stats.avgScoreAfter * (stats.passedValidation + stats.needsNormalization - 1) + scoreBefore) / (stats.passedValidation + stats.needsNormalization);

    return {
      response,
      normalized: false,
      voiceScore: scoreBefore,
      voiceScoreAfter: scoreBefore,
      violations: [],
      profileUpdate: profile,
      cost: {
        tokens: 0,
        estimatedUsd: 0,
        latencyMs: Date.now() - startTime,
      },
    };
  }

  // ── Step 4: Needs normalization ────────────────────────────────────────
  stats.needsNormalization++;

  if (skipRewrite || !_providerFn) {
    // No provider available — return with violations noted but no rewrite
    return {
      response,
      normalized: false,
      voiceScore: scoreBefore,
      voiceScoreAfter: scoreBefore,
      violations: validation.violations,
      profileUpdate: profile,
      cost: {
        tokens: 0,
        estimatedUsd: 0,
        latencyMs: Date.now() - startTime,
      },
    };
  }

  // ── Step 5: Haiku rewrite pass ─────────────────────────────────────────
  try {
    const rewriteStart = Date.now();

    // Build the normalization request
    const normalizerMessages = [
      { role: 'user', content: `${NORMALIZER_PROMPT}\n\n---\n\n${response}` },
    ];

    // Call Haiku — the cheapest, fastest model for text transformation
    const result = await _providerFn({
      modelId: 'claude-haiku-4-5',
      messages: normalizerMessages,
      systemPrompt: 'You are a text normalization engine. Follow instructions exactly.',
      maxTokens: Math.max(estimateTokens(response) * 1.2, 500),  // slightly more than input
      temperature: 0.3,  // low creativity, high fidelity to instructions
    });

    const rewrittenResponse = result?.response || result?.content || response;
    const rewriteLatency = Date.now() - rewriteStart;

    // Validate the rewritten response
    const revalidation = validateVoice(rewrittenResponse);
    const scoreAfter = revalidation.score;

    // Token accounting
    const inputTokens = estimateTokens(NORMALIZER_PROMPT) + estimateTokens(response);
    const outputTokens = estimateTokens(rewrittenResponse);
    const totalTokens = inputTokens + outputTokens;

    // Haiku pricing: $0.80/M input, $4.00/M output (as of mid-2025)
    const costUsd = (inputTokens * 0.80 + outputTokens * 4.00) / 1_000_000;

    stats.totalTokensUsed += totalTokens;
    stats.totalLatencyMs += rewriteLatency;
    stats.avgScoreAfter = (stats.avgScoreAfter * (stats.passedValidation + stats.needsNormalization - 1) + scoreAfter) / (stats.passedValidation + stats.needsNormalization);

    return {
      response: rewrittenResponse,
      normalized: true,
      voiceScore: scoreBefore,
      voiceScoreAfter: scoreAfter,
      violations: validation.violations,
      improvementDelta: scoreAfter - scoreBefore,
      profileUpdate: profile,
      cost: {
        tokens: totalTokens,
        inputTokens,
        outputTokens,
        estimatedUsd: Math.round(costUsd * 1_000_000) / 1_000_000,  // 6 decimal places
        latencyMs: rewriteLatency,
      },
    };
  } catch (err) {
    stats.normalizationErrors++;

    // If Haiku fails, return the original — never block the operator
    return {
      response,
      normalized: false,
      voiceScore: scoreBefore,
      voiceScoreAfter: scoreBefore,
      violations: validation.violations,
      error: err.message,
      profileUpdate: profile,
      cost: {
        tokens: 0,
        estimatedUsd: 0,
        latencyMs: Date.now() - startTime,
      },
    };
  }
}

// ─── Build Adapted System Prompt ─────────────────────────────────────────────
// Combines the fixed voice schema prompt with the operator's adaptation fragment.
// This is what gets injected as the system prompt for every model call.

export function buildSystemPrompt(operatorId, options = {}) {
  const base = generateSystemPrompt(options);
  const profile = getProfile(operatorId || 'default');
  const adaptation = profileToPromptFragment(profile);

  if (!adaptation) return base;
  return base + '\n' + adaptation;
}

// ─── Cost Projection ─────────────────────────────────────────────────────────
// Projects daily/monthly cost based on observed normalization rate.

export function projectCost(responsesPerDay = 1000) {
  if (stats.totalResponses === 0) {
    // No data yet — use conservative estimate
    return {
      normalizationRate: 0.30,  // assume 30% need rewriting
      dailyRewrites: Math.round(responsesPerDay * 0.30),
      dailyTokens: Math.round(responsesPerDay * 0.30 * 800),
      dailyCostUsd: Math.round(responsesPerDay * 0.30 * 0.0002 * 100) / 100,
      monthlyCostUsd: Math.round(responsesPerDay * 0.30 * 0.0002 * 30 * 100) / 100,
      note: 'Projected (no data yet)',
    };
  }

  const normRate = stats.needsNormalization / stats.totalResponses;
  const avgTokensPerRewrite = stats.needsNormalization > 0
    ? stats.totalTokensUsed / stats.needsNormalization
    : 800;
  const avgCostPerRewrite = stats.needsNormalization > 0
    ? (stats.totalTokensUsed / stats.needsNormalization) * 0.0000008  // rough avg
    : 0.0002;

  const dailyRewrites = Math.round(responsesPerDay * normRate);
  const dailyTokens = Math.round(dailyRewrites * avgTokensPerRewrite);
  const dailyCost = dailyRewrites * avgCostPerRewrite;

  return {
    normalizationRate: Math.round(normRate * 100) / 100,
    dailyRewrites,
    dailyTokens,
    dailyCostUsd: Math.round(dailyCost * 100) / 100,
    monthlyCostUsd: Math.round(dailyCost * 30 * 100) / 100,
    avgLatencyMs: stats.needsNormalization > 0
      ? Math.round(stats.totalLatencyMs / stats.needsNormalization)
      : 0,
    avgScoreImprovement: stats.avgScoreAfter - stats.avgScoreBefore,
    note: `Based on ${stats.totalResponses} observed responses`,
  };
}

// ─── Exports ─────────────────────────────────────────────────────────────────

export default {
  normalizeResponse,
  buildSystemPrompt,
  getProfile,
  saveProfile,
  getStats,
  resetStats,
  projectCost,
  _setProvider,
  _setProfileStore,
};
