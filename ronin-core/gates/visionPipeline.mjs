// gates/visionPipeline.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Gate 03 Upgrade: Vision Pipeline
//
// Figma MCP exports multiple frames → Vision workers analyze each in parallel
// → Design tokens extracted → Sonnet synthesizes into a unified Design
// Interpretation Document with taste annotations.
//
// Flow:
//   figmaFrames[] → parallel Vision analyses → extract tokens → synthesize DID
//
// Usage:
//   const result = await runVisionPipeline(frames, visionWorker, synthesizer, tasteProfile);
//   // → { interpretations[], designTokens, synthesizedDocument, cost, duration }
// ─────────────────────────────────────────────────────────────────────────────

// ─── Design Token Schema ─────────────────────────────────────────────────────

export function createDesignTokens() {
  return {
    colors: [],        // [{ name, hex, usage }]
    typography: [],    // [{ role, family, size, weight, lineHeight }]
    spacing: [],       // [{ name, value, usage }]
    radii: [],         // [{ name, value }]
    shadows: [],       // [{ name, value }]
    components: [],    // [{ name, variants, properties }]
  };
}

// ─── Merge design tokens from multiple analyses ──────────────────────────────

export function mergeDesignTokens(tokenSets) {
  const merged = createDesignTokens();

  for (const tokens of tokenSets) {
    if (!tokens) continue;
    for (const key of Object.keys(merged)) {
      if (Array.isArray(tokens[key])) {
        // Deduplicate by name/value
        for (const item of tokens[key]) {
          const exists = merged[key].some(
            m => (m.name   && m.name   === item.name)   ||
                 (m.hex    && m.hex    === item.hex)     ||
                 (m.family && m.family === item.family)  ||
                 (m.value  && m.value  === item.value)
          );
          if (!exists) merged[key].push(item);
        }
      }
    }
  }

  return merged;
}

// ─── Parse vision analysis text into structured tokens ────────────────────────

export function parseTokensFromAnalysis(analysisText) {
  const tokens = createDesignTokens();
  if (!analysisText || typeof analysisText !== 'string') return tokens;

  // Extract hex colors
  const hexMatches = analysisText.matchAll(/#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{3})\b/g);
  const seenHex = new Set();
  for (const match of hexMatches) {
    const hex = match[0].toUpperCase();
    if (!seenHex.has(hex)) {
      seenHex.add(hex);
      tokens.colors.push({ hex, usage: 'detected' });
    }
  }

  // Extract pixel values (spacing/sizing)
  const pxMatches = analysisText.matchAll(/\b(\d+(?:\.\d+)?)\s*px\b/gi);
  const seenPx = new Set();
  for (const match of pxMatches) {
    const val = match[1];
    if (!seenPx.has(val) && parseFloat(val) >= 4 && parseFloat(val) <= 200) {
      seenPx.add(val);
      tokens.spacing.push({ value: `${val}px`, usage: 'detected' });
    }
  }

  // Extract font families (quoted or after "font-family:")
  const fontMatches = analysisText.matchAll(/(?:font(?:-family)?[:\s]+|["'])([A-Z][a-zA-Z\s]+?)(?:["',\s]|$)/g);
  const seenFont = new Set();
  for (const match of fontMatches) {
    const family = match[1].trim();
    if (family.length > 2 && family.length < 40 && !seenFont.has(family)) {
      seenFont.add(family);
      tokens.typography.push({ family, role: 'detected' });
    }
  }

  // Extract component names (capitalized words followed by "component" or "button", "card", etc.)
  const componentKeywords = ['Button', 'Card', 'Modal', 'Header', 'Footer', 'Nav', 'Input', 'Table', 'Badge', 'Toast'];
  for (const keyword of componentKeywords) {
    if (analysisText.includes(keyword)) {
      const exists = tokens.components.some(c => c.name === keyword);
      if (!exists) tokens.components.push({ name: keyword, variants: [], properties: [] });
    }
  }

  return tokens;
}

// ─── Build synthesis prompt ──────────────────────────────────────────────────

function buildSynthesisPrompt(interpretations, designTokens, tasteProfile) {
  const tasteSection = tasteProfile
    ? `\nOperator Taste Profile:\n${JSON.stringify(tasteProfile, null, 2)}\n`
    : '';

  const interpretationsText = interpretations
    .map((interp, i) => `Frame ${i + 1}: ${interp.frameId || `frame_${i + 1}`}\n${interp.analysis}`)
    .join('\n\n---\n\n');

  return `
You are synthesizing a Design Interpretation Document from Figma frame analyses.
Your job is to create a unified understanding of the design system and intent.
${tasteSection}
Frame Analyses:
${interpretationsText}

Extracted Design Tokens:
${JSON.stringify(designTokens, null, 2)}

Create a Design Interpretation Document with:
1. **Design System Summary** — core visual language, 3-5 principles
2. **Component Inventory** — key UI components with their roles
3. **Interaction Patterns** — how the UI behaves and responds
4. **Typography & Color System** — hierarchy and semantic meaning
5. **Spacing & Layout Rhythm** — the grid and spacing logic
6. **Design Intent** — what experience is this design trying to create?
${tasteProfile ? '7. **Taste Annotations** — how this aligns or diverges from operator taste\n' : ''}
Be specific and actionable. This document guides implementation.
`.trim();
}

// ─── Main: runVisionPipeline ─────────────────────────────────────────────────

export async function runVisionPipeline(figmaFrames, visionWorker, synthesizer, tasteProfile = null) {
  if (!figmaFrames || !Array.isArray(figmaFrames) || figmaFrames.length === 0) {
    throw new Error('[visionPipeline] figmaFrames must be a non-empty array');
  }
  if (!visionWorker || typeof visionWorker.execute !== 'function') {
    throw new Error('[visionPipeline] visionWorker must implement execute()');
  }
  if (!synthesizer || typeof synthesizer.execute !== 'function') {
    throw new Error('[visionPipeline] synthesizer must implement execute()');
  }

  const startTime = Date.now();

  // ─── Phase 1: Parallel vision analysis of all frames ───────────────────
  const analysisPromises = figmaFrames.map((frame, i) =>
    _analyzeFrame(frame, i, visionWorker)
  );

  const analysisResults = await Promise.allSettled(analysisPromises);

  const interpretations = analysisResults.map((result, i) => {
    if (result.status === 'fulfilled') return result.value;
    return {
      frameId: figmaFrames[i]?.id || `frame_${i + 1}`,
      analysis: `Analysis failed: ${result.reason?.message || 'unknown error'}`,
      tokens: createDesignTokens(),
      cost: 0,
      error: true,
    };
  });

  const successfulInterpretations = interpretations.filter(i => !i.error);

  // ─── Phase 2: Merge design tokens from all analyses ─────────────────────
  const designTokens = mergeDesignTokens(interpretations.map(i => i.tokens));

  // ─── Phase 3: Synthesize into Design Interpretation Document ────────────
  let synthesizedDocument = '';
  let synthesisCost = 0;

  if (successfulInterpretations.length > 0) {
    const synthPrompt = buildSynthesisPrompt(interpretations, designTokens, tasteProfile);
    const synthResult = await synthesizer.execute(
      { messages: [{ role: 'user', content: synthPrompt }] },
      {}
    ).catch(err => ({ result: `Synthesis failed: ${err.message}`, cost: 0 }));

    synthesizedDocument = synthResult.result || synthResult.content || '';
    synthesisCost = synthResult.cost || 0;
  } else {
    synthesizedDocument = 'All frame analyses failed — no document could be synthesized.';
  }

  const totalCost = interpretations.reduce((sum, i) => sum + (i.cost || 0), 0) + synthesisCost;
  const totalDuration = Date.now() - startTime;

  return {
    interpretations,
    designTokens,
    synthesizedDocument,
    meta: {
      framesTotal: figmaFrames.length,
      framesSuccessful: successfulInterpretations.length,
      framesFailed: figmaFrames.length - successfulInterpretations.length,
      totalCost,
      totalDuration,
      hasTaskAnnotations: !!tasteProfile,
    },
  };
}

// ─── Single frame analysis ───────────────────────────────────────────────────

async function _analyzeFrame(frame, index, visionWorker) {
  const frameId = frame.id || frame.name || `frame_${index + 1}`;
  const start = Date.now();

  const task = {
    mode: 'FIGMA_FRAME',
    image: frame.imageBase64 || frame.image,
    context: frame.context || `Figma frame: ${frameId}`,
    messages: [{
      role: 'user',
      content: `Analyze this Figma frame. Extract: component tree, design tokens (colors, spacing, typography), interaction patterns, and design intent.`,
    }],
  };

  const result = await visionWorker.execute(task, {});

  const analysisText = result.result || result.content || result.analysis || '';
  const tokens = parseTokensFromAnalysis(analysisText);

  return {
    frameId,
    frameName: frame.name || frameId,
    analysis: analysisText,
    tokens,
    cost: result.cost || 0,
    duration: Date.now() - start,
  };
}
