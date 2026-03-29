// infra/tailscaleConfig.mjs
// ─────────────────────────────────────────────────────────────────────────────
// I2: Tailscale Mesh Configuration
//
// Manages Tailscale mesh network discovery and routing for RONIN nodes.
// Allows RONIN surfaces (desktop, mobile, server, CLI) to find each other
// over Tailscale without exposing public ports.
//
// Key behaviours:
//   - discoverPeers() → find RONIN nodes on the Tailnet
//   - registerNode(profile) → announce this node to the mesh
//   - resolveRoute(target) → get the Tailscale IP for a named target
//   - healthCheck() → verify connectivity to critical peers
//
// The Tailscale API is called via the local daemon (`tailscale status --json`).
// Falls back to a static peer table when the daemon is unavailable.
//
// Usage:
//   const mesh = createTailscaleConfig({ authKey: '...', network: 'ronin' });
//   const peers = await mesh.discoverPeers();
//   const ip    = await mesh.resolveRoute('ronin-server');
// ─────────────────────────────────────────────────────────────────────────────

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// ─── Node Roles ───────────────────────────────────────────────────────────────

export const NODE_ROLES = {
  SERVER:  'server',    // RONIN backend / orchestrator
  DESKTOP: 'desktop',  // macOS native client
  MOBILE:  'mobile',   // iOS client
  WEB:     'web',      // web client
  CLI:     'cli',      // terminal client
  GATEWAY: 'gateway',  // RONIN Gateway node
};

// ─── Peer schema ──────────────────────────────────────────────────────────────

export function createPeer(overrides = {}) {
  return {
    id:           null,     // Tailscale node ID
    hostname:     null,
    tailscaleIp:  null,     // 100.x.y.z
    role:         null,     // NODE_ROLES value
    online:       false,
    lastSeen:     null,
    tags:         [],       // Tailscale ACL tags
    roninVersion: null,
    ...overrides,
  };
}

// ─── Parse tailscale status JSON ──────────────────────────────────────────────

export function parseTailscaleStatus(statusJson) {
  const peers = [];

  try {
    const data = typeof statusJson === 'string' ? JSON.parse(statusJson) : statusJson;

    const self = data.Self;
    if (self) {
      peers.push(createPeer({
        id:          self.ID,
        hostname:    self.HostName,
        tailscaleIp: Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs[0] : null,
        online:      self.Online !== false,
        lastSeen:    self.LastSeen || null,
        tags:        self.Tags || [],
        _self:       true,
      }));
    }

    const peerMap = data.Peer || {};
    for (const [, peer] of Object.entries(peerMap)) {
      peers.push(createPeer({
        id:          peer.ID,
        hostname:    peer.HostName,
        tailscaleIp: Array.isArray(peer.TailscaleIPs) ? peer.TailscaleIPs[0] : null,
        online:      peer.Online !== false,
        lastSeen:    peer.LastSeen || null,
        tags:        peer.Tags || [],
      }));
    }
  } catch {
    // Return empty peers on parse failure
  }

  return peers;
}

// ─── Detect node role from hostname / tags ────────────────────────────────────

export function detectNodeRole(peer) {
  const host = (peer.hostname || '').toLowerCase();
  const tags  = (peer.tags || []).map(t => t.toLowerCase());

  if (tags.includes('tag:ronin-server')  || host.includes('server'))  return NODE_ROLES.SERVER;
  if (tags.includes('tag:ronin-gateway') || host.includes('gateway')) return NODE_ROLES.GATEWAY;
  if (tags.includes('tag:ronin-desktop') || host.includes('mac')
    || host.includes('desktop'))                                        return NODE_ROLES.DESKTOP;
  if (tags.includes('tag:ronin-mobile')  || host.includes('iphone')
    || host.includes('ipad'))                                           return NODE_ROLES.MOBILE;
  if (tags.includes('tag:ronin-cli')     || host.includes('cli'))     return NODE_ROLES.CLI;
  if (tags.includes('tag:ronin-web')     || host.includes('web'))     return NODE_ROLES.WEB;

  return null;
}

// ─── Tailscale config factory ─────────────────────────────────────────────────

export function createTailscaleConfig(options = {}) {
  const {
    network    = 'ronin',
    staticPeers = [],       // fallback peer table
    silent      = false,
    _exec       = null,     // injectable for tests
  } = options;

  const peerCache = new Map();   // hostname → peer
  let lastRefresh  = 0;
  const CACHE_TTL  = 30_000;    // 30s

  function _log(...args) {
    if (!silent) console.log('[TailscaleConfig]', ...args);
  }

  // ─── Get raw tailscale status ──────────────────────────────────────────
  async function _getTailscaleStatus() {
    const execFn = _exec || execFileAsync;

    try {
      const { stdout } = await execFn('tailscale', ['status', '--json'], { timeout: 5000 });
      return stdout;
    } catch {
      return null;  // Tailscale not available or not running
    }
  }

  // ─── Discover peers ────────────────────────────────────────────────────
  async function discoverPeers(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && (now - lastRefresh) < CACHE_TTL && peerCache.size > 0) {
      return [...peerCache.values()];
    }

    const statusJson = await _getTailscaleStatus();
    let peers = [];

    if (statusJson) {
      peers = parseTailscaleStatus(statusJson);
      // Annotate with role detection
      for (const peer of peers) {
        if (!peer.role) peer.role = detectNodeRole(peer);
      }
    } else {
      // Fallback to static peer table
      peers = staticPeers.map(p => createPeer(p));
      _log('Tailscale daemon unavailable — using static peer table');
    }

    // Filter to RONIN network peers only (tagged or hostname-matched)
    const roninPeers = peers.filter(p =>
      p.tags.some(t => t.includes(network)) ||
      (p.hostname || '').toLowerCase().includes(network) ||
      p.role !== null
    );

    peerCache.clear();
    for (const peer of roninPeers) {
      peerCache.set(peer.hostname, peer);
    }

    lastRefresh = now;
    return roninPeers;
  }

  // ─── Resolve a route (hostname → IP) ──────────────────────────────────
  async function resolveRoute(target) {
    if (!peerCache.has(target)) {
      await discoverPeers();
    }

    const peer = peerCache.get(target);
    if (!peer) {
      // Check static peers
      const staticPeer = staticPeers.find(p => p.hostname === target || p.id === target);
      if (staticPeer) return staticPeer.tailscaleIp || null;
      return null;
    }

    return peer.tailscaleIp;
  }

  // ─── Register this node ────────────────────────────────────────────────
  // In production, this would call `tailscale up` with an auth key.
  // Here we just record the node profile for discovery.
  async function registerNode(profile = {}) {
    const peer = createPeer({
      ...profile,
      role: profile.role || detectNodeRole(profile),
    });

    peerCache.set(peer.hostname, peer);
    _log(`registered node: ${peer.hostname} (${peer.role})`);
    return peer;
  }

  // ─── Health check connectivity to critical peers ───────────────────────
  async function healthCheck(targetRole = NODE_ROLES.SERVER) {
    const peers = await discoverPeers();
    const targets = peers.filter(p => p.role === targetRole && p.online);

    if (targets.length === 0) {
      return {
        healthy: false,
        role:    targetRole,
        peers:   [],
        error:   `No online peers with role ${targetRole}`,
      };
    }

    return {
      healthy: true,
      role:    targetRole,
      peers:   targets.map(p => ({ hostname: p.hostname, ip: p.tailscaleIp })),
    };
  }

  // ─── Get peers by role ─────────────────────────────────────────────────
  async function getPeersByRole(role) {
    const peers = await discoverPeers();
    return peers.filter(p => p.role === role);
  }

  // ─── Get mesh topology summary ─────────────────────────────────────────
  async function getMeshTopology() {
    const peers = await discoverPeers();
    const topology = {};

    for (const role of Object.values(NODE_ROLES)) {
      topology[role] = peers.filter(p => p.role === role).map(p => ({
        hostname: p.hostname,
        ip:       p.tailscaleIp,
        online:   p.online,
      }));
    }

    return {
      network,
      peerCount: peers.length,
      onlineCount: peers.filter(p => p.online).length,
      topology,
      lastRefresh: new Date(lastRefresh).toISOString(),
    };
  }

  return {
    discoverPeers,
    resolveRoute,
    registerNode,
    healthCheck,
    getPeersByRole,
    getMeshTopology,
  };
}
