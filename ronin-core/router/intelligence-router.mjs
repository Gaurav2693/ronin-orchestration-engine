// intelligence-router.mjs
// RONIN's invisible model selection engine.
//
// The operator sees RONIN. The router decides which intelligence runs behind it.
// Model names never leave this file — they are never exposed to the UI layer.
//
// Flow:
//   handleMessage() → Promise.all([classify, compress]) → route() → model API call
//   Every response streams back through the same RONIN voice, regardless of model.

// ─── Model Registry ─────────────────────────────────────────────────────────
// Internal only. Never expose these IDs or names to the client.

const MODELS = {
  // Anthropic ─────────────────────────────────────────────────────────────────
  haiku: {
    id: 'claude-haiku-4-5-20251001',
    provider: 'anthropic',
    maxTokens: 1500,        // cap keeps tail latency tight
    lane: 'fast',
    costTier: 1,
    firstTokenMs: 350,      // expected time to first streamed token
    thinkingLabel: null,    // null = no "RONIN is thinking..." indicator needed
  },
  sonnet: {
    id: 'claude-sonnet-4-6',
    provider: 'anthropic',
    maxTokens: 4096,
    lane: 'standard',
    costTier: 3,
    firstTokenMs: 700,
    thinkingLabel: null,
  },
  opus: {
    id: 'claude-opus-4-6',
    provider: 'anthropic',
    maxTokens: 8192,
    lane: 'director',
    costTier: 5,
    firstTokenMs: 1500,
    thinkingLabel: 'reviewing',  // shows "RONIN is reviewing..." in UI
  },

  // OpenAI ────────────────────────────────────────────────────────────────────
  gpt4o: {
    id: 'gpt-4o',
    provider: 'openai',
    maxTokens: 2048,
    lane: 'specialist',
    costTier: 3,
    firstTokenMs: 1100,
    thinkingLabel: null,
  },
  o3mini: {
    id: 'o3-mini',
    provider: 'openai',
    maxTokens: 8192,        // needs room to think through steps
    lane: 'specialist',
    costTier: 2,
    firstTokenMs: 2500,
    thinkingLabel: 'thinking',  // shows "RONIN is thinking..." in UI
  },
  gpt4omini: {
    id: 'gpt-4o-mini',
    provider: 'openai',
    maxTokens: 2000,
    lane: 'specialist',
    costTier: 1,
    firstTokenMs: 500,
    thinkingLabel: null,
  },
};

// ─── Routing Thresholds ──────────────────────────────────────────────────────

const THRESHOLDS = {
  SHORT_MESSAGE_TOKENS: 20,     // below this → fast lane (skip complexity analysis)
  COMPLEXITY_FOR_STANDARD: 15,  // score above this → sonnet
  REASONING_FOR_SPECIALIST: 40, // score above this + reasoning signals → o3-mini
  CONTEXT_PRESSURE_TOKENS: 28000, // total conversation tokens above this → prefer larger window
};

// ─── Signal Keyword Dictionaries ─────────────────────────────────────────────

const SIGNALS = {
  // Complexity signals (push score up → toward Sonnet)
  tech: [
    'swiftui', 'swift', 'r3f', 'three.js', 'gsap', 'glsl', 'shader', 'blender',
    'figma', 'design system', 'component', 'architecture', 'typescript', 'react',
    'node', 'api', 'database', 'server', 'mcp', 'webpack', 'vite', 'tailwind',
    'rapier', 'physics', 'animation', 'remotion', 'xstate', 'state machine',
  ],
  design: [
    'review', 'critique', 'feedback', 'layout', 'ux', 'ui', 'design', 'figma',
    'component', 'pattern', 'hierarchy', 'spacing', 'typography', 'accessibility',
  ],
  architecture: [
    'architect', 'should i', 'which approach', 'best practice', 'tradeoff',
    'decide', 'recommend', 'strategy', 'roadmap', 'phase', 'structure',
  ],

  // Reasoning signals (push toward o3-mini)
  reasoning: [
    'why is', 'why does', "why doesn't", "why won't", "why can't",
    'debug', 'error', 'broken', 'not working', 'fix this', 'fails',
    'algorithm', 'implement', 'step by step', 'logic', 'prove',
    'calculate', 'optimize', 'complexity', 'performance issue',
  ],

  // Bulk signals (route to gpt-4o-mini regardless of complexity)
  bulk: [
    'commit message', 'write 10', 'write 20', 'generate 10', 'generate 20',
    'document all', 'jsdoc', 'docstring', 'write docs for', 'create docs',
    'summarize all', 'list all', 'enumerate',
  ],

  // RONIN-specific project terms (boost complexity score — these are always real work)
  roninProjects: [
    'ronin', 'plotsync', 'udis', 'still world', 'orion kade', 'kage',
    'cpq', 'brightspeed', 'inertia', 'stillroom', 'exiro',
  ],
};

// ─── Main Router Class ───────────────────────────────────────────────────────

export class IntelligenceRouter {

  // ── route() ────────────────────────────────────────────────────────────────
  // The only public method. Call this before every API request.
  //
  // @param message  {string | {role, content}}  — the latest operator message
  // @param context  {object}
  //   .hasImage              {boolean}  — image attached to this message
  //   .directorFlag          {boolean}  — operator invoked /director
  //   .conversationTokens    {number}   — total tokens in conversation so far
  //
  // @returns {RoutingDecision}
  //   .modelId       {string}   — pass directly to API
  //   .provider      {string}   — 'anthropic' | 'openai'
  //   .maxTokens     {number}   — cap for this call
  //   .lane          {string}   — 'fast' | 'standard' | 'specialist' | 'director'
  //   .firstTokenMs  {number}   — expected ms to first token (for UI state)
  //   .thinkingLabel {string|null} — if set, show "RONIN is [label]..." in UI
  //   .reason        {string}   — internal log only. NEVER send to client.
  //
  route(message, context = {}) {
    const {
      hasImage = false,
      directorFlag = false,
      conversationTokens = 0,
    } = context;

    // ── Hard overrides (checked first, skip scoring entirely) ──────────────

    // /director command → always Opus, no matter what
    if (directorFlag) {
      return this._select('opus', '/director override');
    }

    // Image attached → always GPT-4o Vision, no matter what
    // GPT-4o is genuinely better at dense UI critique than Claude Vision
    if (hasImage) {
      return this._select('gpt4o', 'image attached');
    }

    // ── Score-based routing ────────────────────────────────────────────────

    const text = typeof message === 'string' ? message : (message?.content ?? '');
    const lower = text.toLowerCase();
    const tokenEstimate = Math.ceil(text.length / 4);

    const scores = this._score(lower, tokenEstimate, conversationTokens);

    // Bulk output → GPT-4o-mini (fast, cheap, handles volume well)
    if (scores.isBulk) {
      return this._select('gpt4omini', 'bulk output pattern detected');
    }

    // High reasoning signal → o3-mini (thinks before answering)
    if (scores.reasoning >= THRESHOLDS.REASONING_FOR_SPECIALIST) {
      return this._select('o3mini', `reasoning score ${scores.reasoning}`);
    }

    // Sufficient complexity → Sonnet (workhorse for code + design)
    if (scores.complexity >= THRESHOLDS.COMPLEXITY_FOR_STANDARD) {
      return this._select('sonnet', `complexity score ${scores.complexity}`);
    }

    // Default → Haiku (fast, cheap, handles conversation well)
    return this._select('haiku', 'low complexity — fast lane');
  }

  // ── _score() ───────────────────────────────────────────────────────────────
  // Computes signal scores from message text.
  // Returns { complexity, reasoning, isBulk }
  //
  _score(lower, tokenCount, conversationTokens) {
    let complexity = 0;
    let reasoning = 0;

    // Bulk: detected by pattern matching — overrides everything except hard overrides
    const isBulk = SIGNALS.bulk.some(k => lower.includes(k)) ||
      /\b(write|generate|create|list)\s+\d{2,}\b/.test(lower); // "write 20 X"

    // Short messages get a penalty — unless they're asking something technical
    if (tokenCount < THRESHOLDS.SHORT_MESSAGE_TOKENS) complexity -= 30;

    // Code block present — clear signal of real work
    if (lower.includes('```') || /\bfunc\b|\bconst \w+\s*=|\bclass \w+\b/.test(lower)) {
      complexity += 25;
    }

    // Technical stack keywords
    if (SIGNALS.tech.some(k => lower.includes(k))) complexity += 20;

    // Design/critique keywords
    if (SIGNALS.design.some(k => lower.includes(k))) complexity += 15;

    // Architecture keywords
    if (SIGNALS.architecture.some(k => lower.includes(k))) complexity += 15;

    // RONIN project names — always real work, always boost
    if (SIGNALS.roninProjects.some(k => lower.includes(k))) complexity += 20;

    // Context pressure — long conversations need a model with larger window + more context
    if (conversationTokens > THRESHOLDS.CONTEXT_PRESSURE_TOKENS) complexity += 15;

    // Reasoning signals
    if (SIGNALS.reasoning.some(k => lower.includes(k))) reasoning += 35;

    // Long message + code = debugging session → amplify reasoning
    if (tokenCount > 100 && lower.includes('```')) reasoning += 15;

    return { complexity, reasoning, isBulk };
  }

  // ── _select() ─────────────────────────────────────────────────────────────
  // Returns the RoutingDecision object from a model key.
  //
  _select(modelKey, reason) {
    const m = MODELS[modelKey];
    return {
      modelId: m.id,
      provider: m.provider,
      maxTokens: m.maxTokens,
      lane: m.lane,
      firstTokenMs: m.firstTokenMs,
      thinkingLabel: m.thinkingLabel,
      reason, // INTERNAL ONLY — log this, never send to client
    };
  }
}


// ─── Integration Example ─────────────────────────────────────────────────────
// Wire this into your existing orchestrator. Three changes only.
//
// import { IntelligenceRouter } from './intelligence-router.mjs';
// import { ContextCompressor } from './memory/context-compressor.mjs';
//
// const router = new IntelligenceRouter();
// const compressor = new ContextCompressor();
// await compressor.init();
//
// async function handleMessage(conversationId, messages, userMessage, context = {}) {
//   messages.push({ role: 'user', content: userMessage });
//
//   // ── CHANGE 1: Parallel pre-flight ──────────────────────────────────────
//   // Both run simultaneously. Total cost: ~150ms (not ~300ms).
//   const [decision, compressed] = await Promise.all([
//     Promise.resolve(router.route(userMessage, {
//       hasImage: context.hasImage ?? false,
//       directorFlag: userMessage.trim().startsWith('/director'),
//       conversationTokens: messages.reduce((s, m) => s + (m.content?.length ?? 0) / 4, 0),
//     })),
//     compressor.compress(messages, conversationId),
//   ]);
//
//   // ── CHANGE 2: Thinking indicator from latency budget ───────────────────
//   // Only shown for o3-mini and Opus. Haiku + Sonnet feel instant.
//   if (decision.thinkingLabel) {
//     sse.send('ronin.state', { label: decision.thinkingLabel }); // "RONIN is thinking..."
//   }
//
//   // ── CHANGE 3: Route to correct provider + model ────────────────────────
//   const provider = providers.get(decision.provider); // your existing provider map
//   const stream = provider.stream(compressed, {
//     model: decision.modelId,       // e.g. 'claude-sonnet-4-6'
//     maxTokens: decision.maxTokens,
//     systemPrompt: RONIN_SYSTEM_PROMPT, // always the same — RONIN's voice
//   });
//
//   for await (const chunk of stream) {
//     if (chunk.type === 'text') {
//       sse.send('ronin.stream', { content: chunk.content });
//     }
//   }
//
//   // Log internally for cost tracking and routing quality review
//   console.log(`[router] ${decision.lane} · ${decision.reason} · ~${decision.firstTokenMs}ms`);
//   // NEVER log decision.modelId to any client-facing surface
// }
