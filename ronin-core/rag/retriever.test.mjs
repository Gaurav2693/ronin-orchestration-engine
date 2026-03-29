// rag/retriever.test.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Tests for Task 12: RAG Retriever
//
// Uses mock Qdrant + mock Gemini embeddings — no live services needed.
// Verifies: retrieval, indexing, context injection, filtering.
// ─────────────────────────────────────────────────────────────────────────────

import { _setClient as setQdrant } from './qdrantClient.mjs';
import { _setModel as setEmbedModel } from './embeddings.mjs';
import {
  retrieveContext,
  indexFile,
  indexFiles,
  isIndexable,
  injectContext,
  CONFIG,
} from './retriever.mjs';

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

function createMockEmbedModel() {
  return {
    embedContent: async ({ content }) => {
      const text = content.parts[0].text;
      const seed = text.length / 1000;
      return { embedding: { values: new Array(768).fill(seed) } };
    },
    batchEmbedContents: async ({ requests }) => {
      const embeddings = requests.map(({ content }) => {
        const text = content.parts[0].text;
        const seed = text.length / 1000;
        return { values: new Array(768).fill(seed) };
      });
      return { embeddings };
    },
  };
}

// ─── Mock Qdrant Client ─────────────────────────────────────────────────────

function createMockQdrant() {
  const collections = new Map();
  const points = new Map();

  return {
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
      const pts = points.get(name);
      return {
        points_count: pts?.size || 0,
        vectors_count: pts?.size || 0,
        status: 'green',
      };
    },

    upsert: async (name, { points: newPoints }) => {
      let store = points.get(name);
      if (!store) {
        points.set(name, new Map());
        store = points.get(name);
      }
      for (const p of newPoints) {
        store.set(p.id, p);
      }
      return { status: 'completed' };
    },

    search: async (name, { vector, limit, filter }) => {
      const store = points.get(name);
      if (!store) return [];

      let results = Array.from(store.values());

      if (filter?.must) {
        for (const condition of filter.must) {
          results = results.filter((p) =>
            p.payload[condition.key] === condition.match.value
          );
        }
      }

      return results.slice(0, limit).map((p, i) => ({
        id: p.id,
        score: 0.95 - i * 0.1, // Descending scores starting high
        payload: p.payload,
      }));
    },

    delete: async (name, { filter }) => {
      const store = points.get(name);
      if (!store) return { status: 'completed' };

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

// Inject mocks
const mockQdrant = createMockQdrant();
setQdrant(mockQdrant);
setEmbedModel(createMockEmbedModel());

console.log('\n─── Task 12: retriever.mjs — Definition of Done ───\n');

// ════════════════════════════════════════════════════════════════════════════
// Test 1: Configuration
// ════════════════════════════════════════════════════════════════════════════
console.log('Configuration:');
{
  assert(CONFIG.DEFAULT_TOP_K === 5, 'default topK is 5');
  assert(CONFIG.MAX_TOP_K === 20, 'max topK is 20');
  assert(CONFIG.MIN_SCORE === 0.3, 'min score threshold is 0.3');
  assert(CONFIG.MAX_FILE_SIZE === 100_000, 'max file size is 100KB');
  assert(CONFIG.INDEXABLE_EXTENSIONS.has('.mjs'), '.mjs is indexable');
  assert(CONFIG.INDEXABLE_EXTENSIONS.has('.py'), '.py is indexable');
  assert(!CONFIG.INDEXABLE_EXTENSIONS.has('.png'), '.png is not indexable');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 2: isIndexable
// ════════════════════════════════════════════════════════════════════════════
console.log('\nisIndexable:');
{
  assert(isIndexable('src/router.mjs') === true, '.mjs is indexable');
  assert(isIndexable('main.py') === true, '.py is indexable');
  assert(isIndexable('README.md') === true, '.md is indexable');
  assert(isIndexable('image.png') === false, '.png is not indexable');
  assert(isIndexable('binary.exe') === false, '.exe is not indexable');
  assert(isIndexable('font.woff2') === false, '.woff2 is not indexable');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 3: indexFile with provided content
// ════════════════════════════════════════════════════════════════════════════
console.log('\nindexFile:');
{
  const code = `// ─── Router Module ──────────────────────────────
import { MODELS } from './modelConfig.mjs';

export function route(message, context) {
  const score = calculateComplexity(message);
  if (context.hasImage) return 'gpt-4o';
  if (context.directorFlag) return 'claude-opus-4-6';
  if (score > 0.7) return 'claude-sonnet-4-6';
  return 'llama-3.3-70b-versatile';
}

export function calculateComplexity(message) {
  let score = 0;
  const words = message.split(' ').length;
  if (words > 50) score += 0.3;
  if (/function|class|async/.test(message)) score += 0.2;
  if (/debug|error|fix/.test(message)) score += 0.2;
  return Math.min(score, 1.0);
}`;

  const result = await indexFile('src/router.mjs', code);
  assert(result.chunksIndexed > 0, `indexed ${result.chunksIndexed} chunks`);
  assert(result.filePath === 'src/router.mjs', 'filePath returned correctly');

  // Verify points are in Qdrant
  const store = mockQdrant._points.get('ronin_codebase');
  assert(store && store.size > 0, `${store.size} points in Qdrant`);

  // Check payload structure
  const firstPoint = Array.from(store.values())[0];
  assert(firstPoint.payload.filePath === 'src/router.mjs', 'payload has filePath');
  assert(firstPoint.payload.content.length > 0, 'payload has content');
  assert(firstPoint.payload.language === 'javascript', 'payload has language');
  assert(firstPoint.payload.indexedAt !== undefined, 'payload has indexedAt timestamp');
  assert(firstPoint.vector.length === 768, 'vector is 768d');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 4: indexFile with empty content
// ════════════════════════════════════════════════════════════════════════════
console.log('\nindexFile edge cases:');
{
  const empty = await indexFile('empty.mjs', '');
  assert(empty.chunksIndexed === 0, 'empty file → 0 chunks');

  const whitespace = await indexFile('ws.mjs', '   \n\n   ');
  assert(whitespace.chunksIndexed === 0, 'whitespace-only file → 0 chunks');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 5: retrieveContext
// ════════════════════════════════════════════════════════════════════════════
console.log('\nretrieveContext:');
{
  const result = await retrieveContext('how does the router work?');

  assert(result.context.length > 0, 'returns non-empty context');
  assert(result.chunks.length > 0, `retrieved ${result.chunks.length} chunks`);
  assert(result.tokenEstimate > 0, 'has token estimate');

  // Context should contain the header
  assert(result.context.includes('[CODEBASE CONTEXT'), 'context has header');

  // Chunks should have expected shape
  const chunk = result.chunks[0];
  assert(chunk.filePath !== undefined, 'chunk has filePath');
  assert(chunk.content !== undefined, 'chunk has content');
  assert(chunk.score !== undefined, 'chunk has score');
  assert(chunk.startLine !== undefined, 'chunk has startLine');
  assert(chunk.endLine !== undefined, 'chunk has endLine');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 6: retrieveContext with empty/null query
// ════════════════════════════════════════════════════════════════════════════
console.log('\nretrieveContext edge cases:');
{
  const empty = await retrieveContext('');
  assert(empty.context === '', 'empty query → empty context');
  assert(empty.chunks.length === 0, 'empty query → no chunks');

  const nullQ = await retrieveContext(null);
  assert(nullQ.context === '', 'null query → empty context');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 7: retrieveContext with topK
// ════════════════════════════════════════════════════════════════════════════
console.log('\nretrieveContext topK:');
{
  const limited = await retrieveContext('route', 1);
  assert(limited.chunks.length <= 1, 'topK=1 limits to 1 chunk');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 8: injectContext
// ════════════════════════════════════════════════════════════════════════════
console.log('\ninjectContext:');
{
  const messages = [
    { role: 'user', content: 'How does routing work?' },
  ];

  const context = 'Some retrieved codebase context here.';
  const injected = injectContext(messages, context);

  assert(injected.length === 3, 'injected adds 2 messages (context + ack)');
  assert(injected[0].role === 'user', 'context message is user role');
  assert(injected[0].content === context, 'context content is preserved');
  assert(injected[1].role === 'assistant', 'ack message is assistant role');
  assert(injected[2].content === 'How does routing work?', 'original message preserved');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 9: injectContext with empty context
// ════════════════════════════════════════════════════════════════════════════
console.log('\ninjectContext edge cases:');
{
  const messages = [{ role: 'user', content: 'hello' }];

  const noContext = injectContext(messages, '');
  assert(noContext.length === 1, 'empty context → messages unchanged');

  const nullContext = injectContext(messages, null);
  assert(nullContext.length === 1, 'null context → messages unchanged');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 10: Re-indexing replaces old vectors
// ════════════════════════════════════════════════════════════════════════════
console.log('\nRe-indexing:');
{
  const store = mockQdrant._points.get('ronin_codebase');
  const countBefore = store.size;

  // Index the same file again with different content
  await indexFile('src/router.mjs', 'export function newRoute() { return "changed"; }');

  // Old vectors for src/router.mjs should be deleted, new ones added
  const countAfter = store.size;
  // The new file is smaller, so fewer chunks
  assert(countAfter <= countBefore, `re-index replaced vectors (${countBefore} → ${countAfter})`);

  // Verify new content is in the store
  const hasNewContent = Array.from(store.values()).some(
    (p) => p.payload.content.includes('newRoute')
  );
  assert(hasNewContent, 'new content indexed after re-index');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 11: indexFiles with mixed file types
// ════════════════════════════════════════════════════════════════════════════
console.log('\nindexFiles:');
{
  // indexFiles can't read from disk in tests, so we test the extension filter
  // by checking isIndexable for each path
  const paths = ['src/app.mjs', 'src/style.css', 'image.png', 'README.md'];
  const indexable = paths.filter(isIndexable);

  assert(indexable.length === 3, 'filters out non-indexable files');
  assert(indexable.includes('src/app.mjs'), 'keeps .mjs');
  assert(indexable.includes('README.md'), 'keeps .md');
  assert(!indexable.includes('image.png'), 'skips .png');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 12: Context format includes file paths and scores
// ════════════════════════════════════════════════════════════════════════════
console.log('\nContext format:');
{
  const result = await retrieveContext('routing logic');

  // Context should include file path references
  assert(result.context.includes('src/router.mjs'), 'context includes file path');

  // Context should include score indicators
  assert(result.context.includes('score:'), 'context includes score');

  // Context should include line numbers
  assert(/L\d+–\d+/.test(result.context), 'context includes line numbers');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 13: Full RAG pipeline simulation
// ════════════════════════════════════════════════════════════════════════════
console.log('\nFull RAG pipeline:');
{
  // Simulate: index → retrieve → inject → ready for model
  const sourceCode = `export function processTask(task) {
  const { type, payload } = task;
  switch (type) {
    case 'code': return handleCode(payload);
    case 'design': return handleDesign(payload);
    default: return handleGeneral(payload);
  }
}`;

  // Index
  await indexFile('src/taskProcessor.mjs', sourceCode);

  // Retrieve
  const { context, chunks } = await retrieveContext('how are tasks processed?');
  assert(context.length > 0, 'pipeline: context retrieved');

  // Inject into conversation
  const messages = [{ role: 'user', content: 'how are tasks processed?' }];
  const enriched = injectContext(messages, context);

  assert(enriched.length === 3, 'pipeline: context injected');
  assert(enriched[0].content.includes('CODEBASE CONTEXT'), 'pipeline: context header present');
  assert(enriched[2].content === 'how are tasks processed?', 'pipeline: original question preserved');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 14: Module exports correct shape
// ════════════════════════════════════════════════════════════════════════════
console.log('\nModule shape:');
{
  const mod = await import('./retriever.mjs');
  assert(typeof mod.retrieveContext === 'function', 'exports retrieveContext');
  assert(typeof mod.indexFile === 'function', 'exports indexFile');
  assert(typeof mod.indexFiles === 'function', 'exports indexFiles');
  assert(typeof mod.isIndexable === 'function', 'exports isIndexable');
  assert(typeof mod.injectContext === 'function', 'exports injectContext');
  assert(typeof mod.CONFIG === 'object', 'exports CONFIG');
  assert(typeof mod.default === 'object', 'default export is object');
}

// ─── Summary ────────────────────────────────────────────────────────────────
console.log(`\n─── Results: ${passed} passed, ${failed} failed ───\n`);
if (failed > 0) process.exit(1);
