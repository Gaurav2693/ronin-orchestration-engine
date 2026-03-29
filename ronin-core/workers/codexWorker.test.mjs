// ─── workers/codexWorker.test.mjs ─────────────────────────────────────────────
// Tests for RONIN Codex Worker (W5)
// Run: node codexWorker.test.mjs 2>&1
// ─────────────────────────────────────────────────────────────────────────────

import { createCodexWorker, createLocalSandboxManager, buildCodexMessages, extractCodeBlocks } from './codexWorker.mjs';
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

// ─── Mock Provider ──────────────────────────────────────────────────────

const CODE_RESPONSE = `Here's the implementation:

\`\`\`js // src/utils.mjs
export function add(a, b) {
  return a + b;
}
\`\`\`

And the test:

\`\`\`js // src/utils.test.mjs
import { add } from './utils.mjs';
console.assert(add(2, 3) === 5);
\`\`\``;

function mockProvider(response = CODE_RESPONSE, usage = { inputTokens: 200, outputTokens: 150 }) {
  const calls = [];
  return {
    calls,
    complete: async (messages, opts) => {
      calls.push({ messages, opts });
      return { content: response, usage };
    },
  };
}

// ─── createLocalSandboxManager ──────────────────────────────────────────

console.log('\n── createLocalSandboxManager ──');

test('creates sandbox manager', () => {
  const mgr = createLocalSandboxManager();
  assertEqual(mgr.getActiveSandboxCount(), 0);
});

test('creates sandbox with id', () => {
  const mgr = createLocalSandboxManager();
  const sb = mgr.createSandbox('test-1');
  assertEqual(sb.id, 'test-1');
  assertEqual(mgr.getActiveSandboxCount(), 1);
});

await test('sandbox writeFile and readFile', async () => {
  const mgr = createLocalSandboxManager();
  const sb = mgr.createSandbox('test-2');
  await sb.writeFile('hello.txt', 'world');
  const content = await sb.readFile('hello.txt');
  assertEqual(content, 'world');
});

await test('sandbox readFile throws for missing file', async () => {
  const mgr = createLocalSandboxManager();
  const sb = mgr.createSandbox('test-3');
  let threw = false;
  try { await sb.readFile('nope.txt'); } catch (e) { threw = true; assert(e.message.includes('not found')); }
  assert(threw);
});

await test('sandbox exec returns result', async () => {
  const mgr = createLocalSandboxManager();
  const sb = mgr.createSandbox('test-4');
  const result = await sb.exec('npm test');
  assertEqual(result.exitCode, 0);
  assert(result.stdout.includes('npm test'));
});

await test('sandbox listFiles', async () => {
  const mgr = createLocalSandboxManager();
  const sb = mgr.createSandbox('test-5');
  await sb.writeFile('a.txt', 'a');
  await sb.writeFile('b.txt', 'b');
  const files = await sb.listFiles();
  assertEqual(files.length, 2);
});

await test('sandbox getExecLog', async () => {
  const mgr = createLocalSandboxManager();
  const sb = mgr.createSandbox('test-6');
  await sb.exec('echo hello');
  await sb.exec('npm install');
  const log = sb.getExecLog();
  assertEqual(log.length, 2);
});

await test('sandbox destroy clears state', async () => {
  const mgr = createLocalSandboxManager();
  const sb = mgr.createSandbox('test-7');
  await sb.writeFile('data.txt', 'stuff');
  await sb.destroy();

  assert(sb.isDestroyed());
  assertEqual(mgr.getActiveSandboxCount(), 0);

  let threw = false;
  try { await sb.readFile('data.txt'); } catch { threw = true; }
  assert(threw);
});

test('getSandbox returns correct sandbox', () => {
  const mgr = createLocalSandboxManager();
  mgr.createSandbox('a');
  mgr.createSandbox('b');
  const sb = mgr.getSandbox('a');
  assertEqual(sb.id, 'a');
});

test('destroyAll clears everything', () => {
  const mgr = createLocalSandboxManager();
  mgr.createSandbox('x');
  mgr.createSandbox('y');
  mgr.destroyAll();
  assertEqual(mgr.getActiveSandboxCount(), 0);
});

// ─── extractCodeBlocks ──────────────────────────────────────────────────

console.log('\n── extractCodeBlocks ──');

test('extracts code blocks with language', () => {
  const blocks = extractCodeBlocks('```js\nconsole.log("hi");\n```');
  assertEqual(blocks.length, 1);
  assertEqual(blocks[0].lang, 'js');
  assertEqual(blocks[0].code, 'console.log("hi");');
});

test('extracts code blocks with path', () => {
  const blocks = extractCodeBlocks('```js // src/app.mjs\nconst x = 1;\n```');
  assertEqual(blocks.length, 1);
  assertEqual(blocks[0].path, 'src/app.mjs');
});

test('extracts multiple code blocks', () => {
  const blocks = extractCodeBlocks(CODE_RESPONSE);
  assertEqual(blocks.length, 2);
  assertEqual(blocks[0].path, 'src/utils.mjs');
  assertEqual(blocks[1].path, 'src/utils.test.mjs');
});

test('handles no code blocks', () => {
  const blocks = extractCodeBlocks('Just some text with no code.');
  assertEqual(blocks.length, 0);
});

test('handles null content', () => {
  const blocks = extractCodeBlocks(null);
  assertEqual(blocks.length, 0);
});

test('handles code block without language', () => {
  const blocks = extractCodeBlocks('```\nplain text block\n```');
  assertEqual(blocks.length, 1);
  assertEqual(blocks[0].lang, 'text');
});

// ─── createCodexWorker ──────────────────────────────────────────────────

console.log('\n── createCodexWorker ──');

test('creates worker with type codex', () => {
  const w = createCodexWorker(mockProvider(), createLocalSandboxManager());
  assertEqual(w.type, 'codex');
});

await test('generates code and writes to sandbox', async () => {
  const provider = mockProvider(CODE_RESPONSE);
  const mgr = createLocalSandboxManager();
  const w = createCodexWorker(provider, mgr);

  const result = await w.execute({ message: 'Create a utility module with add function' });

  assertEqual(result.worker, 'codex');
  assertEqual(result.model_hidden, true);
  assertEqual(result.codeBlockCount, 2);
  assertEqual(result.artifacts.length, 2);
  assert(result.artifacts[0].path.includes('utils.mjs'));
  assert(result.artifacts[1].path.includes('utils.test.mjs'));
});

await test('auto-destroys sandbox after execution', async () => {
  const mgr = createLocalSandboxManager();
  const w = createCodexWorker(mockProvider(), mgr);
  await w.execute({ message: 'generate code' });

  assertEqual(mgr.getActiveSandboxCount(), 0);
});

await test('keeps sandbox when autoDestroy disabled', async () => {
  const mgr = createLocalSandboxManager();
  const w = createCodexWorker(mockProvider(), mgr, { autoDestroySandbox: false });
  await w.execute({ message: 'generate code' });

  assertEqual(mgr.getActiveSandboxCount(), 1);
  mgr.destroyAll();
});

await test('executes commands in sandbox', async () => {
  const mgr = createLocalSandboxManager();
  const w = createCodexWorker(mockProvider(), mgr, { autoDestroySandbox: false });

  const result = await w.execute({
    message: 'Create and test the module',
    commands: ['npm install', 'npm test'],
  });

  assertEqual(result.execResults.length, 2);
  assertEqual(result.execResults[0].exitCode, 0);
  assertEqual(result.execResults[1].exitCode, 0);
  mgr.destroyAll();
});

await test('uses correct model (gpt-4o-mini)', async () => {
  const provider = mockProvider();
  const w = createCodexWorker(provider, createLocalSandboxManager());
  await w.execute({ message: 'test' });

  assertEqual(provider.calls[0].opts.model, 'gpt-4o-mini');
});

await test('calculates cost correctly', async () => {
  const provider = mockProvider(CODE_RESPONSE, { inputTokens: 1000, outputTokens: 500 });
  const w = createCodexWorker(provider, createLocalSandboxManager());
  const result = await w.execute({ message: 'test' });

  // cost = (1000 * 0.15 + 500 * 0.60) / 1_000_000 = (150 + 300) / 1_000_000 = 0.00045
  assert(Math.abs(result.cost - 0.00045) < 0.00001, `Cost was ${result.cost}`);
});

await test('returns files list from sandbox', async () => {
  const mgr = createLocalSandboxManager();
  const w = createCodexWorker(mockProvider(), mgr, { autoDestroySandbox: false });
  const result = await w.execute({ message: 'generate' });

  assert(result.files.length >= 2);
  mgr.destroyAll();
});

await test('destroys sandbox even on provider error', async () => {
  const provider = { complete: async () => { throw new Error('API down'); } };
  const mgr = createLocalSandboxManager();
  const w = createCodexWorker(provider, mgr);

  try { await w.execute({ message: 'fail' }); } catch {}

  assertEqual(mgr.getActiveSandboxCount(), 0);
});

// ─── buildCodexMessages ─────────────────────────────────────────────────

console.log('\n── buildCodexMessages ──');

test('includes system prompt', () => {
  const msgs = buildCodexMessages({ message: 'test' }, {}, 'Generate code.');
  assertEqual(msgs[0].role, 'system');
  assertEqual(msgs[0].content, 'Generate code.');
});

test('includes existing code context', () => {
  const msgs = buildCodexMessages({ message: 'modify', existingCode: 'const x = 1;' }, {}, 'sys');
  assert(msgs.some(m => m.content.includes('const x = 1;')));
});

test('includes file structure', () => {
  const msgs = buildCodexMessages({ message: 'test', fileStructure: 'src/\n  app.mjs\n  utils.mjs' }, {}, 'sys');
  assert(msgs.some(m => m.content.includes('src/')));
});

test('includes recent history', () => {
  const history = [
    { role: 'user', content: 'old' },
    { role: 'assistant', content: 'response' },
  ];
  const msgs = buildCodexMessages({ message: 'now' }, { history }, 'sys');
  assert(msgs.some(m => m.content === 'old'));
});

// ─── Metrics ────────────────────────────────────────────────────────────

console.log('\n── Metrics ──');

await test('tracks calls and cost', async () => {
  const w = createCodexWorker(mockProvider(), createLocalSandboxManager());
  await w.execute({ message: 'a' });
  await w.execute({ message: 'b' });

  const m = w.getMetrics();
  assertEqual(m.calls, 2);
  assert(m.totalCost > 0);
});

await test('health stays healthy on success', async () => {
  const w = createCodexWorker(mockProvider(), createLocalSandboxManager());
  await w.execute({ message: 'test' });
  assertEqual(w.getHealth().status, WORKER_STATES.HEALTHY);
});

// ─── Summary ────────────────────────────────────────────────────────────

await new Promise(r => setTimeout(r, 100));
console.log(`\n${'─'.repeat(60)}`);
console.log(`CodexWorker: ${passCount}/${testCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
