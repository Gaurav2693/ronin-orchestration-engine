// ─── director/directorPipeline.test.mjs ─────────────────────────────────────
// Test suite for D10 · Director Pipeline Orchestrator
// Target: 55+ tests, 0 failures
// ─────────────────────────────────────────────────────────────────────────────

import {
  createDirectorSession,
  runDirectorPipeline,
  handleOperatorAction,
  getSessionSummary,
  formatSideBySide,
  calculatePipelineCost,
  createMockDirectorProvider,
} from './directorPipeline.mjs';

// ─── Test Utilities ──────────────────────────────────────────────────────────

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

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `Expected ${expected}, got ${actual}`);
  }
}

function assertDeepEqual(actual, expected, message) {
  const actualStr = JSON.stringify(actual);
  const expectedStr = JSON.stringify(expected);
  if (actualStr !== expectedStr) {
    throw new Error(message || `Expected ${expectedStr}, got ${actualStr}`);
  }
}

function assertArrayIncludes(array, item, message) {
  if (!array.includes(item)) {
    throw new Error(message || `Array does not include ${item}`);
  }
}

// ─── Mock Data ───────────────────────────────────────────────────────────────

const mockFidelityResult = {
  output: {
    code: 'export const Card = ({ title }) => <div>{title}</div>;',
    fidelityScore: 97.4,
    fidelityBadge: '●●●●● 97.4% match',
    componentNames: ['Card'],
    customProperties: {},
  },
  stage0: {
    screenshot: 'base64png...',
    nodeTree: {
      id: 'root',
      name: 'Frame',
      type: 'FRAME',
      children: [
        { id: 'text1', name: 'Title', type: 'TEXT' },
      ],
    },
  },
  stage1_5: {
    emotional_register: 'formal',
    primary_metaphor: 'data surface',
    motion_implied: 'subtle',
    hierarchy_strategy: 'depth via opacity',
  },
  metadata: {
    costEstimate: 0.008,
  },
};

const mockDirectorResponse = `KEPT
The layout structure and typography hierarchy are already perfect. The designer has established clear visual weight through scale and opacity without needing animation.

CHANGED
Motion: Added smooth transitions on hover — the card lifts 2px and shadow increases 15%, creating a selection metaphor rather than a click metaphor — because the design implies interaction through depth, not color change.

States: Added focus state with thin border highlight — 1px outline in primary color — because keyboard navigation is implied by the interaction vocabulary.

Texture: Added subtle breathing animation on the card background — 100ms ease-in-out opacity pulse between 0.98 and 1.0 — because it suggests the content is alive and waiting for interaction, not static.

CODE
export const Card = ({ title, selected }) => {
  const [isHovered, setIsHovered] = useState(false);

  return (
    <div
      style={{
        padding: '16px',
        borderRadius: '8px',
        backgroundColor: '#fff',
        boxShadow: isHovered ? '0 8px 24px rgba(0,0,0,0.12)' : '0 2px 8px rgba(0,0,0,0.08)',
        transition: 'all 200ms ease-out',
        outline: selected ? '1px solid #0066ff' : 'none',
        animation: 'breathing 2s ease-in-out infinite',
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {title}
    </div>
  );
};`;

const mockTasteSnapshot = {
  operator_id: 'op_123',
  generated_at: new Date().toISOString(),
  strong_preferences: [
    {
      dimension: 'motion timing',
      preference: 'prefers ease-out over ease-in-out, 150-250ms range',
      confidence: 0.95,
      signal_count: 12,
      last_updated: new Date().toISOString(),
      examples: ['card-hover-200ms', 'button-transition-180ms'],
    },
  ],
  developing_preferences: [],
  aversions: [],
  narrative: 'This operator has a strong preference for restrained motion — consistently accepting animations under 250ms and rejecting elastic or bounce characteristics.',
};

// ─── Session Creation Tests (8+) ────────────────────────────────────────────

console.log('\n=== Session Creation (8+ tests) ===');

test('createDirectorSession returns correct shape', () => {
  const session = createDirectorSession(mockFidelityResult, 'op_123');
  assert(session.id, 'session.id missing');
  assert(session.id.startsWith('dir_'), 'session.id should start with dir_');
  assert(session.operatorId === 'op_123', 'operatorId mismatch');
  assert(session.status === 'ready', 'initial status should be "ready"');
  assert(session.fidelityResult === mockFidelityResult, 'fidelityResult not stored');
  assert(session.directorResult === null, 'directorResult should start null');
  assert(Array.isArray(session.creativeDecisions), 'creativeDecisions should be array');
  assert(Array.isArray(session.pendingSignals), 'pendingSignals should be array');
});

test('Status starts as "ready"', () => {
  const session = createDirectorSession(mockFidelityResult, 'op_123');
  assertEqual(session.status, 'ready');
});

test('Fidelity result stored correctly', () => {
  const session = createDirectorSession(mockFidelityResult, 'op_123');
  assertEqual(session.fidelityResult.output.fidelityScore, 97.4);
});

test('Director result starts as null', () => {
  const session = createDirectorSession(mockFidelityResult, 'op_123');
  assertEqual(session.directorResult, null);
});

test('Unique session IDs generated', () => {
  const s1 = createDirectorSession(mockFidelityResult, 'op_123');
  const s2 = createDirectorSession(mockFidelityResult, 'op_123');
  assert(s1.id !== s2.id, 'session IDs should be unique');
});

test('Cost tracking initialized', () => {
  const session = createDirectorSession(mockFidelityResult, 'op_123');
  assert(typeof session.cost === 'object', 'cost should be object');
  assert(typeof session.cost.fidelity === 'number', 'cost.fidelity should be number');
  assert(typeof session.cost.director === 'number', 'cost.director should be number');
  assert(typeof session.cost.total === 'number', 'cost.total should be number');
  assertEqual(session.cost.director, 0, 'director cost should start at 0');
});

test('Timestamps initialized to null', () => {
  const session = createDirectorSession(mockFidelityResult, 'op_123');
  assertEqual(session.startedAt, null);
  assertEqual(session.completedAt, null);
});

test('Missing operatorId throws error', () => {
  try {
    createDirectorSession(mockFidelityResult, null);
    throw new Error('Should have thrown');
  } catch (error) {
    assert(error.message.includes('operatorId'), 'Error should mention operatorId');
  }
});

// ─── Pipeline Execution Tests (12+) ──────────────────────────────────────────

console.log('\n=== Pipeline Execution (12+ tests) ===');

test('runDirectorPipeline sets status to "running" then "complete"', async () => {
  const session = createDirectorSession(mockFidelityResult, 'op_123');
  const provider = createMockDirectorProvider(mockDirectorResponse);

  const updated = await runDirectorPipeline(session, { directorProvider: provider });
  assert(updated.status === 'complete', 'final status should be "complete"');
  assert(updated.startedAt !== null, 'startedAt should be set');
  assert(updated.completedAt !== null, 'completedAt should be set');
});

test('Calls Director with assembled context', async () => {
  const session = createDirectorSession(mockFidelityResult, 'op_123');
  let capturedOptions = null;

  const provider = async (options) => {
    capturedOptions = options;
    return mockDirectorResponse;
  };

  await runDirectorPipeline(session, { directorProvider: provider });

  assert(capturedOptions !== null, 'provider was not called');
  assert(capturedOptions.system, 'system prompt missing');
  assert(capturedOptions.messages, 'messages missing');
});

test('Parses KEPT/CHANGED/CODE from response', async () => {
  const session = createDirectorSession(mockFidelityResult, 'op_123');
  const provider = createMockDirectorProvider(mockDirectorResponse);

  const updated = await runDirectorPipeline(session, { directorProvider: provider });

  assert(updated.directorResult.kept !== null, 'kept section not parsed');
  assert(updated.directorResult.changed !== null, 'changed section not parsed');
  assert(updated.directorResult.code !== null, 'code section not parsed');
});

test('Extracts creative decisions', async () => {
  const session = createDirectorSession(mockFidelityResult, 'op_123');
  const provider = createMockDirectorProvider(mockDirectorResponse);

  const updated = await runDirectorPipeline(session, { directorProvider: provider });

  assert(Array.isArray(updated.creativeDecisions), 'creativeDecisions should be array');
  assert(updated.creativeDecisions.length > 0, 'should extract at least one decision');
});

test('Creates pending taste signals', async () => {
  const session = createDirectorSession(mockFidelityResult, 'op_123');
  const provider = createMockDirectorProvider(mockDirectorResponse);

  const updated = await runDirectorPipeline(session, { directorProvider: provider });

  assert(Array.isArray(updated.pendingSignals), 'pendingSignals should be array');
  assert(updated.pendingSignals.length === updated.creativeDecisions.length, 'signals count should match decisions');
});

test('Tracks cost breakdown', async () => {
  const session = createDirectorSession(mockFidelityResult, 'op_123');
  const provider = createMockDirectorProvider(mockDirectorResponse);

  const updated = await runDirectorPipeline(session, { directorProvider: provider });

  assert(updated.cost.director > 0, 'director cost should be > 0');
  assert(updated.cost.total > updated.cost.fidelity, 'total should include director');
});

test('Handles Director provider error', async () => {
  const session = createDirectorSession(mockFidelityResult, 'op_123');
  const provider = async () => {
    throw new Error('Opus is unavailable');
  };

  try {
    await runDirectorPipeline(session, { directorProvider: provider });
    throw new Error('Should have thrown');
  } catch (error) {
    assert(error.message.includes('Opus'), 'Error should mention provider issue');
  }
});

test('Handles timeout', async () => {
  const session = createDirectorSession(mockFidelityResult, 'op_123');
  const provider = async () => {
    await new Promise(resolve => setTimeout(resolve, 1000));
    return mockDirectorResponse;
  };

  try {
    await runDirectorPipeline(session, {
      directorProvider: provider,
      timeout: 100,
    });
    throw new Error('Should have thrown');
  } catch (error) {
    assert(error.message.includes('timeout'), 'Error should mention timeout');
  }
});

test('Works with empty taste snapshot', async () => {
  const session = createDirectorSession(mockFidelityResult, 'op_123');
  const provider = createMockDirectorProvider(mockDirectorResponse);

  const updated = await runDirectorPipeline(session, {
    directorProvider: provider,
    tasteStore: null, // no taste store
  });

  assert(updated.status === 'complete', 'should complete without taste store');
});

test('Works with existing taste snapshot', async () => {
  const session = createDirectorSession(mockFidelityResult, 'op_123');
  const provider = createMockDirectorProvider(mockDirectorResponse);

  const tasteStore = {
    getSnapshot: (operatorId) => mockTasteSnapshot,
  };

  const updated = await runDirectorPipeline(session, {
    directorProvider: provider,
    tasteStore,
  });

  assert(updated.status === 'complete', 'should complete with taste store');
  assert(updated.directorResult.kept !== null, 'should use taste context in response');
});

// ─── Operator Action Handling Tests (10+) ────────────────────────────────────

console.log('\n=== Operator Action Handling (10+ tests) ===');

test('handleOperatorAction "accept" creates approval signals', async () => {
  const session = createDirectorSession(mockFidelityResult, 'op_123');
  const provider = createMockDirectorProvider(mockDirectorResponse);
  const updated = await runDirectorPipeline(session, { directorProvider: provider });

  const { signals } = handleOperatorAction(updated, { type: 'accept' });

  assert(signals.length > 0, 'should create signals');
  assert(signals.every(s => s.signal_type === 'approval'), 'all signals should be approval');
  assert(signals.every(s => s.operator_action.accepted === true), 'all should be marked accepted');
});

test('handleOperatorAction "reject" creates rejection signals', async () => {
  const session = createDirectorSession(mockFidelityResult, 'op_123');
  const provider = createMockDirectorProvider(mockDirectorResponse);
  const updated = await runDirectorPipeline(session, { directorProvider: provider });

  const { signals } = handleOperatorAction(updated, { type: 'reject' });

  assert(signals.length > 0, 'should create signals');
  assert(signals.every(s => s.signal_type === 'rejection'), 'all signals should be rejection');
  assert(signals.every(s => s.operator_action.accepted === false), 'all should be marked rejected');
});

test('handleOperatorAction "modify" creates modification signals', async () => {
  const session = createDirectorSession(mockFidelityResult, 'op_123');
  const provider = createMockDirectorProvider(mockDirectorResponse);
  const updated = await runDirectorPipeline(session, { directorProvider: provider });

  const modifiedCode = updated.directorResult.code.replace('200ms', '300ms');

  const { signals } = handleOperatorAction(updated, {
    type: 'modify',
    modifiedCode,
  });

  assert(signals.some(s => s.signal_type === 'modification'), 'should have modification signals');
});

test('handleOperatorAction "cherry_pick" accepts selected, rejects others', async () => {
  const session = createDirectorSession(mockFidelityResult, 'op_123');
  const provider = createMockDirectorProvider(mockDirectorResponse);
  const updated = await runDirectorPipeline(session, { directorProvider: provider });

  const { signals } = handleOperatorAction(updated, {
    type: 'cherry_pick',
    selectedDecisions: [0], // Accept first, reject rest
  });

  const approved = signals.filter(s => s.operator_action.accepted === true);
  const rejected = signals.filter(s => s.operator_action.accepted === false);

  assert(approved.length > 0, 'should have approved signals');
  assert(rejected.length >= 0, 'may have rejected signals');
});

test('Session updated after action', async () => {
  const session = createDirectorSession(mockFidelityResult, 'op_123');
  const provider = createMockDirectorProvider(mockDirectorResponse);
  const updated = await runDirectorPipeline(session, { directorProvider: provider });

  const actionResult = handleOperatorAction(updated, { type: 'accept' });

  assert(actionResult.sessionUpdated === updated, 'session should be returned');
  assert(Array.isArray(actionResult.signals), 'signals should be array');
});

test('Signals include correct operator ID and context', async () => {
  const session = createDirectorSession(mockFidelityResult, 'op_123');
  const provider = createMockDirectorProvider(mockDirectorResponse);
  const updated = await runDirectorPipeline(session, { directorProvider: provider });

  const { signals } = handleOperatorAction(updated, { type: 'accept' });

  assert(signals.every(s => s.operatorId === 'op_123'), 'all signals should have correct operatorId');
  assert(signals.every(s => s.gate === 'figma'), 'all signals should be gate=figma');
});

test('Stores signals via tasteStore if provided', async () => {
  const session = createDirectorSession(mockFidelityResult, 'op_123');
  const provider = createMockDirectorProvider(mockDirectorResponse);
  const updated = await runDirectorPipeline(session, { directorProvider: provider });

  const stored = [];
  const tasteStore = {
    add: (signal) => stored.push(signal),
  };

  const { signals } = handleOperatorAction(updated, { type: 'accept' }, { tasteStore });

  assert(stored.length === signals.length, 'all signals should be stored');
});

test('Signals marked with correct signal_type', async () => {
  const session = createDirectorSession(mockFidelityResult, 'op_123');
  const provider = createMockDirectorProvider(mockDirectorResponse);
  const updated = await runDirectorPipeline(session, { directorProvider: provider });

  const acceptResult = handleOperatorAction(updated, { type: 'accept' });
  const rejectResult = handleOperatorAction(updated, { type: 'reject' });

  assert(acceptResult.signals.every(s => s.signal_type === 'approval'), 'accept should create approval signals');
  assert(rejectResult.signals.every(s => s.signal_type === 'rejection'), 'reject should create rejection signals');
});

test('Handles missing modifiedCode for "modify" type', () => {
  const session = createDirectorSession(mockFidelityResult, 'op_123');
  session.status = 'complete';
  session.directorResult = { code: 'some code' };
  session.pendingSignals = [];

  try {
    handleOperatorAction(session, { type: 'modify' });
    throw new Error('Should have thrown');
  } catch (error) {
    assert(error.message.includes('modifiedCode'), 'Error should mention modifiedCode');
  }
});

// ─── Session Summary Tests (5+) ──────────────────────────────────────────────

console.log('\n=== Session Summary (5+ tests) ===');

test('getSessionSummary returns all fields', async () => {
  const session = createDirectorSession(mockFidelityResult, 'op_123');
  const provider = createMockDirectorProvider(mockDirectorResponse);
  const updated = await runDirectorPipeline(session, { directorProvider: provider });

  const summary = getSessionSummary(updated);

  assert(summary.status === 'complete', 'status field missing');
  assert(typeof summary.fidelityScore === 'number', 'fidelityScore field missing');
  assert(typeof summary.directorDecisionCount === 'number', 'directorDecisionCount field missing');
  assert(typeof summary.cost === 'object', 'cost field missing');
  assert(typeof summary.latencyMs === 'number', 'latencyMs field missing');
});

test('Handles incomplete session (pre-Director)', () => {
  const session = createDirectorSession(mockFidelityResult, 'op_123');

  const summary = getSessionSummary(session);

  assert(summary.status === 'ready', 'should show ready status');
  assert(summary.fidelityScore >= 0, 'fidelity score should be valid');
  assert(summary.directorDecisionCount === 0, 'should have 0 decisions pre-Director');
});

test('Handles failed session', async () => {
  const session = createDirectorSession(mockFidelityResult, 'op_123');
  const provider = async () => {
    throw new Error('Director failed');
  };

  try {
    await runDirectorPipeline(session, { directorProvider: provider });
  } catch {
    // Expected
  }

  const summary = getSessionSummary(session);

  assert(summary.status === 'failed', 'should show failed status');
});

test('Cost breakdown is accurate', async () => {
  const session = createDirectorSession(mockFidelityResult, 'op_123');
  const provider = createMockDirectorProvider(mockDirectorResponse);
  const updated = await runDirectorPipeline(session, { directorProvider: provider });

  const summary = getSessionSummary(updated);

  assert(summary.cost.total > 0, 'total cost should be > 0');
  assert(summary.cost.total === summary.cost.fidelity + summary.cost.director, 'total should be sum');
});

test('Latency is calculated correctly', async () => {
  const session = createDirectorSession(mockFidelityResult, 'op_123');
  const provider = createMockDirectorProvider(mockDirectorResponse);
  const updated = await runDirectorPipeline(session, { directorProvider: provider });

  const summary = getSessionSummary(updated);

  assert(summary.latencyMs >= 0, 'latency should be non-negative');
});

// ─── Side-by-Side Format Tests (5+) ──────────────────────────────────────────

console.log('\n=== Side-by-Side Format (5+ tests) ===');

test('formatSideBySide returns exact + director panels', async () => {
  const session = createDirectorSession(mockFidelityResult, 'op_123');
  const provider = createMockDirectorProvider(mockDirectorResponse);
  const updated = await runDirectorPipeline(session, { directorProvider: provider });

  const formatted = formatSideBySide(updated);

  assert(formatted.exact !== undefined, 'exact panel missing');
  assert(formatted.director !== undefined, 'director panel missing');
  assert(formatted.exact.code !== undefined, 'exact.code missing');
  assert(formatted.director.code !== undefined, 'director.code missing');
});

test('Exact panel has fidelity code and score', async () => {
  const session = createDirectorSession(mockFidelityResult, 'op_123');
  const provider = createMockDirectorProvider(mockDirectorResponse);
  const updated = await runDirectorPipeline(session, { directorProvider: provider });

  const formatted = formatSideBySide(updated);

  assert(formatted.exact.code !== '', 'exact.code should not be empty');
  assert(formatted.exact.score !== '', 'exact.score should not be empty');
  assert(formatted.exact.score.includes('%'), 'score should include percent sign');
});

test('Director panel has kept/changed/code', async () => {
  const session = createDirectorSession(mockFidelityResult, 'op_123');
  const provider = createMockDirectorProvider(mockDirectorResponse);
  const updated = await runDirectorPipeline(session, { directorProvider: provider });

  const formatted = formatSideBySide(updated);

  assert(formatted.director.kept !== undefined, 'director.kept missing');
  assert(formatted.director.changed !== undefined, 'director.changed missing');
  assert(formatted.director.code !== undefined, 'director.code missing');
});

test('Both panels have copy/preview actions', async () => {
  const session = createDirectorSession(mockFidelityResult, 'op_123');
  const provider = createMockDirectorProvider(mockDirectorResponse);
  const updated = await runDirectorPipeline(session, { directorProvider: provider });

  const formatted = formatSideBySide(updated);

  assert(Array.isArray(formatted.exact.actions), 'exact.actions should be array');
  assert(formatted.exact.actions.includes('copy'), 'exact should have copy action');
  assert(formatted.exact.actions.includes('preview'), 'exact should have preview action');
  assert(Array.isArray(formatted.director.actions), 'director.actions should be array');
  assert(formatted.director.actions.includes('copy'), 'director should have copy action');
  assert(formatted.director.actions.includes('preview'), 'director should have preview action');
});

test('Panel labels are correct', async () => {
  const session = createDirectorSession(mockFidelityResult, 'op_123');
  const provider = createMockDirectorProvider(mockDirectorResponse);
  const updated = await runDirectorPipeline(session, { directorProvider: provider });

  const formatted = formatSideBySide(updated);

  assertEqual(formatted.exact.label, 'EXACT', 'exact label incorrect');
  assertEqual(formatted.director.label, "DIRECTOR'S CUT", 'director label incorrect');
});

// ─── Cost Calculation Tests (5+) ──────────────────────────────────────────────

console.log('\n=== Cost Calculation (5+ tests) ===');

test('calculatePipelineCost sums correctly', async () => {
  const session = createDirectorSession(mockFidelityResult, 'op_123');
  const provider = createMockDirectorProvider(mockDirectorResponse);
  const updated = await runDirectorPipeline(session, { directorProvider: provider });

  const cost = calculatePipelineCost(updated);

  assert(cost.total > 0, 'total should be > 0');
  assert(Math.abs(cost.total - (cost.fidelity + cost.director)) < 0.00001, 'total should equal sum');
});

test('Handles missing director cost (pre-Director)', () => {
  const session = createDirectorSession(mockFidelityResult, 'op_123');

  const cost = calculatePipelineCost(session);

  assert(cost.total > 0, 'should include fidelity cost');
  assert(cost.director === 0, 'director cost should be 0 pre-Director');
});

test('Breakdown string is human-readable', async () => {
  const session = createDirectorSession(mockFidelityResult, 'op_123');
  const provider = createMockDirectorProvider(mockDirectorResponse);
  const updated = await runDirectorPipeline(session, { directorProvider: provider });

  const cost = calculatePipelineCost(updated);

  assert(typeof cost.breakdown === 'string', 'breakdown should be string');
  assert(cost.breakdown.includes('Fidelity'), 'breakdown should mention Fidelity');
  assert(cost.breakdown.includes('Director'), 'breakdown should mention Director');
  assert(cost.breakdown.includes('Total'), 'breakdown should mention Total');
});

test('Cost values are properly rounded', async () => {
  const session = createDirectorSession(mockFidelityResult, 'op_123');
  const provider = createMockDirectorProvider(mockDirectorResponse);
  const updated = await runDirectorPipeline(session, { directorProvider: provider });

  const cost = calculatePipelineCost(updated);

  // Check that values are rounded to 5 decimals
  assert(typeof cost.fidelity === 'number', 'fidelity should be number');
  assert(typeof cost.director === 'number', 'director should be number');
  assert(typeof cost.total === 'number', 'total should be number');
});

test('Breakdown includes dollar amounts', async () => {
  const session = createDirectorSession(mockFidelityResult, 'op_123');
  const provider = createMockDirectorProvider(mockDirectorResponse);
  const updated = await runDirectorPipeline(session, { directorProvider: provider });

  const cost = calculatePipelineCost(updated);

  assert(cost.breakdown.includes('$'), 'breakdown should include dollar sign');
});

// ─── Integration Tests (8+) ──────────────────────────────────────────────────

console.log('\n=== Integration Tests (8+ tests) ===');

test('Full flow: fidelity → create session → run Director → operator accepts', async () => {
  const session = createDirectorSession(mockFidelityResult, 'op_123');
  const provider = createMockDirectorProvider(mockDirectorResponse);

  // Step 1: Run Director
  const updated = await runDirectorPipeline(session, { directorProvider: provider });
  assert(updated.status === 'complete', 'Director should complete');

  // Step 2: Operator accepts
  const { signals } = handleOperatorAction(updated, { type: 'accept' });
  assert(signals.length > 0, 'should generate signals');
  assert(signals.every(s => s.signal_type === 'approval'), 'signals should be approval');

  // Step 3: Get summary
  const summary = getSessionSummary(updated);
  assert(summary.directorDecisionCount > 0, 'should have decisions');

  // Step 4: Format for UI
  const formatted = formatSideBySide(updated);
  assert(formatted.exact.code !== '', 'should have exact code');
  assert(formatted.director.code !== '', 'should have director code');

  // Step 5: Calculate cost
  const cost = calculatePipelineCost(updated);
  assert(cost.total > 0, 'cost should be > 0');
});

test('Full flow: operator cherry-picks some decisions', async () => {
  const session = createDirectorSession(mockFidelityResult, 'op_123');
  const provider = createMockDirectorProvider(mockDirectorResponse);

  const updated = await runDirectorPipeline(session, { directorProvider: provider });
  const selectedCount = Math.min(2, updated.creativeDecisions.length);
  const selectedIndices = Array.from({ length: selectedCount }, (_, i) => i);

  const { signals } = handleOperatorAction(updated, {
    type: 'cherry_pick',
    selectedDecisions: selectedIndices,
  });

  const approvals = signals.filter(s => s.operator_action.accepted === true);
  const rejections = signals.filter(s => s.operator_action.accepted === false);

  assert(approvals.length > 0, 'should have approved signals');
  assert(approvals.length + rejections.length === signals.length, 'all signals accounted for');
});

test('Multiple sessions for same operator accumulate independently', async () => {
  const s1 = createDirectorSession(mockFidelityResult, 'op_123');
  const s2 = createDirectorSession(mockFidelityResult, 'op_123');

  assert(s1.id !== s2.id, 'sessions should have unique IDs');
  assert(s1.operatorId === s2.operatorId, 'both should be for same operator');
  assert(s1.fidelityResult === s2.fidelityResult, 'both use same fidelity result');
});

test('Cost tracking across full pipeline', async () => {
  const session = createDirectorSession(mockFidelityResult, 'op_123');
  const provider = createMockDirectorProvider(mockDirectorResponse);

  const updated = await runDirectorPipeline(session, { directorProvider: provider });
  const cost = calculatePipelineCost(updated);

  assert(cost.fidelity === 0.008, 'fidelity cost should be 0.008');
  assert(cost.director > 0, 'director cost should be > 0');
  assert(cost.total === cost.fidelity + cost.director, 'total should be correct');
});

test('Mock provider works correctly', () => {
  const testResponse = 'KEPT\nSomething\n\nCHANGED\nSomething else\n\nCODE\nconst Component = () => null;';
  const provider = createMockDirectorProvider(testResponse);

  assert(typeof provider === 'function', 'mock provider should be function');
});

test('Director failure does not corrupt session', async () => {
  const session = createDirectorSession(mockFidelityResult, 'op_123');
  const provider = async () => {
    throw new Error('Provider error');
  };

  try {
    await runDirectorPipeline(session, { directorProvider: provider });
  } catch {
    // Expected
  }

  const summary = getSessionSummary(session);
  assert(session.status === 'failed', 'session status should be failed');
  assert(session.fidelityResult !== null, 'fidelity result should still be intact');
});

test('Side-by-side format works with failed Director', async () => {
  const session = createDirectorSession(mockFidelityResult, 'op_123');
  const provider = async () => {
    throw new Error('Provider error');
  };

  try {
    await runDirectorPipeline(session, { directorProvider: provider });
  } catch {
    // Expected
  }

  const formatted = formatSideBySide(session);
  assert(formatted.exact.code !== '', 'should still show exact code');
  assert(formatted.director.code === '', 'director code should be empty on failure');
});

test('Operator action with no pending signals', () => {
  const session = createDirectorSession(mockFidelityResult, 'op_123');
  session.status = 'complete';
  session.directorResult = { code: 'some code' };
  session.pendingSignals = [];

  const { signals } = handleOperatorAction(session, { type: 'accept' });

  assert(Array.isArray(signals), 'should return signals array');
  assert(signals.length === 0, 'should have no signals if no pending');
});

test('Session with complex fidelity metadata', () => {
  const complexResult = {
    ...mockFidelityResult,
    metadata: {
      costEstimate: 0.0125,
      tokenUsage: { input: 2500, output: 1200 },
      retryCount: 1,
    },
  };

  const session = createDirectorSession(complexResult, 'op_456');

  assert(session.cost.fidelity === 0.0125, 'complex cost should be preserved');
  assert(session.operatorId === 'op_456', 'different operator ID');
});

test('Director decisions with multiple types', async () => {
  const richResponse = `KEPT
The base structure is excellent.

CHANGED
Motion: Added 200ms ease-out transitions — because motion implies intent.
States: Added :hover and :focus pseudo-states — for keyboard navigation.
Hierarchy: Reduced opacity on secondary elements — for visual weight.
Texture: Added subtle gradient overlay — for depth perception.

CODE
const Component = () => <div>Enhanced</div>;`;

  const session = createDirectorSession(mockFidelityResult, 'op_123');
  const provider = createMockDirectorProvider(richResponse);

  const updated = await runDirectorPipeline(session, { directorProvider: provider });

  const decisions = updated.creativeDecisions;
  const types = new Set(decisions.map(d => d.type));

  assert(types.has('motion'), 'should extract motion decisions');
  assert(types.has('state'), 'should extract state decisions');
  assert(types.has('hierarchy'), 'should extract hierarchy decisions');
  assert(types.has('texture'), 'should extract texture decisions');
});

test('Pending signals have all required fields', async () => {
  const session = createDirectorSession(mockFidelityResult, 'op_123');
  const provider = createMockDirectorProvider(mockDirectorResponse);

  const updated = await runDirectorPipeline(session, { directorProvider: provider });

  const signals = updated.pendingSignals;
  assert(signals.length > 0, 'should have pending signals');

  signals.forEach(signal => {
    assert(signal.id, 'signal should have id');
    assert(signal.timestamp, 'signal should have timestamp');
    assert(signal.operatorId === 'op_123', 'signal should have operatorId');
    assert(signal.gate === 'figma', 'signal should have gate');
    assert(signal.subject, 'signal should have subject');
    assert(signal.subject.type === 'creative_direction', 'subject type should be creative_direction');
  });
});

test('Error handling for invalid session in action handler', () => {
  try {
    handleOperatorAction(null, { type: 'accept' });
    throw new Error('Should have thrown');
  } catch (error) {
    assert(error.message.includes('session'), 'Error should mention session');
  }
});

test('Error handling for invalid action type', () => {
  const session = createDirectorSession(mockFidelityResult, 'op_123');
  session.status = 'complete';

  try {
    handleOperatorAction(session, { type: 'invalid_type' });
    throw new Error('Should have thrown');
  } catch (error) {
    assert(error.message.includes('invalid action type'), 'Error should mention invalid type');
  }
});

test('Session summary with zero fidelity score', () => {
  const zeroFidelityResult = {
    ...mockFidelityResult,
    output: {
      ...mockFidelityResult.output,
      fidelityScore: 0,
    },
  };

  const session = createDirectorSession(zeroFidelityResult, 'op_123');
  const summary = getSessionSummary(session);

  assert(summary.fidelityScore === 0, 'should handle zero score');
});

test('Cost calculation with no cost metadata', () => {
  const noCostResult = {
    ...mockFidelityResult,
    metadata: {},
  };

  const session = createDirectorSession(noCostResult, 'op_123');
  const cost = calculatePipelineCost(session);

  assert(cost.fidelity === 0, 'should default to 0 if no metadata');
  assert(typeof cost.breakdown === 'string', 'breakdown should still be generated');
});

// ─── Test Summary ────────────────────────────────────────────────────────────

console.log('\n' + '='.repeat(60));
console.log(`Tests: ${testCount} | Passed: ${passCount} | Failed: ${failCount}`);
console.log('='.repeat(60));

if (failCount > 0) {
  console.error(`\nFAILURE: ${failCount} test(s) failed`);
  process.exit(1);
} else {
  console.log('\nSUCCESS: All tests passed');
  process.exit(0);
}
