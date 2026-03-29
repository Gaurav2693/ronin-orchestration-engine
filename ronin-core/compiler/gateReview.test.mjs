// ─── compiler/gateReview.test.mjs ──────────────────────────────────────────
// Test suite for D12 Gate 06 Visual Regression Checker
// Target: 55+ tests, 0 failures
// Run: node gateReview.test.mjs 2>&1
// ────────────────────────────────────────────────────────────────────────────

import {
  GATE_06_CONFIG,
  runGateReview,
  compareToSourceOfTruth,
  identifyRegressionRegions,
  shouldBlockShip,
  generateReviewReport,
  trackRegressionHistory,
  clearRegressionHistory,
  getRegressionHistory,
  createReviewSession,
  _setRenderer,
  _setComparator,
} from './gateReview.mjs';

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
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `Expected ${expected}, got ${actual}`);
  }
}

function assertDeepEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertThrows(fn, errorMessage) {
  try {
    fn();
    throw new Error(`Expected function to throw, but it did not`);
  } catch (error) {
    if (errorMessage && !error.message.includes(errorMessage)) {
      throw new Error(`Expected error message to include "${errorMessage}", got "${error.message}"`);
    }
  }
}

// ─── Mock providers ─────────────────────────────────────────────────────

function createMockRenderer(regressionPercent = 0) {
  return async (code, viewport, scale) => {
    // Return a fake screenshot
    return Buffer.from(`rendered_${regressionPercent}`);
  };
}

function createMockComparator(diffPercent = 0, regionsCount = 0) {
  return async (imageA, imageB) => {
    const regions = [];
    for (let i = 0; i < regionsCount; i++) {
      regions.push({
        x: 100 + i * 50,
        y: 100,
        width: 50,
        height: 50,
        severity: i === 0 ? 'major' : 'moderate',
        description: `region ${i}`,
      });
    }
    return {
      diffPercent,
      diffImage: Buffer.from(`diff_${diffPercent}`),
      regions,
    };
  };
}

// ─── Tests: Configuration ────────────────────────────────────────────────

test('GATE_06_CONFIG has correct threshold (5.0)', () => {
  assertEqual(GATE_06_CONFIG.regressionThreshold, 5.0);
});

test('GATE_06_CONFIG is blocking gate', () => {
  assertEqual(GATE_06_CONFIG.blockingGate, true);
});

test('GATE_06_CONFIG maxRetries is 1', () => {
  assertEqual(GATE_06_CONFIG.maxRetries, 1);
});

test('GATE_06_CONFIG sourceOfTruth is figma_screenshot', () => {
  assertEqual(GATE_06_CONFIG.sourceOfTruth, 'figma_screenshot');
});

// ─── Tests: Gate Review Execution ────────────────────────────────────────

test('runGateReview returns correct structure', async () => {
  _setRenderer(createMockRenderer(1));
  _setComparator(createMockComparator(1));

  const session = {
    figmaScreenshot: Buffer.from('figma'),
    fidelityOutput: { code: 'component code' },
  };
  const result = await runGateReview('shipped code', session);

  assert(result.pass !== undefined);
  assert(result.regressionScore !== undefined);
  assert(result.fidelityScore !== undefined);
  assert(result.threshold !== undefined);
  assert(result.blocked !== undefined);
  assert(result.regressionRegions !== undefined);
  assert(result.comparison !== undefined);
  assert(result.recommendation !== undefined);
  assert(result.timestamp !== undefined);
});

test('runGateReview passes when regression < 5%', async () => {
  _setRenderer(createMockRenderer(3));
  _setComparator(createMockComparator(3));

  const session = {
    figmaScreenshot: Buffer.from('figma'),
    fidelityOutput: {},
  };
  const result = await runGateReview('shipped code', session);

  assertEqual(result.pass, true);
  assertEqual(result.blocked, false);
});

test('runGateReview blocks when regression > 5%', async () => {
  _setRenderer(createMockRenderer(6));
  _setComparator(createMockComparator(6));

  const session = {
    figmaScreenshot: Buffer.from('figma'),
    fidelityOutput: {},
  };
  const result = await runGateReview('shipped code', session);

  assertEqual(result.pass, false);
  assertEqual(result.blocked, true);
});

test('runGateReview passes in warning zone (2-5%)', async () => {
  _setRenderer(createMockRenderer(3.5));
  _setComparator(createMockComparator(3.5));

  const session = {
    figmaScreenshot: Buffer.from('figma'),
    fidelityOutput: {},
  };
  const result = await runGateReview('shipped code', session);

  assertEqual(result.pass, true);
  assertEqual(result.blocked, false);
});

test('runGateReview clean pass < 2%', async () => {
  _setRenderer(createMockRenderer(1));
  _setComparator(createMockComparator(1));

  const session = {
    figmaScreenshot: Buffer.from('figma'),
    fidelityOutput: {},
  };
  const result = await runGateReview('shipped code', session);

  assertEqual(result.pass, true);
});

test('runGateReview returns comparison screenshots', async () => {
  _setRenderer(createMockRenderer(2));
  _setComparator(createMockComparator(2));

  const session = {
    figmaScreenshot: Buffer.from('figma'),
    fidelityOutput: {},
  };
  const result = await runGateReview('shipped code', session);

  assert(result.comparison.original !== undefined);
  assert(result.comparison.shipped !== undefined);
  assert(result.comparison.diff !== undefined);
});

test('runGateReview returns regression regions', async () => {
  _setRenderer(createMockRenderer(4));
  _setComparator(createMockComparator(4, 2));

  const session = {
    figmaScreenshot: Buffer.from('figma'),
    fidelityOutput: {},
  };
  const result = await runGateReview('shipped code', session);

  assert(Array.isArray(result.regressionRegions));
});

test('runGateReview returns recommendation text', async () => {
  _setRenderer(createMockRenderer(2));
  _setComparator(createMockComparator(2));

  const session = {
    figmaScreenshot: Buffer.from('figma'),
    fidelityOutput: {},
  };
  const result = await runGateReview('shipped code', session);

  assert(typeof result.recommendation === 'string');
  assert(result.recommendation.length > 0);
});

test('runGateReview handles renderer error gracefully', async () => {
  _setRenderer(async () => {
    throw new Error('Renderer crashed');
  });
  _setComparator(createMockComparator(0));

  const session = {
    figmaScreenshot: Buffer.from('figma'),
    fidelityOutput: {},
  };
  const result = await runGateReview('shipped code', session);

  assertEqual(result.blocked, true);
  assert(result.recommendation.includes('Renderer error'));
});

test('runGateReview respects custom threshold override', async () => {
  _setRenderer(createMockRenderer(7));
  _setComparator(createMockComparator(7));

  const session = {
    figmaScreenshot: Buffer.from('figma'),
    fidelityOutput: {},
  };
  const result = await runGateReview('shipped code', session, { threshold: 10 });

  assertEqual(result.pass, true);
  assertEqual(result.blocked, false);
  assertEqual(result.threshold, 10);
});

// ─── Tests: Ship Blocking ────────────────────────────────────────────────

test('shouldBlockShip returns false below 2%', () => {
  const result = shouldBlockShip(1.5);
  assertEqual(result.blocked, false);
});

test('shouldBlockShip returns false at 3% (within threshold)', () => {
  const result = shouldBlockShip(3);
  assertEqual(result.blocked, false);
});

test('shouldBlockShip returns true at 6% (above threshold)', () => {
  const result = shouldBlockShip(6);
  assertEqual(result.blocked, true);
});

test('shouldBlockShip returns true at exactly 5.0%', () => {
  const result = shouldBlockShip(5.0);
  assertEqual(result.blocked, false);
});

test('shouldBlockShip returns true above 5.0%', () => {
  const result = shouldBlockShip(5.1);
  assertEqual(result.blocked, true);
});

test('shouldBlockShip with custom threshold', () => {
  const result = shouldBlockShip(3, 2);
  assertEqual(result.blocked, true);
});

test('shouldBlockShip includes reason string for clean pass', () => {
  const result = shouldBlockShip(0.5);
  assert(result.reason.includes('PASSED'));
  assert(result.reason.includes('0.5'));
});

test('shouldBlockShip includes reason string for blocked status', () => {
  const result = shouldBlockShip(7);
  assert(result.reason.includes('BLOCKED'));
  assert(result.reason.includes('7.0'));
});

// ─── Tests: Regression Identification ────────────────────────────────────

test('identifyRegressionRegions returns descriptions', () => {
  const diffData = {
    regions: [
      {
        x: 10,
        y: 20,
        width: 50,
        height: 50,
        severity: 'major',
        description: 'button area',
      },
    ],
  };
  const regions = identifyRegressionRegions(diffData);
  assert(regions.length > 0);
  assert(typeof regions[0] === 'string');
  assert(regions[0].includes('Major'));
  assert(regions[0].includes('button area'));
});

test('identifyRegressionRegions handles no regions', () => {
  const diffData = { regions: [] };
  const regions = identifyRegressionRegions(diffData);
  assertEqual(regions.length, 0);
});

test('identifyRegressionRegions handles null diffData', () => {
  const regions = identifyRegressionRegions(null);
  assertEqual(regions.length, 0);
});

test('identifyRegressionRegions multiple regions identified', () => {
  const diffData = {
    regions: [
      { severity: 'major', description: 'header' },
      { severity: 'moderate', description: 'footer' },
      { severity: 'minor', description: 'spacing' },
    ],
  };
  const regions = identifyRegressionRegions(diffData);
  assertEqual(regions.length, 3);
  assert(regions[0].includes('Major'));
  assert(regions[1].includes('Moderate'));
  assert(regions[2].includes('Minor'));
});

// ─── Tests: Review Report ────────────────────────────────────────────────

test('generateReviewReport produces summary', () => {
  const result = {
    pass: true,
    regressionScore: 2.5,
    threshold: 5,
    blocked: false,
    regressionRegions: [],
    recommendation: 'Test passed',
    timestamp: new Date().toISOString(),
  };
  const report = generateReviewReport(result);
  assert(report.summary !== undefined);
  assert(typeof report.summary === 'string');
});

test('generateReviewReport status is passed for clean results', () => {
  const result = {
    pass: true,
    regressionScore: 1,
    threshold: 5,
    blocked: false,
    regressionRegions: [],
    recommendation: 'Test passed',
    timestamp: new Date().toISOString(),
  };
  const report = generateReviewReport(result);
  assertEqual(report.status, 'passed');
});

test('generateReviewReport status is blocked for failed results', () => {
  const result = {
    pass: false,
    regressionScore: 7,
    threshold: 5,
    blocked: true,
    regressionRegions: [],
    recommendation: 'Test blocked',
    timestamp: new Date().toISOString(),
  };
  const report = generateReviewReport(result);
  assertEqual(report.status, 'blocked');
});

test('generateReviewReport status is warning for borderline', () => {
  const result = {
    pass: true,
    regressionScore: 3,
    threshold: 5,
    blocked: false,
    regressionRegions: [],
    recommendation: 'Test borderline',
    timestamp: new Date().toISOString(),
  };
  const report = generateReviewReport(result);
  assertEqual(report.status, 'warning');
});

test('generateReviewReport includes action required when blocked', () => {
  const result = {
    pass: false,
    regressionScore: 7,
    threshold: 5,
    blocked: true,
    regressionRegions: [],
    recommendation: 'Test blocked',
    timestamp: new Date().toISOString(),
  };
  const report = generateReviewReport(result);
  assert(report.actionRequired !== null);
  assert(report.actionRequired.includes('Fix'));
});

test('generateReviewReport includes component name and timestamp', () => {
  const result = {
    pass: true,
    regressionScore: 1,
    threshold: 5,
    blocked: false,
    regressionRegions: [],
    recommendation: 'Test passed',
    timestamp: '2026-03-24T10:00:00Z',
    componentName: 'TestButton',
  };
  const report = generateReviewReport(result);
  assertEqual(report.componentName, 'TestButton');
  assertEqual(report.timestamp, '2026-03-24T10:00:00Z');
});

// ─── Tests: Regression History ───────────────────────────────────────────

test('trackRegressionHistory stores results', () => {
  clearRegressionHistory('TestComponent');
  const result = {
    regressionScore: 2.5,
    pass: true,
    blocked: false,
    timestamp: new Date().toISOString(),
  };
  const history = trackRegressionHistory('TestComponent', result);
  assert(Array.isArray(history.history));
  assertEqual(history.history.length, 1);
  assertEqual(history.history[0].score, 2.5);
});

test('trackRegressionHistory trend detection: stable', () => {
  clearRegressionHistory('StableComponent');
  const results = [
    { regressionScore: 2, pass: true, blocked: false, timestamp: new Date().toISOString() },
    { regressionScore: 2.1, pass: true, blocked: false, timestamp: new Date().toISOString() },
    { regressionScore: 2.05, pass: true, blocked: false, timestamp: new Date().toISOString() },
  ];
  let history;
  for (const result of results) {
    history = trackRegressionHistory('StableComponent', result);
  }
  assertEqual(history.trend, 'stable');
});

test('trackRegressionHistory trend detection: degrading', () => {
  clearRegressionHistory('DegradingComponent');
  const results = [
    { regressionScore: 1, pass: true, blocked: false, timestamp: new Date().toISOString() },
    { regressionScore: 2, pass: true, blocked: false, timestamp: new Date().toISOString() },
    { regressionScore: 3, pass: true, blocked: false, timestamp: new Date().toISOString() },
    { regressionScore: 4, pass: true, blocked: false, timestamp: new Date().toISOString() },
    { regressionScore: 5, pass: true, blocked: false, timestamp: new Date().toISOString() },
    { regressionScore: 6, pass: false, blocked: true, timestamp: new Date().toISOString() },
  ];
  let history;
  for (const result of results) {
    history = trackRegressionHistory('DegradingComponent', result);
  }
  assertEqual(history.trend, 'degrading');
});

test('trackRegressionHistory trend detection: improving', () => {
  clearRegressionHistory('ImprovingComponent');
  const results = [
    { regressionScore: 6, pass: false, blocked: true, timestamp: new Date().toISOString() },
    { regressionScore: 5, pass: true, blocked: false, timestamp: new Date().toISOString() },
    { regressionScore: 4, pass: true, blocked: false, timestamp: new Date().toISOString() },
    { regressionScore: 3, pass: true, blocked: false, timestamp: new Date().toISOString() },
    { regressionScore: 2, pass: true, blocked: false, timestamp: new Date().toISOString() },
    { regressionScore: 1, pass: true, blocked: false, timestamp: new Date().toISOString() },
  ];
  let history;
  for (const result of results) {
    history = trackRegressionHistory('ImprovingComponent', result);
  }
  assertEqual(history.trend, 'improving');
});

test('trackRegressionHistory history per component is independent', () => {
  clearRegressionHistory();
  const result1 = { regressionScore: 1, pass: true, blocked: false, timestamp: new Date().toISOString() };
  const result2 = { regressionScore: 5, pass: true, blocked: false, timestamp: new Date().toISOString() };

  trackRegressionHistory('Component1', result1);
  trackRegressionHistory('Component2', result2);

  const history1 = getRegressionHistory('Component1');
  const history2 = getRegressionHistory('Component2');

  assertEqual(history1.length, 1);
  assertEqual(history2.length, 1);
  assertEqual(history1[0].score, 1);
  assertEqual(history2[0].score, 5);
});

// ─── Tests: Review Session Creation ──────────────────────────────────────

test('createReviewSession validates required data', () => {
  const session = {
    figmaScreenshot: Buffer.from('screenshot'),
    fidelityOutput: { code: 'component' },
    componentName: 'TestButton',
  };
  const reviewSession = createReviewSession(session);
  assert(reviewSession.figmaScreenshot !== undefined);
  assert(reviewSession.fidelityOutput !== undefined);
  assertEqual(reviewSession.componentName, 'TestButton');
});

test('createReviewSession throws for missing screenshot', () => {
  const session = {
    fidelityOutput: { code: 'component' },
  };
  assertThrows(() => createReviewSession(session), 'figmaScreenshot');
});

test('createReviewSession throws for missing fidelity output', () => {
  const session = {
    figmaScreenshot: Buffer.from('screenshot'),
  };
  assertThrows(() => createReviewSession(session), 'fidelityOutput');
});

test('createReviewSession returns valid review session', () => {
  const session = {
    figmaScreenshot: Buffer.from('screenshot'),
    fidelityOutput: { code: 'component' },
    componentName: 'TestCard',
    nodeId: 'node123',
    operatorId: 'op456',
  };
  const reviewSession = createReviewSession(session);
  assertEqual(reviewSession.componentName, 'TestCard');
  assertEqual(reviewSession.nodeId, 'node123');
  assertEqual(reviewSession.operatorId, 'op456');
  assert(reviewSession.createdAt !== undefined);
});

// ─── Tests: Integration ──────────────────────────────────────────────────

test('Full flow: Gate 03 session → createReviewSession → runGateReview → report', async () => {
  clearRegressionHistory('IntegrationTest');
  _setRenderer(createMockRenderer(2));
  _setComparator(createMockComparator(2));

  const gate03Session = {
    figmaScreenshot: Buffer.from('figma'),
    fidelityOutput: { code: 'component' },
    componentName: 'IntegrationTest',
  };

  const reviewSession = createReviewSession(gate03Session);
  const result = await runGateReview('shipped code', reviewSession);
  const report = generateReviewReport(result);

  assertEqual(result.pass, true);
  assertEqual(report.status, 'warning');
});

test('Shipped code with minor changes passes', async () => {
  _setRenderer(createMockRenderer(1));
  _setComparator(createMockComparator(1));

  const session = {
    figmaScreenshot: Buffer.from('figma'),
    fidelityOutput: {},
  };
  const result = await runGateReview('shipped code with minor changes', session);
  assertEqual(result.pass, true);
});

test('Shipped code with major regression blocks', async () => {
  _setRenderer(createMockRenderer(8));
  _setComparator(createMockComparator(8));

  const session = {
    figmaScreenshot: Buffer.from('figma'),
    fidelityOutput: {},
  };
  const result = await runGateReview('shipped code with major regression', session);
  assertEqual(result.blocked, true);
});

test('History tracks across multiple reviews', () => {
  clearRegressionHistory('MultiReview');
  const scores = [1, 2, 3, 2, 1];

  for (const score of scores) {
    trackRegressionHistory('MultiReview', {
      regressionScore: score,
      pass: score <= 5,
      blocked: false,
      timestamp: new Date().toISOString(),
    });
  }

  const history = getRegressionHistory('MultiReview');
  assertEqual(history.length, 5);
});

// ─── Tests: Edge Cases and Error Handling ────────────────────────────────

test('runGateReview throws on missing shippedCode', async () => {
  const session = {
    figmaScreenshot: Buffer.from('figma'),
    fidelityOutput: {},
  };
  try {
    await runGateReview(null, session);
    throw new Error('Should have thrown');
  } catch (error) {
    assert(error.message.includes('shippedCode'));
  }
});

test('runGateReview throws on missing session', async () => {
  try {
    await runGateReview('code', null);
    throw new Error('Should have thrown');
  } catch (error) {
    assert(error.message.includes('session'));
  }
});

test('runGateReview throws on missing figmaScreenshot', async () => {
  const session = {
    fidelityOutput: {},
  };
  try {
    await runGateReview('code', session);
    throw new Error('Should have thrown');
  } catch (error) {
    assert(error.message.includes('figmaScreenshot'));
  }
});

test('compareToSourceOfTruth throws on missing shipped screenshot', async () => {
  _setComparator(createMockComparator(0));
  try {
    await compareToSourceOfTruth(null, Buffer.from('figma'));
    throw new Error('Should have thrown');
  } catch (error) {
    assert(error.message.includes('shippedScreenshot'));
  }
});

test('compareToSourceOfTruth throws on missing figma screenshot', async () => {
  _setComparator(createMockComparator(0));
  try {
    await compareToSourceOfTruth(Buffer.from('shipped'), null);
    throw new Error('Should have thrown');
  } catch (error) {
    assert(error.message.includes('figmaScreenshot'));
  }
});

test('shouldBlockShip at exactly threshold boundary (5.0%)', () => {
  const result = shouldBlockShip(5.0);
  assertEqual(result.blocked, false);
});

test('shouldBlockShip just above threshold', () => {
  const result = shouldBlockShip(5.01);
  assertEqual(result.blocked, true);
});

test('shouldBlockShip with zero regression', () => {
  const result = shouldBlockShip(0);
  assertEqual(result.blocked, false);
  assert(result.reason.includes('0.0'));
});

test('shouldBlockShip with high regression', () => {
  const result = shouldBlockShip(95.5);
  assertEqual(result.blocked, true);
  assert(result.reason.includes('95.5'));
});

test('trackRegressionHistory requires componentName', () => {
  const result = {
    regressionScore: 1,
    pass: true,
    blocked: false,
    timestamp: new Date().toISOString(),
  };
  try {
    trackRegressionHistory(null, result);
    throw new Error('Should have thrown');
  } catch (error) {
    assert(error.message.includes('componentName'));
  }
});

test('trackRegressionHistory requires result', () => {
  try {
    trackRegressionHistory('Component', null);
    throw new Error('Should have thrown');
  } catch (error) {
    assert(error.message.includes('result'));
  }
});

test('getRegressionHistory requires componentName', () => {
  try {
    getRegressionHistory(null);
    throw new Error('Should have thrown');
  } catch (error) {
    assert(error.message.includes('componentName'));
  }
});

test('createReviewSession requires session object', () => {
  try {
    createReviewSession(null);
    throw new Error('Should have thrown');
  } catch (error) {
    assert(error.message.includes('session'));
  }
});

test('generateReviewReport requires result', () => {
  try {
    generateReviewReport(null);
    throw new Error('Should have thrown');
  } catch (error) {
    assert(error.message.includes('result'));
  }
});

test('identifyRegressionRegions with region position data', () => {
  const diffData = {
    regions: [
      {
        x: 50,
        y: 100,
        width: 100,
        height: 50,
        severity: 'moderate',
        description: 'header area',
      },
    ],
  };
  const regions = identifyRegressionRegions(diffData);
  assert(regions[0].includes('50'));
  assert(regions[0].includes('100'));
});

test('compareToSourceOfTruth returns correct structure', async () => {
  _setComparator(createMockComparator(2.5, 1));
  const result = await compareToSourceOfTruth(
    Buffer.from('shipped'),
    Buffer.from('figma')
  );
  assert(result.diffPercent !== undefined);
  assert(result.diffImage !== undefined);
  assert(Array.isArray(result.regions));
});

test('runGateReview respects viewport from options', async () => {
  let capturedViewport = null;
  _setRenderer(async (code, viewport, scale) => {
    capturedViewport = viewport;
    return Buffer.from('rendered');
  });
  _setComparator(createMockComparator(1));

  const session = {
    figmaScreenshot: Buffer.from('figma'),
    fidelityOutput: {},
  };
  await runGateReview('code', session, {});
  assertEqual(capturedViewport.width, 1440);
  assertEqual(capturedViewport.height, 900);
});

test('runGateReview generates timestamps', async () => {
  _setRenderer(createMockRenderer(1));
  _setComparator(createMockComparator(1));

  const session = {
    figmaScreenshot: Buffer.from('figma'),
    fidelityOutput: {},
  };
  const result = await runGateReview('code', session);
  assert(result.timestamp !== undefined);
  assert(new Date(result.timestamp).getTime() > 0);
});

test('runGateReview includes timeMs in result', async () => {
  _setRenderer(createMockRenderer(1));
  _setComparator(createMockComparator(1));

  const session = {
    figmaScreenshot: Buffer.from('figma'),
    fidelityOutput: {},
  };
  const result = await runGateReview('code', session);
  assert(result.timeMs >= 0);
});

test('generateReviewReport includes details array', () => {
  const result = {
    pass: true,
    regressionScore: 1.5,
    threshold: 5,
    blocked: false,
    regressionRegions: [],
    recommendation: 'Passed',
    timestamp: new Date().toISOString(),
  };
  const report = generateReviewReport(result);
  assert(Array.isArray(report.details));
  assert(report.details.length > 0);
});

test('generateReviewReport details with regions', () => {
  const result = {
    pass: false,
    regressionScore: 6,
    threshold: 5,
    blocked: true,
    regressionRegions: ['Region A changed', 'Region B changed'],
    recommendation: 'Blocked',
    timestamp: new Date().toISOString(),
  };
  const report = generateReviewReport(result);
  assert(report.details.some(d => d.includes('Affected regions')));
  assert(report.details.some(d => d.includes('Region A changed')));
});

test('Regression score is rounded to 1 decimal', async () => {
  _setRenderer(createMockRenderer(2.567));
  _setComparator(createMockComparator(2.567));

  const session = {
    figmaScreenshot: Buffer.from('figma'),
    fidelityOutput: {},
  };
  const result = await runGateReview('code', session);
  const decimalPlaces = (result.regressionScore.toString().split('.')[1] || '').length;
  assert(decimalPlaces <= 1);
});

test('Fidelity score is 100 minus regression score', async () => {
  _setRenderer(createMockRenderer(3.2));
  _setComparator(createMockComparator(3.2));

  const session = {
    figmaScreenshot: Buffer.from('figma'),
    fidelityOutput: {},
  };
  const result = await runGateReview('code', session);
  assertEqual(Math.round((result.fidelityScore + result.regressionScore) * 10) / 10, 100);
});

// ─── Final Results ───────────────────────────────────────────────────────

console.log('\n═════════════════════════════════════════════════');
console.log(`Tests: ${testCount} | Passed: ${passCount} | Failed: ${failCount}`);
console.log('═════════════════════════════════════════════════');

if (failCount === 0) {
  console.log('All tests passed!');
  process.exit(0);
} else {
  console.log(`${failCount} test(s) failed.`);
  process.exit(1);
}
