// ─── workers/agentWorker.test.mjs ─────────────────────────────────────────────
// Tests for RONIN Agent Worker (W4)
// Run: node agentWorker.test.mjs 2>&1
// ─────────────────────────────────────────────────────────────────────────────

import { createAgentWorker, createToolRegistry, buildAgentMessages } from './agentWorker.mjs';
import { WORKER_STATES } from './workerInterface.mjs';

let testCount = 0;
let passCount = 0;
let failCount = 0;

function test(name, fn) {
  testCount++;
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(() => { passCount++; console.log(`✓ ${name}`); })
        .catch(e => { failCount++; console.error(`✗ ${name}\n  ${e.message}`); });
    }
    passCount++;
    console.log(`✓ ${name}`);
  } catch (e) {
    failCount++;
    console.error(`✗ ${name}\n  ${e.message}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }
function assertEqual(a, b, m) { if (a !== b) throw new Error(m || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function assertThrows(fn, msg) {
  try { fn(); throw new Error('Expected to throw'); }
  catch (e) { if (e.message === 'Expected to throw') throw e; if (msg) assert(e.message.includes(msg), `Expected "${msg}" in "${e.message}"`); }
}

// ─── Mock Provider ──────────────────────────────────────────────────────

function mockProvider(responses = []) {
  let callIndex = 0;
  const calls = [];
  return {
    calls,
    complete: async (messages, opts) => {
      calls.push({ messages, opts });
      const resp = responses[callIndex] || responses[responses.length - 1] || { content: 'Done.' };
      callIndex++;
      return {
        content: resp.content || 'Done.',
        toolCalls: resp.toolCalls || null,
        usage: resp.usage || { inputTokens: 100, outputTokens: 50 },
      };
    },
  };
}

// ─── createToolRegistry ─────────────────────────────────────────────────

console.log('\n── createToolRegistry ──');

test('creates empty registry', () => {
  const reg = createToolRegistry();
  assertEqual(reg.listTools().length, 0);
});

test('registers and retrieves tool', () => {
  const reg = createToolRegistry();
  reg.register('readFile', async (args) => `content of ${args.path}`, { description: 'Read a file' });
  assert(reg.hasTool('readFile'));
  const tool = reg.getTool('readFile');
  assertEqual(tool.name, 'readFile');
});

test('throws for unknown tool', () => {
  const reg = createToolRegistry();
  assertThrows(() => reg.getTool('unknown'), 'Unknown tool');
});

test('hasTool returns false for unregistered', () => {
  const reg = createToolRegistry();
  assertEqual(reg.hasTool('nope'), false);
});

test('listTools returns all registered', () => {
  const reg = createToolRegistry();
  reg.register('read', async () => {});
  reg.register('write', async () => {});
  assertEqual(reg.listTools().length, 2);
});

test('getToolSchemas returns OpenAI format', () => {
  const reg = createToolRegistry();
  reg.register('search', async () => {}, { description: 'Search codebase', parameters: { type: 'object' } });
  const schemas = reg.getToolSchemas();
  assertEqual(schemas[0].type, 'function');
  assertEqual(schemas[0].function.name, 'search');
});

await test('executeTool runs handler', async () => {
  const reg = createToolRegistry();
  reg.register('add', async (args) => args.a + args.b);
  const result = await reg.executeTool('add', { a: 3, b: 5 });
  assertEqual(result, 8);
});

await test('executeTool throws for unknown tool', async () => {
  const reg = createToolRegistry();
  let threw = false;
  try { await reg.executeTool('nope', {}); } catch { threw = true; }
  assert(threw);
});

// ─── createAgentWorker ──────────────────────────────────────────────────

console.log('\n── createAgentWorker ──');

test('creates worker with type agent', () => {
  const w = createAgentWorker(mockProvider([{ content: 'ok' }]), createToolRegistry());
  assertEqual(w.type, 'agent');
});

await test('single-step execution without tools', async () => {
  const provider = mockProvider([{ content: 'Task completed successfully.' }]);
  const w = createAgentWorker(provider, createToolRegistry());

  const result = await w.execute({ message: 'List all files in src/' });
  assertEqual(result.result, 'Task completed successfully.');
  assertEqual(result.worker, 'agent');
  assertEqual(result.model_hidden, true);
  assertEqual(result.steps, 1);
});

await test('calculates cost correctly', async () => {
  const provider = mockProvider([{
    content: 'Done.',
    usage: { inputTokens: 1000, outputTokens: 500 },
  }]);
  const w = createAgentWorker(provider, createToolRegistry());

  const result = await w.execute({ message: 'test' });
  // cost = (1000 * 2.5 + 500 * 10) / 1_000_000 = (2500 + 5000) / 1_000_000 = 0.0075
  assert(Math.abs(result.cost - 0.0075) < 0.0001, `Cost was ${result.cost}`);
});

await test('uses correct model', async () => {
  const provider = mockProvider([{ content: 'ok' }]);
  const w = createAgentWorker(provider, createToolRegistry());
  await w.execute({ message: 'test' });

  assertEqual(provider.calls[0].opts.model, 'gpt-4o');
});

await test('respects custom model', async () => {
  const provider = mockProvider([{ content: 'ok' }]);
  const w = createAgentWorker(provider, createToolRegistry(), { model: 'gpt-5' });
  await w.execute({ message: 'test' });

  assertEqual(provider.calls[0].opts.model, 'gpt-5');
});

// ─── Tool Use Loop ──────────────────────────────────────────────────────

console.log('\n── Tool Use Loop ──');

await test('executes tool calls and feeds back', async () => {
  const provider = mockProvider([
    {
      content: 'I need to read a file.',
      toolCalls: [{
        id: 'tc-1',
        function: { name: 'readFile', arguments: { path: 'src/app.mjs' } },
      }],
      usage: { inputTokens: 100, outputTokens: 50 },
    },
    {
      content: 'The file contains an Express server.',
      usage: { inputTokens: 200, outputTokens: 100 },
    },
  ]);

  const tools = createToolRegistry();
  tools.register('readFile', async (args) => `// app.mjs\nimport express from 'express';`);

  const w = createAgentWorker(provider, tools);
  const result = await w.execute({ message: 'What does src/app.mjs do?' });

  assertEqual(result.steps, 2);
  assertEqual(result.toolCalls.length, 1);
  assert(result.toolCalls[0].success);
  assertEqual(result.toolCalls[0].tool, 'readFile');
});

await test('handles tool execution errors gracefully', async () => {
  const provider = mockProvider([
    {
      content: 'Trying to read.',
      toolCalls: [{
        id: 'tc-1',
        function: { name: 'readFile', arguments: { path: 'missing.txt' } },
      }],
      usage: { inputTokens: 100, outputTokens: 50 },
    },
    {
      content: 'The file was not found.',
      usage: { inputTokens: 200, outputTokens: 100 },
    },
  ]);

  const tools = createToolRegistry();
  tools.register('readFile', async () => { throw new Error('File not found'); });

  const w = createAgentWorker(provider, tools);
  const result = await w.execute({ message: 'read missing.txt' });

  assertEqual(result.toolCalls.length, 1);
  assert(!result.toolCalls[0].success);
  assert(result.toolCalls[0].error.includes('File not found'));
});

await test('passes tool schemas to provider', async () => {
  const provider = mockProvider([{ content: 'Done.' }]);
  const tools = createToolRegistry();
  tools.register('search', async () => 'results', { description: 'Search', parameters: {} });

  const w = createAgentWorker(provider, tools);
  await w.execute({ message: 'search for X' });

  assert(provider.calls[0].opts.tools !== undefined);
  assertEqual(provider.calls[0].opts.tools.length, 1);
});

await test('respects maxSteps limit', async () => {
  // Provider always returns tool calls — should stop at maxSteps
  const provider = mockProvider([
    {
      content: 'step',
      toolCalls: [{ id: 'tc-1', function: { name: 'noop', arguments: {} } }],
      usage: { inputTokens: 10, outputTokens: 10 },
    },
  ]);

  const tools = createToolRegistry();
  tools.register('noop', async () => 'ok');

  const w = createAgentWorker(provider, tools, { maxSteps: 3 });
  const result = await w.execute({ message: 'loop forever' });

  assertEqual(result.steps, 3);
  assertEqual(result.maxStepsReached, true);
});

await test('accumulates cost across tool call steps', async () => {
  const provider = mockProvider([
    {
      content: 'step1',
      toolCalls: [{ id: 'tc-1', function: { name: 'noop', arguments: {} } }],
      usage: { inputTokens: 500, outputTokens: 200 },
    },
    {
      content: 'done',
      usage: { inputTokens: 500, outputTokens: 200 },
    },
  ]);

  const tools = createToolRegistry();
  tools.register('noop', async () => 'ok');

  const w = createAgentWorker(provider, tools);
  const result = await w.execute({ message: 'multi-step' });

  assertEqual(result.inputTokens, 1000);
  assertEqual(result.outputTokens, 400);
  assert(result.cost > 0);
});

// ─── Manifest Execution ─────────────────────────────────────────────────

console.log('\n── Manifest Execution ──');

await test('executes multi-step manifest', async () => {
  const provider = mockProvider([
    { content: 'Step 1 done.', usage: { inputTokens: 100, outputTokens: 50 } },
    { content: 'Step 2 done.', usage: { inputTokens: 100, outputTokens: 50 } },
    { content: 'Step 3 done.', usage: { inputTokens: 100, outputTokens: 50 } },
  ]);

  const w = createAgentWorker(provider, createToolRegistry());
  const result = await w.execute({
    manifest: [
      { instruction: 'Create the component file' },
      { instruction: 'Add tests' },
      { instruction: 'Update exports' },
    ],
  });

  assertEqual(result.stepsCompleted, 3);
  assertEqual(result.stepsTotal, 3);
  assertEqual(result.steps.length, 3);
  assert(result.steps.every(s => s.success));
});

await test('manifest handles step failure', async () => {
  let callCount = 0;
  const provider = {
    complete: async () => {
      callCount++;
      if (callCount === 2) throw new Error('API error');
      return { content: 'Done.', usage: { inputTokens: 100, outputTokens: 50 } };
    },
  };

  const w = createAgentWorker(provider, createToolRegistry());
  const result = await w.execute({
    manifest: [
      { instruction: 'Step 1' },
      { instruction: 'Step 2 (will fail)' },
      { instruction: 'Step 3' },
    ],
  });

  assertEqual(result.stepsCompleted, 2);
  assertEqual(result.errors.length, 1);
  assertEqual(result.errors[0].step, 1);
});

await test('manifest stops on critical step failure', async () => {
  let callCount = 0;
  const provider = {
    complete: async () => {
      callCount++;
      if (callCount === 2) throw new Error('Critical failure');
      return { content: 'Done.', usage: { inputTokens: 100, outputTokens: 50 } };
    },
  };

  const w = createAgentWorker(provider, createToolRegistry());
  const result = await w.execute({
    manifest: [
      { instruction: 'Step 1' },
      { instruction: 'Step 2 (critical)', critical: true },
      { instruction: 'Step 3 (never reached)' },
    ],
  });

  assertEqual(result.stepsCompleted, 1);
  assertEqual(result.steps.length, 2); // Step 3 was never attempted
});

await test('manifest accumulates cost', async () => {
  const provider = mockProvider([
    { content: 'a', usage: { inputTokens: 500, outputTokens: 200 } },
    { content: 'b', usage: { inputTokens: 500, outputTokens: 200 } },
  ]);

  const w = createAgentWorker(provider, createToolRegistry());
  const result = await w.execute({
    manifest: [{ instruction: 'a' }, { instruction: 'b' }],
  });

  assertEqual(result.inputTokens, 1000);
  assertEqual(result.outputTokens, 400);
  assert(result.cost > 0);
});

// ─── buildAgentMessages ─────────────────────────────────────────────────

console.log('\n── buildAgentMessages ──');

test('includes system prompt', () => {
  const msgs = buildAgentMessages({ message: 'test' }, {}, 'Be an agent.');
  assertEqual(msgs[0].role, 'system');
  assertEqual(msgs[0].content, 'Be an agent.');
});

test('includes taste block', () => {
  const msgs = buildAgentMessages({ message: 'test' }, { taste_block: 'Prefers teal.' }, 'sys');
  assert(msgs.some(m => m.content === 'Prefers teal.'));
});

test('includes skills context', () => {
  const msgs = buildAgentMessages({ message: 'test' }, { skills: 'react-skill: ...' }, 'sys');
  assert(msgs.some(m => m.content.includes('react-skill')));
});

test('includes step context for manifests', () => {
  const msgs = buildAgentMessages({ message: 'step 2' }, { stepIndex: 1, totalSteps: 3 }, 'sys');
  assert(msgs.some(m => m.content.includes('step 2 of 3')));
});

test('includes recent history (max 10 messages)', () => {
  const history = Array.from({ length: 14 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `msg-${i}`,
  }));
  const msgs = buildAgentMessages({ message: 'now' }, { history }, 'sys');
  assert(!msgs.some(m => m.content === 'msg-0'));
  assert(msgs.some(m => m.content === 'msg-4'));
});

test('handles string task', () => {
  const msgs = buildAgentMessages('do the thing', {}, 'sys');
  assert(msgs.some(m => m.role === 'user' && m.content === 'do the thing'));
});

// ─── Metrics ────────────────────────────────────────────────────────────

console.log('\n── Metrics ──');

await test('tracks call count and cost', async () => {
  const provider = mockProvider([{ content: 'ok', usage: { inputTokens: 1000, outputTokens: 500 } }]);
  const w = createAgentWorker(provider, createToolRegistry());

  await w.execute({ message: 'test' });
  const m = w.getMetrics();
  assertEqual(m.calls, 1);
  assert(m.totalCost > 0);
});

await test('health degrades on errors', async () => {
  const provider = { complete: async () => { throw new Error('fail'); } };
  const w = createAgentWorker(provider, createToolRegistry(), { maxConsecutiveErrors: 2 });

  try { await w.execute({ message: 'a' }); } catch {}
  assertEqual(w.getHealth().status, WORKER_STATES.DEGRADED);

  try { await w.execute({ message: 'b' }); } catch {}
  assertEqual(w.getHealth().status, WORKER_STATES.UNHEALTHY);
});

// ─── Summary ────────────────────────────────────────────────────────────

await new Promise(r => setTimeout(r, 100));
console.log(`\n${'─'.repeat(60)}`);
console.log(`AgentWorker: ${passCount}/${testCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
