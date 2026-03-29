// ─── gateway/deviceRegistry.mjs ──────────────────────────────────────────────
// RONIN Device Registry (G2)
//
// Purpose: Tracks every surface that has connected to RONIN. Stores capability
// manifests, manages session membership, and answers capability queries that
// downstream middleware (Surface Adapter, Response Formatter) depends on.
//
// Every surface registers once with a capabilities manifest:
//   { platform, has_voice, has_screen, has_artifacts, has_haptics, fidelity_score }
//
// The registry is the authoritative source for "what can this device render?"
// The Surface Adapter (middleware #1) reads it. The Response Formatter (#13)
// reads it. The Worker Dispatch (#10) checks it for vision routing.
//
// Invariants:
//   - A device can only belong to one session at a time.
//   - fidelity_score is 0-100. Higher means richer rendering.
//   - getHighestFidelityDevice always returns the richest surface in a session.
//   - Device removal cascades: removed from session membership too.
//   - Session is deleted when its last device is removed.
//
// This module is independent of syncServer.mjs — it's a pure data structure
// that syncServer delegates to. Testing requires no socket mocking.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'crypto';

// ─── Platform Defaults ───────────────────────────────────────────────────────

const PLATFORM_DEFAULTS = {
  macos: {
    has_voice: true, has_screen: true, has_artifacts: true,
    has_haptics: false, fidelity_score: 100,
  },
  ios: {
    has_voice: true, has_screen: true, has_artifacts: true,
    has_haptics: true, fidelity_score: 70,
  },
  android: {
    has_voice: true, has_screen: true, has_artifacts: true,
    has_haptics: true, fidelity_score: 65,
  },
  web: {
    has_voice: false, has_screen: true, has_artifacts: true,
    has_haptics: false, fidelity_score: 50,
  },
  cli: {
    has_voice: false, has_screen: true, has_artifacts: false,
    has_haptics: false, fidelity_score: 30,
  },
  watchos: {
    has_voice: true, has_screen: true, has_artifacts: false,
    has_haptics: true, fidelity_score: 15,
  },
  kage: {
    has_voice: true, has_screen: true, has_artifacts: false,
    has_haptics: false, fidelity_score: 40,
  },
  ambient: {
    has_voice: false, has_screen: true, has_artifacts: false,
    has_haptics: false, fidelity_score: 10,
  },
};

export { PLATFORM_DEFAULTS };

// ─── Capability Manifest ─────────────────────────────────────────────────────

export function normalizeCapabilities(raw = {}) {
  const platform = (raw.platform || 'unknown').toLowerCase();
  const defaults = PLATFORM_DEFAULTS[platform] || {
    has_voice: false, has_screen: true, has_artifacts: false,
    has_haptics: false, fidelity_score: 0,
  };

  return {
    platform,
    has_voice: raw.has_voice ?? defaults.has_voice,
    has_screen: raw.has_screen ?? defaults.has_screen,
    has_artifacts: raw.has_artifacts ?? defaults.has_artifacts,
    has_haptics: raw.has_haptics ?? defaults.has_haptics,
    fidelity_score: clampFidelity(raw.fidelity_score ?? defaults.fidelity_score),
    registered_at: Date.now(),
  };
}

function clampFidelity(score) {
  if (typeof score !== 'number' || isNaN(score)) return 0;
  return Math.max(0, Math.min(100, Math.round(score)));
}

// ─── Device Registry ─────────────────────────────────────────────────────────

export function createDeviceRegistry() {
  // deviceId → { sessionId, capabilities, lastSeen }
  const devices = new Map();
  // sessionId → Set<deviceId>
  const sessions = new Map();

  // ── Registration ─────────────────────────────────────────────────────

  function registerDevice(deviceId, sessionId, rawCapabilities = {}) {
    if (!deviceId || typeof deviceId !== 'string') {
      throw new Error('deviceId must be a non-empty string');
    }
    if (!sessionId || typeof sessionId !== 'string') {
      throw new Error('sessionId must be a non-empty string');
    }

    // If already registered in another session, remove from old session first
    const existing = devices.get(deviceId);
    if (existing && existing.sessionId !== sessionId) {
      _removeFromSession(deviceId, existing.sessionId);
    }

    const capabilities = normalizeCapabilities(rawCapabilities);

    devices.set(deviceId, {
      sessionId,
      capabilities,
      lastSeen: Date.now(),
    });

    // Add to session
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, new Set());
    }
    sessions.get(sessionId).add(deviceId);

    return { deviceId, sessionId, capabilities };
  }

  // ── Deregistration ───────────────────────────────────────────────────

  function deregisterDevice(deviceId) {
    const device = devices.get(deviceId);
    if (!device) return false;

    _removeFromSession(deviceId, device.sessionId);
    devices.delete(deviceId);
    return true;
  }

  function _removeFromSession(deviceId, sessionId) {
    const sessionDevices = sessions.get(sessionId);
    if (!sessionDevices) return;

    sessionDevices.delete(deviceId);
    if (sessionDevices.size === 0) {
      sessions.delete(sessionId);
    }
  }

  // ── Queries ──────────────────────────────────────────────────────────

  function getDeviceCapabilities(deviceId) {
    const device = devices.get(deviceId);
    return device ? { ...device.capabilities } : null;
  }

  function getSessionDevices(sessionId) {
    const deviceIds = sessions.get(sessionId);
    if (!deviceIds || deviceIds.size === 0) return [];

    return Array.from(deviceIds).map(id => {
      const device = devices.get(id);
      return {
        device_id: id,
        capabilities: device ? { ...device.capabilities } : null,
        lastSeen: device?.lastSeen,
      };
    });
  }

  function getHighestFidelityDevice(sessionId) {
    const deviceIds = sessions.get(sessionId);
    if (!deviceIds || deviceIds.size === 0) return null;

    let best = null;
    let bestFidelity = -1;

    for (const id of deviceIds) {
      const device = devices.get(id);
      if (device && device.capabilities.fidelity_score > bestFidelity) {
        bestFidelity = device.capabilities.fidelity_score;
        best = {
          device_id: id,
          capabilities: { ...device.capabilities },
          lastSeen: device.lastSeen,
        };
      }
    }

    return best;
  }

  function getLowestFidelityDevice(sessionId) {
    const deviceIds = sessions.get(sessionId);
    if (!deviceIds || deviceIds.size === 0) return null;

    let worst = null;
    let worstFidelity = Infinity;

    for (const id of deviceIds) {
      const device = devices.get(id);
      if (device && device.capabilities.fidelity_score < worstFidelity) {
        worstFidelity = device.capabilities.fidelity_score;
        worst = {
          device_id: id,
          capabilities: { ...device.capabilities },
          lastSeen: device.lastSeen,
        };
      }
    }

    return worst;
  }

  function getDevicesWithCapability(sessionId, capability) {
    const sessionDeviceList = getSessionDevices(sessionId);
    return sessionDeviceList.filter(d => d.capabilities && d.capabilities[capability] === true);
  }

  function isRegistered(deviceId) {
    return devices.has(deviceId);
  }

  function getDeviceSession(deviceId) {
    const device = devices.get(deviceId);
    return device ? device.sessionId : null;
  }

  // ── Session Transfer ─────────────────────────────────────────────────

  function transferDevice(deviceId, newSessionId) {
    const device = devices.get(deviceId);
    if (!device) return false;
    if (!newSessionId || typeof newSessionId !== 'string') return false;

    const oldSessionId = device.sessionId;
    _removeFromSession(deviceId, oldSessionId);

    device.sessionId = newSessionId;
    if (!sessions.has(newSessionId)) {
      sessions.set(newSessionId, new Set());
    }
    sessions.get(newSessionId).add(deviceId);

    return { from: oldSessionId, to: newSessionId };
  }

  // ── Touch (update lastSeen) ──────────────────────────────────────────

  function touchDevice(deviceId) {
    const device = devices.get(deviceId);
    if (!device) return false;
    device.lastSeen = Date.now();
    return true;
  }

  // ── Counts ───────────────────────────────────────────────────────────

  function getDeviceCount() {
    return devices.size;
  }

  function getSessionCount() {
    return sessions.size;
  }

  function getSessionDeviceCount(sessionId) {
    const s = sessions.get(sessionId);
    return s ? s.size : 0;
  }

  // ── Bulk ─────────────────────────────────────────────────────────────

  function getAllDevices() {
    const result = [];
    for (const [deviceId, device] of devices) {
      result.push({
        device_id: deviceId,
        session_id: device.sessionId,
        capabilities: { ...device.capabilities },
        lastSeen: device.lastSeen,
      });
    }
    return result;
  }

  function getAllSessions() {
    const result = [];
    for (const [sessionId, deviceIds] of sessions) {
      result.push({
        session_id: sessionId,
        device_count: deviceIds.size,
        devices: Array.from(deviceIds),
      });
    }
    return result;
  }

  // ── Clear ────────────────────────────────────────────────────────────

  function clear() {
    devices.clear();
    sessions.clear();
  }

  // ── Public API ─────────────────────────────────────────────────────────

  return {
    registerDevice,
    deregisterDevice,
    getDeviceCapabilities,
    getSessionDevices,
    getHighestFidelityDevice,
    getLowestFidelityDevice,
    getDevicesWithCapability,
    isRegistered,
    getDeviceSession,
    transferDevice,
    touchDevice,
    getDeviceCount,
    getSessionCount,
    getSessionDeviceCount,
    getAllDevices,
    getAllSessions,
    clear,
  };
}
