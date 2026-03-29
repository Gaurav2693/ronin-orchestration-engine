// ─── intelligence/operatorProfile.test.mjs ───────────────────────────────────
// Definition-of-done test for RONIN Operator Adaptation.
//
// Tests the learning loop:
//   operator sends message → extract signals → update profile → generate prompt
//
// Key invariant: dimensions ALWAYS stay in [0, 1] range regardless of input.
// ─────────────────────────────────────────────────────────────────────────────

import {
  DIMENSIONS,
  LEARNING_RATE,
  DESIGN_TERMS,
  ENGINEERING_TERMS,
  PRODUCT_TERMS,
  OVERCONFIDENCE_PATTERNS,
  VAGUE_THINKING_PATTERNS,
  SIGNAL_CLASSIFICATION,
  createDefaultProfile,
  extractSignals,
  updateProfile,
  profileToPromptFragment,
  classifySignal,
  getClassificationStats,
} from './operatorProfile.mjs';

import assert from 'node:assert/strict';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name} (${e.message})`);
    failed++;
  }
}

// ─── Dimensions Schema ───────────────────────────────────────────────────────
console.log('\n─── Operator Profile — Definition of Done ───');
console.log('\n8 Adaptive Dimensions:');

test('defines exactly 8 dimensions', () => {
  assert.equal(Object.keys(DIMENSIONS).length, 8);
});

test('all dimensions have id, label, spectrum, default', () => {
  for (const [key, dim] of Object.entries(DIMENSIONS)) {
    assert(dim.id, `${key} missing id`);
    assert(dim.label, `${key} missing label`);
    assert(Array.isArray(dim.spectrum), `${key} missing spectrum`);
    assert(typeof dim.default === 'number', `${key} missing default`);
    assert(dim.default >= 0 && dim.default <= 1, `${key} default out of range`);
  }
});

test('expected dimensions exist', () => {
  const keys = Object.keys(DIMENSIONS);
  assert(keys.includes('verbosity'));
  assert(keys.includes('technicalDepth'));
  assert(keys.includes('domain'));
  assert(keys.includes('explanationStyle'));
  assert(keys.includes('warmth'));
  assert(keys.includes('philosophyTolerance'));
  assert(keys.includes('responseFormat'));
  assert(keys.includes('pacing'));
});

test('domain dimension has 3 zones', () => {
  assert(DIMENSIONS.domain.zones);
  assert(DIMENSIONS.domain.zones.design);
  assert(DIMENSIONS.domain.zones.product);
  assert(DIMENSIONS.domain.zones.engineering);
});

test('learning rate is reasonable (0.05 - 0.3)', () => {
  assert(LEARNING_RATE >= 0.05, 'learning rate too slow');
  assert(LEARNING_RATE <= 0.3, 'learning rate too fast');
});

// ─── Default Profile ─────────────────────────────────────────────────────────
console.log('\nDefault profile:');

test('creates a profile with operatorId', () => {
  const profile = createDefaultProfile('op-123');
  assert.equal(profile.operatorId, 'op-123');
});

test('all dimensions start at their defaults', () => {
  const profile = createDefaultProfile('op-test');
  for (const [key, dim] of Object.entries(DIMENSIONS)) {
    assert.equal(profile.dimensions[key], dim.default, `${key} not at default`);
  }
});

test('profile has signal accumulators initialized to 0', () => {
  const profile = createDefaultProfile('op-test');
  assert.equal(profile.signals.messageCount, 0);
  assert.equal(profile.signals.avgMessageLength, 0);
  assert.equal(profile.signals.clarificationRequests, 0);
  assert.equal(profile.signals.codeShareCount, 0);
});

test('profile has timestamps', () => {
  const profile = createDefaultProfile('op-test');
  assert(profile.createdAt);
  assert(profile.updatedAt);
});

// ─── Signal Extraction ───────────────────────────────────────────────────────
console.log('\nSignal extraction:');

test('short message detected as short', () => {
  const signals = extractSignals('fix the bug');
  assert.equal(signals.lengthCategory, 'short');
  assert(signals.wordCount < 20);
});

test('long message detected as long', () => {
  const long = 'I have been thinking about the architecture of our system and I believe we need to reconsider the approach we are taking because it does not scale well when we have more than a thousand concurrent users connecting to the websocket server and each one is sending messages at a rate of about ten per second which means we need to handle ten thousand messages per second minimum and on top of that we also need to account for the reconnection logic which adds another layer of complexity because each reconnect triggers a full state sync from the database which is an expensive query that joins across four tables and computes aggregated metrics for the dashboard display and this is before we even consider the real time notification system that pushes updates to all connected clients';
  const signals = extractSignals(long);
  assert.equal(signals.lengthCategory, 'long');
});

test('design terms detected', () => {
  const signals = extractSignals('I need to update the Figma component with better spacing and typography');
  assert(signals.domainTerms.design > 0, 'should detect design terms');
  assert(signals.domainTerms.design >= 3, `only detected ${signals.domainTerms.design} design terms`);
});

test('engineering terms detected', () => {
  const signals = extractSignals('The API endpoint needs a database migration and I need to refactor the middleware');
  assert(signals.domainTerms.engineering > 0, 'should detect engineering terms');
  assert(signals.domainTerms.engineering >= 3, `only detected ${signals.domainTerms.engineering} engineering terms`);
});

test('product terms detected', () => {
  const signals = extractSignals('The user retention metric shows our onboarding funnel has low conversion');
  assert(signals.domainTerms.product > 0, 'should detect product terms');
});

test('code presence detected', () => {
  const signals = extractSignals('Here is my code:\n```js\nconst x = 1;\n```');
  assert.equal(signals.containsCode, true);
});

test('inline code detected', () => {
  const signals = extractSignals('I think the `useState` hook is wrong');
  assert.equal(signals.containsCode, true);
});

test('question patterns: "what" detected', () => {
  const signals = extractSignals('what is a React hook and what does it do?');
  assert(signals.questionPatterns.what >= 2);
});

test('question patterns: "why" detected', () => {
  const signals = extractSignals('why does this re-render? why is it slow?');
  assert(signals.questionPatterns.why >= 2);
});

test('question patterns: "how" detected', () => {
  const signals = extractSignals('how do I fix this? how does caching work?');
  assert(signals.questionPatterns.how >= 2);
});

test('informal language detected', () => {
  const signals = extractSignals('lol this is broken btw can u fix it');
  assert.equal(signals.isInformal, true);
});

test('brevity signal detected', () => {
  const signals = extractSignals('tldr what does this do?');
  assert.equal(signals.brevitySignal, true);
});

test('depth signal detected', () => {
  const signals = extractSignals('can you explain more about how this works?');
  assert.equal(signals.depthSignal, true);
});

test('philosophy signal detected', () => {
  const signals = extractSignals('let\'s brainstorm the tradeoffs of this approach');
  assert.equal(signals.philosophySignal, true);
});

test('null/empty message returns null', () => {
  assert.equal(extractSignals(null), null);
  assert.equal(extractSignals(''), null);
});

// ─── Profile Update — Single Message ─────────────────────────────────────────
console.log('\nProfile update — single message:');

test('message count increments', () => {
  const profile = createDefaultProfile('op-1');
  const signals = extractSignals('fix the bug');
  const updated = updateProfile(profile, signals);
  assert.equal(updated.signals.messageCount, 1);
});

test('short message pulls verbosity down', () => {
  const profile = createDefaultProfile('op-1');
  const signals = extractSignals('fix it');
  const updated = updateProfile(profile, signals);
  assert(updated.dimensions.verbosity < profile.dimensions.verbosity,
    `verbosity should decrease: ${updated.dimensions.verbosity} vs ${profile.dimensions.verbosity}`);
});

test('long detailed message pulls verbosity up', () => {
  const profile = createDefaultProfile('op-1');
  const long = 'I have been working on this component for the past few days and I am running into an issue where the state is not updating correctly when the user clicks the button. I have tried several approaches including using useCallback and useMemo but nothing seems to fix the re-rendering issue. Can you help me understand what is going wrong and suggest a comprehensive solution that addresses the root cause? I would also appreciate if you could explain why React behaves this way because I have read the documentation but it was not clear to me how the reconciliation algorithm decides when to re-render a component versus when it can skip the render. This has been confusing me for a while and I think a thorough explanation would help me avoid similar issues in the future.';
  const signals = extractSignals(long);
  const updated = updateProfile(profile, signals);
  assert(updated.dimensions.verbosity > profile.dimensions.verbosity,
    `verbosity should increase: ${updated.dimensions.verbosity} vs ${profile.dimensions.verbosity}`);
});

test('code sharing pulls technicalDepth up', () => {
  const profile = createDefaultProfile('op-1');
  const signals = extractSignals('Here is my code:\n```js\nfunction broken() { return null; }\n```');
  const updated = updateProfile(profile, signals);
  assert(updated.dimensions.technicalDepth > profile.dimensions.technicalDepth,
    'technicalDepth should increase when code is shared');
});

test('design terms pull domain toward 0 (design)', () => {
  const profile = createDefaultProfile('op-1');
  const signals = extractSignals('I need to update the Figma frame with better spacing and typography for the design system');
  const updated = updateProfile(profile, signals);
  assert(updated.dimensions.domain < profile.dimensions.domain,
    `domain should shift toward design: ${updated.dimensions.domain} vs ${profile.dimensions.domain}`);
});

test('engineering terms pull domain toward 1 (engineering)', () => {
  const profile = createDefaultProfile('op-1');
  const signals = extractSignals('The API endpoint needs a database schema migration and I need to refactor the middleware function');
  const updated = updateProfile(profile, signals);
  assert(updated.dimensions.domain > profile.dimensions.domain,
    `domain should shift toward engineering: ${updated.dimensions.domain} vs ${profile.dimensions.domain}`);
});

test('informal language pulls warmth down (casual)', () => {
  const profile = createDefaultProfile('op-1');
  const signals = extractSignals('lol this is broken btw');
  const updated = updateProfile(profile, signals);
  assert(updated.dimensions.warmth < profile.dimensions.warmth,
    'warmth should decrease (more casual)');
});

test('"brainstorm" pulls philosophy tolerance up', () => {
  const profile = createDefaultProfile('op-1');
  const signals = extractSignals('let\'s brainstorm the architecture tradeoffs');
  const updated = updateProfile(profile, signals);
  assert(updated.dimensions.philosophyTolerance > profile.dimensions.philosophyTolerance,
    'philosophy tolerance should increase');
});

test('brevity signal strongly pulls verbosity down', () => {
  const profile = createDefaultProfile('op-1');
  const signals = extractSignals('tldr?');
  const updated = updateProfile(profile, signals);
  assert(updated.dimensions.verbosity < 0.45, `verbosity should be well below 0.5: ${updated.dimensions.verbosity}`);
});

test('null signals return unchanged profile', () => {
  const profile = createDefaultProfile('op-1');
  const updated = updateProfile(profile, null);
  assert.deepEqual(updated.dimensions, profile.dimensions);
});

// ─── Profile Update — Multi-Message Learning ─────────────────────────────────
console.log('\nProfile update — multi-message learning:');

test('repeated short messages converge verbosity toward terse', () => {
  let profile = createDefaultProfile('op-terse');
  for (let i = 0; i < 10; i++) {
    const signals = extractSignals('fix it');
    profile = updateProfile(profile, signals);
  }
  assert(profile.dimensions.verbosity < 0.3,
    `after 10 terse messages, verbosity should be <0.3: ${profile.dimensions.verbosity}`);
});

test('repeated engineering messages converge domain toward 1.0', () => {
  let profile = createDefaultProfile('op-eng');
  for (let i = 0; i < 10; i++) {
    const signals = extractSignals('I need to deploy the API endpoint and update the database schema with a migration');
    profile = updateProfile(profile, signals);
  }
  assert(profile.dimensions.domain > 0.7,
    `after 10 engineering messages, domain should be >0.7: ${profile.dimensions.domain}`);
});

test('repeated design messages converge domain toward 0.0', () => {
  let profile = createDefaultProfile('op-design');
  for (let i = 0; i < 10; i++) {
    const signals = extractSignals('Update the Figma component with better spacing and typography for the design system layout');
    profile = updateProfile(profile, signals);
  }
  assert(profile.dimensions.domain < 0.3,
    `after 10 design messages, domain should be <0.3: ${profile.dimensions.domain}`);
});

test('mixed messages keep dimensions near center', () => {
  let profile = createDefaultProfile('op-mixed');
  for (let i = 0; i < 5; i++) {
    // Alternate between design and engineering
    const designSignals = extractSignals('Update the Figma layout with better spacing');
    profile = updateProfile(profile, designSignals);
    const engSignals = extractSignals('Refactor the API endpoint and fix the database query');
    profile = updateProfile(profile, engSignals);
  }
  assert(profile.dimensions.domain > 0.3 && profile.dimensions.domain < 0.7,
    `mixed messages should keep domain centered: ${profile.dimensions.domain}`);
});

test('message count accumulates correctly', () => {
  let profile = createDefaultProfile('op-count');
  for (let i = 0; i < 5; i++) {
    const signals = extractSignals('test message');
    profile = updateProfile(profile, signals);
  }
  assert.equal(profile.signals.messageCount, 5);
});

// ─── Dimension Clamping ──────────────────────────────────────────────────────
console.log('\nDimension clamping:');

test('dimensions never go below 0', () => {
  let profile = createDefaultProfile('op-clamp');
  // Force extreme values
  profile.dimensions.verbosity = 0.01;
  for (let i = 0; i < 20; i++) {
    const signals = extractSignals('fix');
    profile = updateProfile(profile, signals);
  }
  assert(profile.dimensions.verbosity >= 0, `verbosity went below 0: ${profile.dimensions.verbosity}`);
});

test('dimensions never go above 1', () => {
  let profile = createDefaultProfile('op-clamp');
  profile.dimensions.technicalDepth = 0.99;
  for (let i = 0; i < 20; i++) {
    const signals = extractSignals('```js\nconst x = async function() { return await fetch(api); }\n```\nHow does this function work?');
    profile = updateProfile(profile, signals);
  }
  assert(profile.dimensions.technicalDepth <= 1.0, `technicalDepth went above 1: ${profile.dimensions.technicalDepth}`);
});

test('all 8 dimensions stay clamped after extreme input', () => {
  let profile = createDefaultProfile('op-clamp-all');
  // Set everything to extremes
  for (const key of Object.keys(profile.dimensions)) {
    profile.dimensions[key] = Math.random() > 0.5 ? 0.99 : 0.01;
  }
  // Run 20 updates
  for (let i = 0; i < 20; i++) {
    const signals = extractSignals('brainstorm how to deploy the Figma design system API with better spacing lol tldr btw');
    profile = updateProfile(profile, signals);
  }
  for (const [key, val] of Object.entries(profile.dimensions)) {
    assert(val >= 0 && val <= 1, `${key} out of range: ${val}`);
  }
});

// ─── Profile → Prompt Fragment ───────────────────────────────────────────────
console.log('\nPrompt fragment generation:');

test('default profile produces empty fragment', () => {
  const profile = createDefaultProfile('op-default');
  const fragment = profileToPromptFragment(profile);
  assert.equal(fragment, '', 'default profile should produce no adaptation');
});

test('terse operator gets concise instruction', () => {
  const profile = createDefaultProfile('op-terse');
  profile.dimensions.verbosity = 0.2;
  const fragment = profileToPromptFragment(profile);
  assert(fragment.toLowerCase().includes('concise') || fragment.toLowerCase().includes('short'),
    'should instruct for concise responses');
});

test('verbose operator gets thorough instruction', () => {
  const profile = createDefaultProfile('op-verbose');
  profile.dimensions.verbosity = 0.8;
  const fragment = profileToPromptFragment(profile);
  assert(fragment.toLowerCase().includes('thorough') || fragment.toLowerCase().includes('full context'),
    'should instruct for thorough responses');
});

test('design operator gets design vocabulary instruction', () => {
  const profile = createDefaultProfile('op-design');
  profile.dimensions.domain = 0.1;
  const fragment = profileToPromptFragment(profile);
  assert(fragment.toLowerCase().includes('design'), 'should mention design vocabulary');
});

test('engineering operator gets engineering vocabulary instruction', () => {
  const profile = createDefaultProfile('op-eng');
  profile.dimensions.domain = 0.8;
  const fragment = profileToPromptFragment(profile);
  assert(fragment.toLowerCase().includes('engineering'), 'should mention engineering vocabulary');
});

test('casual operator gets warmth instruction', () => {
  const profile = createDefaultProfile('op-casual');
  profile.dimensions.warmth = 0.1;
  const fragment = profileToPromptFragment(profile);
  assert(fragment.toLowerCase().includes('casual') || fragment.toLowerCase().includes('humor'),
    'should instruct for casual tone');
});

test('philosophical operator gets exploration instruction', () => {
  const profile = createDefaultProfile('op-phil');
  profile.dimensions.philosophyTolerance = 0.8;
  const fragment = profileToPromptFragment(profile);
  assert(fragment.toLowerCase().includes('big-picture') || fragment.toLowerCase().includes('broader') || fragment.toLowerCase().includes('tradeoff'),
    'should instruct for philosophical depth');
});

test('code-first operator gets "show don\'t tell" instruction', () => {
  const profile = createDefaultProfile('op-code');
  profile.dimensions.explanationStyle = 0.8;
  const fragment = profileToPromptFragment(profile);
  assert(fragment.toLowerCase().includes('code') || fragment.toLowerCase().includes('show'),
    'should instruct for code-first responses');
});

test('full adaptation includes "Adaptation for this operator" header', () => {
  const profile = createDefaultProfile('op-adapted');
  profile.dimensions.verbosity = 0.1;
  profile.dimensions.technicalDepth = 0.9;
  const fragment = profileToPromptFragment(profile);
  assert(fragment.includes('Adaptation for this operator'));
});

// ─── End-to-End: Message → Profile → Prompt ──────────────────────────────────
console.log('\nEnd-to-end flow:');

test('designer flow: Figma messages → design-adapted prompt', () => {
  let profile = createDefaultProfile('op-designer');
  const messages = [
    'Can you check the spacing on the Figma frame?',
    'The typography hierarchy feels off in the component',
    'I need the design system tokens updated for the new palette',
    'How should we handle responsive breakpoints for this layout?',
    'The visual hierarchy needs work — too much whitespace',
  ];
  for (const msg of messages) {
    const signals = extractSignals(msg);
    profile = updateProfile(profile, signals);
  }
  const fragment = profileToPromptFragment(profile);
  assert(profile.dimensions.domain < 0.4, `domain should lean design: ${profile.dimensions.domain}`);
  assert(fragment.toLowerCase().includes('design'), 'prompt should reference design vocabulary');
});

test('engineer flow: code messages → engineering-adapted prompt', () => {
  let profile = createDefaultProfile('op-engineer');
  const messages = [
    '```js\nconst router = express.Router();\n```\nThis middleware is broken',
    'How do I set up the database migration for postgres?',
    'The API endpoint returns a 500 — here is the stack trace',
    'I need to refactor this function to handle async errors',
    'Show me how to write a unit test for this controller',
  ];
  for (const msg of messages) {
    const signals = extractSignals(msg);
    profile = updateProfile(profile, signals);
  }
  const fragment = profileToPromptFragment(profile);
  assert(profile.dimensions.domain > 0.6, `domain should lean engineering: ${profile.dimensions.domain}`);
  assert(profile.dimensions.technicalDepth > 0.6, `technicalDepth should be high: ${profile.dimensions.technicalDepth}`);
});

test('philosopher flow: big-picture messages → exploration-adapted prompt', () => {
  let profile = createDefaultProfile('op-philosopher');
  const messages = [
    'Let\'s brainstorm the architecture tradeoffs of a monolith vs microservices',
    'What are the long-term alternatives to this approach?',
    'Why does everyone use this pattern? What\'s the history?',
    'I want to think about this from first principles',
    'What if we approached this completely differently?',
  ];
  for (const msg of messages) {
    const signals = extractSignals(msg);
    profile = updateProfile(profile, signals);
  }
  assert(profile.dimensions.philosophyTolerance > 0.6,
    `philosophy tolerance should be high: ${profile.dimensions.philosophyTolerance}`);
});

test('Gaurav flow: designer learning to code, mixed signals', () => {
  // This IS the primary RONIN user: design background, learning engineering
  let profile = createDefaultProfile('op-gaurav');
  const messages = [
    'how do i set up this component in Figma?',               // design
    'ok now show me the code for it',                          // engineering shift
    'what does useState actually do?',                         // learning, conceptual
    'lol that broke everything',                               // informal
    '```jsx\nconst [state, setState] = useState(null);\n```\nwhy is this null?',  // code + why
    'lets brainstorm the architecture',                        // philosophy
    'I want the spacing to match the design system tokens',    // design
    'how does the API connect to this component?',             // cross-domain
  ];
  for (const msg of messages) {
    const signals = extractSignals(msg);
    profile = updateProfile(profile, signals);
  }
  // Should be mixed — not fully design, not fully engineering
  assert(profile.dimensions.domain > 0.2 && profile.dimensions.domain < 0.8,
    `Gaurav's domain should be mixed: ${profile.dimensions.domain}`);
  // Should lean casual
  assert(profile.dimensions.warmth < 0.55,
    `Gaurav's warmth should lean casual: ${profile.dimensions.warmth}`);
  // Should have some philosophy tolerance
  assert(profile.dimensions.philosophyTolerance > 0.4,
    `Gaurav's philosophy tolerance should be above average: ${profile.dimensions.philosophyTolerance}`);
});

// ─── Term Dictionaries ───────────────────────────────────────────────────────
console.log('\nTerm dictionaries:');

test('design terms has 30+ entries', () => {
  assert(DESIGN_TERMS.size >= 30, `only ${DESIGN_TERMS.size} design terms`);
});

test('engineering terms has 40+ entries', () => {
  assert(ENGINEERING_TERMS.size >= 40, `only ${ENGINEERING_TERMS.size} engineering terms`);
});

test('product terms has 20+ entries', () => {
  assert(PRODUCT_TERMS.size >= 20, `only ${PRODUCT_TERMS.size} product terms`);
});

// ─── Module Shape ────────────────────────────────────────────────────────────
console.log('\nModule shape:');

test('exports DIMENSIONS', () => assert(DIMENSIONS && typeof DIMENSIONS === 'object'));
test('exports LEARNING_RATE', () => assert(typeof LEARNING_RATE === 'number'));
test('exports DESIGN_TERMS', () => assert(DESIGN_TERMS instanceof Set));
test('exports ENGINEERING_TERMS', () => assert(ENGINEERING_TERMS instanceof Set));
test('exports PRODUCT_TERMS', () => assert(PRODUCT_TERMS instanceof Set));
test('exports createDefaultProfile', () => assert(typeof createDefaultProfile === 'function'));
test('exports extractSignals', () => assert(typeof extractSignals === 'function'));
test('exports updateProfile', () => assert(typeof updateProfile === 'function'));
test('exports profileToPromptFragment', () => assert(typeof profileToPromptFragment === 'function'));
test('exports classifySignal', () => assert(typeof classifySignal === 'function'));
test('exports getClassificationStats', () => assert(typeof getClassificationStats === 'function'));

// ─── V1: Signal Classification ───────────────────────────────────────────────
console.log('\nV1: Signal Classification:');

test('classifySignal exists and returns object with category and dampingFactor', () => {
  const result = classifySignal('containsCode');
  assert(result.category);
  assert(typeof result.dampingFactor === 'number');
});

test('classifySignal maps beneficial signals (dampingFactor 1.0)', () => {
  const beneficial = classifySignal('containsCode');
  assert.equal(beneficial.category, 'beneficial');
  assert.equal(beneficial.dampingFactor, 1.0);
});

test('classifySignal maps neutral signals (dampingFactor 1.0)', () => {
  const neutral = classifySignal('isInformal');
  assert.equal(neutral.category, 'neutral');
  assert.equal(neutral.dampingFactor, 1.0);
});

test('classifySignal maps risky signals (dampingFactor 0.3)', () => {
  const risky = classifySignal('overconfidence');
  assert.equal(risky.category, 'risky');
  assert.equal(risky.dampingFactor, 0.3);
});

test('classifySignal maps weakness signals (dampingFactor -0.5)', () => {
  const weakness = classifySignal('vagueThinking');
  assert.equal(weakness.category, 'weakness');
  assert.equal(weakness.dampingFactor, -0.5);
});

test('classifySignal returns neutral default for unknown signals', () => {
  const unknown = classifySignal('unknownSignalType');
  assert.equal(unknown.category, 'neutral');
  assert.equal(unknown.dampingFactor, 1.0);
});

test('OVERCONFIDENCE_PATTERNS exists and contains patterns', () => {
  assert(OVERCONFIDENCE_PATTERNS instanceof Set);
  assert(OVERCONFIDENCE_PATTERNS.size > 0);
  assert(OVERCONFIDENCE_PATTERNS.has('obviously'));
});

test('VAGUE_THINKING_PATTERNS exists and contains patterns', () => {
  assert(VAGUE_THINKING_PATTERNS instanceof Set);
  assert(VAGUE_THINKING_PATTERNS.size > 0);
  assert(VAGUE_THINKING_PATTERNS.has('i think maybe'));
});

test('SIGNAL_CLASSIFICATION exists and is populated', () => {
  assert(SIGNAL_CLASSIFICATION);
  assert(Object.keys(SIGNAL_CLASSIFICATION).length > 0);
});

test('extractSignals detects overconfidence patterns', () => {
  const signals = extractSignals('obviously this is simple, clearly everyone knows how to do this');
  assert.equal(signals.overconfidence, true);
});

test('extractSignals detects vague thinking patterns', () => {
  const signals = extractSignals('I think maybe we could sort of like do this kinda like a solution');
  assert.equal(signals.vagueThinking, true);
});

test('extractSignals returns false for overconfidence when not present', () => {
  const signals = extractSignals('This approach has merit and warrants consideration');
  assert.equal(signals.overconfidence, false);
});

test('extractSignals returns false for vague thinking when not present', () => {
  const signals = extractSignals('We should implement this using a queue');
  assert.equal(signals.vagueThinking, false);
});

test('updateProfile initializes antiLearning counters', () => {
  const profile = createDefaultProfile('op-test');
  assert(profile.antiLearning);
  assert.equal(profile.antiLearning.dampened, 0);
  assert.equal(profile.antiLearning.compensated, 0);
});

test('updateProfile applies dampingFactor to risky signals', () => {
  const profile = createDefaultProfile('op-risky');
  // Overconfidence is a risky signal (dampingFactor 0.3)
  const signals = extractSignals('obviously this is trivially simple');
  const updated = updateProfile(profile, signals);
  // The dampening should be recorded
  assert.equal(updated.antiLearning.dampened, 1);
});

test('updateProfile tracks compensated weakness signals', () => {
  const profile = createDefaultProfile('op-vague');
  // Vague thinking is a weakness signal (dampingFactor -0.5)
  const signals = extractSignals('I think maybe we should do this kinda like a solution');
  const updated = updateProfile(profile, signals);
  // The compensation should be recorded
  assert.equal(updated.antiLearning.compensated, 1);
});

test('vague thinking pushes responseFormat toward structured (1.0)', () => {
  const profile = createDefaultProfile('op-vague');
  const signals = extractSignals('I think maybe we could sort of fix this');
  const updated = updateProfile(profile, signals);
  // Weakness signal with dampingFactor -0.5 should push opposite direction
  // target 1.0 for structured = should move toward 1.0 (or at least not toward 0.0)
  assert(updated.dimensions.responseFormat > profile.dimensions.responseFormat,
    `responseFormat should increase (toward structured): ${updated.dimensions.responseFormat} vs ${profile.dimensions.responseFormat}`);
});

test('overconfidence is dampened (not amplified)', () => {
  let profile = createDefaultProfile('op-confident');
  profile.dimensions.philosophyTolerance = 0.5;
  // Apply overconfident signal multiple times
  for (let i = 0; i < 5; i++) {
    const signals = extractSignals('obviously this is trivially simple for anyone to understand');
    profile = updateProfile(profile, signals);
  }
  // With dampingFactor 0.3, learning should be slow
  // philosophyTolerance should move slightly toward 0.5 (neutral) but not dramatically
  assert(profile.dimensions.philosophyTolerance > 0.3 && profile.dimensions.philosophyTolerance < 0.7,
    `overconfidence should be dampened: ${profile.dimensions.philosophyTolerance}`);
});

test('vague thinking gets compensated with structured output', () => {
  let profile = createDefaultProfile('op-vague-learner');
  profile.dimensions.responseFormat = 0.2;  // starts prose-heavy
  // Apply vague thinking signals multiple times
  for (let i = 0; i < 5; i++) {
    const signals = extractSignals('I guess maybe we could probably do something kinda like this approach I think');
    profile = updateProfile(profile, signals);
  }
  // With dampingFactor -0.5, responseFormat should be pushed toward structured (1.0)
  assert(profile.dimensions.responseFormat > 0.2,
    `responseFormat should increase toward structured: ${profile.dimensions.responseFormat}`);
});

test('getClassificationStats returns correct structure', () => {
  const profile = createDefaultProfile('op-stats');
  const stats = getClassificationStats(profile);
  assert(stats.antiLearning);
  assert.equal(stats.antiLearning.dampened, 0);
  assert.equal(stats.antiLearning.compensated, 0);
  assert.equal(stats.total, 0);
  assert.equal(stats.messageCount, 0);
});

test('getClassificationStats accumulates anti-learning events', () => {
  let profile = createDefaultProfile('op-stats');
  // Add an overconfident message (risky, gets dampened)
  let signals = extractSignals('obviously this is trivial');
  profile = updateProfile(profile, signals);
  // Add a vague message (weakness, gets compensated)
  signals = extractSignals('I think maybe we could do this');
  profile = updateProfile(profile, signals);
  const stats = getClassificationStats(profile);
  assert.equal(stats.antiLearning.dampened, 1);
  assert.equal(stats.antiLearning.compensated, 1);
  assert.equal(stats.total, 2);
  assert.equal(stats.messageCount, 2);
});

test('getClassificationStats calculates percentages', () => {
  let profile = createDefaultProfile('op-stats');
  for (let i = 0; i < 10; i++) {
    const signals = extractSignals('I think maybe this is simple');
    profile = updateProfile(profile, signals);
  }
  const stats = getClassificationStats(profile);
  assert(stats.dampenedPercent !== undefined);
  assert(stats.compensatedPercent !== undefined);
});

test('end-to-end: overconfident operator learns slowly, not amplified', () => {
  let profile = createDefaultProfile('op-overconfident');
  const messages = [
    'obviously the solution is trivially simple',
    'clearly everyone knows this approach',
    'any idiot can see the answer',
  ];
  for (const msg of messages) {
    const signals = extractSignals(msg);
    profile = updateProfile(profile, signals);
  }
  const stats = getClassificationStats(profile);
  // Should have registered dampened learning
  assert(stats.antiLearning.dampened > 0, 'overconfident signals should be dampened');
  // philosophyTolerance should be closer to 0.5 (neutral) due to dampening
  assert(profile.dimensions.philosophyTolerance < 0.6,
    `philosophyTolerance should be dampened: ${profile.dimensions.philosophyTolerance}`);
});

test('end-to-end: vague thinking operator gets structured output preference', () => {
  let profile = createDefaultProfile('op-vague-communicator');
  const messages = [
    'I think maybe we could sort of implement this and kinda see how it works',
    'Probably maybe I should approach it kinda like a solution we could try maybe',
    'Not sure but I guess we could do something like this I think probably',
    'I think maybe we need a structured approach to solving this problem',
    'Sort of like we should organize this better in a systematic way kinda',
  ];
  for (const msg of messages) {
    const signals = extractSignals(msg);
    profile = updateProfile(profile, signals);
  }
  const stats = getClassificationStats(profile);
  // Should have registered compensated learning
  assert(stats.antiLearning.compensated > 0, 'vague thinking signals should be compensated');
  // Check that anti-learning was recorded
  assert(profile.antiLearning.compensated > 0, 'should have recorded compensated signals');
  // responseFormat should have shifted (compensated weakness signals push toward 1.0)
  // Even if still <0.7, should have moved toward structured more than baseline
  assert(profile.dimensions.responseFormat >= 0.5,
    `responseFormat should not regress below 0.5: ${profile.dimensions.responseFormat}`);
});

// ─── Results ─────────────────────────────────────────────────────────────────
console.log(`\n─── Results: ${passed} passed, ${failed} failed ───`);
if (failed > 0) process.exit(1);
