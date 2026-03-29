// ─── gateway/middleware/responseFormatter.mjs ─────────────────────────────────
// RONIN Middleware #13 — Response Formatter (G4)
//
// Purpose: LAST in the 13-middleware chain. Takes the raw intelligence response
// and formats it for the target device's fidelity level. Reads the surface
// context attached by the Surface Adapter (middleware #1).
//
// Formatting modes:
//   - full: markdown + artifact refs (macOS, iOS, Web)
//   - text: plain text, no artifacts (CLI, Android)
//   - minimal: ultra-short summary (watchOS)
//   - status: single status line (ambient display)
//   - voice: SSML-wrapped for TTS (KAGE, watchOS with voice)
//
// Invariants:
//   - Model identity NEVER appears in formatted output (ADR-006)
//   - Artifact refs stripped for surfaces with artifacts_enabled === false
//   - Token limit enforced: response truncated if over max_tokens
//   - SSML wrapping only for voice_markup surfaces
//   - Original response preserved in metadata for debugging
// ─────────────────────────────────────────────────────────────────────────────

// ─── Constants ───────────────────────────────────────────────────────────────

const ARTIFACT_REF_PATTERN = /\[artifact:([^\]]+)\]\(([^)]+)\)/g;
const ARTIFACT_BLOCK_PATTERN = /```artifact\b[\s\S]*?```/g;

const TRUNCATION_SUFFIX = '…';

// ─── Formatters ──────────────────────────────────────────────────────────────

export function formatFull(response, surfaceContext) {
  // Full markdown + artifact refs. No modifications needed.
  return {
    formatted: response.content,
    artifacts: response.artifacts || [],
    suggestions: response.suggestions || [],
    format: 'full',
  };
}

export function formatText(response, surfaceContext) {
  // Strip artifact references and blocks, keep plain text
  let text = response.content || '';
  text = text.replace(ARTIFACT_BLOCK_PATTERN, '');
  text = text.replace(ARTIFACT_REF_PATTERN, '$1');

  // Clean up excess whitespace from stripped blocks
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  return {
    formatted: text,
    artifacts: [], // explicitly empty
    suggestions: response.suggestions || [],
    format: 'text',
  };
}

export function formatMinimal(response, surfaceContext) {
  // Ultra-short: first paragraph or first 100 chars
  let text = response.content || '';
  text = text.replace(ARTIFACT_BLOCK_PATTERN, '');
  text = text.replace(ARTIFACT_REF_PATTERN, '');
  text = text.replace(/\n{2,}/g, '\n').trim();

  // Take first paragraph
  const firstPara = text.split('\n')[0] || '';
  const maxLen = surfaceContext?.max_tokens ? surfaceContext.max_tokens * 4 : 400;
  const truncated = firstPara.length > maxLen
    ? firstPara.slice(0, maxLen) + TRUNCATION_SUFFIX
    : firstPara;

  return {
    formatted: truncated,
    artifacts: [],
    suggestions: [],
    format: 'minimal',
  };
}

export function formatStatus(response, surfaceContext) {
  // Single status line for ambient displays
  let text = response.content || '';
  text = text.replace(ARTIFACT_BLOCK_PATTERN, '');
  text = text.replace(ARTIFACT_REF_PATTERN, '');
  text = text.replace(/[#*_`]/g, '').trim();

  // First sentence only
  const firstSentence = text.match(/^[^.!?]*[.!?]/)?.[0] || text.slice(0, 80);
  const maxLen = surfaceContext?.max_tokens ? surfaceContext.max_tokens * 4 : 200;
  const truncated = firstSentence.length > maxLen
    ? firstSentence.slice(0, maxLen) + TRUNCATION_SUFFIX
    : firstSentence;

  return {
    formatted: truncated,
    artifacts: [],
    suggestions: [],
    format: 'status',
  };
}

export function formatVoice(response, surfaceContext) {
  // SSML-wrapped for TTS engines
  let text = response.content || '';
  text = text.replace(ARTIFACT_BLOCK_PATTERN, '');
  text = text.replace(ARTIFACT_REF_PATTERN, '$1');
  text = text.replace(/[#*_`]/g, '').trim();
  text = text.replace(/\n{2,}/g, ' ');

  // Apply token limit
  const maxLen = surfaceContext?.max_tokens ? surfaceContext.max_tokens * 4 : 2000;
  if (text.length > maxLen) {
    text = text.slice(0, maxLen) + TRUNCATION_SUFFIX;
  }

  const ssml = `<speak>${text}</speak>`;

  return {
    formatted: ssml,
    artifacts: [],
    suggestions: [],
    format: 'voice',
  };
}

// ─── Format Router ───────────────────────────────────────────────────────────

export function formatForSurface(response, surfaceContext) {
  if (!response) {
    return { formatted: '', artifacts: [], suggestions: [], format: 'text' };
  }

  // Normalize response shape
  const normalizedResponse = typeof response === 'string'
    ? { content: response, artifacts: [], suggestions: [] }
    : response;

  if (!surfaceContext) {
    // No surface context = default to text mode
    return formatText(normalizedResponse, surfaceContext);
  }

  const mode = surfaceContext.response_mode || 'text';

  // Voice markup overrides response mode for KAGE/watchOS
  if (surfaceContext.voice_markup) {
    return formatVoice(normalizedResponse, surfaceContext);
  }

  switch (mode) {
    case 'full':
      return formatFull(normalizedResponse, surfaceContext);
    case 'text':
      return formatText(normalizedResponse, surfaceContext);
    case 'minimal':
      return formatMinimal(normalizedResponse, surfaceContext);
    case 'status':
      return formatStatus(normalizedResponse, surfaceContext);
    default:
      return formatText(normalizedResponse, surfaceContext);
  }
}

// ─── Middleware Factory ──────────────────────────────────────────────────────

export function createResponseFormatter(registry) {
  return function responseFormatter(request, response) {
    const surfaceContext = request?.surface || null;

    // Format the response for the target surface
    const formatted = formatForSurface(response, surfaceContext);

    // Attach metadata for debugging (never exposed to operator)
    formatted._meta = {
      device_id: request?.device_id,
      session_id: request?.session_id,
      original_length: response?.content?.length || 0,
      formatted_length: formatted.formatted.length,
      format_applied: formatted.format,
    };

    return formatted;
  };
}

// ─── Token Enforcement ───────────────────────────────────────────────────────

export function enforceTokenLimit(text, maxTokens) {
  if (!maxTokens || maxTokens <= 0) return text;

  // Rough estimate: 1 token ≈ 4 chars
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;

  return text.slice(0, maxChars) + TRUNCATION_SUFFIX;
}
