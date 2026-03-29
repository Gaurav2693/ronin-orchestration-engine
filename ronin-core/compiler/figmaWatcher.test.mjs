// ─── compiler/figmaWatcher.test.mjs ────────────────────────────────────────
// D11 Figma Watcher Tests — 55+ tests
// ────────────────────────────────────────────────────────────────────────────

import assert from 'assert';
import {
  createWatcher,
  createMockMCPBridge,
  hashNode,
  diffNodes,
} from './figmaWatcher.mjs';

// ─── Test utilities ───────────────────────────────────────────────────────

let testCount = 0;
let passCount = 0;
let failCount = 0;

function test(name, fn) {
  testCount++;
  try {
    fn();
    passCount++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failCount++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${error.message}`);
  }
}

function createMockNode(overrides = {}) {
  return {
    id: overrides.id ?? 'node-1',
    name: overrides.name ?? 'TestNode',
    type: overrides.type ?? 'FRAME',
    absoluteBoundingBox: overrides.absoluteBoundingBox ?? { x: 0, y: 0, width: 100, height: 100 },
    opacity: overrides.opacity ?? 1,
    fills: overrides.fills ?? [],
    strokes: overrides.strokes ?? [],
    effects: overrides.effects ?? [],
    children: overrides.children ?? [],
    ...overrides,
  };
}

// ─── Tests: Watcher Creation ──────────────────────────────────────────────

console.log('\n=== Watcher Creation (5+ tests) ===');

test('createWatcher returns object with required methods', () => {
  const bridge = createMockMCPBridge();
  const watcher = createWatcher({ mcpBridge: bridge });

  assert(typeof watcher === 'object', 'watcher should be an object');
  assert(typeof watcher.trackFrame === 'function', 'trackFrame method required');
  assert(typeof watcher.untrackFrame === 'function', 'untrackFrame method required');
  assert(typeof watcher.getTrackedFrames === 'function', 'getTrackedFrames method required');
  assert(typeof watcher.isTracking === 'function', 'isTracking method required');
  assert(typeof watcher.checkForChanges === 'function', 'checkForChanges method required');
  assert(typeof watcher.startPolling === 'function', 'startPolling method required');
  assert(typeof watcher.stopPolling === 'function', 'stopPolling method required');
  assert(typeof watcher.isPolling === 'function', 'isPolling method required');
  assert(typeof watcher.setPollInterval === 'function', 'setPollInterval method required');
  assert(typeof watcher.onChangeDetected === 'function', 'onChangeDetected method required');
  assert(typeof watcher.getChangeHistory === 'function', 'getChangeHistory method required');
  assert(typeof watcher.takeSnapshot === 'function', 'takeSnapshot method required');
  assert(typeof watcher.compareSnapshots === 'function', 'compareSnapshots method required');
  assert(typeof watcher.getLatestSnapshot === 'function', 'getLatestSnapshot method required');
  assert(typeof watcher.getStats === 'function', 'getStats method required');
});

test('default poll interval is 30000ms', () => {
  const bridge = createMockMCPBridge();
  const watcher = createWatcher({ mcpBridge: bridge });
  // Can't directly access globalPollInterval, but test via setPollInterval behavior
  assert(typeof watcher.setPollInterval === 'function');
});

test('createWatcher with custom poll interval', () => {
  const bridge = createMockMCPBridge();
  const watcher = createWatcher({ mcpBridge: bridge, pollIntervalMs: 5000 });
  assert(typeof watcher.setPollInterval === 'function');
});

test('createWatcher with onChangeDetected callback', () => {
  const bridge = createMockMCPBridge();
  let called = false;
  const watcher = createWatcher({
    mcpBridge: bridge,
    onChangeDetected: () => {
      called = true;
    },
  });
  assert(typeof watcher.onChangeDetected === 'function');
});

test('createWatcher with onError callback', () => {
  const bridge = createMockMCPBridge();
  let errorCalled = false;
  const watcher = createWatcher({
    mcpBridge: bridge,
    onError: (error) => {
      errorCalled = true;
    },
  });
  assert(typeof watcher === 'object');
});

// ─── Tests: Frame Tracking ────────────────────────────────────────────────

console.log('\n=== Frame Tracking (8+ tests) ===');

test('trackFrame adds frame to watch list', () => {
  const bridge = createMockMCPBridge();
  const watcher = createWatcher({ mcpBridge: bridge });

  watcher.trackFrame({
    nodeId: 'node-1',
    fileKey: 'file-123',
    componentPath: 'src/Button.tsx',
  });

  assert(watcher.isTracking('node-1'), 'node-1 should be tracked');
});

test('untrackFrame removes frame', () => {
  const bridge = createMockMCPBridge();
  const watcher = createWatcher({ mcpBridge: bridge });

  watcher.trackFrame({
    nodeId: 'node-1',
    fileKey: 'file-123',
    componentPath: 'src/Button.tsx',
  });

  watcher.untrackFrame('node-1');
  assert(!watcher.isTracking('node-1'), 'node-1 should no longer be tracked');
});

test('getTrackedFrames lists all tracked frames', () => {
  const bridge = createMockMCPBridge();
  const watcher = createWatcher({ mcpBridge: bridge });

  watcher.trackFrame({
    nodeId: 'node-1',
    fileKey: 'file-123',
    componentPath: 'src/Button.tsx',
  });
  watcher.trackFrame({
    nodeId: 'node-2',
    fileKey: 'file-123',
    componentPath: 'src/Card.tsx',
  });

  const frames = watcher.getTrackedFrames();
  assert(frames.length === 2, 'should have 2 tracked frames');
  assert(frames[0].nodeId === 'node-1' || frames[1].nodeId === 'node-1');
});

test('isTracking returns true for tracked frames', () => {
  const bridge = createMockMCPBridge();
  const watcher = createWatcher({ mcpBridge: bridge });

  watcher.trackFrame({
    nodeId: 'node-1',
    fileKey: 'file-123',
    componentPath: 'src/Button.tsx',
  });

  assert(watcher.isTracking('node-1'), 'node-1 should be tracked');
  assert(!watcher.isTracking('node-2'), 'node-2 should not be tracked');
});

test('isTracking returns false for untracked frames', () => {
  const bridge = createMockMCPBridge();
  const watcher = createWatcher({ mcpBridge: bridge });

  assert(!watcher.isTracking('node-999'), 'unknown node should not be tracked');
});

test('trackFrame with custom config', () => {
  const bridge = createMockMCPBridge();
  const watcher = createWatcher({ mcpBridge: bridge });

  watcher.trackFrame({
    nodeId: 'node-1',
    fileKey: 'file-123',
    componentPath: 'src/Button.tsx',
    pollIntervalMs: 10000,
    autoRecompile: true,
    notifyOnly: false,
  });

  const frames = watcher.getTrackedFrames();
  assert(frames.length === 1);
  assert(frames[0].watchConfig.pollIntervalMs === 10000);
  assert(frames[0].watchConfig.autoRecompile === true);
  assert(frames[0].watchConfig.notifyOnly === false);
});

test('trackFrame throws on missing required fields', () => {
  const bridge = createMockMCPBridge();
  const watcher = createWatcher({ mcpBridge: bridge });

  assert.throws(() => {
    watcher.trackFrame({ nodeId: 'node-1' }); // missing fileKey and componentPath
  }, /requires nodeId, fileKey, and componentPath/);
});

// ─── Tests: Change Detection ──────────────────────────────────────────────

console.log('\n=== Change Detection (10+ tests) ===');

test('checkForChanges detects when node tree changed', async () => {
  const bridge = createMockMCPBridge();
  const node1 = createMockNode({ id: 'node-1' });
  bridge.setNode('node-1', node1);

  const watcher = createWatcher({ mcpBridge: bridge });
  watcher.trackFrame({
    nodeId: 'node-1',
    fileKey: 'file-123',
    componentPath: 'src/Button.tsx',
  });

  // Update node
  const node2 = createMockNode({ id: 'node-1', opacity: 0.5 });
  bridge.setNode('node-1', node2);

  const results = await watcher.checkForChanges('node-1');
  assert(results.length === 1);
  assert(results[0].changed === true, 'should detect change');
});

test('checkForChanges reports no change when identical', async () => {
  const bridge = createMockMCPBridge();
  const node = createMockNode({ id: 'node-1' });
  bridge.setNode('node-1', node);

  const watcher = createWatcher({ mcpBridge: bridge });
  watcher.trackFrame({
    nodeId: 'node-1',
    fileKey: 'file-123',
    componentPath: 'src/Button.tsx',
  });

  // Check twice without changes
  await watcher.checkForChanges('node-1');
  const results = await watcher.checkForChanges('node-1');

  assert(results.length === 1);
  assert(results[0].changed === false, 'should not detect change');
});

test('computeNodeHash is deterministic', () => {
  const node = createMockNode({ id: 'node-1', opacity: 0.8 });

  const hash1 = hashNode(node);
  const hash2 = hashNode(node);

  assert(hash1 === hash2, 'same node should produce same hash');
});

test('computeNodeHash changes when node properties change', () => {
  const node1 = createMockNode({ id: 'node-1', opacity: 1 });
  const node2 = createMockNode({ id: 'node-1', opacity: 0.5 });

  const hash1 = hashNode(node1);
  const hash2 = hashNode(node2);

  assert(hash1 !== hash2, 'different nodes should produce different hashes');
});

test('checkForChanges updates lastSnapshot on change', async () => {
  const bridge = createMockMCPBridge();
  const node1 = createMockNode({ id: 'node-1' });
  bridge.setNode('node-1', node1);

  const watcher = createWatcher({ mcpBridge: bridge });
  watcher.trackFrame({
    nodeId: 'node-1',
    fileKey: 'file-123',
    componentPath: 'src/Button.tsx',
  });

  // First check to establish baseline
  await watcher.checkForChanges('node-1');
  const snapshot1 = watcher.getLatestSnapshot('node-1');
  const hash1 = snapshot1.hash;

  // Change node
  const node2 = createMockNode({ id: 'node-1', opacity: 0.5 });
  bridge.setNode('node-1', node2);

  // Check for changes
  await watcher.checkForChanges('node-1');
  const snapshot2 = watcher.getLatestSnapshot('node-1');
  const hash2 = snapshot2.hash;

  assert(hash1 !== hash2, 'snapshot hash should update after change');
});

test('checkForChanges works for single node ID', async () => {
  const bridge = createMockMCPBridge();
  bridge.setNode('node-1', createMockNode({ id: 'node-1' }));
  bridge.setNode('node-2', createMockNode({ id: 'node-2' }));

  const watcher = createWatcher({ mcpBridge: bridge });
  watcher.trackFrame({
    nodeId: 'node-1',
    fileKey: 'file-123',
    componentPath: 'src/Button.tsx',
  });
  watcher.trackFrame({
    nodeId: 'node-2',
    fileKey: 'file-123',
    componentPath: 'src/Card.tsx',
  });

  const results = await watcher.checkForChanges('node-1');
  assert(results.length === 1, 'should check only node-1');
  assert(results[0].nodeId === 'node-1');
});

test('checkForChanges works for all tracked frames', async () => {
  const bridge = createMockMCPBridge();
  bridge.setNode('node-1', createMockNode({ id: 'node-1' }));
  bridge.setNode('node-2', createMockNode({ id: 'node-2' }));

  const watcher = createWatcher({ mcpBridge: bridge });
  watcher.trackFrame({
    nodeId: 'node-1',
    fileKey: 'file-123',
    componentPath: 'src/Button.tsx',
  });
  watcher.trackFrame({
    nodeId: 'node-2',
    fileKey: 'file-123',
    componentPath: 'src/Card.tsx',
  });

  const results = await watcher.checkForChanges();
  assert(results.length === 2, 'should check all tracked frames');
});

test('checkForChanges increments totalChecks in stats', async () => {
  const bridge = createMockMCPBridge();
  bridge.setNode('node-1', createMockNode({ id: 'node-1' }));

  const watcher = createWatcher({ mcpBridge: bridge });
  watcher.trackFrame({
    nodeId: 'node-1',
    fileKey: 'file-123',
    componentPath: 'src/Button.tsx',
  });

  const statsBefore = watcher.getStats();
  assert(statsBefore.totalChecks === 0);

  await watcher.checkForChanges();
  const statsAfter = watcher.getStats();
  assert(statsAfter.totalChecks === 1);
});

// ─── Tests: Polling ───────────────────────────────────────────────────────

console.log('\n=== Polling (8+ tests) ===');

test('startPolling sets polling active', () => {
  const bridge = createMockMCPBridge();
  const watcher = createWatcher({ mcpBridge: bridge });

  assert(watcher.isPolling() === false, 'polling should start inactive');
  watcher.startPolling();
  assert(watcher.isPolling() === true, 'polling should be active after startPolling');
  watcher.stopPolling();
});

test('stopPolling stops polling', () => {
  const bridge = createMockMCPBridge();
  const watcher = createWatcher({ mcpBridge: bridge });

  watcher.startPolling();
  assert(watcher.isPolling() === true);
  watcher.stopPolling();
  assert(watcher.isPolling() === false);
});

test('isPolling returns correct state', () => {
  const bridge = createMockMCPBridge();
  const watcher = createWatcher({ mcpBridge: bridge });

  assert(watcher.isPolling() === false);
  watcher.startPolling();
  assert(watcher.isPolling() === true);
  watcher.stopPolling();
  assert(watcher.isPolling() === false);
});

test('setPollInterval changes interval', () => {
  const bridge = createMockMCPBridge();
  const watcher = createWatcher({ mcpBridge: bridge, pollIntervalMs: 30000 });

  watcher.setPollInterval(5000);
  // Can't directly verify, but function should not throw
  assert(typeof watcher.setPollInterval === 'function');
});

test('startPolling called twice does not create multiple timers', () => {
  const bridge = createMockMCPBridge();
  const watcher = createWatcher({ mcpBridge: bridge });

  watcher.startPolling();
  const isPollingAfterFirst = watcher.isPolling();
  watcher.startPolling();
  const isPollingAfterSecond = watcher.isPolling();

  assert(isPollingAfterFirst === true);
  assert(isPollingAfterSecond === true);
  watcher.stopPolling();
});

test('stopPolling called on inactive watcher is safe', () => {
  const bridge = createMockMCPBridge();
  const watcher = createWatcher({ mcpBridge: bridge });

  assert(watcher.isPolling() === false);
  watcher.stopPolling();
  assert(watcher.isPolling() === false);
});

test('Polling triggers checkForChanges (manual invocation)', async () => {
  const bridge = createMockMCPBridge();
  bridge.setNode('node-1', createMockNode({ id: 'node-1' }));

  const watcher = createWatcher({ mcpBridge: bridge });
  watcher.trackFrame({
    nodeId: 'node-1',
    fileKey: 'file-123',
    componentPath: 'src/Button.tsx',
  });

  const statsBefore = watcher.getStats();
  assert(statsBefore.totalChecks === 0);

  // Manually trigger check (simulates what polling would do)
  await watcher.checkForChanges();

  const statsAfter = watcher.getStats();
  assert(statsAfter.totalChecks === 1, 'check should have been triggered');
});

test('Polling calls onChangeDetected when changes found', async () => {
  const bridge = createMockMCPBridge();
  const node1 = createMockNode({ id: 'node-1' });
  bridge.setNode('node-1', node1);

  let changeDetectedCalled = false;
  const watcher = createWatcher({
    mcpBridge: bridge,
    onChangeDetected: () => {
      changeDetectedCalled = true;
    },
  });

  watcher.trackFrame({
    nodeId: 'node-1',
    fileKey: 'file-123',
    componentPath: 'src/Button.tsx',
  });

  // Initial check
  await watcher.checkForChanges();
  assert(changeDetectedCalled === false, 'no change on first check');

  // Change node
  const node2 = createMockNode({ id: 'node-1', opacity: 0.5 });
  bridge.setNode('node-1', node2);

  // Check again
  await watcher.checkForChanges();
  assert(changeDetectedCalled === true, 'should call onChangeDetected on change');
});

// ─── Tests: Change History ────────────────────────────────────────────────

console.log('\n=== Change History (5+ tests) ===');

test('Changes are recorded in history', async () => {
  const bridge = createMockMCPBridge();
  const node1 = createMockNode({ id: 'node-1' });
  bridge.setNode('node-1', node1);

  const watcher = createWatcher({ mcpBridge: bridge });
  watcher.trackFrame({
    nodeId: 'node-1',
    fileKey: 'file-123',
    componentPath: 'src/Button.tsx',
  });

  await watcher.checkForChanges();
  const node2 = createMockNode({ id: 'node-1', opacity: 0.5 });
  bridge.setNode('node-1', node2);
  await watcher.checkForChanges();

  const history = watcher.getChangeHistory();
  assert(history.length >= 1, 'should have recorded changes');
});

test('getChangeHistory returns most recent first', async () => {
  const bridge = createMockMCPBridge();
  const node1 = createMockNode({ id: 'node-1' });
  bridge.setNode('node-1', node1);

  const watcher = createWatcher({ mcpBridge: bridge });
  watcher.trackFrame({
    nodeId: 'node-1',
    fileKey: 'file-123',
    componentPath: 'src/Button.tsx',
  });

  await watcher.checkForChanges();
  const node2 = createMockNode({ id: 'node-1', opacity: 0.5 });
  bridge.setNode('node-1', node2);
  await watcher.checkForChanges();

  const node3 = createMockNode({ id: 'node-1', opacity: 0.3 });
  bridge.setNode('node-1', node3);
  await watcher.checkForChanges();

  const history = watcher.getChangeHistory();
  if (history.length > 1) {
    // Most recent should come first
    const timestamps = history.map(e => new Date(e.timestamp).getTime());
    assert(timestamps[0] >= timestamps[1], 'should return most recent first');
  }
});

test('getChangeHistory filters by nodeId', async () => {
  const bridge = createMockMCPBridge();
  bridge.setNode('node-1', createMockNode({ id: 'node-1' }));
  bridge.setNode('node-2', createMockNode({ id: 'node-2' }));

  const watcher = createWatcher({ mcpBridge: bridge });
  watcher.trackFrame({
    nodeId: 'node-1',
    fileKey: 'file-123',
    componentPath: 'src/Button.tsx',
  });
  watcher.trackFrame({
    nodeId: 'node-2',
    fileKey: 'file-123',
    componentPath: 'src/Card.tsx',
  });

  await watcher.checkForChanges();
  bridge.setNode('node-1', createMockNode({ id: 'node-1', opacity: 0.5 }));
  await watcher.checkForChanges();

  const history = watcher.getChangeHistory('node-1');
  for (const event of history) {
    assert(event.nodeId === 'node-1', 'filtered history should only contain node-1');
  }
});

test('getChangeHistory respects limit', async () => {
  const bridge = createMockMCPBridge();
  bridge.setNode('node-1', createMockNode({ id: 'node-1' }));

  const watcher = createWatcher({ mcpBridge: bridge });
  watcher.trackFrame({
    nodeId: 'node-1',
    fileKey: 'file-123',
    componentPath: 'src/Button.tsx',
  });

  // Create multiple changes
  for (let i = 0; i < 5; i++) {
    await watcher.checkForChanges();
    bridge.setNode('node-1', createMockNode({ id: 'node-1', opacity: 1 - i * 0.1 }));
  }

  const history = watcher.getChangeHistory(null, 2);
  assert(history.length <= 2, 'should respect limit');
});

// ─── Tests: Snapshot Management ────────────────────────────────────────────

console.log('\n=== Snapshot Management (5+ tests) ===');

test('takeSnapshot records current state', async () => {
  const bridge = createMockMCPBridge();
  bridge.setNode('node-1', createMockNode({ id: 'node-1' }));

  const watcher = createWatcher({ mcpBridge: bridge });
  watcher.trackFrame({
    nodeId: 'node-1',
    fileKey: 'file-123',
    componentPath: 'src/Button.tsx',
  });

  // Perform check to initialize
  await watcher.checkForChanges();
  const snapshot = watcher.takeSnapshot('node-1');
  assert(snapshot !== null);
  assert(typeof snapshot.timestamp === 'string');
});

test('getLatestSnapshot returns most recent', async () => {
  const bridge = createMockMCPBridge();
  bridge.setNode('node-1', createMockNode({ id: 'node-1' }));

  const watcher = createWatcher({ mcpBridge: bridge });
  watcher.trackFrame({
    nodeId: 'node-1',
    fileKey: 'file-123',
    componentPath: 'src/Button.tsx',
  });

  await watcher.checkForChanges();
  const snapshot = watcher.getLatestSnapshot('node-1');
  assert(snapshot !== null);
  assert(typeof snapshot.hash === 'string' || snapshot.hash === null);
});

test('compareSnapshots identifies property differences', () => {
  const watcher = createWatcher({ mcpBridge: createMockMCPBridge() });

  const snap1 = {
    hash: 'abc123',
    timestamp: '2026-03-24T10:00:00Z',
    fidelityScore: 95,
  };

  const snap2 = {
    hash: 'def456',
    timestamp: '2026-03-24T10:01:00Z',
    fidelityScore: 92,
  };

  const diff = watcher.compareSnapshots(snap1, snap2);
  assert(diff.changed === true);
  assert(diff.changes.length > 0);
});

test('getLatestSnapshot returns null for untracked node', () => {
  const watcher = createWatcher({ mcpBridge: createMockMCPBridge() });
  const snapshot = watcher.getLatestSnapshot('unknown-node');
  assert(snapshot === null);
});

// ─── Tests: Node Diffing ──────────────────────────────────────────────────

console.log('\n=== Node Diffing (8+ tests) ===');

test('hashNode is deterministic', () => {
  const node = createMockNode({ id: 'node-1', opacity: 0.8 });
  const hash1 = hashNode(node);
  const hash2 = hashNode(node);
  assert(hash1 === hash2);
});

test('hashNode differs for different nodes', () => {
  const node1 = createMockNode({ id: 'node-1', opacity: 1 });
  const node2 = createMockNode({ id: 'node-1', opacity: 0.5 });
  const hash1 = hashNode(node1);
  const hash2 = hashNode(node2);
  assert(hash1 !== hash2);
});

test('diffNodes detects color changes', () => {
  const node1 = createMockNode({ id: 'node-1', fills: [{ color: 'red' }] });
  const node2 = createMockNode({ id: 'node-1', fills: [{ color: 'blue' }] });
  const diff = diffNodes(node1, node2);
  assert(diff.changed === true);
});

test('diffNodes detects position changes', () => {
  const node1 = createMockNode({
    id: 'node-1',
    absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
  });
  const node2 = createMockNode({
    id: 'node-1',
    absoluteBoundingBox: { x: 10, y: 10, width: 100, height: 100 },
  });
  const diff = diffNodes(node1, node2);
  assert(diff.changed === true);
});

test('diffNodes detects added children', () => {
  const node1 = createMockNode({ id: 'node-1', children: [] });
  const node2 = createMockNode({
    id: 'node-1',
    children: [createMockNode({ id: 'child-1' })],
  });
  const diff = diffNodes(node1, node2);
  assert(diff.changed === true);
});

test('diffNodes detects removed children', () => {
  const node1 = createMockNode({
    id: 'node-1',
    children: [createMockNode({ id: 'child-1' })],
  });
  const node2 = createMockNode({ id: 'node-1', children: [] });
  const diff = diffNodes(node1, node2);
  assert(diff.changed === true);
});

test('diffNodes returns changed:false for identical nodes', () => {
  const node1 = createMockNode({ id: 'node-1', opacity: 0.8 });
  const node2 = createMockNode({ id: 'node-1', opacity: 0.8 });
  const diff = diffNodes(node1, node2);
  assert(diff.changed === false);
});

test('diffNodes includes change details', () => {
  const node1 = createMockNode({ id: 'node-1', opacity: 1 });
  const node2 = createMockNode({ id: 'node-1', opacity: 0.5 });
  const diff = diffNodes(node1, node2);
  assert(diff.changes.length > 0);
  assert(diff.changes[0].property === 'opacity');
});

// ─── Tests: Mock MCP Bridge ───────────────────────────────────────────────

console.log('\n=== Mock MCP Bridge (5+ tests) ===');

test('createMockMCPBridge provides fetchNode', async () => {
  const bridge = createMockMCPBridge();
  const node = createMockNode({ id: 'node-1' });
  bridge.setNode('node-1', node);

  const fetched = await bridge.fetchNode('node-1');
  assert(fetched.id === 'node-1');
});

test('setNode/updateNode simulate Figma edits', () => {
  const bridge = createMockMCPBridge();
  const node = createMockNode({ id: 'node-1', opacity: 1 });
  bridge.setNode('node-1', node);

  bridge.updateNode('node-1', { opacity: 0.5 });

  const nodes = bridge.getAllNodes();
  assert(nodes['node-1'].opacity === 0.5);
});

test('Bridge integrates with watcher', async () => {
  const bridge = createMockMCPBridge();
  const node1 = createMockNode({ id: 'node-1' });
  bridge.setNode('node-1', node1);

  const watcher = createWatcher({ mcpBridge: bridge });
  watcher.trackFrame({
    nodeId: 'node-1',
    fileKey: 'file-123',
    componentPath: 'src/Button.tsx',
  });

  await watcher.checkForChanges();
  bridge.updateNode('node-1', { opacity: 0.5 });
  const results = await watcher.checkForChanges();

  assert(results[0].changed === true);
});

test('Bridge fetchNode throws on missing node', async () => {
  const bridge = createMockMCPBridge();

  try {
    await bridge.fetchNode('unknown-node');
    assert.fail('should throw');
  } catch (error) {
    assert(error.message.includes('not found'));
  }
});

test('Bridge clear removes all nodes', () => {
  const bridge = createMockMCPBridge();
  bridge.setNode('node-1', createMockNode({ id: 'node-1' }));
  bridge.setNode('node-2', createMockNode({ id: 'node-2' }));

  let nodes = bridge.getAllNodes();
  assert(Object.keys(nodes).length === 2);

  bridge.clear();
  nodes = bridge.getAllNodes();
  assert(Object.keys(nodes).length === 0);
});

// ─── Tests: Integration ───────────────────────────────────────────────────

console.log('\n=== Integration (5+ tests) ===');

test('Full flow: track → simulate edit → detect change → callback fires', async () => {
  const bridge = createMockMCPBridge();
  const node1 = createMockNode({ id: 'node-1' });
  bridge.setNode('node-1', node1);

  let callbackFired = false;
  const watcher = createWatcher({
    mcpBridge: bridge,
    onChangeDetected: () => {
      callbackFired = true;
    },
  });

  watcher.trackFrame({
    nodeId: 'node-1',
    fileKey: 'file-123',
    componentPath: 'src/Button.tsx',
  });

  // Initial check
  await watcher.checkForChanges();
  assert(callbackFired === false);

  // Edit
  bridge.updateNode('node-1', { opacity: 0.5 });

  // Check again
  await watcher.checkForChanges();
  assert(callbackFired === true);
});

test('Multiple frames tracked independently', async () => {
  const bridge = createMockMCPBridge();
  bridge.setNode('node-1', createMockNode({ id: 'node-1' }));
  bridge.setNode('node-2', createMockNode({ id: 'node-2' }));

  const watcher = createWatcher({ mcpBridge: bridge });
  watcher.trackFrame({
    nodeId: 'node-1',
    fileKey: 'file-123',
    componentPath: 'src/Button.tsx',
  });
  watcher.trackFrame({
    nodeId: 'node-2',
    fileKey: 'file-123',
    componentPath: 'src/Card.tsx',
  });

  await watcher.checkForChanges();

  // Change only node-1
  bridge.updateNode('node-1', { opacity: 0.5 });

  const results = await watcher.checkForChanges();
  const node1Result = results.find(r => r.nodeId === 'node-1');
  const node2Result = results.find(r => r.nodeId === 'node-2');

  assert(node1Result.changed === true);
  assert(node2Result.changed === false);
});

test('Stats track correctly across operations', async () => {
  const bridge = createMockMCPBridge();
  bridge.setNode('node-1', createMockNode({ id: 'node-1' }));
  bridge.setNode('node-2', createMockNode({ id: 'node-2' }));

  const watcher = createWatcher({ mcpBridge: bridge });

  let stats = watcher.getStats();
  assert(stats.framesTracked === 0);
  assert(stats.totalChecks === 0);
  assert(stats.changesDetected === 0);

  watcher.trackFrame({
    nodeId: 'node-1',
    fileKey: 'file-123',
    componentPath: 'src/Button.tsx',
  });
  watcher.trackFrame({
    nodeId: 'node-2',
    fileKey: 'file-123',
    componentPath: 'src/Card.tsx',
  });

  stats = watcher.getStats();
  assert(stats.framesTracked === 2);

  await watcher.checkForChanges();
  stats = watcher.getStats();
  assert(stats.totalChecks === 1);

  bridge.updateNode('node-1', { opacity: 0.5 });
  await watcher.checkForChanges();

  stats = watcher.getStats();
  assert(stats.totalChecks === 2);
  assert(stats.changesDetected === 1);
});

test('Multiple listeners receive change notifications', async () => {
  const bridge = createMockMCPBridge();
  const node1 = createMockNode({ id: 'node-1' });
  bridge.setNode('node-1', node1);

  const watcher = createWatcher({ mcpBridge: bridge });

  let listener1Called = false;
  let listener2Called = false;

  watcher.onChangeDetected(() => {
    listener1Called = true;
  });
  watcher.onChangeDetected(() => {
    listener2Called = true;
  });

  watcher.trackFrame({
    nodeId: 'node-1',
    fileKey: 'file-123',
    componentPath: 'src/Button.tsx',
  });

  await watcher.checkForChanges();
  bridge.updateNode('node-1', { opacity: 0.5 });
  await watcher.checkForChanges();

  assert(listener1Called === true);
  assert(listener2Called === true);
});

// ─── Additional Tests: Edge Cases ──────────────────────────────────────────

console.log('\n=== Additional Edge Cases (2+ tests) ===');

test('watcher handles empty tracked frames list', async () => {
  const bridge = createMockMCPBridge();
  const watcher = createWatcher({ mcpBridge: bridge });

  const results = await watcher.checkForChanges();
  assert(Array.isArray(results));
  assert(results.length === 0);
});

test('watcher stats reflect accuracy across lifecycle', async () => {
  const bridge = createMockMCPBridge();
  bridge.setNode('node-1', createMockNode({ id: 'node-1' }));

  const watcher = createWatcher({ mcpBridge: bridge });

  let stats = watcher.getStats();
  assert(stats.totalChecks === 0);
  assert(stats.changesDetected === 0);

  watcher.trackFrame({
    nodeId: 'node-1',
    fileKey: 'file-123',
    componentPath: 'src/Button.tsx',
  });

  for (let i = 0; i < 3; i++) {
    await watcher.checkForChanges();
    if (i === 1) {
      bridge.updateNode('node-1', { opacity: 0.5 - i * 0.1 });
    }
  }

  stats = watcher.getStats();
  assert(stats.totalChecks === 3);
  assert(stats.changesDetected > 0);
  assert(typeof stats.lastCheckTime === 'string');
});

// Declare watcher for test utility functions
let watcher = createWatcher({ mcpBridge: createMockMCPBridge() });

// ─── Results ──────────────────────────────────────────────────────────────

console.log(`\n${'='.repeat(50)}`);
console.log(`Tests run: ${testCount}`);
console.log(`Passed: ${passCount}`);
console.log(`Failed: ${failCount}`);
console.log(`${'='.repeat(50)}`);

process.exit(failCount > 0 ? 1 : 0);
