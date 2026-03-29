// ─── gateway/auth.mjs ─────────────────────────────────────────────────────────
// RONIN Device Token Auth (G5)
//
// Purpose: Device-token authentication for the RONIN Sync protocol. The macOS
// flagship is the root of trust. All other devices authenticate via tokens
// generated from an already-authenticated device.
//
// How it works:
//   1. macOS app generates a root token at first run (or manual reset)
//   2. To add a new device: authenticated device calls generateDeviceToken()
//   3. New device presents the token at connection → validateToken()
//   4. Any authenticated device can revoke any other device's token
//   5. Tokens are opaque strings — no JWTs, no sessions, no OAuth
//
// Why not JWT/OAuth:
//   This is a personal system. One operator. No multi-tenant. No refresh tokens.
//   Device tokens are simpler, revocable, and don't expire (unless explicitly
//   revoked). The operator owns the trust chain.
//
// Invariants:
//   - Root token can only be generated once (until explicitly reset)
//   - Generated tokens are cryptographically random (32 bytes hex)
//   - Revoked tokens immediately fail validation
//   - Token→deviceId mapping is 1:1
//   - listActiveTokens never exposes the token values (security)
//
// Storage: In-memory by default. Pluggable backend for persistence.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'crypto';

// ─── Token Generation ────────────────────────────────────────────────────────

export function generateTokenString() {
  return `rtk_${crypto.randomBytes(32).toString('hex')}`;
}

// ─── Auth Store ──────────────────────────────────────────────────────────────

export function createAuthStore(options = {}) {
  // token → { device_id, created_at, created_by, label }
  const tokens = new Map();
  // device_id → token
  const deviceToToken = new Map();
  // Revoked tokens (kept for audit trail)
  const revokedTokens = new Map();

  let rootToken = null;
  let rootDeviceId = null;

  // ── Root Token ───────────────────────────────────────────────────────

  function initializeRoot(deviceId, label = 'macOS flagship') {
    if (!deviceId || typeof deviceId !== 'string') {
      throw new Error('deviceId must be a non-empty string');
    }
    if (rootToken !== null) {
      throw new Error('Root token already initialized. Call resetRoot() first.');
    }

    const token = generateTokenString();
    rootToken = token;
    rootDeviceId = deviceId;

    tokens.set(token, {
      device_id: deviceId,
      created_at: Date.now(),
      created_by: null, // self-generated
      label,
      is_root: true,
    });
    deviceToToken.set(deviceId, token);

    return { token, device_id: deviceId };
  }

  function resetRoot() {
    // Revoke everything and start fresh
    for (const [token, entry] of tokens) {
      revokedTokens.set(token, { ...entry, revoked_at: Date.now(), reason: 'root_reset' });
    }
    tokens.clear();
    deviceToToken.clear();
    rootToken = null;
    rootDeviceId = null;
  }

  function isRootInitialized() {
    return rootToken !== null;
  }

  function getRootDeviceId() {
    return rootDeviceId;
  }

  // ── Token Generation ─────────────────────────────────────────────────

  function generateDeviceToken(requestingDeviceId, newDeviceId, label = '') {
    if (!requestingDeviceId || !newDeviceId) {
      throw new Error('Both requestingDeviceId and newDeviceId are required');
    }

    // Verify the requesting device is authenticated
    if (!deviceToToken.has(requestingDeviceId)) {
      throw new Error('Requesting device is not authenticated');
    }

    // If new device already has a token, revoke the old one first
    const existingToken = deviceToToken.get(newDeviceId);
    if (existingToken) {
      _revokeTokenInternal(existingToken, 'replaced');
    }

    const token = generateTokenString();
    tokens.set(token, {
      device_id: newDeviceId,
      created_at: Date.now(),
      created_by: requestingDeviceId,
      label: label || newDeviceId,
      is_root: false,
    });
    deviceToToken.set(newDeviceId, token);

    return { token, device_id: newDeviceId };
  }

  // ── Validation ───────────────────────────────────────────────────────

  function validateToken(token) {
    if (!token || typeof token !== 'string') {
      return { valid: false, device_id: null, reason: 'Invalid token format' };
    }

    const entry = tokens.get(token);
    if (!entry) {
      // Check if it was revoked
      if (revokedTokens.has(token)) {
        return { valid: false, device_id: null, reason: 'Token has been revoked' };
      }
      return { valid: false, device_id: null, reason: 'Unknown token' };
    }

    return { valid: true, device_id: entry.device_id, is_root: entry.is_root };
  }

  // ── Revocation ───────────────────────────────────────────────────────

  function revokeToken(deviceId) {
    const token = deviceToToken.get(deviceId);
    if (!token) return false;

    return _revokeTokenInternal(token, 'manual');
  }

  function _revokeTokenInternal(token, reason) {
    const entry = tokens.get(token);
    if (!entry) return false;

    revokedTokens.set(token, { ...entry, revoked_at: Date.now(), reason });
    tokens.delete(token);
    deviceToToken.delete(entry.device_id);

    // If this was the root token, clear root state
    if (entry.is_root) {
      rootToken = null;
      rootDeviceId = null;
    }

    return true;
  }

  function revokeAllExcept(keepDeviceId) {
    const toRevoke = [];
    for (const [token, entry] of tokens) {
      if (entry.device_id !== keepDeviceId) {
        toRevoke.push(token);
      }
    }
    for (const token of toRevoke) {
      _revokeTokenInternal(token, 'bulk_revoke');
    }
    return toRevoke.length;
  }

  // ── Queries ──────────────────────────────────────────────────────────

  function listActiveTokens() {
    const result = [];
    for (const [_, entry] of tokens) {
      result.push({
        device_id: entry.device_id,
        created_at: entry.created_at,
        created_by: entry.created_by,
        label: entry.label,
        is_root: entry.is_root,
        // Token value intentionally NOT included (security)
      });
    }
    return result;
  }

  function listRevokedTokens() {
    const result = [];
    for (const [_, entry] of revokedTokens) {
      result.push({
        device_id: entry.device_id,
        revoked_at: entry.revoked_at,
        reason: entry.reason,
        label: entry.label,
      });
    }
    return result;
  }

  function getActiveDeviceCount() {
    return tokens.size;
  }

  function isDeviceAuthenticated(deviceId) {
    return deviceToToken.has(deviceId);
  }

  function getDeviceTokenInfo(deviceId) {
    const token = deviceToToken.get(deviceId);
    if (!token) return null;
    const entry = tokens.get(token);
    if (!entry) return null;
    return {
      device_id: entry.device_id,
      created_at: entry.created_at,
      created_by: entry.created_by,
      label: entry.label,
      is_root: entry.is_root,
    };
  }

  // ── Public API ─────────────────────────────────────────────────────────

  return {
    initializeRoot,
    resetRoot,
    isRootInitialized,
    getRootDeviceId,
    generateDeviceToken,
    validateToken,
    revokeToken,
    revokeAllExcept,
    listActiveTokens,
    listRevokedTokens,
    getActiveDeviceCount,
    isDeviceAuthenticated,
    getDeviceTokenInfo,
  };
}
