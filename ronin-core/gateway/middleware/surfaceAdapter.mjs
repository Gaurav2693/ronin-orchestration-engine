// ─── gateway/middleware/surfaceAdapter.mjs ────────────────────────────────────
// RONIN Middleware #1 — Surface Adapter (G3)
//
// Purpose: FIRST in the 13-middleware chain. Reads device capabilities from
// the Device Registry and annotates the request so every downstream middleware
// knows what the target surface can render.
//
// What it does:
//   1. Looks up device capabilities from the registry
//   2. Attaches a `surface` context object to the request
//   3. Sets rendering constraints: max_length, artifacts_enabled, voice_markup
//   4. Strips artifact expectations for low-fidelity surfaces
//   5. Normalizes the request so downstream middleware sees a clean contract
//
// The Surface Adapter and Response Formatter (#13) are bookends:
//   Adapter reads capabilities → enriches request
//   Formatter reads capabilities → formats response
//
// Invariants:
//   - If device not found in registry, fall back to minimal capabilities (CLI-like)
//   - fidelity < 50 → artifacts disabled
//   - fidelity < 30 → response length capped at 500 tokens
//   - KAGE platform → voice_markup flag set
//   - watchOS platform → response length capped at 100 tokens
//   - Adapter NEVER modifies the original message content
// ─────────────────────────────────────────────────────────────────────────────

// ─── Constants ───────────────────────────────────────────────────────────────

export const FIDELITY_THRESHOLDS = Object.freeze({
  ARTIFACTS_MIN: 50,     // fidelity >= 50 to render artifacts
  SHORT_RESPONSE: 30,    // fidelity < 30 → capped response
  MINIMAL_RESPONSE: 15,  // fidelity < 15 → ultra-short
});

export const TOKEN_LIMITS = Object.freeze({
  FULL: null,         // no limit
  SHORT: 500,         // CLI, KAGE
  MINIMAL: 100,       // watchOS
  AMBIENT: 50,        // ambient display — status only
});

const FALLBACK_CAPABILITIES = Object.freeze({
  platform: 'unknown',
  has_voice: false,
  has_screen: true,
  has_artifacts: false,
  has_haptics: false,
  fidelity_score: 0,
});

// ─── Surface Context Builder ─────────────────────────────────────────────────

export function buildSurfaceContext(capabilities) {
  const caps = capabilities || FALLBACK_CAPABILITIES;
  const fidelity = caps.fidelity_score ?? 0;
  const platform = (caps.platform || 'unknown').toLowerCase();

  // Determine rendering constraints
  const artifacts_enabled = fidelity >= FIDELITY_THRESHOLDS.ARTIFACTS_MIN && caps.has_artifacts !== false;

  let max_tokens = TOKEN_LIMITS.FULL;
  if (platform === 'ambient') {
    max_tokens = TOKEN_LIMITS.AMBIENT;
  } else if (platform === 'watchos') {
    max_tokens = TOKEN_LIMITS.MINIMAL;
  } else if (fidelity < FIDELITY_THRESHOLDS.SHORT_RESPONSE) {
    max_tokens = TOKEN_LIMITS.SHORT;
  }

  const voice_markup = caps.has_voice === true && (platform === 'kage' || platform === 'watchos');
  const haptic_feedback = caps.has_haptics === true;

  // Determine response mode
  let response_mode = 'full'; // full markdown + artifacts
  if (platform === 'ambient') {
    response_mode = 'status';
  } else if (fidelity <= FIDELITY_THRESHOLDS.MINIMAL_RESPONSE) {
    response_mode = 'minimal';
  } else if (!artifacts_enabled) {
    response_mode = 'text';
  }

  return {
    platform,
    fidelity,
    artifacts_enabled,
    max_tokens,
    voice_markup,
    haptic_feedback,
    response_mode,
    capabilities: { ...caps },
  };
}

// ─── Middleware Factory ──────────────────────────────────────────────────────

export function createSurfaceAdapter(registry) {
  if (!registry) {
    throw new Error('Surface adapter requires a device registry');
  }

  return function surfaceAdapter(request, next) {
    const deviceId = request?.device_id;

    // Look up capabilities from registry
    let capabilities = null;
    if (deviceId) {
      capabilities = registry.getDeviceCapabilities(deviceId);
    }

    // Build surface context
    const surface = buildSurfaceContext(capabilities);

    // Enrich request with surface context (do NOT modify original message)
    const enrichedRequest = {
      ...request,
      surface,
    };

    // If next middleware exists, pass enriched request forward
    if (typeof next === 'function') {
      return next(enrichedRequest);
    }

    return enrichedRequest;
  };
}

// ─── Utility: Check if a request needs artifact stripping ────────────────────

export function shouldStripArtifacts(surfaceContext) {
  return !surfaceContext?.artifacts_enabled;
}

export function shouldAddVoiceMarkup(surfaceContext) {
  return surfaceContext?.voice_markup === true;
}

export function getMaxTokens(surfaceContext) {
  return surfaceContext?.max_tokens ?? TOKEN_LIMITS.FULL;
}

export function getResponseMode(surfaceContext) {
  return surfaceContext?.response_mode ?? 'full';
}
