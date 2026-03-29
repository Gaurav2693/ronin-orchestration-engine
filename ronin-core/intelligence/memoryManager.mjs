// ─── intelligence/memoryManager.mjs ──────────────────────────────────────────
// RONIN Memory System Wiring (V8) — Persistent Memory Layer
//
// Purpose: Unified memory persistence layer that survives across sessions.
// Persists operator intelligence, topology preferences, and insight state.
//
// Memory Tiers (from architecture doc §13.1):
// - persistent: operator preferences, domain familiarity, long-term patterns
// - session: current task, active direction, short-term context
// - insight: patterns detected, recurring thinking structures
//
// Storage Backend:
// Pluggable backends: JSON files (default) or Redis/Qdrant (future).
// Tests use in-memory backend (no disk I/O).
//
// Single Interface Principle:
// Other modules DO NOT touch files directly — they call memoryManager.
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

// ─── Storage Backends ────────────────────────────────────────────────────────

/**
 * File-based storage backend (default for production).
 * Stores operator data in JSON files at: {storagePath}/{operatorId}/{type}.json
 */
function createFileBackend(storagePath) {
  return {
    async read(key) {
      try {
        const data = await fs.readFile(key, 'utf8');
        return JSON.parse(data);
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
    },

    async write(key, data) {
      const dir = path.dirname(key);
      await fs.mkdir(dir, { recursive: true });

      // Atomic write: write to temp file, then rename
      const tempFile = `${key}.tmp`;
      try {
        await fs.writeFile(tempFile, JSON.stringify(data, null, 2), 'utf8');
        await fs.rename(tempFile, key);
      } catch (err) {
        // Clean up temp file if rename failed
        try {
          await fs.unlink(tempFile);
        } catch {}
        throw err;
      }
    },

    async delete(key) {
      try {
        await fs.unlink(key);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    },

    async list(prefix) {
      try {
        const dir = path.dirname(prefix);
        const files = await fs.readdir(dir, { recursive: true });
        return files
          .map(f => path.join(dir, f))
          .filter(f => f.startsWith(prefix));
      } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
      }
    },

    async exists(key) {
      try {
        await fs.access(key);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * In-memory storage backend (for testing — no disk I/O).
 * Stores everything in a Map.
 */
function createInMemoryBackend() {
  const store = new Map();

  return {
    async read(key) {
      const data = store.get(key);
      if (!data) return null;
      // Deep clone to prevent mutation of stored data
      return JSON.parse(JSON.stringify(data));
    },

    async write(key, data) {
      // Deep clone via JSON serialization
      const cloned = JSON.parse(JSON.stringify(data));
      store.set(key, cloned);
    },

    async delete(key) {
      store.delete(key);
    },

    async list(prefix) {
      return Array.from(store.keys()).filter(k => k.startsWith(prefix));
    },

    async exists(key) {
      return store.has(key);
    },
  };
}

// ─── Memory Manager Factory ──────────────────────────────────────────────────

/**
 * Create a memory manager instance.
 * @param {Object} options
 *   - storagePath: where to store files (default: ./data/memory/)
 *   - backend: 'json' or 'redis' (default: 'json')
 * @returns {Object} MemoryManager instance
 */
function createMemoryManager(options = {}) {
  const { storagePath = './data/memory/', backend = 'json' } = options;

  // Initialize backend
  let storageBackend;
  if (backend === 'json') {
    storageBackend = createFileBackend(storagePath);
  } else if (backend === 'memory') {
    storageBackend = createInMemoryBackend();
  } else {
    throw new Error(`Unknown backend: ${backend}`);
  }

  // Session memory (in-memory, lifetime = session)
  const sessionMemory = new Map();

  // ─── Helper: Get operator data directory path ────────────────────────────
  function getOperatorPath(operatorId, type) {
    return path.join(storagePath, operatorId, `${type}.json`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ─── PUBLIC API ──────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  return {
    // ─── Operator Profile Persistence ───────────────────────────────────────

    /**
     * Save an operator profile to persistent storage.
     * @param {string} operatorId
     * @param {Object} profile
     */
    async saveProfile(operatorId, profile) {
      const key = getOperatorPath(operatorId, 'profile');
      await storageBackend.write(key, {
        ...profile,
        persistedAt: new Date().toISOString(),
      });
    },

    /**
     * Load an operator profile from persistent storage.
     * @param {string} operatorId
     * @returns {Object|null} profile or null if not found
     */
    async loadProfile(operatorId) {
      const key = getOperatorPath(operatorId, 'profile');
      return storageBackend.read(key);
    },

    /**
     * Delete an operator profile.
     * @param {string} operatorId
     */
    async deleteProfile(operatorId) {
      const key = getOperatorPath(operatorId, 'profile');
      await storageBackend.delete(key);
    },

    // ─── Topology Preference Persistence ────────────────────────────────────

    /**
     * Save topology preferences.
     * @param {string} operatorId
     * @param {Object} preference
     */
    async saveTopologyPreference(operatorId, preference) {
      const key = getOperatorPath(operatorId, 'topology');
      await storageBackend.write(key, {
        ...preference,
        persistedAt: new Date().toISOString(),
      });
    },

    /**
     * Load topology preferences.
     * @param {string} operatorId
     * @returns {Object|null} preference or null if not found
     */
    async loadTopologyPreference(operatorId) {
      const key = getOperatorPath(operatorId, 'topology');
      return storageBackend.read(key);
    },

    // ─── Insight State Persistence ──────────────────────────────────────────

    /**
     * Save insight engine state.
     * @param {string} operatorId
     * @param {Object} state
     */
    async saveInsightState(operatorId, state) {
      const key = getOperatorPath(operatorId, 'insights');
      await storageBackend.write(key, {
        ...state,
        persistedAt: new Date().toISOString(),
      });
    },

    /**
     * Load insight engine state.
     * @param {string} operatorId
     * @returns {Object|null} state or null if not found
     */
    async loadInsightState(operatorId) {
      const key = getOperatorPath(operatorId, 'insights');
      return storageBackend.read(key);
    },

    /**
     * Prune stale insights from the insight state.
     * @param {string} operatorId
     * @param {number} maxAgeDays (default 30)
     */
    async pruneStaleInsights(operatorId, maxAgeDays = 30) {
      const state = await this.loadInsightState(operatorId);
      if (!state) return;

      const now = Date.now();
      const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;

      // Prune patterns
      state.patterns = (state.patterns || []).filter(p => {
        const pAt = p.persistedAt ? new Date(p.persistedAt).getTime() : now;
        return now - pAt < maxAgeMs;
      });

      // Prune trajectories
      state.trajectories = (state.trajectories || []).filter(t => {
        const tAt = t.persistedAt ? new Date(t.persistedAt).getTime() : now;
        return now - tAt < maxAgeMs;
      });

      // Prune suggestions
      state.suggestions = (state.suggestions || []).filter(s => {
        const sAt = s.persistedAt ? new Date(s.persistedAt).getTime() : now;
        return now - sAt < maxAgeMs;
      });

      await this.saveInsightState(operatorId, state);
    },

    // ─── Session Memory (In-Memory) ──────────────────────────────────────────

    /**
     * Set a value in session memory.
     * @param {string} conversationId
     * @param {string} key
     * @param {*} value
     */
    setSession(conversationId, key, value) {
      if (!sessionMemory.has(conversationId)) {
        sessionMemory.set(conversationId, {});
      }
      sessionMemory.get(conversationId)[key] = value;
    },

    /**
     * Get a value from session memory.
     * @param {string} conversationId
     * @param {string} key
     * @returns {*} value or undefined
     */
    getSession(conversationId, key) {
      const conv = sessionMemory.get(conversationId);
      return conv ? conv[key] : undefined;
    },

    /**
     * Clear all session data for a conversation.
     * @param {string} conversationId
     */
    clearSession(conversationId) {
      sessionMemory.delete(conversationId);
    },

    // ─── Unified Load/Save ──────────────────────────────────────────────────

    /**
     * Load ALL memory tiers for an operator.
     * @param {string} operatorId
     * @returns {Object} {profile, topologyPreference, insightState, lastAccessed}
     */
    async loadOperatorContext(operatorId) {
      const [profile, topologyPreference, insightState] = await Promise.all([
        this.loadProfile(operatorId),
        this.loadTopologyPreference(operatorId),
        this.loadInsightState(operatorId),
      ]);

      return {
        profile,
        topologyPreference,
        insightState,
        lastAccessed: new Date().toISOString(),
      };
    },

    /**
     * Save all memory tiers for an operator at once.
     * @param {string} operatorId
     * @param {Object} context {profile, topologyPreference, insightState}
     */
    async saveOperatorContext(operatorId, context) {
      const promises = [];

      if (context.profile) {
        promises.push(this.saveProfile(operatorId, context.profile));
      }
      if (context.topologyPreference) {
        promises.push(
          this.saveTopologyPreference(operatorId, context.topologyPreference)
        );
      }
      if (context.insightState) {
        promises.push(this.saveInsightState(operatorId, context.insightState));
      }

      await Promise.all(promises);
    },

    // ─── Statistics ──────────────────────────────────────────────────────────

    /**
     * Get memory statistics.
     * @returns {Object} {operatorCount, totalSize, oldestProfile, newestProfile}
     */
    async getStats() {
      // List all files in storagePath
      const prefix = path.join(storagePath, '');  // normalize
      const allFiles = await storageBackend.list(prefix);

      // Filter only profile.json files
      const profileFiles = allFiles.filter(f => f.endsWith('profile.json'));

      const profiles = await Promise.all(
        profileFiles.map(f => storageBackend.read(f))
      );

      let oldestAt = null;
      let newestAt = null;
      let totalSize = 0;

      for (const profile of profiles) {
        if (!profile) continue;

        const createdAt = profile.createdAt
          ? new Date(profile.createdAt).getTime()
          : 0;
        const persistedAt = profile.persistedAt
          ? new Date(profile.persistedAt).getTime()
          : createdAt;

        if (!oldestAt || createdAt < oldestAt) oldestAt = createdAt;
        if (!newestAt || persistedAt > newestAt) newestAt = persistedAt;

        totalSize += JSON.stringify(profile).length;
      }

      return {
        operatorCount: profileFiles.length,
        totalSize,
        oldestProfileAt: oldestAt ? new Date(oldestAt).toISOString() : null,
        newestProfileAt: newestAt ? new Date(newestAt).toISOString() : null,
      };
    },

    /**
     * List all operators with their last-accessed timestamps.
     * @returns {Array<Object>} [{operatorId, lastAccessed}, ...]
     */
    async listOperators() {
      // List all profile files in storagePath
      const prefix = path.join(storagePath, '');  // normalize
      const profileFiles = await storageBackend.list(prefix);

      const operators = [];

      for (const file of profileFiles) {
        // Only process profile.json files
        if (!file.endsWith('profile.json')) continue;

        const profile = await storageBackend.read(file);
        if (!profile) continue;

        const lastAccessed =
          profile.persistedAt || profile.updatedAt || profile.createdAt;

        // Extract operatorId from path: {storagePath}/{operatorId}/profile.json
        const relative = file.substring(prefix.length);
        const parts = relative.split(path.sep).filter(p => p.length > 0);
        const operatorId = parts.length > 0 ? parts[0] : null;

        if (operatorId) {
          operators.push({
            operatorId,
            lastAccessed,
          });
        }
      }

      // Sort by lastAccessed descending
      operators.sort(
        (a, b) =>
          new Date(b.lastAccessed).getTime() -
          new Date(a.lastAccessed).getTime()
      );

      return operators;
    },
  };
}

// ─── Exports ────────────────────────────────────────────────────────────────

export {
  createMemoryManager,
  createFileBackend,
  createInMemoryBackend,
};

export default {
  createMemoryManager,
  createFileBackend,
  createInMemoryBackend,
};
