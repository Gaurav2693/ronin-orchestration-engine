// api/chatServer.test.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Phase 11A tests: chatServer — the bridge between shell and engine.
//
// Tests cover:
//   - Server creation and health endpoint
//   - All GET endpoints return correct shapes
//   - Cycle lifecycle (start, transition, approve/revise)
//   - Message processing (mock provider)
//   - Agent context and threading
//   - SSE event streaming
//   - URL pattern matching
//   - Error handling
//   - CORS headers
// ─────────────────────────────────────────────────────────────────────────────

import { jest } from '@jest/globals';

// ─── Import module under test ───────────────────────────────────────────────

import {
  createChatServer,
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
} from './chatServer.mjs';

// ─── Test Helpers ───────────────────────────────────────────────────────────

let server;
let baseURL;

function resetState() {
  state.cycles.clear();
  state.threads.clear();
  state.agentThreads.clear();
  state.activeCycleId = null;
  state.sseClients.clear();
  AGENTS.clear();
  seedAgents();
}

async function startServer() {
  return new Promise((resolve) => {
    server = createChatServer();
    server.listen(0, () => {
      const port = server.address().port;
      baseURL = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

async function stopServer() {
  if (!server) return;
  return new Promise((resolve) => {
    // Close all SSE clients first
    for (const [, client] of state.sseClients) {
      clearInterval(client.heartbeatInterval);
      if (client.res.writable) client.res.end();
    }
    state.sseClients.clear();
    server.close(() => resolve());
  });
}

async function fetchJSON(path, options = {}) {
  const res = await fetch(`${baseURL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await res.json();
  return { status: res.status, body, headers: res.headers };
}

async function postJSON(path, data) {
  return fetchJSON(path, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

// ─── Test Suite ─────────────────────────────────────────────────────────────

describe('chatServer — Phase 11A: The Bridge', () => {

  beforeAll(async () => {
    await startServer();
  });

  afterAll(async () => {
    await stopServer();
  });

  beforeEach(() => {
    resetState();
  });

  // ════════════════════════════════════════════════════════════════════════
  // 1. Unit Tests — Pure Functions
  // ════════════════════════════════════════════════════════════════════════

  describe('matchRoute', () => {
    test('matches static paths', () => {
      expect(matchRoute('/health', '/health')).toEqual({});
    });

    test('matches paths with single param', () => {
      expect(matchRoute('/api/cycles/:id', '/api/cycles/abc123')).toEqual({ id: 'abc123' });
    });

    test('matches paths with multiple params', () => {
      expect(matchRoute('/api/:type/:id/thread', '/api/cycles/abc/thread')).toEqual({
        type: 'cycles', id: 'abc',
      });
    });

    test('returns null for non-matching paths', () => {
      expect(matchRoute('/api/cycles/:id', '/api/agents/abc')).toBeNull();
    });

    test('returns null for different length paths', () => {
      expect(matchRoute('/api/cycles/:id', '/api/cycles/abc/thread')).toBeNull();
    });

    test('decodes URI components in params', () => {
      expect(matchRoute('/api/cycles/:id', '/api/cycles/hello%20world')).toEqual({ id: 'hello world' });
    });
  });

  describe('createThreadMessage', () => {
    test('creates message with all required fields', () => {
      const msg = createThreadMessage('operator', 'op1', 'Gaurav', 'Test', 'Hello', 'neutral');
      expect(msg.id).toBeDefined();
      expect(msg.lane).toBe('operator');
      expect(msg.speaker_id).toBe('op1');
      expect(msg.speaker_name).toBe('Gaurav');
      expect(msg.title).toBe('Test');
      expect(msg.body).toBe('Hello');
      expect(msg.tone).toBe('neutral');
      expect(msg.created_at).toBeDefined();
    });

    test('generates unique IDs for each message', () => {
      const msg1 = createThreadMessage('a', 'b', 'c', 'd', 'e');
      const msg2 = createThreadMessage('a', 'b', 'c', 'd', 'e');
      expect(msg1.id).not.toBe(msg2.id);
    });
  });

  describe('defaultPreview', () => {
    test('returns idle preview state', () => {
      const p = defaultPreview();
      expect(p.state).toBe('idle');
      expect(p.title).toBe('Preview');
      expect(p.live_url).toBeNull();
    });
  });

  describe('buildCrewStatus', () => {
    test('returns posture for all agents', () => {
      const crew = buildCrewStatus();
      expect(crew.ronin).toBe('idle');
      expect(crew.director).toBe('sleeping');
      expect(crew.ops).toBe('idle');
      expect(crew.analyst).toBe('idle');
      expect(crew.memory).toBe('idle');
      expect(crew.specialist).toBe('sleeping');
    });

    test('reflects posture changes', () => {
      AGENTS.get('ronin').posture = 'working';
      const crew = buildCrewStatus();
      expect(crew.ronin).toBe('working');
    });
  });

  describe('seedAgents', () => {
    test('creates all 6 agents', () => {
      expect(AGENTS.size).toBe(6);
    });

    test('each agent has required fields', () => {
      for (const [, agent] of AGENTS) {
        expect(agent.id).toBeDefined();
        expect(agent.name).toBeDefined();
        expect(agent.role).toBeDefined();
        expect(agent.voice_profile).toBeDefined();
        expect(agent.voice_profile.tone).toBeDefined();
        expect(agent.essence).toBeDefined();
        expect(agent.strengths).toBeInstanceOf(Array);
        expect(agent.anti_patterns).toBeInstanceOf(Array);
        expect(agent.posture).toBeDefined();
        expect(agent.current_responsibility).toBeDefined();
        expect(agent.summary).toBeDefined();
      }
    });

    test('RONIN is the core agent', () => {
      const ronin = AGENTS.get('ronin');
      expect(ronin.name).toBe('RONIN');
      expect(ronin.role).toBe('Core');
    });

    test('Director is Dead Shifu', () => {
      const director = AGENTS.get('director');
      expect(director.name).toBe('Dead Shifu');
      expect(director.role).toBe('Director');
      expect(director.posture).toBe('sleeping');
    });
  });

  describe('transitionCycle', () => {
    test('allows valid state transitions', () => {
      const cycleId = 'test-cycle';
      state.cycles.set(cycleId, {
        id: cycleId, mode: 'hybrid', brief: { feature_slice: 'test' },
        current_state: 'direction_review', history: [],
      });

      const result = transitionCycle(cycleId, 'architecture', 'approved');
      expect(result).not.toBeNull();
      expect(result.current_state).toBe('architecture');
      expect(result.history).toHaveLength(1);
      expect(result.history[0].state).toBe('architecture');
      expect(result.history[0].reason).toBe('approved');
    });

    test('rejects invalid state transitions', () => {
      const cycleId = 'test-cycle';
      state.cycles.set(cycleId, {
        id: cycleId, mode: 'hybrid', brief: { feature_slice: 'test' },
        current_state: 'idle', history: [],
      });

      const result = transitionCycle(cycleId, 'execution', 'skip');
      expect(result).toBeNull();
    });

    test('returns null for non-existent cycle', () => {
      expect(transitionCycle('nonexistent', 'briefing', 'test')).toBeNull();
    });

    test('allows blocked from any state', () => {
      const cycleId = 'test-cycle';
      state.cycles.set(cycleId, {
        id: cycleId, mode: 'hybrid', brief: { feature_slice: 'test' },
        current_state: 'execution', history: [],
      });

      const result = transitionCycle(cycleId, 'blocked', 'provider error');
      expect(result).not.toBeNull();
      expect(result.current_state).toBe('blocked');
    });
  });

  describe('buildWorkspace', () => {
    test('builds workspace with agent rail', () => {
      const cycle = {
        id: 'c1', mode: 'hybrid', brief: { feature_slice: 'test', goal: 'test goal' },
        current_state: 'briefing',
      };
      state.cycles.set('c1', cycle);

      const ws = buildWorkspace('c1', cycle);
      expect(ws.scope).toBe('cycle');
      expect(ws.workspace_id).toBe('c1');
      expect(ws.agent_rail.agents).toHaveLength(6);
      expect(ws.session_tabs).toHaveLength(3);
      expect(ws.thread_summary.message_count).toBe(0);
    });
  });

  describe('buildThreadResponse', () => {
    test('builds response with messages', () => {
      const cycleId = 'c1';
      state.cycles.set(cycleId, {
        id: cycleId, mode: 'hybrid', brief: { feature_slice: 'test' },
        current_state: 'briefing',
      });
      state.threads.set(cycleId, [
        createThreadMessage('operator', 'op', 'Gaurav', 'Hello', 'Test message'),
      ]);

      const resp = buildThreadResponse(cycleId);
      expect(resp.cycle_id).toBe(cycleId);
      expect(resp.messages).toHaveLength(1);
      expect(resp.preview.state).toBe('idle');
      expect(resp.crew_status.ronin).toBeDefined();
    });
  });

  describe('buildAgentThreadResponse', () => {
    test('builds response for existing agent', () => {
      const resp = buildAgentThreadResponse('ronin');
      expect(resp).not.toBeNull();
      expect(resp.agent.id).toBe('ronin');
      expect(resp.messages).toEqual([]);
    });

    test('returns null for non-existent agent', () => {
      expect(buildAgentThreadResponse('nonexistent')).toBeNull();
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // 2. HTTP Endpoint Tests
  // ════════════════════════════════════════════════════════════════════════

  describe('GET /health', () => {
    test('returns 200 with status', async () => {
      const { status, body } = await fetchJSON('/health');
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.uptime).toBeGreaterThanOrEqual(0);
      expect(body.modules).toBe(71);
      expect(body.tests).toBe(3329);
    });
  });

  describe('GET /api/state', () => {
    test('returns dashboard with no active cycle', async () => {
      const { status, body } = await fetchJSON('/api/state');
      expect(status).toBe(200);
      expect(body.active_cycle_id).toBeNull();
      expect(body.active_cycle).toBeNull();
      expect(body.crew_status).toBeDefined();
      expect(body.crew_status.ronin).toBe('idle');
    });

    test('returns active cycle when one exists', async () => {
      // Start a cycle first
      await postJSON('/api/cycles/start', {
        mode: 'hybrid',
        brief: { feature_slice: 'Test', goal: 'Test goal' },
      });

      const { body } = await fetchJSON('/api/state');
      expect(body.active_cycle_id).toBeDefined();
      expect(body.active_cycle).toBeDefined();
      expect(body.active_cycle.mode).toBe('hybrid');
    });
  });

  describe('GET /api/memory/warm-start', () => {
    test('returns operator profile and patterns', async () => {
      const { status, body } = await fetchJSON('/api/memory/warm-start');
      expect(status).toBe(200);
      expect(body.operator.name).toBe('Gaurav Mishra');
      expect(body.operator.title).toBe('Chaos Architect');
      expect(body.accepted_patterns).toContain('approval-gated orchestration');
      expect(body.rejected_patterns).toContain('generic chatbot framing');
      expect(Array.isArray(body.current_constraints)).toBe(true);
      expect(Array.isArray(body.recent_slice_history)).toBe(true);
    });
  });

  describe('GET /api/memory', () => {
    test('returns project memory', async () => {
      const { status, body } = await fetchJSON('/api/memory');
      expect(status).toBe(200);
      expect(body.project.name).toBe('RONIN');
      expect(body.project.mission).toContain('macOS');
      expect(Array.isArray(body.project.memory_layers.slice_history)).toBe(true);
    });
  });

  describe('GET /api/providers/status', () => {
    test('returns provider configuration', async () => {
      const { status, body } = await fetchJSON('/api/providers/status');
      expect(status).toBe(200);
      expect(body.anthropic).toBeDefined();
      expect(body.anthropic.source).toBeDefined();
      expect(body.anthropic.model).toBeDefined();
    });
  });

  describe('POST /api/providers/anthropic/connect', () => {
    test('requires api_key', async () => {
      const { status, body } = await postJSON('/api/providers/anthropic/connect', {});
      expect(status).toBe(400);
      expect(body.error).toContain('api_key');
    });

    test('updates provider config with key', async () => {
      const { status, body } = await postJSON('/api/providers/anthropic/connect', {
        api_key: 'test-key-12345',
        model: 'claude-sonnet-4-6',
      });
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.status.anthropic.configured).toBe(true);
      expect(body.status.anthropic.source).toBe('user');
      expect(body.status.anthropic.last_connected_at).toBeDefined();
    });
  });

  describe('POST /api/cycles/start', () => {
    test('creates a new cycle', async () => {
      const { status, body } = await postJSON('/api/cycles/start', {
        mode: 'hybrid',
        brief: {
          feature_slice: 'Landing page redesign',
          goal: 'Modernize the hero section',
        },
      });
      expect(status).toBe(200);
      expect(body.id).toBeDefined();
      expect(body.mode).toBe('hybrid');
      expect(body.brief.feature_slice).toBe('Landing page redesign');
      expect(body.current_state).toBe('briefing');
      expect(body.history).toHaveLength(1);
    });

    test('sets active cycle', async () => {
      const { body: cycle } = await postJSON('/api/cycles/start', {
        mode: 'fast',
        brief: { feature_slice: 'Quick fix', goal: '' },
      });

      const { body: dashboard } = await fetchJSON('/api/state');
      expect(dashboard.active_cycle_id).toBe(cycle.id);
    });
  });

  describe('GET /api/cycles/:id', () => {
    test('returns cycle snapshot', async () => {
      const { body: cycle } = await postJSON('/api/cycles/start', {
        mode: 'hybrid',
        brief: { feature_slice: 'Test', goal: 'Test' },
      });

      const { status, body } = await fetchJSON(`/api/cycles/${cycle.id}`);
      expect(status).toBe(200);
      expect(body.id).toBe(cycle.id);
    });

    test('returns 404 for non-existent cycle', async () => {
      const { status } = await fetchJSON('/api/cycles/nonexistent');
      expect(status).toBe(404);
    });
  });

  describe('GET /api/cycles/:id/thread', () => {
    test('returns empty thread for new cycle', async () => {
      const { body: cycle } = await postJSON('/api/cycles/start', {
        mode: 'hybrid',
        brief: { feature_slice: 'Test', goal: 'Test' },
      });

      const { status, body } = await fetchJSON(`/api/cycles/${cycle.id}/thread`);
      expect(status).toBe(200);
      expect(body.cycle_id).toBe(cycle.id);
      expect(body.messages).toEqual([]);
      expect(body.preview).toBeDefined();
      expect(body.crew_status).toBeDefined();
    });
  });

  describe('POST /api/cycles/:id/messages', () => {
    test('adds operator message to thread', async () => {
      const { body: cycle } = await postJSON('/api/cycles/start', {
        mode: 'hybrid',
        brief: { feature_slice: 'Test', goal: 'Test' },
      });

      const { status, body } = await postJSON(`/api/cycles/${cycle.id}/messages`, {
        title: 'Question',
        body: 'What is RONIN?',
      });

      expect(status).toBe(200);
      expect(body.messages.length).toBeGreaterThanOrEqual(2); // operator + response
      expect(body.messages[0].speaker_id).toBe('operator');
      expect(body.messages[0].body).toBe('What is RONIN?');
      // Second message is RONIN response (offline mode since no real API key)
      expect(body.messages[1].speaker_id).toBe('ronin');
    });

    test('rejects message without title or body', async () => {
      const { body: cycle } = await postJSON('/api/cycles/start', {
        mode: 'hybrid',
        brief: { feature_slice: 'Test', goal: 'Test' },
      });

      const { status } = await postJSON(`/api/cycles/${cycle.id}/messages`, {});
      expect(status).toBe(400);
    });

    test('returns 404 for non-existent cycle', async () => {
      const { status } = await postJSON('/api/cycles/nonexistent/messages', {
        title: 'Test', body: 'Test',
      });
      expect(status).toBe(404);
    });
  });

  describe('POST /api/cycles/:id/approve-direction', () => {
    test('transitions from direction_review to architecture', async () => {
      const { body: cycle } = await postJSON('/api/cycles/start', {
        mode: 'hybrid',
        brief: { feature_slice: 'Test', goal: 'Test' },
      });

      // Manually set state to direction_review
      state.cycles.get(cycle.id).current_state = 'direction_review';

      const { status, body } = await postJSON(`/api/cycles/${cycle.id}/approve-direction`, {
        selected_direction: 'Direction A',
        operator_notes: 'Looks good',
      });

      expect(status).toBe(200);
      expect(body.current_state).toBe('architecture');
    });

    test('rejects invalid transition', async () => {
      const { body: cycle } = await postJSON('/api/cycles/start', {
        mode: 'hybrid',
        brief: { feature_slice: 'Test', goal: 'Test' },
      });
      // State is 'briefing' — can't approve direction from here
      const { status } = await postJSON(`/api/cycles/${cycle.id}/approve-direction`, {});
      expect(status).toBe(400);
    });
  });

  describe('POST /api/cycles/:id/revise-direction', () => {
    test('transitions from direction_review back to creative', async () => {
      const { body: cycle } = await postJSON('/api/cycles/start', {
        mode: 'hybrid',
        brief: { feature_slice: 'Test', goal: 'Test' },
      });

      state.cycles.get(cycle.id).current_state = 'direction_review';

      const { status, body } = await postJSON(`/api/cycles/${cycle.id}/revise-direction`, {
        rejected_directions: ['Direction B'],
      });

      expect(status).toBe(200);
      expect(body.current_state).toBe('creative');
    });
  });

  describe('POST /api/cycles/:id/approve-plan', () => {
    test('transitions from plan_review to execution', async () => {
      const { body: cycle } = await postJSON('/api/cycles/start', {
        mode: 'hybrid',
        brief: { feature_slice: 'Test', goal: 'Test' },
      });

      state.cycles.get(cycle.id).current_state = 'plan_review';

      const { status, body } = await postJSON(`/api/cycles/${cycle.id}/approve-plan`, {
        operator_notes: 'Ship it',
      });

      expect(status).toBe(200);
      expect(body.current_state).toBe('execution');
    });
  });

  describe('POST /api/cycles/:id/revise-plan', () => {
    test('transitions from plan_review back to architecture', async () => {
      const { body: cycle } = await postJSON('/api/cycles/start', {
        mode: 'hybrid',
        brief: { feature_slice: 'Test', goal: 'Test' },
      });

      state.cycles.get(cycle.id).current_state = 'plan_review';

      const { status, body } = await postJSON(`/api/cycles/${cycle.id}/revise-plan`, {
        taste_signals: ['too complex'],
      });

      expect(status).toBe(200);
      expect(body.current_state).toBe('architecture');
    });
  });

  describe('GET /api/agents/:id/context', () => {
    test('returns agent context', async () => {
      const { status, body } = await fetchJSON('/api/agents/ronin/context');
      expect(status).toBe(200);
      expect(body.id).toBe('ronin');
      expect(body.name).toBe('RONIN');
      expect(body.role).toBe('Core');
      expect(body.voice_profile.tone).toBe('direct');
      expect(body.strengths).toContain('routing');
    });

    test('returns 404 for non-existent agent', async () => {
      const { status } = await fetchJSON('/api/agents/nonexistent/context');
      expect(status).toBe(404);
    });
  });

  describe('GET /api/agents/:id/thread', () => {
    test('returns agent thread response', async () => {
      const { status, body } = await fetchJSON('/api/agents/director/thread');
      expect(status).toBe(200);
      expect(body.agent.id).toBe('director');
      expect(body.agent.name).toBe('Dead Shifu');
      expect(body.messages).toEqual([]);
      expect(body.preview).toBeDefined();
    });
  });

  describe('POST /api/agents/:id/messages', () => {
    test('adds message to agent thread', async () => {
      const { status, body } = await postJSON('/api/agents/ronin/messages', {
        title: 'Question',
        body: 'Status report',
      });

      expect(status).toBe(200);
      expect(body.agent.id).toBe('ronin');
      expect(body.messages.length).toBeGreaterThanOrEqual(2);
      expect(body.messages[0].speaker_id).toBe('operator');
    });

    test('returns 404 for non-existent agent', async () => {
      const { status } = await postJSON('/api/agents/nonexistent/messages', {
        title: 'Test', body: 'Test',
      });
      expect(status).toBe(404);
    });
  });

  describe('GET /api/events (SSE)', () => {
    test('connects and receives initial event', async () => {
      const response = await fetch(`${baseURL}/api/events`, {
        headers: { 'Accept': 'text/event-stream' },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/event-stream');

      // Read the first chunk (connected event)
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const { value } = await reader.read();
      const text = decoder.decode(value);

      expect(text).toContain('event: connected');
      expect(text).toContain('client_id');

      // Clean up
      reader.cancel();
    });
  });

  describe('CORS', () => {
    test('OPTIONS returns 204 with CORS headers', async () => {
      const res = await fetch(`${baseURL}/health`, { method: 'OPTIONS' });
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    });

    test('GET responses include CORS headers', async () => {
      const { headers } = await fetchJSON('/health');
      expect(headers.get('access-control-allow-origin')).toBe('*');
    });
  });

  describe('404 handling', () => {
    test('returns 404 for unknown paths', async () => {
      const { status, body } = await fetchJSON('/api/unknown');
      expect(status).toBe(404);
      expect(body.error).toContain('Not found');
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // 3. Integration: Full Cycle Walkthrough
  // ════════════════════════════════════════════════════════════════════════

  describe('Full cycle lifecycle', () => {
    test('start → message → approve direction → approve plan', async () => {
      // 1. Start cycle
      const { body: cycle } = await postJSON('/api/cycles/start', {
        mode: 'hybrid',
        brief: { feature_slice: 'Dashboard redesign', goal: 'Modernize layout' },
      });
      expect(cycle.current_state).toBe('briefing');

      // 2. Send a message
      const { body: thread } = await postJSON(`/api/cycles/${cycle.id}/messages`, {
        title: 'Brief', body: 'I want a 3-column layout with live preview',
      });
      expect(thread.messages.length).toBeGreaterThanOrEqual(2);

      // 3. Advance to direction_review (simulate the engine progressing)
      state.cycles.get(cycle.id).current_state = 'direction_review';

      // 4. Approve direction
      const { body: afterApprove } = await postJSON(`/api/cycles/${cycle.id}/approve-direction`, {
        selected_direction: 'Option A',
      });
      expect(afterApprove.current_state).toBe('architecture');

      // 5. Advance to plan_review
      state.cycles.get(cycle.id).current_state = 'plan_review';

      // 6. Approve plan
      const { body: afterPlanApprove } = await postJSON(`/api/cycles/${cycle.id}/approve-plan`, {});
      expect(afterPlanApprove.current_state).toBe('execution');
    });
  });

  describe('Multiple cycles', () => {
    test('active cycle updates on new cycle start', async () => {
      const { body: c1 } = await postJSON('/api/cycles/start', {
        mode: 'hybrid', brief: { feature_slice: 'First', goal: '' },
      });
      const { body: c2 } = await postJSON('/api/cycles/start', {
        mode: 'fast', brief: { feature_slice: 'Second', goal: '' },
      });

      const { body: dashboard } = await fetchJSON('/api/state');
      expect(dashboard.active_cycle_id).toBe(c2.id);

      // Both cycles exist
      const { status: s1 } = await fetchJSON(`/api/cycles/${c1.id}`);
      const { status: s2 } = await fetchJSON(`/api/cycles/${c2.id}`);
      expect(s1).toBe(200);
      expect(s2).toBe(200);
    });
  });
});
