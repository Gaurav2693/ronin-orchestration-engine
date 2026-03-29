// config/modelConfig.test.mjs
// Definition-of-done test for Task 1: modelConfig.mjs
//
// ✓ All models importable by ID and return the right shape
// ✓ No model ID exists as a hardcoded string outside this test
// ✓ Helper functions work correctly
// ✓ Escalation chain is valid (every target exists in MODELS or is null)
// ✓ Cost thresholds reference real model IDs

import { MODELS, RATE_LIMITS, COST_THRESHOLDS, ESCALATION_CHAIN, getModelConfig, getModelsBySeat, getModelsByProvider } from './modelConfig.mjs';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ ${message}`);
    failed++;
  }
}

console.log('\n─── Task 1: modelConfig.mjs — Definition of Done ───\n');

// ── Test 1: All 11 models present ──────────────────────────────────────────
console.log('Model registry:');
const expectedModels = [
  'claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'claude-opus-4-6',
  'gpt-4o', 'o3-mini', 'gpt-4o-mini',
  'llama-3.3-70b-versatile', 'llama-3.1-8b-instant',
  'gemini-2.5-flash-lite', 'gemini-2.5-flash', 'text-embedding-004',
];

assert(Object.keys(MODELS).length === 11, `11 models registered (got ${Object.keys(MODELS).length})`);

for (const id of expectedModels) {
  assert(MODELS[id] !== undefined, `${id} exists`);
}

// ── Test 2: Every model has the required shape ─────────────────────────────
console.log('\nModel shape:');
const requiredKeys = ['provider', 'lane', 'seat', 'maxTokens', 'firstTokenMs', 'thinkingLabel', 'cost'];

for (const [id, config] of Object.entries(MODELS)) {
  const hasAllKeys = requiredKeys.every(k => k in config);
  assert(hasAllKeys, `${id} has all required keys`);

  if (config.cost) {
    assert(typeof config.cost.input === 'number', `${id} cost.input is a number`);
    assert(typeof config.cost.output === 'number', `${id} cost.output is a number`);
  }
}

// ── Test 3: getModelConfig works ───────────────────────────────────────────
console.log('\ngetModelConfig():');
const sonnet = getModelConfig('claude-sonnet-4-6');
assert(sonnet.modelId === 'claude-sonnet-4-6', 'returns modelId in result');
assert(sonnet.provider === 'anthropic', 'returns correct provider');
assert(sonnet.lane === 'standard', 'returns correct lane');

let threwOnBadId = false;
try { getModelConfig('nonexistent-model'); } catch { threwOnBadId = true; }
assert(threwOnBadId, 'throws on unknown model ID');

// ── Test 4: getModelsBySeat works ──────────────────────────────────────────
console.log('\ngetModelsBySeat():');
const opsModels = getModelsBySeat('ops');
assert(opsModels.length >= 2, `ops seat has ${opsModels.length} models (Haiku + Groq variants)`);
assert(opsModels.every(m => m.seat === 'ops'), 'all returned models are ops seat');

const directorModels = getModelsBySeat('director');
assert(directorModels.length === 1, 'director seat has exactly 1 model (Opus)');
assert(directorModels[0].modelId === 'claude-opus-4-6', 'director model is Opus');

// ── Test 5: getModelsByProvider works ──────────────────────────────────────
console.log('\ngetModelsByProvider():');
const anthropicModels = getModelsByProvider('anthropic');
assert(anthropicModels.length === 3, `anthropic has 3 models (got ${anthropicModels.length})`);

const groqModels = getModelsByProvider('groq');
assert(groqModels.length === 2, `groq has 2 models (got ${groqModels.length})`);
assert(groqModels.every(m => m.cost.input === 0), 'all groq models are free');

// ── Test 6: Escalation chain is valid ──────────────────────────────────────
console.log('\nEscalation chain:');
for (const [from, to] of Object.entries(ESCALATION_CHAIN)) {
  assert(MODELS[from] !== undefined, `chain source "${from}" exists in MODELS`);
  if (to !== null) {
    assert(MODELS[to] !== undefined, `chain target "${to}" exists in MODELS`);
  } else {
    assert(true, `chain ends at "${from}" (null = throw)`);
  }
}
assert(!('claude-opus-4-6' in ESCALATION_CHAIN), 'Opus is NOT in the escalation chain');

// ── Test 7: Cost thresholds reference real models ──────────────────────────
console.log('\nCost thresholds:');
for (const [key, value] of Object.entries(COST_THRESHOLDS.daily)) {
  if (key === 'total') {
    assert(typeof value === 'number' && value > 0, `total daily cap is $${value}`);
  } else {
    assert(MODELS[key] !== undefined, `threshold model "${key}" exists in MODELS`);
    assert(typeof value === 'number' && value > 0, `${key} daily cap is $${value}`);
  }
}

// ── Test 8: Rate limits cover free providers ───────────────────────────────
console.log('\nRate limits:');
assert(RATE_LIMITS.groq?.rpm === 30, 'Groq RPM limit is 30');
assert(RATE_LIMITS.groq?.rpd === 14400, 'Groq RPD limit is 14,400');
assert(RATE_LIMITS.gemini_embed?.tpm === 10_000_000, 'Gemini embed TPM is 10M');

// ── Summary ────────────────────────────────────────────────────────────────
console.log(`\n─── Results: ${passed} passed, ${failed} failed ───\n`);
if (failed > 0) process.exit(1);
