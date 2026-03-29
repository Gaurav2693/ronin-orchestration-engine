// ─── compiler/visualRegression.mjs ────────────────────────────────────────
// D4 Visual Regression Checker — Stage 3
// Compares rendered component against original Figma screenshot to detect
// pixel-level deviations. Orchestrates rendering, comparison, diff analysis,
// and retry logic.
//
// INVARIANT (from RONIN_DESIGN_INTELLIGENCE.md §4.3):
// — 2% threshold for pixel-diff. Above that, retry with Haiku analysis.
// — Max 2 retries. If still failing, deliver honest score (e.g. "91.4% match").
// — Operator always receives output. Score always shown.
// ─────────────────────────────────────────────────────────────────────────

/**
 * DiffRegion — represents a localized area of deviation
 * @typedef {Object} DiffRegion
 * @property {number} x - left position
 * @property {number} y - top position
 * @property {number} width - region width
 * @property {number} height - region height
 * @property {'minor'|'moderate'|'major'} severity - <5%=minor, 5-15%=moderate, >15%=major
 * @property {string} description - human-readable summary
 */

/**
 * FidelityResult — return shape for checkFidelity
 * @typedef {Object} FidelityResult
 * @property {boolean} pass
 * @property {number} score - 0-100, where 100 is perfect match
 * @property {number} diffPercent - 0-100
 * @property {DiffRegion[]} diffRegions
 * @property {Buffer|null} diffImage - red=different, green=matching
 * @property {boolean} retry - true if diff > threshold
 * @property {Object} metadata
 * @property {Object} metadata.viewport
 * @property {number} metadata.scale
 * @property {number} metadata.renderTimeMs
 * @property {number} metadata.diffTimeMs
 */

/**
 * Correction — CSS correction from Haiku diff analysis
 * @typedef {Object} Correction
 * @property {string} selector
 * @property {string} property
 * @property {string} current
 * @property {string} corrected
 */

// ─── Injectable Renderer/Comparator/Analyzer ─────────────────────────────

let _renderer = async (code, viewport, scale) => {
  throw new Error('No renderer configured — install Playwright for headless rendering');
};

let _comparator = async (imageA, imageB) => {
  throw new Error('No comparator configured — install pixelmatch for pixel comparison');
};

let _diffAnalyzer = async (systemPrompt, userPrompt) => {
  throw new Error('No diff analyzer configured');
};

export function _setRenderer(fn) {
  _renderer = fn;
}

export function _setComparator(fn) {
  _comparator = fn;
}

export function _setDiffAnalyzer(fn) {
  _diffAnalyzer = fn;
}

// ─── Main Entry Point ────────────────────────────────────────────────────

/**
 * Check fidelity of rendered component against original Figma screenshot
 * @param {Buffer|string} figmaScreenshot - original Figma export (PNG, 2x scale)
 * @param {string} componentCode - React component code from Stage 2
 * @param {Object} options
 * @param {Object} options.viewport - { width, height } default { width: 1440, height: 900 }
 * @param {number} options.scale - render scale, default 2
 * @param {number} options.threshold - diff threshold %, default 2.0
 * @param {Function} options.renderer - custom renderer function
 * @param {Function} options.comparator - custom comparator function
 * @param {Function} options.diffAnalyzer - custom diff analyzer function
 * @returns {Promise<FidelityResult>}
 */
export async function checkFidelity(figmaScreenshot, componentCode, options = {}) {
  const {
    viewport = { width: 1440, height: 900 },
    scale = 2,
    threshold = 2.0,
    renderer = _renderer,
    comparator = _comparator,
    diffAnalyzer = _diffAnalyzer,
  } = options;

  const startTime = Date.now();
  let renderTimeMs = 0;
  let diffTimeMs = 0;

  try {
    // 1. Render component headlessly
    const renderStart = Date.now();
    const renderedScreenshot = await renderer(componentCode, viewport, scale);
    renderTimeMs = Date.now() - renderStart;

    // 2. Pixel diff against Figma screenshot
    const diffStart = Date.now();
    const diffResult = await comparator(figmaScreenshot, renderedScreenshot);
    diffTimeMs = Date.now() - diffStart;

    const diffPercent = diffResult.diffPercent ?? 0;
    const score = calculateFidelityScore(diffPercent);
    const pass = diffPercent <= threshold;

    return {
      pass,
      score,
      diffPercent,
      diffRegions: diffResult.regions || [],
      diffImage: diffResult.diffImage || null,
      retry: diffPercent > threshold,
      metadata: {
        viewport,
        scale,
        renderTimeMs,
        diffTimeMs,
      },
    };
  } catch (error) {
    // If renderer or comparator fails, return error result
    return {
      pass: false,
      score: 0,
      diffPercent: 100,
      diffRegions: [],
      diffImage: null,
      retry: false,
      metadata: {
        viewport,
        scale,
        renderTimeMs,
        diffTimeMs,
        error: error.message,
      },
    };
  }
}

// ─── Retry Pass ──────────────────────────────────────────────────────────

/**
 * Run a retry pass: apply corrections and re-check fidelity
 * @param {FidelityResult} originalResult - result from previous checkFidelity
 * @param {string} componentCode - original component code
 * @param {Correction[]} corrections - corrections from Haiku diff analysis
 * @param {Object} options - same as checkFidelity
 * @returns {Promise<FidelityResult & { patchedCode: string, correctionApplied: number }>}
 */
export async function runRetryPass(originalResult, componentCode, corrections, options = {}) {
  // Apply corrections to code
  const { patchedCode, applied, skipped, log } = applyCorrections(componentCode, corrections);

  // Re-run fidelity check with patched code
  const retryResult = await checkFidelity(
    options.figmaScreenshot || Buffer.from(''),
    patchedCode,
    options
  );

  return {
    ...retryResult,
    patchedCode,
    correctionApplied: applied,
    correctionSkipped: skipped,
    correctionLog: log,
  };
}

// ─── Diff Analysis Prompt Builder ───────────────────────────────────────

/**
 * Build the system and user prompts for Haiku diff analysis
 * @param {Buffer|string} figmaScreenshot - original Figma export
 * @param {Buffer|string} renderedScreenshot - rendered component screenshot
 * @param {Buffer|string} diffImage - pixel diff image (red=diff, green=match)
 * @param {string} componentCode - the component code that was rendered
 * @returns {Object} { systemPrompt: string, userPrompt: string }
 */
export function buildDiffAnalysisPrompt(figmaScreenshot, renderedScreenshot, diffImage, componentCode) {
  const systemPrompt = `You are a visual diff analyzer. You have been given:
1. The original Figma design as a PNG screenshot
2. The rendered React component as a PNG screenshot
3. A pixel-diff image showing regions of deviation (red = deviation, green = match)

Your job is to identify which CSS properties in the provided component code are causing
the deviations shown in the diff image.

Output ONLY a JSON array of corrections:
[
  { "selector": ".ComponentName", "property": "padding-top", "current": "16px", "corrected": "20px" },
  ...
]

Do not explain. Do not suggest. Return the JSON array only.`;

  const userPrompt = `Original Figma screenshot: [provided as image]
Rendered component screenshot: [provided as image]
Pixel diff image: [provided as image]

Component code:
\`\`\`tsx
${componentCode}
\`\`\`

Identify the CSS corrections needed.`;

  return { systemPrompt, userPrompt };
}

// ─── Correction Parsing ──────────────────────────────────────────────────

/**
 * Parse Haiku's correction response JSON
 * @param {string} response - Haiku's response, may contain code block
 * @returns {Object} { corrections: Correction[], valid: boolean, parseErrors: string[] }
 */
export function parseCorrectionResponse(response) {
  const corrections = [];
  const parseErrors = [];

  if (!response || typeof response !== 'string') {
    parseErrors.push('Response is not a string');
    return { corrections, valid: false, parseErrors };
  }

  // Try to extract JSON from code block
  let jsonStr = response;
  const codeBlockMatch = response.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1];
  }

  // Try to parse JSON
  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (error) {
    parseErrors.push(`JSON parse error: ${error.message}`);
    return { corrections, valid: false, parseErrors };
  }

  // Validate it's an array
  if (!Array.isArray(parsed)) {
    parseErrors.push('Response is not a JSON array');
    return { corrections, valid: false, parseErrors };
  }

  // Validate each correction
  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i];

    if (typeof item !== 'object' || item === null) {
      parseErrors.push(`Item ${i}: not an object`);
      continue;
    }

    const { selector, property, current, corrected } = item;

    if (!selector || typeof selector !== 'string') {
      parseErrors.push(`Item ${i}: missing or invalid selector`);
      continue;
    }
    if (!property || typeof property !== 'string') {
      parseErrors.push(`Item ${i}: missing or invalid property`);
      continue;
    }
    if (!current || typeof current !== 'string') {
      parseErrors.push(`Item ${i}: missing or invalid current value`);
      continue;
    }
    if (!corrected || typeof corrected !== 'string') {
      parseErrors.push(`Item ${i}: missing or invalid corrected value`);
      continue;
    }

    corrections.push({ selector, property, current, corrected });
  }

  const valid = parseErrors.length === 0;
  return { corrections, valid, parseErrors };
}

// ─── Correction Application ─────────────────────────────────────────────

/**
 * Apply CSS corrections to component code
 * @param {string} code - original component code
 * @param {Correction[]} corrections - array of corrections
 * @returns {Object} { patchedCode: string, applied: number, skipped: number, log: string[] }
 */
export function applyCorrections(code, corrections) {
  let patchedCode = code;
  const log = [];
  let applied = 0;
  let skipped = 0;

  for (const correction of corrections) {
    const { selector, property, current, corrected } = correction;

    // Build a pattern to find the selector + property + current value
    // This is a simple string replacement approach
    // For CSS-in-JS, we look for patterns like:
    //   - `.selector { property: current; }`
    //   - `selector: { property: "current" }`
    //   - `selector: { property: 'current' }`
    //   - `property: "current"` within a styled component

    // Try to find and replace the pattern
    const escapedCurrent = escapeRegExp(current);
    const escapedProperty = escapeRegExp(property);
    const escapedSelector = escapeRegExp(selector);

    // Pattern 1: CSS rule `.selector { property: current; }`
    const cssPattern = new RegExp(
      `(${escapedSelector}\\s*\\{[^}]*?)${escapedProperty}\\s*:\\s*${escapedCurrent}([^}]*)`,
      'g'
    );
    const beforeCss = patchedCode;
    patchedCode = patchedCode.replace(cssPattern, `$1${property}: ${corrected}$2`);

    if (patchedCode !== beforeCss) {
      applied++;
      log.push(`Applied: ${selector} { ${property}: ${corrected} }`);
      continue;
    }

    // Pattern 2: CSS-in-JS object `property: "current"` or `property: 'current'`
    // Look specifically within the context of a selector
    const jsPattern = new RegExp(
      `${escapedProperty}\\s*:\\s*["\']${escapedCurrent}["\']`,
      'g'
    );
    const beforeJs = patchedCode;
    patchedCode = patchedCode.replace(jsPattern, `${property}: "${corrected}"`);

    if (patchedCode !== beforeJs) {
      applied++;
      log.push(`Applied: ${property}: ${corrected}`);
      continue;
    }

    // Pattern 3: Direct value replacement without quotes
    const valuePattern = new RegExp(`\\b${escapedCurrent}\\b`, 'g');
    const beforeValue = patchedCode;
    patchedCode = patchedCode.replace(valuePattern, corrected);

    if (patchedCode !== beforeValue) {
      applied++;
      log.push(`Applied: value ${corrected}`);
      continue;
    }

    skipped++;
    log.push(`Skipped: could not find pattern for ${selector} { ${property}: ${current} }`);
  }

  return {
    patchedCode,
    applied,
    skipped,
    log,
  };
}

/**
 * Escape special regex characters
 */
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Fidelity Score Calculation ──────────────────────────────────────────

/**
 * Convert diff percentage to fidelity score (0-100)
 * @param {number} diffPercent - pixel difference percentage
 * @returns {number} score, rounded to 1 decimal
 */
export function calculateFidelityScore(diffPercent) {
  const score = Math.max(0, 100 - diffPercent);
  return Math.round(score * 10) / 10;
}

// ─── Fidelity Badge Formatting ──────────────────────────────────────────

/**
 * Format fidelity score as UI badge
 * @param {number} score - fidelity score (0-100)
 * @returns {Object} { badge: string, level: string, score: number }
 */
export function formatFidelityBadge(score) {
  let badge;
  let level;

  if (score >= 95) {
    badge = `●●●●● ${score}% match`;
    level = 'excellent';
  } else if (score >= 85) {
    badge = `●●●●○ ${score}% match`;
    level = 'good';
  } else if (score >= 70) {
    badge = `●●●○○ ${score}% match`;
    level = 'acceptable';
  } else {
    badge = `●●○○○ ${score}% match`;
    level = 'poor';
  }

  return { badge, level, score };
}
