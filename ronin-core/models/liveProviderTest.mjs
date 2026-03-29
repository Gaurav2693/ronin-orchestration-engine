#!/usr/bin/env node
// ─── RONIN Live Provider Test ─────────────────────────────────────────────────
// Tests all 4 providers with real API keys against real endpoints.
// Run: node models/liveProviderTest.mjs
// ─────────────────────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
dotenv.config({ override: true });

// ─── Test Harness ─────────────────────────────────────────────────────────────

const results = [];

async function testProvider(name, testFn) {
  const start = Date.now();
  try {
    const result = await testFn();
    const duration = Date.now() - start;
    results.push({ name, status: '✓ LIVE', duration, ...result });
    console.log(`✓ ${name} — ${duration}ms — ${result.response.slice(0, 80)}...`);
    if (result.tokens) {
      console.log(`  tokens: ${result.tokens.input} in / ${result.tokens.output} out`);
    }
    if (result.cost !== undefined) {
      console.log(`  cost: $${result.cost.toFixed(6)}`);
    }
  } catch (err) {
    const duration = Date.now() - start;
    results.push({ name, status: '✗ FAILED', duration, error: err.message });
    console.error(`✗ ${name} — ${duration}ms — ${err.message}`);
  }
  console.log();
}

// ─── Provider Tests ───────────────────────────────────────────────────────────

console.log('═══════════════════════════════════════════════════════════');
console.log('  RONIN LIVE PROVIDER TEST — All 4 Zones');
console.log('═══════════════════════════════════════════════════════════\n');

// Check env vars first
const keys = {
  GEMINI: process.env.GEMINI_API_KEY ? `${process.env.GEMINI_API_KEY.slice(0, 8)}...` : '❌ MISSING',
  GROQ: process.env.GROQ_API_KEY ? `${process.env.GROQ_API_KEY.slice(0, 8)}...` : '❌ MISSING',
  ANTHROPIC: process.env.ANTHROPIC_API_KEY ? `${process.env.ANTHROPIC_API_KEY.slice(0, 12)}...` : '❌ MISSING',
  OPENAI: process.env.OPENAI_API_KEY ? `${process.env.OPENAI_API_KEY.slice(0, 10)}...` : '❌ MISSING',
};

console.log('Keys loaded:');
for (const [name, val] of Object.entries(keys)) {
  console.log(`  ${name}: ${val}`);
}
console.log();

// ─── 1. GEMINI (Free Tier — Flash Lite) ─────────────────────────────────────

await testProvider('Gemini Flash-Lite [FREE] — Fast Worker', async () => {
  const { geminiProvider } = await import('./geminiProvider.mjs');

  const response = await geminiProvider.complete(
    [{ role: 'user', content: 'What is 2 + 2? Answer in one word.' }],
    { model: 'gemini-2.5-flash-lite', maxTokens: 50 }
  );

  return {
    response: response.content,
    tokens: { input: response.usage.inputTokens, output: response.usage.outputTokens },
    cost: 0, // free tier
  };
});

// ─── 2. GEMINI (Free Tier — Flash) ──────────────────────────────────────────

await testProvider('Gemini 2.5 Flash [FREE] — Vision Worker', async () => {
  const { geminiProvider } = await import('./geminiProvider.mjs');

  const response = await geminiProvider.complete(
    [{ role: 'user', content: 'Name 3 colors in a rainbow. One word each, comma separated.' }],
    { model: 'gemini-2.5-flash', maxTokens: 50 }
  );

  return {
    response: response.content,
    tokens: { input: response.usage.inputTokens, output: response.usage.outputTokens },
    cost: 0,
  };
});

// ─── 3. GROQ (Free Tier — Llama 70B) ───────────────────────────────────────

await testProvider('Groq Llama-3.3-70B [FREE] — Fast Fallback', async () => {
  const { groqProvider } = await import('./groqProvider.mjs');

  const response = await groqProvider.complete(
    [{ role: 'user', content: 'What is the capital of Japan? One word.' }],
    { model: 'llama-3.3-70b-versatile', maxTokens: 50 }
  );

  return {
    response: response.content,
    tokens: { input: response.usage.inputTokens, output: response.usage.outputTokens },
    cost: 0,
  };
});

// ─── 4. ANTHROPIC (Paid — Haiku) ────────────────────────────────────────────

await testProvider('Claude Haiku 4.5 [PAID] — Ops Seat', async () => {
  const { anthropicProvider } = await import('./anthropicProvider.mjs');

  const response = await anthropicProvider.complete(
    [{ role: 'user', content: 'What is 10 * 10? Answer with just the number.' }],
    { model: 'claude-haiku-4-5-20251001', maxTokens: 50 }
  );

  const inputCost = (response.usage.inputTokens * 0.25) / 1_000_000;
  const outputCost = (response.usage.outputTokens * 1.25) / 1_000_000;

  return {
    response: response.content,
    tokens: { input: response.usage.inputTokens, output: response.usage.outputTokens },
    cost: inputCost + outputCost,
  };
});

// ─── 5. ANTHROPIC (Paid — Sonnet) ───────────────────────────────────────────

await testProvider('Claude Sonnet 4.6 [PAID] — Core Brain', async () => {
  const { anthropicProvider } = await import('./anthropicProvider.mjs');

  const response = await anthropicProvider.complete(
    [{ role: 'user', content: 'In one sentence: what is an orchestration engine?' }],
    { model: 'claude-sonnet-4-6', maxTokens: 100 }
  );

  const inputCost = (response.usage.inputTokens * 3.00) / 1_000_000;
  const outputCost = (response.usage.outputTokens * 15.00) / 1_000_000;

  return {
    response: response.content,
    tokens: { input: response.usage.inputTokens, output: response.usage.outputTokens },
    cost: inputCost + outputCost,
  };
});

// ─── 6. OPENAI (Paid — GPT-4o-mini) ────────────────────────────────────────

await testProvider('GPT-4o-mini [PAID] — Codex Worker', async () => {
  const { openaiProvider } = await import('./openaiProvider.mjs');

  const response = await openaiProvider.complete(
    [{ role: 'user', content: 'Write a one-line JavaScript function that adds two numbers.' }],
    { model: 'gpt-4o-mini', maxTokens: 100 }
  );

  const inputCost = (response.usage.inputTokens * 0.15) / 1_000_000;
  const outputCost = (response.usage.outputTokens * 0.60) / 1_000_000;

  return {
    response: response.content,
    tokens: { input: response.usage.inputTokens, output: response.usage.outputTokens },
    cost: inputCost + outputCost,
  };
});

// ─── 7. OPENAI (Paid — GPT-4o) ─────────────────────────────────────────────

await testProvider('GPT-4o [PAID] — Agent Worker', async () => {
  const { openaiProvider } = await import('./openaiProvider.mjs');

  const response = await openaiProvider.complete(
    [{ role: 'user', content: 'What color is the sky? One word.' }],
    { model: 'gpt-4o', maxTokens: 20 }
  );

  const inputCost = (response.usage.inputTokens * 2.50) / 1_000_000;
  const outputCost = (response.usage.outputTokens * 10.00) / 1_000_000;

  return {
    response: response.content,
    tokens: { input: response.usage.inputTokens, output: response.usage.outputTokens },
    cost: inputCost + outputCost,
  };
});

// ─── Summary ────────────────────────────────────────────────────────────────

console.log('═══════════════════════════════════════════════════════════');
console.log('  RESULTS');
console.log('═══════════════════════════════════════════════════════════\n');

let passed = 0;
let failed = 0;
let totalCost = 0;

for (const r of results) {
  if (r.status.includes('✓')) {
    passed++;
    totalCost += r.cost || 0;
    console.log(`  ${r.status}  ${r.name.padEnd(45)} ${r.duration}ms  $${(r.cost || 0).toFixed(6)}`);
  } else {
    failed++;
    console.log(`  ${r.status}  ${r.name.padEnd(45)} ${r.error}`);
  }
}

console.log();
console.log(`  Passed: ${passed}/${results.length}`);
console.log(`  Failed: ${failed}/${results.length}`);
console.log(`  Total cost: $${totalCost.toFixed(6)}`);
console.log();

if (failed > 0) {
  console.log('  ⚠️  Some providers failed. Check keys and billing status.');
  process.exit(1);
} else {
  console.log('  🟢 All providers online. RONIN is ready.');
}
