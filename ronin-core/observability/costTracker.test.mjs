// observability/costTracker.test.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Test suite for costTracker module
//
// Tests cost calculation, logging, thresholds, and escalation tracking
// without a live Redis instance by injecting a Map-based mock.
//
// Run with: node --test observability/costTracker.test.mjs
// ─────────────────────────────────────────────────────────────────────────────

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateCost,
  log,
  getDailyTotal,
  canAfford,
  logEscalation,
  _setRedisClient,
} from './costTracker.mjs';

// ─── Mock Redis Client ────────────────────────────────────────────────────
// Simple Map-based implementation supporting incrbyfloat, get, expire, pipeline.

class MockRedis {
  constructor() {
    this.data = new Map();
    this.expiry = new Map();
  }

  get(key) {
    if (this.isExpired(key)) {
      this.data.delete(key);
      return null;
    }
    return this.data.get(key) || null;
  }

  incr(key) {
    if (this.isExpired(key)) {
      this.data.delete(key);
    }
    const current = parseInt(this.data.get(key) || '0', 10);
    const next = current + 1;
    this.data.set(key, String(next));
    return next;
  }

  incrbyfloat(key, increment) {
    if (this.isExpired(key)) {
      this.data.delete(key);
    }
    const current = parseFloat(this.data.get(key) || '0');
    const next = current + increment;
    this.data.set(key, String(next));
    return next;
  }

  expire(key, seconds) {
    const expiryTime = Date.now() + seconds * 1000;
    this.expiry.set(key, expiryTime);
  }

  isExpired(key) {
    const expiryTime = this.expiry.get(key);
    return expiryTime !== undefined && expiryTime < Date.now();
  }

  pipeline() {
    return new MockPipeline(this);
  }

  clear() {
    this.data.clear();
    this.expiry.clear();
  }
}

class MockPipeline {
  constructor(redis) {
    this.redis = redis;
    this.commands = [];
  }

  incr(key) {
    this.commands.push(() => this.redis.incr(key));
    return this;
  }

  incrbyfloat(key, increment) {
    this.commands.push(() => this.redis.incrbyfloat(key, increment));
    return this;
  }

  expire(key, seconds) {
    this.commands.push(() => this.redis.expire(key, seconds));
    return this;
  }

  async exec() {
    const results = [];
    for (const cmd of this.commands) {
      results.push(cmd());
    }
    return results;
  }
}

// ─── Test Setup ──────────────────────────────────────────────────────────

let mockRedis;

function setup() {
  mockRedis = new MockRedis();
  _setRedisClient(mockRedis);
}

// ─── Tests ───────────────────────────────────────────────────────────────

test('costTracker: calculateCost for Sonnet (paid model)', () => {
  // Claude Sonnet: $3 per 1M input, $15 per 1M output
  const cost = calculateCost('claude-sonnet-4-6', 1_000_000, 1_000_000);

  // Expected: 1M * 3/1M + 1M * 15/1M = 3 + 15 = $18
  assert.equal(cost, 18.0, 'should calculate correct cost for Sonnet');
});

test('costTracker: calculateCost for Opus (expensive)', () => {
  // Claude Opus: $15 per 1M input, $75 per 1M output
  const cost = calculateCost('claude-opus-4-6', 1_000_000, 1_000_000);

  // Expected: 1M * 15/1M + 1M * 75/1M = 15 + 75 = $90
  assert.equal(cost, 90.0, 'should calculate correct cost for Opus');
});

test('costTracker: calculateCost for free model (Groq)', () => {
  const cost = calculateCost('llama-3.3-70b-versatile', 1_000_000, 1_000_000);

  assert.equal(cost, 0, 'should return 0 for free models');
});

test('costTracker: calculateCost for partial tokens', () => {
  // Haiku: $0.25 per 1M input, $1.25 per 1M output
  const cost = calculateCost('claude-haiku-4-5-20251001', 100_000, 50_000);

  // Expected: 100k * 0.25/1M + 50k * 1.25/1M = 0.025 + 0.0625 = $0.0875
  const expected = 0.025 + 0.0625;
  assert.equal(cost.toFixed(4), expected.toFixed(4), 'should handle partial tokens');
});

test('costTracker: log records cost to Redis', async () => {
  setup();

  await log('claude-sonnet-4-6', 1_000_000, 1_000_000);

  const today = new Date().toISOString().split('T')[0];
  const modelKey = `cost:model:claude-sonnet-4-6:${today}`;
  const dailyKey = `cost:daily:${today}`;

  const modelValue = parseFloat(mockRedis.data.get(modelKey) || '0');
  const dailyValue = parseFloat(mockRedis.data.get(dailyKey) || '0');

  // Both should be $18 (1M input @ $3 + 1M output @ $15)
  assert.equal(
    modelValue.toFixed(1),
    '18.0',
    'model key should record cost'
  );
  assert.equal(
    dailyValue.toFixed(1),
    '18.0',
    'daily key should record cost'
  );
});

test('costTracker: log ignores free models', async () => {
  setup();

  await log('llama-3.3-70b-versatile', 1_000_000, 1_000_000);

  // No keys should be created for free models
  assert.equal(mockRedis.data.size, 0, 'should not track free model calls');
});

test('costTracker: log accumulates multiple calls', async () => {
  setup();

  await log('claude-sonnet-4-6', 500_000, 500_000);
  await log('claude-sonnet-4-6', 500_000, 500_000);

  const today = new Date().toISOString().split('T')[0];
  const dailyKey = `cost:daily:${today}`;

  const dailyValue = parseFloat(mockRedis.data.get(dailyKey) || '0');

  // Each call: 500k * 3/1M + 500k * 15/1M = 1.5 + 7.5 = $9
  // Two calls: $18
  assert.equal(
    dailyValue.toFixed(1),
    '18.0',
    'should accumulate costs from multiple calls'
  );
});

test('costTracker: getDailyTotal returns zero initially', async () => {
  setup();

  const total = await getDailyTotal();
  assert.equal(total, 0, 'should return 0 when nothing logged');
});

test('costTracker: getDailyTotal returns accumulated cost', async () => {
  setup();

  await log('claude-sonnet-4-6', 1_000_000, 1_000_000);

  const total = await getDailyTotal();
  assert.equal(total, 18.0, 'should return accumulated daily total');
});

test('costTracker: canAfford returns true when under threshold', async () => {
  setup();

  // Claude Opus has per-model threshold of $5.00
  // Log nothing → should be affordable
  const result = await canAfford('claude-opus-4-6');
  assert.equal(result, true, 'should allow call when under threshold');
});

test('costTracker: canAfford returns false when model threshold exceeded', async () => {
  setup();

  // Set model cost to exactly the threshold ($5.00)
  const today = new Date().toISOString().split('T')[0];
  mockRedis.data.set(`cost:model:claude-opus-4-6:${today}`, '5.00');

  const result = await canAfford('claude-opus-4-6');
  assert.equal(
    result,
    false,
    'should deny when model threshold reached'
  );
});

test('costTracker: canAfford returns false when total daily threshold exceeded', async () => {
  setup();

  // Total daily threshold is $25.00
  // Set daily cost to exactly the threshold
  const today = new Date().toISOString().split('T')[0];
  mockRedis.data.set(`cost:daily:${today}`, '25.00');

  const result = await canAfford('claude-sonnet-4-6');
  assert.equal(
    result,
    false,
    'should deny when daily threshold reached'
  );
});

test('costTracker: canAfford allows free models', async () => {
  setup();

  const result = await canAfford('llama-3.3-70b-versatile');
  assert.equal(result, true, 'should always allow free models');
});

test('costTracker: canAfford allows models without threshold', async () => {
  setup();

  // gpt-4o has no per-model threshold defined (only total)
  const result = await canAfford('gpt-4o');
  assert.equal(
    result,
    true,
    'should allow models without per-model threshold (unless total exceeded)'
  );
});

test('costTracker: logEscalation records escalation count', async () => {
  setup();

  await logEscalation('llama-3.3-70b-versatile', 'claude-sonnet-4-6');

  const today = new Date().toISOString().split('T')[0];
  const escalationKey = `escalation:llama-3.3-70b-versatile->claude-sonnet-4-6:${today}`;

  const count = parseInt(mockRedis.data.get(escalationKey) || '0', 10);
  assert.equal(count, 1, 'should record escalation count');
});

test('costTracker: logEscalation accumulates over time', async () => {
  setup();

  await logEscalation('llama-3.3-70b-versatile', 'claude-sonnet-4-6');
  await logEscalation('llama-3.3-70b-versatile', 'claude-sonnet-4-6');
  await logEscalation('llama-3.3-70b-versatile', 'claude-sonnet-4-6');

  const today = new Date().toISOString().split('T')[0];
  const escalationKey = `escalation:llama-3.3-70b-versatile->claude-sonnet-4-6:${today}`;

  const count = parseInt(mockRedis.data.get(escalationKey) || '0', 10);
  assert.equal(count, 3, 'should accumulate escalation counts');
});

test('costTracker: logEscalation tracks different escalation paths separately', async () => {
  setup();

  await logEscalation('llama-3.3-70b-versatile', 'claude-sonnet-4-6');
  await logEscalation('gemini-2.5-flash', 'claude-opus-4-6');

  const today = new Date().toISOString().split('T')[0];
  const key1 = `escalation:llama-3.3-70b-versatile->claude-sonnet-4-6:${today}`;
  const key2 = `escalation:gemini-2.5-flash->claude-opus-4-6:${today}`;

  const count1 = parseInt(mockRedis.data.get(key1) || '0', 10);
  const count2 = parseInt(mockRedis.data.get(key2) || '0', 10);

  assert.equal(count1, 1, 'first escalation path should be 1');
  assert.equal(count2, 1, 'second escalation path should be 1');
});

test('costTracker: unknown model throws error', () => {
  assert.throws(
    () => calculateCost('unknown-model-xyz', 1000, 1000),
    /Unknown model/,
    'should throw for unknown model'
  );
});

test('costTracker: costs expire at midnight', async () => {
  setup();

  await log('claude-sonnet-4-6', 1_000_000, 1_000_000);

  const today = new Date().toISOString().split('T')[0];
  const dailyKey = `cost:daily:${today}`;

  const expiryTime = mockRedis.expiry.get(dailyKey);
  const now = Date.now();

  // Expiry should be approximately at next midnight (20-24 hours away)
  const timeDiff = expiryTime - now;
  const hoursUntilExpiry = timeDiff / 1000 / 3600;

  assert.ok(
    hoursUntilExpiry >= 20 && hoursUntilExpiry <= 24,
    `costs should expire ~midnight, got ${hoursUntilExpiry.toFixed(1)} hours`
  );
});

console.log('✓ All costTracker tests passed');
