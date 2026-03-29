// ─── director/directorPipeline.mjs ──────────────────────────────────────────
// D10 · Director Pipeline Orchestrator — CAPSTONE
//
// Orchestrates the full Creative Director flow end-to-end:
// 1. Load taste snapshot for operator
// 2. Assemble Director context (screenshot + hierarchy + taste + fidelity code)
// 3. Call Opus Creative Director
// 4. Parse response → extract KEPT/CHANGED/CODE
// 5. Extract creative decisions from CHANGED section
// 6. Store creative decisions as pending taste signals
// 7. Deliver side-by-side result
//
// Director pipeline invariant:
// — The Director is activated by operator explicitly. Never auto-triggered.
// — The Director NEVER modifies fidelity output. Produces parallel creative expression.
// — Taste memory accumulates from operator actions — not model preferences.
// — The fidelity score is always shown. Never hidden.
// ─────────────────────────────────────────────────────────────────────────

import crypto from 'crypto';
import {
  buildTasteContextString,
  assembleDirectorContext,
  parseDirectorResponse,
  validateDirectorOutput,
  extractCreativeDecisions,
  runDirector,
} from './creativeDirector.mjs';
import {
  captureApproval,
  captureRejection,
  captureModification,
  captureVerbal,
  computeSemanticDiff,
} from './tasteCapture.mjs';

// ─── Helper: Generate unique session ID ──────────────────────────────────────

function generateSessionId() {
  return `dir_${crypto.randomBytes(8).toString('hex')}`;
}

// ─── 1. createDirectorSession ────────────────────────────────────────────────

/**
 * Create a Director session from a completed fidelity pipeline result
 *
 * @param {Object} fidelityResult - the complete fidelity pipeline result
 * @param {string} operatorId - operator identifier
 * @returns {Object} DirectorSession
 */
export function createDirectorSession(fidelityResult, operatorId) {
  if (!fidelityResult || typeof fidelityResult !== 'object') {
    throw new Error('createDirectorSession: fidelityResult is required');
  }

  if (!operatorId || typeof operatorId !== 'string') {
    throw new Error('createDirectorSession: operatorId is required');
  }

  return {
    id: generateSessionId(),
    operatorId,
    status: 'ready',
    fidelityResult,
    directorResult: null,
    creativeDecisions: [],
    pendingSignals: [],
    startedAt: null,
    completedAt: null,
    cost: {
      fidelity: fidelityResult.metadata?.costEstimate || 0,
      director: 0,
      total: fidelityResult.metadata?.costEstimate || 0,
    },
  };
}

// ─── 2. runDirectorPipeline ─────────────────────────────────────────────────

/**
 * Execute the full Director pipeline
 *
 * @param {Object} session - DirectorSession (must have status 'ready')
 * @param {Object} options
 *   - directorProvider: async function to call Opus
 *   - tasteStore: taste signal store (for loading snapshot)
 *   - narrativeProvider: async function to generate narrative (optional)
 *   - timeout: max time in ms (default: 60000)
 * @returns {Promise<Object>} updated DirectorSession
 */
export async function runDirectorPipeline(session, options = {}) {
  if (!session || typeof session !== 'object') {
    throw new Error('runDirectorPipeline: session is required');
  }

  if (session.status !== 'ready') {
    throw new Error(`runDirectorPipeline: session status is ${session.status}, must be 'ready'`);
  }

  if (!session.fidelityResult) {
    throw new Error('runDirectorPipeline: session.fidelityResult is required');
  }

  const {
    directorProvider,
    tasteStore,
    narrativeProvider,
    timeout = 60000,
  } = options;

  if (!directorProvider || typeof directorProvider !== 'function') {
    throw new Error('runDirectorPipeline: directorProvider function is required');
  }

  // Update session status
  session.status = 'running';
  session.startedAt = new Date().toISOString();

  try {
    // ─── Step 1: Load taste snapshot ─────────────────────────────────────
    let tasteSnapshot = null;
    if (tasteStore && typeof tasteStore.getSnapshot === 'function') {
      try {
        tasteSnapshot = tasteStore.getSnapshot(session.operatorId);
      } catch (error) {
        // Taste store error is not fatal; continue with null snapshot
        console.warn(`Failed to load taste snapshot: ${error.message}`);
      }
    }

    // ─── Step 2: Assemble Director context ───────────────────────────────
    const fidelityOutput = session.fidelityResult.output || {};
    const stage0 = session.fidelityResult.stage0 || {};
    const stage1_5 = session.fidelityResult.stage1_5;

    const directorSession = {
      figmaScreenshot: stage0.screenshot || '',
      layerHierarchy: buildLayerHierarchy(stage0.nodeTree),
      tasteSnapshot,
      fidelityCode: fidelityOutput.code || '',
      interpretation: stage1_5 || undefined,
    };

    // ─── Step 3: Call Director (Opus) ────────────────────────────────────
    let directorResult;
    try {
      directorResult = await Promise.race([
        runDirector(directorSession, {
          provider: directorProvider,
          timeout,
          maxTokens: 3000,
        }),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`Director timeout after ${timeout}ms`)),
            timeout
          )
        ),
      ]);
    } catch (error) {
      session.status = 'failed';
      session.completedAt = new Date().toISOString();
      throw new Error(`Director execution failed: ${error.message}`);
    }

    session.directorResult = directorResult;
    session.cost.director = directorResult.costEstimate || 0;
    session.cost.total = session.cost.fidelity + session.cost.director;

    // ─── Step 4: Parse creative decisions ────────────────────────────────
    const creativeDecisions = extractCreativeDecisions(directorResult.changed || '');
    session.creativeDecisions = creativeDecisions;

    // ─── Step 5: Create pending taste signals ────────────────────────────
    const pendingSignals = creativeDecisions.map((decision) => ({
      id: `sig_${crypto.randomBytes(4).toString('hex')}`,
      timestamp: new Date().toISOString(),
      operatorId: session.operatorId,
      gate: 'figma',
      signal_type: 'pending', // Will be converted to approval/rejection/modification based on operator action
      subject: {
        type: 'creative_direction',
        description: decision.description,
        value: decision.reason,
      },
      operator_action: {},
      project: 'unknown',
      component_type: 'unknown',
      design_register: 'unknown',
      decision: decision, // Keep original decision for later processing
    }));

    session.pendingSignals = pendingSignals;

    // ─── Step 6: Update status ───────────────────────────────────────────
    session.status = 'complete';
    session.completedAt = new Date().toISOString();

    return session;
  } catch (error) {
    session.status = 'failed';
    session.completedAt = new Date().toISOString();
    throw error;
  }
}

// ─── Helper: Build layer hierarchy ───────────────────────────────────────────

function buildLayerHierarchy(nodeTree, depth = 0) {
  if (!nodeTree) return [];

  const hierarchy = [];

  function traverse(node, currentDepth = 0) {
    hierarchy.push({
      id: node.id || `node_${crypto.randomBytes(4).toString('hex')}`,
      name: node.name || 'Unnamed',
      type: node.type || 'UNKNOWN',
      depth: currentDepth,
    });

    if (node.children && Array.isArray(node.children)) {
      node.children.forEach(child => traverse(child, currentDepth + 1));
    }
  }

  traverse(nodeTree);
  return hierarchy;
}

// ─── 3. handleOperatorAction ────────────────────────────────────────────────

/**
 * Process operator's response to Director output
 *
 * @param {Object} session - DirectorSession (must have status 'complete')
 * @param {Object} action - { type, modifiedCode?, selectedDecisions? }
 *   - type: 'accept' | 'reject' | 'modify' | 'cherry_pick'
 *   - modifiedCode: (for 'modify') the operator's edited code
 *   - selectedDecisions: (for 'cherry_pick') array of decision indices to accept
 * @param {Object} options
 *   - tasteStore: taste signal store (for storing signals)
 * @returns {Object} { signals: TasteSignal[], sessionUpdated: DirectorSession }
 */
export function handleOperatorAction(session, action, options = {}) {
  if (!session || typeof session !== 'object') {
    throw new Error('handleOperatorAction: session is required');
  }

  if (!action || typeof action !== 'object') {
    throw new Error('handleOperatorAction: action is required');
  }

  if (!['accept', 'reject', 'modify', 'cherry_pick'].includes(action.type)) {
    throw new Error(`handleOperatorAction: invalid action type '${action.type}'`);
  }

  if (session.status !== 'complete') {
    throw new Error(`handleOperatorAction: session status is ${session.status}, must be 'complete'`);
  }

  const { tasteStore } = options;
  const signals = [];

  // Get the fidelity code and director code
  const fidelityCode = session.fidelityResult?.output?.code || '';
  const directorCode = session.directorResult?.code || '';

  // ─── Process based on action type ────────────────────────────────────
  if (action.type === 'accept') {
    // Convert all pending signals to approval signals
    for (const pending of session.pendingSignals) {
      const signal = {
        ...pending,
        signal_type: 'approval',
        operator_action: {
          accepted: true,
        },
      };
      delete signal.decision; // Clean up helper field
      signals.push(signal);
    }
  } else if (action.type === 'reject') {
    // Convert all pending signals to rejection signals
    for (const pending of session.pendingSignals) {
      const signal = {
        ...pending,
        signal_type: 'rejection',
        operator_action: {
          accepted: false,
        },
      };
      delete signal.decision;
      signals.push(signal);
    }
  } else if (action.type === 'modify') {
    // Diff director code vs modified code → create modification signals
    if (!action.modifiedCode || typeof action.modifiedCode !== 'string') {
      throw new Error('handleOperatorAction: action.modifiedCode is required for "modify" type');
    }

    const diff = computeSemanticDiff(directorCode, action.modifiedCode);

    for (const change of diff.changes) {
      const signal = {
        id: `sig_${crypto.randomBytes(4).toString('hex')}`,
        timestamp: new Date().toISOString(),
        operatorId: session.operatorId,
        gate: 'figma',
        signal_type: 'modification',
        subject: {
          type: 'creative_direction',
          description: `Property modified: ${change.property}`,
          value: change.newValue,
        },
        operator_action: {
          modified_to: change.newValue,
        },
        project: 'unknown',
        component_type: 'unknown',
        design_register: 'unknown',
      };
      signals.push(signal);
    }

    // Also add approval for unchanged pending signals
    if (diff.changes.length === 0) {
      for (const pending of session.pendingSignals) {
        const signal = {
          ...pending,
          signal_type: 'approval',
          operator_action: {
            accepted: true,
          },
        };
        delete signal.decision;
        signals.push(signal);
      }
    }
  } else if (action.type === 'cherry_pick') {
    // Accept selected decisions, reject others
    if (!Array.isArray(action.selectedDecisions)) {
      throw new Error('handleOperatorAction: action.selectedDecisions must be an array');
    }

    for (let i = 0; i < session.pendingSignals.length; i++) {
      const pending = session.pendingSignals[i];
      const isSelected = action.selectedDecisions.includes(i);

      const signal = {
        ...pending,
        signal_type: isSelected ? 'approval' : 'rejection',
        operator_action: {
          accepted: isSelected,
        },
      };
      delete signal.decision;
      signals.push(signal);
    }
  }

  // ─── Store signals if tasteStore provided ────────────────────────────
  if (tasteStore && typeof tasteStore.add === 'function') {
    for (const signal of signals) {
      try {
        tasteStore.add(signal);
      } catch (error) {
        console.warn(`Failed to store signal: ${error.message}`);
      }
    }
  }

  return {
    signals,
    sessionUpdated: session,
  };
}

// ─── 4. getSessionSummary ───────────────────────────────────────────────────

/**
 * Get a human-readable session summary
 *
 * @param {Object} session - DirectorSession
 * @returns {Object} summary with status, fidelityScore, decisionCount, etc.
 */
export function getSessionSummary(session) {
  if (!session || typeof session !== 'object') {
    throw new Error('getSessionSummary: session is required');
  }

  const fidelityScore = session.fidelityResult?.output?.fidelityScore || 0;
  const fidelityResult = session.fidelityResult || {};
  const directorResult = session.directorResult || {};

  // Extract previews
  const kept = directorResult.kept ? directorResult.kept.substring(0, 200) : '';
  const changedPreview = directorResult.changed ? directorResult.changed.substring(0, 200) : '';

  // Calculate latency
  const latencyMs = session.completedAt && session.startedAt
    ? new Date(session.completedAt).getTime() - new Date(session.startedAt).getTime()
    : 0;

  return {
    status: session.status,
    fidelityScore: Math.round(fidelityScore * 10) / 10,
    directorDecisionCount: session.creativeDecisions.length,
    kept,
    changedPreview,
    cost: {
      fidelity: Math.round(session.cost.fidelity * 100000) / 100000,
      director: Math.round(session.cost.director * 100000) / 100000,
      total: Math.round(session.cost.total * 100000) / 100000,
    },
    latencyMs,
  };
}

// ─── 5. formatSideBySide ────────────────────────────────────────────────────

/**
 * Format the side-by-side output structure for UI delivery
 *
 * @param {Object} session - DirectorSession
 * @returns {Object} { exact, director } panels
 */
export function formatSideBySide(session) {
  if (!session || typeof session !== 'object') {
    throw new Error('formatSideBySide: session is required');
  }

  const fidelityOutput = session.fidelityResult?.output || {};
  const directorResult = session.directorResult || {};

  const fidelityScore = fidelityOutput.fidelityScore || 0;
  const fidelityBadge = fidelityOutput.fidelityBadge || '○○○○○ 0% match';
  const scorePercent = Math.round(fidelityScore * 10) / 10;

  return {
    exact: {
      label: 'EXACT',
      score: `${scorePercent}% match`,
      code: fidelityOutput.code || '',
      actions: ['copy', 'preview'],
    },
    director: {
      label: "DIRECTOR'S CUT",
      kept: directorResult.kept || '',
      changed: directorResult.changed || '',
      code: directorResult.code || '',
      actions: ['copy', 'preview'],
    },
  };
}

// ─── 6. calculatePipelineCost ───────────────────────────────────────────────

/**
 * Calculate detailed cost breakdown for the full pipeline
 *
 * @param {Object} session - DirectorSession
 * @returns {Object} { fidelity, director, total, breakdown }
 */
export function calculatePipelineCost(session) {
  if (!session || typeof session !== 'object') {
    throw new Error('calculatePipelineCost: session is required');
  }

  const fidelityCost = session.cost.fidelity || 0;
  const directorCost = session.cost.director || 0;
  const totalCost = fidelityCost + directorCost;

  const breakdown = [
    `Fidelity pipeline: $${fidelityCost.toFixed(5)}`,
    `Director invocation: $${directorCost.toFixed(5)}`,
    `─────────────────────────────`,
    `Total: $${totalCost.toFixed(5)}`,
  ].join('\n');

  return {
    fidelity: Math.round(fidelityCost * 100000) / 100000,
    director: Math.round(directorCost * 100000) / 100000,
    total: Math.round(totalCost * 100000) / 100000,
    breakdown,
  };
}

// ─── 7. createMockDirectorProvider ──────────────────────────────────────────

/**
 * Create a mock Director provider for testing
 *
 * @param {string|Object} response - the response to return
 * @returns {Function} async function that returns the response
 */
export function createMockDirectorProvider(response) {
  if (!response) {
    throw new Error('createMockDirectorProvider: response is required');
  }

  return async (options) => {
    return typeof response === 'string' ? response : JSON.stringify(response);
  };
}
