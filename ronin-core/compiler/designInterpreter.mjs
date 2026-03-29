// ─── compiler/designInterpreter.mjs ──────────────────────────────────────────
// D6 · Seat 7 — Design Interpreter
//
// Reads designer's VISUAL INTENT from Figma screenshot + layer hierarchy.
// Runs at Gate 03 entry, before fidelity pipeline Stage 2.
// Understands what the designer meant — not what to code.
//
// Model: Sonnet 4.6 with vision
// Input: Figma screenshot (base64 PNG) + layer hierarchy
// Output: Design interpretation document (structured JSON)
// Cost: ~$0.003/call
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The canonical interpretation schema.
 * All 7 fields are required. No numeric values. No code references.
 */
export const INTERPRETATION_SCHEMA = {
  emotional_register: {
    description: "What is the emotional tone? (formal, playful, urgent, calm, etc.)",
    type: "string",
    required: true,
  },
  primary_metaphor: {
    description: "What is the primary visual metaphor or conceptual frame?",
    type: "string",
    required: true,
  },
  motion_implied: {
    description: "What motion does this design imply? What would move and how?",
    type: "string",
    required: true,
  },
  hierarchy_strategy: {
    description: "How is visual hierarchy communicated? (size, color, depth, spacing, opacity, etc.)",
    type: "string",
    required: true,
  },
  component_role: {
    description: "What role does this component play in the larger system?",
    type: "string",
    required: true,
  },
  designer_intent: {
    description: "What does the designer want the user to feel or understand?",
    type: "string",
    required: true,
  },
  interaction_vocabulary: {
    description: "What interaction vocabulary does the design imply? (hover=?, click=?, drag=?, etc.)",
    type: "string",
    required: true,
  },
};

/**
 * The system prompt used for all interpretation calls.
 * This is locked — it defines the persona and constraints.
 */
const SYSTEM_PROMPT = `You are reading a designer's intention, not a developer's spec.

You have been given:
1. A screenshot of a Figma design frame
2. The layer hierarchy with designer-chosen names

Your job is to understand what the designer MEANT — not what they drew.

Analyze:
- What is the emotional register of this design? (formal? playful? urgent? calm?)
- What is the primary metaphor? (data surface? conversation? workspace? tool?)
- What motion does this design imply? (what would move? how? why?)
- How is hierarchy communicated? (through size? color? depth? spacing? opacity?)
- What role does this component play? (primary action? navigation? information? status?)
- What is the designer's intent for the user? (guide them? empower them? inform them?)
- What interaction vocabulary fits? (hover=?, click=?, drag=?, scroll=?)

Output a JSON object with these fields:
{
  "emotional_register": "...",
  "primary_metaphor": "...",
  "motion_implied": "...",
  "hierarchy_strategy": "...",
  "component_role": "...",
  "designer_intent": "...",
  "interaction_vocabulary": "..."
}

You are PROHIBITED from:
- Writing any code
- Mentioning any CSS property or HTML element
- Producing any numeric values (px, colors, etc.)
- Reproducing or describing the layout mechanically

Think like a creative director reviewing a comp, not like a developer reading a spec.`;

let modelProvider = null;

/**
 * Build the interpretation prompt for Sonnet with vision.
 *
 * @param {string} screenshotBase64 - base64 PNG string of the Figma screenshot
 * @param {Array<{id: string, name: string, type: string, children?: Array}>} layerHierarchy - simplified layer tree
 * @returns {{systemPrompt: string, userPrompt: string, tokenEstimate: number}}
 */
export function buildInterpretationPrompt(screenshotBase64, layerHierarchy) {
  if (!screenshotBase64 || typeof screenshotBase64 !== "string") {
    throw new Error("screenshotBase64 must be a non-empty string");
  }
  if (!Array.isArray(layerHierarchy)) {
    throw new Error("layerHierarchy must be an array");
  }

  // Build a text representation of the layer hierarchy
  const hierarchyText = formatLayerHierarchy(layerHierarchy);

  // User prompt includes the hierarchy and instructions for vision analysis
  const userPrompt = `I have a Figma design. Here is the layer hierarchy:

${hierarchyText}

Study the screenshot and the layer names. What is the designer trying to communicate?`;

  // Rough token estimate: system ~300, user ~200-400, image ~500
  const tokenEstimate = 300 + 300 + 500;

  return {
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    tokenEstimate,
  };
}

/**
 * Format a layer hierarchy into readable text for the prompt.
 */
function formatLayerHierarchy(layers, indent = 0) {
  let text = "";
  for (const layer of layers) {
    text += " ".repeat(indent) + `- ${layer.name} (${layer.type})\n`;
    if (layer.children && layer.children.length > 0) {
      text += formatLayerHierarchy(layer.children, indent + 2);
    }
  }
  return text;
}

/**
 * Run the interpretation pipeline.
 *
 * @param {string} screenshotBase64 - base64 PNG of Figma screenshot
 * @param {Array} layerHierarchy - simplified layer tree
 * @param {Object} options - { provider?, timeout? }
 * @returns {Promise<{
 *   interpretation: object,
 *   valid: boolean,
 *   missingFields: string[],
 *   tokenUsage: {input: number, output: number},
 *   costEstimate: number,
 *   latencyMs: number
 * }>}
 */
export async function interpret(screenshotBase64, layerHierarchy, options = {}) {
  const startTime = Date.now();
  const { provider = modelProvider, timeout = 8000 } = options;

  if (!provider) {
    throw new Error("No model provider set. Call _setProvider() or pass via options.");
  }

  // Build the prompt
  const { systemPrompt, userPrompt, tokenEstimate } = buildInterpretationPrompt(
    screenshotBase64,
    layerHierarchy
  );

  // Call the provider with vision support
  let response;
  try {
    response = await Promise.race([
      provider({
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: screenshotBase64 },
              },
              {
                type: "text",
                text: userPrompt,
              },
            ],
          },
        ],
        max_tokens: 500,
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Interpretation timeout")), timeout)
      ),
    ]);
  } catch (error) {
    throw new Error(`Provider call failed: ${error.message}`);
  }

  // Parse the response
  const { interpretation, valid, missingFields, parseError } = parseInterpretation(response);

  if (!valid && parseError) {
    throw new Error(`Parse failed: ${parseError}`);
  }

  const latencyMs = Date.now() - startTime;

  // Estimate token usage and cost
  const inputTokens = tokenEstimate;
  const outputTokens = response.usage?.output_tokens || 250;
  const costEstimate = (inputTokens * 0.003 + outputTokens * 0.006) / 1000; // Sonnet 4.6 pricing

  return {
    interpretation: interpretation || {},
    valid,
    missingFields,
    tokenUsage: { input: inputTokens, output: outputTokens },
    costEstimate,
    latencyMs,
  };
}

/**
 * Parse model response into interpretation object.
 * Handles JSON in code blocks or raw JSON.
 *
 * @param {string|object} response - model response (or object with .content property)
 * @returns {{interpretation: object|null, valid: boolean, missingFields: string[], parseError: string|null}}
 */
export function parseInterpretation(response) {
  const missingFields = [];
  let jsonStr = null;

  // Extract text content from response
  let text = response;
  if (typeof response === "object" && response.content) {
    text = response.content;
  }

  if (typeof text !== "string") {
    return {
      interpretation: null,
      valid: false,
      missingFields: [],
      parseError: "Response is not a string",
    };
  }

  // Try to extract JSON from code block
  const codeBlockMatch = text.match(/```(?:json)?\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1];
  } else {
    // Try raw JSON
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      jsonStr = jsonMatch[0];
    }
  }

  if (!jsonStr) {
    return {
      interpretation: null,
      valid: false,
      missingFields: [],
      parseError: "No JSON found in response",
    };
  }

  // Parse JSON
  let interpretation;
  try {
    interpretation = JSON.parse(jsonStr);
  } catch (error) {
    return {
      interpretation: null,
      valid: false,
      missingFields: [],
      parseError: `JSON parse error: ${error.message}`,
    };
  }

  // Validate all 7 required fields
  const requiredFields = [
    "emotional_register",
    "primary_metaphor",
    "motion_implied",
    "hierarchy_strategy",
    "component_role",
    "designer_intent",
    "interaction_vocabulary",
  ];

  for (const field of requiredFields) {
    if (!interpretation.hasOwnProperty(field) || !interpretation[field]) {
      missingFields.push(field);
    }
  }

  const valid = missingFields.length === 0;

  return {
    interpretation: valid ? interpretation : null,
    valid,
    missingFields,
    parseError: null,
  };
}

/**
 * Simplify a full Figma node tree to a layer hierarchy.
 * Strips all visual properties, keeps only: id, name, type, children
 *
 * @param {object} nodeTree - full node tree with visual properties
 * @returns {Array}
 */
export function extractLayerHierarchy(nodeTree) {
  if (!nodeTree) return [];

  function simplify(node) {
    const simplified = {
      id: node.id,
      name: node.name,
      type: node.type,
    };

    if (node.children && Array.isArray(node.children) && node.children.length > 0) {
      simplified.children = node.children.map(simplify);
    }

    return simplified;
  }

  return [simplify(nodeTree)];
}

/**
 * Merge multiple interpretations.
 * Takes the most recent if the same component is interpreted multiple times.
 *
 * @param {Array<{interpretation: object, timestamp?: number}>} interpretations
 * @returns {object} - merged interpretation
 */
export function mergeInterpretations(interpretations) {
  if (!Array.isArray(interpretations) || interpretations.length === 0) {
    return {};
  }

  // Sort by timestamp descending (most recent first)
  const sorted = [...interpretations].sort(
    (a, b) => (b.timestamp || 0) - (a.timestamp || 0)
  );

  // Return the most recent
  return sorted[0]?.interpretation || {};
}

/**
 * Convert interpretation to a prompt fragment for Stage 2.
 * Produces a 2-3 sentence summary for Sonnet's semantic pass.
 *
 * @param {object} interpretation - the interpretation object
 * @returns {string|null}
 */
export function interpretationToPromptFragment(interpretation) {
  if (!interpretation || Object.keys(interpretation).length === 0) {
    return null;
  }

  const {
    emotional_register,
    primary_metaphor,
    motion_implied,
    hierarchy_strategy,
    component_role,
    designer_intent,
  } = interpretation;

  if (!emotional_register || !primary_metaphor) {
    return null;
  }

  // Build a 2-3 sentence summary
  const summary = `The design has a ${emotional_register} tone, organized around the metaphor of "${primary_metaphor}". ` +
    `The hierarchy is communicated through ${hierarchy_strategy}. ` +
    `The designer intends for users to ${designer_intent}.`;

  return summary;
}

/**
 * Inject the model provider (Sonnet with vision capability).
 */
export function _setProvider(fn) {
  if (typeof fn !== "function") {
    throw new Error("Provider must be a function");
  }
  modelProvider = fn;
}

/**
 * Reset provider (for testing).
 */
export function _resetProvider() {
  modelProvider = null;
}
