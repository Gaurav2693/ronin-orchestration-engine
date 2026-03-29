// models/providers.test.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Provider Tests
//
// Validates:
//   1. All 4 providers can be imported without errors
//   2. providerRegistry returns correct provider for each name
//   3. Each provider has stream() and complete() methods
//   4. providerRegistry throws on unknown provider name
//
// Run with: node models/providers.test.mjs
// ─────────────────────────────────────────────────────────────────────────────

import assert from 'assert';

// ─── Test Setup ────────────────────────────────────────────────────────────────

console.log('[test] Starting provider tests...\n');

let passCount = 0;
let failCount = 0;

function test(description, fn) {
  try {
    fn();
    console.log(`✓ ${description}`);
    passCount++;
  } catch (err) {
    console.log(`✗ ${description}`);
    console.log(`  Error: ${err.message}`);
    failCount++;
  }
}

// ─── Test 1: Import all providers ──────────────────────────────────────────────

test('AnthropicProvider can be imported', () => {
  import('./anthropicProvider.mjs');
});

test('OpenAIProvider can be imported', () => {
  import('./openaiProvider.mjs');
});

test('GroqProvider can be imported', () => {
  import('./groqProvider.mjs');
});

test('GeminiProvider can be imported', () => {
  import('./geminiProvider.mjs');
});

// ─── Test 2: providerRegistry lookup ────────────────────────────────────────────

console.log('\n[test] Testing providerRegistry...\n');

// We need to do async imports for these tests
const imports = await Promise.all([
  import('./anthropicProvider.mjs'),
  import('./openaiProvider.mjs'),
  import('./groqProvider.mjs'),
  import('./geminiProvider.mjs'),
  import('./providerRegistry.mjs'),
]);

const [
  anthropicModule,
  openaiModule,
  groqModule,
  geminiModule,
  registryModule,
] = imports;

// Test that registry returns correct provider instances
test('getProvider("anthropic") returns AnthropicProvider instance', () => {
  const provider = registryModule.getProvider('anthropic');
  assert.strictEqual(provider.name, 'anthropic');
  assert.strictEqual(typeof provider.stream, 'function');
  assert.strictEqual(typeof provider.complete, 'function');
});

test('getProvider("openai") returns OpenAIProvider instance', () => {
  const provider = registryModule.getProvider('openai');
  assert.strictEqual(provider.name, 'openai');
  assert.strictEqual(typeof provider.stream, 'function');
  assert.strictEqual(typeof provider.complete, 'function');
});

test('getProvider("groq") returns GroqProvider instance', () => {
  const provider = registryModule.getProvider('groq');
  assert.strictEqual(provider.name, 'groq');
  assert.strictEqual(typeof provider.stream, 'function');
  assert.strictEqual(typeof provider.complete, 'function');
});

test('getProvider("gemini") returns GeminiProvider instance', () => {
  const provider = registryModule.getProvider('gemini');
  assert.strictEqual(provider.name, 'gemini');
  assert.strictEqual(typeof provider.stream, 'function');
  assert.strictEqual(typeof provider.complete, 'function');
});

// ─── Test 3: Provider interface validation ─────────────────────────────────────

console.log('\n[test] Validating provider interface...\n');

test('AnthropicProvider has stream() method', () => {
  const provider = anthropicModule.anthropicProvider;
  assert.strictEqual(typeof provider.stream, 'function');
});

test('AnthropicProvider has complete() method', () => {
  const provider = anthropicModule.anthropicProvider;
  assert.strictEqual(typeof provider.complete, 'function');
});

test('OpenAIProvider has stream() method', () => {
  const provider = openaiModule.openaiProvider;
  assert.strictEqual(typeof provider.stream, 'function');
});

test('OpenAIProvider has complete() method', () => {
  const provider = openaiModule.openaiProvider;
  assert.strictEqual(typeof provider.complete, 'function');
});

test('GroqProvider has stream() method', () => {
  const provider = groqModule.groqProvider;
  assert.strictEqual(typeof provider.stream, 'function');
});

test('GroqProvider has complete() method', () => {
  const provider = groqModule.groqProvider;
  assert.strictEqual(typeof provider.complete, 'function');
});

test('GeminiProvider has stream() method', () => {
  const provider = geminiModule.geminiProvider;
  assert.strictEqual(typeof provider.stream, 'function');
});

test('GeminiProvider has complete() method', () => {
  const provider = geminiModule.geminiProvider;
  assert.strictEqual(typeof provider.complete, 'function');
});

// ─── Test 4: Error handling ────────────────────────────────────────────────────

console.log('\n[test] Testing error handling...\n');

test('getProvider() throws on unknown provider', () => {
  try {
    registryModule.getProvider('unknown-provider');
    throw new Error('Should have thrown');
  } catch (err) {
    assert(err.message.includes('Unknown provider'));
  }
});

test('getProvider() error message includes available providers', () => {
  try {
    registryModule.getProvider('invalid');
    throw new Error('Should have thrown');
  } catch (err) {
    assert(err.message.includes('anthropic'));
    assert(err.message.includes('openai'));
    assert(err.message.includes('groq'));
    assert(err.message.includes('gemini'));
  }
});

// ─── Test 5: Registry helper functions ────────────────────────────────────────

console.log('\n[test] Testing registry helpers...\n');

test('listProviders() returns all provider names', () => {
  const providers = registryModule.listProviders();
  assert(Array.isArray(providers));
  assert.strictEqual(providers.length, 4);
  assert(providers.includes('anthropic'));
  assert(providers.includes('openai'));
  assert(providers.includes('groq'));
  assert(providers.includes('gemini'));
});

test('getAllProviders() returns all provider instances', () => {
  const providers = registryModule.getAllProviders();
  assert(providers.anthropic);
  assert(providers.openai);
  assert(providers.groq);
  assert(providers.gemini);
  assert.strictEqual(typeof providers.anthropic.stream, 'function');
  assert.strictEqual(typeof providers.openai.complete, 'function');
});

// ─── Results ───────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(70));
console.log(`[test] Results: ${passCount} passed, ${failCount} failed`);
console.log('─'.repeat(70) + '\n');

if (failCount > 0) {
  process.exit(1);
} else {
  console.log('✓ All provider tests passed!');
  process.exit(0);
}
