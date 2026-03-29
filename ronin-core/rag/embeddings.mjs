// rag/embeddings.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Gemini text-embedding-004 client
//
// Converts text into 768-dimensional vectors for semantic search.
// Uses Google's Gemini embedding model — free tier, no per-token cost.
//
// Two interfaces:
//   embedSingle(text)     — one text → one vector (for queries)
//   embedBatch(texts[])   — many texts → many vectors (for indexing)
//
// The batch interface chunks requests to stay within Gemini's limits
// (max 100 texts per batch request, max 2048 tokens per text).
//
// Lazy init: reuses the same GoogleGenerativeAI client as geminiProvider.
// API key comes from GEMINI_API_KEY env var.
// ─────────────────────────────────────────────────────────────────────────────

import { GoogleGenerativeAI } from '@google/generative-ai';

// ─── Configuration ──────────────────────────────────────────────────────────

const CONFIG = {
  MODEL: 'text-embedding-004',
  DIMENSIONS: 768,
  BATCH_SIZE: 100,            // Gemini max per batchEmbedContents call
  MAX_TEXT_LENGTH: 8192,      // Characters — truncate beyond this
  TASK_TYPE_QUERY: 'RETRIEVAL_QUERY',
  TASK_TYPE_DOCUMENT: 'RETRIEVAL_DOCUMENT',
};

// ─── Lazy Init ──────────────────────────────────────────────────────────────

let _client = null;
let _model = null;

function getModel() {
  if (!_model) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error('[embeddings] GEMINI_API_KEY not set in environment');
    _client = new GoogleGenerativeAI(key);
    _model = _client.getGenerativeModel({ model: CONFIG.MODEL });
  }
  return _model;
}

// Test injection point
export function _setModel(model) {
  _model = model;
}

// ─── embedSingle(text, taskType?) ───────────────────────────────────────────
// Embed a single text string. Returns a 768-dim float array.
//
// Use RETRIEVAL_QUERY when embedding a search query.
// Use RETRIEVAL_DOCUMENT when embedding content for storage.
//
// Arguments:
//   text     — the string to embed
//   taskType — 'RETRIEVAL_QUERY' (default for single) or 'RETRIEVAL_DOCUMENT'
//
// Returns: { vector: number[768], tokenCount: number }

export async function embedSingle(text, taskType = CONFIG.TASK_TYPE_QUERY) {
  if (!text || typeof text !== 'string') {
    throw new Error('[embeddings] embedSingle requires a non-empty string');
  }

  const truncated = text.slice(0, CONFIG.MAX_TEXT_LENGTH);
  const model = getModel();

  try {
    const result = await model.embedContent({
      content: { parts: [{ text: truncated }] },
      taskType,
    });

    const vector = result.embedding.values;

    if (vector.length !== CONFIG.DIMENSIONS) {
      console.warn(
        `[embeddings] Expected ${CONFIG.DIMENSIONS}d, got ${vector.length}d`
      );
    }

    return {
      vector,
      tokenCount: result.embedding.values.length > 0
        ? Math.ceil(truncated.length / 4) // rough estimate
        : 0,
    };
  } catch (err) {
    if (err.status === 429 || err.message?.includes('429') || err.message?.includes('RESOURCE_EXHAUSTED')) {
      const error = new Error(`[embeddings] Rate limit: ${err.message}`);
      error.status = 429;
      throw error;
    }
    throw new Error(`[embeddings] embedSingle failed: ${err.message}`);
  }
}

// ─── embedBatch(texts, taskType?) ───────────────────────────────────────────
// Embed multiple texts in batches. Returns an array of vectors.
//
// Automatically chunks into batches of 100 (Gemini's limit).
// Use RETRIEVAL_DOCUMENT when indexing a codebase.
//
// Arguments:
//   texts    — array of strings
//   taskType — 'RETRIEVAL_DOCUMENT' (default for batch) or 'RETRIEVAL_QUERY'
//
// Returns: Array<{ vector: number[768], index: number }>
//
// The index field maps each vector back to its position in the input array,
// so you can match vectors to their source chunks.

export async function embedBatch(texts, taskType = CONFIG.TASK_TYPE_DOCUMENT) {
  if (!texts || !Array.isArray(texts) || texts.length === 0) {
    throw new Error('[embeddings] embedBatch requires a non-empty array of strings');
  }

  const model = getModel();
  const results = [];

  // Process in chunks of BATCH_SIZE
  for (let i = 0; i < texts.length; i += CONFIG.BATCH_SIZE) {
    const batch = texts.slice(i, i + CONFIG.BATCH_SIZE);

    const requests = batch.map((text) => ({
      content: { parts: [{ text: text.slice(0, CONFIG.MAX_TEXT_LENGTH) }] },
      taskType,
    }));

    try {
      const response = await model.batchEmbedContents({ requests });

      for (let j = 0; j < response.embeddings.length; j++) {
        results.push({
          vector: response.embeddings[j].values,
          index: i + j,
        });
      }

      // Log progress for large batches
      if (texts.length > CONFIG.BATCH_SIZE) {
        console.log(
          `[embeddings] Batch ${Math.floor(i / CONFIG.BATCH_SIZE) + 1}/` +
          `${Math.ceil(texts.length / CONFIG.BATCH_SIZE)} done ` +
          `(${Math.min(i + CONFIG.BATCH_SIZE, texts.length)}/${texts.length})`
        );
      }
    } catch (err) {
      if (err.status === 429 || err.message?.includes('429') || err.message?.includes('RESOURCE_EXHAUSTED')) {
        const error = new Error(
          `[embeddings] Rate limit on batch ${Math.floor(i / CONFIG.BATCH_SIZE) + 1}: ${err.message}`
        );
        error.status = 429;
        throw error;
      }
      throw new Error(`[embeddings] embedBatch failed at index ${i}: ${err.message}`);
    }
  }

  console.log(`[embeddings] Embedded ${results.length} texts (${CONFIG.DIMENSIONS}d).`);
  return results;
}

// ─── getConfig() ────────────────────────────────────────────────────────────
// Expose config for testing and debugging.

export function getConfig() {
  return { ...CONFIG };
}

// ─── Exports ────────────────────────────────────────────────────────────────

export { CONFIG };

export default {
  embedSingle,
  embedBatch,
  getConfig,
  _setModel,
  CONFIG,
};
