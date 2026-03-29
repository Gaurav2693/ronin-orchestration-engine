// ─── middleware/directorGate.test.mjs ────────────────────────────────────────
// Test suite for M3 RONIN Director Gate
// Target: 30+ tests, 0 failures
// Run: node directorGate.test.mjs 2>&1
// ─────────────────────────────────────────────────────────────────────────────

import {
  createDirectorGate,
  isDirectorInvocation,
  buildConsultantBrief,
  wrapDirectorResponse,
} from './directorGate.mjs';

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

// ─── Tests: isDirectorInvocation ────────────────────────────────────────

console.log('\n── isDirectorInvocation: Commands ──');

test('/director triggers', () => {
  const r = isDirectorInvocation('/director what do you think about this layout?');
  assertEqual(r.isDirector, true);
  assertEqual(r.trigger, 'command');
  assertEqual(r.query, 'what do you think about this layout?');
});

test('/opus triggers', () => {
  const r = isDirectorInvocation('/opus review my design');
  assertEqual(r.isDirector, true);
  assertEqual(r.trigger, 'command');
});

test('/creative triggers', () => {
  const r = isDirectorInvocation('/creative suggest a color palette');
  assertEqual(r.isDirector, true);
});

test('command is case-insensitive', () => {
  assertEqual(isDirectorInvocation('/DIRECTOR test').isDirector, true);
  assertEqual(isDirectorInvocation('/Director test').isDirector, true);
});

console.log('\n── isDirectorInvocation: Phrases ──');

test('"get the director\'s take" triggers', () => {
  const r = isDirectorInvocation('get the director\'s take on this approach');
  assertEqual(r.isDirector, true);
  assertEqual(r.trigger, 'phrase');
});

test('"what would the director say" triggers', () => {
  assertEqual(isDirectorInvocation('what would the director say about this?').isDirector, true);
});

test('"ask the creative director" triggers', () => {
  assertEqual(isDirectorInvocation('ask the creative director about spacing').isDirector, true);
});

test('"second opinion on this" triggers', () => {
  assertEqual(isDirectorInvocation('I need a second opinion on this design').isDirector, true);
});

test('"director, what should we do" triggers', () => {
  assertEqual(isDirectorInvocation('director, what should we do here?').isDirector, true);
});

test('"want the director\'s thoughts" triggers', () => {
  assertEqual(isDirectorInvocation('I want the director\'s thoughts on the layout').isDirector, true);
});

console.log('\n── isDirectorInvocation: Non-triggers ──');

test('normal message does not trigger', () => {
  assertEqual(isDirectorInvocation('Write a React component').isDirector, false);
});

test('empty message does not trigger', () => {
  assertEqual(isDirectorInvocation('').isDirector, false);
});

test('null does not trigger', () => {
  assertEqual(isDirectorInvocation(null).isDirector, false);
});

test('"the director" in unrelated context does not trigger', () => {
  assertEqual(isDirectorInvocation('the film director made a great movie').isDirector, false);
});

// ─── Tests: buildConsultantBrief ────────────────────────────────────────

console.log('\n── buildConsultantBrief ──');

test('includes query in brief', () => {
  const brief = buildConsultantBrief('Is this spacing too tight?');
  assert(brief.includes('Is this spacing too tight?'));
  assert(brief.includes('Operator Query'));
});

test('includes Creative Director identity', () => {
  const brief = buildConsultantBrief('test');
  assert(brief.includes('Creative Director'));
});

test('includes taste narrative when available', () => {
  const brief = buildConsultantBrief('test', { taste_narrative: 'Prefers warm colors.' });
  assert(brief.includes('Prefers warm colors.'));
  assert(brief.includes('Operator Taste Profile'));
});

test('includes project context', () => {
  const brief = buildConsultantBrief('test', { project: 'RONIN Dashboard' });
  assert(brief.includes('RONIN Dashboard'));
});

test('includes current gate', () => {
  const brief = buildConsultantBrief('test', { current_gate: 'Gate 03: Design' });
  assert(brief.includes('Gate 03: Design'));
});

test('includes conversation summary', () => {
  const brief = buildConsultantBrief('test', { conversation_summary: 'User asked about button design.' });
  assert(brief.includes('button design'));
});

test('minimal brief works without context', () => {
  const brief = buildConsultantBrief('simple question');
  assert(brief.includes('simple question'));
  assert(!brief.includes('Operator Taste Profile'));
});

// ─── Tests: wrapDirectorResponse ────────────────────────────────────────

console.log('\n── wrapDirectorResponse ──');

test('wraps valid response', () => {
  const r = wrapDirectorResponse('The spacing is too tight. Use 16px.');
  assertEqual(r.content, 'The spacing is too tight. Use 16px.');
  assertEqual(r.source, 'director');
  assertEqual(r.model_hidden, true);
});

test('handles null response', () => {
  const r = wrapDirectorResponse(null);
  assertEqual(r.source, 'director');
  assert(r.content.length > 0);
});

test('handles empty response', () => {
  const r = wrapDirectorResponse('');
  assertEqual(r.source, 'director');
  assert(r.content.length > 0);
});

test('model identity is always hidden', () => {
  const r = wrapDirectorResponse('I am Claude Opus...');
  assertEqual(r.model_hidden, true);
});

// ─── Tests: createDirectorGate (middleware) ──────────────────────────────

console.log('\n── createDirectorGate (middleware) ──');

await test('creates middleware function', async () => {
  const mw = createDirectorGate();
  assertEqual(typeof mw, 'function');
});

await test('passes through normal messages', async () => {
  const mw = createDirectorGate();
  const request = { message: 'Write a function.', system_prompt: 'You are RONIN.' };
  const result = await mw(request, (req) => ({ ...req, passed: true }));
  assertEqual(result.passed, true);
  assertEqual(result.message, 'Write a function.');
});

await test('short-circuits on /director command', async () => {
  const mockOpus = async (prompt) => 'The Director says: use more whitespace.';
  const mw = createDirectorGate(mockOpus);
  const request = { message: '/director review my layout' };
  const result = await mw(request, () => { throw new Error('Should not reach next'); });
  assertEqual(result._director_invoked, true);
  assert(result.content.includes('whitespace'));
  assertEqual(result.source, 'director');
});

await test('short-circuits on phrase trigger', async () => {
  const mockOpus = async () => 'Director opinion here.';
  const mw = createDirectorGate(mockOpus);
  const request = { message: 'get the director\'s take on this button style' };
  const result = await mw(request);
  assertEqual(result._director_invoked, true);
  assertEqual(result._director_trigger, 'phrase');
});

await test('returns unavailable when no provider', async () => {
  const mw = createDirectorGate(null);
  const result = await mw({ message: '/director test' });
  assertEqual(result._director_invoked, true);
  assertEqual(result._director_available, false);
  assert(result.content.includes('unavailable'));
});

await test('handles provider error gracefully', async () => {
  const mockOpus = async () => { throw new Error('API rate limit'); };
  const mw = createDirectorGate(mockOpus);
  const result = await mw({ message: '/director test' });
  assertEqual(result._director_invoked, true);
  assert(result._director_error.includes('rate limit'));
});

await test('tracks metrics — invocations vs passthroughs', async () => {
  const mockOpus = async () => 'OK';
  const mw = createDirectorGate(mockOpus);
  const next = (req) => req;

  await mw({ message: 'normal message' }, next);
  await mw({ message: 'another normal one' }, next);
  await mw({ message: '/director review this' });

  const m = mw.getMetrics();
  assertEqual(m.directorPassthroughs, 2);
  assertEqual(m.directorInvocations, 1);
});

await test('tracks cost estimate', async () => {
  const mockOpus = async () => 'A response from the Director.';
  const mw = createDirectorGate(mockOpus);
  await mw({ message: '/director review this design' });
  assert(mw.getMetrics().totalCost > 0);
});

await test('tracks duration', async () => {
  const mockOpus = async () => { await new Promise(r => setTimeout(r, 10)); return 'Delayed response.'; };
  const mw = createDirectorGate(mockOpus);
  const result = await mw({ message: '/director test' });
  assert(result._director_duration >= 5);
});

await test('passes taste context to brief', async () => {
  let capturedPrompt = '';
  const mockOpus = async (prompt) => { capturedPrompt = prompt; return 'OK'; };
  const mw = createDirectorGate(mockOpus);
  await mw({ message: '/director review', _taste_narrative: 'Likes bold type.' });
  assert(capturedPrompt.includes('bold type'));
});

// ─── Summary ─────────────────────────────────────────────────────────────

await new Promise(r => setTimeout(r, 50));

console.log(`\n${'─'.repeat(60)}`);
console.log(`M3 directorGate: ${passCount}/${testCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
