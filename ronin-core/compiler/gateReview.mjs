// ─── compiler/gateReview.mjs ───────────────────────────────────────────────
// D12 Gate 06 Visual Regression Checker — Phase 5
//
// Gate 06 (Review) re-runs the visual regression check against the SHIPPED
// component — not the generated component, but the one that went through Gates
// 04 (Plan) and 05 (Implement) and potentially got modified during prop wiring,
// data integration, and responsive behavior changes.
//
// The Figma screenshot stored at Gate 03 is the permanent visual ground truth
// for the component's lifetime. If Gate 06 detects a regression above 5%, it
// blocks Ship (Gate 07) until resolved.
//
// Key difference from Stage 3 (D4):
// — Stage 3 checks generated code vs Figma screenshot (2% threshold)
// — Gate 06 checks shipped code vs Figma screenshot (5% threshold — wider)
// — Gate 06 is a BLOCKING gate — if it fails, Ship (Gate 07) is blocked
// ────────────────────────────────────────────────────────────────────────────

/**
 * Gate 06 Configuration (exported constant)
 */
export const GATE_06_CONFIG = {
  regressionThreshold: 5.0,      // max allowed diff percentage
  blockingGate: true,             // blocks Gate 07 if failed
  maxRetries: 1,                  // only 1 retry (shipped code is harder to auto-fix)
  sourceOfTruth: 'figma_screenshot', // from Gate 03
};

// ─── Injectable Renderer/Comparator ──────────────────────────────────────

let _renderer = async (code, viewport, scale) => {
  throw new Error('No renderer configured for Gate 06 review');
};

let _comparator = async (imageA, imageB) => {
  throw new Error('No comparator configured for Gate 06 review');
};

/**
 * Set custom renderer function
 * @param {Function} fn - async (code, viewport, scale) => Buffer
 */
export function _setRenderer(fn) {
  _renderer = fn;
}

/**
 * Set custom comparator function
 * @param {Function} fn - async (imageA, imageB) => { diffPercent, diffImage, regions }
 */
export function _setComparator(fn) {
  _comparator = fn;
}

// ─── Main Review Function ───────────────────────────────────────────────

/**
 * Run Gate 06 review: check shipped component code against Figma screenshot
 * @param {string} shippedCode - the actual shipped component code (post Gate 05)
 * @param {Object} session - Gate 03 session object with figmaScreenshot, fidelityOutput, etc.
 * @param {Object} options - { renderer?, comparator?, threshold? }
 * @returns {Promise<Object>} review result with pass/fail, score, regions, etc.
 */
export async function runGateReview(shippedCode, session, options = {}) {
  const startTime = Date.now();

  // Validate inputs
  if (!shippedCode || typeof shippedCode !== 'string') {
    throw new Error('runGateReview: shippedCode must be a non-empty string');
  }
  if (!session || typeof session !== 'object') {
    throw new Error('runGateReview: session must be an object');
  }
  if (!session.figmaScreenshot) {
    throw new Error('runGateReview: session.figmaScreenshot is required');
  }

  const {
    renderer = _renderer,
    comparator = _comparator,
    threshold = GATE_06_CONFIG.regressionThreshold,
  } = options;

  try {
    // Step 1: Render shipped component
    let shippedScreenshot;
    try {
      shippedScreenshot = await renderer(shippedCode, { width: 1440, height: 900 }, 2);
    } catch (error) {
      return {
        pass: false,
        regressionScore: 100,
        fidelityScore: 0,
        threshold,
        blocked: true,
        regressionRegions: [],
        comparison: {
          original: session.figmaScreenshot,
          shipped: null,
          diff: null,
        },
        recommendation: `Renderer error: ${error.message}. Review blocked. Check renderer configuration.`,
        timestamp: new Date().toISOString(),
      };
    }

    // Step 2: Compare shipped screenshot vs Figma screenshot
    let diffResult;
    try {
      diffResult = await comparator(session.figmaScreenshot, shippedScreenshot);
    } catch (error) {
      return {
        pass: false,
        regressionScore: 100,
        fidelityScore: 0,
        threshold,
        blocked: true,
        regressionRegions: [],
        comparison: {
          original: session.figmaScreenshot,
          shipped: shippedScreenshot,
          diff: null,
        },
        recommendation: `Comparator error: ${error.message}. Review blocked. Check comparator configuration.`,
        timestamp: new Date().toISOString(),
      };
    }

    const regressionScore = diffResult.diffPercent ?? 0;
    const fidelityScore = 100 - regressionScore;
    const pass = regressionScore <= threshold;
    const blocked = !pass && GATE_06_CONFIG.blockingGate;

    // Step 3: Identify regression regions
    const regressionRegions = identifyRegressionRegions(diffResult);

    // Step 4: Determine recommendation
    const recommendation = shouldBlockShip(regressionScore, threshold);

    const timeMs = Date.now() - startTime;

    return {
      pass,
      regressionScore: Math.round(regressionScore * 10) / 10,
      fidelityScore: Math.round(fidelityScore * 10) / 10,
      threshold,
      blocked,
      regressionRegions,
      comparison: {
        original: session.figmaScreenshot,
        shipped: shippedScreenshot,
        diff: diffResult.diffImage || null,
      },
      recommendation: recommendation.reason,
      timestamp: new Date().toISOString(),
      timeMs,
    };
  } catch (error) {
    return {
      pass: false,
      regressionScore: 100,
      fidelityScore: 0,
      threshold,
      blocked: true,
      regressionRegions: [],
      comparison: {
        original: session.figmaScreenshot,
        shipped: null,
        diff: null,
      },
      recommendation: `Unexpected error: ${error.message}. Review blocked.`,
      timestamp: new Date().toISOString(),
    };
  }
}

// ─── Comparison Function ─────────────────────────────────────────────────

/**
 * Compare shipped screenshot against Figma screenshot (ground truth)
 * @param {Buffer|string} shippedScreenshot - rendered shipped component
 * @param {Buffer|string} figmaScreenshot - original Figma screenshot
 * @param {Object} options - { comparator?, threshold? }
 * @returns {Promise<Object>} { diffPercent, diffImage, regions }
 */
export async function compareToSourceOfTruth(shippedScreenshot, figmaScreenshot, options = {}) {
  const { comparator = _comparator } = options;

  if (!shippedScreenshot) {
    throw new Error('compareToSourceOfTruth: shippedScreenshot is required');
  }
  if (!figmaScreenshot) {
    throw new Error('compareToSourceOfTruth: figmaScreenshot is required');
  }

  try {
    const diffResult = await comparator(figmaScreenshot, shippedScreenshot);
    return {
      diffPercent: diffResult.diffPercent ?? 0,
      diffImage: diffResult.diffImage || null,
      regions: diffResult.regions || [],
    };
  } catch (error) {
    throw new Error(`Comparison failed: ${error.message}`);
  }
}

// ─── Regression Region Identification ────────────────────────────────────

/**
 * Analyze diff to identify which regions changed
 * @param {Object} diffData - { diffPercent, diffImage, regions }
 * @returns {string[]} human-readable descriptions of changed regions
 */
export function identifyRegressionRegions(diffData) {
  if (!diffData || !diffData.regions || diffData.regions.length === 0) {
    return [];
  }

  const regions = [];

  for (const region of diffData.regions) {
    let description = '';

    // Map severity to description
    if (region.severity === 'major') {
      description = `Major change in ${region.description || 'unnamed region'}`;
    } else if (region.severity === 'moderate') {
      description = `Moderate change in ${region.description || 'unnamed region'}`;
    } else {
      description = `Minor change in ${region.description || 'unnamed region'}`;
    }

    if (region.x !== undefined && region.y !== undefined) {
      description += ` (at position ${region.x}, ${region.y})`;
    }

    regions.push(description);
  }

  return regions;
}

// ─── Ship Blocking Logic ─────────────────────────────────────────────────

/**
 * Determine if regression should block Ship (Gate 07)
 * @param {number} regressionScore - diff percentage (0-100)
 * @param {number} threshold - max allowed % (default 5.0)
 * @returns {Object} { blocked: boolean, reason: string }
 */
export function shouldBlockShip(regressionScore, threshold = GATE_06_CONFIG.regressionThreshold) {
  if (regressionScore < 2) {
    return {
      blocked: false,
      reason: `Gate 06 PASSED — ${regressionScore.toFixed(1)}% regression. Clean pass — within fidelity tolerance.`,
    };
  }

  if (regressionScore <= threshold) {
    return {
      blocked: false,
      reason: `Gate 06 PASSED — ${regressionScore.toFixed(1)}% regression. Acceptable — minor implementation drift detected.`,
    };
  }

  return {
    blocked: true,
    reason: `Gate 06 BLOCKED — ${regressionScore.toFixed(1)}% regression. Exceeds ${threshold}% threshold. Review required before Ship.`,
  };
}

// ─── Review Report Generation ────────────────────────────────────────────

/**
 * Generate a structured review report
 * @param {Object} result - result from runGateReview
 * @returns {Object} formatted review report
 */
export function generateReviewReport(result) {
  if (!result) {
    throw new Error('generateReviewReport: result is required');
  }

  let status = 'passed';
  if (result.blocked) {
    status = 'blocked';
  } else if (result.regressionScore > 2) {
    status = 'warning';
  }

  const details = [];

  if (result.regressionScore === 0) {
    details.push('Perfect match — no visual deviations detected');
  } else if (result.regressionScore < 2) {
    details.push(`Minimal deviation (${result.regressionScore.toFixed(1)}%) — sub-pixel rendering differences`);
  } else if (result.regressionScore <= result.threshold) {
    details.push(`Minor drift (${result.regressionScore.toFixed(1)}%) — acceptable implementation variance`);
  } else {
    details.push(`Significant regression (${result.regressionScore.toFixed(1)}%) — exceeds threshold`);
  }

  if (result.regressionRegions && result.regressionRegions.length > 0) {
    details.push('Affected regions:');
    for (const region of result.regressionRegions) {
      details.push(`  • ${region}`);
    }
  }

  let actionRequired = null;
  if (result.blocked) {
    actionRequired = 'Fix the regressions identified above and re-run Gate 06 review before proceeding to Ship.';
  }

  return {
    summary: result.recommendation,
    status,
    details,
    actionRequired,
    componentName: result.componentName || 'Unknown',
    timestamp: result.timestamp || new Date().toISOString(),
  };
}

// ─── Regression History Tracking ─────────────────────────────────────────

/**
 * Track regression score over time for a component
 * @typedef {Object} RegressionHistory
 * @property {Array} history - previous review results
 * @property {string} trend - 'improving' | 'stable' | 'degrading'
 */

// In-memory store for regression history (keyed by component name)
const _regressionHistory = new Map();

/**
 * Track a review result and compute trend
 * @param {string} componentName - component identifier
 * @param {Object} result - result from runGateReview
 * @returns {RegressionHistory} history and trend
 */
export function trackRegressionHistory(componentName, result) {
  if (!componentName || typeof componentName !== 'string') {
    throw new Error('trackRegressionHistory: componentName is required');
  }
  if (!result || typeof result !== 'object') {
    throw new Error('trackRegressionHistory: result is required');
  }

  // Initialize history for this component if needed
  if (!_regressionHistory.has(componentName)) {
    _regressionHistory.set(componentName, []);
  }

  const history = _regressionHistory.get(componentName);

  // Add new result to history
  history.push({
    score: result.regressionScore,
    timestamp: result.timestamp,
    pass: result.pass,
    blocked: result.blocked,
  });

  // Compute trend based on last 5 results
  let trend = 'stable';
  if (history.length >= 2) {
    const recentScores = history.slice(-5).map(r => r.score);
    const avgOldScore = recentScores.slice(0, Math.floor(recentScores.length / 2)).reduce((a, b) => a + b, 0) / Math.floor(recentScores.length / 2);
    const avgNewScore = recentScores.slice(Math.floor(recentScores.length / 2)).reduce((a, b) => a + b, 0) / Math.ceil(recentScores.length / 2);

    if (avgNewScore < avgOldScore - 0.5) {
      trend = 'improving';
    } else if (avgNewScore > avgOldScore + 0.5) {
      trend = 'degrading';
    }
  }

  return {
    history: [...history],
    trend,
  };
}

/**
 * Clear regression history (for testing)
 * @param {string} componentName - optional; if omitted, clears all
 */
export function clearRegressionHistory(componentName) {
  if (componentName) {
    _regressionHistory.delete(componentName);
  } else {
    _regressionHistory.clear();
  }
}

/**
 * Get regression history for a component
 * @param {string} componentName - component identifier
 * @returns {Array} history array
 */
export function getRegressionHistory(componentName) {
  if (!componentName) {
    throw new Error('getRegressionHistory: componentName is required');
  }
  return _regressionHistory.get(componentName) || [];
}

// ─── Review Session Creation ─────────────────────────────────────────────

/**
 * Create a Gate 06 review session from a Gate 03 session
 * @param {Object} session - Gate 03 session with screenshot, fidelityOutput, etc.
 * @returns {Object} review session ready for runGateReview
 */
export function createReviewSession(session) {
  if (!session || typeof session !== 'object') {
    throw new Error('createReviewSession: session must be an object');
  }

  // Validate required fields
  if (!session.figmaScreenshot) {
    throw new Error('createReviewSession: session.figmaScreenshot is required (from Gate 03)');
  }

  if (!session.fidelityOutput) {
    throw new Error('createReviewSession: session.fidelityOutput is required (from Gate 03)');
  }

  // Return validated review session
  return {
    figmaScreenshot: session.figmaScreenshot,
    fidelityOutput: session.fidelityOutput,
    componentName: session.componentName || 'Unknown',
    nodeId: session.nodeId || null,
    operatorId: session.operatorId || null,
    createdAt: new Date().toISOString(),
  };
}
