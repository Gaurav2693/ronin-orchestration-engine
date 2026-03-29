// ─── api/cycleManager.test.mjs ───────────────────────────────────────────────
// Phase 11D — Cycle Manager Tests
//
// 22 tests covering:
// - Cycle creation and initial state
// - Valid and invalid state transitions
// - Block/unblock behavior
// - SSE event emission
// - State machine completeness
// - Multi-cycle isolation
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCycleManager,
  CYCLE_STATES,
  CYCLE_TRANSITIONS,
} from './cycleManager.mjs';

let manager;
const events = [];

function captureEvents() {
  events.length = 0;
  return (event, data) => {
    events.push({ event, data: typeof data === 'string' ? JSON.parse(data) : data });
  };
}

describe('CycleManager (Phase 11D)', () => {
  // ─── State Machine Definition ─────────────────────────────────────────────

  describe('State Machine Definition', () => {
    it('should define all 11 states', () => {
      const states = Object.keys(CYCLE_STATES);
      assert(states.includes('idle'));
      assert(states.includes('briefing'));
      assert(states.includes('creative'));
      assert(states.includes('dialogue'));
      assert(states.includes('direction_review'));
      assert(states.includes('architecture'));
      assert(states.includes('plan_review'));
      assert(states.includes('execution'));
      assert(states.includes('integration_review'));
      assert(states.includes('complete'));
      assert(states.includes('blocked'));
    });

    it('each state should have required metadata', () => {
      for (const [name, def] of Object.entries(CYCLE_STATES)) {
        assert(Array.isArray(def.transitions), `${name}.transitions must be array`);
        assert(Array.isArray(def.requiredInputs), `${name}.requiredInputs must be array`);
        assert(Array.isArray(def.sideEffects), `${name}.sideEffects must be array`);
        assert(typeof def.sseEvent === 'string', `${name}.sseEvent must be string`);
        assert(typeof def.label === 'string', `${name}.label must be string`);
        assert(typeof def.description === 'string', `${name}.description must be string`);
      }
    });

    it('CYCLE_TRANSITIONS should match CYCLE_STATES definitions', () => {
      for (const [state, transitions] of Object.entries(CYCLE_TRANSITIONS)) {
        assert.deepEqual(transitions, CYCLE_STATES[state].transitions);
      }
    });
  });

  // ─── Cycle Creation ───────────────────────────────────────────────────────

  describe('Cycle Creation', () => {
    before(() => {
      manager = createCycleManager(captureEvents());
    });

    afterEach(() => {
      manager.clear();
      events.length = 0;
    });

    it('should create a cycle in briefing state', () => {
      const cycle = manager.create({ feature_slice: 'Auth', goal: 'OAuth login' });
      assert(cycle.id);
      assert.equal(cycle.current_state, 'briefing');
      assert.equal(cycle.brief.feature_slice, 'Auth');
      assert.equal(cycle.brief.goal, 'OAuth login');
      assert.equal(cycle.history.length, 1);
    });

    it('should emit cycle.started event on creation', () => {
      manager.create({ feature_slice: 'Test' });
      const ev = events.find(e => e.event === 'cycle.started');
      assert(ev);
      assert(ev.data.cycle_id);
      assert.equal(ev.data.state, 'briefing');
    });

    it('should default mode to hybrid', () => {
      const cycle = manager.create({ feature_slice: 'Test' });
      assert.equal(cycle.mode, 'hybrid');
    });

    it('should accept custom mode', () => {
      const cycle = manager.create({ feature_slice: 'Test' }, 'fast');
      assert.equal(cycle.mode, 'fast');
    });

    it('should be retrievable after creation', () => {
      const cycle = manager.create({ feature_slice: 'Test' });
      const retrieved = manager.get(cycle.id);
      assert.equal(retrieved.id, cycle.id);
      assert.equal(retrieved.current_state, 'briefing');
    });
  });

  // ─── State Transitions ────────────────────────────────────────────────────

  describe('State Transitions', () => {
    before(() => {
      manager = createCycleManager(captureEvents());
    });

    afterEach(() => {
      manager.clear();
      events.length = 0;
    });

    it('should transition from briefing to creative', () => {
      const cycle = manager.create({});
      const result = manager.transition(cycle.id, 'creative', 'Brief submitted');
      assert(result);
      assert.equal(result.current_state, 'creative');
      assert.equal(result.history.length, 2);
      assert.equal(result.history[1].state, 'creative');
      assert.equal(result.history[1].reason, 'Brief submitted');
    });

    it('should reject invalid transitions', () => {
      const cycle = manager.create({});
      // briefing cannot jump to execution
      const result = manager.transition(cycle.id, 'execution');
      assert.equal(result, null);
      // state should be unchanged
      assert.equal(manager.get(cycle.id).current_state, 'briefing');
    });

    it('should emit SSE event on valid transition', () => {
      const cycle = manager.create({});
      events.length = 0; // clear create event
      manager.transition(cycle.id, 'creative', 'test');
      const ev = events.find(e => e.event === 'cycle.creative');
      assert(ev);
      assert.equal(ev.data.cycle_id, cycle.id);
      assert.equal(ev.data.new_state, 'creative');
    });

    it('should walk the happy path: briefing → creative → direction_review → architecture → plan_review → execution → integration_review → complete', () => {
      const cycle = manager.create({});
      const path = ['creative', 'direction_review', 'architecture', 'plan_review', 'execution', 'integration_review', 'complete'];
      let current = cycle;
      for (const state of path) {
        current = manager.transition(current.id, state);
        assert(current, `Failed to transition to ${state}`);
        assert.equal(current.current_state, state);
      }
    });

    it('should return null for non-existent cycle', () => {
      const result = manager.transition('non-existent-id', 'creative');
      assert.equal(result, null);
    });

    it('canTransition should return true for valid next state', () => {
      const cycle = manager.create({});
      assert.equal(manager.canTransition(cycle.id, 'creative'), true);
      assert.equal(manager.canTransition(cycle.id, 'execution'), false);
    });
  });

  // ─── Block / Unblock ─────────────────────────────────────────────────────

  describe('Block / Unblock', () => {
    before(() => {
      manager = createCycleManager(captureEvents());
    });

    afterEach(() => {
      manager.clear();
      events.length = 0;
    });

    it('should block a cycle from any state', () => {
      const cycle = manager.create({});
      manager.transition(cycle.id, 'creative');

      const blocked = manager.block(cycle.id, 'API rate limited');
      assert.equal(blocked.current_state, 'blocked');
    });

    it('should store pre-blocked state for restore', () => {
      const cycle = manager.create({});
      manager.transition(cycle.id, 'creative');
      const blocked = manager.block(cycle.id);
      assert.equal(blocked._pre_blocked_state, 'creative');
    });

    it('should unblock and restore to pre-blocked state', () => {
      const cycle = manager.create({});
      manager.transition(cycle.id, 'creative');
      manager.block(cycle.id);

      const restored = manager.unblock(cycle.id, null, 'Rate limit cleared');
      assert.equal(restored.current_state, 'creative');
    });

    it('should emit cycle.blocked and cycle.creative events', () => {
      const cycle = manager.create({});
      manager.transition(cycle.id, 'creative');
      events.length = 0;

      manager.block(cycle.id, 'Blocked');
      const blockedEv = events.find(e => e.event === 'cycle.blocked');
      assert(blockedEv);

      manager.unblock(cycle.id, null, 'Fixed');
      const restoredEv = events.find(e => e.event === 'cycle.creative');
      assert(restoredEv);
    });

    it('should return null when unblocking a non-blocked cycle', () => {
      const cycle = manager.create({});
      // briefing state, not blocked
      const result = manager.unblock(cycle.id);
      assert.equal(result, null);
    });
  });

  // ─── Lifecycle & Cleanup ──────────────────────────────────────────────────

  describe('Lifecycle & Cleanup', () => {
    before(() => {
      manager = createCycleManager(captureEvents());
    });

    afterEach(() => {
      manager.clear();
      events.length = 0;
    });

    it('should list all cycles', () => {
      manager.create({ feature_slice: 'A' });
      manager.create({ feature_slice: 'B' });
      manager.create({ feature_slice: 'C' });
      const list = manager.list();
      assert.equal(list.length, 3);
    });

    it('should destroy a cycle', () => {
      const cycle = manager.create({});
      assert.equal(manager.destroy(cycle.id), true);
      assert.equal(manager.get(cycle.id), null);
    });

    it('should return false when destroying non-existent cycle', () => {
      assert.equal(manager.destroy('fake-id'), false);
    });

    it('should emit cycle.destroyed event', () => {
      const cycle = manager.create({});
      events.length = 0;
      manager.destroy(cycle.id);
      const ev = events.find(e => e.event === 'cycle.destroyed');
      assert(ev);
      assert.equal(ev.data.cycle_id, cycle.id);
    });

    it('should work without a broadcastFn (silent mode)', () => {
      const silentManager = createCycleManager(); // no broadcast
      const cycle = silentManager.create({ feature_slice: 'Silent' });
      const result = silentManager.transition(cycle.id, 'creative');
      assert(result);
      assert.equal(result.current_state, 'creative');
    });
  });
});
