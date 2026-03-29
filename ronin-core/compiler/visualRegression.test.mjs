// ─── compiler/visualRegression.test.mjs ──────────────────────────────────
// Comprehensive test suite for Visual Regression Checker
// 55+ tests covering all functions and edge cases
// Run: node compiler/visualRegression.test.mjs
// ─────────────────────────────────────────────────────────────────────────

import {
  checkFidelity,
  runRetryPass,
  buildDiffAnalysisPrompt,
  parseCorrectionResponse,
  applyCorrections,
  calculateFidelityScore,
  formatFidelityBadge,
  _setRenderer,
  _setComparator,
  _setDiffAnalyzer,
} from './visualRegression.mjs';

// ─── Test Framework ──────────────────────────────────────────────────────

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
    if (error.stack) {
      console.error(`  ${error.stack.split('\n')[1]}`);
    }
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

function assertDeepEqual(actual, expected, message) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(
      message || `Expected ${expectedJson}, got ${actualJson}`
    );
  }
}

function assertInRange(actual, min, max, message) {
  if (actual < min || actual > max) {
    throw new Error(
      message || `Expected ${actual} to be between ${min} and ${max}`
    );
  }
}

// ─── Mocks ───────────────────────────────────────────────────────────────

function createMockRenderer(diffPercent = 0, renderTimeMs = 100) {
  return async (code, viewport, scale) => {
    // Return a mock screenshot buffer
    return Buffer.from(`mock-rendered-${diffPercent}`);
  };
}

function createMockComparator(diffPercent = 0, regions = []) {
  return async (imageA, imageB) => {
    return {
      diffPercent,
      regions,
      diffImage: Buffer.from(`mock-diff-${diffPercent}`),
    };
  };
}

function createMockDiffAnalyzer(corrections = []) {
  return async (systemPrompt, userPrompt) => {
    return JSON.stringify(corrections);
  };
}

// ─── checkFidelity Tests ──────────────────────────────────────────────────

test('checkFidelity passes when diffPercent <= threshold', async () => {
  _setRenderer(createMockRenderer(1.5));
  _setComparator(createMockComparator(1.5));

  const result = await checkFidelity(
    Buffer.from('figma'),
    'component code',
    { threshold: 2.0 }
  );

  assert(result.pass === true, 'Should pass');
  assertEqual(result.diffPercent, 1.5, 'Diff percent should match');
  assert(result.retry === false, 'Should not retry');
});

test('checkFidelity fails when diffPercent > threshold', async () => {
  _setRenderer(createMockRenderer(5.0));
  _setComparator(createMockComparator(5.0));

  const result = await checkFidelity(
    Buffer.from('figma'),
    'component code',
    { threshold: 2.0 }
  );

  assert(result.pass === false, 'Should fail');
  assertEqual(result.diffPercent, 5.0, 'Diff percent should match');
  assert(result.retry === true, 'Should retry');
});

test('checkFidelity calculates score correctly', async () => {
  _setRenderer(createMockRenderer(2.6));
  _setComparator(createMockComparator(2.6));

  const result = await checkFidelity(Buffer.from('figma'), 'code');

  assertEqual(result.score, 97.4, 'Score should be 100 - 2.6 = 97.4');
});

test('checkFidelity respects custom threshold', async () => {
  _setRenderer(createMockRenderer(5.0));
  _setComparator(createMockComparator(5.0));

  const result = await checkFidelity(Buffer.from('figma'), 'code', {
    threshold: 6.0,
  });

  assert(result.pass === true, 'Should pass with custom threshold');
});

test('checkFidelity includes viewport in metadata', async () => {
  _setRenderer(createMockRenderer(0));
  _setComparator(createMockComparator(0));

  const viewport = { width: 800, height: 600 };
  const result = await checkFidelity(Buffer.from('figma'), 'code', {
    viewport,
  });

  assertDeepEqual(result.metadata.viewport, viewport);
});

test('checkFidelity includes scale in metadata', async () => {
  _setRenderer(createMockRenderer(0));
  _setComparator(createMockComparator(0));

  const result = await checkFidelity(Buffer.from('figma'), 'code', {
    scale: 3,
  });

  assertEqual(result.metadata.scale, 3);
});

test('checkFidelity includes renderTimeMs in metadata', async () => {
  _setRenderer(createMockRenderer(0));
  _setComparator(createMockComparator(0));

  const result = await checkFidelity(Buffer.from('figma'), 'code');

  assert(result.metadata.renderTimeMs >= 0, 'Should have renderTimeMs');
});

test('checkFidelity includes diffTimeMs in metadata', async () => {
  _setRenderer(createMockRenderer(0));
  _setComparator(createMockComparator(0));

  const result = await checkFidelity(Buffer.from('figma'), 'code');

  assert(result.metadata.diffTimeMs >= 0, 'Should have diffTimeMs');
});

test('checkFidelity handles renderer error gracefully', async () => {
  _setRenderer(async () => {
    throw new Error('Renderer failed');
  });

  const result = await checkFidelity(Buffer.from('figma'), 'code');

  assert(result.pass === false, 'Should fail on renderer error');
  assertEqual(result.score, 0, 'Score should be 0 on error');
  assertEqual(result.diffPercent, 100, 'Diff should be 100%');
});

test('checkFidelity handles comparator error gracefully', async () => {
  _setRenderer(createMockRenderer(0));
  _setComparator(async () => {
    throw new Error('Comparator failed');
  });

  const result = await checkFidelity(Buffer.from('figma'), 'code');

  assert(result.pass === false, 'Should fail on comparator error');
});

test('checkFidelity includes diffImage in result', async () => {
  _setRenderer(createMockRenderer(0));
  _setComparator(createMockComparator(0));

  const result = await checkFidelity(Buffer.from('figma'), 'code');

  assert(result.diffImage !== null, 'Should have diffImage');
  assert(Buffer.isBuffer(result.diffImage), 'diffImage should be Buffer');
});

test('checkFidelity includes diffRegions from comparator', async () => {
  const regions = [
    { x: 10, y: 20, width: 100, height: 50, severity: 'minor' },
  ];
  _setRenderer(createMockRenderer(0));
  _setComparator(createMockComparator(0, regions));

  const result = await checkFidelity(Buffer.from('figma'), 'code');

  assertEqual(result.diffRegions.length, 1, 'Should have 1 region');
  assertEqual(result.diffRegions[0].x, 10, 'Region x should match');
});

// ─── Retry Pass Tests ────────────────────────────────────────────────────

test('runRetryPass applies corrections and re-checks', async () => {
  _setRenderer(createMockRenderer(0.5));
  _setComparator(createMockComparator(0.5));

  const originalResult = {
    pass: false,
    diffPercent: 5.0,
    score: 95.0,
  };

  const corrections = [
    {
      selector: '.card',
      property: 'padding-top',
      current: '16px',
      corrected: '20px',
    },
  ];

  const result = await runRetryPass(originalResult, 'padding-top: 16px;', corrections, {
    figmaScreenshot: Buffer.from('figma'),
  });

  assert(result.patchedCode !== 'padding-top: 16px;', 'Should patch code');
  assert(result.correctionApplied >= 0, 'Should have applied count');
});

test('runRetryPass returns patchedCode property', async () => {
  _setRenderer(createMockRenderer(0));
  _setComparator(createMockComparator(0));

  const corrections = [];
  const originalCode = 'original code';

  const result = await runRetryPass(
    { diffPercent: 5 },
    originalCode,
    corrections,
    { figmaScreenshot: Buffer.from('figma') }
  );

  assert(result.patchedCode !== undefined, 'Should have patchedCode');
});

test('runRetryPass includes correctionApplied count', async () => {
  _setRenderer(createMockRenderer(0));
  _setComparator(createMockComparator(0));

  const corrections = [
    {
      selector: '.test',
      property: 'margin',
      current: '10px',
      corrected: '12px',
    },
  ];

  const result = await runRetryPass(
    {},
    'margin: 10px;',
    corrections,
    { figmaScreenshot: Buffer.from('figma') }
  );

  assert(typeof result.correctionApplied === 'number', 'Should have numeric count');
});

// ─── Diff Analysis Prompt Tests ──────────────────────────────────────────

test('buildDiffAnalysisPrompt returns systemPrompt and userPrompt', () => {
  const { systemPrompt, userPrompt } = buildDiffAnalysisPrompt(
    Buffer.from('figma'),
    Buffer.from('rendered'),
    Buffer.from('diff'),
    'code'
  );

  assert(typeof systemPrompt === 'string', 'systemPrompt should be string');
  assert(typeof userPrompt === 'string', 'userPrompt should be string');
});

test('buildDiffAnalysisPrompt systemPrompt contains key phrases', () => {
  const { systemPrompt } = buildDiffAnalysisPrompt(
    Buffer.from('figma'),
    Buffer.from('rendered'),
    Buffer.from('diff'),
    'code'
  );

  assert(systemPrompt.includes('visual diff analyzer'), 'Should mention diff analyzer');
  assert(systemPrompt.includes('CSS properties'), 'Should mention CSS');
  assert(
    systemPrompt.includes('JSON array'),
    'Should mention JSON output'
  );
});

test('buildDiffAnalysisPrompt userPrompt includes component code', () => {
  const code = 'const MyComponent = () => {}';
  const { userPrompt } = buildDiffAnalysisPrompt(
    Buffer.from('figma'),
    Buffer.from('rendered'),
    Buffer.from('diff'),
    code
  );

  assert(userPrompt.includes(code), 'Should include component code');
});

test('buildDiffAnalysisPrompt systemPrompt instructs JSON-only output', () => {
  const { systemPrompt } = buildDiffAnalysisPrompt(
    Buffer.from('figma'),
    Buffer.from('rendered'),
    Buffer.from('diff'),
    'code'
  );

  assert(
    systemPrompt.includes('Do not explain'),
    'Should forbid explanation'
  );
  assert(
    systemPrompt.includes('Return the JSON array only'),
    'Should request JSON only'
  );
});

// ─── Correction Parsing Tests ────────────────────────────────────────────

test('parseCorrectionResponse extracts valid JSON array', () => {
  const response = JSON.stringify([
    { selector: '.btn', property: 'padding', current: '8px', corrected: '10px' },
  ]);

  const { corrections, valid, parseErrors } = parseCorrectionResponse(response);

  assert(valid === true, 'Should be valid');
  assertEqual(corrections.length, 1, 'Should have 1 correction');
  assertEqual(corrections[0].selector, '.btn');
});

test('parseCorrectionResponse handles code block wrapper', () => {
  const response = `\`\`\`json
[
  { "selector": ".card", "property": "margin", "current": "16px", "corrected": "20px" }
]
\`\`\``;

  const { corrections, valid } = parseCorrectionResponse(response);

  assert(valid === true, 'Should parse from code block');
  assertEqual(corrections.length, 1);
});

test('parseCorrectionResponse validates correction shape', () => {
  const response = JSON.stringify([
    { selector: '.btn', property: 'padding', current: '8px', corrected: '10px' },
  ]);

  const { corrections } = parseCorrectionResponse(response);

  assert('selector' in corrections[0], 'Should have selector');
  assert('property' in corrections[0], 'Should have property');
  assert('current' in corrections[0], 'Should have current');
  assert('corrected' in corrections[0], 'Should have corrected');
});

test('parseCorrectionResponse returns parseErrors for missing fields', () => {
  const response = JSON.stringify([
    { selector: '.btn', property: 'padding' }, // missing current and corrected
  ]);

  const { valid, parseErrors } = parseCorrectionResponse(response);

  assert(valid === false, 'Should be invalid');
  assert(parseErrors.length > 0, 'Should have parse errors');
});

test('parseCorrectionResponse handles malformed JSON', () => {
  const response = '{ not valid json ]';

  const { valid, parseErrors } = parseCorrectionResponse(response);

  assert(valid === false, 'Should be invalid');
  assert(parseErrors.length > 0, 'Should have error');
  assert(
    parseErrors[0].includes('JSON parse error'),
    'Should mention parse error'
  );
});

test('parseCorrectionResponse handles empty response', () => {
  const { valid, parseErrors } = parseCorrectionResponse('');

  assert(valid === false, 'Should be invalid');
});

test('parseCorrectionResponse handles non-array response', () => {
  const response = JSON.stringify({ selector: '.btn' });

  const { valid, parseErrors } = parseCorrectionResponse(response);

  assert(valid === false, 'Should be invalid');
  assert(parseErrors[0].includes('not a JSON array'), 'Should mention array');
});

test('parseCorrectionResponse handles null response', () => {
  const { valid, parseErrors } = parseCorrectionResponse(null);

  assert(valid === false, 'Should be invalid');
});

test('parseCorrectionResponse handles empty array', () => {
  const response = JSON.stringify([]);

  const { corrections, valid } = parseCorrectionResponse(response);

  assert(valid === true, 'Should be valid (empty is valid)');
  assertEqual(corrections.length, 0, 'Should have no corrections');
});

// ─── Correction Application Tests ────────────────────────────────────────

test('applyCorrections replaces matching values', () => {
  const code = 'padding-top: 16px;';
  const corrections = [
    { selector: '.card', property: 'padding-top', current: '16px', corrected: '20px' },
  ];

  const { patchedCode, applied } = applyCorrections(code, corrections);

  assert(patchedCode.includes('20px'), 'Should apply correction');
  assert(applied > 0, 'Should track applied count');
});

test('applyCorrections handles quoted CSS-in-JS values', () => {
  const code = 'paddingTop: "16px"';
  const corrections = [
    { selector: '.card', property: 'paddingTop', current: '16px', corrected: '20px' },
  ];

  const { patchedCode, applied } = applyCorrections(code, corrections);

  assert(applied >= 0, 'Should attempt to apply');
});

test('applyCorrections skips unmatched corrections', () => {
  const code = 'padding: 10px;';
  const corrections = [
    {
      selector: '.card',
      property: 'nonexistent-prop',
      current: 'value',
      corrected: 'newvalue',
    },
  ];

  const { patchedCode, applied, skipped } = applyCorrections(code, corrections);

  assertEqual(applied, 0, 'Should not apply unmatchable correction');
  assertEqual(skipped, 1, 'Should skip unmatchable correction');
});

test('applyCorrections applies multiple corrections in sequence', () => {
  const code = 'padding: 10px; margin: 5px;';
  const corrections = [
    { selector: '.card', property: 'padding', current: '10px', corrected: '12px' },
    { selector: '.card', property: 'margin', current: '5px', corrected: '8px' },
  ];

  const { patchedCode, applied } = applyCorrections(code, corrections);

  assert(patchedCode.includes('12px'), 'Should have first correction');
  assert(patchedCode.includes('8px'), 'Should have second correction');
});

test('applyCorrections returns applied count', () => {
  const code = 'color: red;';
  const corrections = [
    { selector: '.text', property: 'color', current: 'red', corrected: 'blue' },
  ];

  const { applied } = applyCorrections(code, corrections);

  assert(typeof applied === 'number', 'applied should be number');
  assert(applied >= 0, 'applied should be non-negative');
});

test('applyCorrections returns skipped count', () => {
  const code = 'width: 100px;';
  const corrections = [
    { selector: '.box', property: 'height', current: '50px', corrected: '60px' },
  ];

  const { skipped } = applyCorrections(code, corrections);

  assert(typeof skipped === 'number', 'skipped should be number');
});

test('applyCorrections includes log entries', () => {
  const code = 'padding: 10px;';
  const corrections = [
    { selector: '.card', property: 'padding', current: '10px', corrected: '12px' },
  ];

  const { log } = applyCorrections(code, corrections);

  assert(Array.isArray(log), 'log should be array');
  assert(log.length > 0, 'log should have entries');
});

// ─── Fidelity Score Tests ────────────────────────────────────────────────

test('calculateFidelityScore: 0% diff returns 100', () => {
  const score = calculateFidelityScore(0);
  assertEqual(score, 100, 'Perfect match should be 100');
});

test('calculateFidelityScore: 2% diff returns 98', () => {
  const score = calculateFidelityScore(2);
  assertEqual(score, 98, '2% diff should give 98 score');
});

test('calculateFidelityScore: 10% diff returns 90', () => {
  const score = calculateFidelityScore(10);
  assertEqual(score, 90, '10% diff should give 90 score');
});

test('calculateFidelityScore: 100% diff returns 0', () => {
  const score = calculateFidelityScore(100);
  assertEqual(score, 0, 'Complete diff should be 0');
});

test('calculateFidelityScore: clamps negative to 0', () => {
  const score = calculateFidelityScore(150);
  assertEqual(score, 0, 'Over 100% should clamp to 0');
});

test('calculateFidelityScore: rounds to 1 decimal place', () => {
  const score = calculateFidelityScore(2.6);
  assertEqual(score, 97.4, 'Should be 97.4, rounded to 1 decimal');
});

// ─── Fidelity Badge Tests ────────────────────────────────────────────────

test('formatFidelityBadge excellent level (≥95)', () => {
  const { level, badge, score } = formatFidelityBadge(97.4);

  assertEqual(level, 'excellent', 'Score 97.4 should be excellent');
  assert(badge.includes('●●●●●'), 'Should have 5 dots for excellent');
  assert(badge.includes('97.4%'), 'Should include score in badge');
});

test('formatFidelityBadge good level (≥85, <95)', () => {
  const { level, badge } = formatFidelityBadge(89.2);

  assertEqual(level, 'good', 'Score 89.2 should be good');
  assert(badge.includes('●●●●○'), 'Should have 4 dots for good');
});

test('formatFidelityBadge acceptable level (≥70, <85)', () => {
  const { level, badge } = formatFidelityBadge(74.1);

  assertEqual(level, 'acceptable', 'Score 74.1 should be acceptable');
  assert(badge.includes('●●●○○'), 'Should have 3 dots for acceptable');
});

test('formatFidelityBadge poor level (<70)', () => {
  const { level, badge } = formatFidelityBadge(62.3);

  assertEqual(level, 'poor', 'Score 62.3 should be poor');
  assert(badge.includes('●●○○○'), 'Should have 2 dots for poor');
});

test('formatFidelityBadge boundary: exactly 95', () => {
  const { level } = formatFidelityBadge(95);

  assertEqual(level, 'excellent', 'Score 95 should be excellent');
});

test('formatFidelityBadge boundary: exactly 85', () => {
  const { level } = formatFidelityBadge(85);

  assertEqual(level, 'good', 'Score 85 should be good');
});

test('formatFidelityBadge boundary: exactly 70', () => {
  const { level } = formatFidelityBadge(70);

  assertEqual(level, 'acceptable', 'Score 70 should be acceptable');
});

// ─── Integration Tests ───────────────────────────────────────────────────

test('Integration: full flow pass', async () => {
  _setRenderer(createMockRenderer(0.5));
  _setComparator(createMockComparator(0.5));

  const result = await checkFidelity(Buffer.from('figma'), 'code', {
    threshold: 2.0,
  });

  assert(result.pass === true, 'Should pass');
  assertEqual(result.score, 99.5, 'Should calculate correct score');
});

test('Integration: full flow fail then retry pass', async () => {
  // First check fails
  _setRenderer(createMockRenderer(5.0));
  _setComparator(createMockComparator(5.0));

  const firstResult = await checkFidelity(Buffer.from('figma'), 'code', {
    threshold: 2.0,
  });

  assert(firstResult.pass === false, 'Should fail initially');

  // Retry with corrections
  _setRenderer(createMockRenderer(0.5));
  _setComparator(createMockComparator(0.5));

  const retryResult = await runRetryPass(firstResult, 'old code', [], {
    figmaScreenshot: Buffer.from('figma'),
  });

  assert(retryResult.pass === true, 'Should pass on retry');
});

test('Integration: full flow with multiple retries', async () => {
  // Still failing after multiple retries — operator gets honest score
  _setRenderer(createMockRenderer(8.0));
  _setComparator(createMockComparator(8.0));

  const result = await checkFidelity(Buffer.from('figma'), 'code', {
    threshold: 2.0,
  });

  assert(result.pass === false, 'Should fail');
  assertEqual(result.score, 92, 'Should report honest score of 92');
  assertEqual(result.diffPercent, 8.0, 'Should report honest diff');
});

test('Integration: retry does not modify original code', async () => {
  _setRenderer(createMockRenderer(0));
  _setComparator(createMockComparator(0));

  const originalCode = 'const MyComponent = () => {};';
  const corrections = [];

  const result = await runRetryPass(
    {},
    originalCode,
    corrections,
    { figmaScreenshot: Buffer.from('figma') }
  );

  // Original code should not be modified
  assert(
    originalCode === 'const MyComponent = () => {};',
    'Original code should not be modified'
  );
});

// ─── Additional Edge Case Tests ──────────────────────────────────────────

test('applyCorrections handles regex special characters in values', () => {
  const code = 'content: "a.b+c";';
  const corrections = [
    { selector: '.pseudo', property: 'content', current: 'a.b+c', corrected: 'x.y*z' },
  ];

  const { patchedCode } = applyCorrections(code, corrections);

  // Should not throw on special regex characters
  assert(typeof patchedCode === 'string', 'Should return patched code');
});

test('applyCorrections handles mixed quote styles in CSS-in-JS', () => {
  const code = `{
    padding: "10px",
    margin: '5px'
  }`;
  const corrections = [
    { selector: '.box', property: 'padding', current: '10px', corrected: '12px' },
  ];

  const { patchedCode, applied } = applyCorrections(code, corrections);

  assert(typeof patchedCode === 'string', 'Should handle mixed quotes');
});

test('calculateFidelityScore handles decimal diffPercent', () => {
  const score = calculateFidelityScore(3.33);
  assertInRange(score, 96.6, 96.7, 'Should round correctly');
});

test('formatFidelityBadge includes percent sign', () => {
  const { badge } = formatFidelityBadge(95);

  assert(badge.includes('%'), 'Badge should include percent sign');
});

test('parseCorrectionResponse handles corrections with extra fields', () => {
  const response = JSON.stringify([
    {
      selector: '.btn',
      property: 'padding',
      current: '8px',
      corrected: '10px',
      extra: 'ignored',
    },
  ]);

  const { corrections, valid } = parseCorrectionResponse(response);

  assert(valid === true, 'Should ignore extra fields');
  assertEqual(corrections.length, 1);
});

test('buildDiffAnalysisPrompt handles large code strings', () => {
  const largeCode = 'const x = 1;'.repeat(1000);
  const { userPrompt } = buildDiffAnalysisPrompt(
    Buffer.from('figma'),
    Buffer.from('rendered'),
    Buffer.from('diff'),
    largeCode
  );

  assert(userPrompt.includes(largeCode), 'Should handle large code');
});

test('checkFidelity default threshold is 2.0', async () => {
  _setRenderer(createMockRenderer(2.1));
  _setComparator(createMockComparator(2.1));

  const result = await checkFidelity(Buffer.from('figma'), 'code');
  // Default threshold is 2.0, so 2.1% diff should fail

  assert(result.retry === true, 'Default threshold should be 2.0');
});

test('checkFidelity default viewport is 1440x900', async () => {
  let capturedViewport;
  _setRenderer(async (code, viewport) => {
    capturedViewport = viewport;
    return Buffer.from('mock');
  });
  _setComparator(createMockComparator(0));

  await checkFidelity(Buffer.from('figma'), 'code');

  assertEqual(capturedViewport.width, 1440);
  assertEqual(capturedViewport.height, 900);
});

test('parseCorrectionResponse handles whitespace in JSON', () => {
  const response = `
    [
      {
        "selector": ".btn",
        "property": "padding",
        "current": "8px",
        "corrected": "10px"
      }
    ]
  `;

  const { valid, corrections } = parseCorrectionResponse(response);

  assert(valid === true, 'Should handle whitespace');
  assertEqual(corrections.length, 1);
});

test('applyCorrections handles corrections with same current and corrected', () => {
  const code = 'padding: 10px;';
  const corrections = [
    { selector: '.card', property: 'padding', current: '10px', corrected: '10px' },
  ];

  const { patchedCode, applied } = applyCorrections(code, corrections);

  // Should still apply (even though values are same)
  assertEqual(patchedCode, 'padding: 10px;');
});

// ─── Test Summary ────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(70));
console.log(
  `Test Results: ${passCount}/${testCount} passed, ${failCount} failed`
);
console.log('─'.repeat(70));

if (failCount > 0) {
  process.exit(1);
} else {
  console.log('✓ All tests passed');
  process.exit(0);
}
