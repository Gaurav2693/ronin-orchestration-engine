// ─── workers/visionWorker.mjs ─────────────────────────────────────────────────
// RONIN Worker System — Phase 8 (W3)
//
// Vision Worker: Gemini 2.5 Flash. Free tier. Handles screenshot analysis,
// Figma frame interpretation, image input. Can process multiple frames in
// parallel when called from Gate 03.
//
// Cost: $0 (free tier — 10 RPM, 250 RPD)
// Latency: ~600ms first token
// Context: 3000 token output cap
//
// Capabilities:
//   - Single image analysis (screenshots, mockups, photos)
//   - Batch parallel analysis (Figma frames, multi-screen flows)
//   - Component tree extraction (UI element hierarchy)
//   - Design token extraction (colors, spacing, typography)
//   - Visual comparison (before/after, A/B variants)
// ─────────────────────────────────────────────────────────────────────────────

import { createBaseWorker } from './workerInterface.mjs';

// ─── System Prompt ────────────────────────────────────────────────────────────

const VISION_SYSTEM_PROMPT = `You are a visual analysis assistant specializing in UI/UX design interpretation.
When analyzing images:
1. Identify the component hierarchy (what elements exist and how they nest)
2. Extract design tokens: colors (hex), spacing (px), typography (font, size, weight)
3. Note layout patterns: flex, grid, absolute positioning
4. Flag accessibility issues if visible (contrast, touch targets, text size)
5. Describe the visual style: minimal, material, glassmorphic, etc.

Output structured analysis. Be precise with measurements and colors.`;

// ─── Analysis Modes ───────────────────────────────────────────────────────────

export const ANALYSIS_MODES = Object.freeze({
  GENERAL: 'general',           // Default — analyze whatever is in the image
  COMPONENT_TREE: 'component',  // Extract UI component hierarchy
  DESIGN_TOKENS: 'tokens',      // Extract colors, spacing, typography
  COMPARISON: 'comparison',     // Compare two images side by side
  FIGMA_FRAME: 'figma',         // Figma-specific analysis with MCP context
});

// ─── Vision Worker Factory ────────────────────────────────────────────────────

export function createVisionWorker(provider, config = {}) {
  const model = config.model || 'gemini-2.5-flash';
  const maxTokens = config.maxTokens || 3000;
  const systemPrompt = config.systemPrompt || VISION_SYSTEM_PROMPT;
  const maxParallel = config.maxParallel || 5;

  async function executeFn(task, context = {}) {
    // Batch mode: multiple images
    if (task.frames && Array.isArray(task.frames)) {
      return executeBatch(task.frames, task, context);
    }

    // Single image mode
    return executeSingle(task, context);
  }

  async function executeSingle(task, context) {
    const mode = task.mode || ANALYSIS_MODES.GENERAL;
    const messages = buildVisionMessages(task, context, systemPrompt, mode);

    const response = await callProvider(provider, messages, model, maxTokens);

    const analysis = parseAnalysis(response.content, mode);

    return {
      result: response.content,
      cost: 0, // free tier
      model,
      mode,
      analysis,
      inputTokens: response.usage?.inputTokens || 0,
      outputTokens: response.usage?.outputTokens || 0,
    };
  }

  async function executeBatch(frames, task, context) {
    // Parallel execution with concurrency limit
    const batches = [];
    for (let i = 0; i < frames.length; i += maxParallel) {
      batches.push(frames.slice(i, i + maxParallel));
    }

    const allResults = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (const batch of batches) {
      const promises = batch.map((frame, idx) =>
        executeSingle(
          { ...task, image: frame.image || frame, frameId: frame.id || `frame-${idx}`, mode: task.mode },
          context
        ).catch(err => ({
          result: null,
          error: err.message,
          frameId: frame.id || `frame-${idx}`,
          cost: 0,
        }))
      );

      const batchResults = await Promise.all(promises);
      for (const r of batchResults) {
        totalInputTokens += r.inputTokens || 0;
        totalOutputTokens += r.outputTokens || 0;
      }
      allResults.push(...batchResults);
    }

    return {
      result: allResults.map(r => r.result).filter(Boolean).join('\n\n---\n\n'),
      cost: 0,
      model,
      mode: task.mode || ANALYSIS_MODES.GENERAL,
      batchSize: frames.length,
      analyses: allResults.map(r => r.analysis || r.error || null),
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      errors: allResults.filter(r => r.error).map(r => ({ frameId: r.frameId, error: r.error })),
    };
  }

  return createBaseWorker('vision', executeFn, config);
}

// ─── Message Builder ──────────────────────────────────────────────────────────

export function buildVisionMessages(task, context, systemPrompt, mode) {
  const messages = [];

  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }

  // Mode-specific instruction
  const modeInstruction = getModeInstruction(mode);
  if (modeInstruction) {
    messages.push({ role: 'system', content: modeInstruction });
  }

  // Taste context if available
  if (context.taste_block) {
    messages.push({ role: 'system', content: `Operator taste preferences:\n${context.taste_block}` });
  }

  // Build user message with image
  const userContent = [];

  if (task.image) {
    userContent.push({
      type: 'image',
      source: typeof task.image === 'string'
        ? { type: 'base64', data: task.image }
        : task.image,
    });
  }

  // Add comparison image if in comparison mode
  if (mode === ANALYSIS_MODES.COMPARISON && task.comparisonImage) {
    userContent.push({
      type: 'image',
      source: typeof task.comparisonImage === 'string'
        ? { type: 'base64', data: task.comparisonImage }
        : task.comparisonImage,
    });
  }

  // Add text query
  const textQuery = task.query || task.message || task.content || 'Analyze this image.';
  userContent.push({ type: 'text', text: textQuery });

  messages.push({ role: 'user', content: userContent });

  return messages;
}

// ─── Mode Instructions ────────────────────────────────────────────────────────

function getModeInstruction(mode) {
  switch (mode) {
    case ANALYSIS_MODES.COMPONENT_TREE:
      return 'Focus on extracting the UI component hierarchy. List each component with its nesting level, approximate dimensions, and purpose.';
    case ANALYSIS_MODES.DESIGN_TOKENS:
      return 'Focus on extracting design tokens: list all colors (hex), spacing values (px), font families, font sizes, font weights, border radii, and shadows visible in the image.';
    case ANALYSIS_MODES.COMPARISON:
      return 'Compare the two images. Identify what changed between them: layout shifts, color changes, component additions/removals, spacing adjustments. Be specific.';
    case ANALYSIS_MODES.FIGMA_FRAME:
      return 'This is a Figma design frame. Extract the component structure, auto-layout properties, constraints, and design tokens. Note any responsive behavior implied by the layout.';
    default:
      return null;
  }
}

// ─── Analysis Parser ──────────────────────────────────────────────────────────
// Extracts structured data from the model's text response.

export function parseAnalysis(content, mode) {
  if (!content || typeof content !== 'string') {
    return { raw: content, structured: false };
  }

  const analysis = {
    raw: content,
    structured: true,
  };

  // Extract colors (hex patterns)
  const colorMatches = content.match(/#[0-9a-fA-F]{3,8}/g);
  if (colorMatches) {
    analysis.colors = [...new Set(colorMatches)];
  }

  // Extract pixel values
  const pxMatches = content.match(/\d+(?:\.\d+)?px/g);
  if (pxMatches) {
    analysis.spacingValues = [...new Set(pxMatches)];
  }

  // Extract font references
  const fontMatches = content.match(/(?:font[-\s]?(?:family|size|weight))[\s:]*([^\n,;]+)/gi);
  if (fontMatches) {
    analysis.fontReferences = fontMatches.map(m => m.trim());
  }

  // Detect component mentions
  const componentPatterns = /\b(button|input|card|header|footer|nav(?:bar)?|sidebar|modal|dialog|form|table|list|grid|container|wrapper|section|panel)\b/gi;
  const componentMatches = content.match(componentPatterns);
  if (componentMatches) {
    analysis.components = [...new Set(componentMatches.map(c => c.toLowerCase()))];
  }

  return analysis;
}

// ─── Provider Call ────────────────────────────────────────────────────────────

async function callProvider(provider, messages, model, maxTokens) {
  if (typeof provider.complete === 'function') {
    return provider.complete(messages, { model, maxTokens });
  }
  if (typeof provider === 'function') {
    return provider(messages, { model, maxTokens });
  }
  throw new Error('[visionWorker] Provider must implement complete() or be callable');
}
