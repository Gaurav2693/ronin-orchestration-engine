// ─── intelligence/topologyLearner.test.mjs ──────────────────────────────────
// RONIN Output Topology Learning (V4) — comprehensive test suite
//
// Tests cover: topology definitions, detection, selection, learning, rejection
// Target: 45+ tests, 0 failures
// ─────────────────────────────────────────────────────────────────────────────

import {
  TOPOLOGIES,
  createTopologyPreference,
  detectTopology,
  selectTopology,
  recordAcceptance,
  getTopologyPromptFragment,
  detectRejection,
} from './topologyLearner.mjs';

// ─── Helper for test output ──────────────────────────────────────────────────

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
  assert(actual === expected, `${message} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}

function assertDeepEqual(actual, expected, message) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${message} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`
  );
}

function assertInRange(actual, min, max, message) {
  assert(actual >= min && actual <= max, `${message} (got ${actual}, expected ${min}-${max})`);
}

function describe(label) {
  console.log(`\n${label}`);
}

// ─── Test Suites ────────────────────────────────────────────────────────────

describe('## TOPOLOGY DEFINITIONS');

// Test: All 4 topologies defined
(() => {
  const topologyIds = Object.keys(TOPOLOGIES);
  assertEqual(topologyIds.length, 4, 'Should have exactly 4 topologies');
  assert(topologyIds.includes('directTactical'), 'Should have directTactical');
  assert(topologyIds.includes('systemsView'), 'Should have systemsView');
  assert(topologyIds.includes('creativeExploration'), 'Should have creativeExploration');
  assert(topologyIds.includes('reflective'), 'Should have reflective');
})();

// Test: Each topology has required fields
(() => {
  for (const [id, topology] of Object.entries(TOPOLOGIES)) {
    assert(topology.id === id, `${id} topology.id should match key`);
    assert(typeof topology.name === 'string', `${id} should have name`);
    assert(typeof topology.structure === 'string', `${id} should have structure`);
    assert(Array.isArray(topology.bestFor), `${id} should have bestFor array`);
    assert(Array.isArray(topology.markers), `${id} should have markers array`);
    assert(typeof topology.systemPrompt === 'string', `${id} should have systemPrompt`);
  }
})();

// Test: directTactical topology shape
(() => {
  const t = TOPOLOGIES.directTactical;
  assertEqual(t.structure, 'diagnosis → options → recommendation → next action', 'directTactical structure');
  assert(t.markers.some(m => m.includes('diagnosis') || m.includes('direct')), 'has direct opening marker');
  assert(t.markers.some(m => m.includes('action') || m.includes('next')), 'has action closing marker');
})();

// Test: systemsView topology shape
(() => {
  const t = TOPOLOGIES.systemsView;
  assertEqual(t.structure, 'framing → architecture → tradeoffs → risks → recommendation', 'systemsView structure');
  assert(t.markers.some(m => m.includes('framing')), 'has framing marker');
  assert(t.markers.some(m => m.includes('tradeoff')), 'has tradeoffs marker');
  assert(t.markers.some(m => m.includes('risk')), 'has risks marker');
})();

// Test: creativeExploration topology shape
(() => {
  const t = TOPOLOGIES.creativeExploration;
  assertEqual(t.structure, 'interpretation → approaches → creative extension → feasibility', 'creativeExploration structure');
  assert(t.markers.some(m => m.includes('interpretation') || m.includes('interpret')), 'has interpretation marker');
  assert(t.markers.some(m => m.includes('approach')), 'has approaches marker');
  assert(t.markers.some(m => m.includes('feasib')), 'has feasibility marker');
})();

// Test: reflective topology shape
(() => {
  const t = TOPOLOGIES.reflective;
  assertEqual(t.structure, 'pattern recognition → meaning → implication → next move', 'reflective structure');
  assert(t.markers.some(m => m.includes('pattern')), 'has pattern marker');
  assert(t.markers.some(m => m.includes('meaning') || m.includes('significance')), 'has meaning marker');
  assert(t.markers.some(m => m.includes('implication')), 'has implication marker');
})();

describe('## TOPOLOGY PREFERENCE INITIALIZATION');

// Test: createTopologyPreference returns correct defaults
(() => {
  const pref = createTopologyPreference();
  assert(typeof pref.topologyScores === 'object', 'should have topologyScores object');
  assertEqual(pref.topologyScores.directTactical, 0.5, 'directTactical starts at 0.5');
  assertEqual(pref.topologyScores.systemsView, 0.5, 'systemsView starts at 0.5');
  assertEqual(pref.topologyScores.creativeExploration, 0.5, 'creativeExploration starts at 0.5');
  assertEqual(pref.topologyScores.reflective, 0.5, 'reflective starts at 0.5');
  assertEqual(pref.acceptCount, 0, 'acceptCount starts at 0');
  assertEqual(pref.rejectCount, 0, 'rejectCount starts at 0');
  assertEqual(pref.lastTopology, null, 'lastTopology starts as null');
  assert(Array.isArray(pref.history), 'history should be an array');
  assertEqual(pref.history.length, 0, 'history starts empty');
})();

describe('## TOPOLOGY DETECTION');

// Test: detectTopology with directTactical response
(() => {
  const response = `Here's the issue: your cache is stale.

Fix it by clearing Redis:
\`\`\`bash
redis-cli FLUSHALL
\`\`\`

Next: restart your app server.`;

  const result = detectTopology(response);
  assertEqual(result.topology, 'directTactical', 'should detect directTactical');
  assertInRange(result.confidence, 0.5, 1.0, 'should have confidence >= 0.5');
  assert(Array.isArray(result.markers), 'should return markers array');
  assert(result.markers.length > 0, 'should detect at least one marker');
})();

// Test: detectTopology with systemsView response
(() => {
  const response = `Context: You're trying to scale your API to handle 10x traffic.

**Architecture Options:**
1. Horizontal scaling with load balancer
2. Vertical scaling (bigger server)
3. Caching layer + microservices

**Tradeoffs:**
- Option 1: higher complexity but scales well
- Option 2: simpler but hits limits
- Option 3: best scaling but most operational overhead

**Risks to consider:**
- Data consistency in distributed system
- Network latency between services
- Cost of additional infrastructure

**Recommendation:** Use option 3 for long-term resilience.`;

  const result = detectTopology(response);
  assertEqual(result.topology, 'systemsView', 'should detect systemsView');
  assertInRange(result.confidence, 0.5, 1.0, 'should have confidence >= 0.5');
  assert(result.markers.some(m => m.includes('tradeoff') || m.includes('framing')), 'should detect systems markers');
})();

// Test: detectTopology with creativeExploration response
(() => {
  const response = `What if we reframe this? Instead of a database, what if we think of it as a knowledge graph?

**Approaches:**
1. Traditional relational approach (what we've been doing)
2. Graph database (Neo4j, etc.)
3. Document store with embedded relationships
4. Hybrid: relational + search index

The creative extension: what if we combined #2 and #3? You'd get the query flexibility of graphs plus the unstructured richness of documents.

In practice, this would work with something like PostgreSQL + Elasticsearch, or MongoDB + Neo4j. The feasibility depends on your query patterns.`;

  const result = detectTopology(response);
  assertEqual(result.topology, 'creativeExploration', 'should detect creativeExploration');
  assertInRange(result.confidence, 0.3, 1.0, 'should have some confidence');
  assert(result.markers.some(m => m.includes('creative') || m.includes('approach')), 'should detect creative markers');
})();

// Test: detectTopology with reflective response
(() => {
  const response = `The pattern here is that you're conflating two different kinds of complexity: accidental complexity (from our tech choices) and essential complexity (from the problem domain itself).

What this reveals: You've been optimizing for the wrong thing. You've been trying to reduce accidental complexity when you should have been investing in understanding the essential complexity better.

The implication: Instead of rewriting the system, you need a theory of how your domain works. That theory becomes the architecture. You've had it backwards.

Next level: What if you spent a week documenting the domain model first, before touching code?`;

  const result = detectTopology(response);
  assertEqual(result.topology, 'reflective', 'should detect reflective');
  assertInRange(result.confidence, 0.3, 1.0, 'should have some confidence');
  assert(result.markers.some(m => m.includes('pattern') || m.includes('meaning')), 'should detect reflective markers');
})();

// Test: detectTopology with empty response
(() => {
  const result = detectTopology('');
  assertEqual(result.topology, null, 'empty response should return null topology');
  assertEqual(result.confidence, 0.0, 'empty response should have 0 confidence');
})();

// Test: detectTopology with null/undefined
(() => {
  const result1 = detectTopology(null);
  const result2 = detectTopology(undefined);
  assertEqual(result1.topology, null, 'null input should return null');
  assertEqual(result2.topology, null, 'undefined input should return null');
})();

// Test: detectTopology with ambiguous response defaults
(() => {
  const result = detectTopology('This is a generic response with no clear markers.');
  assertEqual(result.topology, 'directTactical', 'ambiguous response defaults to directTactical');
  assert(result.confidence < 0.5, 'ambiguous response should have low confidence');
})();

describe('## TOPOLOGY SELECTION');

// Test: selectTopology mode-to-topology defaults
(() => {
  const pref = createTopologyPreference();
  const profile = {};

  const tactical = selectTopology('tactical', profile, pref);
  assertEqual(tactical.topology, 'directTactical', 'tactical mode → directTactical');

  const architect = selectTopology('architect', profile, pref);
  assertEqual(architect.topology, 'systemsView', 'architect mode → systemsView');

  const explorer = selectTopology('explorer', profile, pref);
  assertEqual(explorer.topology, 'creativeExploration', 'explorer mode → creativeExploration');

  const reflective = selectTopology('reflective', profile, pref);
  assertEqual(reflective.topology, 'reflective', 'reflective mode → reflective');
})();

// Test: selectTopology all mode mappings
(() => {
  const pref = createTopologyPreference();
  const profile = {};

  const modeTests = [
    ['debug', 'directTactical'],
    ['builder', 'directTactical'],
    ['strategy', 'systemsView'],
    ['critic', 'systemsView'],
  ];

  for (const [mode, expectedTopology] of modeTests) {
    const result = selectTopology(mode, profile, pref);
    assertEqual(result.topology, expectedTopology, `${mode} mode mapping`);
  }
})();

// Test: selectTopology returns reason
(() => {
  const pref = createTopologyPreference();
  const profile = {};
  const result = selectTopology('tactical', profile, pref);
  assert(typeof result.reason === 'string', 'should return reason string');
  assert(result.reason.length > 0, 'reason should not be empty');
})();

// Test: selectTopology overrides with strong operator preference
(() => {
  const pref = createTopologyPreference();
  pref.topologyScores.reflective = 0.85;  // strong preference
  const profile = {};

  const result = selectTopology('tactical', profile, pref);
  assertEqual(result.topology, 'reflective', 'strong preference (0.85) overrides tactical mode');
  assert(result.reason.includes('operator preference'), 'reason should mention operator preference');
})();

// Test: selectTopology respects weak preference (doesn't override)
(() => {
  const pref = createTopologyPreference();
  pref.topologyScores.reflective = 0.65;  // weak preference (< 0.7)
  const profile = {};

  const result = selectTopology('tactical', profile, pref);
  assertEqual(result.topology, 'directTactical', 'weak preference (0.65) does not override mode');
})();

// Test: selectTopology with unknown mode defaults
(() => {
  const pref = createTopologyPreference();
  const profile = {};
  const result = selectTopology('unknown-mode', profile, pref);
  assertEqual(result.topology, 'directTactical', 'unknown mode defaults to directTactical');
})();

describe('## ACCEPTANCE RECORDING & LEARNING');

// Test: recordAcceptance updates acceptCount
(() => {
  const pref = createTopologyPreference();
  const updated = recordAcceptance(pref, 'directTactical', true);
  assertEqual(updated.acceptCount, 1, 'acceptCount should increment');
  assertEqual(updated.rejectCount, 0, 'rejectCount should stay 0');
})();

// Test: recordAcceptance updates rejectCount
(() => {
  const pref = createTopologyPreference();
  const updated = recordAcceptance(pref, 'directTactical', false);
  assertEqual(updated.acceptCount, 0, 'acceptCount should stay 0');
  assertEqual(updated.rejectCount, 1, 'rejectCount should increment');
})();

// Test: recordAcceptance moves score toward 1.0 on acceptance
(() => {
  const pref = createTopologyPreference();
  const before = pref.topologyScores.directTactical;  // 0.5

  const updated = recordAcceptance(pref, 'directTactical', true);
  const after = updated.topologyScores.directTactical;

  assert(after > before, 'score should increase on acceptance');
  assert(after < 1.0, 'score should not overshoot to 1.0 immediately');
})();

// Test: recordAcceptance moves score toward 0.0 on rejection
(() => {
  const pref = createTopologyPreference();
  const before = pref.topologyScores.directTactical;  // 0.5

  const updated = recordAcceptance(pref, 'directTactical', false);
  const after = updated.topologyScores.directTactical;

  assert(after < before, 'score should decrease on rejection');
  assert(after > 0.0, 'score should not undershoot to 0.0 immediately');
})();

// Test: recordAcceptance uses EMA learning rate (0.1)
(() => {
  const pref = createTopologyPreference();
  pref.topologyScores.directTactical = 0.5;

  const updated = recordAcceptance(pref, 'directTactical', true);
  const newScore = updated.topologyScores.directTactical;

  // EMA formula: new = old + 0.1 * (target - old)
  // new = 0.5 + 0.1 * (1.0 - 0.5) = 0.5 + 0.05 = 0.55
  assertEqual(newScore, 0.55, 'should use EMA with rate 0.1');
})();

// Test: recordAcceptance clamps scores to [0.0, 1.0]
(() => {
  const pref = createTopologyPreference();
  pref.topologyScores.directTactical = 0.99;

  const updated = recordAcceptance(pref, 'directTactical', true);
  assert(updated.topologyScores.directTactical <= 1.0, 'score should not exceed 1.0');

  const pref2 = createTopologyPreference();
  pref2.topologyScores.directTactical = 0.01;
  const updated2 = recordAcceptance(pref2, 'directTactical', false);
  assert(updated2.topologyScores.directTactical >= 0.0, 'score should not go below 0.0');
})();

// Test: recordAcceptance updates lastTopology
(() => {
  const pref = createTopologyPreference();
  const updated = recordAcceptance(pref, 'systemsView', true);
  assertEqual(updated.lastTopology, 'systemsView', 'lastTopology should be updated');
})();

// Test: recordAcceptance maintains history
(() => {
  const pref = createTopologyPreference();
  let updated = pref;
  for (let i = 0; i < 5; i++) {
    updated = recordAcceptance(updated, 'directTactical', true);
  }
  assertEqual(updated.history.length, 5, 'should maintain 5 history entries');
})();

// Test: recordAcceptance history has correct fields
(() => {
  const pref = createTopologyPreference();
  const updated = recordAcceptance(pref, 'directTactical', true);
  const entry = updated.history[0];
  assertEqual(entry.topology, 'directTactical', 'history entry should have topology');
  assertEqual(entry.accepted, true, 'history entry should have accepted flag');
  assert(typeof entry.timestamp === 'string', 'history entry should have timestamp');
})();

// Test: recordAcceptance caps history at 20 entries
(() => {
  const pref = createTopologyPreference();
  let updated = pref;
  for (let i = 0; i < 25; i++) {
    updated = recordAcceptance(updated, 'directTactical', i % 2 === 0);
  }
  assertEqual(updated.history.length, 20, 'history should cap at 20 entries');
})();

// Test: recordAcceptance keeps last 20 entries (not first 20)
(() => {
  const pref = createTopologyPreference();
  let updated = pref;
  for (let i = 0; i < 25; i++) {
    updated = recordAcceptance(updated, `topology${i}`, true);
  }
  // The oldest entry should be entry 5 (0-indexed: items 0-4 are gone)
  assertEqual(updated.history[0].topology, 'topology5', 'should keep last 20, not first 20');
  assertEqual(updated.history[19].topology, 'topology24', 'should include most recent');
})();

// Test: Operator learns preference over multiple interactions
(() => {
  const pref = createTopologyPreference();
  let updated = pref;

  // Operator repeatedly accepts directTactical
  for (let i = 0; i < 10; i++) {
    updated = recordAcceptance(updated, 'directTactical', true);
  }

  assert(updated.topologyScores.directTactical > 0.7, 'score should rise above 0.7 after 10 acceptances');
  assert(updated.acceptCount === 10, 'should track 10 acceptances');
})();

describe('## TOPOLOGY PROMPT FRAGMENTS');

// Test: getTopologyPromptFragment returns non-empty string for all topologies
(() => {
  for (const topologyId of Object.keys(TOPOLOGIES)) {
    const fragment = getTopologyPromptFragment(topologyId);
    assert(typeof fragment === 'string', `${topologyId} should return string`);
    assert(fragment.length > 0, `${topologyId} fragment should not be empty`);
    assert(fragment.includes('STRUCTURE') || fragment.includes('structure'), `${topologyId} fragment should mention structure`);
  }
})();

// Test: getTopologyPromptFragment returns null for unknown topology
(() => {
  const fragment = getTopologyPromptFragment('unknown');
  assertEqual(fragment, '', 'unknown topology should return empty string');
})();

// Test: getTopologyPromptFragment directTactical mentions structure
(() => {
  const fragment = getTopologyPromptFragment('directTactical');
  assert(fragment.includes('Direct Tactical'), 'should include topology name');
  assert(fragment.includes('diagnosis') || fragment.includes('Diagnosis'), 'should reference diagnosis');
})();

// Test: getTopologyPromptFragment systemsView mentions tradeoffs
(() => {
  const fragment = getTopologyPromptFragment('systemsView');
  assert(fragment.includes('Systems View'), 'should include topology name');
  assert(fragment.includes('tradeoff') || fragment.includes('Tradeoff'), 'should mention tradeoffs');
})();

describe('## REJECTION DETECTION');

// Test: detectRejection identifies "too long" signal
(() => {
  const result = detectRejection('That was too long.');
  assertEqual(result.rejected, true, 'should detect rejection');
  assert(result.signals.includes('too long'), 'should find "too long" signal');
  assertEqual(result.preferredDirection, 'more-direct', 'should suggest more-direct');
})();

// Test: detectRejection identifies "more detail" signal
(() => {
  const result = detectRejection('Can you expand on that?');
  assertEqual(result.rejected, true, 'should detect rejection');
  assert(result.signals.some(s => s.includes('expand') || s.includes('detail')), 'should find expansion signal');
  assertEqual(result.preferredDirection, 'more-expansive', 'should suggest more-expansive');
})();

// Test: detectRejection identifies "more structured" signal
(() => {
  const result = detectRejection('Break it down into steps.');
  assertEqual(result.rejected, true, 'should detect rejection');
  assert(result.signals.some(s => s.includes('break') || s.includes('structured')), 'should find structure signal');
  assertEqual(result.preferredDirection, 'more-structured', 'should suggest more-structured');
})();

// Test: detectRejection identifies creative direction
(() => {
  const result = detectRejection('Can you approach this differently?');
  assertEqual(result.rejected, true, 'should detect rejection');
  assert(result.signals.some(s => s.includes('different')), 'should find different signal');
  assertEqual(result.preferredDirection, 'more-creative', 'should suggest more-creative');
})();

// Test: detectRejection returns false for normal messages
(() => {
  const result = detectRejection('That makes sense. Let me try this approach.');
  assertEqual(result.rejected, false, 'normal message should not be rejection');
  assertEqual(result.signals.length, 0, 'should have no signals');
  assertEqual(result.preferredDirection, null, 'should have no preferred direction');
})();

// Test: detectRejection handles multiple signals
(() => {
  const result = detectRejection('That was too long and too abstract. Can you simplify?');
  assertEqual(result.rejected, true, 'should detect rejection');
  assert(result.signals.length >= 2, 'should detect multiple signals');
})();

// Test: detectRejection with null/undefined
(() => {
  const result1 = detectRejection(null);
  const result2 = detectRejection(undefined);
  assertEqual(result1.rejected, false, 'null input should not be rejection');
  assertEqual(result2.rejected, false, 'undefined input should not be rejection');
})();

// Test: detectRejection case-insensitive
(() => {
  const result1 = detectRejection('TOO LONG');
  const result2 = detectRejection('Too Long');
  assert(result1.rejected, 'uppercase should detect');
  assert(result2.rejected, 'mixed case should detect');
})();

// Test: detectRejection identifies "ELI5" signal
(() => {
  const result = detectRejection('ELI5: how does this work?');
  assertEqual(result.rejected, true, 'should detect ELI5');
  assert(result.signals.some(s => s.includes('eli5') || s.includes('explain it like')), 'should find ELI5 signal');
})();

describe('## END-TO-END SCENARIO');

// Test: Full learning scenario — operator learns preference for directTactical
(() => {
  let pref = createTopologyPreference();
  let mode = 'tactical';

  // Initial selection
  let selection = selectTopology(mode, {}, pref);
  assertEqual(selection.topology, 'directTactical', 'should select directTactical for tactical mode');

  // Operator accepts 8 times
  for (let i = 0; i < 8; i++) {
    pref = recordAcceptance(pref, 'directTactical', true);
  }

  assert(pref.topologyScores.directTactical > 0.7, 'preference should rise above 0.7');

  // Now even in architect mode, should prefer directTactical
  selection = selectTopology('architect', {}, pref);
  assertEqual(selection.topology, 'directTactical', 'strong operator preference overrides mode');
  assert(selection.reason.includes('operator preference'), 'reason should explain override');
})();

// Test: Full rejection → learning → correction scenario
(() => {
  let pref = createTopologyPreference();

  // Initial systemsView response
  let detection = detectTopology(`Context: You're trying to scale.

**Architecture Options:**
1. Option A
2. Option B

**Tradeoffs:** ...`);
  assertEqual(detection.topology, 'systemsView', 'detects systemsView');

  // Record initial acceptance
  pref = recordAcceptance(pref, 'systemsView', true);

  // Operator rejects: too long, wants direct answer
  const rejection = detectRejection('Too long. Just tell me the answer.');
  assertEqual(rejection.rejected, true, 'detects rejection');
  assertEqual(rejection.preferredDirection, 'more-direct', 'wants more direct');

  // Record rejection
  pref = recordAcceptance(pref, 'systemsView', false);

  // Score for systemsView should decrease
  assert(pref.topologyScores.systemsView < 0.5, 'systemsView score should decrease after rejection');

  // directTactical should now be more competitive
  assert(pref.topologyScores.directTactical > pref.topologyScores.systemsView, 'directTactical should outscore systemsView');
})();

// ─── Test Summary ───────────────────────────────────────────────────────────

console.log(`\n${'='.repeat(60)}`);
console.log(`TEST SUMMARY: ${passCount}/${testCount} passed${failCount > 0 ? `, ${failCount} failed` : ''}`);
console.log(`${'='.repeat(60)}`);

if (failCount > 0) {
  process.exit(1);
}
