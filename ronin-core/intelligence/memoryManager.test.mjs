// ─── intelligence/memoryManager.test.mjs ─────────────────────────────────────
// Test suite for RONIN Memory System Wiring (V8)
//
// Target: 55+ tests, 0 failures
// Uses in-memory backend for all tests (no file system dependency)
// File backend tests use temporary directories with cleanup
// ─────────────────────────────────────────────────────────────────────────────

import {
  createMemoryManager,
  createFileBackend,
  createInMemoryBackend,
} from './memoryManager.mjs';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

// ─── Test Framework ──────────────────────────────────────────────────────────

let testCount = 0;
let passCount = 0;
let failCount = 0;

function assert(condition, message) {
  testCount++;
  if (condition) {
    passCount++;
  } else {
    failCount++;
    console.error(`✗ ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  assert(
    actual === expected,
    `${message} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`
  );
}

function assertDeepEqual(actual, expected, message) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${message} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`
  );
}

function assertNotNull(value, message) {
  assert(value !== null, `${message} (got null)`);
}

function assertNull(value, message) {
  assert(value === null, `${message} (got ${JSON.stringify(value)})`);
}

function assertDefined(value, message) {
  assert(value !== undefined, `${message} (got undefined)`);
}

function assertGreater(actual, expected, message) {
  assert(actual > expected, `${message} (got ${actual}, expected > ${expected})`);
}

function assertLessThan(actual, expected, message) {
  assert(actual < expected, `${message} (got ${actual}, expected < ${expected})`);
}

function assertIncludes(array, value, message) {
  assert(
    array.includes(value),
    `${message} (${value} not in [${array.join(', ')}])`
  );
}

function describe(label) {
  console.log(`\n${label}`);
}

function randomTempDir() {
  return path.join(os.tmpdir(), `ronin-test-${crypto.randomUUID()}`);
}

async function cleanupTempDir(dir) {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {}
}

// ─── Test Suites (SYNC) ──────────────────────────────────────────────────────

describe('## MEMORY MANAGER INITIALIZATION');

(() => {
  const manager = createMemoryManager({ backend: 'memory' });
  assert(manager !== null, 'createMemoryManager returns non-null object');
  assert(typeof manager.saveProfile === 'function', 'has saveProfile method');
  assert(typeof manager.loadProfile === 'function', 'has loadProfile method');
  assert(typeof manager.deleteProfile === 'function', 'has deleteProfile method');
  assert(typeof manager.saveTopologyPreference === 'function', 'has saveTopologyPreference method');
  assert(typeof manager.loadTopologyPreference === 'function', 'has loadTopologyPreference method');
  assert(typeof manager.saveInsightState === 'function', 'has saveInsightState method');
  assert(typeof manager.loadInsightState === 'function', 'has loadInsightState method');
  assert(typeof manager.pruneStaleInsights === 'function', 'has pruneStaleInsights method');
  assert(typeof manager.setSession === 'function', 'has setSession method');
  assert(typeof manager.getSession === 'function', 'has getSession method');
  assert(typeof manager.clearSession === 'function', 'has clearSession method');
  assert(typeof manager.loadOperatorContext === 'function', 'has loadOperatorContext method');
  assert(typeof manager.saveOperatorContext === 'function', 'has saveOperatorContext method');
  assert(typeof manager.getStats === 'function', 'has getStats method');
  assert(typeof manager.listOperators === 'function', 'has listOperators method');
})();

(() => {
  const manager = createMemoryManager();
  assert(manager !== null, 'createMemoryManager() with defaults works');
})();

(() => {
  try {
    createMemoryManager({ backend: 'unknown' });
    assert(false, 'unknown backend throws error');
  } catch (err) {
    assert(err.message.includes('Unknown backend'), 'error message mentions unknown backend');
  }
})();

describe('## IN-MEMORY BACKEND');

(() => {
  const backend = createInMemoryBackend();
  assert(backend !== null, 'createInMemoryBackend returns non-null object');
  assert(typeof backend.read === 'function', 'has read method');
  assert(typeof backend.write === 'function', 'has write method');
  assert(typeof backend.delete === 'function', 'has delete method');
  assert(typeof backend.list === 'function', 'has list method');
  assert(typeof backend.exists === 'function', 'has exists method');
})();

describe('## SESSION MEMORY (SYNC)');

(() => {
  const manager = createMemoryManager({ backend: 'memory' });
  const conversationId = 'conv-1';

  manager.setSession(conversationId, 'key1', 'value1');
  const value = manager.getSession(conversationId, 'key1');

  assertEqual(value, 'value1', 'setSession and getSession roundtrip');
})();

(() => {
  const manager = createMemoryManager({ backend: 'memory' });
  const value = manager.getSession('conv-1', 'missing-key');
  assert(value === undefined, 'getSession returns undefined for missing key');
})();

(() => {
  const manager = createMemoryManager({ backend: 'memory' });
  const value = manager.getSession('unknown-conv', 'key1');
  assert(value === undefined, 'getSession returns undefined for unknown conversation');
})();

(() => {
  const manager = createMemoryManager({ backend: 'memory' });
  const conversationId = 'conv-1';

  manager.setSession(conversationId, 'key1', 'value1');
  manager.setSession(conversationId, 'key2', 'value2');
  manager.clearSession(conversationId);

  const value1 = manager.getSession(conversationId, 'key1');
  const value2 = manager.getSession(conversationId, 'key2');

  assert(value1 === undefined, 'clearSession removes all data (key1)');
  assert(value2 === undefined, 'clearSession removes all data (key2)');
})();

(() => {
  const manager = createMemoryManager({ backend: 'memory' });

  manager.setSession('conv-1', 'key', 'value1');
  manager.setSession('conv-2', 'key', 'value2');

  const value1 = manager.getSession('conv-1', 'key');
  const value2 = manager.getSession('conv-2', 'key');

  assertEqual(value1, 'value1', 'session data isolated per conversation (conv-1)');
  assertEqual(value2, 'value2', 'session data isolated per conversation (conv-2)');
})();

(() => {
  const manager = createMemoryManager({ backend: 'memory' });
  const conversationId = 'conv-1';
  const obj = { nested: { value: 42 } };

  manager.setSession(conversationId, 'data', obj);
  const retrieved = manager.getSession(conversationId, 'data');

  assertDeepEqual(retrieved, obj, 'session can store objects');
})();

(() => {
  const manager1 = createMemoryManager({ backend: 'memory' });
  const manager2 = createMemoryManager({ backend: 'memory' });

  manager1.setSession('conv-1', 'key', 'value');
  const value = manager2.getSession('conv-1', 'key');

  assert(value === undefined, 'session memory is not shared between managers');
})();

// ─── ASYNC TESTS ─────────────────────────────────────────────────────────────

describe('## IN-MEMORY BACKEND (ASYNC)');

await (async () => {
  const backend = createInMemoryBackend();
  const data = { foo: 'bar', nested: { value: 42 } };

  await backend.write('test/key', data);
  const result = await backend.read('test/key');

  assertDeepEqual(result, data, 'in-memory backend write and read roundtrip');
})();

await (async () => {
  const backend = createInMemoryBackend();
  const result = await backend.read('nonexistent/key');
  assertNull(result, 'in-memory backend read returns null for missing key');
})();

await (async () => {
  const backend = createInMemoryBackend();

  await backend.write('test/key', { data: 'value' });
  await backend.delete('test/key');
  const result = await backend.read('test/key');

  assertNull(result, 'in-memory backend delete removes data');
})();

await (async () => {
  const backend = createInMemoryBackend();

  await backend.write('prefix/key1', { a: 1 });
  await backend.write('prefix/key2', { b: 2 });
  await backend.write('other/key', { c: 3 });

  const keys = await backend.list('prefix/');

  assertIncludes(keys, 'prefix/key1', 'in-memory backend list includes prefix/key1');
  assertIncludes(keys, 'prefix/key2', 'in-memory backend list includes prefix/key2');
})();

await (async () => {
  const backend = createInMemoryBackend();

  await backend.write('test/key', {});
  const exists = await backend.exists('test/key');

  assert(exists === true, 'in-memory backend exists returns true for existing key');
})();

await (async () => {
  const backend = createInMemoryBackend();
  const exists = await backend.exists('nonexistent/key');
  assert(exists === false, 'in-memory backend exists returns false for missing key');
})();

await (async () => {
  const backend = createInMemoryBackend();

  const obj1 = { value: 1 };
  const obj2 = { value: 2 };

  await backend.write('key1', obj1);
  await backend.write('key2', obj2);

  const read1 = await backend.read('key1');
  const read2 = await backend.read('key2');

  assertEqual(read1.value, 1, 'in-memory backend data for key1 is isolated');
  assertEqual(read2.value, 2, 'in-memory backend data for key2 is isolated');
})();

describe('## FILE BACKEND');

await (async () => {
  const tempDir = randomTempDir();

  try {
    const backend = createFileBackend(tempDir);

    await backend.write(path.join(tempDir, 'test.json'), { data: 'value' });
    const exists = await backend.exists(path.join(tempDir, 'test.json'));

    assert(exists === true, 'file backend creates directories');
  } finally {
    await cleanupTempDir(tempDir);
  }
})();

await (async () => {
  const tempDir = randomTempDir();

  try {
    const backend = createFileBackend(tempDir);
    const data = { test: 'value', number: 42 };

    await backend.write(path.join(tempDir, 'test.json'), data);
    const result = await backend.read(path.join(tempDir, 'test.json'));

    assertDeepEqual(result, data, 'file backend write and read roundtrip');
  } finally {
    await cleanupTempDir(tempDir);
  }
})();

await (async () => {
  const tempDir = randomTempDir();

  try {
    const backend = createFileBackend(tempDir);
    const result = await backend.read(path.join(tempDir, 'nonexistent.json'));

    assertNull(result, 'file backend read returns null for missing file');
  } finally {
    await cleanupTempDir(tempDir);
  }
})();

await (async () => {
  const tempDir = randomTempDir();

  try {
    const backend = createFileBackend(tempDir);
    const filePath = path.join(tempDir, 'atomic.json');

    const data1 = { version: 1 };
    const data2 = { version: 2 };

    await backend.write(filePath, data1);
    await backend.write(filePath, data2);

    const result = await backend.read(filePath);
    assertEqual(result.version, 2, 'file backend atomic write');

    const files = await fs.readdir(tempDir, { recursive: true });
    const tempFiles = files.filter(f => f.includes('.tmp'));
    assertEqual(tempFiles.length, 0, 'no temp files left behind');
  } finally {
    await cleanupTempDir(tempDir);
  }
})();

describe('## PROFILE PERSISTENCE');

await (async () => {
  const manager = createMemoryManager({ backend: 'memory' });
  const operatorId = 'test-op-1';
  const profile = {
    operatorId,
    dimensions: { verbosity: 0.7, technicalDepth: 0.6 },
    signals: { messageCount: 10 },
  };

  await manager.saveProfile(operatorId, profile);
  const loaded = await manager.loadProfile(operatorId);

  assertEqual(loaded.operatorId, operatorId, 'profile saveProfile/loadProfile roundtrip');
  assertDefined(loaded.persistedAt, 'profile has persistedAt timestamp');
})();

await (async () => {
  const manager = createMemoryManager({ backend: 'memory' });
  const loaded = await manager.loadProfile('unknown-operator');
  assertNull(loaded, 'loadProfile returns null for unknown operator');
})();

await (async () => {
  const manager = createMemoryManager({ backend: 'memory' });
  const operatorId = 'test-op-delete';

  await manager.saveProfile(operatorId, { operatorId });
  await manager.deleteProfile(operatorId);
  const loaded = await manager.loadProfile(operatorId);

  assertNull(loaded, 'deleteProfile removes profile');
})();

await (async () => {
  const manager = createMemoryManager({ backend: 'memory' });
  const operatorId = 'test-op-overwrite';

  await manager.saveProfile(operatorId, { operatorId, value: 1 });
  await manager.saveProfile(operatorId, { operatorId, value: 2 });

  const loaded = await manager.loadProfile(operatorId);
  assertEqual(loaded.value, 2, 'saveProfile overwrites existing');
})();

await (async () => {
  const manager = createMemoryManager({ backend: 'memory' });
  const operatorId = 'test-op-clone';
  const profile = {
    operatorId,
    nested: { value: 42 },
  };

  await manager.saveProfile(operatorId, profile);
  const loaded = await manager.loadProfile(operatorId);

  loaded.nested.value = 99;
  const reloaded = await manager.loadProfile(operatorId);

  assertEqual(reloaded.nested.value, 42, 'profile is deeply cloned');
})();

describe('## TOPOLOGY PREFERENCE PERSISTENCE');

await (async () => {
  const manager = createMemoryManager({ backend: 'memory' });
  const operatorId = 'test-op-topo';
  const preference = {
    topologyScores: {
      directTactical: 0.8,
      systemsView: 0.4,
    },
    acceptCount: 5,
  };

  await manager.saveTopologyPreference(operatorId, preference);
  const loaded = await manager.loadTopologyPreference(operatorId);

  assertEqual(loaded.acceptCount, 5, 'topology preference saveTopologyPreference/loadTopologyPreference roundtrip');
  assertDefined(loaded.persistedAt, 'topology preference has persistedAt');
})();

await (async () => {
  const manager = createMemoryManager({ backend: 'memory' });
  const loaded = await manager.loadTopologyPreference('unknown-operator');
  assertNull(loaded, 'loadTopologyPreference returns null for unknown operator');
})();

await (async () => {
  const manager = createMemoryManager({ backend: 'memory' });

  const pref1 = { topologyScores: { directTactical: 0.9 } };
  const pref2 = { topologyScores: { directTactical: 0.2 } };

  await manager.saveTopologyPreference('op-1', pref1);
  await manager.saveTopologyPreference('op-2', pref2);

  const loaded1 = await manager.loadTopologyPreference('op-1');
  const loaded2 = await manager.loadTopologyPreference('op-2');

  assertEqual(loaded1.topologyScores.directTactical, 0.9, 'topology preferences independent (op-1)');
  assertEqual(loaded2.topologyScores.directTactical, 0.2, 'topology preferences independent (op-2)');
})();

describe('## INSIGHT STATE PERSISTENCE');

await (async () => {
  const manager = createMemoryManager({ backend: 'memory' });
  const operatorId = 'test-op-insight';
  const state = {
    messageCount: 15,
    patterns: [{ type: 'topic-repetition', confidence: 0.8 }],
    trajectories: [{ direction: 'converging' }],
    suggestions: [],
  };

  await manager.saveInsightState(operatorId, state);
  const loaded = await manager.loadInsightState(operatorId);

  assertEqual(loaded.messageCount, 15, 'insight state saveInsightState/loadInsightState roundtrip');
  assertDefined(loaded.persistedAt, 'insight state has persistedAt');
})();

await (async () => {
  const manager = createMemoryManager({ backend: 'memory' });
  const loaded = await manager.loadInsightState('unknown-operator');
  assertNull(loaded, 'loadInsightState returns null for unknown operator');
})();

await (async () => {
  const manager = createMemoryManager({ backend: 'memory' });
  const operatorId = 'test-op-prune';

  const now = new Date().toISOString();
  const thirtyDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();

  const state = {
    messageCount: 10,
    patterns: [
      { type: 'type1', persistedAt: now },
      { type: 'type2', persistedAt: thirtyDaysAgo },
    ],
    trajectories: [],
    suggestions: [],
  };

  await manager.saveInsightState(operatorId, state);
  await manager.pruneStaleInsights(operatorId, 30);

  const loaded = await manager.loadInsightState(operatorId);
  assertEqual(loaded.patterns.length, 1, 'pruneStaleInsights removes old patterns');
  assertEqual(loaded.patterns[0].type, 'type1', 'recent pattern preserved');
})();

await (async () => {
  const manager = createMemoryManager({ backend: 'memory' });
  const operatorId = 'test-op-prune-custom';

  const now = new Date().toISOString();
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

  const state = {
    messageCount: 10,
    patterns: [
      { type: 'type1', persistedAt: now },
      { type: 'type2', persistedAt: tenDaysAgo },
    ],
    trajectories: [],
    suggestions: [],
  };

  await manager.saveInsightState(operatorId, state);
  await manager.pruneStaleInsights(operatorId, 5);  // 5 days max

  const loaded = await manager.loadInsightState(operatorId);
  assertEqual(loaded.patterns.length, 1, 'pruneStaleInsights with custom maxAgeDays');
})();

await (async () => {
  const manager = createMemoryManager({ backend: 'memory' });
  const operatorId = 'test-op-prune-all';

  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();

  const state = {
    messageCount: 10,
    patterns: [{ type: 'p1', persistedAt: old }],
    trajectories: [{ direction: 't1', persistedAt: old }],
    suggestions: [{ type: 's1', persistedAt: old }],
  };

  await manager.saveInsightState(operatorId, state);
  await manager.pruneStaleInsights(operatorId, 30);

  const loaded = await manager.loadInsightState(operatorId);
  assertEqual(loaded.patterns.length, 0, 'pruneStaleInsights prunes patterns');
  assertEqual(loaded.trajectories.length, 0, 'pruneStaleInsights prunes trajectories');
  assertEqual(loaded.suggestions.length, 0, 'pruneStaleInsights prunes suggestions');
})();

describe('## UNIFIED LOAD/SAVE');

await (async () => {
  const manager = createMemoryManager({ backend: 'memory' });
  const operatorId = 'test-op-unified';

  const profile = { operatorId, dimensions: { verbosity: 0.5 } };
  const topology = { topologyScores: { directTactical: 0.7 } };
  const insight = { messageCount: 10, patterns: [], trajectories: [], suggestions: [] };

  await manager.saveProfile(operatorId, profile);
  await manager.saveTopologyPreference(operatorId, topology);
  await manager.saveInsightState(operatorId, insight);

  const context = await manager.loadOperatorContext(operatorId);

  assertDefined(context.profile, 'loadOperatorContext loads profile');
  assertDefined(context.topologyPreference, 'loadOperatorContext loads topology');
  assertDefined(context.insightState, 'loadOperatorContext loads insight');
  assertDefined(context.lastAccessed, 'loadOperatorContext includes lastAccessed');
})();

await (async () => {
  const manager = createMemoryManager({ backend: 'memory' });
  const operatorId = 'test-op-partial';

  await manager.saveProfile(operatorId, { operatorId });

  const context = await manager.loadOperatorContext(operatorId);

  assertNotNull(context.profile, 'loadOperatorContext includes saved profile');
  assertNull(context.topologyPreference, 'loadOperatorContext returns null for unsaved tiers');
})();

await (async () => {
  const manager = createMemoryManager({ backend: 'memory' });
  const operatorId = 'test-op-save-all';

  const context = {
    profile: { operatorId, data: 'profile' },
    topologyPreference: { topologyScores: { directTactical: 0.6 } },
    insightState: { messageCount: 5, patterns: [], trajectories: [], suggestions: [] },
  };

  await manager.saveOperatorContext(operatorId, context);

  const loaded = await manager.loadOperatorContext(operatorId);

  assertEqual(loaded.profile.data, 'profile', 'saveOperatorContext saves all tiers');
  assertEqual(loaded.insightState.messageCount, 5, 'saveOperatorContext saves insight state');
})();

describe('## STATISTICS');

await (async () => {
  const manager = createMemoryManager({ backend: 'memory' });
  const stats = await manager.getStats();

  assert(typeof stats.operatorCount === 'number', 'getStats returns correct format (operatorCount)');
  assert(typeof stats.totalSize === 'number', 'getStats returns correct format (totalSize)');
  assertDefined(stats.oldestProfileAt, 'getStats returns correct format (oldestProfileAt)');
  assertDefined(stats.newestProfileAt, 'getStats returns correct format (newestProfileAt)');
})();

await (async () => {
  const manager = createMemoryManager({ backend: 'memory' });

  await manager.saveProfile('op-1', { operatorId: 'op-1' });
  await manager.saveProfile('op-2', { operatorId: 'op-2' });
  await manager.saveProfile('op-3', { operatorId: 'op-3' });

  const stats = await manager.getStats();

  assertEqual(stats.operatorCount, 3, 'getStats counts operators correctly');
})();

await (async () => {
  const manager = createMemoryManager({ backend: 'memory' });
  const profile = {
    operatorId: 'op-1',
    largeData: 'x'.repeat(1000),
  };

  await manager.saveProfile('op-1', profile);

  const stats = await manager.getStats();

  assertGreater(stats.totalSize, 1000, 'getStats calculates totalSize');
})();

await (async () => {
  const manager = createMemoryManager({ backend: 'memory' });

  await manager.saveProfile('op-1', { operatorId: 'op-1', createdAt: new Date().toISOString() });
  await manager.saveProfile('op-2', { operatorId: 'op-2', createdAt: new Date().toISOString() });

  const stats = await manager.getStats();

  assertDefined(stats.oldestProfileAt, 'getStats tracks oldest profile timestamp');
  assertDefined(stats.newestProfileAt, 'getStats tracks newest profile timestamp');
})();

await (async () => {
  const manager = createMemoryManager({ backend: 'memory' });

  await manager.saveProfile('op-1', { operatorId: 'op-1' });
  await manager.saveProfile('op-2', { operatorId: 'op-2' });

  const operators = await manager.listOperators();

  assertEqual(operators.length, 2, 'listOperators returns all operators');
  assert(operators.some(o => o.operatorId === 'op-1'), 'listOperators includes op-1');
})();

await (async () => {
  const manager = createMemoryManager({ backend: 'memory' });

  await manager.saveProfile('op-1', { operatorId: 'op-1' });

  const operators = await manager.listOperators();

  assertDefined(operators[0].operatorId, 'listOperators includes operatorId');
  assertDefined(operators[0].lastAccessed, 'listOperators includes lastAccessed');
})();

await (async () => {
  const manager = createMemoryManager({ backend: 'memory' });
  const operators = await manager.listOperators();

  assertEqual(operators.length, 0, 'listOperators returns empty when no operators');
})();

describe('## MULTIPLE OPERATORS');

await (async () => {
  const manager = createMemoryManager({ backend: 'memory' });

  const profile1 = { operatorId: 'op-1', value: 1 };
  const profile2 = { operatorId: 'op-2', value: 2 };

  await manager.saveProfile('op-1', profile1);
  await manager.saveProfile('op-2', profile2);

  const loaded1 = await manager.loadProfile('op-1');
  const loaded2 = await manager.loadProfile('op-2');

  assertEqual(loaded1.value, 1, 'multiple operators do not interfere (op-1)');
  assertEqual(loaded2.value, 2, 'multiple operators do not interfere (op-2)');
})();

await (async () => {
  const manager = createMemoryManager({ backend: 'memory' });

  await manager.saveProfile('op-1', { operatorId: 'op-1', value: 1 });
  await manager.saveProfile('op-2', { operatorId: 'op-2', value: 2 });

  await manager.saveProfile('op-1', { operatorId: 'op-1', value: 999 });

  const loaded1 = await manager.loadProfile('op-1');
  const loaded2 = await manager.loadProfile('op-2');

  assertEqual(loaded1.value, 999, 'profile update for one operator affects only that operator');
  assertEqual(loaded2.value, 2, 'profile update for one operator does not affect another');
})();

await (async () => {
  const manager = createMemoryManager({ backend: 'memory' });
  const operatorId = 'e2e-operator';

  const initialProfile = {
    operatorId,
    dimensions: { verbosity: 0.5 },
    signals: { messageCount: 0 },
  };

  await manager.saveProfile(operatorId, initialProfile);

  const updatedProfile = {
    operatorId,
    dimensions: { verbosity: 0.8 },
    signals: { messageCount: 5 },
  };

  await manager.saveProfile(operatorId, updatedProfile);

  const loaded = await manager.loadProfile(operatorId);

  assertEqual(loaded.dimensions.verbosity, 0.8, 'end-to-end: create→learn→save→reload (verbosity)');
  assertEqual(loaded.signals.messageCount, 5, 'end-to-end: create→learn→save→reload (messageCount)');
})();

await (async () => {
  const manager = createMemoryManager({ backend: 'memory' });
  const operatorId = 'multi-session-op';

  const context1 = {
    profile: { operatorId, version: 1 },
    topologyPreference: { topologyScores: { directTactical: 0.5 } },
  };

  await manager.saveOperatorContext(operatorId, context1);

  const context2 = await manager.loadOperatorContext(operatorId);

  assertEqual(context2.profile.version, 1, 'end-to-end session: load existing data (version)');
  assertEqual(context2.topologyPreference.topologyScores.directTactical, 0.5, 'end-to-end session: load existing data (topology)');

  const updatedProfile = { ...context2.profile, version: 2 };
  await manager.saveProfile(operatorId, updatedProfile);

  const context3 = await manager.loadOperatorContext(operatorId);

  assertEqual(context3.profile.version, 2, 'end-to-end session: update persisted');
})();

describe('## EDGE CASES');

await (async () => {
  const manager = createMemoryManager({ backend: 'memory' });
  const profile = {};

  await manager.saveProfile('empty-op', profile);
  const loaded = await manager.loadProfile('empty-op');

  assertDefined(loaded, 'empty profile can be saved and loaded');
  assertDefined(loaded.persistedAt, 'empty profile has persistedAt');
})();

await (async () => {
  const manager = createMemoryManager({ backend: 'memory' });
  const profile = {
    operatorId: 'null-op',
    nullValue: null,
  };

  await manager.saveProfile('null-op', profile);
  const loaded = await manager.loadProfile('null-op');

  assertNull(loaded.nullValue, 'null values in profile are preserved');
})();

await (async () => {
  const manager = createMemoryManager({ backend: 'memory' });
  const largeProfile = {
    operatorId: 'large-op',
    largeArray: Array(1000).fill({ data: 'x'.repeat(100) }),
  };

  await manager.saveProfile('large-op', largeProfile);
  const loaded = await manager.loadProfile('large-op');

  assertEqual(loaded.largeArray.length, 1000, 'very large data can be saved');
})();

await (async () => {
  const manager = createMemoryManager({ backend: 'memory' });
  const operatorId = 'op-with-special_chars.123';

  await manager.saveProfile(operatorId, { operatorId });
  const loaded = await manager.loadProfile(operatorId);

  assertEqual(loaded.operatorId, operatorId, 'special characters in operatorId are handled');
})();

await (async () => {
  const manager = createMemoryManager({ backend: 'memory' });

  const promises = [];
  for (let i = 0; i < 10; i++) {
    const operatorId = `concurrent-op-${i}`;
    promises.push(manager.saveProfile(operatorId, { operatorId, value: i }));
  }

  await Promise.all(promises);

  const stats = await manager.getStats();
  assertEqual(stats.operatorCount, 10, 'concurrent saves to different operators');
})();

await (async () => {
  const manager = createMemoryManager({ backend: 'memory' });
  const operatorId = 'concurrent-read-op';

  await manager.saveProfile(operatorId, { operatorId, value: 42 });

  const reads = Array(10).fill(null).map(() => manager.loadProfile(operatorId));

  const results = await Promise.all(reads);

  assertEqual(results.length, 10, 'concurrent reads after saves (count)');
  assert(results.every(r => r.value === 42), 'concurrent reads after saves (consistency)');
})();

await (async () => {
  const manager = createMemoryManager({ backend: 'memory' });

  try {
    await manager.deleteProfile('nonexistent-op');
    assert(true, 'delete non-existent profile does not throw');
  } catch {
    assert(false, 'delete non-existent profile threw');
  }
})();

await (async () => {
  const manager = createMemoryManager({ backend: 'memory' });

  try {
    await manager.pruneStaleInsights('nonexistent-op');
    assert(true, 'prune stale insights on non-existent operator does not throw');
  } catch {
    assert(false, 'prune stale insights threw');
  }
})();

// ─── Test Summary ───────────────────────────────────────────────────────────

console.log(`\n${'='.repeat(60)}`);
console.log(`TEST SUMMARY: ${passCount}/${testCount} passed${failCount > 0 ? `, ${failCount} failed` : ''}`);
console.log(`${'='.repeat(60)}`);

if (failCount > 0) {
  process.exit(1);
}
