// test/deployConfig.test.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Tests for I3: Coolify Deployment Configuration
// ─────────────────────────────────────────────────────────────────────────────

import {
  DEPLOY_ENV,
  RUNTIME,
  createDeployManifest,
  validateDeployConfig,
  createCoolifyClient,
  createDeployConfig,
  productionConfig,
  stagingConfig,
  previewConfig,
} from '../infra/deployConfig.mjs';

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

// ─── Mock fetch ───────────────────────────────────────────────────────────────

function makeFetch(options = {}) {
  let callCount = 0;
  const statusMap = options.statusMap || {};

  return async (url, req) => {
    callCount++;
    const status = statusMap[url] || options.defaultStatus || 200;
    const body   = options.body   || { message: 'ok', uuid: 'deploy_mock_123' };
    return {
      ok:         status < 400,
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      async json() { return body; },
    };
  };
}

console.log('\n─── deployConfig.test.mjs ───────────────────────────────\n');

// ─── DEPLOY_ENV and RUNTIME ───────────────────────────────────────────────────

console.log('Constants:');

await testAsync('DEPLOY_ENV values defined', async () => {
  assert(DEPLOY_ENV.PRODUCTION, 'PRODUCTION');
  assert(DEPLOY_ENV.STAGING,    'STAGING');
  assert(DEPLOY_ENV.PREVIEW,    'PREVIEW');
});

await testAsync('RUNTIME values defined', async () => {
  assert(RUNTIME.NODEJS,   'NODEJS');
  assert(RUNTIME.DOCKER,   'DOCKER');
  assert(RUNTIME.STATIC,   'STATIC');
  assert(RUNTIME.NIXPACKS, 'NIXPACKS');
});

// ─── createDeployManifest ─────────────────────────────────────────────────────

console.log('\ncreateDeployManifest:');

await testAsync('creates manifest with defaults', async () => {
  const manifest = createDeployManifest();
  assertEqual(manifest.environment, DEPLOY_ENV.STAGING, 'default env');
  assertEqual(manifest.runtime, RUNTIME.NIXPACKS, 'default runtime');
  assert(Array.isArray(manifest.ports), 'ports is array');
  assert(typeof manifest.envVars === 'object', 'envVars is object');
});

await testAsync('accepts overrides', async () => {
  const manifest = createDeployManifest({
    appId:       'app-123',
    environment: DEPLOY_ENV.PRODUCTION,
  });
  assertEqual(manifest.appId, 'app-123', 'appId');
  assertEqual(manifest.environment, DEPLOY_ENV.PRODUCTION, 'environment');
});

// ─── validateDeployConfig ─────────────────────────────────────────────────────

console.log('\nvalidateDeployConfig:');

await testAsync('valid config returns valid: true', async () => {
  const result = validateDeployConfig({
    apiUrl:    'https://coolify.example.com',
    apiToken:  'my-token',
    appId:     'app-123',
    environment: DEPLOY_ENV.STAGING,
  });
  assert(result.valid, 'should be valid');
  assertEqual(result.errors.length, 0, 'no errors');
});

await testAsync('missing apiUrl → error', async () => {
  const result = validateDeployConfig({ apiToken: 'tok', appId: 'app' });
  assert(!result.valid, 'should be invalid');
  assert(result.errors.some(e => e.includes('apiUrl')), 'error mentions apiUrl');
});

await testAsync('missing apiToken → error', async () => {
  const result = validateDeployConfig({ apiUrl: 'https://example.com', appId: 'app' });
  assert(!result.valid, 'should be invalid');
  assert(result.errors.some(e => e.includes('apiToken')), 'error mentions apiToken');
});

await testAsync('missing appId → error', async () => {
  const result = validateDeployConfig({ apiUrl: 'https://example.com', apiToken: 'tok' });
  assert(!result.valid, 'should be invalid');
  assert(result.errors.some(e => e.includes('appId')), 'error mentions appId');
});

await testAsync('production without domains → warning', async () => {
  const result = validateDeployConfig({
    apiUrl:      'https://example.com',
    apiToken:    'tok',
    appId:       'app',
    environment: DEPLOY_ENV.PRODUCTION,
    domains:     [],
  });
  assert(result.valid, 'still valid');
  assert(result.warnings.some(w => w.includes('domains')), 'warning about domains');
});

await testAsync('applicationUuid accepted as alternative to appId', async () => {
  const result = validateDeployConfig({
    apiUrl:           'https://example.com',
    apiToken:         'tok',
    applicationUuid:  'uuid-123',
  });
  assert(result.valid, 'should accept applicationUuid');
});

// ─── createCoolifyClient ──────────────────────────────────────────────────────

console.log('\ncreateCoolifyClient:');

await testAsync('deploy calls POST /deploy endpoint', async () => {
  let calledUrl = null;
  const fetch = async (url, req) => {
    calledUrl = url;
    return { ok: true, status: 200, async json() { return { uuid: 'deploy_1' }; } };
  };
  const client = createCoolifyClient('https://coolify.example.com', 'token', { fetch, silent: true });
  await client.deploy('app-123');
  assert(calledUrl?.includes('/deploy'), 'should call /deploy endpoint');
  assert(calledUrl?.includes('app-123'), 'should include app id');
});

await testAsync('returns noop response when no fetch available', async () => {
  // Pass fetch: null explicitly to simulate environment without fetch
  const client = createCoolifyClient('https://coolify.example.com', 'token', { silent: true, fetch: null });
  const result = await client.deploy('app-123');
  assert(result.ok, 'noop response should be ok');
  assert(result.data, 'should have data');
});

await testAsync('throws on non-ok response', async () => {
  const fetch = async () => ({
    ok: false,
    status: 401,
    async json() { return { error: 'Unauthorized' }; },
  });
  const client = createCoolifyClient('https://coolify.example.com', 'badtoken', { fetch, silent: true });
  try {
    await client.deploy('app-123');
    assert(false, 'Should have thrown');
  } catch (err) {
    assert(err.message.includes('401'), 'error mentions 401');
  }
});

await testAsync('setEnvVars sends bulk env var update', async () => {
  let requestBody = null;
  const fetch = async (url, req) => {
    requestBody = JSON.parse(req.body || '{}');
    return { ok: true, status: 200, async json() { return { message: 'ok' }; } };
  };
  const client = createCoolifyClient('https://coolify.example.com', 'token', { fetch, silent: true });
  await client.setEnvVars('app-123', { NODE_ENV: 'production', PORT: '3000' });
  assert(requestBody?.data?.length >= 2, 'should send env vars array');
});

// ─── createDeployConfig ───────────────────────────────────────────────────────

console.log('\ncreateDeployConfig:');

await testAsync('returns manifest and validation', async () => {
  const config = createDeployConfig({
    apiUrl:   'https://coolify.example.com',
    apiToken: 'tok',
    appId:    'app-123',
    silent:   true,
  });
  assert(config.manifest, 'should have manifest');
  assert(config.validation, 'should have validation');
  assert(config.getDeployer, 'should have getDeployer');
});

await testAsync('getDeployer returns no-op deployer when no credentials', async () => {
  const config   = createDeployConfig({ silent: true });
  const deployer = config.getDeployer();
  const result   = await deployer.deploy({}, { mockUrl: 'http://localhost:3000' });
  assert(result.url, 'no-op deployer should return a url');
  assert(result.id, 'no-op deployer should return an id');
});

await testAsync('getDeployer returns real deployer when credentials provided', async () => {
  const fetch  = makeFetch({ body: { uuid: 'deploy_real_1' } });
  const config = createDeployConfig({
    apiUrl:   'https://coolify.example.com',
    apiToken: 'real-token',
    appId:    'app-real',
    fetch,
    silent:   true,
  });
  const deployer = config.getDeployer();
  const result   = await deployer.deploy({}, {});
  assert(result.id, 'should return deploy id');
});

await testAsync('getConfig returns non-sensitive config', async () => {
  const config = createDeployConfig({
    apiUrl:      'https://coolify.example.com',
    apiToken:    'secret-token',
    appId:       'app-123',
    environment: DEPLOY_ENV.PRODUCTION,
    silent:      true,
  });
  const cfg = config.getConfig();
  assert(cfg.apiUrl, 'should have apiUrl');
  assert(!cfg.apiToken, 'should NOT expose apiToken');
  assertEqual(cfg.environment, DEPLOY_ENV.PRODUCTION, 'environment');
});

// ─── Environment builders ─────────────────────────────────────────────────────

console.log('\nEnvironment builders:');

await testAsync('productionConfig sets environment to PRODUCTION', async () => {
  const config = productionConfig('app-123', 'app.example.com', { silent: true });
  assertEqual(config.manifest.environment, DEPLOY_ENV.PRODUCTION, 'environment');
  assert(config.manifest.domains.includes('app.example.com'), 'domain set');
  assertEqual(config.manifest.envVars.NODE_ENV, 'production', 'NODE_ENV');
});

await testAsync('stagingConfig sets environment to STAGING', async () => {
  const config = stagingConfig('app-123', { silent: true });
  assertEqual(config.manifest.environment, DEPLOY_ENV.STAGING, 'environment');
  assertEqual(config.manifest.envVars.NODE_ENV, 'staging', 'NODE_ENV');
});

await testAsync('previewConfig sets environment to PREVIEW and includes branch', async () => {
  const config = previewConfig('app-123', 'feature-auth', { silent: true });
  assertEqual(config.manifest.environment, DEPLOY_ENV.PREVIEW, 'environment');
  assert(config.manifest.appId.includes('feature-auth'), 'appId includes branch');
  assertEqual(config.manifest.envVars.BRANCH, 'feature-auth', 'BRANCH env var');
});

await testAsync('custom envVars merged with defaults', async () => {
  const config = stagingConfig('app-123', {
    silent: true,
    envVars: { DATABASE_URL: 'postgres://localhost/mydb' },
  });
  assertEqual(config.manifest.envVars.DATABASE_URL, 'postgres://localhost/mydb', 'custom env var');
  assertEqual(config.manifest.envVars.NODE_ENV, 'staging', 'default env var preserved');
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n─── Results: ${passed} passed, ${failed} failed ───\n`);
process.exit(failed > 0 ? 1 : 0);
