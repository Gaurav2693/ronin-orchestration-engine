// rag/qdrantClient.test.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Tests for Task 9: Qdrant vector store client
//
// Uses a mock Qdrant client — no live Qdrant needed.
// Verifies: collection management, upsert, search, delete, config.
// ─────────────────────────────────────────────────────────────────────────────

import {
  ensureCollection,
  upsert,
  search,
  deleteByFilter,
  getCollectionInfo,
  _setClient,
  CONFIG,
} from './qdrantClient.mjs';

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

// ─── Mock Qdrant Client ─────────────────────────────────────────────────────
// In-memory mock that implements the subset of QdrantClient API we use.

function createMockQdrant() {
  const collections = new Map();
  const points = new Map(); // collectionName → Map<id, { id, vector, payload }>

  return {
    _collections: collections,
    _points: points,

    getCollections: async () => ({
      collections: Array.from(collections.keys()).map((name) => ({ name })),
    }),

    createCollection: async (name, config) => {
      collections.set(name, config);
      points.set(name, new Map());
      return { result: true };
    },

    getCollection: async (name) => {
      if (!collections.has(name)) throw new Error(`Collection ${name} not found`);
      const pts = points.get(name);
      return {
        points_count: pts?.size || 0,
        vectors_count: pts?.size || 0,
        status: 'green',
      };
    },

    upsert: async (name, { points: newPoints }) => {
      const store = points.get(name);
      if (!store) throw new Error(`Collection ${name} not found`);
      for (const p of newPoints) {
        store.set(p.id, p);
      }
      return { status: 'completed' };
    },

    search: async (name, { vector, limit, filter }) => {
      const store = points.get(name);
      if (!store) throw new Error(`Collection ${name} not found`);

      // Simple mock search: return all points with a fake score
      // Real Qdrant does cosine similarity — we just return in insertion order
      let results = Array.from(store.values());

      // Apply basic filter if present
      if (filter?.must) {
        for (const condition of filter.must) {
          results = results.filter((p) =>
            p.payload[condition.key] === condition.match.value
          );
        }
      }

      return results.slice(0, limit).map((p, i) => ({
        id: p.id,
        score: 1 - i * 0.1, // Fake descending scores
        payload: p.payload,
      }));
    },

    delete: async (name, { filter }) => {
      const store = points.get(name);
      if (!store) throw new Error(`Collection ${name} not found`);

      // Simple filter-based delete
      if (filter?.must) {
        for (const [id, p] of store.entries()) {
          for (const condition of filter.must) {
            if (p.payload[condition.key] === condition.match.value) {
              store.delete(id);
            }
          }
        }
      }
      return { status: 'completed' };
    },
  };
}

// Inject mock before tests
const mockQdrant = createMockQdrant();
_setClient(mockQdrant);

console.log('\n─── Task 9: qdrantClient.mjs — Definition of Done ───\n');

// ════════════════════════════════════════════════════════════════════════════
// Test 1: Configuration
// ════════════════════════════════════════════════════════════════════════════
console.log('Configuration:');
{
  assert(CONFIG.COLLECTION_NAME === 'ronin_codebase', 'collection name is ronin_codebase');
  assert(CONFIG.VECTOR_SIZE === 768, 'vector size is 768 (Gemini embedding dim)');
  assert(CONFIG.DISTANCE === 'Cosine', 'distance metric is Cosine');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 2: ensureCollection creates collection
// ════════════════════════════════════════════════════════════════════════════
console.log('\nensureCollection:');
{
  await ensureCollection();
  assert(mockQdrant._collections.has('ronin_codebase'), 'collection created');

  // Call again — should not throw
  await ensureCollection();
  assert(true, 'idempotent — second call succeeds');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 3: upsert points
// ════════════════════════════════════════════════════════════════════════════
console.log('\nupsert:');
{
  const testPoints = [
    {
      id: 'chunk-001',
      vector: new Array(768).fill(0.1),
      payload: {
        filePath: 'src/router.mjs',
        chunkIndex: 0,
        content: 'export function route(message, context) { ... }',
        language: 'javascript',
        functionName: 'route',
        startLine: 1,
        endLine: 25,
      },
    },
    {
      id: 'chunk-002',
      vector: new Array(768).fill(0.2),
      payload: {
        filePath: 'src/router.mjs',
        chunkIndex: 1,
        content: 'const COMPLEXITY_SIGNALS = { ... }',
        language: 'javascript',
        functionName: null,
        startLine: 26,
        endLine: 50,
      },
    },
    {
      id: 'chunk-003',
      vector: new Array(768).fill(0.3),
      payload: {
        filePath: 'src/compressor.mjs',
        chunkIndex: 0,
        content: 'export class ContextCompressor { ... }',
        language: 'javascript',
        functionName: 'ContextCompressor',
        startLine: 1,
        endLine: 40,
      },
    },
  ];

  const result = await upsert(testPoints);
  assert(result.status === 'ok', 'upsert returns ok status');
  assert(result.count === 3, 'upsert reports correct count');

  const store = mockQdrant._points.get('ronin_codebase');
  assert(store.size === 3, '3 points stored in collection');
  assert(store.get('chunk-001').payload.filePath === 'src/router.mjs',
    'payload preserved correctly');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 4: upsert with empty array skips
// ════════════════════════════════════════════════════════════════════════════
console.log('\nupsert edge cases:');
{
  const empty = await upsert([]);
  assert(empty.status === 'skipped', 'empty array returns skipped');
  assert(empty.count === 0, 'count is 0 for empty upsert');

  const nullResult = await upsert(null);
  assert(nullResult.status === 'skipped', 'null returns skipped');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 5: search returns scored results
// ════════════════════════════════════════════════════════════════════════════
console.log('\nsearch:');
{
  const queryVector = new Array(768).fill(0.15);
  const results = await search(queryVector, 5);

  assert(Array.isArray(results), 'search returns array');
  assert(results.length === 3, 'returns all 3 stored points');
  assert(results[0].score !== undefined, 'results have score');
  assert(results[0].payload !== undefined, 'results have payload');
  assert(results[0].payload.content !== undefined, 'payload includes content');
  assert(results[0].id !== undefined, 'results have id');

  // Test topK limit
  const limited = await search(queryVector, 2);
  assert(limited.length === 2, 'topK limits results correctly');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 6: search with filter
// ════════════════════════════════════════════════════════════════════════════
console.log('\nsearch with filter:');
{
  const queryVector = new Array(768).fill(0.15);
  const filter = {
    must: [{ key: 'filePath', match: { value: 'src/compressor.mjs' } }],
  };

  const results = await search(queryVector, 5, filter);
  assert(results.length === 1, 'filter narrows results to 1');
  assert(results[0].payload.filePath === 'src/compressor.mjs',
    'filtered result matches filter');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 7: deleteByFilter
// ════════════════════════════════════════════════════════════════════════════
console.log('\ndeleteByFilter:');
{
  // Delete all chunks from src/router.mjs
  await deleteByFilter({
    must: [{ key: 'filePath', match: { value: 'src/router.mjs' } }],
  });

  const store = mockQdrant._points.get('ronin_codebase');
  assert(store.size === 1, 'deleted 2 router chunks, 1 compressor remains');
  assert(store.has('chunk-003'), 'compressor chunk survived');
  assert(!store.has('chunk-001'), 'router chunk-001 deleted');
  assert(!store.has('chunk-002'), 'router chunk-002 deleted');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 8: getCollectionInfo
// ════════════════════════════════════════════════════════════════════════════
console.log('\ngetCollectionInfo:');
{
  const info = await getCollectionInfo();
  assert(info.name === 'ronin_codebase', 'reports correct collection name');
  assert(info.pointsCount === 1, 'reports correct point count');
  assert(info.vectorSize === 768, 'reports correct vector size');
  assert(info.distance === 'Cosine', 'reports correct distance metric');
  assert(info.status === 'green', 'collection status is green');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 9: Module exports correct shape
// ════════════════════════════════════════════════════════════════════════════
console.log('\nModule shape:');
{
  const mod = await import('./qdrantClient.mjs');
  assert(typeof mod.ensureCollection === 'function', 'exports ensureCollection');
  assert(typeof mod.upsert === 'function', 'exports upsert');
  assert(typeof mod.search === 'function', 'exports search');
  assert(typeof mod.deleteByFilter === 'function', 'exports deleteByFilter');
  assert(typeof mod.getCollectionInfo === 'function', 'exports getCollectionInfo');
  assert(typeof mod._setClient === 'function', 'exports _setClient for testing');
  assert(typeof mod.default === 'object', 'default export is an object');
}

// ─── Summary ────────────────────────────────────────────────────────────────
console.log(`\n─── Results: ${passed} passed, ${failed} failed ───\n`);
if (failed > 0) process.exit(1);
