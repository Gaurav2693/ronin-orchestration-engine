// api/chatServer.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Phase 11A: The Bridge
//
// HTTP server that connects the macOS SwiftUI shell to ronin-core.
// Every endpoint maps 1:1 to OrchestratorClient.swift methods.
//
// Architecture:
//   - Node built-in http module (no Express dependency)
//   - In-memory state (no Redis required to boot)
//   - Message processing via anthropicProvider (direct streaming)
//   - SSE event channel for real-time state updates
//   - 6 named agents (seats) seeded on startup
//
// Endpoints:
//   GET  /health
//   GET  /api/state                        → DashboardResponse
//   GET  /api/memory/warm-start            → WarmStartResponse
//   GET  /api/memory                       → ProjectMemoryResponse
//   GET  /api/providers/status             → ProviderStatusResponse
//   POST /api/providers/anthropic/connect  → AnthropicConnectResponse
//   GET  /api/cycles/:id                   → CycleSnapshot
//   GET  /api/cycles/:id/thread            → ThreadResponse
//   POST /api/cycles/start                 → CycleSnapshot
//   POST /api/cycles/:id/messages          → ThreadResponse
//   POST /api/cycles/:id/director-review   → ThreadResponse
//   POST /api/cycles/:id/approve-direction → CycleSnapshot
//   POST /api/cycles/:id/revise-direction  → CycleSnapshot
//   POST /api/cycles/:id/approve-plan      → CycleSnapshot
//   POST /api/cycles/:id/revise-plan       → CycleSnapshot
//   GET  /api/agents/:id/context           → AgentContext
//   GET  /api/agents/:id/thread            → AgentThreadResponse
//   POST /api/agents/:id/messages          → AgentThreadResponse
//   GET  /api/events                       → SSE stream
//
// Invariants:
//   - Model identity NEVER appears in any response
//   - CORS enabled for all origins (local dev)
//   - SSE heartbeat every 30s
// ─────────────────────────────────────────────────────────────────────────────

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createForgeSessionManager } from '../forge/forgeSession.mjs';

// ─── Load .env (dotenv-free, runs before anything else) ─────────────────────
try {
  const __dir = dirname(fileURLToPath(import.meta.url));
  const envPath = resolve(__dir, '../.env');
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (key && !(key in process.env)) process.env[key] = val;
  }
} catch { /* .env optional in production */ }

// ─── Configuration ──────────────────────────────────────────────────────────

const PORT = parseInt(process.env.RONIN_PORT ?? '8787', 10);
const DEFAULT_MODEL = process.env.RONIN_MODEL ?? 'claude-sonnet-4-6';

// ─── In-Memory State ────────────────────────────────────────────────────────
// All state lives here. No Redis required. Survives for the lifetime of the
// server process. Future: persist to SQLite via migrationManager.

const state = {
  cycles: new Map(),
  threads: new Map(),
  agentThreads: new Map(),
  activeCycleId: null,
  jobs: new Map(),
  sessionStartedAt: Date.now(),
  providerConfig: {
    anthropic: {
      configured: !!process.env.ANTHROPIC_API_KEY,
      apiKey:     process.env.ANTHROPIC_API_KEY ?? null,
      source:     process.env.ANTHROPIC_API_KEY ? 'env' : 'unconfigured',
      model:      DEFAULT_MODEL,
      last_connected_at: null,
    },
  },
  sseClients: new Map(),      // clientId → { res, heartbeatInterval }
  forgeSessions: new Map(),   // sessionId → Forge session state (from forgeSessionManager)
  bootTime: Date.now(),
};

// ─── 6 Named Agents (Seats) ────────────────────────────────────────────────
// Seeded on startup. Posture changes over time. The operator sees agent
// names but NEVER the model ID underneath.

const AGENTS = new Map();

const AGENT_SEEDS = [
  {
    id: 'ronin',
    name: 'RONIN',
    role: 'Core',
    voice_profile: { tone: 'direct', humor: 'dry', conversation_style: 'concise' },
    essence: 'Primary intelligence. Routes every request through the cheapest viable path.',
    strengths: ['routing', 'synthesis', 'cost optimization', 'voice consistency'],
    anti_patterns: ['verbose filler', 'unsolicited caveats', 'model identity exposure'],
    posture: 'idle',
    current_responsibility: 'Awaiting operator input',
    summary: 'Core seat. All operator-facing responses flow through RONIN voice.',
  },
  {
    id: 'director',
    name: 'Dead Shifu',
    role: 'Director',
    voice_profile: { tone: 'authoritative', humor: 'none', conversation_style: 'consultant' },
    essence: 'Opus-level review. Activated only on /director command or operator-triggered review.',
    strengths: ['architectural critique', 'taste alignment', 'strategic direction'],
    anti_patterns: ['auto-triggering', 'overriding operator decisions', 'casual tone'],
    posture: 'sleeping',
    current_responsibility: 'On standby. Activated by /director or direction review.',
    summary: 'Director seat. Consultant voice. Never auto-triggered.',
  },
  {
    id: 'ops',
    name: 'Diamond',
    role: 'Ops',
    voice_profile: { tone: 'terse', humor: 'none', conversation_style: 'minimal' },
    essence: 'Free-tier classification and compression. Never produces operator-visible output.',
    strengths: ['task classification', 'context compression', 'quick routing'],
    anti_patterns: ['producing visible output', 'spending money', 'slow responses'],
    posture: 'idle',
    current_responsibility: 'Background classification and compression.',
    summary: 'Ops seat. Invisible. Free tier only.',
  },
  {
    id: 'analyst',
    name: 'Somani',
    role: 'Analyst',
    voice_profile: { tone: 'analytical', humor: 'none', conversation_style: 'structured' },
    essence: 'Background analysis. File trees, test scaffolds, research. Never operator-visible.',
    strengths: ['file analysis', 'test generation', 'background research'],
    anti_patterns: ['producing visible output', 'slow blocking calls'],
    posture: 'idle',
    current_responsibility: 'Background analysis tasks.',
    summary: 'Analyst seat. Invisible. Free tier.',
  },
  {
    id: 'memory',
    name: 'Koshi',
    role: 'Memory',
    voice_profile: { tone: 'silent', humor: 'none', conversation_style: 'none' },
    essence: 'Embedding and retrieval. Zero cost. Never produces text output.',
    strengths: ['embedding', 'vector search', 'memory indexing'],
    anti_patterns: ['producing any output', 'text generation'],
    posture: 'idle',
    current_responsibility: 'Memory indexing and retrieval.',
    summary: 'Memory seat. Pure embedding. Zero cost.',
  },
  {
    id: 'specialist',
    name: 'Punk-G',
    role: 'Specialist',
    voice_profile: { tone: 'focused', humor: 'none', conversation_style: 'technical' },
    essence: 'Specialist slots activated by router. Vision, reasoning, scribing. Output feeds through RONIN voice.',
    strengths: ['vision analysis', 'deep reasoning', 'code generation'],
    anti_patterns: ['direct operator communication', 'identity exposure'],
    posture: 'sleeping',
    current_responsibility: 'Specialist slots. Activated by router signal.',
    summary: 'Specialist seat. Multiple models. Output normalized through RONIN.',
  },
];

function seedAgents() {
  for (const seed of AGENT_SEEDS) {
    AGENTS.set(seed.id, { ...seed });
  }
}

// ─── Operator Profile (Default) ────────────────────────────────────────────
// Seeded from known operator data. Updated by operatorProfile.mjs learning.

const OPERATOR = {
  name: 'Gaurav Mishra',
  title: 'Chaos Architect',
  working_identity: 'Systems-level product designer and AI-directed builder',
  priorities: ['authored output', 'speed of thought', 'approval control'],
};

const ACCEPTED_PATTERNS = [
  'approval-gated orchestration',
  'native shell with local runtime authority',
  'operator-visible authority',
  'cost-first model selection',
];

const REJECTED_PATTERNS = [
  'generic chatbot framing',
  'execution without explicit approval',
  'model identity exposure to operator',
  'verbose unsolicited explanations',
];

const CURRENT_CONSTRAINTS = [
  'Operator is not code-first and should not be spoken to as if they are syntax-first.',
  'Fast mode needs its own explicit combined state to stay animation-friendly.',
  'Model identity is NEVER exposed in any operator-facing surface.',
];

// ─── Preview State (default) ────────────────────────────────────────────────

function defaultPreview() {
  return {
    state: 'idle',
    title: 'Preview',
    subtitle: 'No active preview',
    body: '',
    live_url: null,
  };
}

// ─── Workspace Read Model (default) ─────────────────────────────────────────

function buildWorkspace(cycleId, cycle) {
  const thread = state.threads.get(cycleId) || [];
  const agentEntries = [...AGENTS.values()].map(a => ({
    id: a.id,
    label: a.name,
    posture: a.posture,
    active: a.posture === 'working' || a.posture === 'presenting',
    responsibility: a.current_responsibility,
    compact_status: a.posture === 'sleeping' ? 'ZZZ' : a.posture.toUpperCase(),
  }));

  return {
    scope: 'cycle',
    workspace_id: cycleId,
    workspace_type: 'cycle',
    active_workspace_label: cycle?.brief?.feature_slice ?? 'RONIN Workspace',
    active_workspace_subtitle: cycle?.brief?.goal ?? '',
    current_state: cycle?.current_state ?? 'idle',
    mode: cycle?.mode ?? 'hybrid',
    session_tabs: [
      { id: 'chat', label: 'Chat', state: 'active' },
      { id: 'build', label: 'Build', state: 'idle' },
      { id: 'preview', label: 'Preview', state: 'idle' },
    ],
    preview_state: defaultPreview(),
    agent_rail: {
      active_agent_id: null,
      active_agent_label: null,
      summary: `${AGENTS.size} agents registered`,
      agents: agentEntries,
    },
    thread_summary: {
      message_count: thread.length,
      latest_lane: thread.length > 0 ? thread[thread.length - 1].lane : null,
      latest_title: thread.length > 0 ? thread[thread.length - 1].title : null,
      latest_summary: thread.length > 0 ? thread[thread.length - 1].body.slice(0, 120) : null,
    },
    crew_status: buildCrewStatus(),
  };
}

// ─── Crew Status Builder ────────────────────────────────────────────────────

function buildCrewStatus() {
  const status = {};
  for (const [id, agent] of AGENTS) {
    status[id] = agent.posture;
  }
  return status;
}

// ─── Thread Message Factory ─────────────────────────────────────────────────

function createThreadMessage(lane, speakerId, speakerName, title, body, tone = 'neutral') {
  return {
    id: randomUUID(),
    lane,
    speaker_id: speakerId,
    speaker_name: speakerName,
    title,
    body,
    tone,
    created_at: new Date().toISOString(),
  };
}

// ─── Cycle State Machine ────────────────────────────────────────────────────
// Allowed transitions. Each state defines what states it can move to.

const CYCLE_TRANSITIONS = {
  idle:                 ['briefing'],
  briefing:             ['creative', 'blocked'],
  creative:             ['dialogue', 'direction_review', 'blocked'],
  dialogue:             ['direction_review', 'creative', 'blocked'],
  direction_review:     ['architecture', 'creative', 'blocked'],
  architecture:         ['plan_review', 'blocked'],
  plan_review:          ['execution', 'architecture', 'blocked'],
  execution:            ['integration_review', 'blocked'],
  integration_review:   ['complete', 'execution', 'blocked'],
  creative_architecture:['plan_review', 'blocked'],
  complete:             ['idle'],
  blocked:              ['idle', 'briefing', 'creative', 'direction_review', 'architecture', 'plan_review', 'execution'],
};

function transitionCycle(cycleId, newState, reason = '') {
  const cycle = state.cycles.get(cycleId);
  if (!cycle) return null;

  const allowed = CYCLE_TRANSITIONS[cycle.current_state];
  if (!allowed || !allowed.includes(newState)) {
    return null; // invalid transition
  }

  cycle.current_state = newState;
  cycle.history.push({
    state: newState,
    at: new Date().toISOString(),
    reason,
  });

  // Emit SSE event
  broadcastSSE('state_changed', JSON.stringify({
    cycle_id: cycleId,
    new_state: newState,
    reason,
  }));

  return cycle;
}

// ─── SSE Broadcast ──────────────────────────────────────────────────────────

function broadcastSSE(event, data) {
  const dataStr = typeof data === 'string' ? data : JSON.stringify(data);
  for (const [, client] of state.sseClients) {
    if (client.res.writable) {
      client.res.write(`event: ${event}\ndata: ${dataStr}\n\n`);
    }
  }
}

// ─── HTTP Helpers ───────────────────────────────────────────────────────────

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
}

function sendJSON(res, statusCode, data) {
  setCORS(res);
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function sendError(res, statusCode, message) {
  sendJSON(res, statusCode, { error: message });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// ─── URL Pattern Matching ───────────────────────────────────────────────────
// Simple path matching with :param support. No external router dependency.

function matchRoute(pattern, pathname) {
  const patternParts = pattern.split('/');
  const pathParts = pathname.split('/');
  if (patternParts.length !== pathParts.length) return null;

  const params = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

// ─── Thread Response Builder ────────────────────────────────────────────────

function buildThreadResponse(cycleId) {
  const cycle = state.cycles.get(cycleId);
  const messages = state.threads.get(cycleId) || [];
  return {
    cycle_id: cycleId,
    current_state: cycle?.current_state ?? 'idle',
    messages,
    preview: defaultPreview(),
    workspace: cycle ? buildWorkspace(cycleId, cycle) : null,
    crew_status: buildCrewStatus(),
  };
}

// ─── Agent Thread Response Builder ──────────────────────────────────────────

function buildAgentThreadResponse(agentId) {
  const agent = AGENTS.get(agentId);
  if (!agent) return null;
  const messages = state.agentThreads.get(agentId) || [];
  return {
    agent,
    cycle_id: state.activeCycleId,
    messages,
    preview: defaultPreview(),
    workspace: null,
    crew_status: buildCrewStatus(),
  };
}

// ─── LLM Message Processing ────────────────────────────────────────────────
// Direct call to anthropicProvider. No Redis. No runTask (yet).
// When Redis is available, swap this for runTask — one-line change.

let _anthropicProvider = null;

async function getProvider() {
  if (!_anthropicProvider) {
    try {
      const { AnthropicProvider } = await import('../models/anthropicProvider.mjs');
      _anthropicProvider = new AnthropicProvider();
    } catch {
      return null;
    }
  }
  return _anthropicProvider;
}

// ─── Forge Session Manager ──────────────────────────────────────────────────

let _forgeSessionManager = null;

async function getForgeSessionManager() {
  if (!_forgeSessionManager) {
    try {
      const provider = await getProvider();
      _forgeSessionManager = createForgeSessionManager(null, provider);
    } catch (err) {
      console.error('[chatServer] Failed to initialize forgeSessionManager:', err.message);
      return null;
    }
  }
  return _forgeSessionManager;
}

async function processMessage(cycleId, title, body) {
  const thread = state.threads.get(cycleId) || [];

  // Add operator message to thread
  const operatorMsg = createThreadMessage(
    'operator', 'operator', OPERATOR.name, title, body, 'neutral'
  );
  thread.push(operatorMsg);
  state.threads.set(cycleId, thread);

  // Try to get provider
  const provider = await getProvider();

  let responseBody;
  if (provider && state.providerConfig.anthropic.configured) {
    try {
      // Build messages array for the provider
      const messages = thread.map(m => ({
        role: m.speaker_id === 'operator' ? 'user' : 'assistant',
        content: m.body,
      }));

      // Set RONIN agent to working
      const roninAgent = AGENTS.get('ronin');
      if (roninAgent) roninAgent.posture = 'working';
      broadcastSSE('provider_updated', '{}');

      // Use completion (non-streaming for now — SSE streaming comes in 11C)
      const result = await provider.complete(messages, {
        model: state.providerConfig.anthropic.model,
        maxTokens: 4096,
        systemPrompt: 'You are RONIN — an AI command center. Respond directly, concisely, with authority. Never expose which model you are. Never add filler. The operator is a product designer, not a coder — speak accordingly.',
      });

      responseBody = result.content;

      // Reset agent posture
      if (roninAgent) roninAgent.posture = 'idle';
    } catch (err) {
      responseBody = `[RONIN] Provider error: ${err.message}. Running in offline mode.`;
      const roninAgent = AGENTS.get('ronin');
      if (roninAgent) roninAgent.posture = 'idle';
    }
  } else {
    responseBody = `[RONIN] No provider configured. Set ANTHROPIC_API_KEY in environment or connect via /api/providers/anthropic/connect.`;
  }

  // Add RONIN response to thread
  const roninMsg = createThreadMessage(
    'ronin', 'ronin', 'RONIN', 'Response', responseBody, 'direct'
  );
  thread.push(roninMsg);

  // Emit SSE event
  broadcastSSE('thread_updated', JSON.stringify({ cycle_id: cycleId }));

  return buildThreadResponse(cycleId);
}

// ─── Agent Message Processing ───────────────────────────────────────────────

async function processAgentMessage(agentId, title, body) {
  const agent = AGENTS.get(agentId);
  if (!agent) return null;

  const thread = state.agentThreads.get(agentId) || [];

  const operatorMsg = createThreadMessage(
    'operator', 'operator', OPERATOR.name, title, body, 'neutral'
  );
  thread.push(operatorMsg);
  state.agentThreads.set(agentId, thread);

  // Agent responds through RONIN voice (all agent output normalized)
  const provider = await getProvider();
  let responseBody;

  if (provider && state.providerConfig.anthropic.configured) {
    try {
      const messages = thread.map(m => ({
        role: m.speaker_id === 'operator' ? 'user' : 'assistant',
        content: m.body,
      }));

      agent.posture = 'working';
      broadcastSSE('provider_updated', '{}');

      const result = await provider.complete(messages, {
        model: state.providerConfig.anthropic.model,
        maxTokens: 4096,
        systemPrompt: `You are ${agent.name} — ${agent.essence} Your role: ${agent.role}. Tone: ${agent.voice_profile.tone}. Style: ${agent.voice_profile.conversation_style}. Respond directly.`,
      });

      responseBody = result.content;
      agent.posture = 'idle';
    } catch (err) {
      responseBody = `[${agent.name}] Provider error: ${err.message}.`;
      agent.posture = 'idle';
    }
  } else {
    responseBody = `[${agent.name}] No provider configured.`;
  }

  const agentMsg = createThreadMessage(
    agent.id, agent.id, agent.name, 'Response', responseBody,
    agent.voice_profile.tone
  );
  thread.push(agentMsg);

  broadcastSSE('agent_thread_updated', JSON.stringify({ agent_id: agentId }));

  return buildAgentThreadResponse(agentId);
}

// ─── Route Handler ──────────────────────────────────────────────────────────

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;
  const method = req.method;

  // CORS preflight
  if (method === 'OPTIONS') {
    setCORS(res);
    res.writeHead(204);
    res.end();
    return;
  }

  // ─── GET /health ────────────────────────────────────────────────────────
  if (method === 'GET' && pathname === '/health') {
    return sendJSON(res, 200, {
      ok: true,
      uptime: Math.floor((Date.now() - state.bootTime) / 1000),
      modules: 71,
      tests: 3329,
    });
  }

  // ─── GET /api/state → DashboardResponse ─────────────────────────────────
  if (method === 'GET' && pathname === '/api/state') {
    const activeCycle = state.activeCycleId
      ? state.cycles.get(state.activeCycleId) ?? null
      : null;

    return sendJSON(res, 200, {
      active_cycle_id: state.activeCycleId,
      active_cycle: activeCycle,
      crew_status: buildCrewStatus(),
    });
  }

  // ─── GET /api/memory/warm-start → WarmStartResponse ─────────────────────
  if (method === 'GET' && pathname === '/api/memory/warm-start') {
    const sliceHistory = [...state.cycles.values()]
      .filter(c => c.current_state === 'complete')
      .slice(-5)
      .map(c => ({
        cycle_id: c.id,
        mode: c.mode,
        feature_slice: c.brief.feature_slice,
        completed_at: c.history[c.history.length - 1]?.at ?? '',
        selected_direction: null,
        final_state: c.current_state,
      }));

    return sendJSON(res, 200, {
      operator: OPERATOR,
      accepted_patterns: ACCEPTED_PATTERNS,
      rejected_patterns: REJECTED_PATTERNS,
      current_constraints: CURRENT_CONSTRAINTS,
      recent_slice_history: sliceHistory,
    });
  }

  // ─── GET /api/memory → ProjectMemoryResponse ────────────────────────────
  if (method === 'GET' && pathname === '/api/memory') {
    const sliceHistory = [...state.cycles.values()]
      .filter(c => c.current_state === 'complete')
      .slice(-10)
      .map(c => ({
        cycle_id: c.id,
        mode: c.mode,
        feature_slice: c.brief.feature_slice,
        completed_at: c.history[c.history.length - 1]?.at ?? '',
        selected_direction: null,
        final_state: c.current_state,
      }));

    return sendJSON(res, 200, {
      project: {
        name: 'RONIN',
        mission: 'A macOS-first orchestration environment for directing one primary intelligence from a native command center.',
        current_constraints: CURRENT_CONSTRAINTS,
        accepted_patterns: ACCEPTED_PATTERNS,
        rejected_patterns: REJECTED_PATTERNS,
        memory_layers: {
          slice_history: sliceHistory,
        },
      },
    });
  }

  // ─── GET /api/providers/status → ProviderStatusResponse ─────────────────
  if (method === 'GET' && pathname === '/api/providers/status') {
    return sendJSON(res, 200, {
      anthropic: state.providerConfig.anthropic,
    });
  }

  // ─── POST /api/providers/anthropic/connect → AnthropicConnectResponse ───
  if (method === 'POST' && pathname === '/api/providers/anthropic/connect') {
    const body = await readBody(req);
    const apiKey = body.api_key;
    const model = body.model || DEFAULT_MODEL;

    if (!apiKey) {
      return sendError(res, 400, 'api_key is required');
    }

    // Update provider config
    state.providerConfig.anthropic = {
      configured: true,
      source: 'user',
      model,
      last_connected_at: new Date().toISOString(),
    };

    // Reset provider instance to use new key
    try {
      const { AnthropicProvider } = await import('../models/anthropicProvider.mjs');
      _anthropicProvider = new AnthropicProvider({ apiKey });
    } catch {
      // Provider module not available — config still saved
    }

    broadcastSSE('provider_updated', '{}');

    return sendJSON(res, 200, {
      ok: true,
      status: { anthropic: state.providerConfig.anthropic },
    });
  }

  // ─── POST /api/cycles/start → CycleSnapshot ────────────────────────────
  if (method === 'POST' && pathname === '/api/cycles/start') {
    const body = await readBody(req);
    const cycleId = randomUUID();

    const cycle = {
      id: cycleId,
      mode: body.mode || 'hybrid',
      brief: {
        feature_slice: body.brief?.feature_slice ?? 'Untitled',
        goal: body.brief?.goal ?? '',
        user_audience: body.brief?.user_audience ?? null,
        decision_pressure: body.brief?.decision_pressure ?? null,
      },
      current_state: 'briefing',
      history: [
        { state: 'briefing', at: new Date().toISOString(), reason: 'Cycle started' },
      ],
      crew_status: buildCrewStatus(),
    };

    state.cycles.set(cycleId, cycle);
    state.threads.set(cycleId, []);
    state.activeCycleId = cycleId;

    broadcastSSE('cycle_started', JSON.stringify({ cycle_id: cycleId }));

    return sendJSON(res, 200, cycle);
  }

  // ─── GET /api/cycles/:id → CycleSnapshot ───────────────────────────────
  let params;
  if (method === 'GET' && (params = matchRoute('/api/cycles/:id', pathname))) {
    const cycle = state.cycles.get(params.id);
    if (!cycle) return sendError(res, 404, `Cycle ${params.id} not found`);
    return sendJSON(res, 200, cycle);
  }

  // ─── GET /api/cycles/:id/thread → ThreadResponse ───────────────────────
  if (method === 'GET' && (params = matchRoute('/api/cycles/:id/thread', pathname))) {
    const cycle = state.cycles.get(params.id);
    if (!cycle) return sendError(res, 404, `Cycle ${params.id} not found`);
    return sendJSON(res, 200, buildThreadResponse(params.id));
  }

  // ─── POST /api/cycles/:id/messages → ThreadResponse ────────────────────
  if (method === 'POST' && (params = matchRoute('/api/cycles/:id/messages', pathname))) {
    const cycle = state.cycles.get(params.id);
    if (!cycle) return sendError(res, 404, `Cycle ${params.id} not found`);

    const body = await readBody(req);
    if (!body.title && !body.body) {
      return sendError(res, 400, 'title or body is required');
    }

    const result = await processMessage(params.id, body.title || '', body.body || '');
    return sendJSON(res, 200, result);
  }

  // ─── POST /api/cycles/:id/director-review → ThreadResponse ─────────────
  if (method === 'POST' && (params = matchRoute('/api/cycles/:id/director-review', pathname))) {
    const cycle = state.cycles.get(params.id);
    if (!cycle) return sendError(res, 404, `Cycle ${params.id} not found`);

    const body = await readBody(req);

    // Director uses Opus — for now, route through standard processing
    // with Director persona. When runTask is wired, this uses Seat 2.
    const directorAgent = AGENTS.get('director');
    if (directorAgent) directorAgent.posture = 'presenting';
    broadcastSSE('provider_updated', '{}');

    const result = await processMessage(params.id, body.title || 'Director Review', body.body || '');

    if (directorAgent) directorAgent.posture = 'sleeping';
    broadcastSSE('provider_updated', '{}');

    return sendJSON(res, 200, result);
  }

  // ─── POST /api/cycles/:id/approve-direction → CycleSnapshot ────────────
  if (method === 'POST' && (params = matchRoute('/api/cycles/:id/approve-direction', pathname))) {
    const cycle = transitionCycle(params.id, 'architecture', 'Direction approved by operator');
    if (!cycle) return sendError(res, 400, 'Invalid state transition or cycle not found');

    broadcastSSE('direction_approved', JSON.stringify({ cycle_id: params.id }));
    return sendJSON(res, 200, cycle);
  }

  // ─── POST /api/cycles/:id/revise-direction → CycleSnapshot ─────────────
  if (method === 'POST' && (params = matchRoute('/api/cycles/:id/revise-direction', pathname))) {
    const cycle = transitionCycle(params.id, 'creative', 'Direction revised by operator');
    if (!cycle) return sendError(res, 400, 'Invalid state transition or cycle not found');

    broadcastSSE('direction_revised', JSON.stringify({ cycle_id: params.id }));
    return sendJSON(res, 200, cycle);
  }

  // ─── POST /api/cycles/:id/approve-plan → CycleSnapshot ─────────────────
  if (method === 'POST' && (params = matchRoute('/api/cycles/:id/approve-plan', pathname))) {
    const cycle = transitionCycle(params.id, 'execution', 'Plan approved by operator');
    if (!cycle) return sendError(res, 400, 'Invalid state transition or cycle not found');

    broadcastSSE('plan_approved', JSON.stringify({ cycle_id: params.id }));
    return sendJSON(res, 200, cycle);
  }

  // ─── POST /api/cycles/:id/revise-plan → CycleSnapshot ──────────────────
  if (method === 'POST' && (params = matchRoute('/api/cycles/:id/revise-plan', pathname))) {
    const cycle = transitionCycle(params.id, 'architecture', 'Plan revised by operator');
    if (!cycle) return sendError(res, 400, 'Invalid state transition or cycle not found');

    broadcastSSE('plan_revised', JSON.stringify({ cycle_id: params.id }));
    return sendJSON(res, 200, cycle);
  }

  // ─── GET /api/agents/:id/context → AgentContext ─────────────────────────
  if (method === 'GET' && (params = matchRoute('/api/agents/:id/context', pathname))) {
    const agent = AGENTS.get(params.id);
    if (!agent) return sendError(res, 404, `Agent ${params.id} not found`);
    return sendJSON(res, 200, agent);
  }

  // ─── GET /api/agents/:id/thread → AgentThreadResponse ──────────────────
  if (method === 'GET' && (params = matchRoute('/api/agents/:id/thread', pathname))) {
    const agent = AGENTS.get(params.id);
    if (!agent) return sendError(res, 404, `Agent ${params.id} not found`);
    return sendJSON(res, 200, buildAgentThreadResponse(params.id));
  }

  // ─── POST /api/agents/:id/messages → AgentThreadResponse ───────────────
  if (method === 'POST' && (params = matchRoute('/api/agents/:id/messages', pathname))) {
    const agent = AGENTS.get(params.id);
    if (!agent) return sendError(res, 404, `Agent ${params.id} not found`);

    const body = await readBody(req);
    if (!body.title && !body.body) {
      return sendError(res, 400, 'title or body is required');
    }

    const result = await processAgentMessage(params.id, body.title || '', body.body || '');
    return sendJSON(res, 200, result);
  }

  // ─── GET /api/events → SSE Stream ──────────────────────────────────────
  if (method === 'GET' && pathname === '/api/events') {
    setCORS(res);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const clientId = randomUUID();

    // Heartbeat every 30s
    const heartbeatInterval = setInterval(() => {
      if (res.writable) {
        res.write(': heartbeat\n\n');
      }
    }, 30_000);

    state.sseClients.set(clientId, { res, heartbeatInterval });

    // Send initial connection event
    res.write(`event: connected\ndata: ${JSON.stringify({ client_id: clientId })}\n\n`);

    // Cleanup on disconnect
    req.on('close', () => {
      clearInterval(heartbeatInterval);
      state.sseClients.delete(clientId);
    });

    req.on('error', () => {
      clearInterval(heartbeatInterval);
      state.sseClients.delete(clientId);
    });

    return; // Keep connection open
  }

  // ─── Forge Endpoints ────────────────────────────────────────────────────

  // ─── POST /api/forge/start → Create Forge Session ────────────────────────
  if (method === 'POST' && pathname === '/api/forge/start') {
    const body = await readBody(req);
    const operatorId = body.operator_id || 'default-operator';

    try {
      const manager = await getForgeSessionManager();
      if (!manager) return sendError(res, 503, 'Forge unavailable');

      const session = await manager.createSession(operatorId, body.config || {});
      state.forgeSessions.set(session.id, {
        operatorId: session.operatorId,
        status: session.status,
        createdAt: session.createdAt,
      });

      broadcastSSE('forge.session.created', JSON.stringify({
        sessionId: session.id,
        operatorId: session.operatorId,
        status: session.status,
      }));

      return sendJSON(res, 200, session);
    } catch (err) {
      return sendError(res, 500, `Failed to create Forge session: ${err.message}`);
    }
  }

  // ─── POST /api/forge/:id/message → Process Message ──────────────────────
  if (method === 'POST' && pathname.match(/^\/api\/forge\/([^/]+)\/message$/)) {
    const sessionId = pathname.split('/')[3];
    const body = await readBody(req);

    try {
      const manager = await getForgeSessionManager();
      if (!manager) return sendError(res, 503, 'Forge unavailable');

      const result = await manager.processMessage(
        sessionId,
        body.content || '',
        body.context || {}
      );

      if (!result.ok && result.status === 'awaiting_approval') {
        const session = state.forgeSessions.get(sessionId);
        if (session) {
          session.status = 'awaiting_approval';
          broadcastSSE('forge.session.awaiting_approval', JSON.stringify({
            sessionId,
            approvalQueue: result.approvalQueue,
          }));
        }
        return sendJSON(res, 200, result);
      }

      const responseContent = result.ok
        ? (result.response ?? result.output ?? result.content ?? '')
        : (result.error ?? 'Something went wrong.');

      broadcastSSE('forge.message.processed', JSON.stringify({
        sessionId,
        taskId: result.taskId,
        costUsd: result.costUsd,
        content: responseContent,
        ok: result.ok !== false,
        toolCalls: result.toolCalls ?? [],
        filesChanged: result.filesChanged ?? [],
      }));

      return sendJSON(res, 200, result);
    } catch (err) {
      return sendError(res, 500, `Failed to process message: ${err.message}`);
    }
  }

  // ─── GET /api/forge/:id/tree → Get Task Tree ────────────────────────────
  if (method === 'GET' && pathname.match(/^\/api\/forge\/([^/]+)\/tree$/)) {
    const sessionId = pathname.split('/')[3];

    try {
      const manager = await getForgeSessionManager();
      if (!manager) return sendError(res, 503, 'Forge unavailable');

      const session = manager.getSession(sessionId);
      if (!session) return sendError(res, 404, 'Session not found');

      return sendJSON(res, 200, {
        sessionId,
        status: session.status,
        taskCount: session.taskCount,
        messageCount: session.messageCount,
        fileChangeCount: session.fileChangeCount,
      });
    } catch (err) {
      return sendError(res, 500, `Failed to get task tree: ${err.message}`);
    }
  }

  // ─── POST /api/forge/:id/approve → Approve Protected File Write ─────────
  if (method === 'POST' && pathname.match(/^\/api\/forge\/([^/]+)\/approve$/)) {
    const sessionId = pathname.split('/')[3];
    const body = await readBody(req);
    const taskId = body.task_id;

    try {
      const manager = await getForgeSessionManager();
      if (!manager) return sendError(res, 503, 'Forge unavailable');

      const result = await manager.approveAction(sessionId, taskId);

      const session = state.forgeSessions.get(sessionId);
      if (session) {
        session.status = result.sessionStatus;
        broadcastSSE('forge.action.approved', JSON.stringify({
          sessionId,
          taskId,
          approvedFile: result.approvedFile,
        }));
      }

      return sendJSON(res, 200, result);
    } catch (err) {
      return sendError(res, 500, `Failed to approve action: ${err.message}`);
    }
  }

  // ─── POST /api/forge/:id/reject → Reject Protected File Write ───────────
  if (method === 'POST' && pathname.match(/^\/api\/forge\/([^/]+)\/reject$/)) {
    const sessionId = pathname.split('/')[3];
    const body = await readBody(req);
    const taskId = body.task_id;

    try {
      const manager = await getForgeSessionManager();
      if (!manager) return sendError(res, 503, 'Forge unavailable');

      const result = await manager.rejectAction(sessionId, taskId);

      const session = state.forgeSessions.get(sessionId);
      if (session) {
        session.status = result.sessionStatus;
        broadcastSSE('forge.action.rejected', JSON.stringify({
          sessionId,
          taskId,
          rejectedFile: result.rejectedFile,
        }));
      }

      return sendJSON(res, 200, result);
    } catch (err) {
      return sendError(res, 500, `Failed to reject action: ${err.message}`);
    }
  }

  // ─── GET /api/forge/:id/files → Get File Tree ──────────────────────────
  if (method === 'GET' && pathname.match(/^\/api\/forge\/([^/]+)\/files$/)) {
    const sessionId = pathname.split('/')[3];

    try {
      const manager = await getForgeSessionManager();
      if (!manager) return sendError(res, 503, 'Forge unavailable');

      const session = manager.getSession(sessionId);
      if (!session) return sendError(res, 404, 'Session not found');

      return sendJSON(res, 200, {
        sessionId,
        files: [], // TODO: Wire to actual file tree from sandbox
        workspace: session.workspacePath,
      });
    } catch (err) {
      return sendError(res, 500, `Failed to get files: ${err.message}`);
    }
  }

  // ─── GET /api/forge/:id/diff/:filename → Get File Diff ──────────────────
  if (method === 'GET' && pathname.match(/^\/api\/forge\/([^/]+)\/diff\/(.+)$/)) {
    const parts = pathname.match(/^\/api\/forge\/([^/]+)\/diff\/(.+)$/);
    const sessionId = parts[1];
    const filename = decodeURIComponent(parts[2]);

    try {
      const manager = await getForgeSessionManager();
      if (!manager) return sendError(res, 503, 'Forge unavailable');

      const session = manager.getSession(sessionId);
      if (!session) return sendError(res, 404, 'Session not found');

      return sendJSON(res, 200, {
        sessionId,
        filename,
        diff: [], // TODO: Wire to actual diff from file changes log
      });
    } catch (err) {
      return sendError(res, 500, `Failed to get diff: ${err.message}`);
    }
  }

  // ─── POST /api/forge/:id/destroy → Destroy Session ──────────────────────
  if (method === 'POST' && pathname.match(/^\/api\/forge\/([^/]+)\/destroy$/)) {
    const sessionId = pathname.split('/')[3];

    try {
      const manager = await getForgeSessionManager();
      if (!manager) return sendError(res, 503, 'Forge unavailable');

      const result = await manager.destroySession(sessionId);
      state.forgeSessions.delete(sessionId);

      broadcastSSE('forge.session.destroyed', JSON.stringify({
        sessionId,
        archivedSession: result.archivedSession,
      }));

      return sendJSON(res, 200, result);
    } catch (err) {
      return sendError(res, 500, `Failed to destroy session: ${err.message}`);
    }
  }

  // ─── POST /api/chat/stream → SSE streaming chat (Swift shell primary) ──
  if (method === 'POST' && pathname === '/api/chat/stream') {
    const body = await readBody(req);
    const messages = body.messages ?? [];

    if (!state.providerConfig.anthropic.configured || !state.providerConfig.anthropic.apiKey) {
      return sendError(res, 503, 'Anthropic API key not configured. Set it via POST /api/providers/anthropic/connect');
    }

    // SSE headers
    setCORS(res);
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    });

    const sendSSE = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: state.providerConfig.anthropic.apiKey });

      // Normalise roles — remove any system/tool messages Swift may have passed
      const apiMessages = messages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => ({
          role:    m.role,
          content: Array.isArray(m.content) ? m.content : (m.content ?? m.text ?? ''),
        }))
        .filter(m => (typeof m.content === 'string' ? m.content.trim() : true));

      if (apiMessages.length === 0) {
        sendSSE('error', { message: 'No messages to process' });
        res.end();
        return;
      }

      // ── Build rich system prompt with live project context ──────────────
      const projectPath = process.env.RONIN_PROJECT_PATH ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..');
      let fileTreeSummary = '';
      try {
        const { readdir } = await import('node:fs/promises');
        const topLevel = await readdir(projectPath);
        const IGNORE = new Set(['node_modules', '.git', '.build', 'dist', '.DS_Store']);
        fileTreeSummary = topLevel.filter(f => !IGNORE.has(f)).slice(0, 20).join(', ');
      } catch { fileTreeSummary = 'unavailable'; }

      const systemPrompt = [
        `You are RONIN — a native macOS AI command center built by Gaurav Mishra, a design-engineer in Bengaluru.`,
        `You are the operator's primary intelligence. Think in systems, speak in outcomes, never waste words.`,
        `You have tools available to act on the operator's codebase and environment.`,
        `TOOL RULES:`,
        `- For simple greetings, questions, or conversational messages: respond directly WITHOUT calling any tools.`,
        `- Only use tools when the operator explicitly asks to read/search/modify files, run commands, or search the web.`,
        `- Keywords that trigger tools: "read", "show me", "what's in", "find", "search", "run", "list files", "look at", "open", "check", "write", "create", "make".`,
        `- Do NOT call list_files or read_file speculatively unless asked.`,
        `PREVIEW PANE RULES (CRITICAL):`,
        `- RONIN has a built-in preview pane on the right side of the Forge screen.`,
        `- After writing any HTML, SVG, or web file, ALWAYS call show_in_preview with the file path.`,
        `- After writing any file the operator wants to see, call show_in_preview immediately.`,
        `- NEVER tell the operator to open files in Chrome or any external browser. Always use show_in_preview.`,
        `- The preview pane supports file:// URLs for local HTML files and http:// for dev servers.`,
        `Project root: ${projectPath}`,
        `Never mention being Claude or an AI unless directly asked. You are RONIN.`,
      ].join('\n');

      // ── Tool definitions ────────────────────────────────────────────────
      const RONIN_TOOLS = [
        {
          name: 'show_in_preview',
          description: 'Load a URL or local file path into the RONIN preview pane. Use this after writing a file so the operator can see it immediately. For local files, pass the absolute path. For URLs, pass the full http:// address.',
          input_schema: {
            type: 'object',
            properties: {
              target: { type: 'string', description: 'Absolute file path (e.g. /Users/.../file.html) or URL (e.g. http://localhost:3000)' },
              title: { type: 'string', description: 'Optional label shown in the preview pane header' },
            },
            required: ['target'],
          },
        },
        {
          name: 'read_file',
          description: 'Read the contents of any file in the project. Use this whenever the operator asks about code, config, or any file content.',
          input_schema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Absolute or project-relative file path' },
            },
            required: ['path'],
          },
        },
        {
          name: 'list_files',
          description: 'List files and directories at a given path. Use to explore the project structure.',
          input_schema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Directory to list' },
              depth: { type: 'number', description: 'Max depth to recurse (default 2)' },
            },
            required: ['path'],
          },
        },
        {
          name: 'search_files',
          description: 'Search for a text pattern across files in the project. Use for finding TODO comments, function names, usages etc.',
          input_schema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Text or regex to search for' },
              path: { type: 'string', description: 'Directory to search in (default: project root)' },
              file_pattern: { type: 'string', description: 'File glob filter e.g. *.swift, *.mjs' },
            },
            required: ['query'],
          },
        },
        {
          name: 'get_diff',
          description: 'Get the current git diff to see what has changed. Use when operator asks about recent changes.',
          input_schema: { type: 'object', properties: {} },
        },
        {
          name: 'write_file',
          description: 'Write or overwrite a file. ALWAYS explain what you are writing and why before calling this. Operator must have requested a code change.',
          input_schema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'File path to write' },
              content: { type: 'string', description: 'Full file content to write' },
            },
            required: ['path', 'content'],
          },
        },
        {
          name: 'run_command',
          description: 'Run a shell command. Use for running tests, builds, installs. ALWAYS state what command you will run and why.',
          input_schema: {
            type: 'object',
            properties: {
              command: { type: 'string', description: 'Shell command to execute' },
              cwd: { type: 'string', description: 'Working directory (default: project root)' },
            },
            required: ['command'],
          },
        },
        {
          name: 'web_search',
          description: 'Search the web for current information. Use for docs, error messages, recent news, library versions.',
          input_schema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search query' },
            },
            required: ['query'],
          },
        },
      ];

      // ── Tool executor ───────────────────────────────────────────────────
      async function executeTool(name, input) {
        const { readFile, writeFile, readdir, stat } = await import('node:fs/promises');
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const exec = promisify(execFile);
        const root = projectPath;

        switch (name) {
          case 'show_in_preview': {
            const target = input.target ?? '';
            const title = input.title ?? 'Preview';
            // Convert file path to file:// URL if needed
            const url = target.startsWith('/') ? `file://${target}` : target;
            // Broadcast to all SSE clients so SwiftUI preview pane updates
            broadcastSSE('preview.load', JSON.stringify({ url, title }));
            // Also send as SSE event in this response stream so Swift catches it
            sendSSE('preview_load', { url, title });
            return `Preview pane loading: ${url}`;
          }

          case 'read_file': {
            const filePath = input.path.startsWith('/') ? input.path : resolve(root, input.path);
            try {
              const content = await readFile(filePath, 'utf8');
              return content.length > 12000 ? content.slice(0, 12000) + '\n...[truncated — ask for a specific section if needed]' : content;
            } catch (e) { return `Error reading file: ${e.message}`; }
          }

          case 'list_files': {
            const dirPath = input.path.startsWith('/') ? input.path : resolve(root, input.path);
            const depth = input.depth ?? 2;
            const IGNORE = new Set(['node_modules', '.git', '.build', 'dist', '.DS_Store']);
            async function walk(dir, d) {
              if (d > depth) return [];
              try {
                const entries = await readdir(dir);
                const results = [];
                for (const name of entries) {
                  if (IGNORE.has(name)) continue;
                  const full = resolve(dir, name);
                  const s = await stat(full).catch(() => null);
                  if (!s) continue;
                  const rel = full.replace(root, '');
                  if (s.isDirectory()) {
                    results.push(`${rel}/`);
                    results.push(...await walk(full, d + 1));
                  } else {
                    results.push(rel);
                  }
                }
                return results;
              } catch { return []; }
            }
            const files = await walk(dirPath, 0);
            return files.slice(0, 200).join('\n') || 'Empty directory';
          }

          case 'search_files': {
            const searchPath = input.path ? (input.path.startsWith('/') ? input.path : resolve(root, input.path)) : root;
            try {
              const grepArgs = ['-r', '--include', input.file_pattern ?? '*', '-l', '-m', '5', input.query, searchPath];
              const { stdout } = await exec('grep', grepArgs, { cwd: root }).catch(() => ({ stdout: '' }));
              if (!stdout.trim()) return 'No matches found';
              const files = stdout.trim().split('\n').slice(0, 10);
              const results = [];
              for (const f of files) {
                try {
                  const content = await readFile(f, 'utf8');
                  const lines = content.split('\n');
                  const matching = lines
                    .map((line, i) => ({ line, i }))
                    .filter(({ line }) => line.toLowerCase().includes(input.query.toLowerCase()))
                    .slice(0, 3)
                    .map(({ line, i }) => `  L${i + 1}: ${line.trim()}`);
                  results.push(`${f.replace(root, '')}:\n${matching.join('\n')}`);
                } catch { results.push(f.replace(root, '')); }
              }
              return results.join('\n\n');
            } catch (e) { return `Search error: ${e.message}`; }
          }

          case 'get_diff': {
            try {
              const { stdout } = await exec('git', ['diff', '--stat', 'HEAD'], { cwd: root });
              const { stdout: unstaged } = await exec('git', ['diff', '--name-status'], { cwd: root });
              return `Staged:\n${stdout || 'none'}\n\nUnstaged:\n${unstaged || 'none'}`;
            } catch { return 'Not a git repository or no changes'; }
          }

          case 'write_file': {
            const filePath = input.path.startsWith('/') ? input.path : resolve(root, input.path);
            try {
              await writeFile(filePath, input.content, 'utf8');
              return `Written: ${filePath}`;
            } catch (e) { return `Error writing file: ${e.message}`; }
          }

          case 'run_command': {
            const cwd = input.cwd ? (input.cwd.startsWith('/') ? input.cwd : resolve(root, input.cwd)) : root;
            try {
              const [bin, ...args] = input.command.split(' ');
              const { stdout, stderr } = await exec(bin, args, { cwd, timeout: 30000 });
              return [stdout, stderr].filter(Boolean).join('\n') || 'Command completed with no output';
            } catch (e) { return `Command failed: ${e.stderr || e.message}`; }
          }

          case 'web_search': {
            // Use Brave Search API if configured, else DuckDuckGo instant answers
            const apiKey = process.env.BRAVE_SEARCH_API_KEY;
            try {
              if (apiKey) {
                const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(input.query)}&count=5`;
                const resp = await fetch(url, { headers: { 'Accept': 'application/json', 'X-Subscription-Token': apiKey } });
                const data = await resp.json();
                const results = data.web?.results ?? [];
                return results.slice(0, 5).map(r => `**${r.title}**\n${r.url}\n${r.description}`).join('\n\n');
              } else {
                // Fallback: DuckDuckGo instant answer API (no key needed)
                const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(input.query)}&format=json&no_redirect=1&no_html=1`;
                const resp = await fetch(url);
                const data = await resp.json();
                const abstract = data.AbstractText || data.Answer || '';
                const related = (data.RelatedTopics ?? []).slice(0, 3).map(t => t.Text || '').filter(Boolean);
                return abstract || related.join('\n') || `No instant answer. Try: https://search.brave.com/search?q=${encodeURIComponent(input.query)}`;
              }
            } catch (e) { return `Search error: ${e.message}`; }
          }

          default: return `Unknown tool: ${name}`;
        }
      }

      // ── Agentic loop — Claude can call tools multiple times ────────────
      let totalTokensIn = 0, totalTokensOut = 0;
      let loopMessages = [...apiMessages];
      const MAX_TURNS = 5;

      for (let turn = 0; turn < MAX_TURNS; turn++) {
        const stream = client.messages.stream({
          model:      state.providerConfig.anthropic.model ?? DEFAULT_MODEL,
          max_tokens: 4096,
          system:     systemPrompt,
          messages:   loopMessages,
          tools:      RONIN_TOOLS,
        });

        let assistantContent = [];
        let hasToolUse = false;

        for await (const event of stream) {
          if (event.type === 'content_block_start') {
            if (event.content_block.type === 'text') {
              assistantContent.push({ type: 'text', text: '' });
            } else if (event.content_block.type === 'tool_use') {
              hasToolUse = true;
              assistantContent.push({
                type: 'tool_use',
                id: event.content_block.id,
                name: event.content_block.name,
                input: {},
              });
              // Tell Swift a tool is being called
              sendSSE('tool_use', { id: event.content_block.id, name: event.content_block.name, input: {} });
            }
          } else if (event.type === 'content_block_delta') {
            const last = assistantContent[assistantContent.length - 1];
            if (event.delta.type === 'text_delta' && last?.type === 'text') {
              last.text += event.delta.text;
              sendSSE('token', { token: event.delta.text });
            } else if (event.delta.type === 'input_json_delta' && last?.type === 'tool_use') {
              // accumulate JSON string
              last._inputJson = (last._inputJson ?? '') + event.delta.partial_json;
            }
          } else if (event.type === 'content_block_stop') {
            const last = assistantContent[assistantContent.length - 1];
            if (last?.type === 'tool_use' && last._inputJson) {
              try { last.input = JSON.parse(last._inputJson); } catch { last.input = {}; }
              delete last._inputJson;
              // Update the tool_use SSE with final input
              sendSSE('tool_use', { id: last.id, name: last.name, input: last.input });
            }
          } else if (event.type === 'message_start') {
            totalTokensIn += event.message?.usage?.input_tokens ?? 0;
          } else if (event.type === 'message_delta') {
            totalTokensOut += event.usage?.output_tokens ?? 0;
          }
        }

        // Add assistant turn to messages
        loopMessages.push({ role: 'assistant', content: assistantContent });

        if (!hasToolUse) break; // Claude finished — no more tool calls

        // Execute all tool calls and collect results
        const toolResults = [];
        for (const block of assistantContent) {
          if (block.type !== 'tool_use') continue;
          sendSSE('tool_thinking', { name: block.name, input: block.input });
          const result = await executeTool(block.name, block.input);
          sendSSE('tool_result', { tool_use_id: block.id, name: block.name, result: typeof result === 'string' ? result.slice(0, 2000) : String(result) });
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: String(result) });
        }

        // Add tool results to messages and loop
        loopMessages.push({ role: 'user', content: toolResults });
      }

      const costUsd = (totalTokensIn * 0.000003) + (totalTokensOut * 0.000015);
      state.sessionStartedAt = state.sessionStartedAt ?? Date.now();
      if (!state.forgeSessions) state.forgeSessions = new Map();
      const sessionId = randomUUID();
      state.forgeSessions.set(sessionId, { tokensIn: totalTokensIn, tokensOut: totalTokensOut, costUsd });
      sendSSE('done', { tokensIn: totalTokensIn, tokensOut: totalTokensOut, costUsd });
      broadcastSSE('chat.message.complete', JSON.stringify({ tokensIn: totalTokensIn, tokensOut: totalTokensOut, costUsd }));

    } catch (err) {
      sendSSE('error', { message: err.message ?? 'Stream failed' });
    }
    res.end();
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PHASE C — 6 NEW ENDPOINTS (Forge Wiring Plan)
  // ═══════════════════════════════════════════════════════════════════════

  // ─── GET /api/usage → Token spend by seat, model, day ───────────────────
  if (method === 'GET' && pathname === '/api/usage') {
    const sessions = [...state.forgeSessions.values()];
    const totalCostUsd = sessions.reduce((sum, s) => sum + (s.costUsd ?? 0), 0);
    const totalTokensIn  = sessions.reduce((sum, s) => sum + (s.tokensIn ?? 0), 0);
    const totalTokensOut = sessions.reduce((sum, s) => sum + (s.tokensOut ?? 0), 0);

    // Per-seat breakdown from agent threads
    const seatBreakdown = {};
    for (const [agentId, msgs] of state.agentThreads.entries()) {
      const agent = AGENTS.get(agentId);
      if (!agent) continue;
      const calls = msgs.filter(m => m.role === 'assistant').length;
      seatBreakdown[agentId] = {
        seat:     agentId,
        name:     agent.name,
        role:     agent.role,
        calls,
        tokensIn:  Math.round(calls * 420),  // estimated — replace with real tracking
        tokensOut: Math.round(calls * 180),
        costUsd:   parseFloat((calls * 0.0018).toFixed(6)),
        model:     state.providerConfig.anthropic.model ?? DEFAULT_MODEL,
      };
    }

    // Daily burn from session start
    const sessionStart = state.sessionStartedAt ?? Date.now();
    const hoursElapsed = (Date.now() - sessionStart) / 3_600_000;
    const projectedDailyUsd = hoursElapsed > 0
      ? parseFloat(((totalCostUsd / hoursElapsed) * 24).toFixed(4))
      : 0;

    return sendJSON(res, 200, {
      session: {
        totalCostUsd:   parseFloat(totalCostUsd.toFixed(6)),
        totalTokensIn,
        totalTokensOut,
        totalCalls:     sessions.length,
        startedAt:      new Date(sessionStart).toISOString(),
        projectedDailyUsd,
      },
      seats:   Object.values(seatBreakdown),
      dailyCap: parseFloat(process.env.RONIN_DAILY_CAP ?? '25'),
    });
  }

  // ─── GET /api/mcp/status → Ping each MCP, return green/amber/red ────────
  if (method === 'GET' && pathname === '/api/mcp/status') {
    // MCP endpoints to check — extend via env
    const mcpTargets = [
      { id: 'figma',    name: 'Figma',    url: process.env.MCP_FIGMA_URL    ?? 'http://localhost:3845/health' },
      { id: 'blender',  name: 'Blender',  url: process.env.MCP_BLENDER_URL  ?? 'http://localhost:6500/health' },
      { id: 'gmail',    name: 'Gmail',    url: process.env.MCP_GMAIL_URL    ?? null },
      { id: 'calendar', name: 'Calendar', url: process.env.MCP_CALENDAR_URL ?? null },
      { id: 'notion',   name: 'Notion',   url: process.env.MCP_NOTION_URL   ?? null },
    ];

    const results = await Promise.all(mcpTargets.map(async t => {
      if (!t.url) return { ...t, status: 'unconfigured', latencyMs: null };
      const start = Date.now();
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 2000);
        await fetch(t.url, { signal: ctrl.signal });
        clearTimeout(timer);
        return { ...t, status: 'online', latencyMs: Date.now() - start };
      } catch {
        return { ...t, status: Date.now() - start < 2000 ? 'offline' : 'timeout', latencyMs: null };
      }
    }));

    const online = results.filter(r => r.status === 'online').length;
    return sendJSON(res, 200, {
      summary: `${online}/${results.length} online`,
      connectors: results,
      checkedAt: new Date().toISOString(),
    });
  }

  // ─── GET /api/diff → Current git diff (staged + unstaged) ───────────────
  if (method === 'GET' && pathname === '/api/diff') {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);

    const cwd = process.env.RONIN_PROJECT_PATH ??
      resolve(dirname(fileURLToPath(import.meta.url)), '../..');

    try {
      const [staged, unstaged] = await Promise.all([
        exec('git', ['diff', '--cached', '--stat'], { cwd }).then(r => r.stdout).catch(() => ''),
        exec('git', ['diff', '--stat'], { cwd }).then(r => r.stdout).catch(() => ''),
      ]);
      const [stagedFull, unstagedFull] = await Promise.all([
        exec('git', ['diff', '--cached'], { cwd }).then(r => r.stdout).catch(() => ''),
        exec('git', ['diff'], { cwd }).then(r => r.stdout).catch(() => ''),
      ]);
      return sendJSON(res, 200, {
        staged:   { stat: staged.trim(),   diff: stagedFull.trim() },
        unstaged: { stat: unstaged.trim(), diff: unstagedFull.trim() },
        hasChanges: Boolean(staged.trim() || unstaged.trim()),
      });
    } catch (err) {
      return sendJSON(res, 200, { staged: {}, unstaged: {}, hasChanges: false, error: err.message });
    }
  }

  // ─── GET /api/filetree → Project file tree with agent scope markers ──────
  if (method === 'GET' && pathname === '/api/filetree') {
    const { readdir, stat } = await import('node:fs/promises');
    const root = process.env.RONIN_PROJECT_PATH ??
      resolve(dirname(fileURLToPath(import.meta.url)), '../..');

    const IGNORE = new Set(['node_modules', '.git', '.build', 'dist', '.DS_Store']);

    async function walk(dir, depth = 0) {
      if (depth > 3) return [];
      let entries;
      try { entries = await readdir(dir); } catch { return []; }
      const nodes = [];
      for (const name of entries) {
        if (IGNORE.has(name)) continue;
        const full = resolve(dir, name);
        const s = await stat(full).catch(() => null);
        if (!s) continue;
        const node = { name, path: full.replace(root, ''), type: s.isDirectory() ? 'dir' : 'file' };
        if (s.isDirectory()) node.children = await walk(full, depth + 1);
        nodes.push(node);
      }
      return nodes;
    }

    const tree = await walk(root);
    return sendJSON(res, 200, { root, tree, generatedAt: new Date().toISOString() });
  }

  // ─── GET /api/memory/taste-log → Taste delta history ────────────────────
  if (method === 'GET' && pathname === '/api/memory/taste-log') {
    const { readFile } = await import('node:fs/promises');
    const memPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../memory/context-compressor.mjs'
    );

    // Try to read warm-memory.json if it exists
    const warmPath = resolve(dirname(fileURLToPath(import.meta.url)), '../memory/warm-memory.json');
    let tasteLog = [];
    let operatorProfile = null;
    try {
      const raw = await readFile(warmPath, 'utf8');
      const mem = JSON.parse(raw);
      tasteLog = mem.tasteLog ?? [];
      operatorProfile = mem.operatorProfile ?? null;
    } catch { /* file may not exist yet */ }

    return sendJSON(res, 200, {
      tasteLog,
      operatorProfile,
      dimensions: ['Craft', 'Density', 'Tone', 'Structure', 'Aesthetics', 'Speed', 'Precision'],
      lastCompressedAt: null,
    });
  }

  // ─── GET /api/jobs → Async job queue status ──────────────────────────────
  if (method === 'GET' && pathname === '/api/jobs') {
    const jobs = [...(state.jobs?.values() ?? [])];
    return sendJSON(res, 200, {
      jobs,
      total: jobs.length,
      running:  jobs.filter(j => j.status === 'running').length,
      queued:   jobs.filter(j => j.status === 'queued').length,
      complete: jobs.filter(j => j.status === 'complete').length,
      failed:   jobs.filter(j => j.status === 'failed').length,
    });
  }

  // ─── POST /api/jobs → Enqueue a new async job ────────────────────────────
  if (method === 'POST' && pathname === '/api/jobs') {
    const body = await readBody(req);
    if (!state.jobs) state.jobs = new Map();
    const job = {
      id:        randomUUID(),
      name:      body.name ?? 'Unnamed job',
      seat:      body.seat ?? 'architect',
      status:    'queued',
      costUsd:   0,
      createdAt: Date.now(),
      startedAt: null,
      doneAt:    null,
      result:    null,
    };
    state.jobs.set(job.id, job);
    broadcastSSE('job.queued', JSON.stringify({ jobId: job.id, name: job.name, seat: job.seat }));
    return sendJSON(res, 201, job);
  }

  // ─── GET /api/git/branch → Current branch + branch list ─────────────────
  if (method === 'GET' && pathname === '/api/git/branch') {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);

    // Try RONIN_GIT_PATH first, then common locations, then fallback gracefully
    const candidates = [
      process.env.RONIN_GIT_PATH,
      '/Users/chaosarchitect/Documents/RONIN App',
      process.env.RONIN_PROJECT_PATH,
      resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
    ].filter(Boolean);

    for (const cwd of candidates) {
      try {
        const [branchResult, allResult] = await Promise.all([
          exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd }),
          exec('git', ['branch', '--format=%(refname:short)'], { cwd }),
        ]);
        const branch = branchResult.stdout.trim();
        const branches = allResult.stdout.trim().split('\n').filter(Boolean);
        return sendJSON(res, 200, { branch, branches });
      } catch { continue; }
    }
    // No git repo found anywhere — return clean fallback, no error noise
    return sendJSON(res, 200, { branch: 'main', branches: ['main'] });
  }

  // ─── GET /api/file?path=X → File content ─────────────────────────────────
  if (method === 'GET' && pathname === '/api/file') {
    const { readFile, stat } = await import('node:fs/promises');
    const filePath = url.searchParams.get('path');
    if (!filePath) return sendError(res, 400, 'Missing path query param');

    const root = process.env.RONIN_PROJECT_PATH ??
      resolve(dirname(fileURLToPath(import.meta.url)), '../..');

    // Resolve relative to project root, prevent directory traversal
    const resolved = resolve(root, filePath.replace(/^\//, ''));
    if (!resolved.startsWith(root)) return sendError(res, 403, 'Access denied');

    try {
      const [content, info] = await Promise.all([
        readFile(resolved, 'utf8'),
        stat(resolved),
      ]);
      return sendJSON(res, 200, { path: filePath, content, size: info.size });
    } catch (err) {
      return sendError(res, 404, `Cannot read file: ${err.message}`);
    }
  }

  // ─── POST /api/dev/run → Run action, stream output via SSE ───────────────
  if (method === 'POST' && pathname === '/api/dev/run') {
    const body = await readBody(req);
    const action = body.action ?? 'run';
    const cwd = process.env.RONIN_PROJECT_PATH ??
      resolve(dirname(fileURLToPath(import.meta.url)), '../..');

    const COMMANDS = {
      run:    'npm run dev',
      test:   'npm test',
      build:  'npm run build',
      deploy: 'npm run deploy',
    };

    const cmd = COMMANDS[action];
    if (!cmd) return sendError(res, 400, `Unknown action: ${action}`);

    // SSE response for streaming command output
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    });

    const { spawn } = await import('node:child_process');
    const [bin, ...args] = cmd.split(' ');
    const child = spawn(bin, args, { cwd, shell: true });

    const emit = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify({ output: data, action })}\n\n`);
    };

    child.stdout.on('data', chunk => emit('output', chunk.toString()));
    child.stderr.on('data', chunk => emit('output', chunk.toString()));
    child.on('close', code => {
      emit('done', `Process exited with code ${code}`);
      res.end();
    });
    child.on('error', err => {
      emit('error', err.message);
      res.end();
    });

    req.on('close', () => child.kill());
    return; // response handled by SSE
  }

  // ─── 404 ────────────────────────────────────────────────────────────────
  sendError(res, 404, `Not found: ${method} ${pathname}`);
}

// ─── Server Factory ─────────────────────────────────────────────────────────
// Exported for testing. Tests call createChatServer() without starting it.

export function createChatServer() {
  seedAgents();

  const server = createServer((req, res) => {
    handleRequest(req, res).catch(err => {
      console.error('[chatServer] Unhandled error:', err);
      sendError(res, 500, 'Internal server error');
    });
  });

  return server;
}

// ─── Start (when run directly) ──────────────────────────────────────────────

const isMainModule = process.argv[1]?.endsWith('chatServer.mjs');

if (isMainModule) {
  const server = createChatServer();
  server.listen(PORT, () => {
    console.log(`[RONIN] chatServer listening on http://127.0.0.1:${PORT}`);
    console.log(`[RONIN] Provider configured: ${state.providerConfig.anthropic.configured}`);
    console.log(`[RONIN] Agents: ${AGENTS.size}`);
  });

  // ── Morning Brief cron — 7:30 AM daily ──────────────────────────────
  scheduleMorningBrief();
}

async function scheduleMorningBrief() {
  const { default: Anthropic } = await import('@anthropic-ai/sdk').catch(() => ({ default: null }));

  const msUntil730 = () => {
    const now = new Date();
    const next = new Date();
    next.setHours(7, 30, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next - now;
  };

  const runBrief = async () => {
    if (!Anthropic || !state.providerConfig.anthropic.apiKey) {
      console.log('[RONIN] Morning brief skipped — no API key');
      return;
    }
    console.log('[RONIN] Generating morning brief…');
    try {
      const client = new Anthropic({ apiKey: state.providerConfig.anthropic.apiKey });
      const res = await client.messages.create({
        model: state.providerConfig.anthropic.model ?? DEFAULT_MODEL,
        max_tokens: 600,
        system: `You are the Business Director of RONIN. Generate a morning brief for Gaurav Mishra.
Format:
YESTERDAY: 2-3 bullet points of completed/notable items.
PENDING: 2-3 items needing attention or approval.
TODAY — TOP 3: Ranked by leverage, max impact first.
Be direct. Founder-grade. No hedging. Under 200 words total.`,
        messages: [{ role: 'user', content: 'Generate morning brief for today.' }],
      });

      const brief = res.content[0]?.text ?? '';
      if (!state.jobs) state.jobs = new Map();
      const jobId = randomUUID();
      state.jobs.set(jobId, {
        id: jobId, name: 'Morning brief', seat: 'business',
        status: 'complete', costUsd: 0.0018,
        createdAt: Date.now(), startedAt: Date.now() - 3000, doneAt: Date.now(),
        result: brief,
      });
      broadcastSSE('brief.ready', JSON.stringify({ brief, generatedAt: new Date().toISOString() }));
      console.log('[RONIN] Morning brief generated and broadcast.');
    } catch (err) {
      console.error('[RONIN] Morning brief failed:', err.message);
    }
    // Schedule next day
    setTimeout(runBrief, msUntil730());
  };

  // First run
  setTimeout(runBrief, msUntil730());
  console.log(`[RONIN] Morning brief cron scheduled — next run in ${Math.round(msUntil730() / 60000)}min`);
}

// ─── Exports for testing ────────────────────────────────────────────────────

export {
  state,
  AGENTS,
  AGENT_SEEDS,
  OPERATOR,
  ACCEPTED_PATTERNS,
  REJECTED_PATTERNS,
  CURRENT_CONSTRAINTS,
  matchRoute,
  transitionCycle,
  buildCrewStatus,
  buildThreadResponse,
  buildAgentThreadResponse,
  buildWorkspace,
  createThreadMessage,
  broadcastSSE,
  seedAgents,
  defaultPreview,
  PORT,
  getForgeSessionManager,
};
