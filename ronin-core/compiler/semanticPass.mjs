// ─── compiler/semanticPass.mjs ────────────────────────────────────────────
// D3 Semantic Pass — Stage 2 of RONIN Design Intelligence
//
// Takes Stage 1 (deterministic CSS) and wraps it into React components.
// Uses Sonnet for structural intelligence (naming, grouping, safe flexbox conversion)
// but NEVER changes any numeric CSS value.
//
// Hard Constraints (from RONIN_DESIGN_INTELLIGENCE.md §4.2):
// — Sonnet receives Stage 1 CSS output as a hard constraint
// — It CANNOT change any numeric value (px, color, radius, opacity)
// — It CAN: wrap CSS into React components, consolidate duplicate colors,
//   convert absolute→flexbox ONLY when parent has layoutMode HORIZONTAL/VERTICAL
//   and children have layoutGrow:1
// — It CANNOT: add hover states, transitions, animations, pseudo-selectors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract all numeric and color values from Stage 1 CSS for validation
 */
function extractCSSValues(cssObject) {
  const values = [];

  for (const [key, value] of Object.entries(cssObject)) {
    if (value === null || value === undefined) continue;

    // Extract px values
    const pxMatches = String(value).match(/(\d+(?:\.\d+)?)\s*px/g);
    if (pxMatches) {
      values.push(...pxMatches);
    }

    // Extract hex colors
    const hexMatches = String(value).match(/#[0-9A-Fa-f]{6}/g);
    if (hexMatches) {
      values.push(...hexMatches);
    }

    // Extract rgba colors
    const rgbaMatches = String(value).match(/rgba?\([^)]+\)/g);
    if (rgbaMatches) {
      values.push(...rgbaMatches);
    }

    // Extract opacity values (0-1)
    if (key === 'opacity' && typeof value === 'number') {
      values.push(String(value));
    }
  }

  return values;
}

/**
 * Build the system prompt for Sonnet (Stage 2)
 *
 * @param {Map} compiledTree - Map from compileTree (Stage 1 output)
 * @param {Object} nodeTree - Original Figma node tree (for layer names and hierarchy)
 * @param {Object} interpretation - Optional design interpretation from Seat 7
 * @returns {Object} { systemPrompt: string, userPrompt: string, tokenEstimate: number }
 */
export function buildSemanticPrompt(compiledTree, nodeTree, interpretation) {
  const systemPrompt = `You are a mechanical translator. You have received CSS generated from exact Figma measurements.

Your ONLY permitted actions are:
1. Wrap CSS objects into React components. Use the Figma layer name as the component name.
2. Consolidate identical color values into CSS custom properties at the component root.
3. Convert position:absolute to flexbox ONLY when the parent node has layoutMode HORIZONTAL or VERTICAL 
   and children have layoutGrow:1. In all other cases, preserve position:absolute.
4. Name props using the layer names in the Figma hierarchy.

You are PROHIBITED from:
- Changing any px value, color, border-radius, or numeric property
- Adding hover states, transitions, animations, or pseudo-selectors
- Inferring intent from visual appearance
- Making any judgment about whether something looks good
- Adding imports, dependencies, or libraries not required for basic React rendering

Output: a single .tsx file. Nothing else. No explanation, no comments.`;

  // Build node hierarchy with names
  function buildHierarchy(node, depth = 0) {
    const indent = '  '.repeat(depth);
    let lines = [`${indent}${node.name} (${node.type})`];

    if (node.children && Array.isArray(node.children)) {
      for (const child of node.children) {
        lines = lines.concat(buildHierarchy(child, depth + 1));
      }
    }

    return lines;
  }

  const hierarchyLines = buildHierarchy(nodeTree);
  const hierarchyStr = hierarchyLines.join('\n');

  // Build CSS map as JSON
  const cssMapArray = Array.from(compiledTree.entries()).map(([nodeId, entry]) => ({
    nodeId,
    nodeName: entry.nodeName,
    nodeType: entry.nodeType,
    css: entry.css,
    parentId: entry.parentId,
  }));

  const cssMapStr = JSON.stringify(cssMapArray, null, 2);

  // Build user prompt
  let userPrompt = `# CSS Compiled from Figma

## Node Hierarchy (with layer names)
\`\`\`
${hierarchyStr}
\`\`\`

## CSS Map (Stage 1 Output)
\`\`\`json
${cssMapStr}
\`\`\``;

  if (interpretation) {
    userPrompt += `\n\n## Design Interpretation Context
${interpretation}`;
  }

  userPrompt += `\n\nGenerate the React component file (.tsx) now.`;

  // Estimate tokens (rough: ~4 chars per token, minimum 500 for base prompts)
  const estimatedTokens = Math.max(500, Math.ceil((systemPrompt.length + userPrompt.length) / 4));

  return {
    systemPrompt,
    userPrompt,
    tokenEstimate: estimatedTokens,
  };
}

/**
 * Identify which nodes can safely convert from absolute to flexbox
 *
 * Safe when:
 * - layoutMode is 'HORIZONTAL' or 'VERTICAL'
 * - ALL children have layoutGrow: 1 or layoutSizingHorizontal: 'FILL'
 *
 * @param {Object} nodeTree - Figma node tree
 * @param {Map} compiledTree - Stage 1 compiled output
 * @returns {string[]} Array of node IDs that are safe to convert
 */
export function identifySafeFlexConversions(nodeTree, compiledTree) {
  const safeIds = [];

  function traverse(node) {
    // Check if this node has auto-layout
    if (node.layoutMode === 'HORIZONTAL' || node.layoutMode === 'VERTICAL') {
      // Check if all children have FILL or layoutGrow:1
      if (node.children && node.children.length > 0) {
        const allChildrenFill = node.children.every(
          (child) => child.layoutGrow === 1 || child.layoutSizingHorizontal === 'FILL' || child.layoutSizingVertical === 'FILL'
        );

        if (allChildrenFill) {
          safeIds.push(node.id);
        }
      }
    }

    // Recurse
    if (node.children && Array.isArray(node.children)) {
      for (const child of node.children) {
        traverse(child);
      }
    }
  }

  traverse(nodeTree);
  return safeIds;
}

/**
 * Consolidate duplicate colors found in compiled CSS
 *
 * Scans all CSS values for color properties. Colors appearing 2+ times
 * are suggested as CSS custom properties.
 *
 * @param {Map} compiledTree - Stage 1 compiled output
 * @returns {Map} Map of hexColor to { varName, usageCount, nodes }
 */
export function consolidateColors(compiledTree) {
  const colorMap = new Map();

  // Scan all CSS for colors
  for (const [nodeId, entry] of compiledTree.entries()) {
    const css = entry.css || {};

    // Check backgroundColor, color, borderColor, etc.
    for (const [prop, value] of Object.entries(css)) {
      if (!value) continue;

      // Extract hex colors
      const hexMatches = String(value).match(/#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?/g);
      if (hexMatches) {
        for (const hex of hexMatches) {
          if (!colorMap.has(hex)) {
            colorMap.set(hex, {
              varName: null,
              usageCount: 0,
              nodes: [],
            });
          }
          const entry = colorMap.get(hex);
          entry.usageCount += 1;
          entry.nodes.push(nodeId);
        }
      }

      // Extract rgba colors
      const rgbaMatches = String(value).match(/rgba?\([^)]+\)/g);
      if (rgbaMatches) {
        for (const rgba of rgbaMatches) {
          if (!colorMap.has(rgba)) {
            colorMap.set(rgba, {
              varName: null,
              usageCount: 0,
              nodes: [],
            });
          }
          const entry = colorMap.get(rgba);
          entry.usageCount += 1;
          entry.nodes.push(nodeId);
        }
      }
    }
  }

  // Filter to 2+ usages and assign variable names
  const consolidated = new Map();
  const usedNames = new Set();
  const colorNames = ['primary', 'secondary', 'accent', 'surface', 'background', 'border', 'text', 'disabled'];

  let colorIndex = 0;
  for (const [color, data] of colorMap.entries()) {
    if (data.usageCount >= 2) {
      let varName = '--color-' + colorNames[colorIndex % colorNames.length];
      if (colorIndex >= colorNames.length) {
        varName = '--color-' + colorIndex;
      }

      // Avoid duplication
      while (usedNames.has(varName)) {
        colorIndex++;
        varName = '--color-' + colorIndex;
      }

      usedNames.add(varName);
      data.varName = varName;
      consolidated.set(color, data);
      colorIndex++;
    }
  }

  return consolidated;
}

/**
 * Extract .tsx code from model response
 *
 * Looks for code block (```tsx, ```jsx, ```javascript)
 * If no code block found, treats entire response as code.
 *
 * @param {string} response - Model response text
 * @returns {string} Extracted code
 */
export function extractComponentCode(response) {
  if (!response || typeof response !== 'string') {
    return '';
  }

  // Try to find code block with markers
  const codeBlockRegex = /```(?:tsx|jsx|javascript|ts|js)?\s*\n([\s\S]*?)\n```/;
  const match = response.match(codeBlockRegex);

  if (match && match[1]) {
    return match[1].trim();
  }

  // If no code block, check if response looks like code (has import/export/function)
  if (response.includes('import ') || response.includes('export ') || response.includes('function ')) {
    return response.trim();
  }

  // Last resort: return as-is
  return response.trim();
}

/**
 * Validate that Stage 2 didn't break Stage 1 values
 *
 * @param {Map} stageOneCSS - Stage 1 compiled map
 * @param {string} stageTwoCode - Stage 2 .tsx code
 * @returns {Object} { valid, issues, preservedValues, totalValues }
 */
export function validateSemanticOutput(stageOneCSS, stageTwoCode) {
  const issues = [];
  const preservedValues = new Set();

  if (!stageTwoCode || typeof stageTwoCode !== 'string') {
    return {
      valid: false,
      issues: ['No code generated'],
      preservedValues: 0,
      totalValues: 0,
    };
  }

  // Extract all values from Stage 1
  const allValues = [];
  for (const [nodeId, entry] of stageOneCSS.entries()) {
    const values = extractCSSValues(entry.css || {});
    allValues.push(...values);
  }

  // Check each value is present in Stage 2 code
  for (const value of allValues) {
    if (stageTwoCode.includes(value)) {
      preservedValues.add(value);
    }
  }

  // Check for prohibited additions
  const prohibitedPatterns = [
    /:\s*hover\s*{/,
    /:\s*focus\s*{/,
    /:\s*active\s*{/,
    /transition\s*:/,
    /animation\s*:/,
    /@keyframes/,
  ];

  for (const pattern of prohibitedPatterns) {
    if (pattern.test(stageTwoCode)) {
      issues.push(`Found prohibited pattern: ${pattern.source}`);
    }
  }

  // Check for missing critical numeric values
  const criticalMissing = [];
  for (const value of allValues) {
    if (!preservedValues.has(value) && /\d+/.test(value)) {
      criticalMissing.push(value);
    }
  }

  if (criticalMissing.length > 0) {
    issues.push(`Missing numeric values: ${criticalMissing.slice(0, 5).join(', ')}`);
  }

  const valid = issues.length === 0 && preservedValues.size > 0;

  return {
    valid,
    issues,
    preservedValues: preservedValues.size,
    totalValues: allValues.length,
  };
}

// Provider injection for testing
let _provider = async () => {
  throw new Error('No provider configured for semantic pass');
};

/**
 * Inject the model provider (for testing)
 *
 * @param {Function} fn - Async function (systemPrompt, userPrompt) => responseString
 */
export function _setProvider(fn) {
  _provider = fn;
}

/**
 * Execute the full Stage 2 semantic pass
 *
 * @param {Map} compiledTree - Stage 1 compiled tree
 * @param {Object} nodeTree - Figma node tree
 * @param {Object} options - { interpretation, provider, maxRetries }
 * @returns {Object} Result with code, componentNames, customProperties, etc.
 */
export async function runSemanticPass(compiledTree, nodeTree, options = {}) {
  const { interpretation, provider, maxRetries = 1 } = options;
  const modelProvider = provider || _provider;

  // Step 1: Build prompt
  const { systemPrompt, userPrompt, tokenEstimate } = buildSemanticPrompt(compiledTree, nodeTree, interpretation);

  // Step 2: Call provider (Sonnet)
  let response = '';
  let tokenUsage = { input: 0, output: 0 };

  try {
    const result = await modelProvider(systemPrompt, userPrompt);

    if (typeof result === 'object' && result.code) {
      response = result.code;
      tokenUsage = result.tokenUsage || { input: 0, output: 0 };
    } else {
      response = result;
    }
  } catch (err) {
    return {
      code: '',
      componentNames: [],
      customProperties: {},
      flexConversions: 0,
      tokenUsage: { input: 0, output: 0 },
      valid: false,
      validationIssues: [err.message],
    };
  }

  // Step 3: Extract code
  const code = extractComponentCode(response);

  // Step 4: Validate
  const validation = validateSemanticOutput(compiledTree, code);

  // Step 5: Extract component names from code
  const componentNames = [];
  const componentRegex = /(?:export\s+)?(?:default\s+)?(?:function|const)\s+(\w+)\s*(?:\(|=)/g;
  let match;
  while ((match = componentRegex.exec(code)) !== null) {
    componentNames.push(match[1]);
  }

  // Step 6: Extract consolidated colors
  const colorMap = consolidateColors(compiledTree);
  const customProperties = {};
  for (const [color, data] of colorMap.entries()) {
    if (data.varName) {
      customProperties[data.varName] = color;
    }
  }

  // Step 7: Count flex conversions (nodes converted from absolute to flex)
  const safeFlexIds = identifySafeFlexConversions(nodeTree, compiledTree);
  let flexConversions = 0;
  for (const id of safeFlexIds) {
    if (code.includes(`display: 'flex'`) || code.includes('display: "flex"')) {
      flexConversions++;
    }
  }

  return {
    code,
    componentNames,
    customProperties,
    flexConversions,
    tokenUsage,
    valid: validation.valid,
    validationIssues: validation.issues,
  };
}
