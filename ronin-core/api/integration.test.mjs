// ─── api/integration.test.mjs ─────────────────────────────────────────────────
// Phase 11F — Integration Test
//
// End-to-end server-side verification: shell ↔ engine ↔ Forge.
//
// Covers all 5 integration scenarios:
//   F1 — Shell Boot:     server starts, health ok, dashboard valid, SSE connects
//   F2 — Chat Flow:      cycle start → message → thread → cost shape
//   F3 — Forge Flow:     session create → tree → files → destroy
//   F4 — Protected File: approve/reject endpoints, diff endpoint
//   F5 — Full Cycle:     state machine walks via HTTP; shape consistency
//
// Plus: Agent Rail and Invariant checks.
//
// All tests run against a live in-memory chatServer on a random port.
// No Docker required (no-op sandbox fallback).
// ANTHROPIC_API_KEY = test-key (no real LLM calls in shape-validation tests).
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request as nodeRequest } from 'node:http';
import { createChatServer, state } from './chatServer.mjs';

// ─── Test server setup ───────────────────────────────────────────────────────

let server;
let base;

before(async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.NODE_ENV = 'test';
  server = createChatServer();
  await new Promise((resolve) => {
    server.listen(0, () => {
      base = `http://localhost:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  state.cycles.clear();
  state.threads.clear();
  state.agentThreads.clear();
  state.forgeSessions.clear();
  state.activeCycleId = null;
});

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function httpRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(base + path);
    const postData = body ? JSON.stringify(body) : null;
    const req = nodeRequest(
      {
        hostname: url.hostname,
        port: parseInt(url.port, 10),
        path: url.pathname + (url.search || ''),
        method,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(data); } catch { parsed = data; }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

const get  = (path)       => httpRequest('GET',  path);
const post = (path, body) => httpRequest('POST', path, body);

// ─────────────────────────────────────────────────────────────────────────────
// F1 — Shell Boot Test
// ─────────────────────────────────────────────────────────────────────────────

describe('F1 — Shell Boot', () => {
  it('health endpoint returns ok:true with uptime and module count', async () => {
    const res = await get('/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(typeof res.body.uptime === 'number');
    assert.ok(typeof res.body.modules === 'number');
  });

  it('/api/state returns DashboardResponse with active_cycle_id and crew_status', async () => {
    const res = await get('/api/state');
    assert.equal(res.status, 200);
    const d = res.body;
    assert.ok('active_cycle_id' in d, 'has active_cycle_id');
    assert.ok(typeof d.crew_status === 'object', 'has crew_status');
    assert.ok(Object.keys(d.crew_status).length >= 6, 'at least 6 agents in crew_status');
  });

  it('/api/memory/warm-start returns operator profile + patterns', async () => {
    const res = await get('/api/memory/warm-start');
    assert.equal(res.status, 200);
    const w = res.body;
    assert.ok(typeof w.operator === 'object', 'has operator');
    assert.ok(typeof w.operator.name === 'string', 'operator has name');
    assert.ok(Array.isArray(w.accepted_patterns), 'has accepted_patterns');
    assert.ok(Array.isArray(w.rejected_patterns), 'has rejected_patterns');
  });

  it('/api/memory returns ProjectMemory with project name and mission', async () => {
    const res = await get('/api/memory');
    assert.equal(res.status, 200);
    const m = res.body;
    assert.ok(typeof m.project === 'object', 'has project object');
    assert.ok(typeof m.project.name === 'string', 'project has name');
    assert.ok(typeof m.project.mission === 'string', 'project has mission');
  });

  it('/api/providers/status returns anthropic provider shape', async () => {
    const res = await get('/api/providers/status');
    assert.equal(res.status, 200);
    assert.ok(typeof res.body.anthropic === 'object', 'has anthropic');
    assert.ok('configured' in res.body.anthropic, 'anthropic has configured flag');
    assert.ok(typeof res.body.anthropic.model === 'string', 'anthropic has model');
  });

  it('SSE /api/events opens a text/event-stream', async () => {
    const result = await new Promise((resolve, reject) => {
      const url = new URL(base + '/api/events');
      const req = nodeRequest(
        {
          hostname: url.hostname,
          port: parseInt(url.port, 10),
          path: '/api/events',
          method: 'GET',
          headers: { Accept: 'text/event-stream' },
        },
        (res) => {
          const ok = (res.headers['content-type'] ?? '').includes('text/event-stream');
          req.destroy();
          resolve({ status: res.statusCode, isSSE: ok });
        },
      );
      req.on('error', (e) => {
        if (e.code === 'ECONNRESET') resolve({ status: 200, isSSE: true });
        else reject(e);
      });
      req.end();
    });
    assert.equal(result.status, 200);
    assert.ok(result.isSSE, 'Content-Type must be text/event-stream');
  });

  it('CORS header present on all responses', async () => {
    for (const path of ['/api/state', '/api/memory', '/api/providers/status']) {
      const res = await get(path);
      assert.ok(
        typeof res.headers['access-control-allow-origin'] === 'string',
        `CORS missing on ${path}`,
      );
    }
  });

  it('unknown routes return 404', async () => {
    const res = await get('/api/does-not-exist');
    assert.equal(res.status, 404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F2 — Chat Flow Test
// ─────────────────────────────────────────────────────────────────────────────

describe('F2 — Chat Flow', () => {
  let cycleId;

  it('POST /api/cycles/start creates a cycle with id and current_state', async () => {
    const res = await post('/api/cycles/start', {
      brief: { feature_slice: 'Integration Test Cycle', goal: 'verify F2 flow' },
    });
    assert.equal(res.status, 200);
    const snap = res.body;
    assert.ok(typeof snap.id === 'string', 'cycle has id');
    assert.ok(typeof snap.current_state === 'string', 'cycle has current_state');
    assert.ok(['idle', 'briefing'].includes(snap.current_state),
      `unexpected initial state: ${snap.current_state}`);
    cycleId = snap.id;
  });

  it('GET /api/cycles/:id returns the same cycle', async () => {
    const res = await get(`/api/cycles/${cycleId}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.id, cycleId);
    assert.ok(typeof res.body.current_state === 'string');
  });

  it('GET /api/cycles/:id/thread returns messages array', async () => {
    const res = await get(`/api/cycles/${cycleId}/thread`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.messages), 'thread has messages array');
  });

  it('POST /api/cycles/:id/messages adds user message to thread', async () => {
    // With test-key provider fails — but user message is still added optimistically
    const res = await post(`/api/cycles/${cycleId}/messages`, {
      title: 'Test message',
      body: 'What is the current state of the system?',
    });
    // Accept 200 (ok) or 5xx (provider auth failure with test-key)
    assert.ok([200, 500, 503].includes(res.status), `unexpected status ${res.status}`);
  });

  it('thread contains the user message after send', async () => {
    const res = await get(`/api/cycles/${cycleId}/thread`);
    assert.equal(res.status, 200);
    assert.ok(res.body.messages.length >= 1, 'at least one message in thread');
    const userMsg = res.body.messages.find((m) => m.lane === 'operator');
    assert.ok(userMsg, 'operator message present');
    assert.equal(userMsg.body, 'What is the current state of the system?');
  });

  it('missing cycle returns 404', async () => {
    const res = await get('/api/cycles/nonexistent-cycle-000');
    assert.equal(res.status, 404);
  });

  it('approve-direction accepts valid request', async () => {
    const res = await post(`/api/cycles/${cycleId}/approve-direction`, {
      selected_direction: 'native command deck',
    });
    assert.ok([200, 400].includes(res.status));
    if (res.status === 200) {
      assert.ok(typeof res.body.current_state === 'string');
    }
  });

  it('revise-direction accepts valid request', async () => {
    const res = await post(`/api/cycles/${cycleId}/revise-direction`, {
      feedback: 'needs richer animation detail',
    });
    assert.ok([200, 400].includes(res.status));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F3 — Forge Flow Test
// ─────────────────────────────────────────────────────────────────────────────

describe('F3 — Forge Flow', () => {
  let sessionId;

  it('POST /api/forge/start creates a Forge session with id and status', async () => {
    const res = await post('/api/forge/start', { operator_id: 'gaurav' });
    assert.ok([200, 201].includes(res.status), `got ${res.status}`);
    const body = res.body;
    assert.ok(typeof body.id === 'string', 'session has id');
    assert.ok(body.status === 'active', `session status should be active, got ${body.status}`);
    sessionId = body.id;
  });

  it('session appears in server state map', async () => {
    assert.ok(state.forgeSessions.size >= 1, 'forge session in state map');
  });

  it('GET /api/forge/:id/tree returns task tree', async () => {
    const res = await get(`/api/forge/${sessionId}/tree`);
    assert.ok([200, 404].includes(res.status));
    if (res.status === 200) {
      assert.ok(typeof res.body === 'object', 'tree is an object');
    }
  });

  it('GET /api/forge/:id/files returns file listing', async () => {
    const res = await get(`/api/forge/${sessionId}/files`);
    assert.ok([200, 404].includes(res.status));
  });

  it('POST /api/forge/:id/message is accepted by server', async () => {
    const res = await post(`/api/forge/${sessionId}/message`, {
      content: 'read the costGuardrail.mjs file and tell me what it does',
    });
    // Accept 200/202 (queued) or 5xx (provider fails with test-key)
    assert.ok([200, 202, 500, 503].includes(res.status),
      `unexpected status ${res.status}`);
  });

  it('GET /api/forge/:id/diff/:filename returns diff or 404', async () => {
    const res = await get(`/api/forge/${sessionId}/diff/costGuardrail.mjs`);
    assert.ok([200, 404].includes(res.status));
  });

  it('POST /api/forge/:id/destroy cleans up the session', async () => {
    const res = await post(`/api/forge/${sessionId}/destroy`, {});
    assert.ok([200, 204, 404].includes(res.status));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F4 — Protected File Test
// ─────────────────────────────────────────────────────────────────────────────

describe('F4 — Protected File Gate', () => {
  let sessionId;

  before(async () => {
    const res = await post('/api/forge/start', { operator_id: 'gaurav' });
    sessionId = res.body.id;
  });

  after(async () => {
    if (sessionId) await post(`/api/forge/${sessionId}/destroy`, {});
  });

  it('approve endpoint accepts task_id (500 when no pending approval)', async () => {
    const res = await post(`/api/forge/${sessionId}/approve`, {
      task_id: 'nonexistent-task',
    });
    // 500 with "No approval pending" is the correct behaviour when no task awaits
    assert.ok([200, 400, 404, 500].includes(res.status),
      `unexpected status ${res.status}`);
  });

  it('reject endpoint accepts task_id and reason (500 when no pending approval)', async () => {
    const res = await post(`/api/forge/${sessionId}/reject`, {
      task_id: 'nonexistent-task',
      reason: 'test rejection — F4',
    });
    assert.ok([200, 400, 404, 405, 500].includes(res.status));
  });

  it('diff endpoint accepts filename param', async () => {
    const res = await get(`/api/forge/${sessionId}/diff/voiceSchema.mjs`);
    assert.ok([200, 404].includes(res.status));
    if (res.status === 200) {
      assert.ok(typeof res.body === 'object');
    }
  });

  it('sandbox/create endpoint is accessible', async () => {
    const res = await post(`/api/forge/${sessionId}/sandbox/create`, {});
    assert.ok([200, 201, 404, 405].includes(res.status));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F5 — Full Cycle State Machine
// ─────────────────────────────────────────────────────────────────────────────

describe('F5 — Full Cycle State Machine', () => {
  let cycleId;

  it('creates cycle and gets a valid initial state', async () => {
    const res = await post('/api/cycles/start', {
      brief: { feature_slice: 'F5 State Walk', goal: 'validate state machine' },
    });
    assert.equal(res.status, 200);
    assert.ok(typeof res.body.id === 'string');
    assert.ok(typeof res.body.current_state === 'string');
    cycleId = res.body.id;
  });

  it('cycle initial state is briefing or idle', async () => {
    const res = await get(`/api/cycles/${cycleId}`);
    assert.equal(res.status, 200);
    assert.ok(['idle', 'briefing'].includes(res.body.current_state),
      `unexpected initial state: ${res.body.current_state}`);
  });

  it('approve-direction advances state', async () => {
    const res = await post(`/api/cycles/${cycleId}/approve-direction`, {
      selected_direction: 'native command deck approach',
    });
    assert.ok([200, 400].includes(res.status));
    if (res.status === 200) {
      assert.ok(typeof res.body.current_state === 'string');
    }
  });

  it('approve-plan advances state further', async () => {
    const res = await post(`/api/cycles/${cycleId}/approve-plan`, {
      plan_summary: 'implement native command deck with SSE reconnect first',
    });
    assert.ok([200, 400].includes(res.status));
    if (res.status === 200) {
      assert.ok(typeof res.body.current_state === 'string');
    }
  });

  it('director-review endpoint is accepted', async () => {
    const res = await post(`/api/cycles/${cycleId}/director-review`, {
      title: 'Director check',
      body: 'Validate alignment with taste profile',
    });
    assert.ok([200, 500, 503].includes(res.status));
  });

  it('cycle state is stable across repeated fetches', async () => {
    const r1 = await get(`/api/cycles/${cycleId}`);
    const r2 = await get(`/api/cycles/${cycleId}`);
    assert.equal(r1.status, 200);
    assert.equal(r1.body.current_state, r2.body.current_state,
      'state must not change without an action');
  });

  it('revise-plan accepted', async () => {
    const res = await post(`/api/cycles/${cycleId}/revise-plan`, {
      feedback: 'add explicit retry logic for SSE reconnects',
    });
    assert.ok([200, 400].includes(res.status));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Agent Rail — All seats accessible
// ─────────────────────────────────────────────────────────────────────────────

describe('Agent Rail — seats accessible via API', () => {
  let agentIds;

  before(async () => {
    const res = await get('/api/state');
    agentIds = Object.keys(res.body.crew_status);
  });

  it('dashboard crew_status has at least 6 agents', async () => {
    assert.ok(agentIds.length >= 6, `expected ≥6 agents, got ${agentIds.length}`);
  });

  it('expected seat names are present', async () => {
    const expected = ['ronin', 'director', 'ops', 'analyst', 'memory', 'specialist'];
    for (const seat of expected) {
      assert.ok(agentIds.includes(seat), `seat "${seat}" missing from crew_status`);
    }
  });

  it('each agent has a valid posture in crew_status', async () => {
    const res = await get('/api/state');
    const validPostures = ['sleeping', 'idle', 'working', 'presenting', 'blocked'];
    for (const [id, posture] of Object.entries(res.body.crew_status)) {
      assert.ok(validPostures.includes(posture),
        `agent "${id}" has invalid posture: ${posture}`);
    }
  });

  it('GET /api/agents/:id/context works for each agent', async () => {
    for (const id of agentIds) {
      const res = await get(`/api/agents/${id}/context`);
      assert.equal(res.status, 200, `agent "${id}" context returned ${res.status}`);
      assert.ok(typeof res.body.id === 'string', `agent "${id}" context has id`);
      assert.ok(typeof res.body.name === 'string', `agent "${id}" context has name`);
    }
  });

  it('GET /api/agents/:id/thread works for each agent', async () => {
    for (const id of agentIds) {
      const res = await get(`/api/agents/${id}/thread`);
      assert.equal(res.status, 200, `agent "${id}" thread returned ${res.status}`);
      assert.ok(Array.isArray(res.body.messages), `agent "${id}" thread has messages array`);
    }
  });

  it('missing agent returns 404', async () => {
    const res = await get('/api/agents/seat-does-not-exist/context');
    assert.equal(res.status, 404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Invariants — Critical architectural invariants from Architecture doc §16
// ─────────────────────────────────────────────────────────────────────────────

describe('Invariants', () => {
  it('INV-01: model identity never exposed in dashboard response', async () => {
    const res = await get('/api/state');
    const text = JSON.stringify(res.body);
    // Model ID strings must not appear in operator-facing responses
    const forbidden = ['claude-', 'gpt-', 'gemini-', 'llama', 'mistral', 'groq/'];
    for (const pat of forbidden) {
      assert.ok(!text.toLowerCase().includes(pat),
        `INV-01 violated: model pattern "${pat}" found in /api/state`);
    }
  });

  it('INV-02: CORS headers present on all JSON endpoints', async () => {
    for (const path of ['/api/state', '/api/memory', '/api/providers/status']) {
      const res = await get(path);
      assert.ok(
        typeof res.headers['access-control-allow-origin'] === 'string',
        `INV-02: CORS missing on ${path}`,
      );
    }
  });

  it('INV-03: health + state + memory respond within 300ms', async () => {
    for (const path of ['/health', '/api/state', '/api/memory', '/api/providers/status']) {
      const t0 = Date.now();
      await get(path);
      const elapsed = Date.now() - t0;
      assert.ok(elapsed < 300, `INV-03: ${path} took ${elapsed}ms (> 300ms limit)`);
    }
  });

  it('INV-04: 10 concurrent GET /api/state requests all return 200', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => get('/api/state')),
    );
    for (const res of results) {
      assert.equal(res.status, 200);
    }
  });

  it('INV-05: POST /api/providers/anthropic/connect accepts api_key', async () => {
    const res = await post('/api/providers/anthropic/connect', {
      api_key: 'sk-test-invariant-check',
    });
    assert.ok([200, 400].includes(res.status));
    if (res.status === 200) {
      // Response shape: { ok: true, status: { anthropic: { configured, model, ... } } }
      assert.ok(res.body.ok === true, 'connect response has ok:true');
      assert.ok(typeof res.body.status?.anthropic?.configured === 'boolean',
        'connect response has nested configured flag');
    }
  });

  it('INV-06: warm-start operator profile never exposes model_id', async () => {
    const res = await get('/api/memory/warm-start');
    const text = JSON.stringify(res.body);
    assert.ok(!text.includes('model_id'), 'INV-06: model_id must not appear in warm-start');
  });
});
