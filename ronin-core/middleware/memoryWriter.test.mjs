// ─── middleware/memoryWriter.test.mjs ────────────────────────────────────────
// Test suite for M7 RONIN Memory Writer
// Target: 30+ tests, 0 failures
// Run: node memoryWriter.test.mjs 2>&1
// ─────────────────────────────────────────────────────────────────────────────

import {
  createMemoryWriter,
  extractTurn,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_MAX_QUEUE,
} from './memoryWriter.mjs';

// ─── Test utilities ──────────────────────────────────────────────────────

let testCount = 0;
let passCount = 0;
let failCount = 0;

function test(name, fn) {
  testCount++;
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(() => {
        passCount++;
        console.log(`✓ ${name}`);
      }).catch(error => {
        failCount++;
        console.error(`✗ ${name}`);
        console.error(`  ${error.message}`);
      });
    }
    passCount++;
    console.log(`✓ ${name}`);
  } catch (error) {
    failCount++;
    console.error(`✗ ${name}`);
    console.error(`  ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ─── Mock Memory Manager ────────────────────────────────────────────────

function createMockMemoryManager() {
  const written = [];
  return {
    async write(key, data) {
      written.push({ key, data });
    },
    getWritten() { return written; },
  };
}

function createErrorMemoryManager() {
  return {
    async write() { throw new Error('Write failed'); },
  };
}

// ─── Tests: Constants ───────────────────────────────────────────────────

console.log('\n── Constants ──');

test('DEFAULT_DEBOUNCE_MS is 30s', () => {
  assertEqual(DEFAULT_DEBOUNCE_MS, 30000);
});

test('DEFAULT_MAX_QUEUE is 100', () => {
  assertEqual(DEFAULT_MAX_QUEUE, 100);
});

// ─── Tests: extractTurn ─────────────────────────────────────────────────

console.log('\n── extractTurn ──');

test('extracts user message and response', () => {
  const turn = extractTurn(
    { message: 'Hello', session_id: 'ses1' },
    { content: 'Hi there!' }
  );
  assertEqual(turn.user_message, 'Hello');
  assertEqual(turn.assistant_response, 'Hi there!');
  assertEqual(turn.session_id, 'ses1');
  assert(turn.timestamp > 0);
});

test('handles content field as alternative', () => {
  const turn = extractTurn(
    { content: 'From content' },
    { text: 'Text response' }
  );
  assertEqual(turn.user_message, 'From content');
  assertEqual(turn.assistant_response, 'Text response');
});

test('includes classification if present', () => {
  const turn = extractTurn(
    { message: 'test', classification: { complexity: 'trivial' } },
    { content: 'ok' }
  );
  assertEqual(turn.classification.complexity, 'trivial');
});

test('includes taste and skill metadata', () => {
  const turn = extractTurn(
    { message: 'x', _taste_injected: true, _skills_loaded: ['react'] },
    { content: 'y' }
  );
  assertEqual(turn.taste_injected, true);
  assert(turn.skills_loaded.includes('react'));
});

test('defaults for missing fields', () => {
  const turn = extractTurn({}, {});
  assertEqual(turn.session_id, 'default');
  assertEqual(turn.user_message, '');
  assertEqual(turn.assistant_response, '');
});

// ─── Tests: createMemoryWriter (middleware) ──────────────────────────────

console.log('\n── createMemoryWriter (middleware) ──');

await test('creates middleware function', async () => {
  const mw = createMemoryWriter();
  assertEqual(typeof mw, 'function');
  mw.shutdown();
});

await test('returns response immediately (non-blocking)', async () => {
  const mm = createMockMemoryManager();
  const mw = createMemoryWriter(mm, { debounceMs: 60000 }); // long debounce
  const request = { message: 'Hello' };
  const response = await mw(request, () => ({ content: 'Hi!' }));
  assertEqual(response.content, 'Hi!');
  // Write should NOT have happened yet (debounced)
  assertEqual(mm.getWritten().length, 0);
  mw.shutdown();
});

await test('queues turn after response', async () => {
  const mm = createMockMemoryManager();
  const mw = createMemoryWriter(mm, { debounceMs: 60000 });
  await mw({ message: 'Test' }, () => ({ content: 'Response' }));
  assertEqual(mw.getQueueDepth(), 1);
  mw.shutdown();
});

await test('flush writes all queued turns', async () => {
  const mm = createMockMemoryManager();
  const mw = createMemoryWriter(mm, { debounceMs: 60000 });
  const next = () => ({ content: 'ok' });

  await mw({ message: 'A', session_id: 's1' }, next);
  await mw({ message: 'B', session_id: 's1' }, next);
  await mw({ message: 'C', session_id: 's1' }, next);

  assertEqual(mw.getQueueDepth(), 3);
  await mw.flush();
  assertEqual(mw.getQueueDepth(), 0);
  assertEqual(mm.getWritten().length, 3);
  assertEqual(mw.getMetrics().turnsWritten, 3);
});

await test('debounce triggers write after interval', async () => {
  const mm = createMockMemoryManager();
  const mw = createMemoryWriter(mm, { debounceMs: 50 }); // 50ms debounce
  await mw({ message: 'Timed' }, () => ({ content: 'ok' }));

  // Wait for debounce
  await new Promise(r => setTimeout(r, 100));
  assertEqual(mm.getWritten().length, 1);
  mw.shutdown();
});

await test('multiple messages batch into one debounce cycle', async () => {
  const mm = createMockMemoryManager();
  const mw = createMemoryWriter(mm, { debounceMs: 100 });
  const next = () => ({ content: 'ok' });

  await mw({ message: 'A' }, next);
  await mw({ message: 'B' }, next);
  await mw({ message: 'C' }, next);

  // Wait for single debounce cycle
  await new Promise(r => setTimeout(r, 150));
  assertEqual(mm.getWritten().length, 3); // all 3 written in one batch
  mw.shutdown();
});

await test('handles null memory manager gracefully', async () => {
  const mw = createMemoryWriter(null, { debounceMs: 0 });
  await mw({ message: 'Test' }, () => ({ content: 'ok' }));
  await mw.flush();
  assertEqual(mw.getMetrics().droppedTurns, 1);
  mw.shutdown();
});

await test('handles write errors gracefully', async () => {
  const mm = createErrorMemoryManager();
  const mw = createMemoryWriter(mm, { debounceMs: 0 });
  await mw({ message: 'Failing' }, () => ({ content: 'ok' }));
  await mw.flush();
  assertEqual(mw.getMetrics().writeErrors, 1);
  mw.shutdown();
});

await test('tracks metrics — turnsQueued', async () => {
  const mm = createMockMemoryManager();
  const mw = createMemoryWriter(mm, { debounceMs: 60000 });
  const next = () => ({ content: 'ok' });

  await mw({ message: 'A' }, next);
  await mw({ message: 'B' }, next);

  assertEqual(mw.getMetrics().turnsQueued, 2);
  mw.shutdown();
});

await test('tracks metrics — flushes count', async () => {
  const mm = createMockMemoryManager();
  const mw = createMemoryWriter(mm, { debounceMs: 60000 });
  await mw.flush();
  await mw.flush();
  assertEqual(mw.getMetrics().flushes, 2);
  mw.shutdown();
});

await test('queue bounded to maxQueue', async () => {
  const mm = createMockMemoryManager();
  const mw = createMemoryWriter(mm, { debounceMs: 60000, maxQueue: 3 });
  const next = () => ({ content: 'ok' });

  for (let i = 0; i < 5; i++) {
    await mw({ message: `msg_${i}` }, next);
  }

  assertEqual(mw.getQueueDepth(), 3); // bounded
  mw.shutdown();
});

await test('shutdown clears queue and timer', async () => {
  const mm = createMockMemoryManager();
  const mw = createMemoryWriter(mm, { debounceMs: 60000 });
  await mw({ message: 'Test' }, () => ({ content: 'ok' }));
  mw.shutdown();
  assertEqual(mw.getQueueDepth(), 0);
});

await test('returns request when no next function', async () => {
  const mw = createMemoryWriter(null, { debounceMs: 60000 });
  const result = await mw({ message: 'Solo' });
  assertEqual(result.message, 'Solo');
  mw.shutdown();
});

await test('write keys include session_id and timestamp', async () => {
  const mm = createMockMemoryManager();
  const mw = createMemoryWriter(mm, { debounceMs: 0 });
  await mw({ message: 'Test', session_id: 'ses_abc' }, () => ({ content: 'ok' }));
  await mw.flush();

  const key = mm.getWritten()[0].key;
  assert(key.includes('ses_abc'));
  assert(key.startsWith('memory:turn:'));
  mw.shutdown();
});

// ─── Summary ─────────────────────────────────────────────────────────────

await new Promise(r => setTimeout(r, 200));

console.log(`\n${'─'.repeat(60)}`);
console.log(`M7 memoryWriter: ${passCount}/${testCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
