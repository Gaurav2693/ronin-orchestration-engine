// middleware/byokMiddleware.mjs
// ─────────────────────────────────────────────────────────────────────────────
// RONIN BYOK Middleware — Slot #0 in the pipeline (runs first)
//
// Checks if the requesting user has registered their own API keys.
// If they have, attaches ephemeral provider instances to request._byok.
// Downstream (workers, runTask) check request._byok before using system keys.
//
// Pipeline position: Slot #0 — MUST run before all other middleware so that
// any downstream middleware that touches providers gets the user's instances.
//
// Flow:
//   request.userId set → check byokRegistry → create providers → attach to request
//   no userId or no BYOK → pass through (system keys used as normal)
//
// Usage with pipeline:
//   import { createByokMiddleware } from './middleware/byokMiddleware.mjs';
//   const byok = createByokMiddleware(byokRegistry);
//   pipeline.use(byok.middleware);
//
// Usage in workers/execution:
//   const provider = getProviderForRequest('anthropic', request);
//   // returns user's AnthropicProvider if BYOK, else system singleton
// ─────────────────────────────────────────────────────────────────────────────

import { byokRegistry as defaultRegistry } from '../config/byokRegistry.mjs';
import { getProvider } from '../models/providerRegistry.mjs';

// ─── createByokMiddleware ─────────────────────────────────────────────────────

export function createByokMiddleware(registry = defaultRegistry, options = {}) {
  const { silent = false } = options;

  // ─── Middleware function ─────────────────────────────────────────────────
  // Attaches request._byok = { providers, _isByok, _userId } or null

  async function middleware(request, next) {
    const userId = request.userId || request.user?.id || request.operatorId;

    if (!userId) {
      // No user context — system keys will be used downstream
      request._byok = null;
      return next();
    }

    if (!registry.has(userId)) {
      // User hasn't registered any BYOK keys — system keys used
      request._byok = null;
      return next();
    }

    try {
      const providers = await registry.getProviders(userId);

      if (providers) {
        request._byok = providers;
        if (!silent) {
          const which = Object.keys(providers).filter(k => !k.startsWith('_'));
          console.log(`[byokMiddleware] BYOK active for ${userId} — providers: ${which.join(', ')}`);
        }
      } else {
        request._byok = null;
      }
    } catch (err) {
      // Never let BYOK failures break a request — fall back to system keys
      console.error(`[byokMiddleware] Error loading BYOK providers for ${userId}: ${err.message}`);
      request._byok = null;
    }

    return next();
  }

  // ─── getProviderForRequest ───────────────────────────────────────────────
  // The primary consumption API — used by workers and runTask.
  // Returns BYOK provider instance if available, else system singleton.

  function getProviderForRequest(providerName, request) {
    if (request?._byok?.[providerName]) {
      return request._byok[providerName];
    }
    // Fall back to system provider
    return getProvider(providerName);
  }

  return {
    middleware,
    getProviderForRequest,
  };
}

// ─── Singleton default instance ─────────────────────────────────────────────

const _defaultInstance = createByokMiddleware(defaultRegistry);
export const byokMiddleware = _defaultInstance.middleware;
export const getProviderForRequest = _defaultInstance.getProviderForRequest;
