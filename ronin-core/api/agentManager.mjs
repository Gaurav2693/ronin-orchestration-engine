// ─── api/agentManager.mjs ────────────────────────────────────────────────────
// Phase 11D — Agent Seat Manager
//
// Manages the 8 named agent seats (RONIN's crew). Each seat has:
//   - Identity: id, name, role, voice_profile, essence, strengths, anti_patterns
//   - Posture: sleeping | idle | working | presenting | blocked
//   - Thread: conversation history (array of messages)
//   - Context: what they're currently responsible for
//
// Agents are singletons. Posture changes emit SSE events.
// Interpreter (Seat 7) and Reviewer (Seat 8) are added here — they were
// absent from the original chatServer seed list.
//
// Usage:
//   const manager = createAgentManager(broadcastFn);
//   manager.updatePosture('director', 'presenting', 'Director review active');
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto';

// ─── Posture Types ────────────────────────────────────────────────────────────

export const AGENT_POSTURES = ['sleeping', 'idle', 'working', 'presenting', 'blocked'];

// ─── Agent Seat Definitions ───────────────────────────────────────────────────
// All 8 named seats in canonical order.

export const AGENT_SEEDS = [
  // Seat 1 — Core
  {
    id: 'ronin',
    name: 'RONIN',
    role: 'Core',
    seat: 1,
    voice_profile: { tone: 'direct', humor: 'dry', conversation_style: 'concise' },
    essence: 'Primary intelligence. Routes every request through the cheapest viable path.',
    strengths: ['routing', 'synthesis', 'cost optimization', 'voice consistency'],
    anti_patterns: ['verbose filler', 'unsolicited caveats', 'model identity exposure'],
    posture: 'idle',
    current_responsibility: 'Awaiting operator input',
    summary: 'Core seat. All operator-facing responses flow through RONIN voice.',
  },
  // Seat 2 — Director
  {
    id: 'director',
    name: 'Dead Shifu',
    role: 'Director',
    seat: 2,
    voice_profile: { tone: 'authoritative', humor: 'none', conversation_style: 'consultant' },
    essence: 'Opus-level review. Activated only on /director command or operator-triggered review.',
    strengths: ['architectural critique', 'taste alignment', 'strategic direction'],
    anti_patterns: ['auto-triggering', 'overriding operator decisions', 'casual tone'],
    posture: 'sleeping',
    current_responsibility: 'On standby. Activated by /director or direction review.',
    summary: 'Director seat. Consultant voice. Never auto-triggered.',
  },
  // Seat 3 — Ops
  {
    id: 'ops',
    name: 'Diamond',
    role: 'Ops',
    seat: 3,
    voice_profile: { tone: 'terse', humor: 'none', conversation_style: 'minimal' },
    essence: 'Free-tier classification and compression. Never produces operator-visible output.',
    strengths: ['task classification', 'context compression', 'quick routing'],
    anti_patterns: ['producing visible output', 'spending money', 'slow responses'],
    posture: 'idle',
    current_responsibility: 'Background classification and compression.',
    summary: 'Ops seat. Invisible. Free tier only.',
  },
  // Seat 4 — Analyst
  {
    id: 'analyst',
    name: 'Somani',
    role: 'Analyst',
    seat: 4,
    voice_profile: { tone: 'analytical', humor: 'none', conversation_style: 'structured' },
    essence: 'Background analysis. File trees, test scaffolds, research. Never operator-visible.',
    strengths: ['file analysis', 'test generation', 'background research'],
    anti_patterns: ['producing visible output', 'slow blocking calls'],
    posture: 'idle',
    current_responsibility: 'Background analysis tasks.',
    summary: 'Analyst seat. Invisible. Free tier.',
  },
  // Seat 5 — Memory
  {
    id: 'memory',
    name: 'Koshi',
    role: 'Memory',
    seat: 5,
    voice_profile: { tone: 'silent', humor: 'none', conversation_style: 'none' },
    essence: 'Embedding and retrieval. Zero cost. Never produces text output.',
    strengths: ['embedding', 'vector search', 'memory indexing'],
    anti_patterns: ['producing any output', 'text generation'],
    posture: 'idle',
    current_responsibility: 'Memory indexing and retrieval.',
    summary: 'Memory seat. Pure embedding. Zero cost.',
  },
  // Seat 6 — Specialist
  {
    id: 'specialist',
    name: 'Punk-G',
    role: 'Specialist',
    seat: 6,
    voice_profile: { tone: 'focused', humor: 'none', conversation_style: 'technical' },
    essence: 'Specialist slots activated by router. Vision, reasoning, scribing. Output feeds through RONIN voice.',
    strengths: ['vision analysis', 'deep reasoning', 'code generation'],
    anti_patterns: ['direct operator communication', 'identity exposure'],
    posture: 'sleeping',
    current_responsibility: 'Specialist slots. Activated by router signal.',
    summary: 'Specialist seat. Multiple models. Output normalized through RONIN.',
  },
  // Seat 7 — Interpreter
  {
    id: 'interpreter',
    name: 'Ananya',
    role: 'Interpreter',
    seat: 7,
    voice_profile: { tone: 'precise', humor: 'none', conversation_style: 'visual' },
    essence: 'Design intent reader. Translates Figma signals into semantic component context.',
    strengths: ['design interpretation', 'visual token extraction', 'figma bridge'],
    anti_patterns: ['guessing design intent', 'producing non-visual output', 'bypassing fidelity pipeline'],
    posture: 'sleeping',
    current_responsibility: 'Design interpreter. Activated by Figma signals.',
    summary: 'Interpreter seat. Seat 7. Design-to-code context layer.',
  },
  // Seat 8 — Reviewer
  {
    id: 'reviewer',
    name: 'Sentinel',
    role: 'Reviewer',
    seat: 8,
    voice_profile: { tone: 'critical', humor: 'none', conversation_style: 'structured' },
    essence: '6-dimension quality gate. Runs after execution. Never approves what fails taste.',
    strengths: ['quality assessment', 'lint checking', 'taste validation', 'visual regression'],
    anti_patterns: ['auto-approving', 'skipping dimensions', 'tone softening on failures'],
    posture: 'sleeping',
    current_responsibility: 'Quality gate. Activated at integration review.',
    summary: 'Reviewer seat. Seat 8. 6-dimension quality gate.',
  },
];

// ─── Agent Manager Factory ───────────────────────────────────────────────────
// createAgentManager(broadcastFn?) → manager
//
// broadcastFn is optional — omit for pure unit testing.

export function createAgentManager(broadcastFn = null) {
  const agents = new Map();
  const threads = new Map();

  // Seed all 8 agents on creation
  for (const seed of AGENT_SEEDS) {
    agents.set(seed.id, { ...seed });
    threads.set(seed.id, []);
  }

  function broadcast(event, payload) {
    if (typeof broadcastFn === 'function') {
      try {
        broadcastFn(event, typeof payload === 'string' ? payload : JSON.stringify(payload));
      } catch {
        // swallow — broadcast errors must not break agent logic
      }
    }
  }

  return {
    // ── getAgent ──────────────────────────────────────────────────────────────
    getAgent(agentId) {
      const agent = agents.get(agentId);
      return agent ? { ...agent } : null;
    },

    // ── listAgents ────────────────────────────────────────────────────────────
    listAgents() {
      return [...agents.values()].map(a => ({ ...a }));
    },

    // ── updatePosture ─────────────────────────────────────────────────────────
    // Changes an agent's posture and broadcasts agent.posture_changed.
    updatePosture(agentId, newPosture, reason = '') {
      if (!AGENT_POSTURES.includes(newPosture)) return null;
      const agent = agents.get(agentId);
      if (!agent) return null;

      const previousPosture = agent.posture;
      agent.posture = newPosture;

      broadcast('agent.posture_changed', {
        agent_id: agentId,
        agent_name: agent.name,
        previous_posture: previousPosture,
        new_posture: newPosture,
        reason,
      });

      return { ...agent };
    },

    // ── updateContext ─────────────────────────────────────────────────────────
    // Updates what the agent is currently responsible for.
    updateContext(agentId, responsibility, cycleId = null) {
      const agent = agents.get(agentId);
      if (!agent) return null;

      agent.current_responsibility = responsibility;
      if (cycleId !== null) agent.active_cycle_id = cycleId;

      broadcast('agent.context_updated', {
        agent_id: agentId,
        responsibility,
        cycle_id: cycleId,
      });

      return { ...agent };
    },

    // ── appendThread ──────────────────────────────────────────────────────────
    // Appends a message to the agent's thread.
    appendThread(agentId, message) {
      const thread = threads.get(agentId);
      if (!thread) return null;

      const entry = {
        id: randomUUID(),
        agent_id: agentId,
        created_at: new Date().toISOString(),
        ...message,
      };

      thread.push(entry);
      broadcast('agent.message_appended', { agent_id: agentId, message_id: entry.id });
      return entry;
    },

    // ── getThread ─────────────────────────────────────────────────────────────
    getThread(agentId) {
      const thread = threads.get(agentId);
      return thread ? [...thread] : null;
    },

    // ── clearThread ───────────────────────────────────────────────────────────
    clearThread(agentId) {
      if (!threads.has(agentId)) return false;
      threads.set(agentId, []);
      broadcast('agent.thread_cleared', { agent_id: agentId });
      return true;
    },

    // ── activateForCycle ──────────────────────────────────────────────────────
    // Convenience: set agent to 'working' with cycle context.
    activateForCycle(agentId, cycleId, responsibility = 'Active in cycle') {
      this.updateContext(agentId, responsibility, cycleId);
      return this.updatePosture(agentId, 'working', `Activated for cycle ${cycleId}`);
    },

    // ── deactivate ────────────────────────────────────────────────────────────
    // Sets agent back to idle/sleeping after work completes.
    deactivate(agentId, finalPosture = 'idle') {
      const agent = agents.get(agentId);
      if (!agent) return null;

      const restPosture = finalPosture === 'sleeping' ? 'sleeping' : 'idle';
      this.updateContext(agentId, restPosture === 'sleeping' ? 'On standby.' : 'Awaiting next task.');
      return this.updatePosture(agentId, restPosture, 'Work complete');
    },

    // ── crewStatus ────────────────────────────────────────────────────────────
    // Returns posture map for all agents — matches chatServer buildCrewStatus().
    crewStatus() {
      const status = {};
      for (const [id, agent] of agents) {
        status[id] = agent.posture;
      }
      return status;
    },

    // ── agentRail ─────────────────────────────────────────────────────────────
    // Returns the full agent rail payload for workspace responses.
    agentRail() {
      const agentEntries = [...agents.values()].map(a => ({
        id: a.id,
        label: a.name,
        role: a.role,
        seat: a.seat,
        posture: a.posture,
        active: a.posture === 'working' || a.posture === 'presenting',
        responsibility: a.current_responsibility,
        compact_status: a.posture === 'sleeping' ? 'ZZZ' : a.posture.toUpperCase(),
      }));

      return {
        agents: agentEntries,
        active_count: agentEntries.filter(a => a.active).length,
        summary: `${agents.size} agents registered`,
      };
    },

    // ── reset (testing helper) ────────────────────────────────────────────────
    // Reseeds all agents to their initial state.
    reset() {
      agents.clear();
      threads.clear();
      for (const seed of AGENT_SEEDS) {
        agents.set(seed.id, { ...seed });
        threads.set(seed.id, []);
      }
    },

    // ── size ──────────────────────────────────────────────────────────────────
    get size() {
      return agents.size;
    },
  };
}
