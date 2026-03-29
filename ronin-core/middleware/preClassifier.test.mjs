// ─── middleware/preClassifier.test.mjs ───────────────────────────────────────
// Test suite for M2 RONIN Pre-Classifier
// Target: 50+ tests, 0 failures
// Run: node preClassifier.test.mjs 2>&1
// ─────────────────────────────────────────────────────────────────────────────

import {
  createPreClassifier,
  classifyHeuristic,
  classifyWithLLM,
  classify,
  buildClassificationPrompt,
  parseClassificationResponse,
  URGENCY,
  MODALITY,
  COMPLEXITY,
  WORKER,
} from './preClassifier.mjs';

// ─── Test utilities ──────────────────────────────────────────────────────

let testCount = 0;
let passCount = 0;
let failCount = 0;

function test(name, fn) {
  testCount++;
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(() => {
        passCount++;
        console.log(`✓ ${name}`);
      }).catch(error => {
        failCount++;
        console.error(`✗ ${name}`);
        console.error(`  ${error.message}`);
      });
    }
    passCount++;
    console.log(`✓ ${name}`);
  } catch (error) {
    failCount++;
    console.error(`✗ ${name}`);
    console.error(`  ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ─── Tests: Enums ───────────────────────────────────────────────────────

console.log('\n── Enums ──');

test('URGENCY has 3 levels', () => {
  assertEqual(Object.keys(URGENCY).length, 3);
});

test('MODALITY has 5 types', () => {
  assertEqual(Object.keys(MODALITY).length, 5);
});

test('COMPLEXITY has 4 levels', () => {
  assertEqual(Object.keys(COMPLEXITY).length, 4);
});

test('WORKER has 6 types', () => {
  assertEqual(Object.keys(WORKER).length, 6);
});

test('enums are frozen', () => {
  assert(Object.isFrozen(URGENCY));
  assert(Object.isFrozen(MODALITY));
  assert(Object.isFrozen(COMPLEXITY));
  assert(Object.isFrozen(WORKER));
});

// ─── Tests: Heuristic — Trivial ─────────────────────────────────────────

console.log('\n── Heuristic: Trivial ──');

test('"hello" → trivial/text/fast', () => {
  const r = classifyHeuristic('hello');
  assertEqual(r.complexity, COMPLEXITY.TRIVIAL);
  assertEqual(r.modality, MODALITY.TEXT);
  assertEqual(r.suggestedWorker, WORKER.FAST);
});

test('"hi!" → trivial', () => {
  assertEqual(classifyHeuristic('hi!').complexity, COMPLEXITY.TRIVIAL);
});

test('"thanks" → trivial', () => {
  assertEqual(classifyHeuristic('thanks').complexity, COMPLEXITY.TRIVIAL);
});

test('"what time is it?" → trivial', () => {
  const r = classifyHeuristic("what's the time?");
  assertEqual(r.complexity, COMPLEXITY.TRIVIAL);
  assertEqual(r.suggestedWorker, WORKER.FAST);
});

test('"/status" → trivial', () => {
  assertEqual(classifyHeuristic('/status').complexity, COMPLEXITY.TRIVIAL);
});

test('empty message → trivial', () => {
  const r = classifyHeuristic('');
  assertEqual(r.complexity, COMPLEXITY.TRIVIAL);
  assertEqual(r.reason, 'empty_or_invalid_input');
});

test('null message → trivial', () => {
  const r = classifyHeuristic(null);
  assertEqual(r.complexity, COMPLEXITY.TRIVIAL);
});

test('short text under 50 chars → trivial/fast', () => {
  const r = classifyHeuristic('What is RONIN?');
  assertEqual(r.complexity, COMPLEXITY.TRIVIAL);
  assertEqual(r.suggestedWorker, WORKER.FAST);
});

// ─── Tests: Heuristic — Vision ──────────────────────────────────────────

console.log('\n── Heuristic: Vision ──');

test('"analyze this screenshot" → vision', () => {
  const r = classifyHeuristic('analyze this screenshot');
  assertEqual(r.modality, MODALITY.VISION);
  assertEqual(r.suggestedWorker, WORKER.VISION);
});

test('"look at the Figma frame" → vision', () => {
  const r = classifyHeuristic('look at the Figma frame');
  assertEqual(r.suggestedWorker, WORKER.VISION);
});

test('image attachment → vision with high confidence', () => {
  const r = classifyHeuristic('What is this?', { has_image: true });
  assertEqual(r.modality, MODALITY.VISION);
  assertEqual(r.confidence, 0.95);
});

test('screenshot context → vision', () => {
  const r = classifyHeuristic('Describe this', { has_screenshot: true });
  assertEqual(r.suggestedWorker, WORKER.VISION);
});

test('vision + code → mixed modality', () => {
  const r = classifyHeuristic('Analyze this screenshot and write a React component for it');
  assertEqual(r.modality, MODALITY.MIXED);
});

// ─── Tests: Heuristic — Code ────────────────────────────────────────────

console.log('\n── Heuristic: Code ──');

test('"write a function to sort arrays" → code', () => {
  const r = classifyHeuristic('write a function to sort arrays');
  assertEqual(r.modality, MODALITY.CODE);
});

test('"create a React component for login" → code', () => {
  const r = classifyHeuristic('create a React component for login');
  assertEqual(r.modality, MODALITY.CODE);
});

test('"fix the debug test file" → code', () => {
  const r = classifyHeuristic('fix the debug test file');
  assertEqual(r.modality, MODALITY.CODE);
});

test('code block in message → code', () => {
  const r = classifyHeuristic('Fix this:\n```\nconst x = 1;\n```');
  assertEqual(r.modality, MODALITY.CODE);
});

test('"refactor the auth module" → code', () => {
  const r = classifyHeuristic('refactor the auth module');
  assertEqual(r.modality, MODALITY.CODE);
});

// ─── Tests: Heuristic — Agent ───────────────────────────────────────────

console.log('\n── Heuristic: Agent ──');

test('"restructure all files in the project" → agent', () => {
  const r = classifyHeuristic('restructure all files in the project');
  assertEqual(r.suggestedWorker, WORKER.AGENT);
  assertEqual(r.complexity, COMPLEXITY.COMPLEX);
});

test('"set up the project from scratch" → agent', () => {
  const r = classifyHeuristic('set up the project environment from scratch');
  assertEqual(r.suggestedWorker, WORKER.AGENT);
});

test('"migrate across multiple modules" → agent', () => {
  const r = classifyHeuristic('migrate the data layer across multiple modules');
  assertEqual(r.suggestedWorker, WORKER.AGENT);
});

// ─── Tests: Heuristic — Deep ────────────────────────────────────────────

console.log('\n── Heuristic: Deep ──');

test('"/deep analyze the architecture" → deep', () => {
  const r = classifyHeuristic('/deep analyze the architecture');
  assertEqual(r.suggestedWorker, WORKER.DEEP);
  assertEqual(r.complexity, COMPLEXITY.DEEP);
  assertEqual(r.confidence, 0.99);
});

test('"think deeply about trade-offs" → deep', () => {
  const r = classifyHeuristic('think deeply about the trade-offs here');
  assertEqual(r.suggestedWorker, WORKER.DEEP);
});

test('"evaluate the architecture decisions" → deep', () => {
  const r = classifyHeuristic('what are the implications of this architecture approach?');
  assertEqual(r.suggestedWorker, WORKER.DEEP);
});

// ─── Tests: Heuristic — Urgency ─────────────────────────────────────────

console.log('\n── Heuristic: Urgency ──');

test('"production is down" → high urgency', () => {
  const r = classifyHeuristic('production is down, fix it now');
  assertEqual(r.urgency, URGENCY.HIGH);
});

test('"urgent fix needed" → high urgency', () => {
  const r = classifyHeuristic('urgent: the deployment is broken, we need to rollback');
  assertEqual(r.urgency, URGENCY.HIGH);
});

test('"fix the crash immediately" → high urgency', () => {
  const r = classifyHeuristic('fix the crash immediately please');
  assertEqual(r.urgency, URGENCY.HIGH);
});

// ─── Tests: Heuristic — Uncertain ───────────────────────────────────────

console.log('\n── Heuristic: Uncertain ──');

test('long ambiguous message → null (needs LLM)', () => {
  const msg = 'I was thinking about the overall approach we should take for the upcoming quarter, considering the various factors at play and the team dynamics we need to navigate carefully.';
  const r = classifyHeuristic(msg);
  assertEqual(r, null);
});

// ─── Tests: LLM Classifier ─────────────────────────────────────────────

console.log('\n── LLM Classifier ──');

await test('classifyWithLLM returns fallback when no provider', async () => {
  const r = await classifyWithLLM('test', {}, null);
  assertEqual(r.method, 'fallback');
  assertEqual(r.reason, 'no_provider_available');
});

await test('classifyWithLLM parses valid LLM response', async () => {
  const mockProvider = async () => '{"urgency":"high","modality":"code","complexity":"complex","suggestedWorker":"codex","reason":"code rewrite task"}';
  const r = await classifyWithLLM('rewrite the module', {}, mockProvider);
  assertEqual(r.urgency, 'high');
  assertEqual(r.modality, 'code');
  assertEqual(r.complexity, 'complex');
  assertEqual(r.suggestedWorker, 'codex');
  assertEqual(r.method, 'llm');
});

await test('classifyWithLLM handles provider error', async () => {
  const mockProvider = async () => { throw new Error('Rate limited'); };
  const r = await classifyWithLLM('test', {}, mockProvider);
  assertEqual(r.method, 'fallback');
  assert(r.reason.includes('Rate limited'));
});

// ─── Tests: parseClassificationResponse ─────────────────────────────────

console.log('\n── parseClassificationResponse ──');

test('parses valid JSON response', () => {
  const r = parseClassificationResponse('{"urgency":"low","modality":"text","complexity":"trivial","suggestedWorker":"fast","reason":"simple query"}');
  assertEqual(r.urgency, 'low');
  assertEqual(r.modality, 'text');
  assertEqual(r.confidence, 0.8);
  assertEqual(r.method, 'llm');
});

test('extracts JSON from text with extra content', () => {
  const r = parseClassificationResponse('Here is my classification: {"urgency":"medium","modality":"code","complexity":"standard","suggestedWorker":"agent","reason":"test"}');
  assertEqual(r.urgency, 'medium');
  assertEqual(r.modality, 'code');
});

test('returns defaults for invalid JSON', () => {
  const r = parseClassificationResponse('not json at all');
  assertEqual(r.method, 'fallback');
  assertEqual(r.reason, 'parse_failed');
});

test('returns defaults for null response', () => {
  const r = parseClassificationResponse(null);
  assertEqual(r.method, 'fallback');
});

test('validates enum values — rejects invalid urgency', () => {
  const r = parseClassificationResponse('{"urgency":"extreme","modality":"text","complexity":"trivial","suggestedWorker":"fast"}');
  assertEqual(r.urgency, 'medium'); // defaults
});

test('validates enum values — rejects invalid worker', () => {
  const r = parseClassificationResponse('{"urgency":"low","modality":"text","complexity":"trivial","suggestedWorker":"super_worker"}');
  assertEqual(r.suggestedWorker, 'fast'); // defaults
});

// ─── Tests: buildClassificationPrompt ───────────────────────────────────

console.log('\n── buildClassificationPrompt ──');

test('includes message in prompt', () => {
  const prompt = buildClassificationPrompt('Write a function');
  assert(prompt.includes('Write a function'));
});

test('includes image context when present', () => {
  const prompt = buildClassificationPrompt('What is this?', { has_image: true });
  assert(prompt.includes('Image attached'));
});

test('includes surface context when present', () => {
  const prompt = buildClassificationPrompt('Hello', { surface: 'watchos' });
  assert(prompt.includes('watchos'));
});

// ─── Tests: classify (combined) ─────────────────────────────────────────

console.log('\n── classify (combined) ──');

await test('uses heuristic for trivial messages', async () => {
  const r = await classify('hello');
  assertEqual(r.method, 'heuristic');
  assertEqual(r.complexity, 'trivial');
});

await test('falls back to LLM for ambiguous messages', async () => {
  const mockProvider = async () => '{"urgency":"medium","modality":"text","complexity":"standard","suggestedWorker":"fast","reason":"general discussion"}';
  const msg = 'I was thinking about the overall approach we should take for the upcoming quarter, considering the various factors at play and the team dynamics we need to navigate carefully.';
  const r = await classify(msg, {}, mockProvider);
  assertEqual(r.method, 'llm');
});

await test('falls back to defaults when LLM unavailable for ambiguous', async () => {
  const msg = 'I was thinking about the overall approach we should take for the upcoming quarter, considering the various factors at play and the team dynamics we need to navigate carefully.';
  const r = await classify(msg, {}, null);
  assertEqual(r.method, 'fallback');
});

// ─── Tests: createPreClassifier (middleware) ─────────────────────────────

console.log('\n── createPreClassifier (middleware) ──');

await test('creates middleware function', async () => {
  const mw = createPreClassifier();
  assertEqual(typeof mw, 'function');
});

await test('enriches request with classification', async () => {
  const mw = createPreClassifier();
  const request = { message: 'hello', system_prompt: 'You are RONIN.' };
  const result = await mw(request, (req) => req);
  assertEqual(result._pre_classified, true);
  assert(result.classification !== undefined);
  assertEqual(result.classification.complexity, 'trivial');
});

await test('preserves original request fields', async () => {
  const mw = createPreClassifier();
  const request = { message: 'hi', system_prompt: 'Base.', custom_field: 42 };
  const result = await mw(request, (req) => req);
  assertEqual(result.custom_field, 42);
  assertEqual(result.system_prompt, 'Base.');
});

await test('tracks metrics', async () => {
  const mw = createPreClassifier();
  const next = (req) => req;
  await mw({ message: 'hello' }, next);
  await mw({ message: 'write a function to sort' }, next);
  await mw({ message: 'analyze this screenshot' }, next);

  const metrics = mw.getMetrics();
  assertEqual(metrics.totalClassifications, 3);
  assertEqual(metrics.heuristicClassifications, 3);
});

await test('tracks worker distribution', async () => {
  const mw = createPreClassifier();
  const next = (req) => req;
  await mw({ message: 'hello' }, next);
  await mw({ message: 'hello' }, next);
  await mw({ message: 'analyze this screenshot' }, next);

  const dist = mw.getMetrics().workerDistribution;
  assertEqual(dist.fast, 2);
  assertEqual(dist.vision, 1);
});

await test('uses content field as fallback for message', async () => {
  const mw = createPreClassifier();
  const result = await mw({ content: 'hello' }, (req) => req);
  assertEqual(result.classification.complexity, 'trivial');
});

await test('detects image attachments in request', async () => {
  const mw = createPreClassifier();
  const result = await mw({
    message: 'What is this?',
    attachments: [{ type: 'image', url: 'test.png' }],
  }, (req) => req);
  assertEqual(result.classification.suggestedWorker, 'vision');
});

await test('returns enriched request when no next function', async () => {
  const mw = createPreClassifier();
  const result = await mw({ message: 'hello' });
  assertEqual(result._pre_classified, true);
});

await test('uses LLM provider when heuristic uncertain', async () => {
  const mockProvider = async () => '{"urgency":"medium","modality":"text","complexity":"standard","suggestedWorker":"fast","reason":"general query"}';
  const mw = createPreClassifier(mockProvider);
  const msg = 'I was thinking about the overall approach we should take for the upcoming quarter, considering the various factors at play and the team dynamics we need to navigate carefully.';
  const result = await mw({ message: msg }, (req) => req);
  assertEqual(result.classification.method, 'llm');
  assertEqual(mw.getMetrics().llmClassifications, 1);
});

// ─── Tests: Cost-First Routing Validation ───────────────────────────────

console.log('\n── Cost-First Routing ──');

await test('simple greeting → free worker (fast)', async () => {
  const r = await classify('hey there');
  assertEqual(r.suggestedWorker, WORKER.FAST);
});

await test('status check → free worker (fast)', async () => {
  const r = await classify('/ping');
  assertEqual(r.suggestedWorker, WORKER.FAST);
});

await test('vision task → free worker (vision)', async () => {
  const r = await classify('review this mockup', { has_image: true });
  assertEqual(r.suggestedWorker, WORKER.VISION);
});

await test('complex code → agent (paid, necessary)', async () => {
  const r = await classify('set up the CI/CD pipeline for the project');
  assertEqual(r.suggestedWorker, WORKER.AGENT);
});

// ─── Summary ─────────────────────────────────────────────────────────────

await new Promise(r => setTimeout(r, 50));

console.log(`\n${'─'.repeat(60)}`);
console.log(`M2 preClassifier: ${passCount}/${testCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
