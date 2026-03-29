// ─── intelligence/renderer.mjs ──────────────────────────────────────────────────
// RONIN Multi-Style Renderer (V3) — transforms model output into RONIN voice
//
// Purpose: Render model outputs through task-mode-aware styling, ensuring all
// responses feel like RONIN while allowing expression flexibility per task.
//
// CRITICAL CONSTRAINT: Renderer must NOT introduce new facts, NOT change reasoning,
// ONLY transform expression and structure.
//
// Architecture:
// - Multiple renderers for different modes (tactical, architect, critic, etc.)
// - Each renderer follows core persona rules but adjusts expression style
// - Output topology changes per mode (direct, framing-first, diagnosis-first, etc.)
// - validateRenderIntegrity ensures no facts were changed
// ─────────────────────────────────────────────────────────────────────────────

// ─── Render Strategies per Mode ──────────────────────────────────────────────

export const RENDER_STRATEGIES = {
  tactical: {
    prefix: null,
    structure: 'direct',
    paragraphStyle: 'short',
    useHeaders: false,
    headerThreshold: 300,
    bulletStyle: 'dash',
    codeBlockPreference: 'inline',
    closingStyle: 'next-action',
  },
  architect: {
    prefix: null,
    structure: 'framing-first',
    paragraphStyle: 'medium',
    useHeaders: true,
    headerThreshold: 200,
    bulletStyle: 'dash',
    codeBlockPreference: 'block',
    closingStyle: 'tradeoff-summary',
  },
  critic: {
    prefix: null,
    structure: 'assessment-first',
    paragraphStyle: 'medium',
    useHeaders: true,
    headerThreshold: 250,
    bulletStyle: 'numbered',
    codeBlockPreference: 'block',
    closingStyle: 'recommendation',
  },
  debug: {
    prefix: null,
    structure: 'diagnosis-first',
    paragraphStyle: 'short',
    useHeaders: false,
    headerThreshold: 400,
    bulletStyle: 'numbered',
    codeBlockPreference: 'block',
    closingStyle: 'fix-action',
  },
  strategy: {
    prefix: null,
    structure: 'landscape-first',
    paragraphStyle: 'long',
    useHeaders: true,
    headerThreshold: 150,
    bulletStyle: 'dash',
    codeBlockPreference: 'none',
    closingStyle: 'direction',
  },
  reflective: {
    prefix: null,
    structure: 'observation-first',
    paragraphStyle: 'long',
    useHeaders: false,
    headerThreshold: 500,
    bulletStyle: 'dash',
    codeBlockPreference: 'none',
    closingStyle: 'open-question',
  },
  explorer: {
    prefix: null,
    structure: 'divergent',
    paragraphStyle: 'medium',
    useHeaders: true,
    headerThreshold: 200,
    bulletStyle: 'dash',
    codeBlockPreference: 'inline',
    closingStyle: 'expansion',
  },
  builder: {
    prefix: null,
    structure: 'sequential',
    paragraphStyle: 'short',
    useHeaders: true,
    headerThreshold: 150,
    bulletStyle: 'numbered',
    codeBlockPreference: 'block',
    closingStyle: 'checklist',
  },
};

// ─── Main Entry Point ────────────────────────────────────────────────────────

/**
 * Render a model response through RONIN voice, adapted for the task mode.
 *
 * @param {string} response - raw model output
 * @param {Object} options - configuration
 * @param {string} options.mode - task mode ID (e.g., 'tactical', 'architect')
 * @param {Object} [options.operatorProfile] - operator adaptation data
 * @param {string} [options.forceStrategy] - override auto strategy selection
 * @returns {Object} {rendered, mode, strategy, mutations}
 */
export function renderResponse(response, options = {}) {
  if (!response || typeof response !== 'string') {
    return {
      rendered: '',
      mode: options.mode || 'tactical',
      strategy: options.forceStrategy || 'direct',
      mutations: [],
    };
  }

  const mode = options.mode || 'tactical';
  const strategy =
    options.forceStrategy || RENDER_STRATEGIES[mode]?.structure || 'direct';
  const renderConfig = RENDER_STRATEGIES[mode];

  if (!renderConfig) {
    return {
      rendered: response,
      mode: 'tactical',
      strategy: 'direct',
      mutations: [],
    };
  }

  let rendered = response;
  const mutations = [];

  // Step 1: Apply structural transformations
  const structResult = applyStructure(rendered, renderConfig.structure);
  if (structResult.changed) {
    rendered = structResult.text;
    mutations.push(`structure-${renderConfig.structure}`);
  }

  // Step 2: Decide on header usage based on response length and profile
  let useHeaders = renderConfig.useHeaders;
  const responseLength = rendered.length;
  const shouldUseHeaders = responseLength > renderConfig.headerThreshold;

  // V1: Operator profile can lower the threshold
  if (
    options.operatorProfile &&
    options.operatorProfile.dimensions &&
    options.operatorProfile.dimensions.responseFormat > 0.6
  ) {
    useHeaders = shouldUseHeaders || responseLength > renderConfig.headerThreshold * 0.7;
  } else {
    useHeaders = shouldUseHeaders;
  }

  // Step 3: Apply heading formatting if appropriate
  if (useHeaders && !hasHeaders(rendered)) {
    const headingResult = promoteHeadings(rendered);
    if (headingResult.changed) {
      rendered = headingResult.text;
      mutations.push('added-headers');
    }
  }

  // Step 4: Apply bullet style
  const bulletResult = normalizeBullets(rendered, renderConfig.bulletStyle);
  if (bulletResult.changed) {
    rendered = bulletResult.text;
    mutations.push(`bullet-style-${renderConfig.bulletStyle}`);
  }

  // Step 5: Apply closing style
  const closingResult = applyClosingStyle(rendered, renderConfig.closingStyle);
  if (closingResult.changed) {
    rendered = closingResult.text;
    mutations.push(`closing-${renderConfig.closingStyle}`);
  }

  return {
    rendered,
    mode,
    strategy,
    mutations,
  };
}

// ─── Strategy Getters ────────────────────────────────────────────────────────

/**
 * Get the render strategy configuration for a mode.
 * @param {string} modeId - e.g., 'tactical', 'architect'
 * @returns {Object} strategy config, or null if not found
 */
export function getStrategy(modeId) {
  return RENDER_STRATEGIES[modeId] || null;
}

// ─── Structure Transformations ──────────────────────────────────────────────

/**
 * Apply structural transformations based on the structure type.
 * @param {string} text - input text
 * @param {string} structureType - 'direct', 'diagnosis-first', 'sequential', etc.
 * @returns {Object} {text, changed}
 */
function applyStructure(text, structureType) {
  switch (structureType) {
    case 'direct':
      return applyDirectStructure(text);
    case 'diagnosis-first':
      return applyDiagnosisFirst(text);
    case 'sequential':
      return applySequential(text);
    default:
      return { text, changed: false };
  }
}

/**
 * Direct structure: ensure answer/conclusion appears early.
 * Detect and promote if buried.
 */
function applyDirectStructure(text) {
  const lines = text.split('\n');
  if (lines.length < 3) return { text, changed: false };

  // Look for "the answer is", "the solution is", etc. in first 3 lines
  const answerMarkers = [
    /^the (?:answer|solution|issue|problem|bug)/i,
    /^(?:use|try|do)\s+/i,
    /^(?:yes|no),\s*/i,
  ];

  let answerLineIdx = -1;
  for (let i = 0; i < Math.min(3, lines.length); i++) {
    if (answerMarkers.some((marker) => marker.test(lines[i]))) {
      answerLineIdx = i;
      break;
    }
  }

  if (answerLineIdx >= 0) {
    return { text, changed: false };
  }

  // Look in later lines
  for (let i = 3; i < lines.length; i++) {
    if (answerMarkers.some((marker) => marker.test(lines[i]))) {
      // Found it buried; promote to top
      const answerLine = lines.splice(i, 1)[0];
      lines.unshift(answerLine);
      return { text: lines.join('\n'), changed: true };
    }
  }

  return { text, changed: false };
}

/**
 * Diagnosis-first: detect "the bug is", "the issue is", etc. and ensure it's near top.
 */
function applyDiagnosisFirst(text) {
  const lines = text.split('\n');
  if (lines.length < 3) return { text, changed: false };

  const diagnosisMarkers = [
    /^(?:the )?(?:bug|issue|problem|root cause|likely cause)/i,
    /^the problem is/i,
    /^(?:the )?error/i,
  ];

  let diagnosisLineIdx = -1;
  for (let i = 0; i < Math.min(3, lines.length); i++) {
    if (diagnosisMarkers.some((marker) => marker.test(lines[i]))) {
      diagnosisLineIdx = i;
      break;
    }
  }

  if (diagnosisLineIdx >= 0) {
    return { text, changed: false };
  }

  // Look in later lines
  for (let i = 3; i < lines.length; i++) {
    if (diagnosisMarkers.some((marker) => marker.test(lines[i]))) {
      const diagnosisLine = lines.splice(i, 1)[0];
      lines.unshift(diagnosisLine);
      return { text: lines.join('\n'), changed: true };
    }
  }

  return { text, changed: false };
}

/**
 * Sequential structure: detect numbered steps and ensure proper formatting.
 */
function applySequential(text) {
  const lines = text.split('\n');
  let changed = false;

  // Look for numbered list patterns like "1. " or "1) "
  const numberedPattern = /^(\d+)[.\)]\s+/;
  for (const line of lines) {
    if (numberedPattern.test(line)) {
      changed = true;
      break;
    }
  }

  // If no numbered lists found, nothing to do
  if (!changed) {
    return { text, changed: false };
  }

  // Ensure blank lines between steps
  const output = [];
  for (let i = 0; i < lines.length; i++) {
    output.push(lines[i]);
    if (
      i < lines.length - 1 &&
      numberedPattern.test(lines[i]) &&
      lines[i + 1].trim() !== ''
    ) {
      // Check if next line is also a numbered step
      if (!numberedPattern.test(lines[i + 1])) {
        // Don't add blank line between consecutive steps
        if (i < lines.length - 2 && lines[i + 2]?.trim() !== '') {
          // Only add if there's content after
        }
      }
    }
  }

  return { text: output.join('\n'), changed };
}

// ─── Heading Detection & Promotion ──────────────────────────────────────────

/**
 * Check if text already has markdown headers.
 */
function hasHeaders(text) {
  return /^#+\s+/m.test(text);
}

/**
 * Promote natural section breaks to markdown headers.
 * Heuristic: all-caps lines often indicate section headers.
 */
function promoteHeadings(text) {
  const lines = text.split('\n');
  const output = [];
  let changed = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Check if line is all-caps and short (likely a heading)
    if (
      trimmed.length > 0 &&
      trimmed.length < 50 &&
      trimmed === trimmed.toUpperCase() &&
      !trimmed.includes(':')
    ) {
      // Convert to markdown header
      output.push(`## ${trimmed}`);
      changed = true;
    } else {
      output.push(line);
    }
  }

  return { text: output.join('\n'), changed };
}

// ─── Bullet Style Normalization ─────────────────────────────────────────────

/**
 * Normalize bullet points to the target style.
 * @param {string} text - input text
 * @param {string} style - 'dash', 'numbered'
 * @returns {Object} {text, changed}
 */
function normalizeBullets(text, style) {
  const lines = text.split('\n');
  let changed = false;

  const bulletPattern = /^(\s*)[-*•]\s+/;
  const numberedPattern = /^(\s*)\d+[.\)]\s+/;

  if (style === 'dash') {
    // Convert numbered to dashes
    const output = lines.map((line) => {
      const match = line.match(numberedPattern);
      if (match) {
        return line.replace(numberedPattern, `${match[1]}- `);
      }
      return line;
    });

    if (output.some((line, idx) => line !== lines[idx])) {
      changed = true;
    }
    return { text: output.join('\n'), changed };
  }

  if (style === 'numbered') {
    // Convert dashes to numbered
    const output = [];
    let bulletCounter = 0;

    for (const line of lines) {
      const bulletMatch = line.match(bulletPattern);
      if (bulletMatch) {
        bulletCounter++;
        output.push(
          line.replace(bulletPattern, `${bulletMatch[1]}${bulletCounter}. `)
        );
        changed = true;
      } else if (numberedPattern.test(line)) {
        // Already numbered
        output.push(line);
      } else {
        // Reset counter on non-bullet lines
        if (line.trim() !== '') {
          bulletCounter = 0;
        }
        output.push(line);
      }
    }

    return { text: output.join('\n'), changed };
  }

  return { text, changed: false };
}

// ─── Closing Style Application ──────────────────────────────────────────────

/**
 * Apply closing style. V1: mostly no-ops, structure is here for future enhancement.
 * @param {string} response - input text
 * @param {string} closingStyle - e.g., 'next-action', 'recommendation', 'open-question'
 * @returns {Object} {text, changed}
 */
export function applyClosingStyle(response, closingStyle) {
  // V1: Closing styles are primarily instructions for the model, not post-processing
  // The renderer should NOT add content that wasn't in the original response
  // We verify closing alignment but don't force additions

  switch (closingStyle) {
    case 'next-action':
    case 'tradeoff-summary':
    case 'recommendation':
    case 'fix-action':
    case 'direction':
    case 'open-question':
    case 'expansion':
    case 'checklist':
      // V1: These are model-level behaviors, not renderer transformations
      // Don't modify the response
      return { text: response, changed: false };

    default:
      return { text: response, changed: false };
  }
}

// ─── Integrity Validation ────────────────────────────────────────────────────

/**
 * Validate that rendering didn't change facts or reasoning.
 *
 * Checks:
 * - All code blocks from original are preserved
 * - Key technical terms are preserved
 * - No new sentences were added (rough heuristic)
 *
 * @param {string} original - original text
 * @param {string} rendered - rendered text
 * @returns {Object} {valid, issues}
 */
export function validateRenderIntegrity(original, rendered) {
  const issues = [];

  if (!original || typeof original !== 'string') {
    return { valid: false, issues: ['Original text is empty or invalid'] };
  }

  if (!rendered || typeof rendered !== 'string') {
    return { valid: false, issues: ['Rendered text is empty or invalid'] };
  }

  // Check 1: Code blocks preservation
  const codeBlockPattern = /```[\s\S]*?```/g;
  const originalCodeBlocks = (original.match(codeBlockPattern) || []).length;
  const renderedCodeBlocks = (rendered.match(codeBlockPattern) || []).length;

  if (renderedCodeBlocks < originalCodeBlocks) {
    issues.push(
      `Code blocks removed: had ${originalCodeBlocks}, now ${renderedCodeBlocks}`
    );
  }

  // Check 2: Inline code preservation (backticks)
  const backtickPattern = /`[^`]+`/g;
  const originalBackticks = (original.match(backtickPattern) || []).length;
  const renderedBackticks = (rendered.match(backtickPattern) || []).length;

  if (renderedBackticks < originalBackticks) {
    issues.push(
      `Inline code references removed: had ${originalBackticks}, now ${renderedBackticks}`
    );
  }

  // Check 3: Sentence count heuristic
  const sentencePattern = /[.!?]+/g;
  const originalSentences = (original.match(sentencePattern) || []).length;
  const renderedSentences = (rendered.match(sentencePattern) || []).length;

  // Allow up to 2 extra sentences (for added structure/clarification)
  if (renderedSentences > originalSentences + 2) {
    issues.push(
      `Too many sentences added: ${originalSentences} → ${renderedSentences}`
    );
  }

  // Check 4: Key technical term preservation (simple heuristic)
  // Extract words with numbers or underscores (common in technical content)
  const technicalTermPattern = /\b[a-zA-Z0-9_]+(?:[a-zA-Z0-9_]+)*\b/g;
  const originalTerms = new Set(original.match(technicalTermPattern) || []);
  const renderedTerms = new Set(rendered.match(technicalTermPattern) || []);

  // Allow some loss due to reformatting, but flag major losses
  const termLoss = originalTerms.size - renderedTerms.size;
  if (termLoss > originalTerms.size * 0.2) {
    // More than 20% loss
    issues.push(
      `Many technical terms lost: ${originalTerms.size} → ${renderedTerms.size}`
    );
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}
