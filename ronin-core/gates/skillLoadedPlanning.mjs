// gates/skillLoadedPlanning.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Gate 04 Upgrade: Skill-Loaded Planning
//
// Before Sonnet generates the implementation plan, detect the task domain
// and load only the relevant skills into context. Keeps token budget lean —
// critical for cheap worker models with small context windows.
//
// Domain → Skill mapping:
//   react/frontend → frontend skill
//   swift/macos    → swiftui-macos-native skill
//   architecture   → ronin-architect skill
//   design/figma   → ronin-product-craft skill
//   backend/api    → agent-orchestrator skill
//   generic        → no skill injected (lean context)
//
// Usage:
//   const result = await generatePlan(brief, direction, skillLoader, planner);
//   // → { plan, loadedSkills, tokenCount, awaitingApproval, cost, duration }
// ─────────────────────────────────────────────────────────────────────────────

// ─── Domain Detection ────────────────────────────────────────────────────────

export const DOMAINS = {
  REACT: 'react',
  SWIFT: 'swift',
  ARCHITECTURE: 'architecture',
  DESIGN: 'design',
  BACKEND: 'backend',
  GENERIC: 'generic',
};

const DOMAIN_SIGNALS = {
  [DOMAINS.REACT]: [
    'react', 'jsx', 'tsx', 'component', 'hook', 'useState', 'useEffect',
    'next.js', 'nextjs', 'vite', 'tailwind', 'frontend', 'ui component',
    'web app', 'spa', 'chakra', 'shadcn',
  ],
  [DOMAINS.SWIFT]: [
    'swift', 'swiftui', 'macos', 'ios', 'xcode', 'appkit', 'nswindow',
    'view model', 'observable', 'binding', 'state', 'viewbuilder',
    'native app', 'mac app', 'apple',
  ],
  [DOMAINS.ARCHITECTURE]: [
    'architecture', 'system design', 'module', 'pipeline', 'orchestrat',
    'middleware', 'gateway', 'adr', 'decision', 'infrastructure', 'scalab',
    'microservice', 'monolith', 'api design',
  ],
  [DOMAINS.DESIGN]: [
    'figma', 'design system', 'component library', 'token', 'typography',
    'color palette', 'spacing', 'grid', 'prototype', 'wireframe', 'ux',
    'design brief', 'visual', 'aesthetic', 'fidelity',
  ],
  [DOMAINS.BACKEND]: [
    'api', 'rest', 'graphql', 'database', 'postgres', 'mongodb', 'redis',
    'node', 'express', 'fastify', 'server', 'endpoint', 'auth', 'jwt',
    'backend', 'worker', 'queue', 'cron',
  ],
};

export function detectDomain(brief, direction = '') {
  const text = `${brief} ${direction}`.toLowerCase();
  const scores = {};

  for (const [domain, signals] of Object.entries(DOMAIN_SIGNALS)) {
    scores[domain] = 0;
    for (const signal of signals) {
      if (text.includes(signal.toLowerCase())) {
        scores[domain]++;
      }
    }
  }

  const topDomain = Object.entries(scores)
    .sort(([, a], [, b]) => b - a)[0];

  if (topDomain[1] === 0) return DOMAINS.GENERIC;
  return topDomain[0];
}

// ─── Skill Catalog ────────────────────────────────────────────────────────────
// In production these would load from actual skill files.
// Here we define the domain → skill name mapping.

const DOMAIN_TO_SKILL = {
  [DOMAINS.REACT]:         'ronin-frontend-craft',
  [DOMAINS.SWIFT]:         'swiftui-macos-native',
  [DOMAINS.ARCHITECTURE]:  'ronin-architect',
  [DOMAINS.DESIGN]:        'ronin-product-craft',
  [DOMAINS.BACKEND]:       'agent-orchestrator',
  [DOMAINS.GENERIC]:       null,
};

export function getSkillForDomain(domain) {
  return DOMAIN_TO_SKILL[domain] || null;
}

// ─── Plan Structure ──────────────────────────────────────────────────────────

export function createPlanStructure(overrides = {}) {
  return {
    fileStructure: [],      // [{ path, type, purpose }]
    componentTree: [],      // [{ name, parent, children[], props[] }]
    dependencies: [],       // [{ name, version, reason }]
    taskManifest: [],       // [{ id, description, type, files[], critical }]
    edgeCases: [],          // [{ scenario, handling }]
    acceptanceCriteria: [], // string[]
    domain: DOMAINS.GENERIC,
    skillUsed: null,
    tokenEstimate: 0,
    awaitingApproval: true,
    ...overrides,
  };
}

// ─── Build planning prompt ───────────────────────────────────────────────────

function buildPlanningPrompt(brief, direction, skillContext, domain) {
  const skillSection = skillContext
    ? `\nRelevant Domain Knowledge (${domain}):\n${skillContext}\n`
    : '';

  return `
You are generating an implementation plan for a software task.
Return a structured JSON plan — no prose outside the JSON.
${skillSection}
Brief: ${brief}
Chosen Direction: ${direction}

Generate a JSON plan with this exact structure:
{
  "fileStructure": [
    { "path": "src/components/Button.tsx", "type": "component", "purpose": "primary CTA button" }
  ],
  "componentTree": [
    { "name": "Button", "parent": null, "children": [], "props": ["label", "onClick", "variant"] }
  ],
  "dependencies": [
    { "name": "react", "version": "^18", "reason": "core framework" }
  ],
  "taskManifest": [
    { "id": "T1", "description": "Create Button component", "type": "component", "files": ["src/components/Button.tsx"], "critical": true }
  ],
  "edgeCases": [
    { "scenario": "empty label prop", "handling": "render placeholder text" }
  ],
  "acceptanceCriteria": [
    "Button renders with correct label",
    "onClick fires on user interaction"
  ]
}

Be specific. Task manifest items should be independently executable.
Keep tasks small enough for a single Codex worker execution (<50 lines each).
`.trim();
}

// ─── Main: generatePlan ──────────────────────────────────────────────────────

export async function generatePlan(brief, direction, skillLoader, planner, options = {}) {
  if (!brief || typeof brief !== 'string') {
    throw new Error('[skillLoadedPlanning] brief must be a non-empty string');
  }
  if (!planner || typeof planner.execute !== 'function') {
    throw new Error('[skillLoadedPlanning] planner must implement execute()');
  }

  const startTime = Date.now();

  // ─── Detect domain ──────────────────────────────────────────────────────
  const domain = detectDomain(brief, direction);
  const skillName = getSkillForDomain(domain);

  // ─── Load relevant skill ────────────────────────────────────────────────
  let skillContext = null;
  let skillTokens = 0;

  if (skillName && skillLoader && typeof skillLoader.load === 'function') {
    try {
      const loaded = await skillLoader.load(skillName, options.maxSkillTokens || 2000);
      skillContext = loaded.content || null;
      skillTokens = loaded.tokenCount || 0;
    } catch (err) {
      // Skill loading failure is non-fatal — plan without it
      skillContext = null;
    }
  }

  // ─── Generate plan ──────────────────────────────────────────────────────
  const prompt = buildPlanningPrompt(brief, direction, skillContext, domain);
  const tokenEstimate = Math.ceil(prompt.length / 4) + skillTokens; // rough estimate

  const result = await planner.execute(
    {
      messages: [{ role: 'user', content: prompt }],
      jsonMode: true,
      maxTokens: options.maxPlanTokens || 1000,
    },
    {}
  );

  // ─── Parse plan ─────────────────────────────────────────────────────────
  let planData = createPlanStructure({ domain, skillUsed: skillName, tokenEstimate });

  const rawContent = result.result || result.content || '{}';
  try {
    const parsed = typeof rawContent === 'string' ? JSON.parse(rawContent) : rawContent;
    planData = {
      ...planData,
      fileStructure:      Array.isArray(parsed.fileStructure) ? parsed.fileStructure : [],
      componentTree:      Array.isArray(parsed.componentTree) ? parsed.componentTree : [],
      dependencies:       Array.isArray(parsed.dependencies) ? parsed.dependencies : [],
      taskManifest:       Array.isArray(parsed.taskManifest) ? parsed.taskManifest : [],
      edgeCases:          Array.isArray(parsed.edgeCases) ? parsed.edgeCases : [],
      acceptanceCriteria: Array.isArray(parsed.acceptanceCriteria) ? parsed.acceptanceCriteria : [],
    };
  } catch {
    // JSON parse failed — store raw content as a single task
    planData.taskManifest = [{
      id: 'T1',
      description: rawContent.slice(0, 200),
      type: 'generic',
      files: [],
      critical: true,
    }];
  }

  return {
    plan: planData,
    loadedSkills: skillName ? [skillName] : [],
    domain,
    tokenCount: tokenEstimate,
    awaitingApproval: true,  // Always requires operator approval
    cost: result.cost || 0,
    duration: Date.now() - startTime,
  };
}
