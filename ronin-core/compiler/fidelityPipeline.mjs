// ─── compiler/fidelityPipeline.mjs ────────────────────────────────────────
// D5 Fidelity Pipeline Orchestrator — CAPSTONE
//
// Orchestrates the complete Figma→Code fidelity pipeline (Stages 0-4).
// Stages 0-1 are deterministic, Stage 2 is LLM (Sonnet), Stage 3 is visual regression (Haiku).
//
// Pipeline invariants (from RONIN_DESIGN_INTELLIGENCE.md §4):
// — Stage 1 never calls a model. Always deterministic.
// — Stage 2 never changes numeric CSS values.
// — Stage 3 compares visual output against Figma screenshot.
// — Retries max 2 times if diff > threshold. If still failing, deliver honest score.
// — Operator always receives output. Score always shown.
// ─────────────────────────────────────────────────────────────────────────

import { validateNode, normalizeNode } from './figmaNodeAdapter.mjs';
import { compileTree } from './figmaToAbsoluteCSS.mjs';
import { runSemanticPass, identifySafeFlexConversions, consolidateColors } from './semanticPass.mjs';
import { checkFidelity, formatFidelityBadge, calculateFidelityScore } from './visualRegression.mjs';

// ─── Session Management ───────────────────────────────────────────────────

/**
 * Create a new pipeline session to track state across all stages
 * @param {string} operatorId - optional operator identifier
 * @returns {Object} session object
 */
export function createPipelineSession(operatorId) {
  return {
    operatorId: operatorId || null,
    createdAt: new Date().toISOString(),
    stageResults: {},
    timings: {},
    errors: {},
    retryCount: 0,
    totalTimeStart: Date.now(),
  };
}

// ─── Stage 0: Context Capture ────────────────────────────────────────────

/**
 * Stage 0: Validate and capture context (screenshot + node tree)
 * ~50ms
 * @param {Object} input - { nodeTree, screenshot }
 * @returns {Object} stage0 result
 */
export function runStage0(input) {
  const startTime = Date.now();

  if (!input || typeof input !== 'object') {
    throw new Error('Stage 0: input must be an object');
  }

  const { nodeTree, screenshot } = input;

  // Validate nodeTree
  if (!nodeTree || typeof nodeTree !== 'object') {
    throw new Error('Stage 0: nodeTree is required');
  }

  const validation = validateNode(nodeTree);
  if (!validation.valid) {
    throw new Error(`Stage 0: nodeTree validation failed: ${validation.errors.join('; ')}`);
  }

  // Validate screenshot
  if (!screenshot) {
    throw new Error('Stage 0: screenshot is required');
  }

  // Normalize the node tree
  const normalized = normalizeNode(nodeTree);

  // Count nodes
  let nodeCount = 0;
  function countNodes(node) {
    nodeCount++;
    if (node.children && Array.isArray(node.children)) {
      node.children.forEach(child => countNodes(child));
    }
  }
  countNodes(normalized);

  const timeMs = Date.now() - startTime;

  return {
    screenshot,
    nodeTree: normalized,
    nodeCount,
    timestamp: new Date().toISOString(),
    timeMs,
  };
}

// ─── Stage 1: Deterministic Compiler ─────────────────────────────────────

/**
 * Stage 1: Compile node tree to CSS (zero LLM, deterministic)
 * ~100ms
 * @param {Object} nodeTree - normalized Figma node tree
 * @returns {Object} stage1 result with compiledCSS map
 */
export function runStage1(nodeTree) {
  const startTime = Date.now();

  if (!nodeTree || typeof nodeTree !== 'object') {
    throw new Error('Stage 1: nodeTree is required');
  }

  try {
    const compiledCSS = compileTree(nodeTree);
    const timeMs = Date.now() - startTime;

    return {
      compiledCSS,
      nodeCount: compiledCSS.size,
      compileTimeMs: timeMs,
    };
  } catch (error) {
    throw new Error(`Stage 1 compilation failed: ${error.message}`);
  }
}

// ─── Stage 1.5: Optional Interpreter (Seat 7) ────────────────────────────

/**
 * Stage 1.5: Optional design interpretation by Seat 7 (Sonnet with vision)
 * ~800ms
 * Reads design intent from Figma screenshot + layer hierarchy
 * Returns null if no provider, otherwise returns interpretation object
 * @param {Object} nodeTree - Figma node tree
 * @param {Buffer|string} screenshot - Figma screenshot
 * @param {Function} provider - optional async (systemPrompt, userPrompt) => string
 * @returns {Object|null} interpretation or null
 */
export async function runStage1_5(nodeTree, screenshot, provider) {
  if (!provider) {
    return null;
  }

  const startTime = Date.now();

  if (!nodeTree || !screenshot) {
    return null;
  }

  try {
    // Build prompt for design interpretation
    const systemPrompt = `You are reading a designer's visual intention.
You are not a translator. You are reading design intent from a Figma screenshot.
Extract the emotional register, primary metaphor, implied motion, hierarchy strategy,
component role, designer intent, and interaction vocabulary.
Return a JSON object with these fields:
{
  "emotional_register": "string — formal/casual/playful/etc",
  "primary_metaphor": "string — the core design concept",
  "motion_implied": "string — what motion does the design suggest",
  "hierarchy_strategy": "string — how is hierarchy communicated",
  "component_role": "string — is this primary/secondary/supporting",
  "designer_intent": "string — what is the designer asking the user to feel",
  "interaction_vocabulary": "string — what interactions does it imply"
}`;

    // Build layer hierarchy string
    function buildHierarchy(node, depth = 0) {
      const indent = '  '.repeat(depth);
      let lines = [`${indent}${node.name} (${node.type})`];
      if (node.children && Array.isArray(node.children)) {
        node.children.forEach(child => {
          lines = lines.concat(buildHierarchy(child, depth + 1));
        });
      }
      return lines;
    }

    const hierarchyStr = buildHierarchy(nodeTree).join('\n');

    const userPrompt = `Figma design screenshot (design context): [provided as image]

Layer hierarchy:
\`\`\`
${hierarchyStr}
\`\`\`

Analyze the design and extract the interpretation fields.
Return only the JSON object, no explanation.`;

    // Call provider
    let response = await provider(systemPrompt, userPrompt);

    // Extract JSON if response is wrapped in code block
    if (typeof response === 'string') {
      const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        response = jsonMatch[1];
      }
      try {
        response = JSON.parse(response);
      } catch {
        // If parse fails, return raw string as interpretation
        return { raw: response };
      }
    }

    const timeMs = Date.now() - startTime;

    return {
      ...response,
      timeMs,
    };
  } catch (error) {
    // Stage 1.5 is optional; return null on error
    console.warn(`Stage 1.5 interpretation failed: ${error.message}`);
    return null;
  }
}

// ─── Stage 2: Semantic Pass ──────────────────────────────────────────────

/**
 * Stage 2: Semantic pass (Sonnet wraps CSS into React components)
 * ~800ms
 * @param {Map} compiledCSS - stage 1 output
 * @param {Object} nodeTree - Figma node tree
 * @param {Object|null} interpretation - stage 1.5 output (optional)
 * @param {Function} provider - async (systemPrompt, userPrompt) => string|object
 * @returns {Object} stage2 result with code, componentNames, customProperties, etc.
 */
export async function runStage2(compiledCSS, nodeTree, interpretation, provider) {
  const startTime = Date.now();

  if (!compiledCSS || !(compiledCSS instanceof Map)) {
    throw new Error('Stage 2: compiledCSS must be a Map');
  }
  if (!nodeTree || typeof nodeTree !== 'object') {
    throw new Error('Stage 2: nodeTree is required');
  }
  if (!provider || typeof provider !== 'function') {
    throw new Error('Stage 2: provider function is required');
  }

  try {
    const options = {
      interpretation: interpretation ? JSON.stringify(interpretation) : undefined,
      provider,
    };

    const result = await runSemanticPass(compiledCSS, nodeTree, options);
    const timeMs = Date.now() - startTime;

    return {
      ...result,
      timeMs,
    };
  } catch (error) {
    throw new Error(`Stage 2 semantic pass failed: ${error.message}`);
  }
}

// ─── Stage 3: Visual Regression Check ────────────────────────────────────

/**
 * Stage 3: Visual regression check (Haiku analyzes pixel diff)
 * ~400ms per check, plus retry time
 * @param {Buffer|string} figmaScreenshot - original Figma export
 * @param {string} componentCode - React component code from Stage 2
 * @param {Object} options
 * @returns {Object} stage3 result with pass, score, diffPercent, retryCount
 */
export async function runStage3(figmaScreenshot, componentCode, options = {}) {
  const startTime = Date.now();

  if (!figmaScreenshot) {
    throw new Error('Stage 3: figmaScreenshot is required');
  }
  if (!componentCode || typeof componentCode !== 'string') {
    throw new Error('Stage 3: componentCode is required');
  }

  const {
    renderer,
    comparator,
    diffAnalyzer,
    maxRetries = 2,
    fidelityThreshold = 2.0,
  } = options;

  let retryCount = 0;
  let lastResult = null;

  try {
    // First pass
    lastResult = await checkFidelity(figmaScreenshot, componentCode, {
      renderer,
      comparator,
      viewport: options.viewport || { width: 1440, height: 900 },
      scale: options.scale || 2,
      threshold: fidelityThreshold,
    });

    // Retry loop if needed
    while (!lastResult.pass && retryCount < maxRetries && diffAnalyzer) {
      retryCount++;

      // Get corrections from Haiku
      // (In a real implementation, this would call the diff analyzer with screenshots)
      // For now, we just increment retry and note the attempt
      // The real implementation would:
      // 1. Build diff analysis prompt with Figma screenshot, rendered screenshot, diff image
      // 2. Call diffAnalyzer to get corrections
      // 3. Apply corrections to componentCode
      // 4. Re-run checkFidelity

      // Mock behavior: just continue with same code for testing
      lastResult = await checkFidelity(figmaScreenshot, componentCode, {
        renderer,
        comparator,
        viewport: options.viewport || { width: 1440, height: 900 },
        scale: options.scale || 2,
        threshold: fidelityThreshold,
      });
    }

    const timeMs = Date.now() - startTime;

    return {
      pass: lastResult.pass,
      score: lastResult.score,
      diffPercent: lastResult.diffPercent,
      diffImage: lastResult.diffImage || null,
      diffRegions: lastResult.diffRegions || [],
      retryCount,
      timeMs,
      metadata: lastResult.metadata,
    };
  } catch (error) {
    // Stage 3 failure is not fatal; return error result with score 0
    const timeMs = Date.now() - startTime;
    return {
      pass: false,
      score: 0,
      diffPercent: 100,
      diffImage: null,
      diffRegions: [],
      retryCount,
      timeMs,
      error: error.message,
    };
  }
}

// ─── Stage 4: Output Assembly ────────────────────────────────────────────

/**
 * Stage 4: Assemble final output (code + fidelity badge + diff image)
 * @param {Object} session - pipeline session with all stage results
 * @returns {Object} output object with code, fidelityScore, fidelityBadge, etc.
 */
export function assembleOutput(session) {
  const stage2 = session.stageResults.stage2 || {};
  const stage3 = session.stageResults.stage3 || {};

  const code = stage2.code || '';
  const fidelityScore = stage3.score || 0;
  const fidelityBadge = formatFidelityBadge(fidelityScore).badge;
  const diffImage = stage3.diffImage || null;
  const componentNames = stage2.componentNames || [];
  const customProperties = stage2.customProperties || {};

  return {
    code,
    fidelityScore,
    fidelityBadge,
    diffImage,
    componentNames,
    customProperties,
  };
}

// ─── Cost Estimation ─────────────────────────────────────────────────────

/**
 * Estimate pipeline cost based on stage timings and token usage
 * Stage costs (from RONIN_DESIGN_INTELLIGENCE.md §8):
 * - Stage 1: $0.00 (no LLM)
 * - Stage 1.5: ~$0.003 (Sonnet vision)
 * - Stage 2: ~$0.004 (Sonnet)
 * - Stage 3: ~$0.001 per check (Haiku)
 * - Per retry: ~$0.003 (Sonnet re-run)
 *
 * @param {Object} stageTimings - { stage1_5: ms, stage2: ms, stage3: ms }
 * @param {Object} tokenUsage - { input: count, output: count }
 * @param {number} retryCount - number of retries
 * @returns {number} estimated cost in USD
 */
export function estimateCost(stageTimings = {}, tokenUsage = {}, retryCount = 0) {
  let cost = 0;

  // Stage 0: $0.00
  // Stage 1: $0.00

  // Stage 1.5: Sonnet vision (~0.003)
  if (stageTimings.stage1_5 > 0) {
    cost += 0.003;
  }

  // Stage 2: Sonnet semantic pass (~0.004)
  if (stageTimings.stage2 > 0) {
    cost += 0.004;
  }

  // Stage 3: Haiku diff check (~0.001 per check)
  if (stageTimings.stage3 > 0) {
    cost += 0.001;
  }

  // Retries: ~0.003 per retry (Sonnet re-run)
  cost += retryCount * 0.003;

  // Token overages (if provided)
  const inputTokens = tokenUsage.input || 0;
  const outputTokens = tokenUsage.output || 0;
  if (inputTokens > 0 || outputTokens > 0) {
    // Rough estimate: $0.000003 per input token, $0.000012 per output token (Sonnet pricing)
    cost += (inputTokens * 0.000003) + (outputTokens * 0.000012);
  }

  return Math.round(cost * 100000) / 100000; // Round to 5 decimals
}

// ─── Pipeline Configuration ──────────────────────────────────────────────

/**
 * Get current pipeline configuration
 * @returns {Object} config object with defaults
 */
export function getPipelineConfig() {
  return {
    stages: {
      stage0: { name: 'Context capture', timeoutMs: 1000 },
      stage1: { name: 'Deterministic compiler', timeoutMs: 500 },
      stage1_5: { name: 'Interpreter (optional)', timeoutMs: 2000 },
      stage2: { name: 'Semantic pass', timeoutMs: 2000 },
      stage3: { name: 'Visual regression', timeoutMs: 2000 },
      stage4: { name: 'Output assembly', timeoutMs: 500 },
    },
    defaults: {
      maxRetries: 2,
      fidelityThreshold: 2.0,
      viewport: { width: 1440, height: 900 },
      scale: 2,
      skipDiffCheck: false,
    },
  };
}

// ─── Main Entry Point ────────────────────────────────────────────────────

/**
 * Run the complete fidelity pipeline (Stages 0-4)
 *
 * @param {Object} input
 * @param {Object} input.nodeTree - Figma node tree
 * @param {Buffer|string} input.screenshot - Figma screenshot
 * @param {string} input.operatorId - optional operator identifier
 *
 * @param {Object} options
 * @param {Function} options.semanticProvider - async (systemPrompt, userPrompt) => string
 * @param {Function} options.diffAnalyzer - async (systemPrompt, userPrompt) => string
 * @param {Function} options.renderer - async (code, viewport, scale) => Buffer
 * @param {Function} options.comparator - async (screenshotA, screenshotB) => { diffPercent, regions, diffImage }
 * @param {Function} options.interpreter - async (systemPrompt, userPrompt) => string
 * @param {number} options.maxRetries - default 2
 * @param {number} options.fidelityThreshold - default 2.0 (percent)
 * @param {boolean} options.skipDiffCheck - skip Stage 3 for testing
 *
 * @returns {Object} complete pipeline result with all stage outputs and final output
 */
export async function runFidelityPipeline(input, options = {}) {
  const session = createPipelineSession(input.operatorId);
  const pipelineStart = Date.now();

  try {
    // ─── Stage 0: Context Capture ───────────────────────────────────────
    let stage0;
    try {
      stage0 = runStage0(input);
      session.stageResults.stage0 = stage0;
      session.timings.stage0 = stage0.timeMs;
    } catch (error) {
      session.errors.stage0 = error.message;
      throw error;
    }

    // ─── Stage 1: Deterministic Compiler ────────────────────────────────
    let stage1;
    try {
      stage1 = runStage1(stage0.nodeTree);
      session.stageResults.stage1 = stage1;
      session.timings.stage1 = stage1.compileTimeMs;
    } catch (error) {
      session.errors.stage1 = error.message;
      throw error;
    }

    // ─── Stage 1.5: Optional Interpreter ────────────────────────────────
    let stage1_5 = null;
    if (options.interpreter) {
      try {
        stage1_5 = await runStage1_5(stage0.nodeTree, stage0.screenshot, options.interpreter);
        if (stage1_5) {
          session.stageResults.stage1_5 = stage1_5;
          session.timings.stage1_5 = stage1_5.timeMs || 0;
        }
      } catch (error) {
        session.errors.stage1_5 = error.message;
        // Stage 1.5 is optional; don't throw
      }
    }

    // ─── Stage 2: Semantic Pass ─────────────────────────────────────────
    let stage2;
    try {
      if (!options.semanticProvider) {
        throw new Error('semanticProvider is required');
      }
      stage2 = await runStage2(
        stage1.compiledCSS,
        stage0.nodeTree,
        stage1_5,
        options.semanticProvider
      );
      session.stageResults.stage2 = stage2;
      session.timings.stage2 = stage2.timeMs;
    } catch (error) {
      session.errors.stage2 = error.message;
      // Stage 2 failure is not fatal; continue with partial output
      stage2 = {
        code: '',
        componentNames: [],
        customProperties: {},
        flexConversions: 0,
        tokenUsage: { input: 0, output: 0 },
        valid: false,
        validationIssues: [error.message],
        timeMs: 0,
      };
      session.stageResults.stage2 = stage2;
      session.timings.stage2 = 0;
    }

    // ─── Stage 3: Visual Regression Check ────────────────────────────────
    let stage3;
    try {
      if (options.skipDiffCheck) {
        // Skip Stage 3 (for testing)
        stage3 = {
          pass: true,
          score: 100,
          diffPercent: 0,
          diffImage: null,
          diffRegions: [],
          retryCount: 0,
          timeMs: 0,
          metadata: {},
        };
      } else {
        if (!options.renderer || !options.comparator) {
          throw new Error('renderer and comparator are required for Stage 3');
        }
        stage3 = await runStage3(stage0.screenshot, stage2.code, {
          renderer: options.renderer,
          comparator: options.comparator,
          diffAnalyzer: options.diffAnalyzer,
          maxRetries: options.maxRetries || 2,
          fidelityThreshold: options.fidelityThreshold || 2.0,
          viewport: options.viewport,
          scale: options.scale,
        });
      }
      session.stageResults.stage3 = stage3;
      session.timings.stage3 = stage3.timeMs;
      session.retryCount = stage3.retryCount || 0;
    } catch (error) {
      session.errors.stage3 = error.message;
      // Stage 3 failure is not fatal; return with score 0
      stage3 = {
        pass: false,
        score: 0,
        diffPercent: 100,
        diffImage: null,
        diffRegions: [],
        retryCount: 0,
        timeMs: 0,
        error: error.message,
      };
      session.stageResults.stage3 = stage3;
      session.timings.stage3 = 0;
    }

    // ─── Stage 4: Output Assembly ───────────────────────────────────────
    const output = assembleOutput(session);

    // ─── Calculate Metadata ─────────────────────────────────────────────
    const totalTimeMs = Date.now() - pipelineStart;
    const tokenUsage = {
      input: stage2.tokenUsage?.input || 0,
      output: stage2.tokenUsage?.output || 0,
    };
    const costEstimate = estimateCost(session.timings, tokenUsage, session.retryCount);

    const metadata = {
      totalTimeMs,
      stageTimings: session.timings,
      retryCount: session.retryCount,
      tokenUsage,
      costEstimate,
    };

    // ─── Success ────────────────────────────────────────────────────────
    const success = Object.keys(session.errors).length === 0;

    return {
      stage0,
      stage1,
      stage1_5,
      stage2,
      stage3,
      output,
      metadata,
      success,
    };
  } catch (error) {
    // Fatal error (Stage 0 or 1 failed)
    const totalTimeMs = Date.now() - pipelineStart;
    return {
      output: {
        code: '',
        fidelityScore: 0,
        fidelityBadge: '○○○○○ 0% match',
        diffImage: null,
        componentNames: [],
        customProperties: {},
      },
      metadata: {
        totalTimeMs,
        stageTimings: session.timings,
        retryCount: 0,
        tokenUsage: { input: 0, output: 0 },
        costEstimate: 0,
      },
      success: false,
      error: error.message,
    };
  }
}
