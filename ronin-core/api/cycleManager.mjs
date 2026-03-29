// ─── api/cycleManager.mjs ────────────────────────────────────────────────────
// Phase 11D — Cycle Lifecycle State Machine
//
// Manages the 10-state workflow: idle → briefing → creative → dialogue →
// direction_review → architecture → plan_review → execution →
// integration_review → complete, plus blocked (re-entrant from any state).
//
// Each state carries:
//   - transitions: valid next states
//   - requiredInputs: what the operator must provide to enter
//   - sideEffects: which workers/gates fire on entry
//   - sseEvent: event name broadcast on entry
//
// Usage:
//   const manager = createCycleManager(broadcastFn);
//   const cycle   = manager.create({ feature_slice: 'Auth', goal: '...' });
//   manager.transition(cycle.id, 'creative', 'Brief submitted');
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto';

// ─── State Machine Definition ────────────────────────────────────────────────

export const CYCLE_STATES = {
  idle: {
    transitions: ['briefing'],
    requiredInputs: [],
    sideEffects: [],
    sseEvent: 'cycle.idle',
    label: 'Idle',
    description: 'No active work. Waiting for operator to start a cycle.',
  },
  briefing: {
    transitions: ['creative', 'blocked'],
    requiredInputs: ['feature_slice', 'goal'],
    sideEffects: ['operatorProfile.learn'],
    sseEvent: 'cycle.briefing',
    label: 'Briefing',
    description: 'Operator is defining the feature slice and goal.',
  },
  creative: {
    transitions: ['dialogue', 'direction_review', 'blocked'],
    requiredInputs: [],
    sideEffects: ['gates.parallelDirections'],
    sseEvent: 'cycle.creative',
    label: 'Creative',
    description: 'Parallel direction workers generating options (CB + RS + Hybrid).',
  },
  dialogue: {
    transitions: ['direction_review', 'creative', 'blocked'],
    requiredInputs: ['operator_message'],
    sideEffects: ['runTask.chat'],
    sseEvent: 'cycle.dialogue',
    label: 'Dialogue',
    description: 'Operator and RONIN iterating on directions.',
  },
  direction_review: {
    transitions: ['architecture', 'creative', 'blocked'],
    requiredInputs: ['direction_choice'],
    sideEffects: ['director.brief'],
    sseEvent: 'cycle.direction_review',
    label: 'Direction Review',
    description: 'Operator reviewing creative directions. Director may be consulted.',
  },
  architecture: {
    transitions: ['plan_review', 'blocked'],
    requiredInputs: [],
    sideEffects: ['gates.skillLoadedPlanning', 'gates.visionPipeline'],
    sseEvent: 'cycle.architecture',
    label: 'Architecture',
    description: 'Skill-loaded planning with domain detection and vision analysis.',
  },
  plan_review: {
    transitions: ['execution', 'architecture', 'blocked'],
    requiredInputs: ['plan_approval'],
    sideEffects: ['director.planBrief'],
    sseEvent: 'cycle.plan_review',
    label: 'Plan Review',
    description: 'Operator reviewing the architecture plan. May revise or approve.',
  },
  execution: {
    transitions: ['integration_review', 'blocked'],
    requiredInputs: [],
    sideEffects: ['gates.sandboxedImplementation', 'gates.durableBuild'],
    sseEvent: 'cycle.execution',
    label: 'Execution',
    description: 'Codex workers executing task manifest in sandbox containers.',
  },
  integration_review: {
    transitions: ['complete', 'execution', 'blocked'],
    requiredInputs: ['integration_sign_off'],
    sideEffects: ['gates.parallelReview', 'gates.deployVerify'],
    sseEvent: 'cycle.integration_review',
    label: 'Integration Review',
    description: '5-reviewer parallel gate: lint, type check, visual regression, a11y, taste.',
  },
  complete: {
    transitions: ['idle'],
    requiredInputs: [],
    sideEffects: ['memoryManager.consolidate', 'tasteCapture.flush'],
    sseEvent: 'cycle.complete',
    label: 'Complete',
    description: 'Cycle finished. Memory consolidated. Taste signals captured.',
  },
  blocked: {
    transitions: ['idle', 'briefing', 'creative', 'direction_review', 'architecture', 'plan_review', 'execution'],
    requiredInputs: ['unblock_reason'],
    sideEffects: [],
    sseEvent: 'cycle.blocked',
    label: 'Blocked',
    description: 'Cycle is blocked. Operator must resolve before continuing.',
  },
};

// Shorthand for fast lookup of allowed transitions
export const CYCLE_TRANSITIONS = Object.fromEntries(
  Object.entries(CYCLE_STATES).map(([state, def]) => [state, def.transitions])
);

// ─── Cycle Factory ───────────────────────────────────────────────────────────

function createCycleSnapshot(brief = {}, mode = 'hybrid') {
  const id = randomUUID();
  const now = new Date().toISOString();
  return {
    id,
    mode,
    brief: {
      feature_slice: brief.feature_slice ?? 'Untitled',
      goal: brief.goal ?? '',
      user_audience: brief.user_audience ?? null,
      decision_pressure: brief.decision_pressure ?? null,
    },
    current_state: 'briefing',
    history: [
      { state: 'briefing', at: now, reason: 'Cycle started' },
    ],
    created_at: now,
    updated_at: now,
  };
}

// ─── Cycle Manager Factory ───────────────────────────────────────────────────
// createCycleManager(broadcastFn?) → manager
//
// broadcastFn is optional — if omitted, SSE events are silently dropped.
// This makes the manager fully testable without a running HTTP server.

export function createCycleManager(broadcastFn = null) {
  const cycles = new Map();

  function broadcast(event, payload) {
    if (typeof broadcastFn === 'function') {
      try {
        broadcastFn(event, typeof payload === 'string' ? payload : JSON.stringify(payload));
      } catch {
        // swallow — broadcast errors must not break cycle logic
      }
    }
  }

  return {
    // ── create ────────────────────────────────────────────────────────────────
    // Creates a new cycle in `briefing` state and broadcasts cycle.started.
    create(brief = {}, mode = 'hybrid') {
      const cycle = createCycleSnapshot(brief, mode);
      cycles.set(cycle.id, cycle);
      broadcast('cycle.started', { cycle_id: cycle.id, state: cycle.current_state });
      return { ...cycle };
    },

    // ── get ───────────────────────────────────────────────────────────────────
    get(cycleId) {
      const cycle = cycles.get(cycleId);
      return cycle ? { ...cycle, history: [...cycle.history] } : null;
    },

    // ── list ──────────────────────────────────────────────────────────────────
    list() {
      return [...cycles.values()].map(c => ({ ...c, history: [...c.history] }));
    },

    // ── transition ────────────────────────────────────────────────────────────
    // Advances cycle to newState if the transition is valid.
    // Returns updated CycleSnapshot on success, null on invalid transition.
    transition(cycleId, newState, reason = '') {
      const cycle = cycles.get(cycleId);
      if (!cycle) return null;

      const allowed = CYCLE_TRANSITIONS[cycle.current_state];
      if (!allowed || !allowed.includes(newState)) return null;
      if (!CYCLE_STATES[newState]) return null;

      const now = new Date().toISOString();
      cycle.current_state = newState;
      cycle.updated_at = now;
      cycle.history.push({ state: newState, at: now, reason });

      const stateDef = CYCLE_STATES[newState];
      broadcast(stateDef.sseEvent, {
        cycle_id: cycleId,
        new_state: newState,
        reason,
        side_effects: stateDef.sideEffects,
      });

      return { ...cycle, history: [...cycle.history] };
    },

    // ── block ─────────────────────────────────────────────────────────────────
    // Moves cycle into blocked state from any state.
    block(cycleId, reason = 'Blocked') {
      const cycle = cycles.get(cycleId);
      if (!cycle) return null;
      if (cycle.current_state === 'blocked') return { ...cycle, history: [...cycle.history] };

      const now = new Date().toISOString();
      cycle._pre_blocked_state = cycle.current_state;
      cycle.current_state = 'blocked';
      cycle.updated_at = now;
      cycle.history.push({ state: 'blocked', at: now, reason });

      broadcast('cycle.blocked', { cycle_id: cycleId, reason, from_state: cycle._pre_blocked_state });

      return { ...cycle, history: [...cycle.history] };
    },

    // ── unblock ───────────────────────────────────────────────────────────────
    // Restores cycle to its pre-block state (or a specified target state).
    unblock(cycleId, targetState = null, reason = 'Unblocked') {
      const cycle = cycles.get(cycleId);
      if (!cycle) return null;
      if (cycle.current_state !== 'blocked') return null;

      const restoreState = targetState ?? cycle._pre_blocked_state ?? 'briefing';
      const allowed = CYCLE_TRANSITIONS['blocked'];
      if (!allowed.includes(restoreState)) return null;

      const now = new Date().toISOString();
      cycle.current_state = restoreState;
      cycle.updated_at = now;
      cycle.history.push({ state: restoreState, at: now, reason });
      delete cycle._pre_blocked_state;

      const stateDef = CYCLE_STATES[restoreState];
      broadcast(stateDef.sseEvent, { cycle_id: cycleId, new_state: restoreState, reason });

      return { ...cycle, history: [...cycle.history] };
    },

    // ── complete ──────────────────────────────────────────────────────────────
    // Shortcut to move cycle to complete state from integration_review.
    complete(cycleId, reason = 'Cycle complete') {
      return this.transition(cycleId, 'complete', reason);
    },

    // ── reset ─────────────────────────────────────────────────────────────────
    // Moves cycle back to idle (only from complete).
    reset(cycleId, reason = 'Cycle reset') {
      return this.transition(cycleId, 'idle', reason);
    },

    // ── destroy ───────────────────────────────────────────────────────────────
    // Removes cycle from store.
    destroy(cycleId) {
      if (!cycles.has(cycleId)) return false;
      cycles.delete(cycleId);
      broadcast('cycle.destroyed', { cycle_id: cycleId });
      return true;
    },

    // ── stateInfo ─────────────────────────────────────────────────────────────
    // Returns metadata for a given state (or current cycle state).
    stateInfo(stateOrCycleId) {
      // If it looks like a UUID, get the cycle's current state
      const cycle = cycles.get(stateOrCycleId);
      const stateName = cycle ? cycle.current_state : stateOrCycleId;
      return CYCLE_STATES[stateName] ?? null;
    },

    // ── canTransition ─────────────────────────────────────────────────────────
    canTransition(cycleId, newState) {
      const cycle = cycles.get(cycleId);
      if (!cycle) return false;
      const allowed = CYCLE_TRANSITIONS[cycle.current_state];
      return Boolean(allowed && allowed.includes(newState));
    },

    // ── size (testing helper) ─────────────────────────────────────────────────
    get size() {
      return cycles.size;
    },

    // ── clear (testing helper) ────────────────────────────────────────────────
    clear() {
      cycles.clear();
    },
  };
}
