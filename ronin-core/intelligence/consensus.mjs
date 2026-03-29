// intelligence/consensus.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Multi-Model Consensus — Second-Opinion Verification
//
// When the confidence scorer flags an uncertain response, this module runs
// the same prompt through a second model and compares results. If the two
// models agree, confidence is restored. If they diverge, the Director (Opus)
// synthesizes a final answer.
//
// Flow:
//   1. First model already responded (from runTask)
//   2. Confidence scorer flags output as uncertain (score < 0.7)
//   3. Consensus module runs a second model in parallel
//   4. Compare responses via text similarity
//   5. If similar (>= agreement threshold) → return first response
//   6. If divergent → route to Director for synthesis
//
// Cost awareness: The second model should be of EQUAL or LOWER tier.
// We never escalate to Opus for consensus — only for synthesis when
// two models disagree. This keeps consensus checks cheap.
//
// Similarity method: Jaccard similarity on word n-grams.
// This is intentionally simple — no embeddings needed for comparison.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Configuration ──────────────────────────────────────────────────────────

const CONFIG = {
  AGREEMENT_THRESHOLD: 0.6,    // Word overlap ratio above this = agreement
  NGRAM_SIZE: 3,               // Use trigrams for similarity comparison
  DIRECTOR_MODEL: 'claude-opus-4-6',
  // Second-opinion model selection: pick from the same tier or cheaper
  CONSENSUS_MODELS: {
    'claude-sonnet-4-6': 'gemini-2.5-flash',          // Sonnet → Gemini Flash
    'claude-haiku-4-5-20251001': 'llama-3.3-70b-versatile', // Haiku → Groq
    'llama-3.3-70b-versatile': 'gemini-2.5-flash',    // Groq → Gemini Flash
    'gemini-2.5-flash': 'llama-3.3-70b-versatile',    // Gemini → Groq
    'gpt-4o': 'claude-sonnet-4-6',                     // GPT-4o → Sonnet
    'gpt-4o-mini': 'claude-haiku-4-5-20251001',       // GPT-4o-mini → Haiku
  },
  SYNTHESIS_MAX_TOKENS: 4096,
};

// ─── getConsensusModel(primaryModelId) ──────────────────────────────────────
// Returns the second-opinion model for a given primary model.
// Returns null if no consensus partner is defined (e.g., Opus).

export function getConsensusModel(primaryModelId) {
  return CONFIG.CONSENSUS_MODELS[primaryModelId] || null;
}

// ─── calculateSimilarity(textA, textB) ──────────────────────────────────────
// Jaccard similarity on word n-grams.
//
// Returns: 0.0 (completely different) → 1.0 (identical)
//
// Why n-grams instead of word overlap? N-grams capture phrase-level
// agreement, not just vocabulary overlap. Two responses might use different
// words but express the same idea through similar phrases.

export function calculateSimilarity(textA, textB) {
  if (!textA || !textB) return 0;

  const ngramsA = _extractNgrams(textA, CONFIG.NGRAM_SIZE);
  const ngramsB = _extractNgrams(textB, CONFIG.NGRAM_SIZE);

  if (ngramsA.size === 0 || ngramsB.size === 0) return 0;

  // Jaccard: |intersection| / |union|
  let intersection = 0;
  for (const gram of ngramsA) {
    if (ngramsB.has(gram)) intersection++;
  }

  const union = new Set([...ngramsA, ...ngramsB]).size;
  return union === 0 ? 0 : intersection / union;
}

// ─── checkConsensus(responseA, responseB) ───────────────────────────────────
// Compare two model responses and determine if they agree.
//
// Returns: {
//   agree: boolean,           — true if similarity >= threshold
//   similarity: number,       — 0.0 to 1.0
//   action: string,           — 'accept' | 'synthesize'
// }

export function checkConsensus(responseA, responseB) {
  const similarity = calculateSimilarity(responseA, responseB);
  const agree = similarity >= CONFIG.AGREEMENT_THRESHOLD;

  return {
    agree,
    similarity: Math.round(similarity * 100) / 100,
    action: agree ? 'accept' : 'synthesize',
  };
}

// ─── buildSynthesisPrompt(query, responseA, responseB, modelA, modelB) ─────
// Build the prompt for the Director to synthesize divergent responses.
//
// The Director sees both responses anonymously (Model A / Model B) and
// produces a single authoritative answer. Model identity is never revealed.

export function buildSynthesisPrompt(query, responseA, responseB, modelA, modelB) {
  return {
    systemPrompt: `You are the Director — the final arbiter when two systems disagree. You receive two different responses to the same question. Your job:

1. Identify where they agree — that's likely correct.
2. Identify where they disagree — evaluate each claim on its merits.
3. Produce a single, authoritative response that takes the best from both.

Rules:
- Never mention that there were two responses or that you're synthesizing.
- Never reveal model identities (you don't know them, and they don't matter).
- Your response should read as a direct, confident answer.
- If both responses are wrong, say so directly.`,

    userMessage: `The operator asked: "${query}"

Two systems produced different responses:

--- Response A ---
${responseA}

--- Response B ---
${responseB}

Produce the definitive answer.`,
  };
}

// ─── runConsensus(query, primaryResponse, primaryModelId, providerFn) ───────
// Full consensus flow: get second opinion → compare → synthesize if needed.
//
// Arguments:
//   query           — the original operator question
//   primaryResponse — the first model's response (already generated)
//   primaryModelId  — which model generated it
//   providerFn      — async function(modelId, messages) → string
//                     (injected to avoid circular dependency with runTask)
//
// Returns: {
//   finalResponse: string,    — the response to send to the operator
//   consensus: boolean,       — true if models agreed
//   similarity: number,       — 0.0 to 1.0
//   synthesized: boolean,     — true if Director was invoked
//   secondModelId: string,    — which model gave the second opinion
//   costInfo: string,         — human-readable cost impact
// }

export async function runConsensus(
  query,
  primaryResponse,
  primaryModelId,
  providerFn,
) {
  // Step 1: Get consensus partner
  const secondModelId = getConsensusModel(primaryModelId);

  if (!secondModelId) {
    // No consensus partner (Opus, or unmapped model) → accept as-is
    return {
      finalResponse: primaryResponse,
      consensus: true,
      similarity: 1.0,
      synthesized: false,
      secondModelId: null,
      costInfo: 'no consensus partner available',
    };
  }

  // Step 2: Get second opinion
  const secondResponse = await providerFn(secondModelId, [
    { role: 'user', content: query },
  ]);

  // Step 3: Compare
  const { agree, similarity, action } = checkConsensus(primaryResponse, secondResponse);

  console.log(
    `[consensus] ${primaryModelId} vs ${secondModelId}: ` +
    `similarity=${similarity}, action=${action}`
  );

  // Step 4a: Models agree → return primary response
  if (agree) {
    return {
      finalResponse: primaryResponse,
      consensus: true,
      similarity,
      synthesized: false,
      secondModelId,
      costInfo: `second opinion from ${secondModelId} confirmed`,
    };
  }

  // Step 4b: Models disagree → Director synthesis
  const { systemPrompt, userMessage } = buildSynthesisPrompt(
    query, primaryResponse, secondResponse, primaryModelId, secondModelId
  );

  const synthesized = await providerFn(CONFIG.DIRECTOR_MODEL, [
    { role: 'user', content: userMessage },
  ], { systemPrompt, maxTokens: CONFIG.SYNTHESIS_MAX_TOKENS });

  console.log(
    `[consensus] Director synthesized (similarity was ${similarity})`
  );

  return {
    finalResponse: synthesized,
    consensus: false,
    similarity,
    synthesized: true,
    secondModelId,
    costInfo: `divergent responses (${similarity}) — Director synthesized`,
  };
}

// ─── _extractNgrams(text, n) ────────────────────────────────────────────────
// Extract word n-grams from text. Returns a Set of gram strings.

function _extractNgrams(text, n) {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 0);

  const grams = new Set();
  for (let i = 0; i <= words.length - n; i++) {
    grams.add(words.slice(i, i + n).join(' '));
  }
  return grams;
}

// ─── Exports ────────────────────────────────────────────────────────────────

export { CONFIG };

export default {
  getConsensusModel,
  calculateSimilarity,
  checkConsensus,
  buildSynthesisPrompt,
  runConsensus,
  CONFIG,
};
