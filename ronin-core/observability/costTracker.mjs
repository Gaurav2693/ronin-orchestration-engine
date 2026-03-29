// observability/costTracker.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Token cost tracking per model, per day.
//
// This module monitors spending on LLM API calls and enforces daily thresholds
// (per-model and total) to prevent runaway costs. It logs every token, calculates
// USD cost, checks affordability before calls, and tracks model escalations.
//
// Redis keys:
//   - `cost:daily:{date}` — total spend for the day (aggregated across all models)
//   - `cost:model:{modelId}:{date}` — spend for a specific model on that date
//   - `escalation:{fromModel}->{toModel}:{date}` — count of escalations
//
// Lazy Redis init: Redis client is NOT created on import. Tests can inject
// a mock via _setRedisClient().
// ─────────────────────────────────────────────────────────────────────────────

import Redis from 'ioredis';
import { MODELS, COST_THRESHOLDS, getModelConfig } from '../config/modelConfig.mjs';

// ─── Redis Client (Lazy Init) ─────────────────────────────────────────────
// Singleton Redis client. Created on first call to any function.
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

// ─── calculateCost(modelId, inputTokens, outputTokens) ──────────────────
// Calculate USD cost for a single API call.
//
// Returns: USD number (e.g., 0.042 for $0.042)
// Returns 0 for free models.
//
// Formula:
//   cost = (inputTokens / 1_000_000 * inputPricePerM) +
//           (outputTokens / 1_000_000 * outputPricePerM)

export function calculateCost(modelId, inputTokens, outputTokens) {
  const model = MODELS[modelId];
  if (!model) {
    throw new Error(`[costTracker] Unknown model: ${modelId}`);
  }

  // Free models return 0
  if (model.cost.input === 0 && model.cost.output === 0) {
    return 0;
  }

  const inputCost = (inputTokens / 1_000_000) * model.cost.input;
  const outputCost = (outputTokens / 1_000_000) * model.cost.output;

  return inputCost + outputCost;
}

// ─── log(modelId, inputTokens, outputTokens, meta) ─────────────────────
// Record a token usage event in Redis.
//
// Updates two counters:
//   1. `cost:model:{modelId}:{date}` — cost for this specific model today
//   2. `cost:daily:{date}` — total cost across all models today
//
// Arguments:
//   meta — optional object with {requestId, userId, context} for observability
//          (not stored in Redis, but useful for logging)

export async function log(
  modelId,
  inputTokens,
  outputTokens,
  meta = {}
) {
  const model = MODELS[modelId];
  if (!model) {
    throw new Error(`[costTracker] Unknown model: ${modelId}`);
  }

  const cost = calculateCost(modelId, inputTokens, outputTokens);

  // Free models don't need tracking
  if (cost === 0) {
    return;
  }

  const redis = getRedisClient();
  const today = new Date().toISOString().split('T')[0];

  // Build pipeline to update both counters atomically
  const pipeline = redis.pipeline();

  // Increment model-specific cost
  const modelKey = `cost:model:${modelId}:${today}`;
  pipeline.incrbyfloat(modelKey, cost);

  // Increment daily total
  const dailyKey = `cost:daily:${today}`;
  pipeline.incrbyfloat(dailyKey, cost);

  // Both expire at midnight tomorrow
  const now = new Date();
  const nextMidnight = new Date(now);
  nextMidnight.setDate(nextMidnight.getDate() + 1);
  nextMidnight.setHours(0, 0, 0, 0);
  const secondsUntilMidnight = Math.floor((nextMidnight - now) / 1000);

  pipeline.expire(modelKey, secondsUntilMidnight);
  pipeline.expire(dailyKey, secondsUntilMidnight);

  // Execute pipeline
  await pipeline.exec();
}

// ─── getDailyTotal() ──────────────────────────────────────────────────────
// Get the total spend for today across all models.
//
// Returns: USD number (e.g., 15.42 for $15.42)
// Returns 0 if nothing spent yet.

export async function getDailyTotal() {
  const redis = getRedisClient();
  const today = new Date().toISOString().split('T')[0];
  const dailyKey = `cost:daily:${today}`;

  const value = await redis.get(dailyKey);
  return parseFloat(value || '0');
}

// ─── canAfford(modelId) ───────────────────────────────────────────────────
// Check if we can afford to call this model right now.
//
// Returns: true if within all thresholds, false if calling would exceed limits.
//
// Checks two thresholds:
//   1. Per-model threshold: COST_THRESHOLDS.daily[modelId]
//   2. Total daily threshold: COST_THRESHOLDS.daily.total
//
// If no threshold is defined for a model, assume unlimited and return true.

export async function canAfford(modelId) {
  const model = MODELS[modelId];
  if (!model) {
    throw new Error(`[costTracker] Unknown model: ${modelId}`);
  }

  // Free models are always affordable
  if (model.cost.input === 0 && model.cost.output === 0) {
    return true;
  }

  const redis = getRedisClient();
  const today = new Date().toISOString().split('T')[0];

  // Check per-model threshold
  const modelThreshold = COST_THRESHOLDS.daily[modelId];
  if (modelThreshold !== undefined) {
    const modelKey = `cost:model:${modelId}:${today}`;
    const modelSpent = parseFloat(await redis.get(modelKey) || '0');

    if (modelSpent >= modelThreshold) {
      return false;  // Model daily limit exceeded
    }
  }

  // Check total daily threshold
  const totalThreshold = COST_THRESHOLDS.daily.total;
  if (totalThreshold !== undefined) {
    const dailyKey = `cost:daily:${today}`;
    const totalSpent = parseFloat(await redis.get(dailyKey) || '0');

    if (totalSpent >= totalThreshold) {
      return false;  // Total daily limit exceeded
    }
  }

  return true;  // All checks passed
}

// ─── logEscalation(fromModelId, toModelId) ────────────────────────────────
// Record that we escalated from one model to another.
//
// This tracks when the router decides a cheaper model can't handle the task
// and escalates to a more capable (expensive) model. Useful for understanding
// cost drivers and model utilization patterns.
//
// Arguments:
//   fromModelId — the model we tried first (cheaper)
//   toModelId — the model we escalated to (more capable, usually more expensive)

export async function logEscalation(fromModelId, toModelId) {
  const redis = getRedisClient();
  const today = new Date().toISOString().split('T')[0];

  const escalationKey = `escalation:${fromModelId}->${toModelId}:${today}`;

  // Increment the escalation counter
  const pipeline = redis.pipeline();
  pipeline.incr(escalationKey);

  // Expire at midnight tomorrow
  const now = new Date();
  const nextMidnight = new Date(now);
  nextMidnight.setDate(nextMidnight.getDate() + 1);
  nextMidnight.setHours(0, 0, 0, 0);
  const secondsUntilMidnight = Math.floor((nextMidnight - now) / 1000);

  pipeline.expire(escalationKey, secondsUntilMidnight);

  // Execute pipeline
  await pipeline.exec();
}

// ─── Export Signature ──────────────────────────────────────────────────────

export default {
  calculateCost,
  log,
  getDailyTotal,
  canAfford,
  logEscalation,
  _setRedisClient,
};
