// rag/qdrantClient.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Qdrant Vector Store Client
//
// Manages the ronin_codebase collection in Qdrant for RAG retrieval.
// This is the storage layer — it accepts pre-computed vectors and returns
// nearest neighbors. It does NOT compute embeddings (that's embeddings.mjs).
//
// Collection spec (from architecture doc):
//   - Name: ronin_codebase
//   - Vector size: 768 (Gemini text-embedding-004)
//   - Distance: Cosine
//
// Lazy init: Qdrant client is NOT created on import. Tests can inject a mock
// via _setClient(). This follows the same pattern as all RONIN providers.
//
// Docker: qdrant/qdrant on port 6333 (see package.json qdrant:start script)
// ─────────────────────────────────────────────────────────────────────────────

import { QdrantClient } from '@qdrant/js-client-rest';

// ─── Configuration ──────────────────────────────────────────────────────────

const CONFIG = {
  COLLECTION_NAME: 'ronin_codebase',
  VECTOR_SIZE: 768,        // Gemini text-embedding-004 output dimension
  DISTANCE: 'Cosine',      // Cosine similarity for semantic search
  HOST: process.env.QDRANT_HOST || 'localhost',
  PORT: parseInt(process.env.QDRANT_PORT || '6333', 10),
};

// ─── Lazy Init ──────────────────────────────────────────────────────────────

let _client = null;

function getClient() {
  if (!_client) {
    _client = new QdrantClient({
      host: CONFIG.HOST,
      port: CONFIG.PORT,
    });
  }
  return _client;
}

// Test injection point
export function _setClient(client) {
  _client = client;
}

// ─── ensureCollection() ─────────────────────────────────────────────────────
// Creates the ronin_codebase collection if it doesn't exist.
// Safe to call multiple times — checks existence first.
//
// Call this once at startup or before the first upsert.

export async function ensureCollection() {
  const client = getClient();

  try {
    const collections = await client.getCollections();
    const exists = collections.collections.some(
      (c) => c.name === CONFIG.COLLECTION_NAME
    );

    if (exists) {
      console.log(`[qdrantClient] Collection "${CONFIG.COLLECTION_NAME}" already exists.`);
      return;
    }

    await client.createCollection(CONFIG.COLLECTION_NAME, {
      vectors: {
        size: CONFIG.VECTOR_SIZE,
        distance: CONFIG.DISTANCE,
      },
    });

    console.log(
      `[qdrantClient] Created collection "${CONFIG.COLLECTION_NAME}" ` +
      `(${CONFIG.VECTOR_SIZE}d, ${CONFIG.DISTANCE}).`
    );
  } catch (err) {
    throw new Error(`[qdrantClient] Failed to ensure collection: ${err.message}`);
  }
}

// ─── upsert(points) ────────────────────────────────────────────────────────
// Insert or update vectors in the collection.
//
// Each point must have:
//   {
//     id: string | number,       — unique identifier (use a hash of file+chunk)
//     vector: number[768],       — embedding from Gemini text-embedding-004
//     payload: {                  — metadata stored alongside the vector
//       filePath: string,
//       chunkIndex: number,
//       content: string,          — the actual code/text chunk
//       language?: string,
//       functionName?: string,
//       startLine?: number,
//       endLine?: number,
//     }
//   }
//
// Returns: operation info from Qdrant

export async function upsert(points) {
  if (!points || points.length === 0) {
    return { status: 'skipped', count: 0 };
  }

  const client = getClient();

  try {
    const result = await client.upsert(CONFIG.COLLECTION_NAME, {
      wait: true,
      points,
    });

    console.log(`[qdrantClient] Upserted ${points.length} points.`);
    return { status: 'ok', count: points.length, result };
  } catch (err) {
    throw new Error(`[qdrantClient] Upsert failed: ${err.message}`);
  }
}

// ─── search(vector, topK, filter?) ──────────────────────────────────────────
// Find the closest vectors to the query vector.
//
// Arguments:
//   vector — 768-dim query embedding
//   topK   — number of results to return (default 5)
//   filter — optional Qdrant filter object for metadata filtering
//            e.g., { must: [{ key: 'language', match: { value: 'javascript' } }] }
//
// Returns: Array of { id, score, payload } sorted by relevance (highest first)

export async function search(vector, topK = 5, filter = null) {
  const client = getClient();

  try {
    const searchParams = {
      vector,
      limit: topK,
      with_payload: true,
      with_vector: false, // Don't return vectors (saves bandwidth)
    };

    if (filter) {
      searchParams.filter = filter;
    }

    const results = await client.search(CONFIG.COLLECTION_NAME, searchParams);

    return results.map((hit) => ({
      id: hit.id,
      score: hit.score,
      payload: hit.payload,
    }));
  } catch (err) {
    throw new Error(`[qdrantClient] Search failed: ${err.message}`);
  }
}

// ─── deleteByFilter(filter) ─────────────────────────────────────────────────
// Delete points matching a filter. Used when re-indexing a file.
//
// Example: delete all chunks from a specific file:
//   deleteByFilter({ must: [{ key: 'filePath', match: { value: 'src/foo.mjs' } }] })

export async function deleteByFilter(filter) {
  const client = getClient();

  try {
    const result = await client.delete(CONFIG.COLLECTION_NAME, {
      wait: true,
      filter,
    });

    console.log(`[qdrantClient] Deleted points by filter.`);
    return result;
  } catch (err) {
    throw new Error(`[qdrantClient] Delete failed: ${err.message}`);
  }
}

// ─── getCollectionInfo() ────────────────────────────────────────────────────
// Returns collection stats: point count, vector config, etc.
// Useful for monitoring and debugging.

export async function getCollectionInfo() {
  const client = getClient();

  try {
    const info = await client.getCollection(CONFIG.COLLECTION_NAME);
    return {
      name: CONFIG.COLLECTION_NAME,
      pointsCount: info.points_count,
      vectorsCount: info.vectors_count,
      status: info.status,
      vectorSize: CONFIG.VECTOR_SIZE,
      distance: CONFIG.DISTANCE,
    };
  } catch (err) {
    throw new Error(`[qdrantClient] Get info failed: ${err.message}`);
  }
}

// ─── Exports ────────────────────────────────────────────────────────────────

export { CONFIG };

export default {
  ensureCollection,
  upsert,
  search,
  deleteByFilter,
  getCollectionInfo,
  _setClient,
  CONFIG,
};
