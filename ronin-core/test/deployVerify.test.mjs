// test/deployVerify.test.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Tests for Gate 08: Deploy + Verify
// ─────────────────────────────────────────────────────────────────────────────

import {
  DEPLOY_STATUS,
  createHealthCheck,
  createSmokeTest,
  runHealthChecks,
  runSmokeTests,
  notifySurfaces,
  deployAndVerify,
} from '../gates/deployVerify.mjs';

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

// ─── Mock helpers ─────────────────────────────────────────────────────────────

function makeFetch(options = {}) {
  const statusMap = options.statusMap || {};
  const defaultStatus = options.defaultStatus || 200;

  return async (url) => {
    const status = statusMap[url] || defaultStatus;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Error',
    };
  };
}

function makeDeployer(options = {}) {
  let deployCallCount  = 0;
  let rollbackCallCount = 0;

  return {
    get deployCallCount()   { return deployCallCount; },
    get rollbackCallCount() { return rollbackCallCount; },
    async deploy(artifacts, config) {
      deployCallCount++;
      if (options.failDeploy) throw new Error('Deploy failed');
      return {
        url:  options.url  || 'https://app.example.com',
        id:   options.id   || 'deploy_123',
        cost: options.cost || 0,
      };
    },
    async rollback(deployId) {
      rollbackCallCount++;
    },
  };
}

function makeNotifier() {
  const notifications = [];
  return {
    notifications,
    async notify(surface, event) {
      notifications.push({ surface, event });
    },
  };
}

const SAMPLE_BUILD = { 'dist/app.js': 'bundled code', 'dist/index.html': '<html/>' };

console.log('\n─── deployVerify.test.mjs ───────────────────────────────\n');

// ─── DEPLOY_STATUS ────────────────────────────────────────────────────────────

console.log('DEPLOY_STATUS:');

await testAsync('all status values defined', async () => {
  assert(DEPLOY_STATUS.PENDING,      'PENDING');
  assert(DEPLOY_STATUS.DEPLOYING,    'DEPLOYING');
  assert(DEPLOY_STATUS.DEPLOYED,     'DEPLOYED');
  assert(DEPLOY_STATUS.HEALTH_CHECK, 'HEALTH_CHECK');
  assert(DEPLOY_STATUS.SMOKE_TEST,   'SMOKE_TEST');
  assert(DEPLOY_STATUS.LIVE,         'LIVE');
  assert(DEPLOY_STATUS.FAILED,       'FAILED');
  assert(DEPLOY_STATUS.ROLLED_BACK,  'ROLLED_BACK');
});

// ─── createHealthCheck / createSmokeTest ─────────────────────────────────────

console.log('\nSchemas:');

await testAsync('createHealthCheck creates default record', async () => {
  const hc = createHealthCheck('root');
  assertEqual(hc.name, 'root', 'name');
  assertEqual(hc.passed, false, 'passed default false');
  assert(hc.critical !== undefined, 'critical exists');
});

await testAsync('createSmokeTest creates default record', async () => {
  const st = createSmokeTest('homepage');
  assertEqual(st.name, 'homepage', 'name');
  assertEqual(st.passed, false, 'passed default false');
});

// ─── runHealthChecks ──────────────────────────────────────────────────────────

console.log('\nrunHealthChecks:');

await testAsync('returns default checks when no checks configured', async () => {
  const results = await runHealthChecks('https://app.example.com', [], {
    fetch: makeFetch({ defaultStatus: 200 }),
  });
  assert(results.length >= 1, `expected >= 1 check, got ${results.length}`);
});

await testAsync('passes when HTTP 200', async () => {
  const checks  = [{ name: 'root', path: '/', expectedStatus: 200, critical: true }];
  const results = await runHealthChecks('https://app.example.com', checks, {
    fetch: makeFetch({ defaultStatus: 200 }),
  });
  assert(results[0].passed, 'should pass for 200');
  assert(results[0].statusCode === 200, 'statusCode should be 200');
});

await testAsync('fails when status does not match expected', async () => {
  const checks  = [{ name: 'root', path: '/', expectedStatus: 200, critical: true }];
  const results = await runHealthChecks('https://app.example.com', checks, {
    fetch: makeFetch({ defaultStatus: 503 }),
  });
  assert(!results[0].passed, 'should fail for 503');
  assert(results[0].error?.includes('503'), 'error message includes status');
});

await testAsync('all checks run in parallel', async () => {
  const checks = [
    { name: 'check1', path: '/a', expectedStatus: 200 },
    { name: 'check2', path: '/b', expectedStatus: 200 },
    { name: 'check3', path: '/c', expectedStatus: 200 },
  ];
  let fetchCount = 0;
  const fetch    = async () => { fetchCount++; return { ok: true, status: 200, statusText: 'OK' }; };
  await runHealthChecks('https://app.example.com', checks, { fetch });
  assertEqual(fetchCount, 3, 'all 3 checks should run');
});

await testAsync('no fetch available → checks pass as skipped', async () => {
  const checks  = [{ name: 'root', path: '/', critical: true }];
  // Pass fetch: null explicitly to simulate an environment with no fetch
  const results = await runHealthChecks('https://app.example.com', checks, { fetch: null });
  assert(results[0].passed, 'skipped checks should pass');
  assert(results[0].error?.includes('skipped'), 'error notes skipped');
});

await testAsync('returns passed: false on no deploy URL', async () => {
  const results = await runHealthChecks(null, [], {});
  assert(!results[0].passed, 'should fail when no URL');
});

// ─── runSmokeTests ────────────────────────────────────────────────────────────

console.log('\nrunSmokeTests:');

await testAsync('returns default passing result when no tests configured', async () => {
  const results = await runSmokeTests('https://app.example.com', []);
  assert(results.length === 1, 'should return 1 default result');
  assert(results[0].passed, 'default result should pass');
});

await testAsync('uses custom runner when provided', async () => {
  let runnerCalled = false;
  const tests = [{
    name: 'homepage loads',
    runner: async (baseUrl) => { runnerCalled = true; return { passed: true, output: 'ok' }; },
  }];
  const results = await runSmokeTests('https://app.example.com', tests, {});
  assert(runnerCalled, 'custom runner should be called');
  assert(results[0].passed, 'should pass');
});

await testAsync('custom runner failure captured gracefully', async () => {
  const tests = [{
    name: 'failing test',
    runner: async () => { throw new Error('runner exploded'); },
  }];
  const results = await runSmokeTests('https://app.example.com', tests, {});
  assert(!results[0].passed, 'should not pass on error');
  assert(results[0].error?.includes('exploded'), 'error preserved');
});

// ─── notifySurfaces ───────────────────────────────────────────────────────────

console.log('\nnotifySurfaces:');

await testAsync('notifies default surfaces', async () => {
  const notifier = makeNotifier();
  await notifySurfaces({ type: 'deploy_success' }, notifier, { surfaces: ['desktop', 'cli'] });
  assertEqual(notifier.notifications.length, 2, 'should notify 2 surfaces');
});

await testAsync('returns sent count and empty errors on success', async () => {
  const notifier = makeNotifier();
  const result   = await notifySurfaces({ type: 'deploy_success' }, notifier, { surfaces: ['desktop'] });
  assertEqual(result.sent, 1, 'sent: 1');
  assertEqual(result.errors.length, 0, 'no errors');
});

await testAsync('handles missing notifier gracefully', async () => {
  const result = await notifySurfaces({ type: 'test' }, null, {});
  assertEqual(result.sent, 0, 'sent: 0 without notifier');
});

await testAsync('captures notifier errors without throwing', async () => {
  const badNotifier = { async notify() { throw new Error('notification failed'); } };
  const result      = await notifySurfaces({ type: 'test' }, badNotifier, { surfaces: ['desktop'] });
  assertEqual(result.errors.length, 1, 'should capture error');
  assert(result.errors[0].surface === 'desktop', 'error surface identified');
});

// ─── deployAndVerify ──────────────────────────────────────────────────────────

console.log('\ndeployAndVerify:');

await testAsync('throws if buildOutput is null', async () => {
  try {
    await deployAndVerify(null, {});
    assert(false, 'Should have thrown');
  } catch (err) {
    assert(err.message.includes('buildOutput'));
  }
});

await testAsync('deploys and returns live status on success', async () => {
  const deployer  = makeDeployer();
  const notifier  = makeNotifier();
  const result    = await deployAndVerify(SAMPLE_BUILD, { deployer, notifier }, {
    mockUrl: 'https://app.example.com',
    fetch:   makeFetch({ defaultStatus: 200 }),  // mock health checks
  });
  assert(result.deployed, 'should be deployed');
  assertEqual(result.status, DEPLOY_STATUS.LIVE, 'status should be LIVE');
  assert(result.url, 'should have URL');
});

await testAsync('uses no-op deploy when no deployer provided', async () => {
  const result = await deployAndVerify(SAMPLE_BUILD, {}, {
    mockUrl: 'http://localhost:3000',
    fetch:   makeFetch({ defaultStatus: 200 }),
  });
  assert(result.deployed, 'should succeed without deployer');
  assert(result.url === 'http://localhost:3000', 'should use mockUrl');
});

await testAsync('deploy failure → deployed: false', async () => {
  const deployer = makeDeployer({ failDeploy: true });
  const result   = await deployAndVerify(SAMPLE_BUILD, { deployer }, {});
  assert(!result.deployed, 'should not be deployed');
  assertEqual(result.status, DEPLOY_STATUS.FAILED, 'status FAILED');
  assert(result.error?.includes('Deploy failed'), 'error preserved');
});

await testAsync('health check failure → rolled back', async () => {
  const deployer = makeDeployer({ url: 'https://app.example.com' });
  const result   = await deployAndVerify(SAMPLE_BUILD, {
    deployer,
    healthChecks: [{ name: 'root', path: '/', expectedStatus: 200, critical: true }],
  }, {
    fetch: makeFetch({ defaultStatus: 503 }),  // health check fails
  });
  assert(!result.deployed, 'should not be deployed');
  assert(result.rolled_back, 'should be rolled back');
  assert([DEPLOY_STATUS.FAILED, DEPLOY_STATUS.ROLLED_BACK].includes(result.status), 'failed or rolled_back');
});

await testAsync('rollback is called on health check failure', async () => {
  const deployer = makeDeployer({ url: 'https://app.example.com' });
  await deployAndVerify(SAMPLE_BUILD, {
    deployer,
    healthChecks: [{ name: 'root', path: '/', expectedStatus: 200, critical: true }],
  }, {
    fetch: makeFetch({ defaultStatus: 500 }),
  });
  assertEqual(deployer.rollbackCallCount, 1, 'rollback should be called once');
});

await testAsync('notifies success surfaces on live', async () => {
  const notifier = makeNotifier();
  await deployAndVerify(SAMPLE_BUILD, { notifier }, {
    surfaces: ['desktop', 'cli'],
    fetch:    makeFetch({ defaultStatus: 200 }),
  });
  const successNotifications = notifier.notifications.filter(n => n.event?.type === 'deploy_success');
  assert(successNotifications.length > 0, 'success notification sent');
});

await testAsync('notifies failure surfaces on rollback', async () => {
  const deployer = makeDeployer({ url: 'https://app.example.com' });
  const notifier = makeNotifier();
  await deployAndVerify(SAMPLE_BUILD, {
    deployer,
    notifier,
    healthChecks: [{ name: 'root', path: '/', expectedStatus: 200, critical: true }],
  }, {
    fetch: makeFetch({ defaultStatus: 500 }),
    surfaces: ['desktop'],
  });
  const failNotifications = notifier.notifications.filter(n => n.event?.type === 'deploy_failed');
  assert(failNotifications.length > 0, 'failure notification sent');
});

await testAsync('returns meta with cost and duration', async () => {
  const result = await deployAndVerify(SAMPLE_BUILD, {}, {});
  assert(result.meta, 'meta exists');
  assert(typeof result.meta.totalCost === 'number', 'totalCost');
  assert(typeof result.meta.totalDuration === 'number', 'totalDuration');
});

await testAsync('health checks results included in response', async () => {
  const result = await deployAndVerify(SAMPLE_BUILD, {}, {});
  assert(Array.isArray(result.healthChecks), 'healthChecks is array');
});

await testAsync('smoke test results included in response', async () => {
  const result = await deployAndVerify(SAMPLE_BUILD, {}, {});
  assert(Array.isArray(result.smokeTests), 'smokeTests is array');
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n─── Results: ${passed} passed, ${failed} failed ───\n`);
process.exit(failed > 0 ? 1 : 0);
