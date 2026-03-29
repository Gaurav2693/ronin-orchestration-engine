// test/parallelReview.test.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Tests for Gate 06: Parallel Review Battery
// ─────────────────────────────────────────────────────────────────────────────

import {
  REVIEWER_TYPES,
  SEVERITY,
  createReviewResult,
  runReviewBattery,
} from '../gates/parallelReview.mjs';

let passed = 0;
let failed = 0;

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

function assert(cond, msg)      { if (!cond) throw new Error(msg || 'Assertion failed'); }
function assertEqual(a, b, msg) { if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

// ─── Mock workers ─────────────────────────────────────────────────────────────

function makeWorker(options = {}) {
  let callCount = 0;
  return {
    get callCount() { return callCount; },
    async execute(payload) {
      callCount++;
      if (options.fail) throw new Error('Worker failed');
      const response = options.response || { passed: true, issues: [], fixInstructions: [] };
      return {
        result: JSON.stringify(response),
        cost:   0.001,
      };
    },
  };
}

function makeFailingWorker(response = null) {
  return {
    async execute() {
      return {
        result: JSON.stringify(response || {
          passed: false,
          issues: [{ severity: 'error', message: 'blocking issue found', file: 'src/App.tsx', line: 10 }],
          fixInstructions: ['Fix the issue on line 10'],
        }),
        cost: 0.001,
      };
    },
  };
}

const SAMPLE_ARTIFACTS = {
  'src/App.tsx': 'export function App() { return <div>Hello</div>; }',
  'src/styles.css': '.app { color: red; }',
};

console.log('\n─── parallelReview.test.mjs ─────────────────────────────\n');

// ─── createReviewResult ───────────────────────────────────────────────────────

console.log('createReviewResult:');

await testAsync('creates result with default values', async () => {
  const result = createReviewResult(REVIEWER_TYPES.LINT);
  assertEqual(result.type, REVIEWER_TYPES.LINT, 'type');
  assertEqual(result.passed, true, 'passed default');
  assertEqual(result.blocking, false, 'blocking default');
  assert(Array.isArray(result.issues), 'issues is array');
  assert(Array.isArray(result.fixInstructions), 'fixInstructions is array');
});

await testAsync('accepts overrides', async () => {
  const result = createReviewResult(REVIEWER_TYPES.TYPE_CHECK, { passed: false, blocking: true });
  assertEqual(result.passed, false, 'passed override');
  assertEqual(result.blocking, true, 'blocking override');
});

// ─── REVIEWER_TYPES and SEVERITY ─────────────────────────────────────────────

console.log('\nReviewer types and severity:');

await testAsync('all reviewer types defined', async () => {
  assert(REVIEWER_TYPES.LINT, 'LINT');
  assert(REVIEWER_TYPES.TYPE_CHECK, 'TYPE_CHECK');
  assert(REVIEWER_TYPES.VISUAL_REGRESSION, 'VISUAL_REGRESSION');
  assert(REVIEWER_TYPES.ACCESSIBILITY, 'ACCESSIBILITY');
  assert(REVIEWER_TYPES.TASTE, 'TASTE');
});

await testAsync('severity levels defined', async () => {
  assert(SEVERITY.ERROR, 'ERROR');
  assert(SEVERITY.WARNING, 'WARNING');
  assert(SEVERITY.INFO, 'INFO');
});

// ─── runReviewBattery ─────────────────────────────────────────────────────────

console.log('\nrunReviewBattery:');

await testAsync('throws if artifacts are empty', async () => {
  const worker = makeWorker();
  try {
    await runReviewBattery({}, { fastWorker: worker });
    assert(false, 'Should have thrown');
  } catch (err) {
    assert(err.message.includes('artifacts'));
  }
});

await testAsync('throws if no worker provided', async () => {
  try {
    await runReviewBattery(SAMPLE_ARTIFACTS, {});
    assert(false, 'Should have thrown');
  } catch (err) {
    assert(err.message.includes('fastWorker') || err.message.includes('sonnetWorker'));
  }
});

await testAsync('returns passed: true when all reviewers pass', async () => {
  const worker = makeWorker();
  const result = await runReviewBattery(SAMPLE_ARTIFACTS, {
    fastWorker:   worker,
    sonnetWorker: worker,
  });
  assert(result.passed, 'should pass when no issues');
  assertEqual(result.blockingIssues.length, 0, 'no blocking issues');
});

await testAsync('returns all 5 review results', async () => {
  const worker = makeWorker();
  const result = await runReviewBattery(SAMPLE_ARTIFACTS, {
    fastWorker:   worker,
    sonnetWorker: worker,
  });
  assertEqual(result.results.length, 5, 'should have 5 reviewer results');
});

await testAsync('result contains correct reviewer types', async () => {
  const worker = makeWorker();
  const result = await runReviewBattery(SAMPLE_ARTIFACTS, {
    fastWorker:   worker,
    sonnetWorker: worker,
  });
  const types = result.results.map(r => r.type);
  assert(types.includes(REVIEWER_TYPES.LINT), 'lint reviewer');
  assert(types.includes(REVIEWER_TYPES.TYPE_CHECK), 'type_check reviewer');
  assert(types.includes(REVIEWER_TYPES.VISUAL_REGRESSION), 'visual_regression reviewer');
  assert(types.includes(REVIEWER_TYPES.ACCESSIBILITY), 'accessibility reviewer');
  assert(types.includes(REVIEWER_TYPES.TASTE), 'taste reviewer');
});

await testAsync('blocking lint failure → passed: false', async () => {
  const failWorker = makeFailingWorker();
  const okWorker   = makeWorker();
  const result     = await runReviewBattery(SAMPLE_ARTIFACTS, {
    fastWorker:   failWorker,  // lint + type use fast worker
    sonnetWorker: okWorker,
  });
  assert(!result.passed, 'should fail when lint has error');
  assert(result.blockingIssues.length > 0, 'should have blocking issues');
});

await testAsync('blocking issues include reviewer type', async () => {
  const failWorker = makeFailingWorker();
  const okWorker   = makeWorker();
  const result     = await runReviewBattery(SAMPLE_ARTIFACTS, {
    fastWorker:   failWorker,
    sonnetWorker: okWorker,
  });
  const issue = result.blockingIssues[0];
  assert(issue.reviewer, 'issue should have reviewer field');
  assert(issue.message, 'issue should have message');
});

await testAsync('fixInstructions populated when blocking issues found', async () => {
  const failWorker = makeFailingWorker();
  const okWorker   = makeWorker();
  const result     = await runReviewBattery(SAMPLE_ARTIFACTS, {
    fastWorker:   failWorker,
    sonnetWorker: okWorker,
  });
  assert(Array.isArray(result.fixInstructions), 'fixInstructions should be array');
});

await testAsync('taste reviewer never blocks (even if passed: false)', async () => {
  const okWorker   = makeWorker();
  const tasteWorker = makeWorker({
    response: {
      passed: false,
      score:  60,
      issues: [{ severity: 'warning', message: 'typography could be tighter', dimension: 'typography' }],
      fixInstructions: ['Tighten letter spacing'],
    },
  });
  const result = await runReviewBattery(SAMPLE_ARTIFACTS, {
    fastWorker:   okWorker,
    sonnetWorker: tasteWorker,
  });
  // Taste reviewer is non-blocking
  assert(result.passed, 'taste failures should not block gate');
});

await testAsync('visual regression skipped when no figmaSource', async () => {
  const worker = makeWorker();
  const result = await runReviewBattery(SAMPLE_ARTIFACTS, { fastWorker: worker, sonnetWorker: worker });
  const vrResult = result.results.find(r => r.type === REVIEWER_TYPES.VISUAL_REGRESSION);
  assert(vrResult, 'VR result should exist');
  // Should be skipped (passed: true, info issue)
  assert(vrResult.passed, 'VR should pass when skipped');
});

await testAsync('visual regression uses gate when provided', async () => {
  const worker = makeWorker();
  let vrCalled = false;
  const vrGate = {
    async check(artifacts, figmaSource) {
      vrCalled = true;
      return { passed: true, fidelityScore: 98, issues: [], threshold: 95 };
    },
  };
  await runReviewBattery(SAMPLE_ARTIFACTS, {
    fastWorker:          worker,
    sonnetWorker:        worker,
    figmaSource:         { frames: [] },
    visualRegressionGate: vrGate,
  });
  assert(vrCalled, 'visual regression gate should be called when provided');
});

await testAsync('worker error is non-fatal (reviewer gets error field, still passes)', async () => {
  const crashWorker = {
    async execute() { throw new Error('CRASH'); },
  };
  const result = await runReviewBattery(SAMPLE_ARTIFACTS, {
    fastWorker:   crashWorker,
    sonnetWorker: crashWorker,
  });
  // Reviewer error ≠ code failure
  const failedReviewers = result.results.filter(r => r.error);
  assert(failedReviewers.length > 0, 'some reviewers should have error field');
  // All reviewers with errors should still pass (non-blocking error)
  assert(failedReviewers.every(r => r.passed), 'reviewers with errors should still pass');
});

await testAsync('returns meta with cost and duration', async () => {
  const worker = makeWorker();
  const result = await runReviewBattery(SAMPLE_ARTIFACTS, {
    fastWorker:   worker,
    sonnetWorker: worker,
  });
  assert(result.meta, 'meta exists');
  assert(typeof result.meta.totalCost === 'number', 'totalCost');
  assert(typeof result.meta.totalDuration === 'number', 'totalDuration');
  assertEqual(result.meta.reviewersRun, 5, 'reviewersRun should be 5');
});

await testAsync('nonBlockingA11y option makes accessibility non-blocking', async () => {
  const okWorker = makeWorker();
  const a11yFail = makeWorker({
    response: {
      passed: false,
      score: 70,
      issues: [{ severity: 'error', message: 'missing alt text', wcag: '1.1.1' }],
      fixInstructions: ['Add alt text to all images'],
    },
  });
  // With nonBlockingA11y, even an a11y error shouldn't block
  const result = await runReviewBattery(SAMPLE_ARTIFACTS, {
    fastWorker:   okWorker,
    sonnetWorker: a11yFail,
  }, { nonBlockingA11y: true });
  assert(result.passed, 'a11y failure should not block with nonBlockingA11y');
});

await testAsync('reviewer scores captured in reviewerScores map', async () => {
  const scoredWorker = makeWorker({
    response: { passed: true, score: 88, issues: [], fixInstructions: [] },
  });
  const result = await runReviewBattery(SAMPLE_ARTIFACTS, {
    fastWorker:   scoredWorker,
    sonnetWorker: scoredWorker,
  });
  assert(result.reviewerScores, 'reviewerScores should exist');
  // At least one reviewer should have returned a score
  const scores = Object.values(result.reviewerScores);
  assert(scores.length > 0, 'at least one score captured');
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n─── Results: ${passed} passed, ${failed} failed ───\n`);
process.exit(failed > 0 ? 1 : 0);
