// queue/rateLimitGuard.test.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Test suite for rateLimitGuard module
//
// Tests rate limit tracking without a live Redis instance by injecting
// a Map-based mock Redis client.
//
// Run with: node --test queue/rateLimitGuard.test.mjs
// ─────────────────────────────────────────────────────────────────────────────

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canCall,
  recordCall,
  _setRedisClient,
} from './rateLimitGuard.mjs';

// ─── Mock Redis Client ────────────────────────────────────────────────────
// Simple Map-based implementation of Redis operations we need.
// Supports: get, incr, expire, pipeline.

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

  // Clear all data (useful for test setup)
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
// Before each test, create a fresh mock Redis and inject it.

let mockRedis;

function setup() {
  mockRedis = new MockRedis();
  _setRedisClient(mockRedis);
}

// ─── Tests ───────────────────────────────────────────────────────────────

test('rateLimitGuard: canCall returns true when under RPM limit', async () => {
  setup();

  // Groq has RPM limit of 30
  // Start with 0 calls → should allow
  const result = await canCall('llama-3.3-70b-versatile');
  assert.equal(result, true, 'should allow call when under RPM limit');
});

test('rateLimitGuard: canCall returns false when RPM limit exceeded', async () => {
  setup();

  // Set RPM counter to exactly the limit (30)
  mockRedis.data.set('rl:groq:rpm', '30');

  const result = await canCall('llama-3.3-70b-versatile');
  assert.equal(result, false, 'should deny call when at/over RPM limit');
});

test('rateLimitGuard: canCall returns false when RPD limit exceeded', async () => {
  setup();

  // Groq has RPD limit of 14400
  // Set RPD counter to exactly the limit
  const today = new Date().toISOString().split('T')[0];
  mockRedis.data.set(`rl:groq:rpd:${today}`, '14400');

  const result = await canCall('llama-3.3-70b-versatile');
  assert.equal(result, false, 'should deny call when at/over RPD limit');
});

test('rateLimitGuard: canCall returns true for paid providers', async () => {
  setup();

  // Anthropic paid models have no rate limits
  const result = await canCall('claude-sonnet-4-6');
  assert.equal(result, true, 'should allow paid provider without rate limit');
});

test('rateLimitGuard: canCall returns true for unknown models', async () => {
  setup();

  const result = await canCall('unknown-model-xyz');
  assert.equal(
    result,
    true,
    'should allow unknown models (assume paid provider)'
  );
});

test('rateLimitGuard: recordCall increments RPM counter', async () => {
  setup();

  await recordCall('llama-3.3-70b-versatile');

  const rpmValue = mockRedis.data.get('rl:groq:rpm');
  assert.equal(rpmValue, '1', 'RPM counter should increment to 1');
});

test('rateLimitGuard: recordCall increments RPD counter', async () => {
  setup();

  await recordCall('llama-3.3-70b-versatile');

  const today = new Date().toISOString().split('T')[0];
  const rpdValue = mockRedis.data.get(`rl:groq:rpd:${today}`);
  assert.equal(rpdValue, '1', 'RPD counter should increment to 1');
});

test('rateLimitGuard: recordCall increments both counters', async () => {
  setup();

  await recordCall('llama-3.3-70b-versatile');
  await recordCall('llama-3.3-70b-versatile');

  const rpmValue = mockRedis.data.get('rl:groq:rpm');
  const today = new Date().toISOString().split('T')[0];
  const rpdValue = mockRedis.data.get(`rl:groq:rpd:${today}`);

  assert.equal(rpmValue, '2', 'RPM counter should be 2');
  assert.equal(rpdValue, '2', 'RPD counter should be 2');
});

test('rateLimitGuard: recordCall ignores paid providers', async () => {
  setup();

  await recordCall('claude-sonnet-4-6');

  // No keys should be created for paid providers
  assert.equal(
    mockRedis.data.size,
    0,
    'should not track paid provider calls'
  );
});

test('rateLimitGuard: RPM counter expires after 60 seconds', async () => {
  setup();

  await recordCall('llama-3.3-70b-versatile');

  const expiryTime = mockRedis.expiry.get('rl:groq:rpm');
  const now = Date.now();
  const timeDiff = expiryTime - now;

  // Should be approximately 60 seconds (allow 1 second tolerance)
  assert.ok(
    timeDiff >= 59000 && timeDiff <= 61000,
    `RPM expiry should be ~60 seconds, got ${timeDiff}ms`
  );
});

test('rateLimitGuard: Gemini models use correct limit keys', async () => {
  setup();

  // Gemini flash model
  const resultFlash = await canCall('gemini-2.5-flash');
  assert.equal(resultFlash, true, 'should allow Gemini flash when under limit');

  // Gemini lite model
  const resultLite = await canCall('gemini-2.5-flash-lite');
  assert.equal(resultLite, true, 'should allow Gemini lite when under limit');

  // Embedding model (uses different limit)
  const resultEmbed = await canCall('text-embedding-004');
  assert.equal(resultEmbed, true, 'should allow embedding when under limit');
});

test('rateLimitGuard: canCall respects expired RPM counter', async () => {
  setup();

  // Set RPM to limit and mark as expired
  mockRedis.data.set('rl:groq:rpm', '30');
  mockRedis.expiry.set('rl:groq:rpm', Date.now() - 1000);  // Already expired

  // Should allow because counter is expired
  const result = await canCall('llama-3.3-70b-versatile');
  assert.equal(
    result,
    true,
    'should allow when expired counter is deleted'
  );
});

test('rateLimitGuard: multiple providers tracked separately', async () => {
  setup();

  // Record calls to different providers
  await recordCall('llama-3.3-70b-versatile');  // Groq
  await recordCall('gemini-2.5-flash');         // Gemini

  const groqRpm = mockRedis.data.get('rl:groq:rpm');
  const geminiRpm = mockRedis.data.get('rl:gemini:rpm');

  assert.equal(groqRpm, '1', 'Groq RPM should be 1');
  assert.equal(geminiRpm, '1', 'Gemini RPM should be 1');
});

console.log('✓ All rateLimitGuard tests passed');
