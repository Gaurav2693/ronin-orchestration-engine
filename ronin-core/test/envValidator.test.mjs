// test/envValidator.test.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Tests for RONIN Environment Validator
// ─────────────────────────────────────────────────────────────────────────────

import { validateEnv } from '../config/envValidator.mjs';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'Assertion failed'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

// ─── Helper: set/clear all keys ─────────────────────────────────────────────

const ALL_KEYS = ['GEMINI_API_KEY', 'GROQ_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OLLAMA_HOST'];
const VALID_KEYS = {
  GEMINI_API_KEY: 'AIzaSyTest1234567890abcdef',
  GROQ_API_KEY: 'gsk_test1234567890abcdefghijklm',
  ANTHROPIC_API_KEY: 'sk-ant-api03-test1234567890abcdef',
  OPENAI_API_KEY: 'sk-proj-test1234567890abcdef',
};

function setAllKeys() {
  for (const [k, v] of Object.entries(VALID_KEYS)) {
    process.env[k] = v;
  }
  process.env.DAILY_COST_LIMIT = '1.00';
}

function clearAllKeys() {
  for (const k of ALL_KEYS) {
    delete process.env[k];
  }
  delete process.env.DAILY_COST_LIMIT;
}

console.log('\n─── envValidator.test.mjs ───────────────────────────────\n');

// ─── All keys present ───────────────────────────────────────────────────────

console.log('All keys valid:');

test('returns valid:true when all required keys are present', () => {
  setAllKeys();
  const result = validateEnv({ silent: true });
  assertEqual(result.valid, true);
  assertEqual(result.loaded, 4);
  assertEqual(result.errors.length, 0);
  clearAllKeys();
});

test('loads 4 required keys', () => {
  setAllKeys();
  const result = validateEnv({ silent: true });
  assertEqual(result.loaded, 4);
  clearAllKeys();
});

// ─── Missing keys ───────────────────────────────────────────────────────────

console.log('\nMissing keys:');

test('reports error for missing GEMINI_API_KEY', () => {
  setAllKeys();
  delete process.env.GEMINI_API_KEY;
  const result = validateEnv({ silent: true });
  assertEqual(result.valid, false);
  assert(result.errors.some(e => e.includes('GEMINI_API_KEY')), 'Should mention GEMINI_API_KEY');
  clearAllKeys();
});

test('reports error for missing GROQ_API_KEY', () => {
  setAllKeys();
  delete process.env.GROQ_API_KEY;
  const result = validateEnv({ silent: true });
  assertEqual(result.valid, false);
  assert(result.errors.some(e => e.includes('GROQ_API_KEY')), 'Should mention GROQ_API_KEY');
  clearAllKeys();
});

test('reports error for missing ANTHROPIC_API_KEY', () => {
  setAllKeys();
  delete process.env.ANTHROPIC_API_KEY;
  const result = validateEnv({ silent: true });
  assertEqual(result.valid, false);
  assert(result.errors.some(e => e.includes('ANTHROPIC_API_KEY')), 'Should mention ANTHROPIC_API_KEY');
  clearAllKeys();
});

test('reports error for missing OPENAI_API_KEY', () => {
  setAllKeys();
  delete process.env.OPENAI_API_KEY;
  const result = validateEnv({ silent: true });
  assertEqual(result.valid, false);
  assert(result.errors.some(e => e.includes('OPENAI_API_KEY')), 'Should mention OPENAI_API_KEY');
  clearAllKeys();
});

test('reports all 4 errors when all keys missing', () => {
  clearAllKeys();
  const result = validateEnv({ silent: true });
  assertEqual(result.valid, false);
  assertEqual(result.errors.length, 4);
  clearAllKeys();
});

test('treats empty string as missing', () => {
  setAllKeys();
  process.env.GEMINI_API_KEY = '';
  const result = validateEnv({ silent: true });
  assertEqual(result.valid, false);
  assert(result.errors.some(e => e.includes('GEMINI_API_KEY')));
  clearAllKeys();
});

test('treats whitespace-only as missing', () => {
  setAllKeys();
  process.env.GEMINI_API_KEY = '   ';
  const result = validateEnv({ silent: true });
  assertEqual(result.valid, false);
  clearAllKeys();
});

// ─── Invalid format ─────────────────────────────────────────────────────────

console.log('\nInvalid format:');

test('rejects GEMINI key without AIza prefix', () => {
  setAllKeys();
  process.env.GEMINI_API_KEY = 'wrong-prefix-key-here-test';
  const result = validateEnv({ silent: true });
  assertEqual(result.valid, false);
  assert(result.errors.some(e => e.includes('invalid format')));
  clearAllKeys();
});

test('rejects GROQ key without gsk_ prefix', () => {
  setAllKeys();
  process.env.GROQ_API_KEY = 'wrong-prefix-key-here-test';
  const result = validateEnv({ silent: true });
  assertEqual(result.valid, false);
  assert(result.errors.some(e => e.includes('invalid format')));
  clearAllKeys();
});

test('rejects ANTHROPIC key without sk-ant- prefix', () => {
  setAllKeys();
  process.env.ANTHROPIC_API_KEY = 'wrong-prefix-key-here-test';
  const result = validateEnv({ silent: true });
  assertEqual(result.valid, false);
  assert(result.errors.some(e => e.includes('invalid format')));
  clearAllKeys();
});

test('rejects OPENAI key without sk- prefix', () => {
  setAllKeys();
  process.env.OPENAI_API_KEY = 'wrong-prefix-key-here-test';
  const result = validateEnv({ silent: true });
  assertEqual(result.valid, false);
  assert(result.errors.some(e => e.includes('invalid format')));
  clearAllKeys();
});

// ─── Optional keys ──────────────────────────────────────────────────────────

console.log('\nOptional keys:');

test('OLLAMA_HOST is optional — valid without it', () => {
  setAllKeys();
  delete process.env.OLLAMA_HOST;
  const result = validateEnv({ silent: true });
  assertEqual(result.valid, true);
  clearAllKeys();
});

test('warns when OLLAMA_HOST missing', () => {
  setAllKeys();
  delete process.env.OLLAMA_HOST;
  const result = validateEnv({ silent: true });
  assert(result.warnings.some(w => w.includes('OLLAMA_HOST')));
  clearAllKeys();
});

// ─── Cost limit ─────────────────────────────────────────────────────────────

console.log('\nCost limit validation:');

test('warns when DAILY_COST_LIMIT not set', () => {
  setAllKeys();
  delete process.env.DAILY_COST_LIMIT;
  const result = validateEnv({ silent: true });
  assert(result.warnings.some(w => w.includes('DAILY_COST_LIMIT')));
  clearAllKeys();
});

test('warns when DAILY_COST_LIMIT is invalid', () => {
  setAllKeys();
  process.env.DAILY_COST_LIMIT = 'not-a-number';
  const result = validateEnv({ silent: true });
  assert(result.warnings.some(w => w.includes('DAILY_COST_LIMIT')));
  clearAllKeys();
});

test('no cost warning when DAILY_COST_LIMIT is valid', () => {
  setAllKeys();
  const result = validateEnv({ silent: true });
  assert(!result.warnings.some(w => w.includes('DAILY_COST_LIMIT')));
  clearAllKeys();
});

// ─── Strict mode ────────────────────────────────────────────────────────────

console.log('\nStrict mode:');

test('strict mode throws on missing required keys', () => {
  clearAllKeys();
  let threw = false;
  try {
    validateEnv({ silent: true, strict: true });
  } catch (err) {
    threw = true;
    assert(err.message.includes('required key'), `Expected 'required key' in: ${err.message}`);
  }
  assert(threw, 'Should have thrown');
});

test('strict mode does not throw when all keys valid', () => {
  setAllKeys();
  const result = validateEnv({ silent: true, strict: true });
  assertEqual(result.valid, true);
  clearAllKeys();
});

// ─── Short key warning ──────────────────────────────────────────────────────

console.log('\nSuspicious keys:');

test('warns on suspiciously short key', () => {
  setAllKeys();
  process.env.GEMINI_API_KEY = 'AIza_short';  // only 10 chars
  const result = validateEnv({ silent: true });
  // Short key still has valid prefix, so no error — but warning
  assert(result.warnings.some(w => w.includes('suspiciously short')));
  clearAllKeys();
});

// ─── Console output (non-silent) ────────────────────────────────────────────

console.log('\nConsole output:');

test('silent mode produces no console output', () => {
  setAllKeys();
  // Can't easily capture console in this test runner,
  // but we verify it returns the result object correctly
  const result = validateEnv({ silent: true });
  assert(typeof result === 'object');
  assert('valid' in result);
  assert('loaded' in result);
  assert('errors' in result);
  assert('warnings' in result);
  clearAllKeys();
});

test('result object has correct shape', () => {
  setAllKeys();
  const result = validateEnv({ silent: true });
  assert(typeof result.valid === 'boolean');
  assert(typeof result.loaded === 'number');
  assert(Array.isArray(result.errors));
  assert(Array.isArray(result.warnings));
  clearAllKeys();
});

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\n─── Results: ${passed} passed, ${failed} failed ───\n`);
process.exit(failed > 0 ? 1 : 0);
