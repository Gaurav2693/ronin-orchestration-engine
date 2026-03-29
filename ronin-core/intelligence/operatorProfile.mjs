// ─── intelligence/operatorProfile.mjs ────────────────────────────────────────
// RONIN Operator Adaptation — the learning layer.
//
// voiceSchema.mjs = the skeleton (fixed constraints, never changes)
// operatorProfile.mjs = the skin (adaptive register, learns over time)
//
// The operator never configures this. RONIN observes and adapts silently.
// Think of it like a senior colleague who naturally adjusts their
// communication style based on who they're talking to — without asking
// "do you prefer bullet points or paragraphs?"
//
// ─── Architecture ────────────────────────────────────────────────────────────
//
//   FIXED (voiceSchema)          ADAPTIVE (operatorProfile)
//   ─────────────────           ──────────────────────────
//   No sycophancy               Verbosity (terse ↔ detailed)
//   No model identity           Technical depth (conceptual ↔ deep)
//   No apology preambles        Domain language (design ↔ code ↔ product)
//   Direct starts               Explanation style (metaphor ↔ example ↔ code)
//   Plain vocabulary             Warmth (casual ↔ professional)
//   Colleague tone              Philosophy tolerance (practical ↔ exploratory)
//                               Response format (prose ↔ structured)
//                               Pacing (dense ↔ breathing room)
//
// The left column NEVER changes. The right column shifts per operator.
// ─────────────────────────────────────────────────────────────────────────────

// ─── The 8 Adaptive Dimensions ───────────────────────────────────────────────
// Each dimension is a 0.0 → 1.0 spectrum. Default is 0.5 (neutral).
// RONIN adjusts these based on observed operator behavior.

const DIMENSIONS = {
  verbosity: {
    id: 'verbosity',
    label: 'Verbosity',
    spectrum: ['terse', 'detailed'],
    default: 0.5,
    description: 'How much RONIN says. 0 = "No." / 1 = full explanation with context.',
    signals: {
      pullToward0: [
        'operator sends short messages (<20 words)',
        'operator asks "tldr?" or "short version?"',
        'operator interrupts with follow-up before RONIN finishes',
      ],
      pullToward1: [
        'operator sends long, detailed messages (>100 words)',
        'operator asks "can you explain more?" or "why?"',
        'operator asks follow-up questions seeking depth',
      ],
    },
  },

  technicalDepth: {
    id: 'technicalDepth',
    label: 'Technical Depth',
    spectrum: ['conceptual', 'implementation'],
    default: 0.5,
    description: 'How deep RONIN goes technically. 0 = "use a queue" / 1 = "use BullMQ with Redis, here\'s the exact config."',
    signals: {
      pullToward0: [
        'operator asks "what" and "why" questions',
        'operator uses non-technical vocabulary',
        'operator asks for analogies or metaphors',
      ],
      pullToward1: [
        'operator asks "how" and "show me" questions',
        'operator uses technical terms correctly',
        'operator pastes code or error messages',
        'operator references specific libraries or APIs',
      ],
    },
  },

  domain: {
    id: 'domain',
    label: 'Domain',
    spectrum: ['design', 'engineering'],  // not binary — 0.5 = product/mixed
    default: 0.5,
    description: 'Which vocabulary to lean into. 0 = frames, tokens, hierarchy / 0.5 = features, users, flows / 1 = functions, APIs, schemas.',
    signals: {
      pullToward0: [
        'operator mentions Figma, layouts, spacing, typography, colors',
        'operator discusses user experience, flows, screens',
        'operator references design tools (Figma, Sketch, Framer)',
      ],
      pullToward1: [
        'operator mentions code, APIs, databases, deployment',
        'operator discusses architecture, performance, scaling',
        'operator references dev tools (VS Code, terminal, git)',
      ],
    },
    // Special: this dimension has 3 zones, not 2
    zones: {
      design: [0.0, 0.33],
      product: [0.33, 0.66],
      engineering: [0.66, 1.0],
    },
  },

  explanationStyle: {
    id: 'explanationStyle',
    label: 'Explanation Style',
    spectrum: ['metaphor', 'code'],
    default: 0.5,
    description: 'How RONIN explains concepts. 0 = "think of it like a post office" / 1 = "here\'s the code."',
    signals: {
      pullToward0: [
        'operator responds well to analogies (follows up on them)',
        'operator asks "what is X like?"',
        'operator is learning a new domain',
      ],
      pullToward1: [
        'operator says "show me" or "give me an example"',
        'operator responds to code with code',
        'operator skips prose and reads code blocks first',
      ],
    },
  },

  warmth: {
    id: 'warmth',
    label: 'Warmth',
    spectrum: ['casual', 'professional'],
    default: 0.6,  // slightly professional by default
    description: 'Tone temperature. 0 = "yeah that\'s broken lol" / 1 = "the implementation has a defect in the state management layer."',
    signals: {
      pullToward0: [
        'operator uses informal language, slang, emojis',
        'operator makes jokes or uses humor',
        'operator uses lowercase, abbreviations',
      ],
      pullToward1: [
        'operator writes in complete, formal sentences',
        'operator uses titles or formal references',
        'operator context is a professional/enterprise setting',
      ],
    },
  },

  philosophyTolerance: {
    id: 'philosophyTolerance',
    label: 'Philosophy Tolerance',
    spectrum: ['practical', 'exploratory'],
    default: 0.4,  // slightly practical by default
    description: 'How much big-picture thinking RONIN offers. 0 = "here\'s the fix" / 1 = "here\'s the fix, and here\'s why this pattern exists, and what it means for your architecture."',
    signals: {
      pullToward0: [
        'operator asks specific, scoped questions',
        'operator says "just tell me what to do"',
        'operator ignores context and asks next question',
      ],
      pullToward1: [
        'operator asks "why" after getting an answer',
        'operator discusses tradeoffs and alternatives',
        'operator references first principles or design philosophy',
        'operator says "brainstorm with me" or "let\'s think about"',
      ],
    },
  },

  responseFormat: {
    id: 'responseFormat',
    label: 'Response Format',
    spectrum: ['prose', 'structured'],
    default: 0.5,
    description: 'How RONIN formats output. 0 = flowing paragraphs / 1 = headers, bullets, code blocks.',
    signals: {
      pullToward0: [
        'operator writes in paragraphs',
        'operator asks conversational questions',
        'operator engages in back-and-forth dialogue',
      ],
      pullToward1: [
        'operator asks for lists or comparisons',
        'operator asks for step-by-step instructions',
        'operator requests documentation or specs',
      ],
    },
  },

  pacing: {
    id: 'pacing',
    label: 'Pacing',
    spectrum: ['dense', 'breathing'],
    default: 0.5,
    description: 'Information density. 0 = pack everything tight / 1 = space things out, one concept per paragraph.',
    signals: {
      pullToward0: [
        'operator processes dense information well (no "slow down" signals)',
        'operator is experienced in the topic',
        'operator asks rapid-fire questions',
      ],
      pullToward1: [
        'operator asks clarifying questions frequently',
        'operator is learning something new',
        'operator says "wait" or "hold on" or "let me understand"',
      ],
    },
  },
};

// ─── Operator Profile Schema ─────────────────────────────────────────────────
// This is what gets stored per operator in RAG memory.

function createDefaultProfile(operatorId) {
  const dimensions = {};
  for (const [key, dim] of Object.entries(DIMENSIONS)) {
    dimensions[key] = dim.default;
  }

  return {
    operatorId,
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),

    // Current adaptive state
    dimensions,

    // Accumulated signals (raw interaction data)
    signals: {
      messageCount: 0,
      avgMessageLength: 0,
      avgResponseRating: null,       // null = no ratings yet

      // Term frequency tracking
      domainTerms: {
        design: 0,     // count of design-related terms used
        engineering: 0, // count of engineering-related terms used
        product: 0,     // count of product-related terms used
      },

      // Behavioral signals
      clarificationRequests: 0,  // "what do you mean?" → pacing needs to slow
      depthRequests: 0,          // "tell me more" → verbosity should increase
      brevityRequests: 0,        // "too long" / "tldr" → verbosity should decrease
      codeShareCount: 0,         // operator pastes code → technicalDepth up
      questionPatterns: {
        what: 0,   // conceptual
        why: 0,    // philosophical
        how: 0,    // implementation
        show: 0,   // code-first
      },
    },

    // Interaction log (last N messages for pattern detection)
    // Stored separately in RAG, referenced here by IDs
    recentInteractionIds: [],

    // V1: Anti-learning tracking (how many signals were dampened/compensated)
    antiLearning: {
      dampened: 0,      // risky signals learned slowly
      compensated: 0,   // weakness signals pushed opposite direction
    },
  };
}

// ─── Signal Extraction ───────────────────────────────────────────────────────
// Analyzes an operator message and extracts learning signals.
// This runs on EVERY operator message — cheap, no API calls.

const DESIGN_TERMS = new Set([
  'figma', 'sketch', 'frame', 'component', 'variant', 'auto-layout', 'autolayout',
  'spacing', 'padding', 'margin', 'typography', 'typeface', 'font', 'color',
  'palette', 'token', 'design system', 'mockup', 'wireframe', 'prototype',
  'flow', 'screen', 'layout', 'grid', 'responsive', 'breakpoint', 'hierarchy',
  'visual', 'ux', 'ui', 'user experience', 'user interface', 'interaction',
  'hover', 'animation', 'transition', 'easing', 'motion', 'icon', 'illustration',
  'brand', 'style guide', 'accessibility', 'contrast', 'whitespace',
]);

const ENGINEERING_TERMS = new Set([
  'function', 'class', 'api', 'endpoint', 'database', 'schema', 'migration',
  'deploy', 'ci/cd', 'pipeline', 'docker', 'kubernetes', 'redis', 'postgres',
  'mongo', 'query', 'mutation', 'resolver', 'middleware', 'route', 'controller',
  'model', 'orm', 'sql', 'nosql', 'cache', 'index', 'performance', 'latency',
  'throughput', 'load balancer', 'microservice', 'monolith', 'refactor',
  'debug', 'stack trace', 'error', 'exception', 'test', 'unit test', 'e2e',
  'git', 'branch', 'merge', 'commit', 'pr', 'pull request', 'code review',
  'typescript', 'javascript', 'python', 'swift', 'rust', 'go', 'node',
  'react', 'vue', 'svelte', 'nextjs', 'express', 'fastapi',
  'webpack', 'vite', 'eslint', 'prettier', 'npm', 'yarn', 'pnpm',
]);

const PRODUCT_TERMS = new Set([
  'user', 'customer', 'stakeholder', 'requirement', 'spec', 'prd',
  'roadmap', 'sprint', 'backlog', 'priority', 'mvp', 'feature', 'release',
  'metric', 'kpi', 'okr', 'conversion', 'retention', 'churn', 'engagement',
  'a/b test', 'experiment', 'hypothesis', 'persona', 'journey', 'funnel',
  'onboarding', 'activation', 'feedback', 'survey', 'interview', 'insight',
  'competitor', 'market', 'positioning', 'pricing', 'freemium', 'enterprise',
  'saas', 'b2b', 'b2c', 'strategy', 'vision', 'mission', 'north star',
]);

const BREVITY_SIGNALS = new Set([
  'tldr', 'tl;dr', 'short version', 'briefly', 'in brief', 'summarize',
  'too long', 'too much', 'just tell me', 'get to the point', 'bottom line',
  'quick answer', 'one line', 'in a nutshell',
]);

const DEPTH_SIGNALS = new Set([
  'explain more', 'tell me more', 'go deeper', 'elaborate', 'expand on',
  'why is that', 'how does that work', 'what do you mean', 'can you clarify',
  'i don\'t understand', 'break it down', 'walk me through',
]);

const PHILOSOPHY_SIGNALS = new Set([
  'brainstorm', 'think about', 'what if', 'imagine', 'in theory',
  'philosophically', 'from first principles', 'the bigger picture',
  'long term', 'strategically', 'what\'s the right approach',
  'tradeoffs', 'trade-offs', 'alternatives', 'options',
]);

const OVERCONFIDENCE_PATTERNS = new Set([
  'obviously', 'clearly everyone knows', 'it\'s simple', 'trivially',
  'any idiot can see', 'obviously everyone knows', 'it\'s obvious',
  'needless to say', 'as everyone knows',
]);

const VAGUE_THINKING_PATTERNS = new Set([
  'i think maybe', 'not sure but', 'kinda like', 'sort of like',
  'i guess', 'probably maybe', 'maybe probably', 'kind of like',
  'seems like maybe', 'i\'m not sure but', 'i think probably',
]);

// ─── V1: Signal Classification ──────────────────────────────────────────────
// Each signal is classified into one of 4 categories with a dampingFactor.
// dampingFactor controls how much RONIN learns from this signal:
//   1.0 = full learning (beneficial/neutral)
//   0.3 = dampened learning (risky — learn slowly)
//   -0.5 = compensate/opposite (weakness — push opposite direction)

const SIGNAL_CLASSIFICATION = {
  // ─── Beneficial Signals (learn fully) ───────────────────────────────────
  // These are adaptive preferences that help RONIN serve better
  lengthCategory_short: { category: 'beneficial', dampingFactor: 1.0 },
  lengthCategory_long: { category: 'beneficial', dampingFactor: 1.0 },
  containsCode: { category: 'beneficial', dampingFactor: 1.0 },
  brevitySignal: { category: 'beneficial', dampingFactor: 1.0 },
  depthSignal: { category: 'beneficial', dampingFactor: 1.0 },
  questionPatterns_how: { category: 'beneficial', dampingFactor: 1.0 },
  questionPatterns_show: { category: 'beneficial', dampingFactor: 1.0 },
  domainTerms_design: { category: 'beneficial', dampingFactor: 1.0 },
  domainTerms_engineering: { category: 'beneficial', dampingFactor: 1.0 },
  domainTerms_product: { category: 'beneficial', dampingFactor: 1.0 },

  // ─── Neutral Signals (learn fully) ──────────────────────────────────────
  // These are style markers that don't indicate a weakness
  containsEmoji: { category: 'neutral', dampingFactor: 1.0 },
  isInformal: { category: 'neutral', dampingFactor: 1.0 },
  isFormal: { category: 'neutral', dampingFactor: 1.0 },
  philosophySignal: { category: 'neutral', dampingFactor: 1.0 },
  questionPatterns_what: { category: 'neutral', dampingFactor: 1.0 },
  questionPatterns_why: { category: 'neutral', dampingFactor: 1.0 },

  // ─── Risky Signals (dampened learning) ─────────────────────────────────
  // These are tendencies to dampen, not amplify
  // Extreme verbosity (>0.9) or brevity (<0.1) taken to extreme
  verbosity_extreme: { category: 'risky', dampingFactor: 0.3 },
  overconfidence: { category: 'risky', dampingFactor: 0.3 },

  // ─── Weakness Signals (compensate — opposite direction) ────────────────
  // These are patterns to actively compensate for, not adapt to
  vagueThinking: { category: 'weakness', dampingFactor: -0.5 },
};

// ─── Classification Function ────────────────────────────────────────────────
function classifySignal(signalType, value) {
  // Map signal type to classification
  const classification = SIGNAL_CLASSIFICATION[signalType];
  if (classification) {
    return classification;
  }

  // Default classification if signal not in map
  return { category: 'neutral', dampingFactor: 1.0 };
}

function extractSignals(message) {
  if (!message || typeof message !== 'string') {
    return null;
  }

  const lower = message.toLowerCase();
  const words = lower.split(/\s+/);
  const wordCount = words.length;

  // Message length category
  const lengthCategory = wordCount < 20 ? 'short' : wordCount < 100 ? 'medium' : 'long';

  // Domain term counting
  let designCount = 0;
  let engineeringCount = 0;
  let productCount = 0;

  for (const term of DESIGN_TERMS) {
    if (lower.includes(term)) designCount++;
  }
  for (const term of ENGINEERING_TERMS) {
    if (lower.includes(term)) engineeringCount++;
  }
  for (const term of PRODUCT_TERMS) {
    if (lower.includes(term)) productCount++;
  }

  // Question pattern detection
  const questionPatterns = {
    what: (lower.match(/\bwhat\b/g) || []).length,
    why: (lower.match(/\bwhy\b/g) || []).length,
    how: (lower.match(/\bhow\b/g) || []).length,
    show: (lower.match(/\b(show me|give me|example|code)\b/g) || []).length,
  };

  // Behavioral signals
  const containsCode = /```|`[^`]+`|\bfunction\b|\bconst\b|\bimport\b/.test(message);
  const containsEmoji = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}]/u.test(message);
  const isInformal = /\blol\b|\bhaha\b|\bomg\b|\bbtw\b|\bimo\b|\bfyi\b/i.test(lower);
  const isFormal = wordCount > 30 && !isInformal && !containsEmoji;

  // V1: Overconfidence detection
  let overconfidence = false;
  for (const pattern of OVERCONFIDENCE_PATTERNS) {
    if (lower.includes(pattern)) { overconfidence = true; break; }
  }

  // V1: Vague thinking detection
  let vagueThinking = false;
  for (const pattern of VAGUE_THINKING_PATTERNS) {
    if (lower.includes(pattern)) { vagueThinking = true; break; }
  }

  // Specific request signals
  let brevitySignal = false;
  let depthSignal = false;
  let philosophySignal = false;

  for (const signal of BREVITY_SIGNALS) {
    if (lower.includes(signal)) { brevitySignal = true; break; }
  }
  for (const signal of DEPTH_SIGNALS) {
    if (lower.includes(signal)) { depthSignal = true; break; }
  }
  for (const signal of PHILOSOPHY_SIGNALS) {
    if (lower.includes(signal)) { philosophySignal = true; break; }
  }

  return {
    wordCount,
    lengthCategory,
    domainTerms: { design: designCount, engineering: engineeringCount, product: productCount },
    questionPatterns,
    containsCode,
    containsEmoji,
    isInformal,
    isFormal,
    brevitySignal,
    depthSignal,
    philosophySignal,
    overconfidence,
    vagueThinking,
  };
}

// ─── Profile Updater ─────────────────────────────────────────────────────────
// Takes a profile + new signals → returns an updated profile.
// Uses exponential moving average so recent interactions matter more.
// V1: Applies classification-based dampingFactor to learning rate.

const LEARNING_RATE = 0.15;  // How fast dimensions shift. 0.15 = ~7 messages to shift significantly.

function updateProfile(profile, signals) {
  if (!signals) return profile;

  const updated = JSON.parse(JSON.stringify(profile));  // deep clone
  updated.updatedAt = new Date().toISOString();
  updated.signals.messageCount++;

  // Update running average message length
  const n = updated.signals.messageCount;
  updated.signals.avgMessageLength =
    ((n - 1) * updated.signals.avgMessageLength + signals.wordCount) / n;

  // Accumulate domain terms
  updated.signals.domainTerms.design += signals.domainTerms.design;
  updated.signals.domainTerms.engineering += signals.domainTerms.engineering;
  updated.signals.domainTerms.product += signals.domainTerms.product;

  // Accumulate question patterns
  for (const [type, count] of Object.entries(signals.questionPatterns)) {
    updated.signals.questionPatterns[type] += count;
  }

  // Accumulate behavioral signals
  if (signals.containsCode) updated.signals.codeShareCount++;
  if (signals.brevitySignal) updated.signals.brevityRequests++;
  if (signals.depthSignal) updated.signals.depthRequests++;

  // ─── Dimension Shifts ────────────────────────────────────────────────────
  // Each signal nudges dimensions using exponential moving average:
  // new_value = old_value + (LEARNING_RATE * dampingFactor) * (target - old_value)
  // V1: dampingFactor is determined by signal classification

  const dims = updated.dimensions;

  // Helper: apply dimension shift with classification-aware dampingFactor
  const shiftDimension = (dimKey, target, signalType) => {
    const classification = classifySignal(signalType);
    const effectiveLearningRate = LEARNING_RATE * classification.dampingFactor;

    if (classification.dampingFactor === -0.5) {
      // Weakness signal: push AWAY from target (opposite direction)
      const oppositeTarget = target > 0.5 ? 0.0 : 1.0;
      dims[dimKey] += effectiveLearningRate * (oppositeTarget - dims[dimKey]);
      updated.antiLearning.compensated++;
    } else if (classification.dampingFactor === 0.3) {
      // Risky signal: dampen the learning
      dims[dimKey] += effectiveLearningRate * (target - dims[dimKey]);
      updated.antiLearning.dampened++;
    } else {
      // Beneficial or neutral: normal learning
      dims[dimKey] += effectiveLearningRate * (target - dims[dimKey]);
    }
  };

  // Verbosity: short messages → terse, long messages → detailed
  if (signals.lengthCategory === 'short') {
    shiftDimension('verbosity', 0.2, 'lengthCategory_short');
  } else if (signals.lengthCategory === 'long') {
    shiftDimension('verbosity', 0.8, 'lengthCategory_long');
  }
  if (signals.brevitySignal) {
    shiftDimension('verbosity', 0.1, 'brevitySignal');  // strong pull
  }
  if (signals.depthSignal) {
    shiftDimension('verbosity', 0.9, 'depthSignal');  // strong pull
  }

  // V1: Risky check — extreme verbosity
  if (dims.verbosity > 0.9 || dims.verbosity < 0.1) {
    shiftDimension('verbosity', 0.5, 'verbosity_extreme');
  }

  // Technical depth: code presence and how/show questions push toward implementation
  if (signals.containsCode) {
    shiftDimension('technicalDepth', 0.9, 'containsCode');
  }
  if (signals.questionPatterns.how > 0 || signals.questionPatterns.show > 0) {
    shiftDimension('technicalDepth', 0.8, signals.questionPatterns.show > 0 ? 'questionPatterns_show' : 'questionPatterns_how');
  }
  if (signals.questionPatterns.what > 0) {
    shiftDimension('technicalDepth', 0.3, 'questionPatterns_what');
  }

  // Domain: which terms dominate?
  const totalDomain = signals.domainTerms.design + signals.domainTerms.engineering + signals.domainTerms.product;
  if (totalDomain > 0) {
    const engineeringRatio = signals.domainTerms.engineering / totalDomain;
    const designRatio = signals.domainTerms.design / totalDomain;
    // 0 = design, 0.5 = product, 1.0 = engineering
    const target = engineeringRatio * 1.0 + designRatio * 0.0 + (1 - engineeringRatio - designRatio) * 0.5;
    if (signals.domainTerms.design > 0) shiftDimension('domain', target, 'domainTerms_design');
    if (signals.domainTerms.engineering > 0) shiftDimension('domain', target, 'domainTerms_engineering');
    if (signals.domainTerms.product > 0) shiftDimension('domain', target, 'domainTerms_product');
  }

  // Explanation style: code presence → code examples, no code → metaphor
  if (signals.containsCode || signals.questionPatterns.show > 0) {
    shiftDimension('explanationStyle', 0.8, 'containsCode');
  }
  if (signals.questionPatterns.what > 0 && !signals.containsCode) {
    shiftDimension('explanationStyle', 0.3, 'questionPatterns_what');
  }

  // Warmth: informal → casual, formal → professional
  if (signals.isInformal || signals.containsEmoji) {
    shiftDimension('warmth', 0.2, 'isInformal');
  }
  if (signals.isFormal) {
    shiftDimension('warmth', 0.8, 'isFormal');
  }

  // Philosophy tolerance
  if (signals.philosophySignal) {
    shiftDimension('philosophyTolerance', 0.9, 'philosophySignal');
  }
  if (signals.questionPatterns.why > 0) {
    shiftDimension('philosophyTolerance', 0.7, 'questionPatterns_why');
  }

  // V1: Vague thinking detected — compensate with structured output
  if (signals.vagueThinking) {
    shiftDimension('responseFormat', 1.0, 'vagueThinking');  // push toward structured
  }

  // Response format: stays mostly neutral, shifts with explicit signals
  if (signals.lengthCategory === 'short') {
    shiftDimension('responseFormat', 0.3, 'lengthCategory_short');  // prose for quick chats
  }

  // V1: Overconfidence detected — dampen it
  if (signals.overconfidence) {
    shiftDimension('philosophyTolerance', 0.5, 'overconfidence');  // pull back to neutral
  }

  // Pacing: follows verbosity loosely
  dims.pacing += LEARNING_RATE * 0.5 * (dims.verbosity - dims.pacing);

  // Clamp all dimensions to [0, 1]
  for (const key of Object.keys(dims)) {
    dims[key] = Math.max(0, Math.min(1, dims[key]));
  }

  return updated;
}

// ─── Profile → Prompt Injection ──────────────────────────────────────────────
// Converts the current profile state into a prompt fragment that gets injected
// alongside the voice schema's system prompt.
//
// This is the magic: voiceSchema says WHAT RONIN is.
// This function says HOW RONIN adapts to THIS operator.

function profileToPromptFragment(profile) {
  const dims = profile.dimensions;

  const fragments = [];

  // Verbosity instruction
  if (dims.verbosity < 0.3) {
    fragments.push('This operator prefers concise answers. Keep responses short — 2-4 sentences for simple questions. Skip context unless asked.');
  } else if (dims.verbosity > 0.7) {
    fragments.push('This operator values thorough explanations. Provide full context, reasoning, and implications. Don\'t truncate — they want the complete picture.');
  }

  // Technical depth instruction
  if (dims.technicalDepth < 0.3) {
    fragments.push('This operator thinks conceptually. Use analogies and high-level explanations before diving into implementation. Lead with "what" and "why" before "how".');
  } else if (dims.technicalDepth > 0.7) {
    fragments.push('This operator is technically deep. Lead with code, configs, and implementation details. Skip the conceptual overview — they already know the "what" and "why".');
  }

  // Domain language
  if (dims.domain < 0.33) {
    fragments.push('This operator is design-oriented. Use design vocabulary: frames, tokens, hierarchy, spacing, visual weight. Reference Figma, design systems, and UI patterns.');
  } else if (dims.domain > 0.66) {
    fragments.push('This operator is engineering-oriented. Use engineering vocabulary: functions, APIs, schemas, performance, architecture. Reference code patterns and system design.');
  }
  // Middle zone (product/mixed) = no adaptation needed — RONIN's default is balanced

  // Explanation style
  if (dims.explanationStyle < 0.3) {
    fragments.push('Explain with metaphors and analogies when introducing concepts. "Think of it like..." works well with this operator.');
  } else if (dims.explanationStyle > 0.7) {
    fragments.push('Show, don\'t tell. Lead with code examples and concrete implementations. This operator reads code faster than prose.');
  }

  // Warmth
  if (dims.warmth < 0.3) {
    fragments.push('Match their casual energy. Contractions, short sentences, occasional humor. Don\'t be stiff.');
  } else if (dims.warmth > 0.7) {
    fragments.push('Maintain a professional, measured tone. Full sentences, precise vocabulary. This operator values clarity over casualness.');
  }

  // Philosophy tolerance
  if (dims.philosophyTolerance > 0.7) {
    fragments.push('This operator enjoys big-picture thinking. After answering the immediate question, offer a broader perspective — tradeoffs, patterns, or "here\'s what this decision means long-term."');
  } else if (dims.philosophyTolerance < 0.3) {
    fragments.push('This operator wants actionable answers. Don\'t philosophize — give the answer and move on. Save broader context for when they explicitly ask.');
  }

  // Response format
  if (dims.responseFormat > 0.7) {
    fragments.push('Use structured formatting: headers for sections, bullets for lists, code blocks labeled with language. This operator scans rather than reads linearly.');
  } else if (dims.responseFormat < 0.3) {
    fragments.push('Use flowing prose. Avoid bullet points and headers unless listing 4+ items. This operator prefers a conversational feel.');
  }

  if (fragments.length === 0) {
    return '';  // default profile, no adaptation needed
  }

  return `\nAdaptation for this operator:\n${fragments.join('\n')}`;
}

// ─── Classification Stats ────────────────────────────────────────────────────
// Returns a summary of how many signals were beneficial/neutral/risky/weakness

function getClassificationStats(profile) {
  const stats = {
    antiLearning: {
      dampened: profile.antiLearning?.dampened || 0,
      compensated: profile.antiLearning?.compensated || 0,
    },
    total: (profile.antiLearning?.dampened || 0) + (profile.antiLearning?.compensated || 0),
    messageCount: profile.signals.messageCount,
  };

  // If we've processed messages, calculate percentages
  if (stats.messageCount > 0) {
    stats.dampenedPercent = ((stats.antiLearning.dampened / stats.messageCount) * 100).toFixed(1);
    stats.compensatedPercent = ((stats.antiLearning.compensated / stats.messageCount) * 100).toFixed(1);
  }

  return stats;
}

// ─── Exports ─────────────────────────────────────────────────────────────────

export {
  DIMENSIONS,
  LEARNING_RATE,
  DESIGN_TERMS,
  ENGINEERING_TERMS,
  PRODUCT_TERMS,
  OVERCONFIDENCE_PATTERNS,
  VAGUE_THINKING_PATTERNS,
  SIGNAL_CLASSIFICATION,
  createDefaultProfile,
  extractSignals,
  updateProfile,
  profileToPromptFragment,
  classifySignal,
  getClassificationStats,
};

export default {
  DIMENSIONS,
  LEARNING_RATE,
  createDefaultProfile,
  extractSignals,
  updateProfile,
  profileToPromptFragment,
  classifySignal,
  getClassificationStats,
};
