// intelligence/confidenceScorer.test.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Tests for Task 13: Confidence Scorer
//
// Pure logic — no external dependencies.
// Verifies: signal detection, scoring accuracy, threshold triggering.
// ─────────────────────────────────────────────────────────────────────────────

import {
  scoreConfidence,
  shouldTriggerConsensus,
  CONFIG,
  SIGNALS,
  POSITIVE_SIGNALS,
} from './confidenceScorer.mjs';

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

console.log('\n─── Task 13: confidenceScorer.mjs — Definition of Done ───\n');

// ════════════════════════════════════════════════════════════════════════════
// Test 1: Configuration
// ════════════════════════════════════════════════════════════════════════════
console.log('Configuration:');
{
  assert(CONFIG.THRESHOLD === 0.7, 'consensus threshold is 0.7');
  assert(CONFIG.HIGH_CONFIDENCE === 0.9, 'high confidence threshold is 0.9');
  assert(CONFIG.MIN_LENGTH === 20, 'min response length is 20');
  assert(Object.keys(SIGNALS).length === 6, '6 negative signal categories');
  assert(Object.keys(POSITIVE_SIGNALS).length === 2, '2 positive signal categories');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 2: Confident response scores high
// ════════════════════════════════════════════════════════════════════════════
console.log('\nConfident response:');
{
  const response = `Here's the fix for your SwiftUI layout issue. The problem is that your VStack doesn't have an explicit frame. Add \`.frame(maxWidth: .infinity)\` to the outer container. This will make it expand correctly.

\`\`\`swift
VStack {
    Text("Hello")
}
.frame(maxWidth: .infinity)
\`\`\`

The correct approach is to always set explicit frames on your root containers.`;

  const result = scoreConfidence(response);
  assert(result.score >= 0.8, `confident response scores high: ${result.score}`);
  assert(result.needsConsensus === false, 'no consensus needed');
  assert(typeof result.summary === 'string', 'has summary string');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 3: Hedging response scores low
// ════════════════════════════════════════════════════════════════════════════
console.log('\nHedging response:');
{
  const response = `I think the issue might be with your layout, but I'm not sure. Perhaps you could try changing the frame, although I'm not entirely sure that's the right approach. It could be something else, probably related to the container. I believe there might be a bug, but I'm not certain.`;

  const result = scoreConfidence(response);
  assert(result.score < 0.7, `hedging response scores low: ${result.score}`);
  assert(result.needsConsensus === true, 'consensus needed for hedging');
  assert(result.signals.hedging !== undefined, 'hedging signals detected');
  assert(result.signals.hedging.matches >= 3, `multiple hedging matches: ${result.signals.hedging.matches}`);
}

// ════════════════════════════════════════════════════════════════════════════
// Test 4: Refusal scores very low
// ════════════════════════════════════════════════════════════════════════════
console.log('\nRefusal response:');
{
  const response = `I can't help with that specific issue because I don't have access to your codebase. I'm not able to see the actual error, and I don't have the information needed to debug this.`;

  const result = scoreConfidence(response);
  assert(result.score < 0.5, `refusal scores very low: ${result.score}`);
  assert(result.needsConsensus === true, 'consensus needed for refusal');
  assert(result.signals.refusal !== undefined, 'refusal signals detected');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 5: Self-correction indicates low confidence
// ════════════════════════════════════════════════════════════════════════════
console.log('\nSelf-correction:');
{
  const response = `The solution is to use useState. Actually, wait — let me reconsider. I was wrong about that. Actually, you should use useReducer instead because the state logic is complex.`;

  const result = scoreConfidence(response);
  assert(result.score < 0.7, `self-correction scores lower: ${result.score}`);
  assert(result.signals.selfCorrection !== undefined, 'self-correction detected');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 6: Code blocks boost confidence
// ════════════════════════════════════════════════════════════════════════════
console.log('\nCode blocks boost:');
{
  const withCode = `Here's the implementation:

\`\`\`javascript
export function route(msg) {
  return msg.length > 100 ? 'sonnet' : 'haiku';
}
\`\`\`

Use \`route()\` to determine the model.`;

  const withoutCode = `You should implement a function that checks the message length and returns the appropriate model name based on whether it exceeds one hundred characters.`;

  const scoreWithCode = scoreConfidence(withCode).score;
  const scoreWithoutCode = scoreConfidence(withoutCode).score;

  assert(scoreWithCode >= scoreWithoutCode,
    `code boosts confidence: ${scoreWithCode} >= ${scoreWithoutCode}`);
}

// ════════════════════════════════════════════════════════════════════════════
// Test 7: Vagueness detection
// ════════════════════════════════════════════════════════════════════════════
console.log('\nVagueness detection:');
{
  const response = `It's something like a routing function, kind of. It sort of figures out which model to use, roughly based on the message content. In some cases it works, in some situations it doesn't.`;

  const result = scoreConfidence(response);
  assert(result.score < 0.8, `vague response scores lower: ${result.score}`);
  assert(result.signals.vagueness !== undefined, 'vagueness signals detected');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 8: Contradiction signals (lower weight)
// ════════════════════════════════════════════════════════════════════════════
console.log('\nContradiction signals:');
{
  const response = `The best approach is server-side rendering. However, client-side rendering has advantages too. On the other hand, a hybrid approach might work. Although, that said, the choice depends on your specific needs and conversely there are tradeoffs either way.`;

  const result = scoreConfidence(response);
  assert(result.signals.contradiction !== undefined, 'contradiction signals detected');
  // Contradictions have low weight — shouldn't tank the score alone
  assert(result.score > 0.5, `contradictions alone don't tank score: ${result.score}`);
}

// ════════════════════════════════════════════════════════════════════════════
// Test 9: Empty/null/short responses
// ════════════════════════════════════════════════════════════════════════════
console.log('\nEdge cases:');
{
  const empty = scoreConfidence('');
  assert(empty.score === 0, 'empty string → score 0');
  assert(empty.needsConsensus === true, 'empty → needs consensus');

  const nullR = scoreConfidence(null);
  assert(nullR.score === 0, 'null → score 0');

  const short = scoreConfidence('OK, got it.');
  assert(short.score === 1.0, 'short response → score 1.0 (skip scoring)');
  assert(short.needsConsensus === false, 'short → no consensus');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 10: shouldTriggerConsensus
// ════════════════════════════════════════════════════════════════════════════
console.log('\nshouldTriggerConsensus:');
{
  const confident = `Here's the exact solution. You need to add the frame modifier to your VStack container. The correct approach is definitely to use .frame(maxWidth: .infinity).`;
  assert(shouldTriggerConsensus(confident) === false,
    'confident response → no consensus');

  const hedgy = `I think maybe you could try something like adding a frame, but I'm not sure if that's the right approach. Perhaps there's a better way, although I'm not certain. It could be something else, probably not though.`;
  assert(shouldTriggerConsensus(hedgy) === true,
    'hedgy response → consensus triggered');

  // High-risk uses stricter threshold (0.9)
  const medium = `The fix should work. You need to update the configuration file and restart the server. That should resolve the issue.`;
  const needsForHigh = shouldTriggerConsensus(medium, 'high');
  const needsForMedium = shouldTriggerConsensus(medium, 'medium');

  // High-risk threshold is stricter, so might trigger where medium doesn't
  assert(typeof needsForHigh === 'boolean', 'high-risk returns boolean');
  assert(typeof needsForMedium === 'boolean', 'medium-risk returns boolean');
}

// ════════════════════════════════════════════════════════════════════════════
// Test 11: Score is always clamped 0-1
// ════════════════════════════════════════════════════════════════════════════
console.log('\nScore clamping:');
{
  // Extremely hedgy — lots of signals should push toward 0 but never below
  const extreme = `I think perhaps maybe it could be sort of something like I'm not sure but I believe probably it might be that I think perhaps it could be roughly not certain.`;
  const result = scoreConfidence(extreme);
  assert(result.score >= 0, `score never below 0: ${result.score}`);
  assert(result.score <= 1, `score never above 1: ${result.score}`);
}

// ════════════════════════════════════════════════════════════════════════════
// Test 12: Signal breakdown is useful for debugging
// ════════════════════════════════════════════════════════════════════════════
console.log('\nSignal breakdown:');
{
  const response = `I think the issue might be related to something. I'm not sure exactly, but perhaps you could try restarting. I can't access your system to verify.`;

  const result = scoreConfidence(response);

  // Should have multiple signal types
  const signalTypes = Object.keys(result.signals);
  assert(signalTypes.length >= 2, `multiple signal types detected: ${signalTypes.join(', ')}`);

  // Each signal has matches count and impact
  for (const [name, data] of Object.entries(result.signals)) {
    assert(typeof data.matches === 'number', `${name} has matches count`);
    assert(typeof data.impact === 'number', `${name} has impact value`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Test 13: Module exports correct shape
// ════════════════════════════════════════════════════════════════════════════
console.log('\nModule shape:');
{
  const mod = await import('./confidenceScorer.mjs');
  assert(typeof mod.scoreConfidence === 'function', 'exports scoreConfidence');
  assert(typeof mod.shouldTriggerConsensus === 'function', 'exports shouldTriggerConsensus');
  assert(typeof mod.CONFIG === 'object', 'exports CONFIG');
  assert(typeof mod.SIGNALS === 'object', 'exports SIGNALS');
  assert(typeof mod.POSITIVE_SIGNALS === 'object', 'exports POSITIVE_SIGNALS');
  assert(typeof mod.default === 'object', 'default export is object');
}

// ─── Summary ────────────────────────────────────────────────────────────────
console.log(`\n─── Results: ${passed} passed, ${failed} failed ───\n`);
if (failed > 0) process.exit(1);
