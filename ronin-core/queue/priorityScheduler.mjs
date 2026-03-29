// queue/priorityScheduler.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Priority lane router
//
// Takes a routing decision from the intelligence-router (the 'lane' field from
// a model config) and maps it to the correct BullMQ queue lane.
//
// The intelligence-router outputs a lane like 'fast', 'standard', 'specialist',
// 'director', or 'background'. This module normalizes those into the 3 actual
// queue lanes: 'live', 'standard', or 'background'.
//
// Mapping logic:
//   fast       → live       (fast models, user watching)
//   standard   → live       (default, user triggered task)
//   specialist → live       (vision/reasoning, user watching)
//   director   → live       (Opus, review/quality gate, user watching)
//   background → background (system-initiated async work)
//   (anything else) → standard (safe default)
// ─────────────────────────────────────────────────────────────────────────────

// ─── Lane Mapping ──────────────────────────────────────────────────────────
// This object defines which queue lane each router lane maps to.
// Update this map if the architecture changes the lane definitions.

const LANE_MAP = {
  'fast': 'live',
  'standard': 'live',
  'specialist': 'live',
  'director': 'live',
  'background': 'background',
};

// ─── Schedule Function ──────────────────────────────────────────────────────
// Given a routing decision (lane name from modelConfig), return the queue lane.
//
// Arguments:
//   routingLane — string from model config's 'lane' field
//
// Returns:
//   'live' | 'standard' | 'background'
//
// The function is defensive: unknown lanes default to 'standard' rather than
// throwing an error, ensuring the system always has a safe fallback.

export function schedule(routingLane) {
  // If the lane is unknown, log a warning and default to standard
  if (!LANE_MAP[routingLane]) {
    console.warn(
      `[priorityScheduler] Unknown routing lane '${routingLane}', defaulting to 'standard'`
    );
    return 'standard';
  }

  return LANE_MAP[routingLane];
}

// ─── Export Lane Map ────────────────────────────────────────────────────────
// Expose the map for testing and documentation purposes.

export { LANE_MAP };
