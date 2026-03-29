// ─── intelligence/critic.mjs ──────────────────────────────────────────────────
// V6: Critic Layer — Final quality gate for all responses.
//
// The Critic evaluates every response across 6 quality dimensions before the
// operator sees it. It ensures consistency, grounds claims, and maintains
// RONIN's identity while adapting to operator preferences.
//
// This is NOT a system prompt. It's a structured validator that:
//   1. Scores responses across 6 dimensions
//   2. Detects failure signals
//   3. Reports issues and suggestions
//   4. Decides pass/fail (≥0.65 = pass)
// ─────────────────────────────────────────────────────────────────────────────

import { BANNED_PATTERNS, validateVoice } from './voiceSchema.mjs';

// ─── Dimension Definitions ────────────────────────────────────────────────────

const DIMENSIONS = {
  identityFidelity: {
    weight: 0.25,
    description: 'Does it sound like RONIN?',
  },
  hallucinationRisk: {
    weight: 0.20,
    description: 'Are claims grounded?',
  },
  epistemicDiscipline: {
    weight: 0.15,
    description: 'Fact vs inference distinction',
  },
  operatorFit: {
    weight: 0.15,
    description: 'Matches operator preferences',
  },
  structuralClarity: {
    weight: 0.15,
    description: 'Well-organized response',
  },
  usefulness: {
    weight: 0.10,
    description: 'Addresses the question',
  },
};

// Verify weights sum to 1.0
const weightSum = Object.values(DIMENSIONS).reduce((sum, d) => sum + d.weight, 0);
if (Math.abs(weightSum - 1.0) > 0.001) {
  throw new Error(`Dimension weights must sum to 1.0, got ${weightSum}`);
}

// ─── Failure Signal Patterns ───────────────────────────────────────────────────

const FAILURE_SIGNALS = {
  assistantTone: {
    pattern: /\b(i'?d be happy|i'?m glad|as an (ai|assistant|language model)|my training)\b/i,
    label: 'Assistant-like tone',
  },
  excessiveEnthusiasm: {
    pattern: /([!]{2,}|great question|excellent (point|question)|wonderful|fantastic|amazing)/i,
    label: 'Excessive enthusiasm',
  },
  unsupportedCertainty: {
    pattern: /\b(always|never).{0,50}\b(work|fail|happen|occur|will)|\b(definitely|absolutely|certainly)\b.{0,50}\b(is|are|will|won't)\b/i,
    label: 'Unsupported certainty',
  },
  genericPhrasing: {
    pattern: /\b(in conclusion|to summarize|to sum up|in summary|at the end of the day|moving forward)\b/i,
    label: 'Generic phrasing',
  },
  lossOfStructure: {
    // Very long paragraphs (>300 words) with no headings/breaks
    check: 'custom',
    label: 'Loss of structure',
  },
  driftFromPersona: {
    pattern: /\b(obviously|as you know|needless to say)\b.*\b(everyone|you all)\b/i,
    label: 'Drift from persona',
  },
};

// ─── Dimension Scorers ─────────────────────────────────────────────────────────

/**
 * Score identity fidelity — does it sound like RONIN?
 * Uses voiceSchema.validateVoice as the primary check.
 */
function scoreIdentityFidelity(response) {
  let score = 1.0;
  const issues = [];

  // Check against banned patterns
  for (const pattern of BANNED_PATTERNS) {
    const match = response.match(pattern);
    if (match) {
      score -= 0.3;
      issues.push(`Banned pattern: "${match[0]}"`);
    }
  }

  // Check for assistant-like phrases
  const assistantPhrases = [
    'i\'d be happy to',
    'as an ai',
    'as a language model',
    'my training data',
    'my knowledge cutoff',
    'i was trained',
  ];

  for (const phrase of assistantPhrases) {
    if (response.toLowerCase().includes(phrase)) {
      score -= 0.2;
      issues.push(`Assistant phrase: "${phrase}"`);
    }
  }

  // Check for excessive enthusiasm
  const exclamationCount = (response.match(/!/g) || []).length;
  if (exclamationCount > 2) {
    score -= 0.15;
    issues.push(`Excessive exclamation marks (${exclamationCount})`);
  }

  // Check for sycophancy openers
  const sycophancyOpeners = [
    'great question',
    'excellent point',
    'wonderful question',
    'that\'s a great question',
    'sure thing',
    'absolutely',
    'of course',
  ];

  for (const opener of sycophancyOpeners) {
    if (response.toLowerCase().startsWith(opener)) {
      score -= 0.15;
      issues.push(`Sycophancy opener: "${opener}"`);
    }
  }

  // Generic filler phrases
  const fillerPhrases = [
    'in conclusion',
    'to summarize',
    'it\'s worth noting that',
    'in terms of',
    'with respect to',
  ];

  for (const filler of fillerPhrases) {
    if (response.toLowerCase().includes(filler)) {
      score -= 0.1;
      issues.push(`Filler phrase: "${filler}"`);
    }
  }

  score = Math.max(0, Math.min(1, score));

  return {
    score: Math.round(score * 100) / 100,
    issues,
  };
}

/**
 * Score hallucination risk — are claims grounded?
 */
function scoreHallucinationRisk(response, context = {}) {
  let score = 1.0;
  const issues = [];

  // Check for absolute claims without qualification
  const absoluteClaimsPattern = /\b(always|never|everyone|nobody|all|none)\b/g;
  const absoluteClaims = response.match(absoluteClaimsPattern) || [];
  if (absoluteClaims.length > 1) {
    score -= 0.2;
    issues.push(`Multiple absolute claims (${absoluteClaims.length})`);
  }

  // Check for definitive statements with high confidence words
  const definitivePattern = /\b(definitely|absolutely|certainly|undoubtedly)\b.*\b(is|are|will|should)\b/i;
  if (definitivePattern.test(response)) {
    score -= 0.15;
    issues.push('Definitive statement without hedging');
  }

  // Check for invented version numbers/dates without context
  const versionPattern = /\bv([\d.]+)\b(?!\s*(?:released|introduced|announced|launched))/gi;
  const versionMatches = response.match(versionPattern) || [];
  if (versionMatches.length > 1) {
    score -= 0.1;
    issues.push(`Specific versions mentioned without context (${versionMatches.length})`);
  }

  // Check for claims about user's code without evidence
  if (context.operatorMessage && !response.includes('code') && /\b(your|you'?re)\b.*\b(bug|error|issue|problem)\b/i.test(response)) {
    score -= 0.1;
    issues.push('Claims about user\'s code without context');
  }

  // Positive signal: claims are hedged appropriately
  const hedgingWords = response.match(/\b(may|might|could|possibly|likely|probably|appears|seems)\b/gi) || [];
  if (hedgingWords.length > 0 && hedgingWords.length <= 3) {
    score += 0.1;
  }

  // Positive signal: acknowledges unknowns
  if (/\b(i don'?t know|unclear|uncertain|not sure|unsure)\b/i.test(response)) {
    score += 0.15;
  }

  score = Math.max(0, Math.min(1, score));

  return {
    score: Math.round(score * 100) / 100,
    issues,
  };
}

/**
 * Score epistemic discipline — distinction between fact and inference
 */
function scoreEpistemicDiscipline(response) {
  let score = 0.5;  // Start neutral
  const issues = [];

  // Check for appropriate hedging
  const hedgingWords = ['may', 'might', 'could', 'possibly', 'likely', 'probably', 'appears', 'seems', 'suggests'];
  let hedgingCount = 0;

  for (const word of hedgingWords) {
    const regex = new RegExp(`\\b${word}\\b`, 'gi');
    const matches = response.match(regex) || [];
    hedgingCount += matches.length;
  }

  if (hedgingCount > 0 && hedgingCount <= 5) {
    score += 0.2;
  }

  // Check for explicit unknowns
  const unknownPatterns = [
    /\bi don'?t know\b/i,
    /\b(i'?m not sure|i'?m unclear|i'?m uncertain)\b/i,
    /\bunclear|uncertain|unknown\b/i,
  ];

  for (const pattern of unknownPatterns) {
    if (pattern.test(response)) {
      score += 0.15;
      issues.push('Appropriately acknowledges uncertainty');
      break;
    }
  }

  // Check for statements presented as inference
  const inferenceMarkers = ['infer', 'imply', 'suggest', 'indicate', 'point to'];
  let inferenceCount = 0;
  for (const marker of inferenceMarkers) {
    const regex = new RegExp(`\\b${marker}`, 'gi');
    inferenceCount += (response.match(regex) || []).length;
  }

  if (inferenceCount > 0) {
    score += 0.1;
  }

  // Penalty: stating inference as fact (look for pattern like "this clearly proves" without qualification)
  if (/this\s+(clearly\s+)?(proves|demonstrates|shows|means|indicates)\b/i.test(response)) {
    score -= 0.25;
    issues.push('Inference stated as fact');
  }

  score = Math.max(0, Math.min(1, score));

  return {
    score: Math.round(score * 100) / 100,
    issues,
  };
}

/**
 * Score operator fit — does it match operator preferences?
 */
function scoreOperatorFit(response, profile) {
  let score = 0.7;  // Default decent fit
  const issues = [];

  if (!profile || typeof profile !== 'object') {
    return {
      score: Math.round(score * 100) / 100,
      issues: ['No operator profile available'],
    };
  }

  const dimensions = profile.dimensions || {};

  // Check verbosity match
  const responseLength = response.split(/\s+/).length;
  const targetVerbosity = dimensions.verbosity ?? 0.5;

  if (targetVerbosity < 0.3 && responseLength > 300) {
    score -= 0.1;
    issues.push('Response too long for terse operator');
  } else if (targetVerbosity > 0.7 && responseLength < 100) {
    score -= 0.1;
    issues.push('Response too brief for verbose operator');
  } else if (Math.abs(responseLength - (targetVerbosity * 400)) < 50) {
    // Good match
    score += 0.05;
  }

  // Check structure match
  const hasStructure = /#{1,3}\s|^[-*]\s|```/m.test(response);
  const targetStructure = dimensions.responseFormat ?? 0.5;

  if (targetStructure > 0.7 && !hasStructure) {
    score -= 0.1;
    issues.push('Structured operator expects formatted output');
  } else if (targetStructure < 0.3 && hasStructure && response.match(/^#{1,3}\s/m)) {
    score -= 0.05;
    issues.push('Prose operator prefers flowing text');
  }

  // Check technical depth match
  const hasCode = /```|`[^`]{5,}`/i.test(response);
  const targetDepth = dimensions.technicalDepth ?? 0.5;

  if (targetDepth > 0.8 && !hasCode && !response.includes('API') && !response.includes('database')) {
    score -= 0.05;
    issues.push('Technical operator expected deeper explanation');
  } else if (targetDepth < 0.3 && hasCode && response.match(/```/g).length > 1) {
    score -= 0.05;
    issues.push('Conceptual operator overwhelmed with code');
  }

  score = Math.max(0, Math.min(1, score));

  return {
    score: Math.round(score * 100) / 100,
    issues,
  };
}

/**
 * Score structural clarity — is response well-organized?
 */
function scoreStructuralClarity(response) {
  let score = 1.0;
  const issues = [];

  // Split into paragraphs
  const paragraphs = response.split(/\n\n+/);

  // Check for very long paragraphs
  let longParaCount = 0;
  for (const para of paragraphs) {
    const wordCount = para.split(/\s+/).length;
    if (wordCount > 200) {
      longParaCount++;
      score -= 0.15;
    }
  }

  if (longParaCount > 0) {
    issues.push(`${longParaCount} paragraph(s) over 200 words`);
  }

  // Check heading consistency
  const headings = response.match(/^#{1,3}\s/gm) || [];
  const headingLevels = headings.map(h => h.match(/#/g).length);
  if (headingLevels.length > 2) {
    const minLevel = Math.min(...headingLevels);
    const maxLevel = Math.max(...headingLevels);
    if (maxLevel - minLevel > 1) {
      score -= 0.1;
      issues.push('Inconsistent heading levels');
    }
  }

  // Check list formatting
  const listItems = response.match(/^[-*+]\s/gm) || [];
  const codeBlocks = response.match(/```/g) || [];

  if (listItems.length > 0 && listItems.length < 4) {
    score -= 0.05;
    issues.push('Bullet list with fewer than 4 items');
  }

  // Positive signal: good code block labeling
  const labeledBlocks = (response.match(/```\w+/g) || []).length;
  const totalBlocks = (codeBlocks.length || 0) / 2;
  if (totalBlocks > 0 && labeledBlocks === totalBlocks) {
    score += 0.1;
  }

  // Positive signal: good overall structure with headings and code
  if (headings.length > 0 && codeBlocks.length > 0) {
    score += 0.05;
  }

  score = Math.max(0, Math.min(1, score));

  return {
    score: Math.round(score * 100) / 100,
    issues,
  };
}

/**
 * Score usefulness — does it address the operator's question?
 */
function scoreUsefulness(response, operatorMessage) {
  let score = 0.5;  // Start neutral
  const issues = [];

  if (!operatorMessage || typeof operatorMessage !== 'string') {
    return {
      score: Math.round(score * 100) / 100,
      issues: ['No operator message provided'],
    };
  }

  // Extract key terms from operator's question
  const keywords = operatorMessage
    .toLowerCase()
    .replace(/[?!.,;:]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 3 && !/^(the|and|or|for|with|from|that|this|what|how|why|is|are|do)$/.test(w));

  // Count keyword overlap
  const responseLower = response.toLowerCase();
  let overlapCount = 0;

  for (const keyword of keywords) {
    if (responseLower.includes(keyword)) {
      overlapCount++;
    }
  }

  const overlapRatio = keywords.length > 0 ? overlapCount / keywords.length : 0;
  if (overlapRatio > 0.5) {
    score += 0.2;
  } else if (overlapRatio > 0.3) {
    score += 0.15;
  } else if (overlapRatio > 0.2) {
    score += 0.1;
  } else if (overlapRatio < 0.1) {
    score -= 0.2;
    issues.push('Low keyword overlap with question');
  }

  // Check for code relevance (if question is technical)
  if (/code|function|class|api|database|query|schema|javascript|react|swift|python|structure/i.test(operatorMessage)) {
    if (/```|const |function |class |interface |async |=>|\.map\(|\.filter\(|return /i.test(response)) {
      score += 0.2;
    } else {
      score -= 0.05;
      issues.push('Technical question but response lacks code examples');
    }
  }

  // Penalty: response too short for substantial question
  if (operatorMessage.length > 50 && response.length < 100) {
    score -= 0.3;
    issues.push('Response too brief for substantial question');
  }

  // Positive: response length reasonable
  if (response.length > 150 && response.length < 3000) {
    score += 0.05;
  }

  score = Math.max(0, Math.min(1, score));

  return {
    score: Math.round(score * 100) / 100,
    issues,
  };
}

// ─── Failure Signal Detection ──────────────────────────────────────────────────

/**
 * Detect all failure signals from §12.3
 */
function detectFailureSignals(response) {
  const detected = [];

  // Pattern-based signals
  for (const [key, signal] of Object.entries(FAILURE_SIGNALS)) {
    if (key === 'lossOfStructure') continue;  // Handle separately

    if (signal.pattern && signal.pattern.test(response)) {
      detected.push(signal.label);
    }
  }

  // Custom check: loss of structure
  const paragraphs = response.split(/\n\n+/);
  let maxParaLength = 0;
  for (const para of paragraphs) {
    maxParaLength = Math.max(maxParaLength, para.length);
  }

  if (maxParaLength > 500 && paragraphs.length === 1) {
    // Single massive paragraph with no structure
    detected.push(FAILURE_SIGNALS.lossOfStructure.label);
  }

  return [...new Set(detected)];  // Remove duplicates
}

// ─── Main Critique Function ───────────────────────────────────────────────────

/**
 * Main evaluation function — scores response across 6 dimensions
 *
 * @param {string} response - the response text to evaluate
 * @param {object} context - { operatorMessage, operatorProfile?, mode? }
 * @returns {object} - critique result with pass/fail decision
 */
function critique(response, context = {}) {
  if (!response || typeof response !== 'string') {
    return {
      pass: false,
      score: 0,
      dimensions: {},
      failureSignals: ['Empty response'],
      suggestions: ['Response cannot be empty'],
    };
  }

  // Score each dimension
  const dimensions = {};

  dimensions.identityFidelity = {
    ...scoreIdentityFidelity(response),
    weight: DIMENSIONS.identityFidelity.weight,
  };

  dimensions.hallucinationRisk = {
    ...scoreHallucinationRisk(response, context),
    weight: DIMENSIONS.hallucinationRisk.weight,
  };

  dimensions.epistemicDiscipline = {
    ...scoreEpistemicDiscipline(response),
    weight: DIMENSIONS.epistemicDiscipline.weight,
  };

  dimensions.operatorFit = {
    ...scoreOperatorFit(response, context.operatorProfile),
    weight: DIMENSIONS.operatorFit.weight,
  };

  dimensions.structuralClarity = {
    ...scoreStructuralClarity(response),
    weight: DIMENSIONS.structuralClarity.weight,
  };

  dimensions.usefulness = {
    ...scoreUsefulness(response, context.operatorMessage),
    weight: DIMENSIONS.usefulness.weight,
  };

  // Calculate weighted average
  let weightedScore = 0;
  for (const [key, dim] of Object.entries(dimensions)) {
    weightedScore += dim.score * dim.weight;
  }

  const score = Math.round(weightedScore * 100) / 100;
  const pass = score >= 0.65;

  // Detect failure signals
  const failureSignals = detectFailureSignals(response);

  // Generate suggestions
  const suggestions = [];

  for (const [key, dim] of Object.entries(dimensions)) {
    if (dim.issues && dim.issues.length > 0) {
      for (const issue of dim.issues.slice(0, 2)) {  // Max 2 per dimension
        suggestions.push(`${key}: ${issue}`);
      }
    }
  }

  if (!pass) {
    if (score < 0.5) {
      suggestions.push('Response quality is below threshold. Consider complete rewrite.');
    } else {
      suggestions.push('Minor issues found. Review failure signals and dimension scores.');
    }
  }

  return {
    pass,
    score,
    dimensions,
    failureSignals,
    suggestions: suggestions.slice(0, 5),  // Max 5 suggestions
  };
}

// ─── System Prompt Fragment ────────────────────────────────────────────────────

/**
 * Returns a system prompt fragment about quality standards
 */
function getCriticPromptFragment() {
  return `Before responding, remember:
- Sound like RONIN (colleague, direct, grounded) not like a chatbot or assistant
- Check your confidence: only state as fact what you know. Hedge uncertain claims.
- Be precise: avoid assistant phrases like "I'd be happy to help" or "As an AI"
- Stay on topic: your response should address the operator's actual question
- Structure for clarity: use headings and code blocks when they help, not by default
- Acknowledge unknowns: if you're uncertain about something, say so explicitly`;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export {
  DIMENSIONS,
  critique,
  scoreIdentityFidelity,
  scoreHallucinationRisk,
  scoreEpistemicDiscipline,
  scoreOperatorFit,
  scoreStructuralClarity,
  scoreUsefulness,
  detectFailureSignals,
  getCriticPromptFragment,
};

export default {
  DIMENSIONS,
  critique,
  scoreIdentityFidelity,
  scoreHallucinationRisk,
  scoreEpistemicDiscipline,
  scoreOperatorFit,
  scoreStructuralClarity,
  scoreUsefulness,
  detectFailureSignals,
  getCriticPromptFragment,
};
