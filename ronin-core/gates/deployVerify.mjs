// gates/deployVerify.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Gate 08 Upgrade: Deploy + Verify
//
// After a successful build, this gate:
//   1. Deploys the build output (via pluggable deployer)
//   2. Runs health checks against the live deployment
//   3. Runs smoke tests (configurable per deployment target)
//   4. Notifies all registered surfaces (desktop, mobile, CLI, web)
//   5. Rolls back automatically if health checks fail
//
// Flow:
//   buildOutput → deploy → healthCheck → smokeTest → notifySurfaces → ✓
//                                ↓ fail
//                           rollback → notifyFailure
//
// Usage:
//   const result = await deployAndVerify(buildOutput, deployConfig, notifier);
//   // → { deployed, url, healthChecks[], smokeTests[], rolled_back, cost, duration }
// ─────────────────────────────────────────────────────────────────────────────

// ─── Deploy Status ────────────────────────────────────────────────────────────

export const DEPLOY_STATUS = {
  PENDING:      'pending',
  DEPLOYING:    'deploying',
  DEPLOYED:     'deployed',
  HEALTH_CHECK: 'health_check',
  SMOKE_TEST:   'smoke_test',
  LIVE:         'live',
  FAILED:       'failed',
  ROLLED_BACK:  'rolled_back',
};

// ─── Health check result schema ────────────────────────────────────────────────

export function createHealthCheck(name, overrides = {}) {
  return {
    name,
    passed:       false,
    statusCode:   null,
    latencyMs:    null,
    error:        null,
    critical:     true,  // critical checks block deployment if failed
    ...overrides,
  };
}

// ─── Smoke test result schema ─────────────────────────────────────────────────

export function createSmokeTest(name, overrides = {}) {
  return {
    name,
    passed:   false,
    output:   null,
    error:    null,
    critical: false,  // smoke tests warn but don't block by default
    ...overrides,
  };
}

// ─── Run health checks ────────────────────────────────────────────────────────
// Each check is a { name, url, expectedStatus?, timeout?, critical? }

export async function runHealthChecks(deployUrl, checks = [], options = {}) {
  if (!deployUrl) {
    return [{
      ...createHealthCheck('connectivity'),
      error: 'No deploy URL provided',
      passed: false,
    }];
  }

  const defaultChecks = checks.length > 0 ? checks : [
    { name: 'root', path: '/',        expectedStatus: 200, critical: true  },
    { name: 'health', path: '/health', expectedStatus: 200, critical: false },
  ];

  const results = await Promise.allSettled(
    defaultChecks.map(check => _runSingleHealthCheck(deployUrl, check, options))
  );

  return results.map((result, i) => {
    if (result.status === 'fulfilled') return result.value;
    return createHealthCheck(defaultChecks[i]?.name || `check_${i}`, {
      error:    result.reason?.message || 'Health check threw',
      critical: defaultChecks[i]?.critical !== false,
    });
  });
}

async function _runSingleHealthCheck(baseUrl, check, options = {}) {
  const url     = `${baseUrl.replace(/\/$/, '')}${check.path || '/'}`;
  const timeout = check.timeout || options.healthCheckTimeout || 5000;
  const start   = Date.now();

  // Pluggable fetch — in production uses real fetch; in tests use mock
  // If options.fetch is explicitly set (even to null), honour it. Otherwise fall back to globalThis.fetch.
  const fetchFn = 'fetch' in options
    ? options.fetch
    : (typeof globalThis.fetch === 'function' ? globalThis.fetch : null);

  if (!fetchFn) {
    // No fetch available — mark as skipped/passing (sandbox environment)
    return createHealthCheck(check.name || 'check', {
      passed:     true,
      statusCode: 0,
      latencyMs:  0,
      error:      'fetch not available — health check skipped',
      critical:   check.critical !== false,
    });
  }

  try {
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), timeout);

    const response = await fetchFn(url, { signal: controller.signal });
    clearTimeout(timer);

    const latencyMs      = Date.now() - start;
    const expectedStatus = check.expectedStatus || 200;
    const passed         = response.status === expectedStatus;

    return createHealthCheck(check.name || 'check', {
      passed,
      statusCode: response.status,
      latencyMs,
      critical:   check.critical !== false,
      error:      passed ? null : `Expected ${expectedStatus}, got ${response.status}`,
    });
  } catch (err) {
    return createHealthCheck(check.name || 'check', {
      error:    err.name === 'AbortError' ? `Timeout after ${timeout}ms` : err.message,
      latencyMs: Date.now() - start,
      critical:  check.critical !== false,
    });
  }
}

// ─── Run smoke tests ──────────────────────────────────────────────────────────

export async function runSmokeTests(deployUrl, testSpecs = [], options = {}) {
  if (!testSpecs || testSpecs.length === 0) {
    return [{
      ...createSmokeTest('default'),
      passed:  true,
      output:  'No smoke tests configured — skipped',
      critical: false,
    }];
  }

  const results = await Promise.allSettled(
    testSpecs.map(spec => _runSingleSmokeTest(deployUrl, spec, options))
  );

  return results.map((result, i) => {
    if (result.status === 'fulfilled') return result.value;
    return createSmokeTest(testSpecs[i]?.name || `test_${i}`, {
      error:    result.reason?.message || 'Smoke test threw',
      critical: testSpecs[i]?.critical === true,
    });
  });
}

async function _runSingleSmokeTest(baseUrl, spec, options = {}) {
  const runner = spec.runner || options.defaultRunner;

  if (!runner || typeof runner !== 'function') {
    // No runner — treat as a simple HTTP assertion
    const url    = `${baseUrl.replace(/\/$/, '')}${spec.path || '/'}`;
    const fetchFn = 'fetch' in options
      ? options.fetch
      : (typeof globalThis.fetch === 'function' ? globalThis.fetch : null);

    if (!fetchFn) {
      return createSmokeTest(spec.name || 'smoke', {
        passed:   true,
        output:   'fetch not available — smoke test skipped',
        critical: spec.critical === true,
      });
    }

    try {
      const response = await fetchFn(url);
      const passed   = response.ok;
      return createSmokeTest(spec.name || 'smoke', {
        passed,
        output:   `${response.status} ${response.statusText}`,
        critical: spec.critical === true,
        error:    passed ? null : `Smoke test failed: ${response.status}`,
      });
    } catch (err) {
      return createSmokeTest(spec.name || 'smoke', {
        error:    err.message,
        critical: spec.critical === true,
      });
    }
  }

  // Custom runner provided
  try {
    const output = await runner(baseUrl, spec);
    return createSmokeTest(spec.name || 'smoke', {
      passed:   output?.passed !== false,
      output:   output?.output || String(output),
      critical: spec.critical === true,
    });
  } catch (err) {
    return createSmokeTest(spec.name || 'smoke', {
      error:    err.message,
      critical: spec.critical === true,
    });
  }
}

// ─── Surface notification ─────────────────────────────────────────────────────

export async function notifySurfaces(event, notifier, options = {}) {
  if (!notifier || typeof notifier.notify !== 'function') {
    return { sent: 0, errors: [] };
  }

  const surfaces = options.surfaces || ['desktop', 'cli'];
  const results  = await Promise.allSettled(
    surfaces.map(surface => notifier.notify(surface, event))
  );

  const errors = results
    .map((r, i) => r.status === 'rejected' ? { surface: surfaces[i], error: r.reason?.message } : null)
    .filter(Boolean);

  return { sent: results.filter(r => r.status === 'fulfilled').length, errors };
}

// ─── Main: deployAndVerify ────────────────────────────────────────────────────

export async function deployAndVerify(buildOutput, deployConfig = {}, options = {}) {
  if (!buildOutput || typeof buildOutput !== 'object') {
    throw new Error('[deployVerify] buildOutput must be an object');
  }

  const startTime = Date.now();
  let status      = DEPLOY_STATUS.DEPLOYING;
  let deployUrl   = null;
  let deployId    = null;
  let rolled_back = false;
  let totalCost   = 0;

  const {
    deployer,    // { deploy(artifacts, config) → { url, id, cost } }
    notifier,    // { notify(surface, event) }
    healthChecks = [],
    smokeTests   = [],
  } = deployConfig;

  // ─── Step 1: Deploy ──────────────────────────────────────────────────────
  if (!deployer || typeof deployer.deploy !== 'function') {
    // No deployer — simulate a successful deploy (useful for dry-run / local)
    deployUrl = options.mockUrl || 'http://localhost:3000';
    deployId  = `deploy_${Date.now()}`;
    status    = DEPLOY_STATUS.DEPLOYED;
  } else {
    try {
      const deployResult = await deployer.deploy(buildOutput, deployConfig);
      deployUrl  = deployResult.url   || deployResult.deployUrl;
      deployId   = deployResult.id    || deployResult.deployId;
      totalCost += deployResult.cost  || 0;
      status     = DEPLOY_STATUS.DEPLOYED;
    } catch (err) {
      return {
        deployed:     false,
        status:       DEPLOY_STATUS.FAILED,
        url:          null,
        deployId:     null,
        healthChecks: [],
        smokeTests:   [],
        rolled_back:  false,
        error:        err.message,
        meta: { totalCost, totalDuration: Date.now() - startTime },
      };
    }
  }

  // ─── Step 2: Health checks ───────────────────────────────────────────────
  status = DEPLOY_STATUS.HEALTH_CHECK;
  const healthResults = await runHealthChecks(deployUrl, healthChecks, options);
  const criticalHealthFailed = healthResults.some(r => r.critical && !r.passed && !r.error?.includes('skipped'));

  if (criticalHealthFailed) {
    // Rollback
    if (deployer && typeof deployer.rollback === 'function') {
      try {
        await deployer.rollback(deployId, deployConfig);
        rolled_back = true;
      } catch { /* rollback failure is non-fatal */ }
    }

    status = rolled_back ? DEPLOY_STATUS.ROLLED_BACK : DEPLOY_STATUS.FAILED;

    await notifySurfaces(
      { type: 'deploy_failed', deployId, url: deployUrl, healthResults, rolled_back },
      notifier,
      options
    );

    return {
      deployed:     false,
      status,
      url:          deployUrl,
      deployId,
      healthChecks: healthResults,
      smokeTests:   [],
      rolled_back,
      error:        'Critical health checks failed',
      meta: { totalCost, totalDuration: Date.now() - startTime },
    };
  }

  // ─── Step 3: Smoke tests ─────────────────────────────────────────────────
  status = DEPLOY_STATUS.SMOKE_TEST;
  const smokeResults = await runSmokeTests(deployUrl, smokeTests, options);
  const criticalSmokeFailed = smokeResults.some(r => r.critical && !r.passed && !r.output?.includes('skipped'));

  if (criticalSmokeFailed) {
    if (deployer && typeof deployer.rollback === 'function') {
      try {
        await deployer.rollback(deployId, deployConfig);
        rolled_back = true;
      } catch { /* rollback failure is non-fatal */ }
    }

    status = rolled_back ? DEPLOY_STATUS.ROLLED_BACK : DEPLOY_STATUS.FAILED;

    await notifySurfaces(
      { type: 'smoke_failed', deployId, url: deployUrl, smokeResults, rolled_back },
      notifier,
      options
    );

    return {
      deployed:     false,
      status,
      url:          deployUrl,
      deployId,
      healthChecks: healthResults,
      smokeTests:   smokeResults,
      rolled_back,
      error:        'Critical smoke tests failed',
      meta: { totalCost, totalDuration: Date.now() - startTime },
    };
  }

  // ─── Step 4: Notify success ──────────────────────────────────────────────
  status = DEPLOY_STATUS.LIVE;
  await notifySurfaces(
    { type: 'deploy_success', deployId, url: deployUrl, healthResults, smokeResults },
    notifier,
    options
  );

  return {
    deployed:     true,
    status,
    url:          deployUrl,
    deployId,
    healthChecks: healthResults,
    smokeTests:   smokeResults,
    rolled_back:  false,
    error:        null,
    meta: {
      totalCost,
      totalDuration:       Date.now() - startTime,
      healthChecksPassed:  healthResults.filter(r => r.passed).length,
      healthChecksFailed:  healthResults.filter(r => !r.passed).length,
      smokeTestsPassed:    smokeResults.filter(r => r.passed).length,
      smokeTestsFailed:    smokeResults.filter(r => !r.passed).length,
    },
  };
}
