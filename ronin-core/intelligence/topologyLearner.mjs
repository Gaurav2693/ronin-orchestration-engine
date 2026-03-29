// ─── intelligence/topologyLearner.mjs ────────────────────────────────────────
// RONIN Output Topology Learning (V4) — adaptive response shape selection.
//
// Purpose: Learn which output structures (topologies) the operator prefers,
// and adapt future responses to match those preferences.
//
// Architecture:
// - 4 output topology types, each with distinctive structural markers
// - Operator preference tracking via EMA (exponential moving average)
// - Topology selection based on mode + operator history
// - Rejection detection to signal restructuring requests
// - System prompt injection to guide model behavior
//
// Design Principle: Adapt HOW information is arranged, not WHAT is included.
// Core content remains the same; presentation shape changes per operator.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Topology Definitions ────────────────────────────────────────────────────

const TOPOLOGIES = {
  directTactical: {
    id: 'directTactical',
    name: 'Direct Tactical',
    structure: 'diagnosis → options → recommendation → next action',
    bestFor: ['tactical', 'debug', 'builder'],
    characteristics: {
      opening: 'direct answer/fix',
      format: 'short paragraphs',
      closing: 'actionable next step',
    },
    markers: [
      'starts with diagnosis or answer',
      'lists options briefly',
      'single recommendation',
      'ends with "next:" or action',
      'uses imperative verbs',
    ],
    systemPrompt:
      'Structure your response as: 1) Direct diagnosis or answer, 2) Brief option list (if applicable), ' +
      '3) Single clear recommendation, 4) Next action. Keep paragraphs short. Use imperative tone. ' +
      'Operator prefers getting to the point quickly.',
  },

  systemsView: {
    id: 'systemsView',
    name: 'Systems View',
    structure: 'framing → architecture → tradeoffs → risks → recommendation',
    bestFor: ['architect', 'strategy', 'critic'],
    characteristics: {
      opening: 'problem framing and context',
      format: 'structured with headers',
      closing: 'long-term implications',
    },
    markers: [
      'establishes context/framing',
      'discusses architecture options',
      'explicitly mentions tradeoffs',
      'addresses risks or constraints',
      'includes long-term thinking',
    ],
    systemPrompt:
      'Structure your response as: 1) Frame the problem and context, 2) Present architecture options, ' +
      '3) Discuss tradeoffs explicitly, 4) Address risks and constraints, 5) Recommend with long-term view. ' +
      'Use headers and structured formatting. Operator thinks in systems.',
  },

  creativeExploration: {
    id: 'creativeExploration',
    name: 'Creative Exploration',
    structure: 'interpretation → approaches → creative extension → feasibility',
    bestFor: ['explorer', 'reflective'],
    characteristics: {
      opening: 'reframe or interpretation',
      format: 'expansive with varied structure',
      closing: 'feasibility assessment',
    },
    markers: [
      'reframes or reinterprets question',
      'lists multiple approaches',
      'explores "what if" possibilities',
      'creative language and metaphors',
      'feasibility or implementation notes',
    ],
    systemPrompt:
      'Structure your response as: 1) Reinterpret or reframe the question, 2) Explore multiple approaches, ' +
      '3) Expand creatively (what if scenarios, alternatives), 4) Assess feasibility. ' +
      'Use varied formatting. Lean into metaphor and creative language. Operator enjoys breadth.',
  },

  reflective: {
    id: 'reflective',
    name: 'Reflective',
    structure: 'pattern recognition → meaning → implication → next move',
    bestFor: ['reflective', 'explorer'],
    characteristics: {
      opening: 'pattern observation',
      format: 'flowing prose with depth',
      closing: 'next level of understanding',
    },
    markers: [
      'identifies patterns',
      'discusses meaning or significance',
      'explores implications',
      'philosophical or foundational language',
      'ends with deeper question or direction',
    ],
    systemPrompt:
      'Structure your response as: 1) Recognize and name the pattern, 2) Explore its meaning, ' +
      '3) Discuss implications (local and systemic), 4) Suggest next level of thinking. ' +
      'Use flowing prose. Embrace philosophy and foundational thinking. Operator seeks depth.',
  },
};

// ─── Preference Tracking ──────────────────────────────────────────────────────

/**
 * Create a default topology preference object.
 * Each topology starts at 0.5 (neutral), updated via EMA.
 */
function createTopologyPreference() {
  return {
    topologyScores: {
      directTactical: 0.5,
      systemsView: 0.5,
      creativeExploration: 0.5,
      reflective: 0.5,
    },
    acceptCount: 0,             // responses accepted without complaint
    rejectCount: 0,             // responses where operator asked for restructure
    lastTopology: null,         // last topology used
    history: [],                // last 20 topology decisions [{topology, accepted, mode, timestamp}]
  };
}

// ─── Topology Detection ──────────────────────────────────────────────────────

/**
 * Analyze a response and classify which topology it follows.
 *
 * Looks for structural markers:
 * - directTactical: starts with direct answer, short paragraphs, action-oriented
 * - systemsView: framing, architecture language, tradeoffs, risks
 * - creativeExploration: multiple approaches, "what if", creative language, feasibility
 * - reflective: pattern language, meaning, implication, philosophical tone
 *
 * @param {string} response - the model's response text
 * @returns {Object} {topology: string, confidence: number, markers: string[]}
 */
function detectTopology(response) {
  if (!response || typeof response !== 'string') {
    return {
      topology: null,
      confidence: 0.0,
      markers: [],
    };
  }

  const lower = response.toLowerCase();
  const lines = response.split('\n');
  const firstLine = lines[0] || '';
  const lastLine = lines[lines.length - 1] || '';

  // Score each topology based on markers
  const scores = {};

  for (const [topologyId, topology] of Object.entries(TOPOLOGIES)) {
    let score = 0;
    const detectedMarkers = [];

    // Check for characteristic opening
    if (topologyId === 'directTactical') {
      if (/^(here's|the issue|the problem|fix:|do this|first)/i.test(firstLine)) {
        score += 3;
        detectedMarkers.push('direct opening');
      }
      if (/next:|then:|finally:|(step|do|run)/i.test(lastLine)) {
        score += 2;
        detectedMarkers.push('action closing');
      }
      if (lines.length < 15) {
        score += 1;
        detectedMarkers.push('short paragraphs');
      }
    }

    if (topologyId === 'systemsView') {
      if (/context|framing|architecture|design|structure/i.test(response.substring(0, 300))) {
        score += 3;
        detectedMarkers.push('framing established');
      }
      if (/tradeoff|trade-off|pro|con|advantage|disadvantage/i.test(lower)) {
        score += 3;
        detectedMarkers.push('tradeoffs discussed');
      }
      if (/risk|constraint|limitation|challenge/i.test(lower)) {
        score += 2;
        detectedMarkers.push('risks addressed');
      }
      if (response.includes('##') || response.includes('**')) {
        score += 1;
        detectedMarkers.push('structured format');
      }
    }

    if (topologyId === 'creativeExploration') {
      if (/what if|imagine|consider|alternatively|could|perhaps|another way/i.test(lower)) {
        score += 3;
        detectedMarkers.push('creative language');
      }
      if (/approach|option|alternative|possibility/i.test(lower) && lower.split('approach|option|alternative|possibility').length > 3) {
        score += 2;
        detectedMarkers.push('multiple approaches');
      }
      if (/feasib|practical|implement|reality|work in/i.test(lastLine)) {
        score += 2;
        detectedMarkers.push('feasibility noted');
      }
      if (/metaphor|analogy|like|think of/i.test(response.substring(0, 400))) {
        score += 1;
        detectedMarkers.push('creative metaphors');
      }
    }

    if (topologyId === 'reflective') {
      if (/pattern|recognize|notice|observe|this reveals/i.test(response.substring(0, 300))) {
        score += 3;
        detectedMarkers.push('pattern recognition');
      }
      if (/meaning|significance|implication|philosophy|essence|fundamental/i.test(lower)) {
        score += 3;
        detectedMarkers.push('deep meaning');
      }
      if (/therefore|implies|suggests|consider|what if|next level/i.test(lower)) {
        score += 2;
        detectedMarkers.push('implication noted');
      }
      if (lines.length > 10 && !response.includes('##')) {
        score += 1;
        detectedMarkers.push('flowing prose');
      }
    }

    scores[topologyId] = { score, markers: detectedMarkers };
  }

  // Find highest scoring topology
  let topTopology = null;
  let topScore = 0;

  for (const [topologyId, { score }] of Object.entries(scores)) {
    if (score > topScore) {
      topScore = score;
      topTopology = topologyId;
    }
  }

  // If no topology scored, default to directTactical with low confidence
  if (!topTopology || topScore === 0) {
    return {
      topology: 'directTactical',
      confidence: 0.1,
      markers: [],
    };
  }

  // Calculate confidence (0-1)
  // Max expected score per topology is roughly 8 markers × weight
  const confidence = Math.min(topScore / 8.0, 1.0);
  const markers = scores[topTopology].markers;

  return {
    topology: topTopology,
    confidence: Math.round(confidence * 100) / 100,
    markers,
  };
}

// ─── Topology Selection ──────────────────────────────────────────────────────

/**
 * Select the best topology for a response.
 *
 * Strategy:
 * 1. Use mode → default topology mapping
 * 2. If operator has strong preference (score > 0.7), override with preferred topology
 * 3. Return topology + reasoning
 *
 * @param {string} mode - task mode (tactical, architect, etc.)
 * @param {Object} operatorProfile - operator profile (unused for now, future signal)
 * @param {Object} topologyPreference - operator topology preferences
 * @returns {Object} {topology: string, reason: string}
 */
function selectTopology(mode, operatorProfile, topologyPreference) {
  // Default mapping: mode → topology
  const modeToTopology = {
    tactical: 'directTactical',
    debug: 'directTactical',
    builder: 'directTactical',
    architect: 'systemsView',
    strategy: 'systemsView',
    critic: 'systemsView',
    explorer: 'creativeExploration',
    reflective: 'reflective',
  };

  let selectedTopology = modeToTopology[mode] || 'directTactical';
  let reason = `mode-based: ${mode} → ${selectedTopology}`;

  // Check for strong operator preference
  if (topologyPreference && topologyPreference.topologyScores) {
    const scores = topologyPreference.topologyScores;
    let maxScore = 0;
    let preferredTopology = null;

    for (const [topology, score] of Object.entries(scores)) {
      if (score > maxScore) {
        maxScore = score;
        preferredTopology = topology;
      }
    }

    // If operator has strong preference, override mode default
    if (maxScore > 0.7) {
      selectedTopology = preferredTopology;
      reason = `operator preference (${(maxScore * 100).toFixed(0)}%) overrides ${mode} default`;
    }
  }

  return {
    topology: selectedTopology,
    reason,
  };
}

// ─── Learning from Acceptance/Rejection ──────────────────────────────────────

const EMA_LEARNING_RATE = 0.1;  // How fast preferences shift

/**
 * Record whether the operator accepted or rejected a topology.
 *
 * Uses exponential moving average:
 * - Accepted: score moves toward 1.0
 * - Rejected: score moves toward 0.0
 *
 * @param {Object} topologyPreference - current preference
 * @param {string} topology - the topology that was used
 * @param {boolean} accepted - true if operator accepted, false if rejected
 * @returns {Object} updated topologyPreference
 */
function recordAcceptance(topologyPreference, topology, accepted) {
  const updated = JSON.parse(JSON.stringify(topologyPreference));

  // Update acceptance/rejection count
  if (accepted) {
    updated.acceptCount++;
  } else {
    updated.rejectCount++;
  }

  // Update EMA score for this topology
  const target = accepted ? 1.0 : 0.0;
  const currentScore = updated.topologyScores[topology];
  const newScore = currentScore + EMA_LEARNING_RATE * (target - currentScore);
  updated.topologyScores[topology] = Math.max(0.0, Math.min(1.0, newScore));

  // Update last topology used
  updated.lastTopology = topology;

  // Update history (keep last 20)
  updated.history.push({
    topology,
    accepted,
    timestamp: new Date().toISOString(),
  });

  if (updated.history.length > 20) {
    updated.history = updated.history.slice(-20);
  }

  return updated;
}

// ─── System Prompt Injection ────────────────────────────────────────────────

/**
 * Get a system prompt fragment that instructs the model to use a specific topology.
 *
 * @param {string} topology - topology ID (directTactical, systemsView, etc.)
 * @returns {string} 3-5 sentence system prompt fragment
 */
function getTopologyPromptFragment(topology) {
  const topologyDef = TOPOLOGIES[topology];
  if (!topologyDef) return '';

  return `\nOUTPUT STRUCTURE: ${topologyDef.name}\n${topologyDef.systemPrompt}`;
}

// ─── Rejection Detection ─────────────────────────────────────────────────────

/**
 * Detect if the operator is rejecting the current output structure.
 *
 * Signals:
 * - "too long", "shorter", "get to the point", "more detail", "expand on"
 * - "break it down", "restructure", "differently", "more structured", "less structured"
 * - "just tell me", "ELI5"
 *
 * @param {string} operatorMessage - operator's message
 * @returns {Object} {rejected: boolean, signals: string[], preferredDirection: null | 'more-direct' | 'more-expansive' | 'more-structured' | 'more-creative'}
 */
function detectRejection(operatorMessage) {
  if (!operatorMessage || typeof operatorMessage !== 'string') {
    return {
      rejected: false,
      signals: [],
      preferredDirection: null,
    };
  }

  const lower = operatorMessage.toLowerCase();

  // Rejection signals
  const rejectionSignals = [
    'too long',
    'shorter',
    'get to the point',
    'tl;dr',
    'tldr',
    'bottom line',
    'more detail',
    'expand on',
    'go deeper',
    'break it down',
    'restructure',
    'differently',
    'more structured',
    'less structured',
    'just tell me',
    'eli5',
    'explain it like',
    'simplify',
    'more examples',
    'show me',
    'too abstract',
    'too detailed',
    'too much',
    'too short',
    'fill in the gaps',
    'i don\'t understand',
  ];

  const detectedSignals = [];
  for (const signal of rejectionSignals) {
    if (lower.includes(signal)) {
      detectedSignals.push(signal);
    }
  }

  if (detectedSignals.length === 0) {
    return {
      rejected: false,
      signals: [],
      preferredDirection: null,
    };
  }

  // Infer preferred direction based on signals
  let preferredDirection = null;

  if (detectedSignals.some(s => ['too long', 'shorter', 'get to the point', 'tl;dr', 'tldr', 'bottom line', 'just tell me'].includes(s))) {
    preferredDirection = 'more-direct';
  } else if (detectedSignals.some(s => ['more detail', 'expand on', 'go deeper', 'fill in the gaps'].includes(s))) {
    preferredDirection = 'more-expansive';
  } else if (detectedSignals.some(s => ['break it down', 'restructure', 'more structured', 'more examples', 'show me'].includes(s))) {
    preferredDirection = 'more-structured';
  } else if (detectedSignals.some(s => ['differently', 'alternative', 'creative', 'what if'].includes(s))) {
    preferredDirection = 'more-creative';
  }

  return {
    rejected: true,
    signals: detectedSignals,
    preferredDirection,
  };
}

// ─── Exports ─────────────────────────────────────────────────────────────────

export {
  TOPOLOGIES,
  createTopologyPreference,
  detectTopology,
  selectTopology,
  recordAcceptance,
  getTopologyPromptFragment,
  detectRejection,
};

export default {
  TOPOLOGIES,
  createTopologyPreference,
  detectTopology,
  selectTopology,
  recordAcceptance,
  getTopologyPromptFragment,
  detectRejection,
};
