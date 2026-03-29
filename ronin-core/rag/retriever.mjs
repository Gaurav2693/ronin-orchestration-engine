// rag/retriever.mjs
// ─────────────────────────────────────────────────────────────────────────────
// RAG Retriever — Context Injection for RONIN
//
// This is the bridge between the vector store and the orchestration loop.
// When an operator asks a question about their codebase, the retriever:
//
//   1. Embeds the query (via embeddings.mjs)
//   2. Searches Qdrant for nearest chunks (via qdrantClient.mjs)
//   3. Formats the results as context for injection into the conversation
//
// It also handles the indexing side:
//   - indexFile(filePath, content) → chunk + embed + upsert
//   - indexDirectory(dirPath) → walk + index all files
//
// The retriever is designed to plug into runTask.mjs:
//   const context = await retrieveContext(query, topK);
//   // Inject context into messages before sending to the model
//
// ─────────────────────────────────────────────────────────────────────────────

import { embedSingle, embedBatch } from './embeddings.mjs';
import { search, upsert, deleteByFilter, ensureCollection } from './qdrantClient.mjs';
import { chunkFile, detectLanguage } from './chunker.mjs';
import { readFile } from 'fs/promises';
import { join, extname } from 'path';

// ─── Configuration ──────────────────────────────────────────────────────────

const CONFIG = {
  DEFAULT_TOP_K: 5,
  MAX_TOP_K: 20,
  MIN_SCORE: 0.3,                // Ignore results below this relevance
  CONTEXT_HEADER: '[CODEBASE CONTEXT — retrieved from indexed files]',
  // File extensions to index (skip binaries, images, etc.)
  INDEXABLE_EXTENSIONS: new Set([
    '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx',
    '.py', '.rb', '.go', '.rs', '.swift', '.java', '.kt',
    '.md', '.mdx', '.txt',
    '.css', '.scss', '.html',
    '.json', '.yaml', '.yml', '.toml',
    '.sh', '.bash',
    '.env.example', '.gitignore',
  ]),
  MAX_FILE_SIZE: 100_000,       // Skip files > 100KB (likely generated)
};

// ─── retrieveContext(query, topK?, filter?) ─────────────────────────────────
// Main retrieval function. Embeds the query, searches Qdrant, returns
// formatted context ready for injection into conversation messages.
//
// Arguments:
//   query  — the operator's question or the message to find context for
//   topK   — number of chunks to retrieve (default 5)
//   filter — optional Qdrant filter (e.g., limit to specific file/language)
//
// Returns: {
//   context: string,         — formatted text block for injection
//   chunks: Array<{          — raw chunk data for inspection
//     content, filePath, score, startLine, endLine, language, name
//   }>,
//   tokenEstimate: number,   — rough token count of the context block
// }

export async function retrieveContext(query, topK = CONFIG.DEFAULT_TOP_K, filter = null) {
  if (!query || typeof query !== 'string') {
    return { context: '', chunks: [], tokenEstimate: 0 };
  }

  // Clamp topK
  const k = Math.min(Math.max(1, topK), CONFIG.MAX_TOP_K);

  // Step 1: Embed the query
  const { vector } = await embedSingle(query, 'RETRIEVAL_QUERY');

  // Step 2: Search Qdrant
  const results = await search(vector, k, filter);

  // Step 3: Filter by minimum score
  const relevant = results.filter((r) => r.score >= CONFIG.MIN_SCORE);

  if (relevant.length === 0) {
    return { context: '', chunks: [], tokenEstimate: 0 };
  }

  // Step 4: Format chunks into context block
  const chunks = relevant.map((r) => ({
    content: r.payload.content,
    filePath: r.payload.filePath,
    score: r.score,
    startLine: r.payload.startLine,
    endLine: r.payload.endLine,
    language: r.payload.language,
    name: r.payload.functionName || r.payload.name || null,
  }));

  const context = _formatContext(chunks);
  const tokenEstimate = Math.ceil(context.length / 4);

  return { context, chunks, tokenEstimate };
}

// ─── indexFile(filePath, content?) ──────────────────────────────────────────
// Index a single file into the vector store.
//
// Flow:
//   1. Read file content (if not provided)
//   2. Chunk it at structural boundaries
//   3. Embed all chunks in batch
//   4. Delete old vectors for this file (re-index)
//   5. Upsert new vectors
//
// Returns: { chunksIndexed: number, filePath: string }

export async function indexFile(filePath, content = null) {
  // Read content if not provided
  if (content === null) {
    try {
      content = await readFile(filePath, 'utf-8');
    } catch (err) {
      throw new Error(`[retriever] Cannot read file: ${filePath} — ${err.message}`);
    }
  }

  // Skip empty files
  if (!content || content.trim().length === 0) {
    return { chunksIndexed: 0, filePath };
  }

  // Skip oversized files
  if (content.length > CONFIG.MAX_FILE_SIZE) {
    console.warn(`[retriever] Skipping oversized file: ${filePath} (${content.length} chars)`);
    return { chunksIndexed: 0, filePath };
  }

  // Step 1: Chunk the file
  const chunks = chunkFile(content, filePath);
  if (chunks.length === 0) {
    return { chunksIndexed: 0, filePath };
  }

  // Step 2: Embed all chunks
  const texts = chunks.map((c) => c.content);
  const embeddings = await embedBatch(texts, 'RETRIEVAL_DOCUMENT');

  // Step 3: Delete old vectors for this file
  await deleteByFilter({
    must: [{ key: 'filePath', match: { value: filePath } }],
  });

  // Step 4: Build points for Qdrant
  const points = chunks.map((chunk, i) => {
    const embedding = embeddings.find((e) => e.index === i);
    return {
      id: _generateId(filePath, i),
      vector: embedding.vector,
      payload: {
        filePath,
        chunkIndex: i,
        content: chunk.content,
        language: chunk.language,
        functionName: chunk.name,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        type: chunk.type,
        tokenEstimate: chunk.tokenEstimate,
        indexedAt: new Date().toISOString(),
      },
    };
  });

  // Step 5: Upsert
  await upsert(points);

  console.log(`[retriever] Indexed ${filePath}: ${chunks.length} chunks`);
  return { chunksIndexed: chunks.length, filePath };
}

// ─── indexFiles(filePaths) ──────────────────────────────────────────────────
// Index multiple files. Ensures collection exists first.
//
// Returns: { totalChunks: number, filesIndexed: number, skipped: string[] }

export async function indexFiles(filePaths) {
  await ensureCollection();

  let totalChunks = 0;
  let filesIndexed = 0;
  const skipped = [];

  for (const filePath of filePaths) {
    // Check extension
    const ext = extname(filePath).toLowerCase();
    if (!CONFIG.INDEXABLE_EXTENSIONS.has(ext)) {
      skipped.push(filePath);
      continue;
    }

    try {
      const result = await indexFile(filePath);
      if (result.chunksIndexed > 0) {
        totalChunks += result.chunksIndexed;
        filesIndexed++;
      } else {
        skipped.push(filePath);
      }
    } catch (err) {
      console.error(`[retriever] Failed to index ${filePath}: ${err.message}`);
      skipped.push(filePath);
    }
  }

  console.log(
    `[retriever] Indexed ${filesIndexed} files (${totalChunks} chunks). ` +
    `Skipped ${skipped.length}.`
  );

  return { totalChunks, filesIndexed, skipped };
}

// ─── isIndexable(filePath) ──────────────────────────────────────────────────
// Quick check: should we index this file?

export function isIndexable(filePath) {
  const ext = extname(filePath).toLowerCase();
  return CONFIG.INDEXABLE_EXTENSIONS.has(ext);
}

// ─── injectContext(messages, context) ────────────────────────────────────────
// Inject retrieved context into a conversation messages array.
// Adds it as a system-style user message at the beginning.
//
// This is the function runTask.mjs calls to add RAG context.
//
// Returns: new messages array with context prepended.

export function injectContext(messages, context) {
  if (!context || context.length === 0) {
    return messages;
  }

  return [
    { role: 'user', content: context },
    { role: 'assistant', content: 'I have the relevant codebase context. How can I help?' },
    ...messages,
  ];
}

// ─── _formatContext(chunks) ─────────────────────────────────────────────────
// Format retrieved chunks into a readable context block.

function _formatContext(chunks) {
  const sections = chunks.map((chunk, i) => {
    const location = chunk.name
      ? `${chunk.filePath} → ${chunk.name} (L${chunk.startLine}–${chunk.endLine})`
      : `${chunk.filePath} (L${chunk.startLine}–${chunk.endLine})`;

    return `--- ${location} [score: ${chunk.score.toFixed(2)}] ---\n${chunk.content}`;
  });

  return `${CONFIG.CONTEXT_HEADER}\n\n${sections.join('\n\n')}`;
}

// ─── _generateId(filePath, chunkIndex) ──────────────────────────────────────
// Generate a deterministic ID for a chunk. Same file + same chunk index
// always produces the same ID, enabling clean re-indexing.

function _generateId(filePath, chunkIndex) {
  // Simple hash: use string encoding. In production, use a proper hash.
  let hash = 0;
  const str = `${filePath}:${chunkIndex}`;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}

// ─── Exports ────────────────────────────────────────────────────────────────

export { CONFIG };

export default {
  retrieveContext,
  indexFile,
  indexFiles,
  isIndexable,
  injectContext,
  CONFIG,
};
