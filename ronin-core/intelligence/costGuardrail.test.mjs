// intelligence/costGuardrail.test.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Tests for Task 15: Cost Guardrail Auto-Downgrade
//
// Pure logic — no external dependencies.
// Verifies: tier detection, model blocking, downgrade chains, budget reports.
// ─────────────────────────────────────────────────────────────────────────────

import {
  getTier,
  isModelAllowed,
  getDowngrade,
  getAvailableModels,
  getBudgetReport,
  CONFIG,
} from './costGuardrail.mjs';

import { COST_THRESHOLDS, MODELS } from '../config/modelConfig.mjs';

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

const BUDGET = COST_THRESHOLDS.daily.total; // $25

console.log(`\n─── Task 15: costGuardrail.mjs — Definition of Done ───\n`);
console.log(`Daily budget: $${BUDGET}\n`);

// ════════════════════════════════════════════════════════════════════════════
// Test 1: Configuration
// ════════════════════════════════════════════════════════════════════════════
console.log('Configuration:');
{
  assert(Object.keys(CONFIG.TIERS).length === 4, '4 cost tiers');
  assert(CONFIG.TIERS.green.maxPercent === 0.60, 'green < 60%');
  assert(CONFIG.TIERS.yellow.maxPercent === 0.80, 'yellow 60-80%');
  assert(CONFIG.TIERS.orange.maxPercent === 0.95, 'orange 80-95%');
  assert(CONFIG.TIERS.red.maxPercent === 1.00, 'red > 95%');
  assert(CONFIG.TIERS.green.label === null, 'green has no UI label');
  assert(CONFIG.TIERS.yellow.label !== null, 'yellow has conserve label');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 2: Green tier — all models available
// ════════════════════════════════════════════════════════════════════════════
console.log('\nGreen tier ($0 - $15):');
{
  const tier = getTier(5.00);
  assert(tier.tier === 'green', `$5 → green (got ${tier.tier})`);
  assert(tier.label === null, 'no conserve label');
  assert(tier.percentUsed === 0.20, `20% used (got ${tier.percentUsed})`);
  assert(tier.remaining === 20.00, `$20 remaining (got ${tier.remaining})`);
  assert(tier.budget === BUDGET, `budget is $${BUDGET}`);

  // All models available
  const available = getAvailableModels(5.00);
  assert(available.length === Object.keys(MODELS).length,
    `all ${Object.keys(MODELS).length} models available`);

  assert(isModelAllowed('claude-opus-4-6', 5.00), 'Opus allowed in green');
  assert(isModelAllowed('gpt-4o', 5.00), 'GPT-4o allowed in green');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 3: Yellow tier — Opus blocked
// ════════════════════════════════════════════════════════════════════════════
console.log('\nYellow tier ($15 - $20):');
{
  const spend = BUDGET * 0.70; // 70% = $17.50
  const tier = getTier(spend);
  assert(tier.tier === 'yellow', `70% spend → yellow (got ${tier.tier})`);
  assert(tier.label !== null, 'has conserve label');

  assert(!isModelAllowed('claude-opus-4-6', spend), 'Opus BLOCKED in yellow');
  assert(isModelAllowed('claude-sonnet-4-6', spend), 'Sonnet still allowed');
  assert(isModelAllowed('gpt-4o', spend), 'GPT-4o still allowed');
  assert(isModelAllowed('llama-3.3-70b-versatile', spend), 'Groq always allowed');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 4: Orange tier — Opus + GPT-4o blocked
// ════════════════════════════════════════════════════════════════════════════
console.log('\nOrange tier ($20 - $23.75):');
{
  const spend = BUDGET * 0.90; // 90% = $22.50
  const tier = getTier(spend);
  assert(tier.tier === 'orange', `90% spend → orange (got ${tier.tier})`);

  assert(!isModelAllowed('claude-opus-4-6', spend), 'Opus BLOCKED');
  assert(!isModelAllowed('gpt-4o', spend), 'GPT-4o BLOCKED');
  assert(!isModelAllowed('o3-mini', spend), 'o3-mini BLOCKED');
  assert(isModelAllowed('claude-sonnet-4-6', spend), 'Sonnet still allowed');
  assert(isModelAllowed('claude-haiku-4-5-20251001', spend), 'Haiku still allowed');
  assert(isModelAllowed('llama-3.3-70b-versatile', spend), 'Groq always allowed');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 5: Red tier — free models only
// ════════════════════════════════════════════════════════════════════════════
console.log('\nRed tier ($23.75+):');
{
  const spend = BUDGET * 0.98; // 98% = $24.50
  const tier = getTier(spend);
  assert(tier.tier === 'red', `98% spend → red (got ${tier.tier})`);
  assert(tier.label.includes('free models'), 'red label mentions free models');

  assert(!isModelAllowed('claude-opus-4-6', spend), 'Opus BLOCKED');
  assert(!isModelAllowed('claude-sonnet-4-6', spend), 'Sonnet BLOCKED');
  assert(!isModelAllowed('claude-haiku-4-5-20251001', spend), 'Haiku BLOCKED');
  assert(!isModelAllowed('gpt-4o', spend), 'GPT-4o BLOCKED');

  // Only free models remain
  assert(isModelAllowed('llama-3.3-70b-versatile', spend), 'Groq allowed');
  assert(isModelAllowed('gemini-2.5-flash', spend), 'Gemini Flash allowed');
  assert(isModelAllowed('gemini-2.5-flash-lite', spend), 'Gemini Lite allowed');

  const available = getAvailableModels(spend);
  assert(available.every(id => {
    const model = MODELS[id];
    return model.cost.input === 0 && model.cost.output === 0;
  }), 'all remaining models are free');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 6: Downgrade chains work correctly
// ════════════════════════════════════════════════════════════════════════════
console.log('\nDowngrade chains:');
{
  // Yellow: Opus → Sonnet
  const yellowSpend = BUDGET * 0.70;
  const opusDown = getDowngrade('claude-opus-4-6', yellowSpend);
  assert(opusDown.downgraded === true, 'Opus was downgraded');
  assert(opusDown.modelId === 'claude-sonnet-4-6', 'Opus → Sonnet in yellow');
  assert(opusDown.originalModelId === 'claude-opus-4-6', 'originalModelId preserved');
  assert(opusDown.tier === 'yellow', 'tier is yellow');

  // Orange: GPT-4o → Sonnet
  const orangeSpend = BUDGET * 0.90;
  const gptDown = getDowngrade('gpt-4o', orangeSpend);
  assert(gptDown.downgraded === true, 'GPT-4o was downgraded');
  assert(gptDown.modelId === 'claude-sonnet-4-6', 'GPT-4o → Sonnet in orange');

  // Red: Opus chains all the way down to free
  const redSpend = BUDGET * 0.98;
  const opusRedDown = getDowngrade('claude-opus-4-6', redSpend);
  assert(opusRedDown.downgraded === true, 'Opus downgraded in red');
  assert(isModelAllowed(opusRedDown.modelId, redSpend),
    `downgrade target "${opusRedDown.modelId}" is allowed in red`);

  // Green: no downgrade
  const greenDown = getDowngrade('claude-opus-4-6', 5.00);
  assert(greenDown.downgraded === false, 'no downgrade in green');
  assert(greenDown.modelId === 'claude-opus-4-6', 'Opus stays Opus in green');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 7: Free models never downgraded
// ════════════════════════════════════════════════════════════════════════════
console.log('\nFree models unaffected:');
{
  // Even at 100% budget, free models stay
  const maxSpend = BUDGET * 1.5; // Over budget
  const groq = getDowngrade('llama-3.3-70b-versatile', maxSpend);
  assert(groq.downgraded === false, 'Groq never downgraded');
  assert(groq.modelId === 'llama-3.3-70b-versatile', 'Groq stays Groq');

  const gemini = getDowngrade('gemini-2.5-flash', maxSpend);
  assert(gemini.downgraded === false, 'Gemini never downgraded');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 8: Budget report
// ════════════════════════════════════════════════════════════════════════════
console.log('\nBudget report:');
{
  const report = getBudgetReport(15.00);
  assert(report.includes('$15.00'), 'report includes spend');
  assert(report.includes(`$${BUDGET.toFixed(2)}`), 'report includes budget');
  assert(report.includes('60%'), 'report includes percentage');
  assert(typeof report === 'string', 'report is a string');

  const redReport = getBudgetReport(24.00);
  assert(redReport.includes('RED'), 'red tier shows in report');
  assert(redReport.includes('Blocked'), 'blocked models listed');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 9: Edge cases
// ════════════════════════════════════════════════════════════════════════════
console.log('\nEdge cases:');
{
  // Zero spend
  const zero = getTier(0);
  assert(zero.tier === 'green', '$0 → green');
  assert(zero.percentUsed === 0, '0% used');
  assert(zero.remaining === BUDGET, 'full budget remaining');

  // Exact budget
  const exact = getTier(BUDGET);
  assert(exact.tier === 'red', 'exact budget → red');

  // Over budget
  const over = getTier(BUDGET * 2);
  assert(over.tier === 'red', 'over budget → red');
  assert(over.remaining === 0, '$0 remaining when over budget');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 10: Tier boundaries are correct
// ════════════════════════════════════════════════════════════════════════════
console.log('\nTier boundaries:');
{
  // Just below yellow (59.9%)
  assert(getTier(BUDGET * 0.599).tier === 'green', '59.9% → green');
  // At yellow (60%)
  assert(getTier(BUDGET * 0.60).tier === 'yellow', '60% → yellow');
  // Just below orange (79.9%)
  assert(getTier(BUDGET * 0.799).tier === 'yellow', '79.9% → yellow');
  // At orange (80%)
  assert(getTier(BUDGET * 0.80).tier === 'orange', '80% → orange');
  // Just below red (94.9%)
  assert(getTier(BUDGET * 0.949).tier === 'orange', '94.9% → orange');
  // At red (95%)
  assert(getTier(BUDGET * 0.95).tier === 'red', '95% → red');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 11: Module exports correct shape
// ════════════════════════════════════════════════════════════════════════════
console.log('\nModule shape:');
{
  const mod = await import('./costGuardrail.mjs');
  assert(typeof mod.getTier === 'function', 'exports getTier');
  assert(typeof mod.isModelAllowed === 'function', 'exports isModelAllowed');
  assert(typeof mod.getDowngrade === 'function', 'exports getDowngrade');
  assert(typeof mod.getAvailableModels === 'function', 'exports getAvailableModels');
  assert(typeof mod.getBudgetReport === 'function', 'exports getBudgetReport');
  assert(typeof mod.CONFIG === 'object', 'exports CONFIG');
  assert(typeof mod.default === 'object', 'default export is object');
}

// ─── Summary ────────────────────────────────────────────────────────────────
console.log(`\n─── Results: ${passed} passed, ${failed} failed ───\n`);
if (failed > 0) process.exit(1);
