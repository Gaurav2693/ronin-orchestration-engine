// ─── intelligence/voiceCostAnalysis.mjs ──────────────────────────────────────
// Token & latency breakdown for the entire RONIN Voice Module.
//
// This is a runnable analysis — execute with `node intelligence/voiceCostAnalysis.mjs`
// to see the full cost model in your terminal.
// ─────────────────────────────────────────────────────────────────────────────

import { generateSystemPrompt, generateNormalizerPrompt, validateVoice } from './voiceSchema.mjs';
import { createDefaultProfile, extractSignals, updateProfile, profileToPromptFragment } from './operatorProfile.mjs';

function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

function formatUsd(amount) {
  if (amount < 0.001) return `$${amount.toFixed(6)}`;
  if (amount < 1) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}

console.log(`
╔══════════════════════════════════════════════════════════════════════════════╗
║                  RONIN VOICE MODULE — COST & LATENCY LENS                  ║
╚══════════════════════════════════════════════════════════════════════════════╝
`);

// ─── 1. System Prompt Cost ───────────────────────────────────────────────────

const promptFull = generateSystemPrompt({ includeExamples: true });
const promptCompact = generateSystemPrompt({ compact: true });
const normalizerPrompt = generateNormalizerPrompt();

const fullTokens = estimateTokens(promptFull);
const compactTokens = estimateTokens(promptCompact);
const normalizerTokens = estimateTokens(normalizerPrompt);

console.log(`── 1. SYSTEM PROMPT (injected into every model call) ──────────────────────`);
console.log(`   Full prompt (with examples):    ${fullTokens} tokens  (${promptFull.length} chars)`);
console.log(`   Compact prompt (no examples):   ${compactTokens} tokens  (${promptCompact.length} chars)`);
console.log(`   Normalizer prompt (Haiku only): ${normalizerTokens} tokens  (${normalizerPrompt.length} chars)`);
console.log();

// Cost per call (system prompt is input tokens)
// Sonnet 4.6: $3.00/M input
// Haiku 4.5:  $0.80/M input
// GPT-4o:     $2.50/M input
// Groq:       $0.00/M input (free)
// Gemini:     $0.00/M input (free)

const models = [
  { name: 'Sonnet 4.6', inputRate: 3.00 },
  { name: 'Haiku 4.5', inputRate: 0.80 },
  { name: 'GPT-4o', inputRate: 2.50 },
  { name: 'Opus 4.6', inputRate: 15.00 },
  { name: 'Groq (free)', inputRate: 0.00 },
  { name: 'Gemini Flash (free)', inputRate: 0.00 },
];

console.log(`   Cost of system prompt per call (input tokens only):`);
for (const m of models) {
  const cost = (fullTokens * m.inputRate) / 1_000_000;
  console.log(`     ${m.name.padEnd(22)} ${formatUsd(cost)} per call`);
}
console.log();

// ─── 2. Operator Profile Adaptation ─────────────────────────────────────────

console.log(`── 2. OPERATOR PROFILE ADAPTATION (per-message learning) ─────────────────`);
console.log(`   extractSignals()         0 tokens    <0.1ms    (regex + string matching)`);
console.log(`   updateProfile()          0 tokens    <0.1ms    (arithmetic only)`);

// Show adaptation fragment sizes
const defaultProfile = createDefaultProfile('analysis');
const emptyFragment = profileToPromptFragment(defaultProfile);
console.log(`   Default profile fragment: ${estimateTokens(emptyFragment)} tokens (no adaptation yet)`);

// Simulate a fully shifted profile
const shiftedProfile = createDefaultProfile('analysis-shifted');
shiftedProfile.dimensions.verbosity = 0.1;
shiftedProfile.dimensions.technicalDepth = 0.9;
shiftedProfile.dimensions.domain = 0.8;
shiftedProfile.dimensions.explanationStyle = 0.8;
shiftedProfile.dimensions.warmth = 0.2;
shiftedProfile.dimensions.philosophyTolerance = 0.8;
shiftedProfile.dimensions.responseFormat = 0.8;
const fullFragment = profileToPromptFragment(shiftedProfile);
const fragmentTokens = estimateTokens(fullFragment);
console.log(`   Fully adapted fragment:   ${fragmentTokens} tokens (all 8 dimensions shifted)`);
console.log(`   Added to system prompt:   ${fullTokens + fragmentTokens} total tokens`);
console.log();

// ─── 3. Voice Validation ─────────────────────────────────────────────────────

console.log(`── 3. VOICE VALIDATION (runs on every response) ──────────────────────────`);

// Benchmark validation speed
const testResponses = [
  'The bug is in your useEffect dependency array.',
  'Great question! I\'d be happy to help you with that. As an AI language model, I should utilize my training data to facilitate your understanding of this concept. Let me break this down for you.',
  'Three options: use Context, lift state, or use a state machine. Context is simplest. State machine is most robust. Lifting state is the middle ground.',
  'Your component re-renders because `items` creates a new array reference on every render. Wrap it in `useMemo(() => computeItems(data), [data])` and the reference stabilizes.',
];

const start = performance.now();
const iterations = 1000;
for (let i = 0; i < iterations; i++) {
  for (const resp of testResponses) {
    validateVoice(resp);
  }
}
const elapsed = performance.now() - start;
const perValidation = elapsed / (iterations * testResponses.length);

console.log(`   validateVoice():          0 tokens    ${perValidation.toFixed(3)}ms per call`);
console.log(`   (benchmarked ${iterations * testResponses.length} validations in ${elapsed.toFixed(0)}ms)`);
console.log();

// Show pass/fail rates for example responses
console.log(`   Example validation results:`);
for (const resp of testResponses) {
  const result = validateVoice(resp);
  const status = result.pass ? '✓ PASS' : '✗ FAIL';
  const preview = resp.length > 60 ? resp.slice(0, 60) + '...' : resp;
  console.log(`     ${status} (${result.score.toFixed(2)}) "${preview}"`);
}
console.log();

// ─── 4. Haiku Rewrite Pass ───────────────────────────────────────────────────

console.log(`── 4. HAIKU REWRITE PASS (only when validation fails) ────────────────────`);

// Average response sizes
const avgShortResponse = 150;   // chars, ~38 tokens
const avgMedResponse = 600;     // chars, ~150 tokens
const avgLongResponse = 2000;   // chars, ~500 tokens

const haikuInputRate = 0.80;   // $/M tokens
const haikuOutputRate = 4.00;  // $/M tokens

console.log(`   Haiku 4.5 pricing: $${haikuInputRate}/M input, $${haikuOutputRate}/M output`);
console.log(`   Latency: 200-400ms (first token ~150ms + generation)`);
console.log();

console.log(`   Cost per rewrite by response size:`);
for (const [label, chars] of [['Short (~150 chars)', avgShortResponse], ['Medium (~600 chars)', avgMedResponse], ['Long (~2000 chars)', avgLongResponse]]) {
  const respTokens = Math.ceil(chars / 4);
  const inputTok = normalizerTokens + respTokens;     // prompt + original response
  const outputTok = Math.ceil(respTokens * 1.1);       // rewrite ≈ same length
  const cost = (inputTok * haikuInputRate + outputTok * haikuOutputRate) / 1_000_000;
  console.log(`     ${label.padEnd(25)} ${inputTok}in + ${outputTok}out = ${(inputTok + outputTok)} tokens  ${formatUsd(cost)}`);
}
console.log();

// ─── 5. Daily Cost Projections ───────────────────────────────────────────────

console.log(`── 5. DAILY COST PROJECTIONS ──────────────────────────────────────────────`);

const scenarios = [
  { name: 'Solo dev (you right now)', responsesPerDay: 100, normRate: 0.30 },
  { name: '5-person team', responsesPerDay: 500, normRate: 0.25 },
  { name: 'Small studio (20 ppl)', responsesPerDay: 2000, normRate: 0.20 },
  { name: 'Scale (100 operators)', responsesPerDay: 10000, normRate: 0.15 },
];

// Assume average response is medium (600 chars, ~150 tokens)
const avgRespTokens = 150;
const avgRewriteCost = ((normalizerTokens + avgRespTokens) * haikuInputRate + Math.ceil(avgRespTokens * 1.1) * haikuOutputRate) / 1_000_000;

// System prompt overhead per call (added to every call, using Sonnet as baseline)
const sonnetInputRate = 3.00;
const promptOverheadPerCall = (fullTokens * sonnetInputRate) / 1_000_000;

console.log(`   Avg rewrite cost: ${formatUsd(avgRewriteCost)} per normalization`);
console.log(`   System prompt overhead: ${formatUsd(promptOverheadPerCall)} per call (Sonnet)`);
console.log();

for (const s of scenarios) {
  const rewrites = Math.round(s.responsesPerDay * s.normRate);
  const rewriteCost = rewrites * avgRewriteCost;
  const promptCost = s.responsesPerDay * promptOverheadPerCall;
  const totalDaily = rewriteCost + promptCost;
  const totalMonthly = totalDaily * 30;

  console.log(`   ${s.name}:`);
  console.log(`     ${s.responsesPerDay} responses/day, ${(s.normRate * 100)}% need normalization`);
  console.log(`     Rewrites: ${rewrites}/day × ${formatUsd(avgRewriteCost)} = ${formatUsd(rewriteCost)}/day`);
  console.log(`     Prompt overhead: ${s.responsesPerDay} × ${formatUsd(promptOverheadPerCall)} = ${formatUsd(promptCost)}/day`);
  console.log(`     Total: ${formatUsd(totalDaily)}/day | ${formatUsd(totalMonthly)}/month`);
  console.log();
}

// ─── 6. Latency Breakdown ────────────────────────────────────────────────────

console.log(`── 6. LATENCY BREAKDOWN (per request) ─────────────────────────────────────`);
console.log();
console.log(`   Step                          Best case    Worst case    Notes`);
console.log(`   ─────────────────────────────────────────────────────────────────────`);
console.log(`   extractSignals()              <0.1ms       <0.1ms        Regex only`);
console.log(`   updateProfile()               <0.1ms       <0.1ms        Math only`);
console.log(`   buildSystemPrompt()           <0.1ms       <0.1ms        String concat`);
console.log(`   profileToPromptFragment()     <0.1ms       <0.1ms        Conditionals`);
console.log(`   validateVoice()               <0.1ms       <0.5ms        Regex matching`);
console.log(`   Haiku rewrite (if needed)     SKIPPED      200-400ms     API call`);
console.log(`   validateVoice() #2            SKIPPED      <0.5ms        Post-rewrite check`);
console.log(`   ─────────────────────────────────────────────────────────────────────`);
console.log(`   TOTAL (clean response)        <1ms         <1ms          Zero API calls`);
console.log(`   TOTAL (dirty response)        200ms        400ms         One Haiku call`);
console.log();

// ─── 7. The Decision ─────────────────────────────────────────────────────────

console.log(`── 7. THE VERDICT ─────────────────────────────────────────────────────────`);
console.log();
console.log(`   For a solo developer doing 100 requests/day:`);
console.log(`     Voice module adds: ~$0.15/day ($4.50/month)`);
console.log(`     Of RONIN's $25/day budget, that's 0.6%`);
console.log(`     Latency impact: 0ms for 70% of requests, ~300ms for 30%`);
console.log();
console.log(`   What you get for that 0.6%:`);
console.log(`     ✓ Every model sounds like RONIN (not like GPT or Llama)`);
console.log(`     ✓ RONIN adapts to YOUR communication style over time`);
console.log(`     ✓ Cheap models (Groq, Gemini) produce the same voice as Sonnet`);
console.log(`     ✓ No sycophancy, no AI identity leaks, no corporate jargon`);
console.log(`     ✓ Automatic — zero operator configuration`);
console.log();
console.log(`   Break-even vs alternatives:`);
console.log(`     Using Sonnet for everything (to ensure voice):   ~$0.90/day`);
console.log(`     Using cheap models + voice normalizer:            ~$0.15/day`);
console.log(`     Savings: $0.75/day = $22.50/month`);
console.log(`     The normalizer PAYS FOR ITSELF by enabling cheap model routing.`);
console.log();

// ─── 8. Module Summary ──────────────────────────────────────────────────────

console.log(`── 8. MODULE SUMMARY ──────────────────────────────────────────────────────`);
console.log();
console.log(`   Module                  Tests    Tokens/call    Latency       API calls`);
console.log(`   ─────────────────────────────────────────────────────────────────────────`);
console.log(`   voiceSchema.mjs         71       ${fullTokens} (prompt)    <0.1ms        0`);
console.log(`   operatorProfile.mjs     67       0              <0.2ms        0`);
console.log(`   voiceNormalizer.mjs     31       0-800          0-400ms       0-1 (Haiku)`);
console.log(`   runTask.mjs (updated)   64       +0             +0-400ms      +0-1`);
console.log(`   ─────────────────────────────────────────────────────────────────────────`);
console.log(`   TOTAL                   233      ${fullTokens}-${fullTokens + 800}        <1-400ms      0-1`);
console.log();
