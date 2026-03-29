// queue/rateLimitGuard.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Rate limit tracking for free-tier providers (Groq, Gemini).
//
// Maintains two Redis keys per provider:
//   - `rl:{provider}:rpm` — requests in the current minute (expires after 60s)
//   - `rl:{provider}:rpd:{date}` — requests in the current day (expires at midnight)
//
// This module prevents hitting provider API quotas by checking limits before
// each call, and recording the call afterwards. Cost guardrails are handled
// by costTracker.mjs; this module is rate-limit only.
//
// Lazy Redis init: Redis client is NOT created on import. Instead, it connects
// on first use. This lets tests run without a live Redis instance.
// ─────────────────────────────────────────────────────────────────────────────

import Redis from 'ioredis';
import { RATE_LIMITS, getModelsByProvider } from '../config/modelConfig.mjs';

// ─── Redis Client (Lazy Init) ─────────────────────────────────────────────
// Singleton Redis client. Created on first call to canCall() or recordCall().
// Tests can inject a mock via _setRedisClient().

let redisClient = null;

function getRedisClient() {
  if (!redisClient) {
    redisClient = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      maxRetriesPerRequest: null,
      retryStrategy: (times) => Math.min(times * 50, 2000),
    });
  }
  return redisClient;
}

export function _setRedisClient(client) {
  redisClient = client;
}

// ─── Provider Mapping ─────────────────────────────────────────────────────
// Map provider names to their rate limit config keys.
// This ensures we look up the right limit from RATE_LIMITS.

const PROVIDER_LIMIT_KEYS = {
  groq: 'groq',
  gemini: 'gemini_flash',  // Gemini models use different limits
};

// ─── Build provider → [modelIds] map ────────────────────────────────────
// Used to check if a model belongs to a free-tier provider.

const FREE_TIER_PROVIDERS = new Set(['groq', 'gemini']);
const PROVIDER_MODELS = {};

for (const provider of FREE_TIER_PROVIDERS) {
  const models = getModelsByProvider(provider);
  PROVIDER_MODELS[provider] = new Set(models.map((m) => m.modelId));
}

// ─── Determine Rate Limit Key for Gemini Models ──────────────────────────
// Gemini has different limits for different models (flash vs lite vs embed).
// This function picks the right limit key based on model name.

function getGeminiLimitKey(modelId) {
  if (modelId.includes('embedding')) {
    return 'gemini_embed';
  } else if (modelId.includes('flash-lite')) {
    return 'gemini_lite';
  } else {
    return 'gemini_flash';
  }
}

// ─── canCall(modelId) ──────────────────────────────────────────────────────
// Check if a call to this model is allowed under rate limits.
//
// Returns: true if call is safe, false if we've hit a rate limit.
//
// Rules:
//   - Paid providers (Anthropic, OpenAI) → always true (no rate limit)
//   - Free providers (Groq, Gemini) → check RPM and RPD limits from Redis
//   - Unknown providers → safely assume it's paid, return true
//
// Note: This is a synchronous check. For Groq, we check 'rpm' and 'rpd'.
// For Gemini, we check the specific limit key (flash vs lite vs embed).

export async function canCall(modelId) {
  // Look up which provider this model belongs to
  let provider = null;
  for (const [prov, modelIds] of Object.entries(PROVIDER_MODELS)) {
    if (modelIds.has(modelId)) {
      provider = prov;
      break;
    }
  }

  // Paid provider or unknown → no rate limit
  if (!provider) {
    return true;
  }

  const redis = getRedisClient();

  // Determine which rate limit key to use
  let limitKey = PROVIDER_LIMIT_KEYS[provider];
  if (provider === 'gemini') {
    limitKey = getGeminiLimitKey(modelId);
  }

  const limits = RATE_LIMITS[limitKey];
  if (!limits) {
    // No rate limit defined → allow the call
    return true;
  }

  // Check RPM (requests per minute)
  if (limits.rpm !== undefined) {
    const rpmKey = `rl:${provider}:rpm`;
    const rpm = parseInt(await redis.get(rpmKey) || '0', 10);
    if (rpm >= limits.rpm) {
      return false;  // Over RPM limit
    }
  }

  // Check RPD (requests per day)
  if (limits.rpd !== undefined) {
    const today = new Date().toISOString().split('T')[0];
    const rpdKey = `rl:${provider}:rpd:${today}`;
    const rpd = parseInt(await redis.get(rpdKey) || '0', 10);
    if (rpd >= limits.rpd) {
      return false;  // Over RPD limit
    }
  }

  return true;  // All checks passed
}

// ─── recordCall(modelId) ──────────────────────────────────────────────────
// Record a call to this model by incrementing rate limit counters.
//
// This should be called AFTER a successful API call, to update counters.
// Uses Redis pipeline for atomicity: both RPM and RPD are incremented in
// a single round-trip.

export async function recordCall(modelId) {
  // Find provider
  let provider = null;
  for (const [prov, modelIds] of Object.entries(PROVIDER_MODELS)) {
    if (modelIds.has(modelId)) {
      provider = prov;
      break;
    }
  }

  // Paid provider → no tracking needed
  if (!provider) {
    return;
  }

  const redis = getRedisClient();

  // Determine rate limit key
  let limitKey = PROVIDER_LIMIT_KEYS[provider];
  if (provider === 'gemini') {
    limitKey = getGeminiLimitKey(modelId);
  }

  const limits = RATE_LIMITS[limitKey];
  if (!limits) {
    return;  // No limits defined, nothing to track
  }

  // Build pipeline to increment both counters atomically
  const pipeline = redis.pipeline();

  if (limits.rpm !== undefined) {
    const rpmKey = `rl:${provider}:rpm`;
    pipeline.incr(rpmKey);
    pipeline.expire(rpmKey, 60);  // RPM counter expires after 60 seconds
  }

  if (limits.rpd !== undefined) {
    const today = new Date().toISOString().split('T')[0];
    const rpdKey = `rl:${provider}:rpd:${today}`;
    pipeline.incr(rpdKey);

    // RPD counter expires at midnight (next day)
    // Calculate seconds until next midnight
    const now = new Date();
    const nextMidnight = new Date(now);
    nextMidnight.setDate(nextMidnight.getDate() + 1);
    nextMidnight.setHours(0, 0, 0, 0);
    const secondsUntilMidnight = Math.floor(
      (nextMidnight - now) / 1000
    );
    pipeline.expire(rpdKey, secondsUntilMidnight);
  }

  // Execute pipeline
  await pipeline.exec();
}

// ─── Export Signature ──────────────────────────────────────────────────────

export default {
  canCall,
  recordCall,
  _setRedisClient,
};
