// ─── gateway/middleware/responseFormatter.test.mjs ────────────────────────────
// Test suite for G4 Response Formatter — Middleware #13
// Target: 40+ tests, 0 failures
// Run: node responseFormatter.test.mjs 2>&1
// ─────────────────────────────────────────────────────────────────────────────

import {
  createResponseFormatter,
  formatForSurface,
  formatFull,
  formatText,
  formatMinimal,
  formatStatus,
  formatVoice,
  enforceTokenLimit,
} from './responseFormatter.mjs';

// ─── Test utilities ──────────────────────────────────────────────────────

let testCount = 0;
let passCount = 0;
let failCount = 0;

function test(name, fn) {
  testCount++;
  try {
    fn();
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

// ─── Mock responses ──────────────────────────────────────────────────────

const RESPONSE_WITH_ARTIFACTS = {
  content: 'Here is the component:\n\n```artifact\n<div>Hello</div>\n```\n\nAnd a reference: [artifact:LoginForm](https://artifacts.ronin/abc123)\n\nDone.',
  artifacts: [{ id: 'abc123', type: 'html' }],
  suggestions: ['Add tests', 'Refactor'],
};

const SIMPLE_RESPONSE = {
  content: 'The answer is 42. This is a straightforward response.',
  artifacts: [],
  suggestions: ['Follow up'],
};

const LONG_RESPONSE = {
  content: 'A'.repeat(5000),
  artifacts: [],
  suggestions: [],
};

// ─── Tests: formatFull ───────────────────────────────────────────────────

console.log('\n── formatFull ──');

test('formatFull preserves content unchanged', () => {
  const result = formatFull(RESPONSE_WITH_ARTIFACTS, { response_mode: 'full' });
  assertEqual(result.formatted, RESPONSE_WITH_ARTIFACTS.content);
  assertEqual(result.format, 'full');
});

test('formatFull preserves artifacts', () => {
  const result = formatFull(RESPONSE_WITH_ARTIFACTS, {});
  assertEqual(result.artifacts.length, 1);
  assertEqual(result.artifacts[0].id, 'abc123');
});

test('formatFull preserves suggestions', () => {
  const result = formatFull(RESPONSE_WITH_ARTIFACTS, {});
  assertEqual(result.suggestions.length, 2);
});

// ─── Tests: formatText ───────────────────────────────────────────────────

console.log('\n── formatText ──');

test('formatText strips artifact blocks', () => {
  const result = formatText(RESPONSE_WITH_ARTIFACTS, {});
  assert(!result.formatted.includes('```artifact'));
  assert(!result.formatted.includes('<div>Hello</div>'));
});

test('formatText converts artifact refs to plain text', () => {
  const result = formatText(RESPONSE_WITH_ARTIFACTS, {});
  assert(result.formatted.includes('LoginForm'));
  assert(!result.formatted.includes('https://artifacts.ronin'));
});

test('formatText clears artifacts array', () => {
  const result = formatText(RESPONSE_WITH_ARTIFACTS, {});
  assertEqual(result.artifacts.length, 0);
});

test('formatText preserves suggestions', () => {
  const result = formatText(RESPONSE_WITH_ARTIFACTS, {});
  assertEqual(result.suggestions.length, 2);
});

test('formatText format is "text"', () => {
  assertEqual(formatText(SIMPLE_RESPONSE, {}).format, 'text');
});

// ─── Tests: formatMinimal ────────────────────────────────────────────────

console.log('\n── formatMinimal ──');

test('formatMinimal takes first paragraph only', () => {
  const response = { content: 'First paragraph.\n\nSecond paragraph.\n\nThird.', artifacts: [] };
  const result = formatMinimal(response, { max_tokens: 100 });
  assertEqual(result.formatted, 'First paragraph.');
});

test('formatMinimal strips artifacts', () => {
  const result = formatMinimal(RESPONSE_WITH_ARTIFACTS, { max_tokens: 200 });
  assert(!result.formatted.includes('artifact'));
});

test('formatMinimal truncates to max_tokens limit', () => {
  const result = formatMinimal({ content: 'A'.repeat(1000), artifacts: [] }, { max_tokens: 10 });
  assert(result.formatted.length <= 41); // 10*4=40 + truncation char
  assert(result.formatted.endsWith('…'));
});

test('formatMinimal empties suggestions', () => {
  assertEqual(formatMinimal(SIMPLE_RESPONSE, {}).suggestions.length, 0);
});

test('formatMinimal format is "minimal"', () => {
  assertEqual(formatMinimal(SIMPLE_RESPONSE, {}).format, 'minimal');
});

// ─── Tests: formatStatus ─────────────────────────────────────────────────

console.log('\n── formatStatus ──');

test('formatStatus takes first sentence', () => {
  const result = formatStatus(SIMPLE_RESPONSE, {});
  assertEqual(result.formatted, 'The answer is 42.');
});

test('formatStatus strips markdown', () => {
  const response = { content: '**Bold** and _italic_ and `code`', artifacts: [] };
  const result = formatStatus(response, {});
  assert(!result.formatted.includes('*'));
  assert(!result.formatted.includes('_'));
  assert(!result.formatted.includes('`'));
});

test('formatStatus respects max_tokens', () => {
  const response = { content: 'A'.repeat(500) + '.', artifacts: [] };
  const result = formatStatus(response, { max_tokens: 5 });
  assert(result.formatted.length <= 21); // 5*4=20 + truncation
});

test('formatStatus format is "status"', () => {
  assertEqual(formatStatus(SIMPLE_RESPONSE, {}).format, 'status');
});

// ─── Tests: formatVoice ──────────────────────────────────────────────────

console.log('\n── formatVoice ──');

test('formatVoice wraps in <speak> tags', () => {
  const result = formatVoice(SIMPLE_RESPONSE, {});
  assert(result.formatted.startsWith('<speak>'));
  assert(result.formatted.endsWith('</speak>'));
});

test('formatVoice strips artifacts', () => {
  const result = formatVoice(RESPONSE_WITH_ARTIFACTS, {});
  assert(!result.formatted.includes('```artifact'));
});

test('formatVoice strips markdown formatting', () => {
  const response = { content: '**bold** _italic_ `code`', artifacts: [] };
  const result = formatVoice(response, {});
  assert(!result.formatted.includes('*'));
  assert(!result.formatted.includes('_'));
});

test('formatVoice respects max_tokens', () => {
  const result = formatVoice(LONG_RESPONSE, { max_tokens: 10 });
  // 10*4=40 chars + <speak></speak> (15) + truncation
  assert(result.formatted.length < 70);
});

test('formatVoice format is "voice"', () => {
  assertEqual(formatVoice(SIMPLE_RESPONSE, {}).format, 'voice');
});

// ─── Tests: formatForSurface (router) ────────────────────────────────────

console.log('\n── formatForSurface ──');

test('routes to full for macOS', () => {
  const result = formatForSurface(SIMPLE_RESPONSE, {
    response_mode: 'full', voice_markup: false, artifacts_enabled: true,
  });
  assertEqual(result.format, 'full');
});

test('routes to text for CLI', () => {
  const result = formatForSurface(SIMPLE_RESPONSE, {
    response_mode: 'text', voice_markup: false,
  });
  assertEqual(result.format, 'text');
});

test('routes to minimal for watchOS', () => {
  const result = formatForSurface(SIMPLE_RESPONSE, {
    response_mode: 'minimal', voice_markup: false,
  });
  assertEqual(result.format, 'minimal');
});

test('routes to status for ambient', () => {
  const result = formatForSurface(SIMPLE_RESPONSE, {
    response_mode: 'status', voice_markup: false,
  });
  assertEqual(result.format, 'status');
});

test('voice_markup overrides response_mode', () => {
  const result = formatForSurface(SIMPLE_RESPONSE, {
    response_mode: 'text', voice_markup: true,
  });
  assertEqual(result.format, 'voice');
});

test('null response returns empty text format', () => {
  const result = formatForSurface(null, { response_mode: 'full' });
  assertEqual(result.formatted, '');
  assertEqual(result.format, 'text');
});

test('string response is normalized', () => {
  const result = formatForSurface('Hello RONIN', { response_mode: 'full' });
  assertEqual(result.formatted, 'Hello RONIN');
});

test('null surfaceContext defaults to text', () => {
  const result = formatForSurface(SIMPLE_RESPONSE, null);
  assertEqual(result.format, 'text');
});

// ─── Tests: Middleware Factory ────────────────────────────────────────────

console.log('\n── Middleware Factory ──');

test('createResponseFormatter returns a function', () => {
  const formatter = createResponseFormatter(null);
  assert(typeof formatter === 'function');
});

test('middleware formats based on request.surface', () => {
  const formatter = createResponseFormatter(null);
  const result = formatter(
    { device_id: 'dev_1', surface: { response_mode: 'status', voice_markup: false } },
    SIMPLE_RESPONSE
  );
  assertEqual(result.format, 'status');
});

test('middleware attaches _meta', () => {
  const formatter = createResponseFormatter(null);
  const result = formatter(
    { device_id: 'dev_1', session_id: 'ses_1', surface: { response_mode: 'full' } },
    SIMPLE_RESPONSE
  );
  assertEqual(result._meta.device_id, 'dev_1');
  assertEqual(result._meta.session_id, 'ses_1');
  assert(typeof result._meta.original_length === 'number');
  assert(typeof result._meta.formatted_length === 'number');
});

test('middleware handles missing surface context', () => {
  const formatter = createResponseFormatter(null);
  const result = formatter({ device_id: 'dev_1' }, SIMPLE_RESPONSE);
  assertEqual(result.format, 'text');
});

// ─── Tests: enforceTokenLimit ────────────────────────────────────────────

console.log('\n── enforceTokenLimit ──');

test('returns text unchanged if under limit', () => {
  assertEqual(enforceTokenLimit('hello', 100), 'hello');
});

test('truncates text over limit', () => {
  const result = enforceTokenLimit('A'.repeat(500), 10);
  assertEqual(result.length, 41); // 40 + …
  assert(result.endsWith('…'));
});

test('returns text unchanged for null limit', () => {
  assertEqual(enforceTokenLimit('hello', null), 'hello');
});

test('returns text unchanged for 0 limit', () => {
  assertEqual(enforceTokenLimit('hello', 0), 'hello');
});

// ─── Summary ─────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`G4 responseFormatter: ${passCount}/${testCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
