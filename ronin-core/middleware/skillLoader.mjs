// ─── middleware/skillLoader.mjs ──────────────────────────────────────────────
// RONIN Middleware #5 — Progressive Skill Loader (M4)
//
// Purpose: Detects the task domain from the message and pre-classifier output,
// then loads only relevant skills into context. Keeps token budget lean —
// critical for cheap worker models with small context windows.
//
// How it works:
//   1. Detect domain from message keywords + pre-classifier modality/complexity
//   2. Query the skill registry for matching skills
//   3. Load skills up to the token budget
//   4. Inject skill content into the request context
//
// Token budget matters:
//   - Fast workers (Gemini Flash-Lite) have ~8K context
//   - Loading all skills would exceed any budget
//   - Progressive loading = only what's needed, trimmed to fit
//
// Invariants:
//   - Never exceeds token budget
//   - Unrecognized domains get no skills (safe default)
//   - Usage stats tracked for analytics
//   - Skill content is read-only (never mutated)
// ─────────────────────────────────────────────────────────────────────────────

// ─── Domain Detection ───────────────────────────────────────────────────────

export const DOMAINS = Object.freeze({
  FRONTEND: 'frontend',
  BACKEND: 'backend',
  DESIGN: 'design',
  ARCHITECTURE: 'architecture',
  DEVOPS: 'devops',
  DATA: 'data',
  MOBILE: 'mobile',
  GENERAL: 'general',
});

const DOMAIN_PATTERNS = {
  [DOMAINS.FRONTEND]: [
    /\b(react|vue|angular|svelte|next\.?js|nuxt|remix|astro|html|css|scss|tailwind|component|ui|ux|button|form|layout|page|dom|browser|webpack|vite|esbuild)\b/i,
  ],
  [DOMAINS.BACKEND]: [
    /\b(api|server|express|fastify|node\.?js|deno|bun|endpoint|route|middleware|database|sql|postgres|redis|queue|worker|cron|webhook|rest|graphql)\b/i,
  ],
  [DOMAINS.DESIGN]: [
    /\b(figma|design|mockup|wireframe|prototype|color|palette|spacing|typography|layout|visual|aesthetic|brand|icon|illustration|motion|animation)\b/i,
  ],
  [DOMAINS.ARCHITECTURE]: [
    /\b(architecture|system design|infrastructure|scaling|microservice|monolith|event.?driven|message.?queue|cqrs|saga|distributed|cap theorem|trade.?off)\b/i,
  ],
  [DOMAINS.DEVOPS]: [
    /\b(docker|kubernetes|k8s|ci\/?cd|deploy|pipeline|terraform|aws|gcp|azure|cloudflare|nginx|coolify|tailscale|github actions|vercel)\b/i,
  ],
  [DOMAINS.DATA]: [
    /\b(data|analytics|ml|machine learning|ai|model|embedding|vector|rag|scrape|etl|pandas|numpy|tensorflow|pytorch)\b/i,
  ],
  [DOMAINS.MOBILE]: [
    /\b(swift|swiftui|ios|android|kotlin|jetpack|react native|flutter|mobile|app store|testflight|xcode)\b/i,
  ],
};

/**
 * Detect the domain of a message.
 * Uses keyword patterns + pre-classifier output for higher accuracy.
 */
export function detectDomain(message, classification = null) {
  if (!message || typeof message !== 'string') {
    return DOMAINS.GENERAL;
  }

  const text = message.trim();
  const scores = {};

  // Score each domain by pattern matches
  for (const [domain, patterns] of Object.entries(DOMAIN_PATTERNS)) {
    let score = 0;
    for (const pattern of patterns) {
      const matches = text.match(pattern);
      if (matches) score += matches.length;
    }
    if (score > 0) scores[domain] = score;
  }

  // Boost from pre-classifier
  if (classification) {
    if (classification.modality === 'vision') {
      scores[DOMAINS.DESIGN] = (scores[DOMAINS.DESIGN] || 0) + 2;
    }
    if (classification.modality === 'code' && !scores[DOMAINS.FRONTEND] && !scores[DOMAINS.BACKEND]) {
      scores[DOMAINS.BACKEND] = (scores[DOMAINS.BACKEND] || 0) + 1;
    }
  }

  // Return highest-scoring domain
  const entries = Object.entries(scores);
  if (entries.length === 0) return DOMAINS.GENERAL;

  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][0];
}

// ─── Skill Registry ─────────────────────────────────────────────────────────

/**
 * Create a skill registry that maps domains to skill entries.
 * Each skill entry: { name, domain, content, tokens }
 */
export function createSkillRegistry() {
  // domain → [{ name, content, tokens, priority }]
  const skills = new Map();

  function register(name, domain, content, priority = 0) {
    if (!name || !domain || !content) {
      throw new Error('Skill name, domain, and content are required');
    }
    const tokens = estimateTokens(content);
    const entry = { name, domain, content, tokens, priority };

    if (!skills.has(domain)) {
      skills.set(domain, []);
    }
    skills.get(domain).push(entry);
    // Keep sorted by priority (highest first)
    skills.get(domain).sort((a, b) => b.priority - a.priority);

    return entry;
  }

  function getSkillsForDomain(domain) {
    return skills.get(domain) || [];
  }

  function getAllSkills() {
    const all = [];
    for (const [_, entries] of skills) {
      all.push(...entries);
    }
    return all;
  }

  function getSkillByName(name) {
    for (const [_, entries] of skills) {
      const found = entries.find(e => e.name === name);
      if (found) return found;
    }
    return null;
  }

  function getDomains() {
    return [...skills.keys()];
  }

  function size() {
    let count = 0;
    for (const [_, entries] of skills) {
      count += entries.length;
    }
    return count;
  }

  function clear() {
    skills.clear();
  }

  return { register, getSkillsForDomain, getAllSkills, getSkillByName, getDomains, size, clear };
}

// ─── Token Estimation ───────────────────────────────────────────────────────

/**
 * Rough token estimation: 1 token ≈ 4 characters.
 */
export function estimateTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  return Math.ceil(text.length / 4);
}

// ─── Skill Loading ──────────────────────────────────────────────────────────

/**
 * Load skills for a domain up to the token budget.
 * Returns the concatenated skill content and metadata.
 */
export function loadSkills(registry, domain, maxTokens = 2000) {
  const available = registry.getSkillsForDomain(domain);
  if (available.length === 0) {
    return { content: '', skills: [], totalTokens: 0 };
  }

  const loaded = [];
  let totalTokens = 0;

  for (const skill of available) {
    if (totalTokens + skill.tokens > maxTokens) {
      // Try to fit a trimmed version
      const remaining = maxTokens - totalTokens;
      if (remaining >= 100) { // minimum useful size
        const trimmedContent = skill.content.substring(0, remaining * 4);
        loaded.push({
          name: skill.name,
          tokens: remaining,
          trimmed: true,
        });
        totalTokens += remaining;
      }
      break;
    }

    loaded.push({
      name: skill.name,
      tokens: skill.tokens,
      trimmed: false,
    });
    totalTokens += skill.tokens;
  }

  // Build concatenated content
  const contentParts = [];
  for (const meta of loaded) {
    const skill = registry.getSkillByName(meta.name);
    if (meta.trimmed) {
      contentParts.push(`--- Skill: ${meta.name} (trimmed) ---\n${skill.content.substring(0, meta.tokens * 4)}`);
    } else {
      contentParts.push(`--- Skill: ${meta.name} ---\n${skill.content}`);
    }
  }

  return {
    content: contentParts.join('\n\n'),
    skills: loaded,
    totalTokens,
  };
}

// ─── Middleware Factory ─────────────────────────────────────────────────────

/**
 * Creates the Skill Loader middleware.
 *
 * @param {Object} skillRegistry - created via createSkillRegistry()
 * @param {Object} config - { maxTokens, defaultDomain }
 * @returns {Function} middleware(request, next) => response
 */
export function createSkillLoader(skillRegistry, config = {}) {
  const maxTokens = config.maxTokens ?? 2000;

  const usageStats = new Map();

  async function middleware(request, next) {
    const message = request?.message || request?.content || '';
    const classification = request?.classification || null;

    const domain = detectDomain(message, classification);
    const loaded = loadSkills(skillRegistry, domain, maxTokens);

    // Track usage
    for (const skill of loaded.skills) {
      usageStats.set(skill.name, (usageStats.get(skill.name) || 0) + 1);
    }

    // Enrich request with skill context
    const enriched = {
      ...request,
      _skill_domain: domain,
      _skills_loaded: loaded.skills.map(s => s.name),
      _skill_tokens: loaded.totalTokens,
    };

    // Inject skill content into context
    if (loaded.content) {
      enriched.skill_context = loaded.content;
    }

    if (typeof next === 'function') {
      return next(enriched);
    }
    return enriched;
  }

  middleware.getSkillUsageStats = () => new Map(usageStats);
  middleware.detectDomain = detectDomain;

  return middleware;
}
