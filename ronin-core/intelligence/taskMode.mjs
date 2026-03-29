// ─── intelligence/taskMode.mjs ──────────────────────────────────────────────
// RONIN Task Mode Engine (V2) — context-aware behavioral adaptation
//
// Purpose: Detect the operator's current task and adapt RONIN's posture
// (response structure, depth, abstraction, tone, verbosity, suggestion density).
//
// Architecture: 8 task modes, each with triggers, response style, and system
// prompt modifiers. Mode detection scores trigger matches and applies stickiness
// to prevent thrashing.
//
// Design Principle: Task modes change HOW we respond, not WHAT we think.
// Core persona (voice schema) remains invariant across all modes.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Mode Definitions ────────────────────────────────────────────────────────

const MODES = [
  {
    id: 'tactical',
    name: 'Tactical',
    posture: 'Direct, execution-focused action',
    triggers: [
      'how do i',
      'fix this',
      'make it work',
      'implement',
      'what do i do',
      'need to',
      'can you',
      'help me',
      'do this',
      'build',
      'deploy',
      'now',
      'urgent',
      'quick',
    ],
    responseStyle: {
      verbosity: 'terse',
      structure: 'minimal',
      abstraction: 'concrete',
      toneSharpness: 'sharp',
      suggestionDensity: 'high',
      depth: 'surface',
    },
    systemPromptModifier:
      'You are in TACTICAL mode. The operator needs action, now. ' +
      'Lead with the diagnosis, then immediate next steps. Skip philosophy. ' +
      'One clear recommendation. Assume technical competence unless shown otherwise.',
  },

  {
    id: 'architect',
    name: 'Architect',
    posture: 'Systems thinking, tradeoffs, structure',
    triggers: [
      'design',
      'architecture',
      'architect',
      'system',
      'tradeoffs',
      'scale',
      'structure',
      'pattern',
      'approach',
      'should we',
      'which one',
      'pros and cons',
      'how do you',
      'best way',
      'sustainable',
      'long-term',
    ],
    responseStyle: {
      verbosity: 'expansive',
      structure: 'heavy',
      abstraction: 'balanced',
      toneSharpness: 'neutral',
      suggestionDensity: 'moderate',
      depth: 'deep',
    },
    systemPromptModifier:
      'You are in ARCHITECT mode. The operator is thinking systems. ' +
      'Frame the problem space, present architecture options with tradeoffs, ' +
      'discuss long-term implications. Show the reasoning, not just the answer.',
  },

  {
    id: 'critic',
    name: 'Critic',
    posture: 'Evaluation, challenge, refinement',
    triggers: [
      'review',
      'critique',
      "what's wrong",
      'improve',
      'feedback',
      'better',
      'problem',
      'issue',
      'weakness',
      'consider',
      'think about',
      'could be',
      'evaluate',
      'assess',
    ],
    responseStyle: {
      verbosity: 'moderate',
      structure: 'heavy',
      abstraction: 'balanced',
      toneSharpness: 'sharp',
      suggestionDensity: 'moderate',
      depth: 'deep',
    },
    systemPromptModifier:
      'You are in CRITIC mode. The operator invites challenge and refinement. ' +
      'Find the weaknesses. Question assumptions. Offer specific improvements. ' +
      'Be direct. Frame critiques as opportunities, not attacks.',
  },

  {
    id: 'debug',
    name: 'Debug',
    posture: 'Stepwise reasoning, systematic elimination',
    triggers: [
      'bug',
      'error',
      'not working',
      'fails',
      'broken',
      'stack trace',
      'undefined',
      'crash',
      'why is',
      'console error',
      'doesn\'t work',
      'help debug',
      'what\'s happening',
      'investigate',
      'fix this',
      'issue',
    ],
    responseStyle: {
      verbosity: 'moderate',
      structure: 'heavy',
      abstraction: 'concrete',
      toneSharpness: 'neutral',
      suggestionDensity: 'high',
      depth: 'deep',
    },
    systemPromptModifier:
      'You are in DEBUG mode. The operator has a broken system. ' +
      'Lead with hypothesis about the root cause, then systematic steps to verify. ' +
      'Use the evidence (stack traces, code, logs) to eliminate possibilities. ' +
      'Be methodical. Explain the reasoning chain.',
  },

  {
    id: 'strategy',
    name: 'Strategy',
    posture: 'Long-term directional thinking, roadmap',
    triggers: [
      'roadmap',
      'direction',
      'long-term',
      'vision',
      'plan',
      'prioritize',
      'strategy',
      'should we',
      'what should',
      'next phase',
      'future',
      'goals',
      'where do we',
      'timeline',
      'initiative',
    ],
    responseStyle: {
      verbosity: 'expansive',
      structure: 'heavy',
      abstraction: 'abstract',
      toneSharpness: 'neutral',
      suggestionDensity: 'moderate',
      depth: 'deep',
    },
    systemPromptModifier:
      'You are in STRATEGY mode. The operator is thinking long-term. ' +
      'Present the options, discuss phasing and dependencies, ' +
      'recommend a sequencing that builds optionality. ' +
      'Help them see ahead 6-12 months, not just the next task.',
  },

  {
    id: 'reflective',
    name: 'Reflective',
    posture: 'Philosophical, pattern-aware, foundational',
    triggers: [
      'why',
      'what if',
      'meaning',
      'pattern',
      'think about',
      'philosophy',
      'principle',
      'assumption',
      'what does',
      'fundamentally',
      'essence',
      'understand',
      'explore',
      'reflect',
    ],
    responseStyle: {
      verbosity: 'expansive',
      structure: 'moderate',
      abstraction: 'abstract',
      toneSharpness: 'soft',
      suggestionDensity: 'low',
      depth: 'deep',
    },
    systemPromptModifier:
      'You are in REFLECTIVE mode. The operator is questioning fundamentals. ' +
      'Go deeper. Explore the assumptions. Connect patterns across domains. ' +
      'Be philosophical. Help them see the meta-level architecture of the problem.',
  },

  {
    id: 'explorer',
    name: 'Explorer',
    posture: 'Idea expansion, creative breadth, possibilities',
    triggers: [
      'brainstorm',
      'explore',
      'what about',
      'possibilities',
      'creative',
      'ideas',
      'if we',
      'imagine',
      'experiment',
      'try',
      'another',
      'alternative',
      'wild',
      'unconventional',
    ],
    responseStyle: {
      verbosity: 'expansive',
      structure: 'minimal',
      abstraction: 'abstract',
      toneSharpness: 'soft',
      suggestionDensity: 'high',
      depth: 'moderate',
    },
    systemPromptModifier:
      'You are in EXPLORER mode. The operator wants breadth, not depth. ' +
      'Generate possibilities. Push the edges. Question constraints. ' +
      'Say "what if" with confidence. Mix the conventional and unconventional.',
  },

  {
    id: 'builder',
    name: 'Builder',
    posture: 'Actionable clarity, step-by-step execution',
    triggers: [
      'step by step',
      'how do i build',
      'ship',
      'deploy',
      'launch',
      'create',
      'from scratch',
      'instructions',
      'guide',
      'walk me',
      'show me how',
      'start to finish',
      'setup',
      'configure',
    ],
    responseStyle: {
      verbosity: 'moderate',
      structure: 'heavy',
      abstraction: 'concrete',
      toneSharpness: 'neutral',
      suggestionDensity: 'high',
      depth: 'moderate',
    },
    systemPromptModifier:
      'You are in BUILDER mode. The operator needs to ship something. ' +
      'Break it into clear steps. Number them. Assume they will follow in order. ' +
      'Include gotchas. Explain the why for each step. Be specific.',
  },
];

// ─── Mode Adjacency Map ──────────────────────────────────────────────────────
// Modes that are conceptually close (smooth transitions).
// Used by getTransition() to determine if a mode switch should feel jarring.

const ADJACENCY_GROUPS = [
  ['tactical', 'builder'],        // action-oriented
  ['architect', 'strategy'],       // systems-oriented
  ['critic', 'debug'],             // analytical
  ['reflective', 'explorer'],      // exploratory
];

// ─── Exports ─────────────────────────────────────────────────────────────────

/**
 * Get all 8 task modes.
 * @returns {Array} MODES constant
 */
export function getModes() {
  return MODES;
}

/**
 * Detect the most appropriate task mode from an operator message.
 *
 * Algorithm:
 * 1. For each mode, count trigger matches in the message (case-insensitive).
 * 2. Weight matches by position: beginning of message = 2x, elsewhere = 1x.
 * 3. Pick the mode with highest score.
 * 4. If confidence < 0.3, return 'tactical' (RONIN default).
 * 5. If previousMode is set and confidence < 0.5, prefer stickiness.
 *
 * @param {string} message - operator's message
 * @param {Object} context - optional context
 * @param {string} context.previousMode - the mode from the last task
 * @param {Array} context.conversationHistory - past messages (unused for now)
 * @param {Object} context.operatorProfile - operator preferences (unused for now)
 * @returns {Object} {mode, confidence, signals, fallback}
 */
export function detectMode(message, context = {}) {
  if (!message || typeof message !== 'string') {
    return {
      mode: 'tactical',
      confidence: 0.0,
      signals: [],
      fallback: true,
    };
  }

  const lowerMessage = message.toLowerCase();
  const modeScores = {};

  // Score each mode
  MODES.forEach((mode) => {
    let score = 0;
    const signals = [];

    mode.triggers.forEach((trigger) => {
      const triggerLower = trigger.toLowerCase();

      // Check if message starts with the trigger (2x weight)
      if (lowerMessage.startsWith(triggerLower)) {
        score += 2.0;
        signals.push(trigger);
      }
      // Check if trigger appears in message (1x weight)
      else if (lowerMessage.includes(triggerLower)) {
        score += 1.0;
        signals.push(trigger);
      }
    });

    modeScores[mode.id] = { score, signals };
  });

  // Find highest scoring mode
  let topMode = null;
  let topScore = 0;

  Object.entries(modeScores).forEach(([modeId, { score }]) => {
    if (score > topScore) {
      topScore = score;
      topMode = modeId;
    }
  });

  // If no matches at all, topMode will be null; default to tactical
  if (!topMode) {
    return {
      mode: 'tactical',
      confidence: 0.0,
      signals: [],
      fallback: true,
    };
  }

  // Calculate confidence (0.0 → 1.0)
  // Max possible score is triggered by many matches. Normalize to ~10 expected.
  const confidence = Math.min(topScore / 5.0, 1.0);
  const signals = modeScores[topMode].signals;

  // If confidence is very low, default to tactical
  if (confidence < 0.3) {
    return {
      mode: 'tactical',
      confidence: 0.0,
      signals: [],
      fallback: true,
    };
  }

  // Mode stickiness: if previous mode exists and confidence is low-moderate,
  // prefer staying in the previous mode (modes shouldn't thrash)
  if (
    context.previousMode &&
    confidence < 0.5 &&
    Object.keys(modeScores).find((m) => m === context.previousMode)
  ) {
    return {
      mode: context.previousMode,
      confidence: confidence * 0.8, // marked as lower confidence, but sticky
      signals: signals,
      fallback: false,
    };
  }

  return {
    mode: topMode,
    confidence: Math.round(confidence * 100) / 100,
    signals: signals,
    fallback: false,
  };
}

/**
 * Get the full mode definition for a given mode ID.
 * @param {string} modeId - e.g., 'tactical', 'architect'
 * @returns {Object} the mode definition, or null if not found
 */
export function getModeConfig(modeId) {
  return MODES.find((m) => m.id === modeId) || null;
}

/**
 * Get a system prompt fragment for a given mode.
 * This fragment instructs the model how to behave in this mode.
 *
 * @param {string} modeId - e.g., 'tactical', 'architect'
 * @returns {string} system prompt fragment (3-5 sentences)
 */
export function getModePromptFragment(modeId) {
  const mode = getModeConfig(modeId);
  if (!mode) return '';
  return mode.systemPromptModifier;
}

/**
 * Get transition metadata between two modes.
 * Reports whether the modes are adjacent (smooth) or distant (jarring).
 *
 * @param {string} fromMode - e.g., 'tactical'
 * @param {string} toMode - e.g., 'architect'
 * @returns {Object} {from, to, smooth}
 */
export function getTransition(fromMode, toMode) {
  if (fromMode === toMode) {
    return { from: fromMode, to: toMode, smooth: true };
  }

  // Check if modes are in the same adjacency group
  let smooth = false;
  ADJACENCY_GROUPS.forEach((group) => {
    if (group.includes(fromMode) && group.includes(toMode)) {
      smooth = true;
    }
  });

  return { from: fromMode, to: toMode, smooth };
}
