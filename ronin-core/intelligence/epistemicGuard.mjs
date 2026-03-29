// ─── intelligence/epistemicGuard.mjs ─────────────────────────────────────────
// V5: Epistemic Guard
//
// Enforces epistemic discipline — ensuring RONIN distinguishes between what is
// known, inferred, uncertain, and missing. Prevents hallucination by detecting
// overconfident claims and ungrounded assertions.
//
// Core principle: "No confidence without grounding."
// ─────────────────────────────────────────────────────────────────────────────

// ─── Epistemic Markers ───────────────────────────────────────────────────────
// Linguistic patterns that indicate epistemic status

export const EPISTEMIC_MARKERS = {
  known: [],  // no special markers needed — default state
  inferred: [
    'likely',
    'probably',
    'suggests',
    'indicates',
    'based on this',
    'given that',
    'this implies',
    'appears',
    'seems',
    'in this case',
    'would',
    'should',
  ],
  uncertain: [
    'might',
    'could be',
    'possibly',
    'not sure',
    'hard to say',
    'unclear',
    'may or may not',
    'uncertain',
    'questionable',
    'debatable',
    'it\'s possible',
    'perhaps',
    'somewhat',
  ],
  missing: [
    'need to see',
    'would need',
    'can\'t determine without',
    'depends on',
    'if you share',
    'without seeing',
    'unclear without',
    'need more info',
    'can\'t tell',
    'missing context',
  ],
};

// ─── Analyze Epistemic Content ───────────────────────────────────────────────
// Scan a response for epistemic markers and classify sentences

export function analyzeEpistemicContent(response) {
  if (!response || typeof response !== 'string') {
    return {
      sentences: [],
      summary: { known: 0, inferred: 0, uncertain: 0, missing: 0 },
    };
  }

  // Split into sentences (basic approach)
  const sentencePattern = /[.!?]+(?:\s+|$)/g;
  const sentenceTexts = response
    .split(sentencePattern)
    .filter((s) => s.trim().length > 0);

  const sentences = sentenceTexts.map((text) => {
    const trimmed = text.trim();
    const lowerText = trimmed.toLowerCase();

    let status = 'known';
    const foundMarkersSet = new Set();

    // Check for all markers and collect them all
    let hasMissing = false;
    let hasUncertain = false;
    let hasInferred = false;

    for (const marker of EPISTEMIC_MARKERS.missing) {
      if (lowerText.includes(marker.toLowerCase())) {
        hasMissing = true;
        foundMarkersSet.add(marker);
      }
    }

    for (const marker of EPISTEMIC_MARKERS.uncertain) {
      if (lowerText.includes(marker.toLowerCase())) {
        hasUncertain = true;
        foundMarkersSet.add(marker);
      }
    }

    for (const marker of EPISTEMIC_MARKERS.inferred) {
      if (lowerText.includes(marker.toLowerCase())) {
        hasInferred = true;
        foundMarkersSet.add(marker);
      }
    }

    // Determine status based on priority (missing > uncertain > inferred > known)
    if (hasMissing) {
      status = 'missing';
    } else if (hasUncertain) {
      status = 'uncertain';
    } else if (hasInferred) {
      status = 'inferred';
    }

    // Calculate confidence based on status
    const confidenceMap = {
      known: 1.0,
      inferred: 0.75,
      uncertain: 0.4,
      missing: 0.1,
    };

    return {
      text: trimmed,
      status,
      confidence: confidenceMap[status],
      markers: Array.from(foundMarkersSet),
    };
  });

  const summary = {
    known: sentences.filter((s) => s.status === 'known').length,
    inferred: sentences.filter((s) => s.status === 'inferred').length,
    uncertain: sentences.filter((s) => s.status === 'uncertain').length,
    missing: sentences.filter((s) => s.status === 'missing').length,
  };

  return { sentences, summary };
}

// ─── Detect Overconfidence ──────────────────────────────────────────────────
// Find claims stated with high confidence but that should have hedging

export function detectOverconfidence(response) {
  if (!response || typeof response !== 'string') {
    return { overconfidentClaims: [], score: 0 };
  }

  const overconfidentClaims = [];
  const lowerResponse = response.toLowerCase();

  // Absolute statement patterns
  const absolutePatterns = [
    { pattern: /\balways\b/gi, reason: 'uses "always" — context-dependent' },
    { pattern: /\bnever\b/gi, reason: 'uses "never" — context-dependent' },
    { pattern: /\bdefinitely\b/gi, reason: 'uses "definitely" — overstates certainty' },
    { pattern: /\bcertainly\b/gi, reason: 'uses "certainly" — overstates certainty' },
    { pattern: /\bguaranteed\b/gi, reason: 'uses "guaranteed" — unrealistic' },
    { pattern: /\bimpossible\b/gi, reason: 'uses "impossible" — rarely absolute' },
    {
      pattern: /\bmust\s+(be|be\s+\w+)/gi,
      reason: 'uses "must be" — overconfident assertion',
    },
  ];

  for (const { pattern, reason } of absolutePatterns) {
    const matches = response.match(pattern);
    if (matches) {
      matches.forEach((match) => {
        overconfidentClaims.push({
          text: match,
          reason,
        });
      });
    }
  }

  // Check for ungrounded assertions about user's code/system
  const ungroundedContextPatterns = [
    {
      pattern: /^(?!.*\b(?:likely|probably|might|could|maybe)\b).*\byour\s+(?:code|system|app|component)\b.*\b(?:is|has|will|should)\b.*[.!?]/gim,
      reason: 'definitive statement about user code without evidence',
    },
  ];

  for (const { pattern, reason } of ungroundedContextPatterns) {
    const matches = response.match(pattern);
    if (matches) {
      matches.forEach((match) => {
        // Only flag if it's a real definitive statement (not hedged)
        const trimmed = match.trim();
        if (
          !trimmed.match(
            /\b(?:likely|probably|might|could|possibly|uncertain|not sure)\b/i,
          )
        ) {
          overconfidentClaims.push({
            text: trimmed.substring(0, 80) + (trimmed.length > 80 ? '...' : ''),
            reason,
          });
        }
      });
    }
  }

  // Calculate overconfidence score (0-1, higher = more overconfident)
  const baseScore = Math.min(overconfidentClaims.length * 0.25, 1.0);
  const score = baseScore;

  return { overconfidentClaims, score };
}

// ─── Detect Hallucination ───────────────────────────────────────────────────
// Lightweight hallucination detection — flag suspicious patterns

export function detectHallucination(response, context = {}) {
  if (!response || typeof response !== 'string') {
    return { risks: [], score: 0 };
  }

  const risks = [];
  const { knownFacts = [], codebaseContext = '', userMessage = '' } = context;

  // Pattern 1: Invented API names (camelCase identifiers that look like APIs)
  const apiLikePattern = /\b([a-z]+(?:[A-Z][a-z]+)+)\s*\(/g;
  const matches = response.matchAll(apiLikePattern);

  const knownAPIs = new Set([
    'useState',
    'useEffect',
    'useContext',
    'useReducer',
    'useCallback',
    'useMemo',
    'useRef',
    'useLayoutEffect',
    'useDebugValue',
    'useId',
    'useTransition',
    'useDeferredValue',
    'useInsertionEffect',
    'useSyncExternalStore',
    'useOptimistic',
    'querySelector',
    'getElementById',
    'getElementsByClassName',
    'addEventListener',
    'appendChild',
    'createElement',
    'defineComponent',
    'onMounted',
    'computed',
    'reactive',
    'ref',
    'watch',
    'render',
    'mount',
    'unmount',
    'toString',
    'length',
    'slice',
    'split',
    'join',
    'map',
    'filter',
    'reduce',
  ]);

  for (const match of matches) {
    const apiName = match[1];
    const isKnown = knownAPIs.has(apiName);
    const inContext =
      codebaseContext.includes(apiName) || userMessage.includes(apiName);

    if (!isKnown && !inContext) {
      risks.push({
        text: `${apiName}()`,
        type: 'invented_api_name',
        severity: 'medium',
      });
    }
  }

  // Pattern 2: Invented error codes
  const errorCodePattern = /\b(?:Error|error):\s*["']?([A-Z_0-9]{3,})\b/g;
  const errorMatches = response.matchAll(errorCodePattern);

  for (const match of errorMatches) {
    const errorCode = match[1];
    if (errorCode.length > 10 && !knownFacts.some((f) => f.includes(errorCode))) {
      risks.push({
        text: errorCode,
        type: 'invented_error_code',
        severity: 'medium',
      });
    }
  }

  // Pattern 3: Fabricated module/package names
  const importPattern = /(?:import|require|from)\s+["']([^"']+)["']/g;
  const importMatches = response.matchAll(importPattern);
  const commonPackages = [
    'react',
    'vue',
    'angular',
    'svelte',
    'next',
    'nuxt',
    'fastapi',
    'django',
    'express',
    'nodejs',
    'typescript',
    'lodash',
    'moment',
    'axios',
    'fetch',
  ];

  for (const match of importMatches) {
    const packageName = match[1].toLowerCase();
    const looksReal = commonPackages.some((p) => packageName.includes(p));

    if (!looksReal && !codebaseContext.includes(match[1])) {
      risks.push({
        text: match[1],
        type: 'suspicious_import',
        severity: 'low',
      });
    }
  }

  // Calculate hallucination score
  const risksWithWeight = risks.reduce((sum, r) => {
    const severityWeight = { high: 0.3, medium: 0.2, low: 0.1 };
    return sum + (severityWeight[r.severity] || 0.1);
  }, 0);

  const score = Math.min(risksWithWeight, 1.0);

  return { risks, score };
}

// ─── Enforce Epistemic Discipline ───────────────────────────────────────────
// Main guard function — runs analysis + detection

export function enforceEpistemicDiscipline(response) {
  if (!response || typeof response !== 'string') {
    return {
      pass: true,
      score: 1.0,
      violations: [],
      summary: { known: 0, inferred: 0, uncertain: 0, missing: 0 },
    };
  }

  // Run all analyses
  const contentAnalysis = analyzeEpistemicContent(response);
  const overconfidenceDetection = detectOverconfidence(response);
  const hallucinations = detectHallucination(response);

  // Build violations array
  const violations = [];

  // Add overconfidence violations
  for (const claim of overconfidenceDetection.overconfidentClaims) {
    violations.push({
      type: 'overconfidence',
      text: claim.text,
      suggestion: `Consider hedging: add "likely", "probably", or "in this case" before this claim`,
    });
  }

  // Add hallucination violations (separate high-severity risks)
  for (const risk of hallucinations.risks) {
    if (risk.severity === 'high' || risk.severity === 'medium') {
      violations.push({
        type: 'hallucination_risk',
        text: risk.text,
        suggestion: `This may be fabricated. Remove or verify: ${risk.type}`,
      });
    }
  }

  // Identify sentences without proper epistemic markers that make specific claims
  for (const sentence of contentAnalysis.sentences) {
    if (
      sentence.status === 'known' &&
      sentence.text.length > 15 &&
      !sentence.text.match(/^[A-Z][a-z]+\s+is\s+[a-z]/i) // not basic definitions
    ) {
      // Check if it makes a specific claim about something uncertain
      if (
        sentence.text.match(
          /\b(?:your|the|this|that)\s+(?:code|system|app|bug|issue|problem|state|component|function|method)\b/i,
        )
      ) {
        violations.push({
          type: 'ungrounded_claim',
          text: sentence.text.substring(0, 60) + (sentence.text.length > 60 ? '...' : ''),
          suggestion: 'Consider adding epistemic marker: "likely", "probably", etc.',
        });
      }
    }
  }

  // Calculate discipline score
  let score = 1.0;

  // Deductions for violations (more aggressive)
  score -= overconfidenceDetection.score * 0.25;
  score -= hallucinations.score * 0.25;
  
  // Penalty per violation type
  const overconfidenceViolations = violations.filter(v => v.type === 'overconfidence').length;
  const ungroundedViolations = violations.filter(v => v.type === 'ungrounded_claim').length;
  const hallucViolations = violations.filter(v => v.type === 'hallucination_risk').length;
  
  score -= overconfidenceViolations * 0.22;
  score -= ungroundedViolations * 0.18;
  score -= hallucViolations * 0.25;

  // Bonus for acknowledging unknowns
  if (
    contentAnalysis.summary.missing > 0 ||
    response.match(/\b(?:i don't know|i'm not sure|unclear|unknown)\b/i)
  ) {
    score = Math.min(score + 0.15, 1.0);
  }

  // Bonus for uncertainty markers (shows epistemic awareness)
  if (contentAnalysis.summary.uncertain > 0) {
    score = Math.min(score + 0.08, 1.0);
  }

  // Normalize score to 0-1
  score = Math.max(0, Math.min(score, 1.0));

  const pass = score > 0.6;

  return {
    pass,
    score,
    violations,
    summary: contentAnalysis.summary,
  };
}

// ─── Generate Epistemic Prompt Fragment ──────────────────────────────────────
// System prompt instructions for maintaining epistemic discipline

export function generateEpistemicPromptFragment() {
  return `You must maintain epistemic discipline at all times. Distinguish between what is known (factual, verifiable), inferred (logical deduction from known facts), uncertain (plausible but unverified), and missing (information gaps). Never present inference as fact. Never fill gaps with stylistic confidence. Explicitly acknowledge unknowns and limitations. Use appropriate hedging ("likely", "probably", "possibly") for uncertain claims. Never make confident assertions about a user's code or system without seeing it directly.`;
}

export default {
  EPISTEMIC_MARKERS,
  analyzeEpistemicContent,
  detectOverconfidence,
  detectHallucination,
  enforceEpistemicDiscipline,
  generateEpistemicPromptFragment,
};
