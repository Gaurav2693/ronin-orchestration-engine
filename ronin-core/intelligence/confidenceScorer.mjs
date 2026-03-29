// intelligence/confidenceScorer.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Confidence Scorer — Uncertainty Detection in Model Outputs
//
// After a model responds, this module scores how confident the output is.
// If confidence is below a threshold, it triggers a second-model check
// (multi-model consensus) before the response reaches the operator.
//
// Why: Cheaper models (Haiku, Groq) sometimes hedge, hallucinate, or
// produce vague answers. Rather than always routing to expensive models,
// we let the cheap model try first, then check its confidence. Only if
// the output is uncertain do we escalate.
//
// Signals scored (each weighted independently):
//   - Hedging language: "I think", "perhaps", "might be", "not sure"
//   - Uncertainty markers: "?", "may or may not", "it depends"
//   - Contradiction: "however", "but on the other hand", "although"
//   - Vagueness: "something like", "kind of", "sort of", "roughly"
//   - Self-correction: "actually", "wait", "let me reconsider"
//   - Refusal: "I can't", "I'm not able", "I don't have access"
//   - Excessive hedging density (many hedges per paragraph)
//
// Score output: 0.0 (no confidence) → 1.0 (fully confident)
// Threshold: < 0.7 triggers second-model check
// ─────────────────────────────────────────────────────────────────────────────

// ─── Configuration ──────────────────────────────────────────────────────────

const CONFIG = {
  THRESHOLD: 0.7,             // Below this → trigger consensus check
  HIGH_CONFIDENCE: 0.9,       // Above this → definitely skip consensus
  MIN_LENGTH: 20,             // Responses shorter than this skip scoring (too short to judge)
};

// ─── Signal Dictionaries ────────────────────────────────────────────────────
// Each signal has a pattern (regex) and a weight (how much it reduces confidence).
// Weights are negative — they subtract from a starting score of 1.0.

const SIGNALS = {
  hedging: {
    patterns: [
      /\bi think\b/gi,
      /\bperhaps\b/gi,
      /\bprobably\b/gi,
      /\bmight be\b/gi,
      /\bcould be\b/gi,
      /\bnot sure\b/gi,
      /\bnot certain\b/gi,
      /\bI believe\b/gi,
      /\bto my knowledge\b/gi,
      /\bas far as I know\b/gi,
      /\bif I recall\b/gi,
      /\bI'm not (entirely |completely )?sure\b/gi,
    ],
    weightPerMatch: -0.06,
  },

  uncertainty: {
    patterns: [
      /\bmay or may not\b/gi,
      /\bit depends\b/gi,
      /\bit's (hard|difficult) to say\b/gi,
      /\bthere's no (clear|definitive) answer\b/gi,
      /\bunclear\b/gi,
      /\bhard to determine\b/gi,
      /\bdifficult to know\b/gi,
    ],
    weightPerMatch: -0.08,
  },

  contradiction: {
    patterns: [
      /\bhowever\b/gi,
      /\bon the other hand\b/gi,
      /\balthough\b/gi,
      /\bthat said\b/gi,
      /\bbut then again\b/gi,
      /\bconversely\b/gi,
    ],
    weightPerMatch: -0.03, // Lower weight — contradictions can be legitimate analysis
  },

  vagueness: {
    patterns: [
      /\bsomething like\b/gi,
      /\bkind of\b/gi,
      /\bsort of\b/gi,
      /\broughly\b/gi,
      /\bapproximately\b/gi,
      /\bmore or less\b/gi,
      /\bin some (cases|situations|ways)\b/gi,
      /\bsome(times|how)\b/gi,
    ],
    weightPerMatch: -0.04,
  },

  selfCorrection: {
    patterns: [
      /\bactually,?\s/gi,
      /\bwait\b/gi,
      /\blet me (reconsider|rethink|correct)\b/gi,
      /\bsorry,? I (was|made)\b/gi,
      /\bI (was|stand) corrected\b/gi,
      /\bstriking that\b/gi,
    ],
    weightPerMatch: -0.10, // High weight — self-correction = low confidence
  },

  refusal: {
    patterns: [
      /\bI (can't|cannot|don't have access)\b/gi,
      /\bI'm (not able|unable)\b/gi,
      /\bI don't (have|know)\b/gi,
      /\bbeyond my (capabilities|knowledge)\b/gi,
      /\bI (lack|don't have) the (ability|information)\b/gi,
    ],
    weightPerMatch: -0.12, // Highest weight — refusals indicate task failure
  },
};

// ─── Positive Signals (boost confidence) ────────────────────────────────────
// These indicate the model is assertive and specific.

const POSITIVE_SIGNALS = {
  assertive: {
    patterns: [
      /\bhere's (how|what|the)\b/gi,
      /\bthe (answer|solution|fix) is\b/gi,
      /\bspecifically\b/gi,
      /\bdefinitely\b/gi,
      /\bthe correct approach\b/gi,
      /\byou (should|need to|must)\b/gi,
    ],
    weightPerMatch: 0.02,
  },

  codePresent: {
    patterns: [
      /```[\s\S]*?```/g,        // Code blocks
      /`[^`]+`/g,               // Inline code
    ],
    weightPerMatch: 0.03,       // Code = specific = confident
  },
};

// ─── scoreConfidence(response) ──────────────────────────────────────────────
// Main entry point. Scores model output confidence from 0.0 to 1.0.
//
// Arguments:
//   response — the model's text output
//
// Returns: {
//   score: number,            — 0.0 to 1.0
//   signals: object,          — breakdown by signal type with match counts
//   needsConsensus: boolean,  — true if score < THRESHOLD
//   summary: string,          — human-readable explanation
// }

export function scoreConfidence(response) {
  if (!response || typeof response !== 'string') {
    return {
      score: 0,
      signals: {},
      needsConsensus: true,
      summary: 'Empty response — no confidence.',
    };
  }

  // Short responses skip scoring (greetings, acks, etc.)
  if (response.length < CONFIG.MIN_LENGTH) {
    return {
      score: 1.0,
      signals: {},
      needsConsensus: false,
      summary: 'Response too short to score.',
    };
  }

  let score = 1.0;
  const signalDetails = {};

  // ─── Score negative signals ──────────────────────────────────────
  for (const [name, signal] of Object.entries(SIGNALS)) {
    let totalMatches = 0;

    for (const pattern of signal.patterns) {
      const matches = response.match(pattern);
      if (matches) {
        totalMatches += matches.length;
      }
    }

    if (totalMatches > 0) {
      const penalty = totalMatches * signal.weightPerMatch;
      score += penalty;
      signalDetails[name] = {
        matches: totalMatches,
        impact: penalty,
      };
    }
  }

  // ─── Score positive signals ──────────────────────────────────────
  for (const [name, signal] of Object.entries(POSITIVE_SIGNALS)) {
    let totalMatches = 0;

    for (const pattern of signal.patterns) {
      const matches = response.match(pattern);
      if (matches) {
        totalMatches += matches.length;
      }
    }

    if (totalMatches > 0) {
      const boost = totalMatches * signal.weightPerMatch;
      score += boost;
      signalDetails[name] = {
        matches: totalMatches,
        impact: boost,
      };
    }
  }

  // ─── Hedge density penalty ───────────────────────────────────────
  // If more than 20% of sentences contain hedging, apply extra penalty
  const sentences = response.split(/[.!?]+/).filter(s => s.trim().length > 0);
  if (sentences.length > 3) {
    const hedgeSentences = sentences.filter(s =>
      SIGNALS.hedging.patterns.some(p => p.test(s))
    ).length;
    const density = hedgeSentences / sentences.length;

    if (density > 0.2) {
      const densityPenalty = -(density - 0.2) * 0.3;
      score += densityPenalty;
      signalDetails.hedgeDensity = {
        density: Math.round(density * 100),
        impact: densityPenalty,
      };
    }
  }

  // Clamp score to [0, 1]
  score = Math.max(0, Math.min(1, score));

  // Round to 2 decimal places
  score = Math.round(score * 100) / 100;

  const needsConsensus = score < CONFIG.THRESHOLD;

  // Build summary
  const summary = _buildSummary(score, signalDetails, needsConsensus);

  return {
    score,
    signals: signalDetails,
    needsConsensus,
    summary,
  };
}

// ─── shouldTriggerConsensus(response, taskRisk?) ────────────────────────────
// Quick check: does this response need a second-model verification?
//
// Arguments:
//   response — model output text
//   taskRisk — optional 'low' | 'medium' | 'high'. High-risk tasks use
//              a stricter threshold (0.85 instead of 0.7).
//
// Returns: boolean

export function shouldTriggerConsensus(response, taskRisk = 'medium') {
  const { score } = scoreConfidence(response);

  const threshold = taskRisk === 'high'
    ? CONFIG.HIGH_CONFIDENCE
    : CONFIG.THRESHOLD;

  return score < threshold;
}

// ─── _buildSummary(score, signals, needsConsensus) ──────────────────────────

function _buildSummary(score, signals, needsConsensus) {
  if (Object.keys(signals).length === 0) {
    return `Confidence: ${score} — no uncertainty signals detected.`;
  }

  const topSignals = Object.entries(signals)
    .sort((a, b) => a[1].impact - b[1].impact) // Most negative first
    .slice(0, 3)
    .map(([name, data]) => `${name}(${data.matches}×, ${data.impact > 0 ? '+' : ''}${data.impact.toFixed(2)})`)
    .join(', ');

  const action = needsConsensus
    ? '→ triggering consensus check'
    : '→ confident enough, no consensus needed';

  return `Confidence: ${score} | Signals: ${topSignals} | ${action}`;
}

// ─── Exports ────────────────────────────────────────────────────────────────

export { CONFIG, SIGNALS, POSITIVE_SIGNALS };

export default {
  scoreConfidence,
  shouldTriggerConsensus,
  CONFIG,
};
