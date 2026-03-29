// ─── middleware/preClassifier.mjs ────────────────────────────────────────────
// RONIN Middleware #8 — Pre-Classifier (M2)
//
// Purpose: Flash-Lite (free tier) classifies every incoming message before
// Sonnet or any expensive model sees it. This is the routing brain — it
// decides which worker handles the task.
//
// Classification dimensions:
//   - urgency: low | medium | high
//   - modality: text | code | vision | voice | mixed
//   - complexity: trivial | standard | complex | deep
//   - suggestedWorker: fast | vision | agent | deep | codex | local
//
// How it works:
//   1. Heuristic pre-filter (zero-cost, instant) handles obvious cases
//   2. If heuristic is uncertain, Flash-Lite classifies via LLM (still free)
//   3. Classification result is attached to the request for downstream use
//
// Cost-first routing rule:
//   "What is the cheapest worker that can safely execute this task?"
//   Free tier absorbs 60%+ of all requests.
//
// Invariants:
//   - Classification completes in <100ms for heuristic path
//   - Provider is injectable for testing
//   - Never blocks pipeline on provider failure — falls back to defaults
//   - suggestedWorker is a suggestion, not a mandate (Worker Dispatch decides)
// ─────────────────────────────────────────────────────────────────────────────

// ─── Classification Types ───────────────────────────────────────────────────

export const URGENCY = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
});

export const MODALITY = Object.freeze({
  TEXT: 'text',
  CODE: 'code',
  VISION: 'vision',
  VOICE: 'voice',
  MIXED: 'mixed',
});

export const COMPLEXITY = Object.freeze({
  TRIVIAL: 'trivial',
  STANDARD: 'standard',
  COMPLEX: 'complex',
  DEEP: 'deep',
});

export const WORKER = Object.freeze({
  FAST: 'fast',
  VISION: 'vision',
  AGENT: 'agent',
  DEEP: 'deep',
  CODEX: 'codex',
  LOCAL: 'local',
});

// ─── Heuristic Patterns ─────────────────────────────────────────────────────

const TRIVIAL_PATTERNS = [
  /^(hi|hello|hey|thanks|thank you|ok|okay|sure|yes|no|yep|nope|good|great|cool|nice)\s*[.!?]*$/i,
  /^what('s| is) (the )?(time|date|day)\??$/i,
  /^(how are you|how's it going|what's up)\s*\??$/i,
  /^\/?(status|ping|health|version)\s*$/i,
];

const VISION_PATTERNS = [
  /\b(screenshot|image|picture|photo|frame|figma|design|mockup|wireframe|visual)\b/i,
  /\b(analyze|look at|see|view|inspect|review)\s+(this|the)\s+(image|screenshot|design|frame|mockup)\b/i,
  /\b(what does this|how does this)\s+(look|appear)\b/i,
];

const CODE_PATTERNS = [
  /\b(write|create|build|implement|code|refactor|fix|debug|test|deploy)\s+(a |the |my )?(function|class|module|component|service|api|endpoint|script|test|file|app|server|worker|middleware)\b/i,
  /\b(refactor|rewrite|debug|implement)\s+(the |my |a )?\w+\s*(module|class|component|service|file|function)\b/i,
  /\b(React|Vue|Angular|Svelte|Next\.?js|Express|Django|Flask|Rails)\b/,
  /\b(import|export|const|let|var|function|class|interface|type|enum|async|await)\s/,
  /\b(npm|yarn|pip|cargo|go|rustc|gcc|make|cmake)\s/i,
  /```[\s\S]*```/,
  /\b(typescript|javascript|python|rust|go|java|swift|kotlin|c\+\+|ruby|php)\b/i,
];

const AGENT_PATTERNS = [
  /\b(multi.?step|step.?by.?step|plan|organize|restructure|migrate|convert|refactor the entire|rewrite the|overhaul)\b/i,
  /\b(across|multiple|several|all)\s+(files|modules|components|services|tests)\b/i,
  /\b(set up|configure|install|bootstrap|scaffold|initialize)\s+(the |a )?(project|app|environment|workspace|pipeline|ci)\b/i,
];

const DEEP_PATTERNS = [
  /^\/deep\b/i,
  /\b(deep think|think deeply|think hard|reason about|analyze thoroughly)\b/i,
  /\b(architecture|system design|trade.?off|compare.{0,20}approaches)\b/i,
  /\b(why (should|would|does)|what are the implications|evaluate|critique)\b/i,
];

const URGENT_PATTERNS = [
  /\b(urgent|asap|immediately|now|critical|emergency|broken|down|crash|outage|production)\b/i,
  /^(fix|stop|revert|rollback|undo)\s/i,
  /\b(on fire|broke|failing|error|500|404)\b/i,
];

// ─── Heuristic Classifier ───────────────────────────────────────────────────

/**
 * Zero-cost heuristic classification. Handles obvious cases instantly.
 * Returns null if uncertain (needs LLM classification).
 */
export function classifyHeuristic(message, context = {}) {
  if (!message || typeof message !== 'string') {
    return {
      urgency: URGENCY.LOW,
      modality: MODALITY.TEXT,
      complexity: COMPLEXITY.TRIVIAL,
      suggestedWorker: WORKER.FAST,
      confidence: 0.9,
      method: 'heuristic',
      reason: 'empty_or_invalid_input',
    };
  }

  const text = message.trim();

  // Check for attached images/vision input
  const hasImage = context.has_image || context.has_screenshot || context.has_attachment_image;

  // ── Urgency ────────────────────────────────────────────────────────
  let urgency = URGENCY.MEDIUM;
  if (URGENT_PATTERNS.some(p => p.test(text))) {
    urgency = URGENCY.HIGH;
  } else if (TRIVIAL_PATTERNS.some(p => p.test(text))) {
    urgency = URGENCY.LOW;
  }

  // ── Trivial messages ──────────────────────────────────────────────
  if (TRIVIAL_PATTERNS.some(p => p.test(text))) {
    return {
      urgency: URGENCY.LOW,
      modality: MODALITY.TEXT,
      complexity: COMPLEXITY.TRIVIAL,
      suggestedWorker: WORKER.FAST,
      confidence: 0.95,
      method: 'heuristic',
      reason: 'trivial_greeting_or_status',
    };
  }

  // ── Vision input ──────────────────────────────────────────────────
  if (hasImage || VISION_PATTERNS.some(p => p.test(text))) {
    const codeAlso = CODE_PATTERNS.some(p => p.test(text)) || AGENT_PATTERNS.some(p => p.test(text));
    return {
      urgency,
      modality: codeAlso ? MODALITY.MIXED : MODALITY.VISION,
      complexity: codeAlso ? COMPLEXITY.COMPLEX : COMPLEXITY.STANDARD,
      suggestedWorker: WORKER.VISION,
      confidence: hasImage ? 0.95 : 0.8,
      method: 'heuristic',
      reason: hasImage ? 'image_attachment_detected' : 'vision_keywords_detected',
    };
  }

  // ── Deep thinking request ─────────────────────────────────────────
  if (DEEP_PATTERNS.some(p => p.test(text))) {
    const isExplicit = /^\/deep\b/i.test(text);
    return {
      urgency,
      modality: CODE_PATTERNS.some(p => p.test(text)) ? MODALITY.CODE : MODALITY.TEXT,
      complexity: COMPLEXITY.DEEP,
      suggestedWorker: WORKER.DEEP,
      confidence: isExplicit ? 0.99 : 0.75,
      method: 'heuristic',
      reason: isExplicit ? 'explicit_deep_command' : 'deep_thinking_keywords',
    };
  }

  // ── Agent-level multi-step tasks ──────────────────────────────────
  if (AGENT_PATTERNS.some(p => p.test(text))) {
    return {
      urgency,
      modality: CODE_PATTERNS.some(p => p.test(text)) ? MODALITY.CODE : MODALITY.MIXED,
      complexity: COMPLEXITY.COMPLEX,
      suggestedWorker: WORKER.AGENT,
      confidence: 0.75,
      method: 'heuristic',
      reason: 'multi_step_task_detected',
    };
  }

  // ── Code tasks ────────────────────────────────────────────────────
  if (CODE_PATTERNS.some(p => p.test(text))) {
    // Short code request = standard, long = complex
    const isComplex = text.length > 200 || AGENT_PATTERNS.some(p => p.test(text));
    return {
      urgency,
      modality: MODALITY.CODE,
      complexity: isComplex ? COMPLEXITY.COMPLEX : COMPLEXITY.STANDARD,
      suggestedWorker: isComplex ? WORKER.CODEX : WORKER.AGENT,
      confidence: 0.7,
      method: 'heuristic',
      reason: 'code_keywords_detected',
    };
  }

  // ── Standard text (below heuristic confidence threshold) ──────────
  if (text.length < 50) {
    return {
      urgency,
      modality: MODALITY.TEXT,
      complexity: COMPLEXITY.TRIVIAL,
      suggestedWorker: WORKER.FAST,
      confidence: 0.6,
      method: 'heuristic',
      reason: 'short_text_default',
    };
  }

  // High urgency messages always get classified (don't waste time on LLM)
  if (urgency === URGENCY.HIGH) {
    return {
      urgency: URGENCY.HIGH,
      modality: MODALITY.TEXT,
      complexity: COMPLEXITY.STANDARD,
      suggestedWorker: WORKER.AGENT,
      confidence: 0.65,
      method: 'heuristic',
      reason: 'urgent_message_default',
    };
  }

  // Uncertain — return null to trigger LLM classification
  return null;
}

// ─── LLM Classifier ────────────────────────────────────────────────────────

/**
 * LLM-based classification via Flash-Lite (free tier).
 * Used when heuristic is uncertain.
 */
export async function classifyWithLLM(message, context, provider) {
  if (!provider || typeof provider !== 'function') {
    // Fallback: standard text, medium urgency
    return {
      urgency: URGENCY.MEDIUM,
      modality: MODALITY.TEXT,
      complexity: COMPLEXITY.STANDARD,
      suggestedWorker: WORKER.FAST,
      confidence: 0.5,
      method: 'fallback',
      reason: 'no_provider_available',
    };
  }

  const prompt = buildClassificationPrompt(message, context);

  try {
    const response = await provider(prompt);
    return parseClassificationResponse(response);
  } catch (err) {
    // Never block the pipeline
    return {
      urgency: URGENCY.MEDIUM,
      modality: MODALITY.TEXT,
      complexity: COMPLEXITY.STANDARD,
      suggestedWorker: WORKER.FAST,
      confidence: 0.3,
      method: 'fallback',
      reason: `provider_error: ${err.message}`,
    };
  }
}

/**
 * Build the classification prompt for Flash-Lite.
 */
export function buildClassificationPrompt(message, context = {}) {
  return `Classify this user message for an AI assistant routing system.

Message: "${message}"
${context.has_image ? 'Context: Image attached.' : ''}
${context.surface ? `Surface: ${context.surface}` : ''}

Respond in EXACTLY this JSON format (no other text):
{"urgency":"low|medium|high","modality":"text|code|vision|voice|mixed","complexity":"trivial|standard|complex|deep","suggestedWorker":"fast|vision|agent|deep|codex|local","reason":"brief explanation"}`;
}

/**
 * Parse the LLM classification response.
 */
export function parseClassificationResponse(response) {
  const defaults = {
    urgency: URGENCY.MEDIUM,
    modality: MODALITY.TEXT,
    complexity: COMPLEXITY.STANDARD,
    suggestedWorker: WORKER.FAST,
    confidence: 0.5,
    method: 'fallback',
    reason: 'parse_failed',
  };

  if (!response || typeof response !== 'string') return defaults;

  try {
    // Extract JSON from response (may have extra text around it)
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return defaults;

    const parsed = JSON.parse(jsonMatch[0]);

    // Validate each field against allowed values
    const urgency = Object.values(URGENCY).includes(parsed.urgency) ? parsed.urgency : URGENCY.MEDIUM;
    const modality = Object.values(MODALITY).includes(parsed.modality) ? parsed.modality : MODALITY.TEXT;
    const complexity = Object.values(COMPLEXITY).includes(parsed.complexity) ? parsed.complexity : COMPLEXITY.STANDARD;
    const suggestedWorker = Object.values(WORKER).includes(parsed.suggestedWorker) ? parsed.suggestedWorker : WORKER.FAST;

    return {
      urgency,
      modality,
      complexity,
      suggestedWorker,
      confidence: 0.8,
      method: 'llm',
      reason: parsed.reason || 'llm_classified',
    };
  } catch {
    return defaults;
  }
}

// ─── Combined Classifier ────────────────────────────────────────────────────

/**
 * Full classification: heuristic first, LLM fallback.
 */
export async function classify(message, context = {}, provider = null) {
  // Try heuristic first (instant, zero cost)
  const heuristic = classifyHeuristic(message, context);
  if (heuristic) return heuristic;

  // Fall back to LLM (still free — Flash-Lite)
  return classifyWithLLM(message, context, provider);
}

// ─── Middleware Factory ─────────────────────────────────────────────────────

/**
 * Creates the Pre-Classifier middleware.
 *
 * @param {Function|null} flashLiteProvider - async (prompt) => response string
 * @param {Object} config - optional configuration
 * @returns {Function} middleware(request, next) => response
 */
export function createPreClassifier(flashLiteProvider = null, config = {}) {
  const metrics = {
    heuristicClassifications: 0,
    llmClassifications: 0,
    fallbackClassifications: 0,
    totalClassifications: 0,
    workerDistribution: {},
  };

  async function middleware(request, next) {
    const message = request?.message || request?.content || '';
    const context = {
      has_image: request?.has_image || request?.attachments?.some?.(a => a.type === 'image'),
      has_screenshot: request?.has_screenshot,
      surface: request?.surface_context?.platform,
    };

    const classification = await classify(message, context, flashLiteProvider);

    metrics.totalClassifications++;
    if (classification.method === 'heuristic') metrics.heuristicClassifications++;
    else if (classification.method === 'llm') metrics.llmClassifications++;
    else metrics.fallbackClassifications++;

    // Track worker distribution
    const worker = classification.suggestedWorker;
    metrics.workerDistribution[worker] = (metrics.workerDistribution[worker] || 0) + 1;

    // Enrich request with classification
    const enriched = {
      ...request,
      classification,
      _pre_classified: true,
    };

    if (typeof next === 'function') {
      return next(enriched);
    }
    return enriched;
  }

  middleware.getMetrics = () => ({ ...metrics, workerDistribution: { ...metrics.workerDistribution } });
  middleware.classify = classify;

  return middleware;
}
