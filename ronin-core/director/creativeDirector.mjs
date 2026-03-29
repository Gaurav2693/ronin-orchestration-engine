// ─── director/creativeDirector.mjs ────────────────────────────────────────
// D7 · Creative Director Context Assembler + Opus Integration
//
// Takes completed fidelity output + design intent, produces "Director's Cut"
// via Opus 4.6. Adds motion, states, microinteractions, texture.
// NEVER modifies fidelity output. Produces parallel creative expression layer.
//
// Activation: Only when operator explicitly taps "Director" button.
// Cost: ~$0.034 per invocation (Opus creative pass)
// ─────────────────────────────────────────────────────────────────────────

/**
 * The locked Creative Director system prompt.
 * Never changes. This defines the role, constraints, and creative boundaries.
 */
export const DIRECTOR_SYSTEM_PROMPT = `You are a creative director reviewing a design handoff.

You are not a translator. The translation already exists — it is in the fidelity output
you have been given. Your job is not to reproduce the design. Your job is to answer:

"What would this become if it were fully alive?"

You have been given:
— The original Figma screenshot: study it as a designer would. What is the emotional
  register? What is being communicated beyond the layout? What does the stillness imply
  about motion?
— The designer's accumulated taste: [TASTE_CONTEXT]
— The pixel-perfect reproduction: treat this as a hard constraint. You cannot change
  layout, dimensions, colors, or typography. The structure is locked.
  You are adding a layer of expression on top of it.

Your creative space is:
— Motion: what transitions, microinteractions, and animations reveal the intent?
— States: what hover, focus, active, empty, loading, and error states does the design
  imply but not show?
— Hierarchy: what subtle weight shifts in opacity, scale, or timing communicate the
  component's purpose?
— Texture: what subtle animations (breathing, pulsing, tracking) make this feel alive
  without being distracting?

Hard rules:
— The external API of the component does not change. Same props, same layout contract.
— Nothing you add should break the 2% fidelity score.
— You are not redesigning. You are animating an intention.
— Every change must have a reason. "It looks better" is not a reason.

Structure your output as exactly three sections:

KEPT
What you preserved from the original and why it was already right.

CHANGED
What you augmented, what you added, and the precise creative reason for each decision.
Be specific: not "added hover state" but "hover lifts the card 2px and dims surrounding
elements 15% — because the design implies a selection metaphor, not a click metaphor."

CODE
The augmented React component. Full file. Ready to use.`;

let modelProvider = null;

// ─── Core Functions ──────────────────────────────────────────────────────

/**
 * Build taste context string from taste snapshot.
 * If snapshot has narrative: return narrative.
 * If snapshot has preferences but no narrative: summarize preferences.
 * If null/empty: return fallback.
 *
 * @param {Object|null} tasteSnapshot - taste snapshot with optional narrative + preferences
 * @returns {string} - context string for injection into prompt
 */
export function buildTasteContextString(tasteSnapshot) {
  if (!tasteSnapshot) {
    return 'No taste history available yet. Use your best creative judgment.';
  }

  // If narrative exists, use it directly
  if (tasteSnapshot.narrative && typeof tasteSnapshot.narrative === 'string') {
    return tasteSnapshot.narrative;
  }

  // If preferences exist but no narrative, summarize
  if (tasteSnapshot.strong_preferences && Array.isArray(tasteSnapshot.strong_preferences)) {
    const prefs = tasteSnapshot.strong_preferences;
    if (prefs.length > 0) {
      const summaries = prefs.slice(0, 3).map(p =>
        `${p.dimension}: ${p.preference}`
      ).join('; ');
      return `This operator has shown patterns in: ${summaries}. Apply these sensibilities to creative decisions.`;
    }
  }

  // Fallback
  return 'No taste history available yet. Use your best creative judgment.';
}

/**
 * Assemble the 4 inputs for Opus into a context object.
 *
 * @param {Object} session - { figmaScreenshot, layerHierarchy, tasteSnapshot, fidelityCode, interpretation? }
 * @returns {Object} - { systemPrompt, userPrompt, tokenEstimate, contextItems }
 */
export function assembleDirectorContext(session) {
  if (!session) {
    throw new Error('assembleDirectorContext: session is required');
  }

  const {
    figmaScreenshot,
    layerHierarchy,
    tasteSnapshot,
    fidelityCode,
    interpretation,
  } = session;

  if (!figmaScreenshot || typeof figmaScreenshot !== 'string') {
    throw new Error('assembleDirectorContext: figmaScreenshot must be a non-empty string');
  }

  if (!Array.isArray(layerHierarchy) || layerHierarchy.length === 0) {
    throw new Error('assembleDirectorContext: layerHierarchy must be a non-empty array');
  }

  if (!fidelityCode || typeof fidelityCode !== 'string') {
    throw new Error('assembleDirectorContext: fidelityCode must be a non-empty string');
  }

  // Build taste context
  const tasteContext = buildTasteContextString(tasteSnapshot);

  // Inject taste into system prompt
  const systemPrompt = DIRECTOR_SYSTEM_PROMPT.replace('[TASTE_CONTEXT]', tasteContext);

  // Build layer hierarchy text
  const hierarchyText = formatLayerHierarchy(layerHierarchy);

  // Build user prompt with all 4 inputs
  let userPrompt = `Here is the design handoff:

## Original Figma Screenshot
[Reference Figma design — study the visual intent, emotional tone, and what motion/states are implied]

## Layer Hierarchy (Designer's Vocabulary)
${hierarchyText}

## Design Interpretation
${interpretation ? JSON.stringify(interpretation, null, 2) : '(No interpretation available)'}

## Fidelity Output (Hard Constraint)
This is the pixel-perfect reproduction. You cannot change layout, dimensions, colors, or typography.
\`\`\`tsx
${fidelityCode}
\`\`\`

Now, enhance this component with creative expression. What would this become if it were fully alive?

Structure your response as exactly three sections: KEPT, CHANGED, CODE.`;

  // Estimate tokens: system ~400, user prompt ~1200, screenshot ~500, code ~2000
  const tokenEstimate = 400 + 1200 + 500 + Math.min(fidelityCode.length / 4, 2000);

  // List what was included
  const contextItems = [
    'figmaScreenshot (base64 PNG)',
    'layerHierarchy',
    'tasteSnapshot' + (tasteSnapshot ? ' (with narrative)' : ' (null)'),
    'fidelityCode',
  ];

  if (interpretation) {
    contextItems.push('interpretation');
  }

  return {
    systemPrompt,
    userPrompt,
    tokenEstimate: Math.round(tokenEstimate),
    contextItems,
  };
}

/**
 * Format layer hierarchy into readable text for prompt.
 */
function formatLayerHierarchy(layers, indent = 0) {
  let text = '';
  for (const layer of layers) {
    text += ' '.repeat(indent) + `- ${layer.name} (${layer.type})\n`;
    if (layer.children && Array.isArray(layer.children) && layer.children.length > 0) {
      text += formatLayerHierarchy(layer.children, indent + 2);
    }
  }
  return text;
}

/**
 * Parse Director response into KEPT/CHANGED/CODE sections.
 *
 * @param {string} response - raw response from Opus
 * @returns {Object} - { kept, changed, code, parseErrors }
 */
export function parseDirectorResponse(response) {
  const parseErrors = [];

  if (!response || typeof response !== 'string') {
    parseErrors.push('Response is not a string');
    return { kept: null, changed: null, code: null, parseErrors };
  }

  // Split by section headers
  const keptIndex = response.indexOf('KEPT');
  const changedIndex = response.indexOf('CHANGED');
  const codeIndex = response.indexOf('CODE');

  let kept = null;
  let changed = null;
  let code = null;

  // Extract KEPT section
  if (keptIndex !== -1) {
    let endIdx = changedIndex !== -1 ? changedIndex : (codeIndex !== -1 ? codeIndex : response.length);
    kept = response.substring(keptIndex + 4, endIdx).trim();
    if (!kept) {
      kept = null;
      parseErrors.push('KEPT section is empty');
    }
  } else {
    parseErrors.push('KEPT section not found');
  }

  // Extract CHANGED section
  if (changedIndex !== -1) {
    let endIdx = codeIndex !== -1 ? codeIndex : response.length;
    changed = response.substring(changedIndex + 7, endIdx).trim();
    if (!changed) {
      changed = null;
      parseErrors.push('CHANGED section is empty');
    }
  } else {
    parseErrors.push('CHANGED section not found');
  }

  // Extract CODE section
  if (codeIndex !== -1) {
    let codeContent = response.substring(codeIndex + 4).trim();
    // Remove backtick code block if present
    const backtickMatch = codeContent.match(/```(?:tsx|jsx|)?\s*([\s\S]*?)\s*```/);
    if (backtickMatch) {
      code = backtickMatch[1].trim();
    } else {
      code = codeContent;
    }
    if (!code) {
      code = null;
      parseErrors.push('CODE section is empty');
    }
  } else {
    parseErrors.push('CODE section not found');
  }

  return { kept, changed, code, parseErrors };
}

/**
 * Validate that Director output preserves component API and constraints.
 *
 * @param {string} fidelityCode - original fidelity output
 * @param {string} directorCode - new director output
 * @returns {Object} - { valid, issues }
 */
export function validateDirectorOutput(fidelityCode, directorCode) {
  const issues = [];

  if (!fidelityCode || typeof fidelityCode !== 'string') {
    return { valid: false, issues: ['fidelityCode must be non-empty string'] };
  }

  if (!directorCode || typeof directorCode !== 'string') {
    return { valid: false, issues: ['directorCode must be non-empty string'] };
  }

  // Extract component export names
  const fidelityExportMatch = fidelityCode.match(/export\s+(?:default\s+)?(?:function|const)\s+(\w+)/);
  const directorExportMatch = directorCode.match(/export\s+(?:default\s+)?(?:function|const)\s+(\w+)/);

  const fidelityName = fidelityExportMatch?.[1];
  const directorName = directorExportMatch?.[1];

  if (fidelityName && directorName && fidelityName !== directorName) {
    issues.push(`Component export name changed from ${fidelityName} to ${directorName}`);
  }

  // Extract prop interfaces (rough check — look for const <Name> = ({ ... }) =>)
  const fidelityPropsMatch = fidelityCode.match(/=\s*\(\s*\{\s*([^}]+)\s*\}\s*\)\s*=>/);
  const directorPropsMatch = directorCode.match(/=\s*\(\s*\{\s*([^}]+)\s*\}\s*\)\s*=>/);

  if (fidelityPropsMatch && directorPropsMatch) {
    const fidelityProps = fidelityPropsMatch[1].split(/[,:\n]/).filter(p => p.trim()).slice(0, 3);
    const directorProps = directorPropsMatch[1].split(/[,:\n]/).filter(p => p.trim()).slice(0, 3);

    // Check if key props are removed
    for (const prop of fidelityProps) {
      if (!directorPropsMatch[0].includes(prop)) {
        issues.push(`Prop removed: ${prop}`);
      }
    }
  }

  // Check that CSS dimensions/colors are preserved (rough heuristic)
  // Count occurrences of px values and color values
  const fidelityPxCount = (fidelityCode.match(/\d+px/g) || []).length;
  const directorPxCount = (directorCode.match(/\d+px/g) || []).length;

  // Allow some variance (±30%) but flag if too many changed
  if (fidelityPxCount > 0 && directorPxCount < fidelityPxCount * 0.7) {
    issues.push('Many layout dimensions appear to have been changed');
  }

  const valid = issues.length === 0;

  return { valid, issues };
}

/**
 * Extract creative decisions from CHANGED section.
 * Parses structured decisions: type, description, reason.
 *
 * @param {string} changedSection - CHANGED section content
 * @returns {Array} - [{ type, description, reason }, ...]
 */
export function extractCreativeDecisions(changedSection) {
  if (!changedSection || typeof changedSection !== 'string') {
    return [];
  }

  const decisions = [];

  // Look for patterns like: "motion: ...", "state: ...", "hierarchy: ...", "texture: ..."
  // The reason is after — (em-dash) or - (hyphen)
  const patterns = [
    { type: 'motion', regex: /motion[:\s]+([^\n—-]+)(?:[—-]\s*([^\n]+))?/gi },
    { type: 'state', regex: /(?:state|hover|focus|active|empty|loading|error)[:\s]+([^\n—-]+)(?:[—-]\s*([^\n]+))?/gi },
    { type: 'hierarchy', regex: /hierarchy[:\s]+([^\n—-]+)(?:[—-]\s*([^\n]+))?/gi },
    { type: 'texture', regex: /texture[:\s]+([^\n—-]+)(?:[—-]\s*([^\n]+))?/gi },
  ];

  for (const pattern of patterns) {
    let match;
    const regex = pattern.regex;
    regex.lastIndex = 0; // Reset regex state

    while ((match = regex.exec(changedSection)) !== null) {
      decisions.push({
        type: pattern.type,
        description: match[1]?.trim() || '',
        reason: match[2]?.trim() || '',
      });
    }
  }

  return decisions;
}

/**
 * Run the complete Creative Director pipeline.
 *
 * @param {Object} session - { figmaScreenshot, layerHierarchy, tasteSnapshot, fidelityCode, interpretation? }
 * @param {Object} options - { provider, timeout, maxTokens }
 * @returns {Promise<Object>} - { kept, changed, code, valid, validationIssues, tokenUsage, costEstimate, latencyMs }
 */
export async function runDirector(session, options = {}) {
  const startTime = Date.now();
  const {
    provider = modelProvider,
    timeout = 60000,
    maxTokens = 3000,
  } = options;

  if (!provider) {
    throw new Error('No model provider set. Call _setProvider() or pass via options.');
  }

  // Validate fidelity code exists
  if (!session?.fidelityCode) {
    throw new Error('runDirector: session.fidelityCode is required');
  }

  // Assemble context
  const context = assembleDirectorContext(session);

  // Call Opus
  let response;
  try {
    response = await Promise.race([
      provider({
        system: context.systemPrompt,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: session.figmaScreenshot,
                },
              },
              {
                type: 'text',
                text: context.userPrompt,
              },
            ],
          },
        ],
        max_tokens: maxTokens,
      }),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`Director timeout after ${timeout}ms`)),
          timeout
        )
      ),
    ]);
  } catch (error) {
    throw new Error(`Director provider call failed: ${error.message}`);
  }

  // Parse response
  const { kept, changed, code, parseErrors } = parseDirectorResponse(
    typeof response === 'string' ? response : response?.content || ''
  );

  // Validate output
  const validation = validateDirectorOutput(session.fidelityCode, code || '');

  // Calculate cost and latency
  const latencyMs = Date.now() - startTime;
  const inputTokens = context.tokenEstimate;
  const outputTokens = response?.usage?.output_tokens || 1500;
  const tokenUsage = { input: inputTokens, output: outputTokens };

  // Opus cost: ~$0.015 per 1M input tokens, ~$0.060 per 1M output tokens
  const costEstimate = (inputTokens * 0.000015) + (outputTokens * 0.000060);

  return {
    kept,
    changed,
    code,
    valid: validation.valid && parseErrors.length === 0,
    validationIssues: [...validation.issues, ...parseErrors],
    tokenUsage,
    costEstimate: Math.round(costEstimate * 100000) / 100000, // 5 decimals
    latencyMs,
  };
}

/**
 * Inject the model provider.
 */
export function _setProvider(fn) {
  if (typeof fn !== 'function') {
    throw new Error('Provider must be a function');
  }
  modelProvider = fn;
}

/**
 * Reset provider (for testing).
 */
export function _resetProvider() {
  modelProvider = null;
}
