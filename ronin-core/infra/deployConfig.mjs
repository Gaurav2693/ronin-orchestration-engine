// infra/deployConfig.mjs
// ─────────────────────────────────────────────────────────────────────────────
// I3: Coolify Deployment Configuration
//
// Manages deployment configuration for Coolify (self-hosted PaaS).
// Generates Coolify-compatible deployment manifests, validates config,
// and provides a deployer adapter that integrates with Gate 08 (deployVerify).
//
// Coolify API: https://coolify.io/docs/api
// Key concepts:
//   - Applications: deployed services with a source, environment, and runtime
//   - Environments: production, staging, preview
//   - Deployments: triggered deployments with build logs
//
// Usage:
//   const config = createDeployConfig({ apiUrl, apiToken, appId });
//   const deployer = config.getDeployer();
//   // Pass deployer to deployVerify gate
// ─────────────────────────────────────────────────────────────────────────────

// ─── Deploy Environments ──────────────────────────────────────────────────────

export const DEPLOY_ENV = {
  PRODUCTION: 'production',
  STAGING:    'staging',
  PREVIEW:    'preview',
};

// ─── App Runtime Types ────────────────────────────────────────────────────────

export const RUNTIME = {
  NODEJS:   'nodejs',
  DOCKER:   'docker',
  STATIC:   'static',
  NIXPACKS: 'nixpacks',
};

// ─── Deployment manifest schema ───────────────────────────────────────────────

export function createDeployManifest(overrides = {}) {
  return {
    appId:       null,          // Coolify application UUID
    environment: DEPLOY_ENV.STAGING,
    runtime:     RUNTIME.NIXPACKS,
    buildPack:   'nixpacks',
    startCommand: null,
    buildCommand: null,
    envVars:     {},            // { KEY: value } — injected into container
    ports:       [3000],
    healthPath:  '/health',
    domains:     [],
    resourceLimits: {
      memory: '512m',
      cpu:    '0.5',
    },
    ...overrides,
  };
}

// ─── Validate deploy config ───────────────────────────────────────────────────

export function validateDeployConfig(config) {
  const errors   = [];
  const warnings = [];

  if (!config.apiUrl) errors.push('apiUrl is required');
  if (!config.apiToken) errors.push('apiToken is required');
  if (!config.appId && !config.applicationUuid) errors.push('appId or applicationUuid is required');

  if (config.environment === DEPLOY_ENV.PRODUCTION) {
    if (!config.domains || config.domains.length === 0) {
      warnings.push('Production deployments should have domains configured');
    }
  }

  if (config.resourceLimits?.memory) {
    const mem = parseInt(config.resourceLimits.memory, 10);
    if (mem < 128) warnings.push('Memory limit below 128m may cause OOM');
  }

  return {
    valid:    errors.length === 0,
    errors,
    warnings,
  };
}

// ─── Coolify API client ───────────────────────────────────────────────────────

export function createCoolifyClient(apiUrl, apiToken, options = {}) {
  const fetchFn = 'fetch' in options
    ? options.fetch
    : (typeof globalThis.fetch === 'function' ? globalThis.fetch : null);
  const silent  = options.silent || false;

  function _log(...args) {
    if (!silent) console.log('[CoolifyClient]', ...args);
  }

  async function _request(method, path, body = null) {
    if (!fetchFn) {
      // No fetch — return mock response for testing / sandbox environments
      return { ok: true, status: 200, data: { message: 'noop', uuid: `deploy_${Date.now()}` } };
    }

    const url     = `${apiUrl.replace(/\/$/, '')}/api/v1${path}`;
    const headers = {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
    };

    const response = await fetchFn(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(`Coolify API ${method} ${path} → ${response.status}: ${JSON.stringify(data)}`);
    }

    return { ok: true, status: response.status, data };
  }

  return {
    // Trigger a deployment
    async deploy(appId) {
      _log(`triggering deploy for app ${appId}`);
      return _request('POST', `/deploy?uuid=${appId}&force=false`);
    },

    // Get deployment status
    async getDeploymentStatus(deploymentUuid) {
      return _request('GET', `/deployments/${deploymentUuid}`);
    },

    // Update environment variables
    async setEnvVars(appId, envVars) {
      const vars = Object.entries(envVars).map(([key, value]) => ({
        key, value, is_secret: key.toLowerCase().includes('secret') || key.toLowerCase().includes('key'),
      }));
      return _request('POST', `/applications/${appId}/envs/bulk`, { data: vars });
    },

    // Get application info
    async getApplication(appId) {
      return _request('GET', `/applications/${appId}`);
    },

    // Rollback to previous deployment
    async rollback(deploymentUuid) {
      _log(`rolling back deployment ${deploymentUuid}`);
      return _request('POST', `/deployments/${deploymentUuid}/rollback`);
    },

    // List recent deployments
    async listDeployments(appId, limit = 5) {
      return _request('GET', `/applications/${appId}/deployments?limit=${limit}`);
    },
  };
}

// ─── Deploy config factory ────────────────────────────────────────────────────

export function createDeployConfig(options = {}) {
  const {
    apiUrl,
    apiToken,
    appId,
    environment = DEPLOY_ENV.STAGING,
    healthPath  = '/health',
    domains     = [],
    envVars     = {},
    silent      = false,
    fetch,
  } = options;

  const manifest = createDeployManifest({
    appId,
    environment,
    healthPath,
    domains,
    envVars,
  });

  const validation = validateDeployConfig({ apiUrl, apiToken, appId, ...manifest });

  function _log(...args) {
    if (!silent) console.log('[DeployConfig]', ...args);
  }

  // ─── Deployer adapter for Gate 08 (deployVerify) ────────────────────────
  function getDeployer() {
    if (!apiUrl || !apiToken || !appId) {
      // No-op deployer for environments without Coolify
      return {
        async deploy(buildOutput, config = {}) {
          _log('no-op deployer (Coolify not configured)');
          return {
            url:      config.mockUrl || 'http://localhost:3000',
            id:       `noop_deploy_${Date.now()}`,
            cost:     0,
          };
        },
        async rollback(deployId) {
          _log(`no-op rollback for ${deployId}`);
        },
      };
    }

    const client = createCoolifyClient(apiUrl, apiToken, { fetch, silent });

    return {
      async deploy(buildOutput, config = {}) {
        // Inject env vars if provided
        if (Object.keys(envVars).length > 0) {
          await client.setEnvVars(appId, envVars).catch(err => {
            _log(`warning: could not set env vars: ${err.message}`);
          });
        }

        const deployResult = await client.deploy(appId);
        const deployUuid   = deployResult.data?.uuid || deployResult.data?.deployment_uuid;

        // Wait briefly for deployment to start
        await new Promise(resolve => setTimeout(resolve, 500));

        const statusResult = await client.getDeploymentStatus(deployUuid).catch(() => ({ data: {} }));
        const deployUrl    = statusResult.data?.url || domains[0] || `https://${appId}.${apiUrl.replace(/https?:\/\//, '')}`;

        return {
          url:  deployUrl,
          id:   deployUuid,
          cost: 0,
        };
      },

      async rollback(deployId) {
        if (deployId) {
          await client.rollback(deployId).catch(err => {
            _log(`rollback warning: ${err.message}`);
          });
        }
      },
    };
  }

  return {
    manifest,
    validation,
    getDeployer,
    // Expose for introspection
    getConfig: () => ({ apiUrl, appId, environment, domains }),
  };
}

// ─── Environment-specific config builders ─────────────────────────────────────

export function productionConfig(appId, domain, options = {}) {
  return createDeployConfig({
    ...options,
    appId,
    environment: DEPLOY_ENV.PRODUCTION,
    domains:     [domain],
    envVars:     { NODE_ENV: 'production', ...options.envVars },
  });
}

export function stagingConfig(appId, options = {}) {
  return createDeployConfig({
    ...options,
    appId,
    environment: DEPLOY_ENV.STAGING,
    envVars:     { NODE_ENV: 'staging', ...options.envVars },
  });
}

export function previewConfig(appId, branch, options = {}) {
  return createDeployConfig({
    ...options,
    appId:      `${appId}-preview-${branch}`,
    environment: DEPLOY_ENV.PREVIEW,
    envVars:    { NODE_ENV: 'preview', BRANCH: branch, ...options.envVars },
  });
}
