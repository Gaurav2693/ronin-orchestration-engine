// ─── intelligence/voiceSchema.test.mjs ───────────────────────────────────────
// Definition-of-done test for RONIN Voice Schema.
//
// This module is the single source of truth for how RONIN speaks.
// Tests verify: identity contract, tone rules, banned patterns,
// vocabulary preferences, system prompt generation, normalizer prompt,
// and the validateVoice scoring engine.
// ─────────────────────────────────────────────────────────────────────────────

import {
  IDENTITY,
  TONE_RULES,
  VOCABULARY,
  STRUCTURE,
  BANNED_PATTERNS,
  generateSystemPrompt,
  generateNormalizerPrompt,
  validateVoice,
} from './voiceSchema.mjs';

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

// ─── Identity Contract ───────────────────────────────────────────────────────
console.log('\n─── RONIN Voice Schema — Definition of Done ───');
console.log('\nIdentity contract:');

test('name is RONIN', () => {
  assert.equal(IDENTITY.name, 'RONIN');
});

test('persona is colleague, not assistant', () => {
  assert.equal(IDENTITY.persona, 'colleague');
  assert.notEqual(IDENTITY.persona, 'assistant');
});

test('relationship is peer', () => {
  assert.equal(IDENTITY.relationship, 'peer');
});

test('uses first person naturally', () => {
  assert.equal(IDENTITY.firstPerson, true);
});

// ─── Tone Rules ──────────────────────────────────────────────────────────────
console.log('\nTone rules:');

test('has critical tone rules defined', () => {
  const ruleIds = TONE_RULES.map(r => r.id);
  assert(ruleIds.includes('no-sycophancy'), 'missing no-sycophancy');
  assert(ruleIds.includes('no-apology-preamble'), 'missing no-apology-preamble');
  assert(ruleIds.includes('no-model-identity'), 'missing no-model-identity');
  assert(ruleIds.includes('direct-start'), 'missing direct-start');
  assert(ruleIds.includes('match-energy'), 'missing match-energy');
  assert(ruleIds.includes('no-hedging'), 'missing no-hedging');
  assert(ruleIds.includes('no-corporate-filler'), 'missing no-corporate-filler');
  assert(ruleIds.includes('no-markdown-spam'), 'missing no-markdown-spam');
});

test('no-sycophancy has max weight', () => {
  const rule = TONE_RULES.find(r => r.id === 'no-sycophancy');
  assert.equal(rule.weight, 1.0);
});

test('no-model-identity has max weight', () => {
  const rule = TONE_RULES.find(r => r.id === 'no-model-identity');
  assert.equal(rule.weight, 1.0);
});

test('sycophancy ban list covers common openers', () => {
  const rule = TONE_RULES.find(r => r.id === 'no-sycophancy');
  assert(rule.ban.some(b => b.toLowerCase().includes('great question')));
  assert(rule.ban.some(b => b.toLowerCase().includes('happy to help')));
  assert(rule.ban.some(b => b.toLowerCase().includes('absolutely')));
});

test('model identity ban covers all providers', () => {
  const rule = TONE_RULES.find(r => r.id === 'no-model-identity');
  const bansLower = rule.ban.map(b => b.toLowerCase());
  assert(bansLower.some(b => b.includes('claude')), 'missing Claude');
  assert(bansLower.some(b => b.includes('gpt')), 'missing GPT');
  assert(bansLower.some(b => b.includes('as an ai')), 'missing "as an AI"');
  assert(bansLower.some(b => b.includes('training')), 'missing training reference');
});

test('direct-start has good and bad examples', () => {
  const rule = TONE_RULES.find(r => r.id === 'direct-start');
  assert(rule.examples.good.length >= 2, 'need at least 2 good examples');
  assert(rule.examples.bad.length >= 2, 'need at least 2 bad examples');
});

test('every rule with a ban list has at least 3 entries', () => {
  for (const rule of TONE_RULES) {
    if (rule.ban) {
      assert(rule.ban.length >= 3, `${rule.id} has only ${rule.ban.length} bans`);
    }
  }
});

// ─── Vocabulary ──────────────────────────────────────────────────────────────
console.log('\nVocabulary preferences:');

test('prefer simple words over corporate ones', () => {
  assert(VOCABULARY.prefer['use'].includes('utilize'));
  assert(VOCABULARY.prefer['help'].includes('facilitate'));
  assert(VOCABULARY.prefer['fix'].includes('remediate'));
});

test('"in order to" maps to "to"', () => {
  assert(VOCABULARY.prefer['to'].includes('in order to'));
});

test('technical terms are exempted', () => {
  assert(VOCABULARY.technicalExceptions.includes('component'));
  assert(VOCABULARY.technicalExceptions.includes('embedding'));
  assert(VOCABULARY.technicalExceptions.includes('schema'));
});

test('has at least 15 vocabulary preferences', () => {
  assert(Object.keys(VOCABULARY.prefer).length >= 15);
});

// ─── Structure Rules ─────────────────────────────────────────────────────────
console.log('\nStructure rules:');

test('max sentence length defined', () => {
  assert(STRUCTURE.maxSentenceWords > 0);
  assert(STRUCTURE.maxSentenceWords <= 40, 'sentences should be under 40 words');
});

test('prefers active voice', () => {
  assert.equal(STRUCTURE.preferActivoice, true);
});

test('list threshold is 4+', () => {
  assert(STRUCTURE.listThreshold >= 4, 'bullets only for 4+ items');
});

// ─── Banned Patterns ─────────────────────────────────────────────────────────
console.log('\nBanned patterns:');

test('has regex patterns defined', () => {
  assert(BANNED_PATTERNS.length >= 8, `only ${BANNED_PATTERNS.length} patterns`);
  assert(BANNED_PATTERNS.every(p => p instanceof RegExp), 'all must be RegExp');
});

test('catches "Great question" opener', () => {
  assert(BANNED_PATTERNS.some(p => p.test('Great question! Let me explain...')));
});

test('catches "Absolutely" opener', () => {
  assert(BANNED_PATTERNS.some(p => p.test('Absolutely! Here\'s how...')));
});

test('catches "As an AI" identity leak', () => {
  assert(BANNED_PATTERNS.some(p => p.test('As an AI, I don\'t have feelings')));
});

test('catches "I\'m Claude" identity leak', () => {
  assert(BANNED_PATTERNS.some(p => p.test('I\'m Claude, made by Anthropic')));
});

test('catches "I\'m sorry" preamble', () => {
  assert(BANNED_PATTERNS.some(p => p.test('I\'m sorry, I can\'t help with that')));
});

test('catches corporate filler "circle back"', () => {
  assert(BANNED_PATTERNS.some(p => p.test('Let\'s circle back on this later')));
});

test('catches triple hedge', () => {
  assert(BANNED_PATTERNS.some(p => p.test('This might possibly maybe work')));
});

test('does NOT ban clean RONIN responses', () => {
  const clean = 'The bug is in your useEffect dependency array. You\'re creating a new array on every render.';
  const matches = BANNED_PATTERNS.filter(p => p.test(clean));
  assert.equal(matches.length, 0, `clean response matched ${matches.length} patterns`);
});

test('does NOT ban technical language', () => {
  const technical = 'Your component re-renders because the state update triggers a new render cycle. Memoize with useMemo.';
  const matches = BANNED_PATTERNS.filter(p => p.test(technical));
  assert.equal(matches.length, 0, `technical response matched ${matches.length} patterns`);
});

test('does NOT ban code blocks', () => {
  const code = '```javascript\nconst result = await fetch(url);\n```';
  const matches = BANNED_PATTERNS.filter(p => p.test(code));
  assert.equal(matches.length, 0, 'code block should not trigger bans');
});

// ─── System Prompt Generation ────────────────────────────────────────────────
console.log('\nSystem prompt generation:');

test('generates a non-empty system prompt', () => {
  const prompt = generateSystemPrompt();
  assert(prompt.length > 100, 'prompt too short');
});

test('prompt mentions RONIN by name', () => {
  const prompt = generateSystemPrompt();
  assert(prompt.includes('RONIN'));
});

test('prompt enforces colleague persona', () => {
  const prompt = generateSystemPrompt();
  assert(prompt.includes('colleague'));
  assert(prompt.includes('not an assistant'));
});

test('prompt bans sycophancy', () => {
  const prompt = generateSystemPrompt();
  const lower = prompt.toLowerCase();
  assert(lower.includes('great question') || lower.includes('happy to help'));
});

test('prompt bans model identity', () => {
  const prompt = generateSystemPrompt();
  assert(prompt.includes('Never reveal which AI model'));
});

test('full prompt includes examples', () => {
  const prompt = generateSystemPrompt({ includeExamples: true });
  assert(prompt.includes('Operator:'));
  assert(prompt.includes('You:'));
});

test('compact prompt excludes examples', () => {
  const prompt = generateSystemPrompt({ compact: true });
  assert(!prompt.includes('Operator:'));
});

test('prompt without examples option excludes them', () => {
  const prompt = generateSystemPrompt({ includeExamples: false });
  assert(!prompt.includes('Operator:'));
});

// ─── Normalizer Prompt ───────────────────────────────────────────────────────
console.log('\nNormalizer prompt:');

test('generates normalizer prompt', () => {
  const prompt = generateNormalizerPrompt();
  assert(prompt.length > 50);
});

test('normalizer instructs to preserve code blocks', () => {
  const prompt = generateNormalizerPrompt();
  assert(prompt.toLowerCase().includes('code block') || prompt.toLowerCase().includes('technical content'));
});

test('normalizer instructs to remove sycophancy', () => {
  const prompt = generateNormalizerPrompt();
  const lower = prompt.toLowerCase();
  assert(lower.includes('happy to help') || lower.includes('praise'));
});

test('normalizer says return only the rewrite', () => {
  const prompt = generateNormalizerPrompt();
  assert(prompt.includes('Return ONLY') || prompt.includes('return only'));
});

// ─── Validate Voice — Clean Responses ────────────────────────────────────────
console.log('\nValidation — clean responses:');

test('clean direct response scores 1.0', () => {
  const result = validateVoice('The bug is in your useEffect dependency array.');
  assert.equal(result.score, 1.0);
  assert.equal(result.violations.length, 0);
  assert.equal(result.pass, true);
});

test('technical response with code scores high', () => {
  const result = validateVoice('Use `useMemo` to cache the calculation:\n\n```js\nconst value = useMemo(() => expensiveCalc(items), [items]);\n```');
  assert(result.score >= 0.9, `score ${result.score} too low for clean technical response`);
  assert.equal(result.pass, true);
});

test('concise answer passes', () => {
  const result = validateVoice('No. That approach won\'t scale past 100 users.');
  assert.equal(result.score, 1.0);
  assert.equal(result.pass, true);
});

// ─── Validate Voice — Violations ─────────────────────────────────────────────
console.log('\nValidation — violation detection:');

test('sycophantic opener detected', () => {
  const result = validateVoice('Great question! Let me walk you through this.');
  assert(result.violations.length > 0, 'should detect sycophancy');
  assert(result.score < 1.0);
});

test('"I\'d be happy to help" detected', () => {
  const result = validateVoice('I\'d be happy to help you with that. Here\'s what you need to do.');
  assert(result.violations.length > 0);
});

test('AI identity leak detected', () => {
  const result = validateVoice('As an AI, I should mention that my training data only goes to 2024.');
  assert(result.violations.length > 0);
  const identityViolation = result.violations.some(v =>
    v.rule === 'no-model-identity' || v.rule === 'banned-pattern'
  );
  assert(identityViolation, 'should flag model identity leak');
});

test('"I\'m Claude" detected', () => {
  const result = validateVoice('I\'m Claude, and I can help with coding questions.');
  assert(result.violations.length > 0);
});

test('apology preamble detected', () => {
  const result = validateVoice('I\'m sorry, but I\'m not able to access external websites.');
  assert(result.violations.length > 0);
});

test('corporate filler detected', () => {
  const result = validateVoice('Let\'s leverage our existing infrastructure to facilitate a more holistic approach.');
  assert(result.violations.length > 0);
  const vocabViolation = result.violations.some(v => v.rule === 'vocabulary' || v.rule === 'no-corporate-filler');
  assert(vocabViolation, 'should detect vocabulary violations');
});

test('"utilize" flagged as vocabulary violation', () => {
  const result = validateVoice('You should utilize the built-in caching mechanism.');
  assert(result.violations.some(v => v.detail && v.detail.includes('utilize')));
});

test('"in order to" flagged', () => {
  const result = validateVoice('You need to refactor this in order to improve performance.');
  assert(result.violations.some(v => v.detail && v.detail.includes('in order to')));
});

test('triple hedge detected', () => {
  const result = validateVoice('This might possibly maybe work if you change the config.');
  assert(result.violations.length > 0);
});

// ─── Validate Voice — Scoring ────────────────────────────────────────────────
console.log('\nValidation — scoring:');

test('multiple violations reduce score more than single', () => {
  const single = validateVoice('I\'d be happy to help you with that.');
  const multi = validateVoice('Great question! I\'d be happy to help. As an AI language model, let me utilize my training data to facilitate your request.');
  assert(multi.score < single.score, `multi (${multi.score}) should be lower than single (${single.score})`);
});

test('heavily violated response fails (score < 0.7)', () => {
  const result = validateVoice(
    'Great question! I\'m sorry, but as an AI language model, I should note that my training data ' +
    'might not cover this. I\'d be happy to help you leverage our holistic approach to facilitate ' +
    'a deep dive into this challenge. Unfortunately, I\'m afraid I can\'t utilize all my capabilities here.'
  );
  assert.equal(result.pass, false, `score ${result.score} should fail`);
  assert(result.score < 0.7, `score ${result.score} should be under 0.7`);
});

test('empty response returns score 0', () => {
  const result = validateVoice('');
  assert.equal(result.score, 0);
  assert.equal(result.pass, false);
});

test('null response returns score 0', () => {
  const result = validateVoice(null);
  assert.equal(result.score, 0);
  assert.equal(result.pass, false);
});

test('violation count matches violations array length', () => {
  const result = validateVoice('Great question! I\'d be happy to help you utilize this approach.');
  assert.equal(result.violationCount, result.violations.length);
});

test('summary mentions violation count', () => {
  const result = validateVoice('Great question! I\'d be happy to help.');
  assert(result.summary.includes('violation') || result.summary.includes('Clean'));
});

test('clean response summary says "Clean"', () => {
  const result = validateVoice('Your state is stale because the closure captured the old value.');
  assert(result.summary.includes('Clean'), `expected "Clean" in: "${result.summary}"`);
});

// ─── Validate Voice — Edge Cases ─────────────────────────────────────────────
console.log('\nValidation — edge cases:');

test('code containing banned words in strings is still flagged', () => {
  // This is intentional — we validate the full response text
  // The normalizer should only modify prose, not code blocks
  // But validation runs on raw text for safety
  const result = validateVoice('Here\'s the fix: utilize the cache.');
  assert(result.violations.some(v => v.detail && v.detail.includes('utilize')));
});

test('long clean response still passes', () => {
  const long = 'The issue is your state management. '.repeat(20) + 'Fix it by lifting state up.';
  const result = validateVoice(long);
  assert.equal(result.pass, true);
});

test('response with only code block passes', () => {
  const result = validateVoice('```js\nconst x = 1;\nconst y = 2;\nconsole.log(x + y);\n```');
  assert.equal(result.pass, true);
});

// ─── Module Shape ────────────────────────────────────────────────────────────
console.log('\nModule shape:');

test('exports IDENTITY object', () => assert(IDENTITY && typeof IDENTITY === 'object'));
test('exports TONE_RULES array', () => assert(Array.isArray(TONE_RULES)));
test('exports VOCABULARY object', () => assert(VOCABULARY && typeof VOCABULARY === 'object'));
test('exports STRUCTURE object', () => assert(STRUCTURE && typeof STRUCTURE === 'object'));
test('exports BANNED_PATTERNS array', () => assert(Array.isArray(BANNED_PATTERNS)));
test('exports generateSystemPrompt function', () => assert(typeof generateSystemPrompt === 'function'));
test('exports generateNormalizerPrompt function', () => assert(typeof generateNormalizerPrompt === 'function'));
test('exports validateVoice function', () => assert(typeof validateVoice === 'function'));

// ─── Results ─────────────────────────────────────────────────────────────────
console.log(`\n─── Results: ${passed} passed, ${failed} failed ───`);
if (failed > 0) process.exit(1);
