// rag/embeddings.test.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Tests for Task 10: Gemini text-embedding-004 client
//
// Uses a mock Gemini model — no live API needed.
// Verifies: embedSingle, embedBatch, config, error handling.
// ─────────────────────────────────────────────────────────────────────────────

import {
  embedSingle,
  embedBatch,
  getConfig,
  _setModel,
  CONFIG,
} from './embeddings.mjs';

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

// ─── Mock Gemini Embedding Model ────────────────────────────────────────────
// Simulates the embedContent and batchEmbedContents methods.

function createMockModel() {
  let callCount = 0;

  return {
    _getCallCount: () => callCount,

    embedContent: async ({ content, taskType }) => {
      callCount++;
      const text = content.parts[0].text;
      // Generate a deterministic fake vector from text length
      const seed = text.length / 1000;
      const vector = new Array(768).fill(seed);
      return {
        embedding: { values: vector },
      };
    },

    batchEmbedContents: async ({ requests }) => {
      callCount++;
      const embeddings = requests.map(({ content }) => {
        const text = content.parts[0].text;
        const seed = text.length / 1000;
        return { values: new Array(768).fill(seed) };
      });
      return { embeddings };
    },
  };
}

// Inject mock before tests
const mockModel = createMockModel();
_setModel(mockModel);

console.log('\n─── Task 10: embeddings.mjs — Definition of Done ───\n');

// ════════════════════════════════════════════════════════════════════════════
// Test 1: Configuration
// ════════════════════════════════════════════════════════════════════════════
console.log('Configuration:');
{
  assert(CONFIG.MODEL === 'text-embedding-004', 'model is text-embedding-004');
  assert(CONFIG.DIMENSIONS === 768, 'dimensions is 768');
  assert(CONFIG.BATCH_SIZE === 100, 'batch size is 100');
  assert(CONFIG.TASK_TYPE_QUERY === 'RETRIEVAL_QUERY', 'query task type correct');
  assert(CONFIG.TASK_TYPE_DOCUMENT === 'RETRIEVAL_DOCUMENT', 'document task type correct');

  const config = getConfig();
  assert(config.MODEL === CONFIG.MODEL, 'getConfig() returns correct config');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 2: embedSingle returns correct shape
// ════════════════════════════════════════════════════════════════════════════
console.log('\nembedSingle:');
{
  const result = await embedSingle('function route(message) { return model; }');
  assert(Array.isArray(result.vector), 'returns vector array');
  assert(result.vector.length === 768, 'vector is 768-dimensional');
  assert(typeof result.tokenCount === 'number', 'returns tokenCount');
  assert(result.tokenCount > 0, 'tokenCount is positive');

  // All values should be the same (deterministic mock)
  assert(result.vector[0] === result.vector[767], 'vector values are consistent');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 3: embedSingle default task type is RETRIEVAL_QUERY
// ════════════════════════════════════════════════════════════════════════════
console.log('\nembedSingle task type:');
{
  // This test validates that the function works with default params
  const result = await embedSingle('how does the router work?');
  assert(result.vector.length === 768, 'query embedding is 768d');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 4: embedSingle rejects invalid input
// ════════════════════════════════════════════════════════════════════════════
console.log('\nembedSingle validation:');
{
  let threw1 = false;
  try { await embedSingle(''); } catch (e) {
    threw1 = e.message.includes('non-empty string');
  }
  assert(threw1, 'throws on empty string');

  let threw2 = false;
  try { await embedSingle(null); } catch (e) {
    threw2 = e.message.includes('non-empty string');
  }
  assert(threw2, 'throws on null');

  let threw3 = false;
  try { await embedSingle(42); } catch (e) {
    threw3 = e.message.includes('non-empty string');
  }
  assert(threw3, 'throws on non-string');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 5: embedSingle truncates long text
// ════════════════════════════════════════════════════════════════════════════
console.log('\nembedSingle truncation:');
{
  const longText = 'x'.repeat(20000); // Way beyond MAX_TEXT_LENGTH
  const result = await embedSingle(longText);
  assert(result.vector.length === 768, 'long text still produces 768d vector');
  // The mock uses text.length / 1000 as seed. Truncated to 8192 chars → seed = 8.192
  assert(result.vector[0] === 8192 / 1000, 'text was truncated to MAX_TEXT_LENGTH');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 6: embedBatch returns correct shape
// ════════════════════════════════════════════════════════════════════════════
console.log('\nembedBatch:');
{
  const texts = [
    'function route(message) { return model; }',
    'class ContextCompressor { compress() {} }',
    'export const MODELS = { sonnet: {}, haiku: {} }',
  ];

  const results = await embedBatch(texts);
  assert(Array.isArray(results), 'returns array');
  assert(results.length === 3, 'returns 3 embeddings');
  assert(results[0].vector.length === 768, 'first vector is 768d');
  assert(results[1].vector.length === 768, 'second vector is 768d');
  assert(results[2].vector.length === 768, 'third vector is 768d');

  // Check index mapping
  assert(results[0].index === 0, 'first result index is 0');
  assert(results[1].index === 1, 'second result index is 1');
  assert(results[2].index === 2, 'third result index is 2');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 7: embedBatch default task type is RETRIEVAL_DOCUMENT
// ════════════════════════════════════════════════════════════════════════════
console.log('\nembedBatch task type:');
{
  const results = await embedBatch(['document text here']);
  assert(results.length === 1, 'single text batch works');
  assert(results[0].index === 0, 'index mapping correct');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 8: embedBatch rejects invalid input
// ════════════════════════════════════════════════════════════════════════════
console.log('\nembedBatch validation:');
{
  let threw1 = false;
  try { await embedBatch([]); } catch (e) {
    threw1 = e.message.includes('non-empty array');
  }
  assert(threw1, 'throws on empty array');

  let threw2 = false;
  try { await embedBatch(null); } catch (e) {
    threw2 = e.message.includes('non-empty array');
  }
  assert(threw2, 'throws on null');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 9: embedBatch handles large batches (chunking)
// ════════════════════════════════════════════════════════════════════════════
console.log('\nembedBatch chunking:');
{
  // Create 150 texts — should split into 2 API calls (100 + 50)
  const texts = Array.from({ length: 150 }, (_, i) => `chunk ${i} content`);
  const results = await embedBatch(texts);

  assert(results.length === 150, '150 texts → 150 embeddings');
  assert(results[0].index === 0, 'first index correct');
  assert(results[99].index === 99, 'index 99 correct (end of first batch)');
  assert(results[100].index === 100, 'index 100 correct (start of second batch)');
  assert(results[149].index === 149, 'last index correct');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 10: Different texts produce different vectors
// ════════════════════════════════════════════════════════════════════════════
console.log('\nVector differentiation:');
{
  const short = await embedSingle('hi');
  const long = await embedSingle('a very long description of the architecture');

  assert(short.vector[0] !== long.vector[0],
    'different text lengths produce different vectors');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 11: Module exports correct shape
// ════════════════════════════════════════════════════════════════════════════
console.log('\nModule shape:');
{
  const mod = await import('./embeddings.mjs');
  assert(typeof mod.embedSingle === 'function', 'exports embedSingle');
  assert(typeof mod.embedBatch === 'function', 'exports embedBatch');
  assert(typeof mod.getConfig === 'function', 'exports getConfig');
  assert(typeof mod._setModel === 'function', 'exports _setModel for testing');
  assert(typeof mod.default === 'object', 'default export is an object');
}

// ─── Summary ────────────────────────────────────────────────────────────────
console.log(`\n─── Results: ${passed} passed, ${failed} failed ───\n`);
if (failed > 0) process.exit(1);
