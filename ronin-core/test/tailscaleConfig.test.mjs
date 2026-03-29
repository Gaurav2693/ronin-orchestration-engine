// test/tailscaleConfig.test.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Tests for I2: Tailscale Mesh Configuration
// ─────────────────────────────────────────────────────────────────────────────

import {
  NODE_ROLES,
  createPeer,
  parseTailscaleStatus,
  detectNodeRole,
  createTailscaleConfig,
} from '../infra/tailscaleConfig.mjs';

let passed = 0;
let failed = 0;

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

function assert(cond, msg)      { if (!cond) throw new Error(msg || 'Assertion failed'); }
function assertEqual(a, b, msg) { if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

// ─── Mock tailscale status JSON ───────────────────────────────────────────────

const MOCK_STATUS = {
  Self: {
    ID:           'self-node-id',
    HostName:     'ronin-server',
    TailscaleIPs: ['100.64.0.1'],
    Online:       true,
    Tags:         ['tag:ronin-server'],
    LastSeen:     new Date().toISOString(),
  },
  Peer: {
    'node-mac': {
      ID:           'mac-node-id',
      HostName:     'gauravs-macbook',
      TailscaleIPs: ['100.64.0.2'],
      Online:       true,
      Tags:         ['tag:ronin-desktop'],
      LastSeen:     new Date().toISOString(),
    },
    'node-iphone': {
      ID:           'iphone-node-id',
      HostName:     'gauravs-iphone',
      TailscaleIPs: ['100.64.0.3'],
      Online:       false,
      Tags:         ['tag:ronin-mobile'],
      LastSeen:     new Date().toISOString(),
    },
  },
};

// Mock exec function that returns status JSON
function makeExec(statusData = MOCK_STATUS, options = {}) {
  return async (cmd, args, opts) => {
    if (options.fail) throw new Error('tailscale command not found');
    return { stdout: JSON.stringify(statusData) };
  };
}

console.log('\n─── tailscaleConfig.test.mjs ────────────────────────────\n');

// ─── NODE_ROLES ───────────────────────────────────────────────────────────────

console.log('NODE_ROLES:');

await testAsync('all roles defined', async () => {
  assert(NODE_ROLES.SERVER,  'SERVER');
  assert(NODE_ROLES.DESKTOP, 'DESKTOP');
  assert(NODE_ROLES.MOBILE,  'MOBILE');
  assert(NODE_ROLES.WEB,     'WEB');
  assert(NODE_ROLES.CLI,     'CLI');
  assert(NODE_ROLES.GATEWAY, 'GATEWAY');
});

// ─── createPeer ───────────────────────────────────────────────────────────────

console.log('\ncreatePeer:');

await testAsync('creates peer with defaults', async () => {
  const peer = createPeer();
  assertEqual(peer.id, null, 'id default null');
  assertEqual(peer.online, false, 'online default false');
  assert(Array.isArray(peer.tags), 'tags is array');
});

await testAsync('accepts overrides', async () => {
  const peer = createPeer({ hostname: 'myhost', online: true, role: NODE_ROLES.SERVER });
  assertEqual(peer.hostname, 'myhost', 'hostname');
  assert(peer.online, 'online');
  assertEqual(peer.role, NODE_ROLES.SERVER, 'role');
});

// ─── parseTailscaleStatus ─────────────────────────────────────────────────────

console.log('\nparseTailscaleStatus:');

await testAsync('parses self node', async () => {
  const peers = parseTailscaleStatus(MOCK_STATUS);
  const self  = peers.find(p => p._self);
  assert(self, 'should find self node');
  assertEqual(self.hostname, 'ronin-server', 'hostname');
  assertEqual(self.tailscaleIp, '100.64.0.1', 'tailscale IP');
});

await testAsync('parses peer nodes', async () => {
  const peers = parseTailscaleStatus(MOCK_STATUS);
  const mac   = peers.find(p => p.hostname === 'gauravs-macbook');
  assert(mac, 'should find mac peer');
  assertEqual(mac.tailscaleIp, '100.64.0.2', 'mac IP');
  assert(mac.online, 'mac should be online');
});

await testAsync('parses offline peers', async () => {
  const peers   = parseTailscaleStatus(MOCK_STATUS);
  const iphone  = peers.find(p => p.hostname === 'gauravs-iphone');
  assert(iphone, 'should find iphone peer');
  assert(!iphone.online, 'iphone should be offline');
});

await testAsync('parses JSON string input', async () => {
  const peers = parseTailscaleStatus(JSON.stringify(MOCK_STATUS));
  assert(peers.length >= 2, 'should parse from string');
});

await testAsync('returns empty array on invalid JSON', async () => {
  const peers = parseTailscaleStatus('not valid json {{');
  assertEqual(peers.length, 0, 'should return empty on invalid JSON');
});

await testAsync('returns empty array on null input', async () => {
  const peers = parseTailscaleStatus(null);
  assertEqual(peers.length, 0, 'should return empty on null');
});

await testAsync('includes tags array', async () => {
  const peers = parseTailscaleStatus(MOCK_STATUS);
  const server = peers.find(p => p._self);
  assert(server.tags.includes('tag:ronin-server'), 'should include server tag');
});

// ─── detectNodeRole ───────────────────────────────────────────────────────────

console.log('\ndetectNodeRole:');

await testAsync('detects SERVER from hostname', async () => {
  const peer = createPeer({ hostname: 'ronin-server', tags: [] });
  assertEqual(detectNodeRole(peer), NODE_ROLES.SERVER, 'role');
});

await testAsync('detects DESKTOP from mac hostname', async () => {
  const peer = createPeer({ hostname: 'my-macbook', tags: [] });
  assertEqual(detectNodeRole(peer), NODE_ROLES.DESKTOP, 'role');
});

await testAsync('detects MOBILE from iphone hostname', async () => {
  const peer = createPeer({ hostname: 'my-iphone', tags: [] });
  assertEqual(detectNodeRole(peer), NODE_ROLES.MOBILE, 'role');
});

await testAsync('detects role from tags (takes priority)', async () => {
  const peer = createPeer({ hostname: 'some-host', tags: ['tag:ronin-gateway'] });
  assertEqual(detectNodeRole(peer), NODE_ROLES.GATEWAY, 'gateway from tag');
});

await testAsync('returns null for unknown hostname and no tags', async () => {
  const peer = createPeer({ hostname: 'mystery-box', tags: [] });
  assertEqual(detectNodeRole(peer), null, 'unknown role');
});

// ─── createTailscaleConfig ────────────────────────────────────────────────────

console.log('\ncreateTailscaleConfig:');

await testAsync('discoverPeers returns peers from tailscale status', async () => {
  const mesh  = createTailscaleConfig({ _exec: makeExec(), silent: true });
  const peers = await mesh.discoverPeers();
  assert(peers.length >= 1, 'should discover peers');
});

await testAsync('peers have role annotations', async () => {
  const mesh  = createTailscaleConfig({ _exec: makeExec(), silent: true });
  const peers = await mesh.discoverPeers();
  const server = peers.find(p => p.hostname === 'ronin-server');
  assert(server, 'should find server');
  assertEqual(server.role, NODE_ROLES.SERVER, 'server role detected');
});

await testAsync('falls back to static peers when tailscale unavailable', async () => {
  const staticPeers = [
    createPeer({ hostname: 'static-server', tailscaleIp: '100.64.9.1', role: NODE_ROLES.SERVER, online: true }),
  ];
  const mesh  = createTailscaleConfig({
    _exec:       makeExec(null, { fail: true }),
    staticPeers,
    silent:      true,
  });
  const peers = await mesh.discoverPeers();
  assert(peers.some(p => p.hostname === 'static-server'), 'static peer should be included');
});

await testAsync('resolveRoute returns tailscale IP for hostname', async () => {
  const mesh = createTailscaleConfig({ _exec: makeExec(), silent: true });
  const ip   = await mesh.resolveRoute('ronin-server');
  assertEqual(ip, '100.64.0.1', 'should resolve server IP');
});

await testAsync('resolveRoute returns null for unknown hostname', async () => {
  const mesh = createTailscaleConfig({ _exec: makeExec(), silent: true });
  const ip   = await mesh.resolveRoute('unknown-machine');
  assertEqual(ip, null, 'should return null for unknown');
});

await testAsync('registerNode adds peer to cache', async () => {
  const mesh = createTailscaleConfig({ _exec: makeExec(), silent: true });
  await mesh.registerNode({ hostname: 'new-cli', role: NODE_ROLES.CLI, tailscaleIp: '100.64.0.9' });
  const ip = await mesh.resolveRoute('new-cli');
  assertEqual(ip, '100.64.0.9', 'registered node should be resolvable');
});

await testAsync('healthCheck returns healthy when target role peers online', async () => {
  const mesh   = createTailscaleConfig({ _exec: makeExec(), silent: true });
  const result = await mesh.healthCheck(NODE_ROLES.SERVER);
  assert(result.healthy, 'server should be healthy');
  assert(result.peers.length > 0, 'should list server peers');
});

await testAsync('healthCheck returns unhealthy when no peers for role', async () => {
  const mesh   = createTailscaleConfig({ _exec: makeExec(), silent: true });
  const result = await mesh.healthCheck(NODE_ROLES.WEB);  // no web peers in mock
  assert(!result.healthy, 'should be unhealthy when no web peers');
  assert(result.error, 'should have error message');
});

await testAsync('getPeersByRole filters correctly', async () => {
  const mesh    = createTailscaleConfig({ _exec: makeExec(), silent: true });
  const desktops = await mesh.getPeersByRole(NODE_ROLES.DESKTOP);
  assert(desktops.length >= 1, 'should find desktop peers');
  assert(desktops.every(p => p.role === NODE_ROLES.DESKTOP), 'all should be desktop role');
});

await testAsync('getMeshTopology returns topology map', async () => {
  const mesh     = createTailscaleConfig({ _exec: makeExec(), silent: true });
  const topology = await mesh.getMeshTopology();
  assert(topology.network, 'should have network name');
  assert(typeof topology.peerCount === 'number', 'peerCount');
  assert(topology.topology, 'should have topology map');
  assert(Object.keys(topology.topology).length >= 1, 'topology has roles');
});

await testAsync('peer cache is used on second call (no re-exec)', async () => {
  let execCount = 0;
  const exec    = async () => { execCount++; return { stdout: JSON.stringify(MOCK_STATUS) }; };
  const mesh    = createTailscaleConfig({ _exec: exec, silent: true });
  await mesh.discoverPeers();
  await mesh.discoverPeers();  // second call should hit cache
  assertEqual(execCount, 1, 'exec should only be called once within cache TTL');
});

await testAsync('forceRefresh bypasses cache', async () => {
  let execCount = 0;
  const exec    = async () => { execCount++; return { stdout: JSON.stringify(MOCK_STATUS) }; };
  const mesh    = createTailscaleConfig({ _exec: exec, silent: true });
  await mesh.discoverPeers();
  await mesh.discoverPeers(true);  // force refresh
  assertEqual(execCount, 2, 'exec should be called twice with forceRefresh');
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n─── Results: ${passed} passed, ${failed} failed ───\n`);
process.exit(failed > 0 ? 1 : 0);
