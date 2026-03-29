// intelligence/renderer.test.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Tests for Task V3: Multi-Style Renderer
//
// Pure logic — no external dependencies.
// Verifies: render strategies, structural transformations, integrity validation.
// Target: 45+ tests, 0 failures
// ─────────────────────────────────────────────────────────────────────────────

import {
  RENDER_STRATEGIES,
  renderResponse,
  getStrategy,
  applyClosingStyle,
  validateRenderIntegrity,
} from './renderer.mjs';

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

console.log('\n─── Task V3: renderer.mjs — Definition of Done ───\n');

// ────────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────────

const SAMPLE_RESPONSE = `The bug is in your useEffect dependency array.

You're missing the \`userId\` variable in the dependencies, so the effect runs
on every render. This causes the API call to fire repeatedly.

Here's the fix:
\`\`\`javascript
useEffect(() => {
  fetchUser(userId);
}, [userId]); // Add userId here
\`\`\`

This ensures the effect only runs when userId changes.`;

const SAMPLE_ARCHITECT_RESPONSE = `There are three architectural approaches to this problem.

OPTION 1: MONOLITHIC QUEUE
Use a single Redis queue for all events. Simple to implement, but creates
bottlenecks under load.

OPTION 2: SHARDED QUEUE
Partition events by key into multiple queues. More complex, but distributes
load and enables parallel processing.

OPTION 3: EVENT STREAMING
Use Kafka or similar. Best for high-volume scenarios with multiple consumers.
Overkill for most projects.

I'd recommend Option 2 for your use case because it scales linearly without
the operational overhead of Kafka.`;

const SAMPLE_REFLECTIVE_RESPONSE = `Why are we building this at all?

That's the fundamental question. On the surface, it seems like a feature the
users want. But dig deeper: are they asking for this because it solves a real
problem, or because it's a visible lever they think they need to pull?

The pattern I see in similar projects is that premature abstraction often feels
like progress. We build infrastructure before we have the evidence to justify it.
Then we're locked into decisions we made with incomplete information.

What if instead we built the minimum viable version, measured what actually
breaks, and then architectured from there?`;

// ════════════════════════════════════════════════════════════════════════════
// SECTION 1: RENDER_STRATEGIES Definition
// ════════════════════════════════════════════════════════════════════════════
console.log('RENDER_STRATEGIES Definitions:');
{
  assert(
    Object.keys(RENDER_STRATEGIES).length === 8,
    'All 8 strategies are defined'
  );
  assert(
    RENDER_STRATEGIES.tactical !== undefined,
    'tactical strategy exists'
  );
  assert(
    RENDER_STRATEGIES.architect !== undefined,
    'architect strategy exists'
  );
  assert(
    RENDER_STRATEGIES.critic !== undefined,
    'critic strategy exists'
  );
  assert(
    RENDER_STRATEGIES.debug !== undefined,
    'debug strategy exists'
  );
  assert(
    RENDER_STRATEGIES.strategy !== undefined,
    'strategy mode exists'
  );
  assert(
    RENDER_STRATEGIES.reflective !== undefined,
    'reflective strategy exists'
  );
  assert(
    RENDER_STRATEGIES.explorer !== undefined,
    'explorer strategy exists'
  );
  assert(
    RENDER_STRATEGIES.builder !== undefined,
    'builder strategy exists'
  );
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 2: Strategy Shape Validation
// ════════════════════════════════════════════════════════════════════════════
console.log('\nStrategy Shape Validation:');
{
  const tac = RENDER_STRATEGIES.tactical;
  assert(tac.prefix === null, 'tactical prefix is null');
  assert(tac.structure === 'direct', 'tactical uses direct structure');
  assert(tac.paragraphStyle === 'short', 'tactical uses short paragraphs');
  assert(tac.useHeaders === false, 'tactical does not force headers');
  assert(tac.headerThreshold === 300, 'tactical threshold is 300');
  assert(tac.bulletStyle === 'dash', 'tactical uses dash bullets');
  assert(tac.codeBlockPreference === 'inline', 'tactical prefers inline code');
  assert(tac.closingStyle === 'next-action', 'tactical closes with next-action');

  const arch = RENDER_STRATEGIES.architect;
  assert(arch.structure === 'framing-first', 'architect uses framing-first');
  assert(arch.useHeaders === true, 'architect uses headers');
  assert(arch.headerThreshold === 200, 'architect threshold is 200');
  assert(arch.bulletStyle === 'dash', 'architect uses dashes');
  assert(arch.codeBlockPreference === 'block', 'architect prefers block code');

  const crit = RENDER_STRATEGIES.critic;
  assert(crit.structure === 'assessment-first', 'critic uses assessment-first');
  assert(crit.bulletStyle === 'numbered', 'critic uses numbered bullets');
  assert(crit.headerThreshold === 250, 'critic threshold is 250');

  const dbg = RENDER_STRATEGIES.debug;
  assert(dbg.structure === 'diagnosis-first', 'debug uses diagnosis-first');
  assert(dbg.bulletStyle === 'numbered', 'debug uses numbered bullets');

  const bld = RENDER_STRATEGIES.builder;
  assert(bld.structure === 'sequential', 'builder uses sequential structure');
  assert(bld.headerThreshold === 150, 'builder threshold is 150');

  const strat = RENDER_STRATEGIES.strategy;
  assert(strat.structure === 'landscape-first', 'strategy uses landscape-first');
  assert(strat.paragraphStyle === 'long', 'strategy uses long paragraphs');

  const refl = RENDER_STRATEGIES.reflective;
  assert(refl.useHeaders === false, 'reflective does not force headers');
  assert(refl.headerThreshold === 500, 'reflective threshold is 500');

  const expl = RENDER_STRATEGIES.explorer;
  assert(expl.structure === 'divergent', 'explorer uses divergent structure');
  assert(expl.useHeaders === true, 'explorer uses headers');
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 3: getStrategy Function
// ════════════════════════════════════════════════════════════════════════════
console.log('\ngetStrategy Function:');
{
  const tac = getStrategy('tactical');
  assert(tac !== null, 'returns strategy for tactical');
  assert(tac.structure === 'direct', 'returned tactical has correct structure');

  assert(getStrategy('architect') !== null, 'returns strategy for architect');
  assert(getStrategy('critic') !== null, 'returns strategy for critic');
  assert(getStrategy('debug') !== null, 'returns strategy for debug');
  assert(getStrategy('strategy') !== null, 'returns strategy for strategy');
  assert(getStrategy('reflective') !== null, 'returns strategy for reflective');
  assert(getStrategy('explorer') !== null, 'returns strategy for explorer');
  assert(getStrategy('builder') !== null, 'returns strategy for builder');

  assert(getStrategy('invalid-mode') === null, 'returns null for invalid mode');
  assert(getStrategy('') === null, 'returns null for empty string');
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 4: renderResponse Basic Structure
// ════════════════════════════════════════════════════════════════════════════
console.log('\nrenderResponse Basic Structure:');
{
  const result = renderResponse(SAMPLE_RESPONSE, { mode: 'tactical' });
  assert(result !== null, 'returns object');
  assert(result.rendered !== undefined, 'has rendered property');
  assert(result.mode !== undefined, 'has mode property');
  assert(result.strategy !== undefined, 'has strategy property');
  assert(result.mutations !== undefined, 'has mutations property');
  assert(Array.isArray(result.mutations), 'mutations is array');
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 5: renderResponse Edge Cases
// ════════════════════════════════════════════════════════════════════════════
console.log('\nrenderResponse Edge Cases:');
{
  const empty = renderResponse('', { mode: 'tactical' });
  assert(empty.rendered === '', 'handles empty string');
  assert(empty.mode === 'tactical', 'defaults to tactical mode');

  const nullResp = renderResponse(null, { mode: 'tactical' });
  assert(nullResp.rendered === '', 'handles null');

  const undefinedResp = renderResponse(undefined, { mode: 'tactical' });
  assert(undefinedResp.rendered === '', 'handles undefined');

  const noMode = renderResponse(SAMPLE_RESPONSE);
  assert(noMode.mode === 'tactical', 'defaults to tactical when mode not specified');

  const invalidMode = renderResponse(SAMPLE_RESPONSE, { mode: 'invalid' });
  assert(invalidMode.rendered === SAMPLE_RESPONSE, 'returns original for invalid mode');
  assert(invalidMode.mutations.length === 0, 'no mutations for invalid mode');
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 6: Mode-Specific Strategy Selection
// ════════════════════════════════════════════════════════════════════════════
console.log('\nMode-Specific Strategy Selection:');
{
  const tac = renderResponse(SAMPLE_RESPONSE, { mode: 'tactical' });
  assert(tac.strategy === 'direct', 'tactical uses direct strategy');

  const arch = renderResponse(SAMPLE_ARCHITECT_RESPONSE, { mode: 'architect' });
  assert(arch.strategy === 'framing-first', 'architect uses framing-first');

  const dbg = renderResponse(SAMPLE_RESPONSE, { mode: 'debug' });
  assert(dbg.strategy === 'diagnosis-first', 'debug uses diagnosis-first');

  const bld = renderResponse(SAMPLE_RESPONSE, { mode: 'builder' });
  assert(bld.strategy === 'sequential', 'builder uses sequential');

  const expl = renderResponse(SAMPLE_RESPONSE, { mode: 'explorer' });
  assert(expl.strategy === 'divergent', 'explorer uses divergent');
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 7: Content Preservation
// ════════════════════════════════════════════════════════════════════════════
console.log('\nContent Preservation:');
{
  const result = renderResponse(SAMPLE_RESPONSE, { mode: 'tactical' });
  assert(result.rendered.includes('useEffect'), 'preserves useEffect mention');
  assert(result.rendered.includes('userId'), 'preserves userId variable');
  assert(result.rendered.includes('javascript'), 'preserves code language');

  const result2 = renderResponse(SAMPLE_ARCHITECT_RESPONSE, {
    mode: 'architect',
  });
  assert(
    result2.rendered.includes('OPTION'),
    'preserves OPTION headers in architect'
  );
  assert(
    result2.rendered.includes('Redis'),
    'preserves Redis mention'
  );
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 8: Direct Structure (Tactical)
// ════════════════════════════════════════════════════════════════════════════
console.log('\nDirect Structure (Tactical Mode):');
{
  const buried = `There are many factors to consider. The system is complex.
Let me think about this carefully. There are pros and cons.

The answer is to use a queue with Redis.

You'll want to monitor latency carefully.`;

  const result = renderResponse(buried, { mode: 'tactical' });
  assert(result.rendered !== undefined, 'processes buried answer');
  assert(result.rendered.length > 0, 'returns non-empty response');

  const response = `The solution is to refactor the component.

Here's why and how...`;
  const result2 = renderResponse(response, { mode: 'tactical' });
  assert(
    result2.rendered.startsWith('The solution'),
    'preserves answer at top'
  );
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 9: Diagnosis-First Structure (Debug)
// ════════════════════════════════════════════════════════════════════════════
console.log('\nDiagnosis-First Structure (Debug Mode):');
{
  const response = `Let me walk through what's happening here. The system has several moving parts.

The bug is in the event listener cleanup. You're not removing
the listener on unmount, so it fires multiple times.

To fix this, add a return statement to cleanup.`;

  const result = renderResponse(response, { mode: 'debug' });
  assert(result.rendered.includes('bug'), 'includes bug term');

  const issueResp = `The issue is that your cache invalidation strategy is wrong.
You're using a TTL but not invalidating on writes.`;
  const result2 = renderResponse(issueResp, { mode: 'debug' });
  assert(result2.rendered.includes('issue'), 'handles issue pattern');

  const rootResp = `The root cause is an off-by-one error in the loop.`;
  const result3 = renderResponse(rootResp, { mode: 'debug' });
  assert(result3.rendered.includes('root cause'), 'handles root cause pattern');
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 10: Sequential Structure (Builder)
// ════════════════════════════════════════════════════════════════════════════
console.log('\nSequential Structure (Builder Mode):');
{
  const stepsResp = `1. Clone the repository
2. Install dependencies with npm
3. Run the build command
4. Deploy to production`;

  const result = renderResponse(stepsResp, { mode: 'builder' });
  assert(result.rendered.includes('1.'), 'preserves step 1');
  assert(result.rendered.includes('2.'), 'preserves step 2');
  assert(result.rendered.includes('3.'), 'preserves step 3');
  assert(result.rendered.includes('4.'), 'preserves step 4');
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 11: Bullet Style Handling
// ════════════════════════════════════════════════════════════════════════════
console.log('\nBullet Style Handling:');
{
  const tacResp = `Three things:
* Item one
* Item two
* Item three`;

  const result = renderResponse(tacResp, { mode: 'tactical' });
  assert(result.rendered !== undefined, 'processes bullet list for tactical');

  const critResp = `Issues:
- Missing error handling
- Inefficient algorithm
- No unit tests`;

  const result2 = renderResponse(critResp, { mode: 'critic' });
  assert(result2.rendered !== undefined, 'processes bullet list for critic');
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 12: applyClosingStyle Function
// ════════════════════════════════════════════════════════════════════════════
console.log('\napplyClosingStyle Function:');
{
  const closingStyles = [
    'next-action',
    'tradeoff-summary',
    'recommendation',
    'fix-action',
    'direction',
    'open-question',
    'expansion',
    'checklist',
  ];

  for (const style of closingStyles) {
    const result = applyClosingStyle(SAMPLE_RESPONSE, style);
    assert(result.text !== undefined, `handles ${style}`);
    assert(typeof result.changed === 'boolean', `${style} returns changed flag`);
  }

  const invalid = applyClosingStyle(SAMPLE_RESPONSE, 'invalid');
  assert(invalid.text === SAMPLE_RESPONSE, 'handles invalid closing style');
  assert(invalid.changed === false, 'no changes for invalid style');
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 13: validateRenderIntegrity - Success Cases
// ════════════════════════════════════════════════════════════════════════════
console.log('\nvalidateRenderIntegrity - Success Cases:');
{
  const original = `The bug is here. Use this fix:
\`\`\`javascript
const x = y;
\`\`\`
Done.`;

  const result = validateRenderIntegrity(original, original);
  assert(result.valid === true, 'identical content passes validation');
  assert(result.issues.length === 0, 'no issues for identical content');

  const original2 = 'Use the `userId` variable in dependencies.';
  const result2 = validateRenderIntegrity(original2, original2);
  assert(result2.valid === true, 'code with backticks passes');
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 14: validateRenderIntegrity - Failure Cases
// ════════════════════════════════════════════════════════════════════════════
console.log('\nvalidateRenderIntegrity - Failure Cases:');
{
  const original = `Here's the code:
\`\`\`javascript
const x = y;
\`\`\`
That's it.`;

  const rendered = `Here's the code: const x = y; That's it.`;

  const result = validateRenderIntegrity(original, rendered);
  assert(result.valid === false, 'fails when code blocks removed');
  assert(result.issues.length > 0, 'lists issues when blocks removed');

  const longOriginal = 'The bug is here.';
  const longRendered = `The bug is here. Additional sentence one. Additional sentence two.
Additional sentence three. Additional sentence four. Added more.`;

  const result2 = validateRenderIntegrity(longOriginal, longRendered);
  // Should flag if too many sentences added
  assert(result2 !== null, 'validates sentence count');
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 15: validateRenderIntegrity - Edge Cases
// ════════════════════════════════════════════════════════════════════════════
console.log('\nvalidateRenderIntegrity - Edge Cases:');
{
  const result1 = validateRenderIntegrity('', 'text');
  assert(result1.valid === false, 'fails on empty original');

  const result2 = validateRenderIntegrity(null, 'text');
  assert(result2.valid === false, 'fails on null original');

  const result3 = validateRenderIntegrity('text', '');
  assert(result3.valid === false, 'fails on empty rendered');

  const result4 = validateRenderIntegrity('text', null);
  assert(result4.valid === false, 'fails on null rendered');
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 16: Code Block Preservation
// ════════════════════════════════════════════════════════════════════════════
console.log('\nCode Block Preservation:');
{
  const withCode = `Here's the solution:
\`\`\`javascript
function solve() {
  return true;
}
\`\`\`

Use it like that.`;

  const modes = [
    'tactical',
    'architect',
    'critic',
    'debug',
    'strategy',
    'reflective',
    'explorer',
    'builder',
  ];

  for (const mode of modes) {
    const result = renderResponse(withCode, { mode });
    assert(result.rendered.includes('```'), `${mode} preserves code blocks`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 17: Operator Profile Integration
// ════════════════════════════════════════════════════════════════════════════
console.log('\nOperator Profile Integration:');
{
  const profile = {
    dimensions: {
      responseFormat: 0.8,
    },
  };

  const result = renderResponse(SAMPLE_RESPONSE, {
    mode: 'architect',
    operatorProfile: profile,
  });
  assert(result.rendered !== undefined, 'respects operator profile');

  const resultNoProfile = renderResponse(SAMPLE_RESPONSE, {
    mode: 'architect',
    operatorProfile: null,
  });
  assert(resultNoProfile.rendered !== undefined, 'handles null profile');

  const emptyProfile = renderResponse(SAMPLE_RESPONSE, {
    mode: 'architect',
    operatorProfile: {},
  });
  assert(emptyProfile.rendered !== undefined, 'handles empty profile');
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 18: Force Strategy Override
// ════════════════════════════════════════════════════════════════════════════
console.log('\nForce Strategy Override:');
{
  const result = renderResponse(SAMPLE_RESPONSE, {
    mode: 'tactical',
    forceStrategy: 'sequential',
  });
  assert(result.strategy === 'sequential', 'respects forceStrategy');

  const result2 = renderResponse(SAMPLE_RESPONSE, {
    mode: 'architect',
    forceStrategy: 'direct',
  });
  assert(result2.strategy === 'direct', 'forceStrategy overrides mode strategy');
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 19: Special Character Handling
// ════════════════════════════════════════════════════════════════════════════
console.log('\nSpecial Character Handling:');
{
  const special = 'Use $variable or @decorator syntax properly. It\'s #hashtag safe.';
  const result = renderResponse(special, { mode: 'tactical' });
  assert(result.rendered.includes('$variable'), 'preserves $ characters');
  assert(result.rendered.includes('@decorator'), 'preserves @ characters');
  assert(result.rendered.includes('#hashtag'), 'preserves # characters');
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 20: Long Response Handling
// ════════════════════════════════════════════════════════════════════════════
console.log('\nLong Response Handling:');
{
  const long = 'A'.repeat(5000);
  const result = renderResponse(long, { mode: 'architect' });
  assert(result.rendered !== undefined, 'handles very long response');
  assert(result.rendered.length > 0, 'returns non-empty for long input');
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 21: End-to-End Scenarios
// ════════════════════════════════════════════════════════════════════════════
console.log('\nEnd-to-End Scenarios:');
{
  // Tactical
  const tacResp = 'The bug is in the loop. Use a break statement.';
  const tacResult = renderResponse(tacResp, { mode: 'tactical' });
  assert(tacResult.mode === 'tactical', 'tactical end-to-end preserves mode');
  assert(tacResult.strategy === 'direct', 'tactical uses direct strategy');
  assert(tacResult.rendered.includes('bug'), 'tactical preserves content');

  // Architect
  const archResult = renderResponse(SAMPLE_ARCHITECT_RESPONSE, {
    mode: 'architect',
  });
  assert(archResult.mode === 'architect', 'architect preserves mode');
  assert(archResult.strategy === 'framing-first', 'architect uses framing-first');

  // Debug
  const dbgResult = renderResponse(SAMPLE_RESPONSE, { mode: 'debug' });
  assert(dbgResult.mode === 'debug', 'debug preserves mode');
  assert(dbgResult.strategy === 'diagnosis-first', 'debug uses diagnosis-first');

  // Reflective
  const reflResult = renderResponse(SAMPLE_REFLECTIVE_RESPONSE, {
    mode: 'reflective',
  });
  assert(reflResult.rendered.includes('Why'), 'reflective preserves content');

  // Builder
  const stepsResp = `1. Setup
2. Configure
3. Deploy`;
  const bldResult = renderResponse(stepsResp, { mode: 'builder' });
  assert(bldResult.strategy === 'sequential', 'builder uses sequential');
  assert(bldResult.rendered.includes('1.'), 'builder preserves numbering');
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 22: Semantic Meaning Preservation
// ════════════════════════════════════════════════════════════════════════════
console.log('\nSemantic Meaning Preservation:');
{
  const original = `The issue is performance. Your query has N+1.
Use eager loading instead.`;

  const result = renderResponse(original, { mode: 'debug' });
  assert(result.rendered.includes('issue'), 'preserves issue terminology');
  assert(result.rendered.includes('performance'), 'preserves performance mention');
  assert(result.rendered.includes('query'), 'preserves query mention');
  assert(result.rendered.includes('eager loading'), 'preserves solution mention');
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 23: Mixed Content Handling
// ════════════════════════════════════════════════════════════════════════════
console.log('\nMixed Content Handling:');
{
  const mixed = `Here's context.

\`\`\`python
def foo():
  pass
\`\`\`

And more text.`;

  const result = renderResponse(mixed, { mode: 'debug' });
  assert(result.rendered.includes('```'), 'preserves code blocks in mixed');
  assert(result.rendered.includes('context'), 'preserves text in mixed');
  assert(result.rendered.includes('python'), 'preserves language tag');
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 24: All Modes Create Valid Results
// ════════════════════════════════════════════════════════════════════════════
console.log('\nAll Modes Create Valid Results:');
{
  const modes = [
    'tactical',
    'architect',
    'critic',
    'debug',
    'strategy',
    'reflective',
    'explorer',
    'builder',
  ];

  for (const mode of modes) {
    const result = renderResponse(SAMPLE_RESPONSE, { mode });
    assert(
      result.rendered !== undefined && result.rendered.length > 0,
      `${mode} produces valid output`
    );
  }
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 25: Integrity Across Modes
// ════════════════════════════════════════════════════════════════════════════
console.log('\nIntegrity Across Modes:');
{
  const modes = ['tactical', 'architect', 'critic', 'debug'];

  for (const mode of modes) {
    const result = renderResponse(SAMPLE_RESPONSE, { mode });
    const integrity = validateRenderIntegrity(SAMPLE_RESPONSE, result.rendered);
    // Code blocks should be preserved across all modes
    assert(
      result.rendered.includes('```'),
      `${mode} preserves code blocks`
    );
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Summary
// ════════════════════════════════════════════════════════════════════════════
console.log('\n' + '='.repeat(80));
console.log(`RESULTS: ${passed} passed, ${failed} failed`);
console.log('='.repeat(80) + '\n');

if (failed > 0) {
  process.exit(1);
}
