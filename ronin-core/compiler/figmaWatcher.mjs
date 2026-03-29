// ─── compiler/figmaWatcher.mjs ────────────────────────────────────────────────
// D11 Figma MCP Ambient Watch Mode
//
// Watches Figma files via MCP and detects changes to tracked frames.
// When a frame changes, proactively triggers the fidelity pipeline to maintain
// the Figma→code truth guarantee. This is visual regression in ambient mode.
//
// Modes:
// - Poll mode: periodically checks tracked frames for changes
// - Event mode: receives change notifications (future MCP push support)
//
// ────────────────────────────────────────────────────────────────────────────

import crypto from 'crypto';

/**
 * TrackedFrame data structure
 * @typedef {Object} TrackedFrame
 * @property {string} nodeId - Figma node ID
 * @property {string} fileKey - Figma file key
 * @property {string} componentPath - path to .tsx component in codebase
 * @property {Object} lastSnapshot
 * @property {string} lastSnapshot.hash - hash of serialized node tree
 * @property {string} lastSnapshot.timestamp - ISO timestamp
 * @property {number} lastSnapshot.fidelityScore - last known fidelity score
 * @property {Object} watchConfig
 * @property {number} watchConfig.pollIntervalMs - how often to check (default: 30000)
 * @property {boolean} watchConfig.autoRecompile - auto-trigger pipeline on change (default: false)
 * @property {boolean} watchConfig.notifyOnly - just notify, don't recompile (default: true)
 */

/**
 * ChangeResult from a check
 * @typedef {Object} ChangeResult
 * @property {string} nodeId
 * @property {boolean} changed
 * @property {string} previousHash
 * @property {string} currentHash
 * @property {string} timestamp
 */

/**
 * ChangeEvent in history
 * @typedef {Object} ChangeEvent
 * @property {string} nodeId
 * @property {string} timestamp
 * @property {string} previousHash
 * @property {string} currentHash
 * @property {Object} changeDetails - what changed
 */

/**
 * Compute a deterministic hash of a normalized node tree.
 * Same node always produces same hash.
 * @param {Object} node - Figma node tree
 * @returns {string} hex hash
 */
export function hashNode(node) {
  if (!node || typeof node !== 'object') {
    return '';
  }

  // Normalize: create a copy with sorted keys for consistent ordering
  const normalized = normalizeForHashing(node);
  const jsonStr = JSON.stringify(normalized);
  return crypto.createHash('sha256').update(jsonStr).digest('hex');
}

/**
 * Recursively normalize a node for hashing.
 * Sorts keys, removes timestamps/transient properties.
 * @private
 */
function normalizeForHashing(obj) {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => normalizeForHashing(item));
  }

  // Sort object keys
  const sorted = {};
  const keys = Object.keys(obj).sort();
  for (const key of keys) {
    // Skip transient fields
    if (key === 'timestamp' || key === 'createdAt' || key === 'updatedAt') {
      continue;
    }
    sorted[key] = normalizeForHashing(obj[key]);
  }
  return sorted;
}

/**
 * Compare two node trees and return which properties changed.
 * @param {Object} nodeA
 * @param {Object} nodeB
 * @returns {Object} { changed: boolean, changes: PropertyChange[] }
 * PropertyChange = { nodeId, property, oldValue, newValue }
 */
export function diffNodes(nodeA, nodeB) {
  if (!nodeA || !nodeB) {
    return { changed: true, changes: [] };
  }

  const changes = [];

  // Compare properties at this level
  const keysA = new Set(Object.keys(nodeA));
  const keysB = new Set(Object.keys(nodeB));
  const allKeys = new Set([...keysA, ...keysB]);

  for (const key of allKeys) {
    // Skip children for now (recursive comparison)
    if (key === 'children') {
      continue;
    }

    const valueA = nodeA[key];
    const valueB = nodeB[key];

    if (!deepEqual(valueA, valueB)) {
      changes.push({
        nodeId: nodeA.id || 'unknown',
        property: key,
        oldValue: valueA,
        newValue: valueB,
      });
    }
  }

  // Compare children recursively
  const childrenA = nodeA.children || [];
  const childrenB = nodeB.children || [];

  if (childrenA.length !== childrenB.length) {
    changes.push({
      nodeId: nodeA.id || 'unknown',
      property: 'children.length',
      oldValue: childrenA.length,
      newValue: childrenB.length,
    });
  }

  // For each child, recursively check
  for (let i = 0; i < Math.min(childrenA.length, childrenB.length); i++) {
    const childDiff = diffNodes(childrenA[i], childrenB[i]);
    changes.push(...childDiff.changes);
  }

  return {
    changed: changes.length > 0,
    changes,
  };
}

/**
 * Deep equality check for values (handles objects, arrays, primitives).
 * @private
 */
function deepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;

  if (typeof a === 'object') {
    if (Array.isArray(a) !== Array.isArray(b)) return false;

    if (Array.isArray(a)) {
      if (a.length !== b.length) return false;
      return a.every((item, idx) => deepEqual(item, b[idx]));
    }

    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;

    return keysA.every(key => deepEqual(a[key], b[key]));
  }

  return false;
}

/**
 * Create a mock MCP bridge for testing.
 * @returns {Object} mock bridge with setNode, updateNode, fetchNode
 */
export function createMockMCPBridge() {
  const store = new Map(); // nodeId → node

  return {
    /**
     * Set a node in the mock store (simulates Figma state).
     */
    setNode(nodeId, node) {
      if (!nodeId || !node) {
        throw new Error('setNode requires nodeId and node');
      }
      store.set(nodeId, JSON.parse(JSON.stringify(node))); // deep copy
    },

    /**
     * Update a node (merge properties, simulates designer editing).
     */
    updateNode(nodeId, changes) {
      const node = store.get(nodeId);
      if (!node) {
        throw new Error(`Node ${nodeId} not found in store`);
      }
      Object.assign(node, changes);
      store.set(nodeId, node);
    },

    /**
     * Fetch a node from the store (implements MCP interface).
     */
    async fetchNode(nodeId) {
      const node = store.get(nodeId);
      if (!node) {
        throw new Error(`Node ${nodeId} not found`);
      }
      // Return a copy
      return JSON.parse(JSON.stringify(node));
    },

    /**
     * Get all nodes (for testing).
     */
    getAllNodes() {
      const result = {};
      for (const [id, node] of store) {
        result[id] = JSON.parse(JSON.stringify(node));
      }
      return result;
    },

    /**
     * Clear all nodes.
     */
    clear() {
      store.clear();
    },
  };
}

/**
 * Create a watcher instance.
 * @param {Object} options
 * @param {Object} options.mcpBridge - MCP bridge (injectable for testing)
 * @param {number} options.pollIntervalMs - default poll interval (default: 30000)
 * @param {Function} options.onChangeDetected - callback when change detected
 * @param {Function} options.onError - callback on error
 * @returns {Object} watcher instance
 */
export function createWatcher(options = {}) {
  const {
    mcpBridge = null,
    pollIntervalMs = 30000,
    onChangeDetected = null,
    onError = null,
  } = options;

  const trackedFrames = new Map(); // nodeId → TrackedFrame
  let pollingActive = false;
  let globalPollInterval = pollIntervalMs;
  let pollTimer = null;
  const changeHistory = []; // ChangeEvent[]
  const changeListeners = []; // callback functions
  let stats = {
    framesTracked: 0,
    totalChecks: 0,
    changesDetected: 0,
    lastCheckTime: null,
    isPolling: false,
  };

  // Register initial listener if provided
  if (onChangeDetected) {
    changeListeners.push(onChangeDetected);
  }

  /**
   * Track a new frame.
   */
  function trackFrame(config) {
    if (!config || !config.nodeId || !config.fileKey || !config.componentPath) {
      throw new Error('trackFrame requires nodeId, fileKey, and componentPath');
    }

    const {
      nodeId,
      fileKey,
      componentPath,
      pollIntervalMs: customInterval,
      autoRecompile = false,
      notifyOnly = true,
    } = config;

    const frame = {
      nodeId,
      fileKey,
      componentPath,
      lastSnapshot: {
        hash: null,
        timestamp: null,
        fidelityScore: null,
      },
      watchConfig: {
        pollIntervalMs: customInterval ?? globalPollInterval,
        autoRecompile,
        notifyOnly,
      },
    };

    trackedFrames.set(nodeId, frame);
    stats.framesTracked = trackedFrames.size;

    // Take initial snapshot
    try {
      const snapshot = takeSnapshot(nodeId);
      if (snapshot) {
        frame.lastSnapshot = snapshot;
      }
    } catch (error) {
      if (onError) onError(error);
    }
  }

  /**
   * Stop tracking a frame.
   */
  function untrackFrame(nodeId) {
    trackedFrames.delete(nodeId);
    stats.framesTracked = trackedFrames.size;
  }

  /**
   * Get all tracked frames.
   */
  function getTrackedFrames() {
    return Array.from(trackedFrames.values());
  }

  /**
   * Check if a frame is being tracked.
   */
  function isTracking(nodeId) {
    return trackedFrames.has(nodeId);
  }

  /**
   * Take a snapshot of a frame's current state.
   */
  function takeSnapshot(nodeId) {
    if (!mcpBridge) {
      throw new Error('takeSnapshot requires mcpBridge');
    }

    const frame = trackedFrames.get(nodeId);
    if (!frame) {
      throw new Error(`Frame ${nodeId} is not tracked`);
    }

    // In real implementation, this would fetch from MCP.
    // For now, we store the hash in the frame's snapshot.
    // The actual node data comes from checkForChanges.
    return {
      hash: frame.lastSnapshot?.hash || null,
      timestamp: new Date().toISOString(),
      fidelityScore: frame.lastSnapshot?.fidelityScore || null,
    };
  }

  /**
   * Compare two snapshots.
   */
  function compareSnapshots(snapshotA, snapshotB) {
    if (!snapshotA || !snapshotB) {
      return { changed: true, changes: [] };
    }

    const changes = [];

    if (snapshotA.hash !== snapshotB.hash) {
      changes.push({
        property: 'hash',
        oldValue: snapshotA.hash,
        newValue: snapshotB.hash,
      });
    }

    if (snapshotA.fidelityScore !== snapshotB.fidelityScore) {
      changes.push({
        property: 'fidelityScore',
        oldValue: snapshotA.fidelityScore,
        newValue: snapshotB.fidelityScore,
      });
    }

    return {
      changed: changes.length > 0,
      changes,
    };
  }

  /**
   * Get the latest snapshot for a frame.
   */
  function getLatestSnapshot(nodeId) {
    const frame = trackedFrames.get(nodeId);
    if (!frame) {
      return null;
    }
    return frame.lastSnapshot;
  }

  /**
   * Check for changes in one or all tracked frames.
   */
  async function checkForChanges(nodeId = null) {
    if (!mcpBridge) {
      throw new Error('checkForChanges requires mcpBridge');
    }

    stats.totalChecks++;
    stats.lastCheckTime = new Date().toISOString();

    const results = [];

    const framesToCheck = nodeId
      ? [trackedFrames.get(nodeId)].filter(Boolean)
      : Array.from(trackedFrames.values());

    for (const frame of framesToCheck) {
      try {
        // Fetch current node from MCP
        const currentNode = await mcpBridge.fetchNode(frame.nodeId);
        const currentHash = hashNode(currentNode);

        const previousHash = frame.lastSnapshot?.hash || null;
        const changed = currentHash !== previousHash;

        const result = {
          nodeId: frame.nodeId,
          changed,
          previousHash,
          currentHash,
          timestamp: new Date().toISOString(),
        };

        results.push(result);

        // Update snapshot
        if (changed) {
          frame.lastSnapshot.hash = currentHash;
          frame.lastSnapshot.timestamp = result.timestamp;
          stats.changesDetected++;

          // Record in change history
          changeHistory.push({
            nodeId: frame.nodeId,
            timestamp: result.timestamp,
            previousHash,
            currentHash,
            changeDetails: { changed: true },
          });

          // Notify listeners
          for (const listener of changeListeners) {
            try {
              listener(result);
            } catch (error) {
              if (onError) onError(error);
            }
          }
        }
      } catch (error) {
        if (onError) onError(error);
        results.push({
          nodeId: frame.nodeId,
          changed: false,
          previousHash: null,
          currentHash: null,
          timestamp: new Date().toISOString(),
          error: error.message,
        });
      }
    }

    return results;
  }

  /**
   * Start polling all tracked frames.
   */
  function startPolling() {
    if (pollingActive) {
      return;
    }

    pollingActive = true;
    stats.isPolling = true;

    // Set up polling interval
    const poll = async () => {
      try {
        await checkForChanges();
      } catch (error) {
        if (onError) onError(error);
      }
      if (pollingActive) {
        pollTimer = setTimeout(poll, globalPollInterval);
      }
    };

    pollTimer = setTimeout(poll, globalPollInterval);
  }

  /**
   * Stop polling.
   */
  function stopPolling() {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    pollingActive = false;
    stats.isPolling = false;
  }

  /**
   * Check if polling is active.
   */
  function isPolling() {
    return pollingActive;
  }

  /**
   * Set global poll interval.
   */
  function setPollInterval(ms) {
    globalPollInterval = ms;
  }

  /**
   * Register a change listener.
   */
  function onChangeDetectedListener(callback) {
    if (typeof callback !== 'function') {
      throw new Error('onChangeDetected requires a function');
    }
    changeListeners.push(callback);
  }

  /**
   * Get change history.
   */
  function getChangeHistory(nodeIdFilter = null, limit = 100) {
    let filtered = changeHistory;

    if (nodeIdFilter) {
      filtered = filtered.filter(e => e.nodeId === nodeIdFilter);
    }

    // Return most recent first
    return filtered
      .slice()
      .reverse()
      .slice(0, limit);
  }

  /**
   * Get watcher statistics.
   */
  function getStats() {
    return {
      framesTracked: stats.framesTracked,
      totalChecks: stats.totalChecks,
      changesDetected: stats.changesDetected,
      lastCheckTime: stats.lastCheckTime,
      isPolling: stats.isPolling,
    };
  }

  // Return watcher instance
  return {
    trackFrame,
    untrackFrame,
    getTrackedFrames,
    isTracking,
    checkForChanges,
    computeNodeHash: hashNode,
    startPolling,
    stopPolling,
    isPolling,
    setPollInterval,
    onChangeDetected: onChangeDetectedListener,
    getChangeHistory,
    takeSnapshot,
    compareSnapshots,
    getLatestSnapshot,
    getStats,
  };
}
