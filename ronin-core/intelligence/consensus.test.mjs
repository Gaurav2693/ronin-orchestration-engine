// intelligence/consensus.test.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Tests for Task 14: Multi-Model Consensus
//
// Pure logic + mock provider function. No live APIs.
// Verifies: similarity, consensus checking, synthesis, model pairing.
// ─────────────────────────────────────────────────────────────────────────────

import {
  getConsensusModel,
  calculateSimilarity,
  checkConsensus,
  buildSynthesisPrompt,
  runConsensus,
  CONFIG,
} from './consensus.mjs';

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

console.log('\n─── Task 14: consensus.mjs — Definition of Done ───\n');

// ════════════════════════════════════════════════════════════════════════════
// Test 1: Configuration
// ════════════════════════════════════════════════════════════════════════════
console.log('Configuration:');
{
  assert(CONFIG.AGREEMENT_THRESHOLD === 0.6, 'agreement threshold is 0.6');
  assert(CONFIG.NGRAM_SIZE === 3, 'ngram size is 3 (trigrams)');
  assert(CONFIG.DIRECTOR_MODEL === 'claude-opus-4-6', 'Director is Opus');
  assert(Object.keys(CONFIG.CONSENSUS_MODELS).length >= 4, 'at least 4 model pairings');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 2: Consensus model pairing
// ════════════════════════════════════════════════════════════════════════════
console.log('\nModel pairing:');
{
  assert(getConsensusModel('claude-sonnet-4-6') === 'gemini-2.5-flash',
    'Sonnet → Gemini Flash');
  assert(getConsensusModel('claude-haiku-4-5-20251001') === 'llama-3.3-70b-versatile',
    'Haiku → Groq');
  assert(getConsensusModel('llama-3.3-70b-versatile') === 'gemini-2.5-flash',
    'Groq → Gemini Flash');
  assert(getConsensusModel('gemini-2.5-flash') === 'llama-3.3-70b-versatile',
    'Gemini → Groq');
  assert(getConsensusModel('gpt-4o') === 'claude-sonnet-4-6',
    'GPT-4o → Sonnet');

  // Opus has no consensus partner (it IS the Director)
  assert(getConsensusModel('claude-opus-4-6') === null,
    'Opus has no consensus partner');

  // Unknown model returns null
  assert(getConsensusModel('unknown-model') === null,
    'unknown model returns null');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 3: Identical texts have similarity 1.0
// ════════════════════════════════════════════════════════════════════════════
console.log('\nSimilarity — identical:');
{
  const text = 'The router sends simple messages to Haiku and complex ones to Sonnet.';
  const sim = calculateSimilarity(text, text);
  assert(sim === 1.0, `identical text → similarity 1.0 (got ${sim})`);
}

// ════════════════════════════════════════════════════════════════════════════
// Test 4: Similar texts score high
// ════════════════════════════════════════════════════════════════════════════
console.log('\nSimilarity — similar:');
{
  const a = 'The router sends simple messages to Haiku for fast processing and routes complex ones to Sonnet for better quality.';
  const b = 'The router sends simple messages to Haiku because it is fast and routes complex messages to Sonnet for higher quality output.';
  const sim = calculateSimilarity(a, b);
  assert(sim > 0.1, `similar texts score reasonably: ${sim}`);
}

// ════════════════════════════════════════════════════════════════════════════
// Test 5: Completely different texts score near 0
// ════════════════════════════════════════════════════════════════════════════
console.log('\nSimilarity — different:');
{
  const a = 'The weather is beautiful today with clear blue skies and warm temperatures.';
  const b = 'Quantum computing uses superposition and entanglement for parallel processing.';
  const sim = calculateSimilarity(a, b);
  assert(sim < 0.1, `unrelated texts score low: ${sim}`);
}

// ════════════════════════════════════════════════════════════════════════════
// Test 6: Edge cases for similarity
// ════════════════════════════════════════════════════════════════════════════
console.log('\nSimilarity — edge cases:');
{
  assert(calculateSimilarity('', 'hello') === 0, 'empty A → 0');
  assert(calculateSimilarity('hello', '') === 0, 'empty B → 0');
  assert(calculateSimilarity(null, 'hello') === 0, 'null A → 0');
  assert(calculateSimilarity('hi', 'hi') === 0, 'text shorter than ngram size → 0');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 7: checkConsensus — agreement
// ════════════════════════════════════════════════════════════════════════════
console.log('\ncheckConsensus:');
{
  const same = 'The router sends simple messages to Haiku and complex ones to Sonnet for better quality output.';
  const result = checkConsensus(same, same);
  assert(result.agree === true, 'identical responses agree');
  assert(result.action === 'accept', 'action is accept');
  assert(result.similarity === 1.0, 'similarity is 1.0');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 8: checkConsensus — disagreement
// ════════════════════════════════════════════════════════════════════════════
console.log('\ncheckConsensus — disagreement:');
{
  const a = 'You should use React with TypeScript for the frontend because it has the best type safety and component model.';
  const b = 'SwiftUI is the right choice for macOS because it provides native performance and direct access to AppKit.';
  const result = checkConsensus(a, b);
  assert(result.agree === false, 'divergent responses disagree');
  assert(result.action === 'synthesize', 'action is synthesize');
  assert(result.similarity < 0.6, `similarity below threshold: ${result.similarity}`);
}

// ════════════════════════════════════════════════════════════════════════════
// Test 9: buildSynthesisPrompt
// ════════════════════════════════════════════════════════════════════════════
console.log('\nbuildSynthesisPrompt:');
{
  const { systemPrompt, userMessage } = buildSynthesisPrompt(
    'What framework should I use?',
    'Use React.',
    'Use SwiftUI.',
    'sonnet',
    'gemini',
  );

  assert(systemPrompt.includes('Director'), 'system prompt mentions Director role');
  assert(systemPrompt.toLowerCase().includes('never reveal model'), 'system prompt forbids model identity');
  assert(userMessage.includes('What framework should I use?'), 'user message includes query');
  assert(userMessage.includes('Use React.'), 'user message includes response A');
  assert(userMessage.includes('Use SwiftUI.'), 'user message includes response B');
  // Model identities NOT in the user message
  assert(!userMessage.includes('sonnet'), 'model identity A not in prompt');
  assert(!userMessage.includes('gemini'), 'model identity B not in prompt');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 10: runConsensus — agreement path
// ════════════════════════════════════════════════════════════════════════════
console.log('\nrunConsensus — agreement:');
{
  // Mock provider returns same-ish response
  const mockProvider = async (modelId, messages) => {
    return 'The router sends simple messages to Haiku and complex ones to Sonnet for quality output.';
  };

  const result = await runConsensus(
    'How does the router work?',
    'The router sends simple messages to Haiku and complex ones to Sonnet for quality output.',
    'claude-sonnet-4-6',
    mockProvider,
  );

  assert(result.consensus === true, 'models agreed');
  assert(result.synthesized === false, 'no synthesis needed');
  assert(result.similarity === 1.0, 'perfect similarity');
  assert(result.secondModelId === 'gemini-2.5-flash', 'second model was Gemini');
  assert(result.finalResponse.includes('router'), 'final response preserved');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 11: runConsensus — disagreement triggers Director
// ════════════════════════════════════════════════════════════════════════════
console.log('\nrunConsensus — disagreement:');
{
  let directorCalled = false;

  const mockProvider = async (modelId, messages, options) => {
    if (modelId === 'claude-opus-4-6') {
      directorCalled = true;
      return 'The Director says: use the best of both approaches.';
    }
    // Second opinion returns something completely different
    return 'Quantum computing is the future of all software development and routing.';
  };

  const result = await runConsensus(
    'How does routing work?',
    'The router uses complexity scoring to pick the cheapest viable model.',
    'claude-sonnet-4-6',
    mockProvider,
  );

  assert(result.consensus === false, 'models disagreed');
  assert(result.synthesized === true, 'synthesis was needed');
  assert(directorCalled === true, 'Director (Opus) was invoked');
  assert(result.finalResponse.includes('Director'), 'final response is from Director');
  assert(result.similarity < 0.6, `similarity was low: ${result.similarity}`);
}

// ════════════════════════════════════════════════════════════════════════════
// Test 12: runConsensus — no consensus partner (Opus)
// ════════════════════════════════════════════════════════════════════════════
console.log('\nrunConsensus — no partner:');
{
  const mockProvider = async () => { throw new Error('should not be called'); };

  const result = await runConsensus(
    'Director review',
    'The Director responds directly.',
    'claude-opus-4-6',
    mockProvider,
  );

  assert(result.consensus === true, 'accepted without consensus');
  assert(result.synthesized === false, 'no synthesis');
  assert(result.secondModelId === null, 'no second model');
  assert(result.finalResponse === 'The Director responds directly.', 'original preserved');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 13: Module exports correct shape
// ════════════════════════════════════════════════════════════════════════════
console.log('\nModule shape:');
{
  const mod = await import('./consensus.mjs');
  assert(typeof mod.getConsensusModel === 'function', 'exports getConsensusModel');
  assert(typeof mod.calculateSimilarity === 'function', 'exports calculateSimilarity');
  assert(typeof mod.checkConsensus === 'function', 'exports checkConsensus');
  assert(typeof mod.buildSynthesisPrompt === 'function', 'exports buildSynthesisPrompt');
  assert(typeof mod.runConsensus === 'function', 'exports runConsensus');
  assert(typeof mod.CONFIG === 'object', 'exports CONFIG');
  assert(typeof mod.default === 'object', 'default export is object');
}

// ─── Summary ────────────────────────────────────────────────────────────────
console.log(`\n─── Results: ${passed} passed, ${failed} failed ───\n`);
if (failed > 0) process.exit(1);
