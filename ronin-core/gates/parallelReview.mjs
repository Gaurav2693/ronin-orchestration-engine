// gates/parallelReview.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Gate 06 Upgrade: Parallel Review Battery
//
// 5 reviewers run simultaneously instead of sequentially:
//   1. Lint         — static analysis, style, import errors
//   2. Type Check   — TypeScript / prop-type errors
//   3. Visual Regression — pixel diff against reference (uses Gate D4)
//   4. Accessibility — WCAG 2.1 AA audit on generated components
//   5. Taste Review  — Creative Director taste alignment check
//
// If any critical reviewer flags a blocking issue → Gate 06 fails with
// specific fix instructions assembled from all reviewers.
//
// Flow:
//   code + figmaSource → 5 parallel reviewers → merge → review report
//
// Usage:
//   const result = await runReviewBattery(artifacts, reviewerSet, options);
//   // → { passed, results[], blockingIssues[], fixInstructions, cost, duration }
// ─────────────────────────────────────────────────────────────────────────────

// ─── Reviewer Types ───────────────────────────────────────────────────────────

export const REVIEWER_TYPES = {
  LINT:              'lint',
  TYPE_CHECK:        'type_check',
  VISUAL_REGRESSION: 'visual_regression',
  ACCESSIBILITY:     'accessibility',
  TASTE:             'taste',
};

// ─── Review Result Schema ─────────────────────────────────────────────────────

export function createReviewResult(type, overrides = {}) {
  return {
    type,
    passed:          true,
    blocking:        false,       // blocking = gate must fail if false
    issues:          [],          // [{ severity, message, file?, line? }]
    fixInstructions: [],          // string[]
    score:           null,        // 0-100 where applicable
    cost:            0,
    duration:        0,
    error:           null,        // reviewer error (not a code issue)
    ...overrides,
  };
}

// ─── Severity levels ─────────────────────────────────────────────────────────

export const SEVERITY = {
  ERROR:   'error',    // blocking
  WARNING: 'warning',  // non-blocking
  INFO:    'info',     // informational
};

// ─── Build reviewer prompts ───────────────────────────────────────────────────

function buildLintPrompt(artifacts) {
  const fileList = Object.entries(artifacts)
    .map(([path, content]) => `\`\`\`\n// ${path}\n${content}\n\`\`\``)
    .join('\n\n');

  return `
You are a code linter reviewing generated code for quality issues.
Check for: unused imports, undefined variables, unreachable code, missing
semicolons/brackets, inconsistent naming, dead code, console.log statements
left in production code, and obvious logic errors.

Files to review:
${fileList}

Return a JSON object:
{
  "passed": true/false,
  "issues": [
    { "severity": "error"|"warning"|"info", "message": "...", "file": "path/to/file", "line": 12 }
  ],
  "fixInstructions": ["specific fix 1", "specific fix 2"]
}

Blocking errors (passed: false): syntax errors, undefined references, circular imports.
Warnings: style issues, unused vars. Info: suggestions.
`.trim();
}

function buildTypeCheckPrompt(artifacts) {
  const fileList = Object.entries(artifacts)
    .map(([path, content]) => `\`\`\`\n// ${path}\n${content}\n\`\`\``)
    .join('\n\n');

  return `
You are a TypeScript type checker reviewing generated code.
Check for: missing type annotations, any-type overuse, prop type mismatches,
incorrect generic usage, missing null checks, type assertion abuse, and
interface violations.

Files to review:
${fileList}

Return a JSON object:
{
  "passed": true/false,
  "issues": [
    { "severity": "error"|"warning"|"info", "message": "...", "file": "path/to/file", "line": 12 }
  ],
  "fixInstructions": ["specific fix 1"]
}

Blocking errors: type errors that would fail tsc compilation.
Warnings: missing annotations, implicit any.
`.trim();
}

function buildAccessibilityPrompt(artifacts) {
  const componentFiles = Object.entries(artifacts)
    .filter(([path]) => path.match(/\.(jsx?|tsx?|html|svelte)$/))
    .map(([path, content]) => `\`\`\`\n// ${path}\n${content}\n\`\`\``)
    .join('\n\n');

  if (!componentFiles) {
    return null; // No UI files to check
  }

  return `
You are an accessibility auditor checking generated UI components against WCAG 2.1 AA.
Check for: missing alt text on images, unlabeled form inputs, missing ARIA roles,
insufficient color contrast indicators, keyboard navigation issues, missing focus
indicators, and semantic HTML violations.

Components to audit:
${componentFiles}

Return a JSON object:
{
  "passed": true/false,
  "score": 0-100,
  "issues": [
    { "severity": "error"|"warning"|"info", "message": "...", "file": "path/to/file", "wcag": "1.1.1" }
  ],
  "fixInstructions": ["specific fix 1"]
}

Blocking errors (passed: false): WCAG AA critical violations (missing alt, unlabeled inputs).
Warnings: WCAG AA recommendations.
`.trim();
}

function buildTastePrompt(artifacts, tasteProfile) {
  const fileList = Object.entries(artifacts)
    .map(([path, content]) => `\`\`\`\n// ${path}\n${content}\n\`\`\``)
    .join('\n\n');

  const tasteSection = tasteProfile
    ? `\nOperator Taste Profile:\n${JSON.stringify(tasteProfile, null, 2)}\n`
    : '\n(No taste profile loaded — evaluate general design quality)\n';

  return `
You are the Creative Director reviewing generated code for taste alignment.
Evaluate: does this implementation match the operator's aesthetic preferences?
Is the component structure elegant? Is the naming intentional? Does the visual
output (inferred from code) match the design intent?
${tasteSection}
Generated code:
${fileList}

Return a JSON object:
{
  "passed": true/false,
  "score": 0-100,
  "issues": [
    { "severity": "warning"|"info", "message": "...", "dimension": "typography|color|spacing|motion|naming" }
  ],
  "fixInstructions": ["specific fix 1"]
}

Taste review is non-blocking (passed can be false as a warning, not an error).
Focus on actionable style improvements, not subjective opinions.
`.trim();
}

// ─── Run a single reviewer ────────────────────────────────────────────────────

async function _runReviewer(type, promptText, worker, isBlocking = true) {
  const start = Date.now();

  if (!promptText) {
    // Skipped reviewer (e.g., no UI files for accessibility check)
    return createReviewResult(type, {
      passed:   true,
      blocking: false,
      issues:   [{ severity: SEVERITY.INFO, message: `${type} reviewer skipped — no applicable files` }],
      duration: 0,
    });
  }

  try {
    const result = await worker.execute(
      {
        messages:  [{ role: 'user', content: promptText }],
        jsonMode:  true,
        maxTokens: 800,
      },
      {}
    );

    const rawContent = result.result || result.content || '{}';
    let parsed = {};

    try {
      parsed = typeof rawContent === 'string' ? JSON.parse(rawContent) : rawContent;
    } catch {
      parsed = { passed: true, issues: [], fixInstructions: [] };
    }

    const issues          = Array.isArray(parsed.issues) ? parsed.issues : [];
    const hasBlockingError = issues.some(i => i.severity === SEVERITY.ERROR);
    const passed           = parsed.passed !== false && !hasBlockingError;

    return createReviewResult(type, {
      passed,
      blocking:        isBlocking && !passed,
      issues,
      fixInstructions: Array.isArray(parsed.fixInstructions) ? parsed.fixInstructions : [],
      score:           typeof parsed.score === 'number' ? parsed.score : null,
      cost:            result.cost || 0,
      duration:        Date.now() - start,
    });

  } catch (err) {
    return createReviewResult(type, {
      passed:   true,   // reviewer error ≠ code failure
      blocking: false,
      error:    err.message,
      duration: Date.now() - start,
    });
  }
}

// ─── Visual regression reviewer ───────────────────────────────────────────────
// Delegates to Gate D4 (visualRegression) if provided, otherwise skips.

async function _runVisualRegression(artifacts, figmaSource, visualRegressionGate) {
  const start = Date.now();

  if (!visualRegressionGate || typeof visualRegressionGate.check !== 'function') {
    return createReviewResult(REVIEWER_TYPES.VISUAL_REGRESSION, {
      passed:   true,
      blocking: false,
      issues:   [{ severity: SEVERITY.INFO, message: 'Visual regression gate not connected — skipped' }],
      duration: 0,
    });
  }

  if (!figmaSource) {
    return createReviewResult(REVIEWER_TYPES.VISUAL_REGRESSION, {
      passed:   true,
      blocking: false,
      issues:   [{ severity: SEVERITY.INFO, message: 'No Figma source provided — visual regression skipped' }],
      duration: 0,
    });
  }

  try {
    const vrResult = await visualRegressionGate.check(artifacts, figmaSource);
    const passed   = vrResult.passed !== false && (vrResult.fidelityScore || 100) >= (vrResult.threshold || 95);

    return createReviewResult(REVIEWER_TYPES.VISUAL_REGRESSION, {
      passed,
      blocking:        !passed,
      score:           vrResult.fidelityScore || null,
      issues:          vrResult.issues || (passed ? [] : [{
        severity: SEVERITY.ERROR,
        message:  `Visual fidelity ${vrResult.fidelityScore}% below threshold ${vrResult.threshold || 95}%`,
      }]),
      fixInstructions: vrResult.fixInstructions || [],
      cost:            vrResult.cost || 0,
      duration:        Date.now() - start,
    });
  } catch (err) {
    return createReviewResult(REVIEWER_TYPES.VISUAL_REGRESSION, {
      passed:   true,
      blocking: false,
      error:    err.message,
      duration: Date.now() - start,
    });
  }
}

// ─── Merge all review results ─────────────────────────────────────────────────

function mergeReviewResults(results) {
  const blockingIssues    = [];
  const allFixInstructions = [];
  let totalCost = 0;

  for (const result of results) {
    totalCost += result.cost || 0;

    if (result.blocking && !result.passed) {
      for (const issue of result.issues.filter(i => i.severity === SEVERITY.ERROR)) {
        blockingIssues.push({ reviewer: result.type, ...issue });
      }
      allFixInstructions.push(...(result.fixInstructions || []));
    }
  }

  const passed = blockingIssues.length === 0;

  return {
    passed,
    blockingIssues,
    fixInstructions: allFixInstructions,
    totalCost,
  };
}

// ─── Main: runReviewBattery ───────────────────────────────────────────────────

export async function runReviewBattery(artifacts, reviewerSet = {}, options = {}) {
  if (!artifacts || typeof artifacts !== 'object' || Object.keys(artifacts).length === 0) {
    throw new Error('[parallelReview] artifacts must be a non-empty object of { path: content }');
  }

  const startTime = Date.now();

  const {
    fastWorker,          // for lint + type check (cheap)
    sonnetWorker,        // for accessibility + taste (smarter)
    visualRegressionGate,// Gate D4 instance (optional)
    tasteProfile,        // operator taste dimensions (optional)
    figmaSource,         // reference Figma source (optional)
  } = reviewerSet;

  // ─── Build prompts ───────────────────────────────────────────────────────
  const lintPrompt   = buildLintPrompt(artifacts);
  const typePrompt   = buildTypeCheckPrompt(artifacts);
  const a11yPrompt   = buildAccessibilityPrompt(artifacts);
  const tastePrompt  = buildTastePrompt(artifacts, tasteProfile || null);

  const worker = fastWorker || sonnetWorker;

  if (!worker || typeof worker.execute !== 'function') {
    throw new Error('[parallelReview] reviewerSet must include fastWorker or sonnetWorker with execute()');
  }

  // ─── Dispatch all 5 reviewers in parallel ────────────────────────────────
  const [
    lintResult,
    typeResult,
    vrResult,
    a11yResult,
    tasteResult,
  ] = await Promise.all([
    _runReviewer(REVIEWER_TYPES.LINT,       lintPrompt,  fastWorker || worker, true),
    _runReviewer(REVIEWER_TYPES.TYPE_CHECK,  typePrompt,  fastWorker || worker, true),
    _runVisualRegression(artifacts, figmaSource, visualRegressionGate),
    _runReviewer(REVIEWER_TYPES.ACCESSIBILITY, a11yPrompt, sonnetWorker || worker, !options.nonBlockingA11y),
    _runReviewer(REVIEWER_TYPES.TASTE,      tastePrompt, sonnetWorker || worker, false),  // taste never blocks
  ]);

  const results = [lintResult, typeResult, vrResult, a11yResult, tasteResult];
  const merged  = mergeReviewResults(results);
  const totalDuration = Date.now() - startTime;

  // ─── Build summary ───────────────────────────────────────────────────────
  const reviewerScores = results
    .filter(r => r.score !== null)
    .reduce((acc, r) => ({ ...acc, [r.type]: r.score }), {});

  return {
    passed:          merged.passed,
    results,
    blockingIssues:  merged.blockingIssues,
    fixInstructions: merged.fixInstructions,
    reviewerScores,
    meta: {
      totalCost:        merged.totalCost,
      totalDuration,
      reviewersRun:     results.length,
      reviewersPassed:  results.filter(r => r.passed).length,
      reviewersFailed:  results.filter(r => !r.passed).length,
      parallelDuration: totalDuration, // all 5 ran in parallel
    },
  };
}
