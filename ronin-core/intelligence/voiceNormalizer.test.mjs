// ─── intelligence/voiceNormalizer.test.mjs ───────────────────────────────────
// Definition-of-done test for RONIN Voice Normalizer.
//
// Tests the full pipeline:
//   operator message → signal extraction → profile update → validation →
//   (optional) Haiku rewrite → cost tracking → projection
//
// Mock provider simulates Haiku for rewrite tests.
// ─────────────────────────────────────────────────────────────────────────────

import {
  normalizeResponse,
  buildSystemPrompt,
  getProfile,
  saveProfile,
  getStats,
  resetStats,
  projectCost,
  _setProvider,
  _setProfileStore,
} from './voiceNormalizer.mjs';

import { validateVoice } from './voiceSchema.mjs';
import { createDefaultProfile } from './operatorProfile.mjs';

import assert from 'node:assert/strict';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    // Handle async tests
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(() => {
        console.log(`  ✓ ${name}`);
        passed++;
      }).catch(e => {
        console.log(`  ✗ ${name} (${e.message})`);
        failed++;
      });
    }
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name} (${e.message})`);
    failed++;
  }
  return Promise.resolve();
}

// ─── Mock Haiku Provider ─────────────────────────────────────────────────────
// Simulates what Haiku would do: strip sycophancy, remove AI identity, simplify.

function mockHaikuProvider({ messages }) {
  const input = messages[0]?.content || '';
  // Extract the response after the --- separator
  const parts = input.split('---');
  let rawResponse = parts.length > 1 ? parts[parts.length - 1].trim() : input;

  // Simulate Haiku cleanup
  rawResponse = rawResponse
    .replace(/^(Great question!?\s*)/i, '')
    .replace(/^(I'd be happy to help[.!]?\s*)/i, '')
    .replace(/^(Absolutely!?\s*)/i, '')
    .replace(/^(I'm sorry,?\s*(but\s*)?)/i, '')
    .replace(/\bAs an AI\b/gi, '')
    .replace(/\bAs a language model\b/gi, '')
    .replace(/\bmy training data\b/gi, 'available information')
    .replace(/\butilize\b/gi, 'use')
    .replace(/\bfacilitate\b/gi, 'help')
    .replace(/\bleverage\b/gi, 'use')
    .replace(/\bin order to\b/gi, 'to')
    .replace(/\s+/g, ' ')
    .trim();

  return Promise.resolve({ response: rawResponse });
}

// ─── Setup ───────────────────────────────────────────────────────────────────

_setProvider(mockHaikuProvider);
_setProfileStore(new Map());
resetStats();

// ─── Tests ───────────────────────────────────────────────────────────────────

async function runTests() {

  console.log('\n─── Voice Normalizer — Definition of Done ───');

  // ── Clean Response Pass-Through ──────────────────────────────────────────
  console.log('\nClean response pass-through:');

  await test('clean response passes without rewrite', async () => {
    const result = await normalizeResponse({
      response: 'The bug is in your useEffect dependency array. Memoize the value.',
      operatorMessage: 'why is my component re-rendering?',
      operatorId: 'op-clean-1',
    });
    assert.equal(result.normalized, false);
    assert(result.voiceScore >= 0.7);
    assert.equal(result.cost.tokens, 0);
    assert.equal(result.cost.estimatedUsd, 0);
  });

  await test('clean response cost is zero', async () => {
    const result = await normalizeResponse({
      response: 'Three options. First, use a context provider. Second, lift state. Third, use a state machine.',
      operatorMessage: 'how should I manage this state?',
      operatorId: 'op-clean-2',
    });
    assert.equal(result.cost.tokens, 0);
    assert.equal(result.cost.estimatedUsd, 0);
    assert(result.cost.latencyMs < 50, 'pass-through should be near-instant');
  });

  await test('clean response returns original text unchanged', async () => {
    const original = 'Your API is returning 500 because the middleware throws before reaching the handler.';
    const result = await normalizeResponse({
      response: original,
      operatorMessage: 'my endpoint is broken',
      operatorId: 'op-clean-3',
    });
    assert.equal(result.response, original);
  });

  // ── Dirty Response Normalization ─────────────────────────────────────────
  console.log('\nDirty response normalization:');

  await test('sycophantic response triggers normalization', async () => {
    const result = await normalizeResponse({
      response: 'Great question! I\'d be happy to help you with that. The issue is in your state management.',
      operatorMessage: 'what\'s wrong with my code?',
      operatorId: 'op-dirty-1',
    });
    assert.equal(result.normalized, true);
    assert(result.voiceScore < 0.7, `pre-score should be <0.7: ${result.voiceScore}`);
    assert(!result.response.toLowerCase().includes('great question'));
    assert(!result.response.toLowerCase().includes('happy to help'));
  });

  await test('AI identity leak triggers normalization', async () => {
    const result = await normalizeResponse({
      response: 'As an AI, I should note that my training data covers this topic well. The function needs a return statement.',
      operatorMessage: 'is this function correct?',
      operatorId: 'op-dirty-2',
    });
    assert.equal(result.normalized, true);
    assert(!result.response.toLowerCase().includes('as an ai'));
    assert(!result.response.toLowerCase().includes('my training data'));
  });

  await test('corporate jargon gets cleaned', async () => {
    const result = await normalizeResponse({
      response: 'You should utilize the caching mechanism in order to facilitate better performance and leverage the existing infrastructure.',
      operatorMessage: 'how do I speed this up?',
      operatorId: 'op-dirty-3',
    });
    assert.equal(result.normalized, true);
    assert(!result.response.includes('utilize'));
    assert(!result.response.includes('in order to'));
    assert(!result.response.includes('facilitate'));
    assert(!result.response.includes('leverage'));
  });

  await test('normalized response has better voice score', async () => {
    const result = await normalizeResponse({
      response: 'Great question! I\'d be happy to help. As an AI language model, I should utilize my training to facilitate your understanding.',
      operatorMessage: 'explain hooks',
      operatorId: 'op-dirty-4',
    });
    assert(result.voiceScoreAfter > result.voiceScore,
      `after (${result.voiceScoreAfter}) should be better than before (${result.voiceScore})`);
    assert(result.improvementDelta > 0);
  });

  // ── Cost Tracking ────────────────────────────────────────────────────────
  console.log('\nCost tracking:');

  await test('normalization reports token usage', async () => {
    const result = await normalizeResponse({
      response: 'Great question! I\'d be happy to help you understand this concept.',
      operatorMessage: 'what is this?',
      operatorId: 'op-cost-1',
    });
    if (result.normalized) {
      assert(result.cost.tokens > 0, 'should report tokens used');
      assert(result.cost.inputTokens > 0, 'should report input tokens');
      assert(result.cost.outputTokens > 0, 'should report output tokens');
      assert(result.cost.estimatedUsd > 0, 'should report cost');
      assert(result.cost.latencyMs >= 0, 'should report latency');
    }
  });

  await test('stats accumulate across calls', async () => {
    resetStats();
    // Clean response
    await normalizeResponse({
      response: 'The answer is 42.',
      operatorMessage: 'what?',
      operatorId: 'op-stats-1',
    });
    // Dirty response
    await normalizeResponse({
      response: 'Great question! I\'d be happy to help you.',
      operatorMessage: 'help',
      operatorId: 'op-stats-2',
    });

    const s = getStats();
    assert.equal(s.totalResponses, 2);
    assert.equal(s.passedValidation, 1);
    assert.equal(s.needsNormalization, 1);
  });

  await test('reset stats clears everything', () => {
    resetStats();
    const s = getStats();
    assert.equal(s.totalResponses, 0);
    assert.equal(s.passedValidation, 0);
    assert.equal(s.needsNormalization, 0);
    assert.equal(s.totalTokensUsed, 0);
  });

  // ── Profile Learning ─────────────────────────────────────────────────────
  console.log('\nProfile learning through normalizer:');

  await test('normalizer updates operator profile', async () => {
    _setProfileStore(new Map());
    await normalizeResponse({
      response: 'Here is the fix.',
      operatorMessage: 'lol this is broken btw fix it',
      operatorId: 'op-learn-1',
    });
    const profile = getProfile('op-learn-1');
    assert(profile.signals.messageCount >= 1, 'message count should increment');
    assert(profile.dimensions.warmth < 0.6, `warmth should shift casual: ${profile.dimensions.warmth}`);
  });

  await test('multiple messages shift profile over time', async () => {
    _setProfileStore(new Map());
    for (let i = 0; i < 8; i++) {
      await normalizeResponse({
        response: 'Done.',
        operatorMessage: 'update the Figma frame spacing and typography for the design system component layout',
        operatorId: 'op-learn-2',
      });
    }
    const profile = getProfile('op-learn-2');
    assert(profile.dimensions.domain < 0.4,
      `domain should lean design after 8 design messages: ${profile.dimensions.domain}`);
  });

  await test('operator profile persists across calls', async () => {
    _setProfileStore(new Map());
    await normalizeResponse({
      response: 'OK.',
      operatorMessage: 'how does the API endpoint connect to the database schema?',
      operatorId: 'op-persist',
    });
    await normalizeResponse({
      response: 'OK.',
      operatorMessage: 'show me the middleware function code',
      operatorId: 'op-persist',
    });
    const profile = getProfile('op-persist');
    assert.equal(profile.signals.messageCount, 2);
  });

  // ── System Prompt Building ───────────────────────────────────────────────
  console.log('\nSystem prompt building:');

  await test('buildSystemPrompt returns voice schema base', () => {
    const prompt = buildSystemPrompt('op-new');
    assert(prompt.includes('RONIN'));
    assert(prompt.includes('colleague'));
  });

  await test('adapted profile adds operator fragment', () => {
    _setProfileStore(new Map());
    const profile = createDefaultProfile('op-adapted');
    profile.dimensions.verbosity = 0.1;
    profile.dimensions.technicalDepth = 0.9;
    saveProfile(profile);

    const prompt = buildSystemPrompt('op-adapted');
    assert(prompt.includes('Adaptation for this operator'));
    assert(prompt.toLowerCase().includes('concise') || prompt.toLowerCase().includes('short'));
  });

  await test('default profile produces clean base prompt (no adaptation)', () => {
    _setProfileStore(new Map());
    const prompt = buildSystemPrompt('op-brand-new');
    assert(!prompt.includes('Adaptation for this operator'));
  });

  // ── Error Handling ───────────────────────────────────────────────────────
  console.log('\nError handling:');

  await test('provider failure returns original response', async () => {
    _setProvider(() => Promise.reject(new Error('Haiku timeout')));
    const result = await normalizeResponse({
      response: 'Great question! I\'d be happy to help.',
      operatorMessage: 'hi',
      operatorId: 'op-err-1',
    });
    assert.equal(result.normalized, false);
    assert(result.error, 'should have error message');
    assert(result.response.includes('Great question'), 'should return original on error');
    _setProvider(mockHaikuProvider);  // restore
  });

  await test('no provider set returns original with violations', async () => {
    _setProvider(null);
    const result = await normalizeResponse({
      response: 'Great question! I\'d be happy to help.',
      operatorMessage: 'hi',
      operatorId: 'op-err-2',
    });
    assert.equal(result.normalized, false);
    assert(result.violations.length > 0);
    _setProvider(mockHaikuProvider);  // restore
  });

  await test('skipRewrite flag validates but skips Haiku', async () => {
    const result = await normalizeResponse({
      response: 'Great question! I\'d be happy to help.',
      operatorMessage: 'hi',
      operatorId: 'op-skip',
      skipRewrite: true,
    });
    assert.equal(result.normalized, false);
    assert(result.voiceScore < 0.7);
    assert(result.violations.length > 0);
    assert.equal(result.cost.tokens, 0);
  });

  // ── Cost Projection ──────────────────────────────────────────────────────
  console.log('\nCost projection:');

  await test('projection with no data uses conservative estimate', () => {
    resetStats();
    const proj = projectCost(1000);
    assert.equal(proj.normalizationRate, 0.30);
    assert.equal(proj.dailyRewrites, 300);
    assert(proj.dailyCostUsd > 0);
    assert(proj.monthlyCostUsd > 0);
    assert(proj.note.includes('Projected'));
  });

  await test('projection with data uses observed rates', async () => {
    resetStats();
    // Generate some data
    for (let i = 0; i < 5; i++) {
      await normalizeResponse({
        response: 'Clean response number ' + i + '.',
        operatorMessage: 'test',
        operatorId: 'op-proj',
      });
    }
    for (let i = 0; i < 3; i++) {
      await normalizeResponse({
        response: 'Great question! I\'d be happy to help with number ' + i + '.',
        operatorMessage: 'test',
        operatorId: 'op-proj',
      });
    }
    const proj = projectCost(1000);
    assert(proj.note.includes('observed'));
    assert(proj.normalizationRate > 0, 'should have a positive normalization rate');
    assert(proj.normalizationRate < 1, 'should not be 100%');
  });

  // ── End-to-End Scenario ──────────────────────────────────────────────────
  console.log('\nEnd-to-end: Gaurav scenario:');

  await test('designer-learning-code gets adapted prompt + clean output', async () => {
    _setProfileStore(new Map());
    resetStats();

    // Simulate 5 messages from Gaurav
    const messages = [
      { op: 'check the Figma spacing on this frame', resp: 'The spacing is 16px between items. Matches your 8-point grid.' },
      { op: 'lol ok now show me the code', resp: 'Here\'s the component:\n```jsx\n<Stack spacing={16}>\n```' },
      { op: 'what does useState do?', resp: 'Great question! I\'d be happy to explain. useState is a React hook.' },
      { op: 'how does the API connect?', resp: 'The API endpoint at /api/chat accepts POST requests and returns SSE streams.' },
      { op: 'brainstorm the architecture tradeoffs', resp: 'Three paths. Monolith ships faster. Microservices scale better. Hybrid gives you both at the cost of operational complexity.' },
    ];

    for (const { op, resp } of messages) {
      await normalizeResponse({
        response: resp,
        operatorMessage: op,
        operatorId: 'gaurav',
      });
    }

    const profile = getProfile('gaurav');
    const prompt = buildSystemPrompt('gaurav');
    const s = getStats();

    // Profile should reflect mixed design/engineering, casual, philosophical
    assert.equal(profile.signals.messageCount, 5);
    assert(profile.dimensions.warmth < 0.6, 'should lean casual');
    assert(profile.dimensions.philosophyTolerance > 0.4, 'should tolerate philosophy');

    // Stats should show most passed, one normalized
    assert(s.passedValidation >= 3, 'most responses should pass');
    assert(s.needsNormalization >= 1, 'at least one should need normalization');

    // The dirty response (#3) should have been cleaned
    const dirtyResult = await normalizeResponse({
      response: 'Great question! I\'d be happy to explain. useState is a React hook.',
      operatorMessage: 'test',
      operatorId: 'gaurav',
      skipRewrite: false,
    });
    assert.equal(dirtyResult.normalized, true);
    assert(!dirtyResult.response.toLowerCase().includes('great question'));
  });

  // ── Module Shape ─────────────────────────────────────────────────────────
  console.log('\nModule shape:');

  await test('exports normalizeResponse', () => assert(typeof normalizeResponse === 'function'));
  await test('exports buildSystemPrompt', () => assert(typeof buildSystemPrompt === 'function'));
  await test('exports getProfile', () => assert(typeof getProfile === 'function'));
  await test('exports saveProfile', () => assert(typeof saveProfile === 'function'));
  await test('exports getStats', () => assert(typeof getStats === 'function'));
  await test('exports resetStats', () => assert(typeof resetStats === 'function'));
  await test('exports projectCost', () => assert(typeof projectCost === 'function'));
  await test('exports _setProvider', () => assert(typeof _setProvider === 'function'));
  await test('exports _setProfileStore', () => assert(typeof _setProfileStore === 'function'));

  // ─── Results ───────────────────────────────────────────────────────────
  console.log(`\n─── Results: ${passed} passed, ${failed} failed ───`);
  if (failed > 0) process.exit(1);
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
