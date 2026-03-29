// ─── api/agentManager.test.mjs ───────────────────────────────────────────────
// Phase 11D — Agent Manager Tests
//
// 22 tests covering:
// - All 8 seats present and seeded correctly
// - Posture management and validation
// - Thread appending and retrieval
// - Context updates
// - SSE event emission
// - Crew status / agent rail builders
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAgentManager,
  AGENT_SEEDS,
  AGENT_POSTURES,
} from './agentManager.mjs';

let manager;
const events = [];

function captureEvents() {
  events.length = 0;
  return (event, data) => {
    events.push({ event, data: typeof data === 'string' ? JSON.parse(data) : data });
  };
}

describe('AgentManager (Phase 11D)', () => {
  // ─── Seat Definitions ─────────────────────────────────────────────────────

  describe('Seat Definitions', () => {
    it('should define exactly 8 agent seats', () => {
      assert.equal(AGENT_SEEDS.length, 8);
    });

    it('should include all expected seat roles', () => {
      const roles = AGENT_SEEDS.map(a => a.role);
      assert(roles.includes('Core'));
      assert(roles.includes('Director'));
      assert(roles.includes('Ops'));
      assert(roles.includes('Analyst'));
      assert(roles.includes('Memory'));
      assert(roles.includes('Specialist'));
      assert(roles.includes('Interpreter'));
      assert(roles.includes('Reviewer'));
    });

    it('seat numbers should be sequential 1-8', () => {
      const seats = AGENT_SEEDS.map(a => a.seat).sort((a, b) => a - b);
      assert.deepEqual(seats, [1, 2, 3, 4, 5, 6, 7, 8]);
    });

    it('each agent should have required fields', () => {
      for (const seed of AGENT_SEEDS) {
        assert(typeof seed.id === 'string', `${seed.id}.id missing`);
        assert(typeof seed.name === 'string', `${seed.id}.name missing`);
        assert(typeof seed.essence === 'string', `${seed.id}.essence missing`);
        assert(Array.isArray(seed.strengths), `${seed.id}.strengths not array`);
        assert(Array.isArray(seed.anti_patterns), `${seed.id}.anti_patterns not array`);
        assert(AGENT_POSTURES.includes(seed.posture), `${seed.id}.posture invalid`);
      }
    });
  });

  // ─── Initialization ───────────────────────────────────────────────────────

  describe('Initialization', () => {
    before(() => {
      manager = createAgentManager(captureEvents());
    });

    it('should seed all 8 agents', () => {
      assert.equal(manager.size, 8);
    });

    it('should have interpreter seat (seat 7)', () => {
      const agent = manager.getAgent('interpreter');
      assert(agent);
      assert.equal(agent.role, 'Interpreter');
      assert.equal(agent.seat, 7);
    });

    it('should have reviewer seat (seat 8)', () => {
      const agent = manager.getAgent('reviewer');
      assert(agent);
      assert.equal(agent.role, 'Reviewer');
      assert.equal(agent.seat, 8);
    });

    it('should return null for unknown agent', () => {
      assert.equal(manager.getAgent('unknown-agent'), null);
    });

    it('listAgents should return all 8', () => {
      const list = manager.listAgents();
      assert.equal(list.length, 8);
    });
  });

  // ─── Posture Management ───────────────────────────────────────────────────

  describe('Posture Management', () => {
    before(() => {
      manager = createAgentManager(captureEvents());
    });

    afterEach(() => {
      manager.reset();
      events.length = 0;
    });

    it('should update posture for a valid agent', () => {
      const updated = manager.updatePosture('director', 'presenting', 'Director review');
      assert(updated);
      assert.equal(updated.posture, 'presenting');
    });

    it('should reject invalid posture values', () => {
      const result = manager.updatePosture('director', 'flying');
      assert.equal(result, null);
      // posture should be unchanged
      assert.equal(manager.getAgent('director').posture, 'sleeping');
    });

    it('should emit agent.posture_changed SSE event', () => {
      events.length = 0;
      manager.updatePosture('ronin', 'working', 'Active task');
      const ev = events.find(e => e.event === 'agent.posture_changed');
      assert(ev);
      assert.equal(ev.data.agent_id, 'ronin');
      assert.equal(ev.data.new_posture, 'working');
      assert.equal(ev.data.previous_posture, 'idle');
    });

    it('should activate agent for a cycle', () => {
      const result = manager.activateForCycle('analyst', 'cycle-123', 'Scanning files');
      assert.equal(result.posture, 'working');
      assert.equal(manager.getAgent('analyst').active_cycle_id, 'cycle-123');
    });

    it('should deactivate agent back to idle', () => {
      manager.updatePosture('ronin', 'working');
      manager.deactivate('ronin');
      assert.equal(manager.getAgent('ronin').posture, 'idle');
    });

    it('should deactivate director back to sleeping', () => {
      manager.updatePosture('director', 'presenting');
      manager.deactivate('director', 'sleeping');
      assert.equal(manager.getAgent('director').posture, 'sleeping');
    });
  });

  // ─── Thread Management ────────────────────────────────────────────────────

  describe('Thread Management', () => {
    before(() => {
      manager = createAgentManager(captureEvents());
    });

    afterEach(() => {
      manager.reset();
      events.length = 0;
    });

    it('should append a message to thread', () => {
      const msg = manager.appendThread('ronin', {
        role: 'assistant',
        content: 'Routing to Flash-Lite.',
      });
      assert(msg.id);
      assert.equal(msg.agent_id, 'ronin');
      assert.equal(msg.role, 'assistant');
      assert.equal(msg.content, 'Routing to Flash-Lite.');
    });

    it('should retrieve thread with all messages', () => {
      manager.appendThread('ronin', { role: 'user', content: 'Hello' });
      manager.appendThread('ronin', { role: 'assistant', content: 'World' });
      const thread = manager.getThread('ronin');
      assert.equal(thread.length, 2);
    });

    it('should clear thread', () => {
      manager.appendThread('ronin', { role: 'user', content: 'x' });
      manager.clearThread('ronin');
      assert.equal(manager.getThread('ronin').length, 0);
    });

    it('should return null thread for unknown agent', () => {
      assert.equal(manager.getThread('ghost'), null);
    });

    it('should emit agent.message_appended event', () => {
      events.length = 0;
      manager.appendThread('analyst', { role: 'system', content: 'Starting analysis' });
      const ev = events.find(e => e.event === 'agent.message_appended');
      assert(ev);
      assert.equal(ev.data.agent_id, 'analyst');
    });
  });

  // ─── Crew Status & Agent Rail ─────────────────────────────────────────────

  describe('Crew Status & Agent Rail', () => {
    before(() => {
      manager = createAgentManager(captureEvents());
    });

    afterEach(() => {
      manager.reset();
      events.length = 0;
    });

    it('crewStatus should return posture map for all agents', () => {
      const status = manager.crewStatus();
      assert.equal(Object.keys(status).length, 8);
      assert(typeof status.ronin === 'string');
      assert(typeof status.director === 'string');
    });

    it('agentRail should return agents with seat and active flag', () => {
      manager.updatePosture('ronin', 'working');
      const rail = manager.agentRail();
      assert.equal(rail.agents.length, 8);
      assert.equal(rail.active_count, 1);
      const roninEntry = rail.agents.find(a => a.id === 'ronin');
      assert.equal(roninEntry.active, true);
      assert.equal(roninEntry.seat, 1);
    });

    it('should work without a broadcastFn (silent mode)', () => {
      const silentManager = createAgentManager(); // no broadcast
      const result = silentManager.updatePosture('ronin', 'working');
      assert(result);
      assert.equal(result.posture, 'working');
    });

    it('context update should emit agent.context_updated', () => {
      events.length = 0;
      manager.updateContext('memory', 'Indexing new embeddings', 'cycle-xyz');
      const ev = events.find(e => e.event === 'agent.context_updated');
      assert(ev);
      assert.equal(ev.data.agent_id, 'memory');
      assert.equal(ev.data.cycle_id, 'cycle-xyz');
    });
  });
});
