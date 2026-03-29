// ─── intelligence/insightEngine.mjs ──────────────────────────────────────────
// RONIN Insight Engine (V7) — Parallel Intelligence Layer
//
// Purpose: Continuously observe evolving patterns across the conversation and
// surface meta-level insights. The Insight Engine runs PARALLEL to RONIN's main
// response — it doesn't answer the operator's question, it observes patterns and
// suggests meta-level improvements.
//
// Role Separation:
// - RONIN: responds to the current prompt
// - Insight Engine: observes evolving patterns and surfaces meta-level insights
//
// Core Functions:
// 1. Pattern Detection — emerging direction, repeated thinking patterns, dominant
//    approach style, unresolved tensions, complexity buildup
// 2. Trajectory Prediction — where the operator is heading, whether converging or
//    diverging, likely future decision points
// 3. Creative/Structural Suggestions — simplifications, alternative approaches,
//    creative extensions, risk awareness, efficiency improvements
// ─────────────────────────────────────────────────────────────────────────────

// ─── Insight State ───────────────────────────────────────────────────────────

/**
 * Create a new insight engine state.
 * @returns {Object} insight state with empty history and tracking
 */
function createInsightState() {
  return {
    messageCount: 0,
    patterns: [],           // detected patterns
    trajectories: [],       // predicted directions
    suggestions: [],        // generated suggestions
    lastInsightAt: 0,       // message count of last insight
    topicHistory: [],       // tracked topics (last 50)
    modeHistory: [],        // tracked modes (last 50)
    tensionPoints: [],      // unresolved contradictions
  };
}

// ─── Topic Extraction ────────────────────────────────────────────────────────

/**
 * Extract topics (nouns, technical terms, proper nouns) from a message.
 * @param {string} message - operator's message
 * @returns {Array<string>} list of extracted topics
 */
function extractTopics(message) {
  if (!message || typeof message !== 'string') return [];

  const lower = message.toLowerCase();

  // Simple topic extraction: look for capitalized words, technical terms, and key nouns
  const capitalizedWords = (message.match(/\b[A-Z][a-z]+/g) || []);

  // Common technical and domain terms
  const technicalTerms = (lower.match(/\b(api|database|function|component|state|async|promise|event|cache|middleware|router|query|mutation|schema|migration|endpoint|service|layer|module|pattern|architecture|system|performance|optimization|testing|deployment|security|validation|authentication|authorization)\b/gi) || []);

  // Extract common nouns (very basic — just look for common patterns)
  const nounPatterns = [
    /\b(bug|error|issue|feature|requirement|design|implementation|structure|approach|solution|problem|question|answer|option|alternative|workflow|pipeline|process)\b/gi,
  ];

  const nouns = [];
  for (const pattern of nounPatterns) {
    const matches = lower.match(pattern);
    if (matches) nouns.push(...matches);
  }

  // Combine and deduplicate
  const allTopics = [
    ...capitalizedWords.map(w => w.toLowerCase()),
    ...technicalTerms.map(t => t.toLowerCase()),
    ...nouns.map(n => n.toLowerCase()),
  ];

  return [...new Set(allTopics)].slice(0, 10);  // top 10 unique topics
}

// ─── Complexity Scoring ─────────────────────────────────────────────────────

/**
 * Calculate a complexity score for a message.
 * Formula: (wordCount * 0.3) + (technicalTermCount * 0.5) + (questionCount * 0.2)
 * @param {string} message - operator's message
 * @returns {number} complexity score (0+)
 */
function calculateComplexity(message) {
  if (!message || typeof message !== 'string') return 0;

  const words = message.split(/\s+/);
  const wordCount = words.length;

  // Count technical terms
  const technicalTerms = message.match(/\b(api|database|function|component|state|async|promise|event|cache|middleware|router|query|mutation|schema|migration|endpoint|service|layer|module|pattern|architecture|system|performance|optimization|testing|deployment|security|validation|authentication|authorization|algorithm|recursion|concurrency|latency|throughput|scalability)\b/gi) || [];
  const technicalTermCount = technicalTerms.length;

  // Count questions
  const questionCount = (message.match(/\?/g) || []).length;

  return (wordCount * 0.3) + (technicalTermCount * 0.5) + (questionCount * 0.2);
}

// ─── Pattern Detection ───────────────────────────────────────────────────────

/**
 * Detect patterns from the insight state.
 * @param {Object} state - insight state
 * @returns {Array<Object>} patterns detected
 */
function detectPatterns(state) {
  const patterns = [];

  // Pattern 1: Topic Repetition
  const topicCounts = {};
  for (const topic of state.topicHistory) {
    topicCounts[topic] = (topicCounts[topic] || 0) + 1;
  }
  for (const [topic, count] of Object.entries(topicCounts)) {
    if (count >= 3) {
      patterns.push({
        type: 'topic-repetition',
        description: `Topic "${topic}" has appeared ${count} times without resolution`,
        confidence: Math.min(count / 5, 1.0),
        evidence: [`${topic} mentioned ${count}x`],
      });
    }
  }

  // Pattern 2: Mode Clustering
  if (state.modeHistory.length >= 5) {
    const lastFive = state.modeHistory.slice(-5);
    const modeSet = new Set(lastFive);
    if (modeSet.size === 1) {
      patterns.push({
        type: 'mode-clustering',
        description: `Operator has stayed in "${lastFive[0]}" mode for 5+ messages (possible stalling)`,
        confidence: 0.8,
        evidence: [`${lastFive[0]} for last 5 messages`],
      });
    }
  }

  // Pattern 3: Complexity Buildup
  if (state.messageCount >= 3) {
    // Check last 3 complexity scores (if available)
    // This is a simplified check — in practice, we'd track complexity per message
    const avgComplexity = state.messageCount > 0 ? state.messageCount * 0.3 : 0;
    if (avgComplexity > 15) {
      patterns.push({
        type: 'complexity-buildup',
        description: 'Conversation complexity has increased significantly',
        confidence: Math.min(avgComplexity / 50, 1.0),
        evidence: ['complexity score trending upward'],
      });
    }
  }

  // Pattern 4: Tension Points (unresolved contradictions)
  if (state.tensionPoints.length > 0) {
    for (const tension of state.tensionPoints) {
      patterns.push({
        type: 'tension-point',
        description: `Unresolved contradiction: ${tension.description}`,
        confidence: tension.confidence || 0.6,
        evidence: tension.evidence || ['marked as tension'],
      });
    }
  }

  return patterns;
}

// ─── Trajectory Prediction ──────────────────────────────────────────────────

/**
 * Predict the conversation's trajectory.
 * @param {Object} state - insight state
 * @param {Array<Object>} patterns - detected patterns
 * @returns {Object} trajectory prediction
 */
function predictTrajectory(state, patterns) {
  // Determine direction based on patterns and history

  // Check for convergence: operator focusing on one topic
  const topicCounts = {};
  for (const topic of state.topicHistory.slice(-10)) {
    topicCounts[topic] = (topicCounts[topic] || 0) + 1;
  }
  const topTopicCount = Math.max(...Object.values(topicCounts), 0);
  const topicFocus = topTopicCount / Math.max(Object.keys(topicCounts).length, 1);

  // Check for divergence: many different topics
  const uniqueTopics = new Set(state.topicHistory.slice(-10)).size;
  const isConverging = topicFocus > 0.5 && uniqueTopics <= 3;
  const isDiverging = uniqueTopics > 5;

  // Check for stalling: same mode for too long, or repeating patterns
  const hasStalling = patterns.some(p => p.type === 'mode-clustering' || p.type === 'topic-repetition');
  const hasEscalation = patterns.some(p => p.type === 'complexity-buildup');

  if (hasStalling && state.messageCount >= 5) {
    return {
      direction: 'stalling',
      confidence: 0.8,
      description: 'Operator appears to be going in circles without making progress',
    };
  }

  if (hasEscalation) {
    return {
      direction: 'escalating',
      confidence: 0.7,
      description: 'Conversation complexity is increasing rapidly, may need to step back',
    };
  }

  if (isConverging) {
    return {
      direction: 'converging',
      confidence: 0.75,
      description: 'Operator is narrowing down on a solution',
    };
  }

  if (isDiverging) {
    return {
      direction: 'diverging',
      confidence: 0.65,
      description: 'Operator is exploring broadly without convergence yet',
    };
  }

  // Default: neutral trajectory
  return {
    direction: 'neutral',
    confidence: 0.5,
    description: 'Conversation direction is still forming',
  };
}

// ─── Suggestion Generation ──────────────────────────────────────────────────

/**
 * Generate actionable suggestions based on patterns and trajectory.
 * @param {Array<Object>} patterns - detected patterns
 * @param {Object} trajectory - predicted trajectory
 * @returns {Array<Object>} suggestions
 */
function generateSuggestions(patterns, trajectory) {
  const suggestions = [];

  // Based on trajectory
  if (trajectory.direction === 'stalling') {
    suggestions.push({
      type: 'step-back',
      content: 'Consider stepping back. You\'ve been exploring the same approach for a while — try breaking it into smaller, concrete steps.',
      priority: 'high',
    });
  }

  if (trajectory.direction === 'escalating') {
    suggestions.push({
      type: 'simplification',
      content: 'The complexity is rising. Try narrowing the scope — what\'s the minimum viable step you need to take right now?',
      priority: 'high',
    });
  }

  if (trajectory.direction === 'diverging') {
    suggestions.push({
      type: 'convergence',
      content: 'You\'re exploring multiple directions. Consider picking one and going deeper before branching further.',
      priority: 'medium',
    });
  }

  if (trajectory.direction === 'converging') {
    suggestions.push({
      type: 'extension',
      content: 'You\'re narrowing in well. Once you land on this, consider how it might extend to similar problems.',
      priority: 'low',
    });
  }

  // Based on patterns
  for (const pattern of patterns) {
    if (pattern.type === 'topic-repetition') {
      suggestions.push({
        type: 'clarification',
        content: `You keep returning to "${pattern.evidence[0]}". What specifically is unresolved about it?`,
        priority: 'medium',
      });
    }

    if (pattern.type === 'tension-point') {
      suggestions.push({
        type: 'resolution',
        content: `There's a tension between ${pattern.description}. Which matters more to you right now?`,
        priority: 'medium',
      });
    }
  }

  return suggestions;
}

// ─── Triggering Logic ────────────────────────────────────────────────────────

/**
 * Decide if it's time to surface an insight.
 * Triggers:
 * - Pattern change detected (new pattern or pattern intensified)
 * - Topic repeated 3+ times without resolution
 * - Mode hasn't changed in 5+ messages (possible stalling)
 * - Complexity score increased 50%+ over last 3 messages
 * - Fallback: every 8 messages if no event-based trigger fired
 * @param {Object} state - insight state
 * @returns {Object} {trigger: boolean, reason: string}
 */
function shouldTriggerInsight(state) {
  // Fallback: every 8 messages
  if (state.messageCount > 0 && state.messageCount - state.lastInsightAt >= 8) {
    return {
      trigger: true,
      reason: 'time-based fallback (every 8 messages)',
    };
  }

  // Pattern change detection
  const patterns = detectPatterns(state);
  if (patterns.length > 0) {
    return {
      trigger: true,
      reason: `pattern change detected: ${patterns[0].type}`,
    };
  }

  // Topic repetition (3+ times)
  const topicCounts = {};
  for (const topic of state.topicHistory) {
    topicCounts[topic] = (topicCounts[topic] || 0) + 1;
  }
  for (const [topic, count] of Object.entries(topicCounts)) {
    if (count >= 3) {
      return {
        trigger: true,
        reason: `topic "${topic}" repeated ${count} times`,
      };
    }
  }

  // Mode stalling (5+ messages in same mode)
  if (state.modeHistory.length >= 5) {
    const lastFive = state.modeHistory.slice(-5);
    const modeSet = new Set(lastFive);
    if (modeSet.size === 1) {
      return {
        trigger: true,
        reason: `mode stalling: ${lastFive[0]} for 5+ messages`,
      };
    }
  }

  // No trigger fired
  return {
    trigger: false,
    reason: 'no trigger conditions met',
  };
}

// ─── Format Insight ─────────────────────────────────────────────────────────

/**
 * Format an insight for display (compact, high-signal string).
 * @param {Object} insight - {pattern, trajectory, suggestion}
 * @returns {string} formatted insight
 */
function formatInsight(insight) {
  if (!insight) return '';

  const parts = [];

  if (insight.pattern) {
    parts.push(`Pattern: ${insight.pattern.type}`);
  }

  if (insight.trajectory) {
    parts.push(`Trajectory: ${insight.trajectory.direction}`);
  }

  if (insight.suggestion) {
    parts.push(`Suggestion: ${insight.suggestion.content}`);
  }

  return parts.join(' | ');
}

// ─── Main Processing Function ───────────────────────────────────────────────

/**
 * Process each message through the insight engine.
 * @param {Object} state - insight state
 * @param {string} message - operator's message
 * @param {Object} context - {mode?: string, operatorProfile?: object, response?: string, topologyUsed?: string}
 * @returns {Object} {state: updatedState, insights: Array<Object> | null}
 */
function processMessage(state, message, context = {}) {
  if (!message || typeof message !== 'string') {
    return { state, insights: null };
  }

  const updated = JSON.parse(JSON.stringify(state));
  updated.messageCount++;

  // Extract and track topics
  const topics = extractTopics(message);
  updated.topicHistory.push(...topics);
  if (updated.topicHistory.length > 50) {
    updated.topicHistory = updated.topicHistory.slice(-50);
  }

  // Track mode if provided
  if (context.mode) {
    updated.modeHistory.push(context.mode);
    if (updated.modeHistory.length > 50) {
      updated.modeHistory = updated.modeHistory.slice(-50);
    }
  }

  // Check if we should trigger an insight
  const triggerResult = shouldTriggerInsight(updated);

  if (!triggerResult.trigger) {
    return { state: updated, insights: null };
  }

  // Generate insight
  updated.lastInsightAt = updated.messageCount;

  const patterns = detectPatterns(updated);
  const trajectory = predictTrajectory(updated, patterns);
  const suggestions = generateSuggestions(patterns, trajectory);

  // Update state's pattern and trajectory history
  updated.patterns = patterns;
  updated.trajectories = [...(updated.trajectories || []), trajectory];
  updated.suggestions = suggestions;

  // Format insights for output
  const insights = [];
  for (const pattern of patterns) {
    const suggestion = suggestions.find(s => s.type !== 'step-back' && s.type !== 'convergence' && s.type !== 'extension') || suggestions[0];
    insights.push({
      pattern: pattern,
      trajectory: trajectory,
      suggestion: suggestion,
      formatted: formatInsight({ pattern, trajectory, suggestion }),
    });
  }

  return {
    state: updated,
    insights: insights.length > 0 ? insights : null,
  };
}

// ─── Exports ────────────────────────────────────────────────────────────────

export {
  createInsightState,
  processMessage,
  detectPatterns,
  predictTrajectory,
  generateSuggestions,
  shouldTriggerInsight,
  formatInsight,
  extractTopics,
  calculateComplexity,
};

export default {
  createInsightState,
  processMessage,
  detectPatterns,
  predictTrajectory,
  generateSuggestions,
  shouldTriggerInsight,
  formatInsight,
  extractTopics,
  calculateComplexity,
};
