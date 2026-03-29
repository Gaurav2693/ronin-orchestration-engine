// ─── workers/codexWorker.mjs ──────────────────────────────────────────────────
// RONIN Worker System — Phase 8 (W5)
//
// Codex Worker: GPT-4o-mini (no-think mode). Multi-file code generation
// with sandboxed execution. Each Codex worker gets its own isolated
// environment — can install deps, build, test. Results stream back to Sonnet.
//
// Cost: $0.15/$0.60 per MTok (input/output) — cheapest paid model
// Latency: ~500ms first token
// Context: 2000 token output cap
//
// The sandbox is injected (SandboxManager interface). In dev, it's a
// local temp directory. In production, it's a Docker container.
//
// Sandbox contract:
//   createSandbox(id) → { id, workDir, exec, writeFile, readFile, destroy }
//   exec(command) → { stdout, stderr, exitCode }
//   writeFile(path, content) → void
//   readFile(path) → string
//   destroy() → void
// ─────────────────────────────────────────────────────────────────────────────

import { createBaseWorker } from './workerInterface.mjs';

// ─── System Prompt ────────────────────────────────────────────────────────────

const CODEX_SYSTEM_PROMPT = `You are a code generation assistant. Generate clean, well-structured code.
Rules:
- Always include imports/exports
- Use modern JavaScript/TypeScript conventions
- Add brief comments for non-obvious logic
- Handle errors appropriately
- Generate test stubs if asked

Output code blocks with file paths: \`\`\`js // path/to/file.mjs\`\`\``;

// ─── Sandbox Manager (in-memory for testing) ──────────────────────────────────

export function createLocalSandboxManager(config = {}) {
  const sandboxes = new Map();
  const defaultTimeout = config.timeout || 30_000;

  function createSandbox(id) {
    const files = new Map();
    const execLog = [];
    let destroyed = false;

    function checkDestroyed() {
      if (destroyed) throw new Error(`Sandbox ${id} has been destroyed`);
    }

    const sandbox = {
      id,
      workDir: `/tmp/ronin-sandbox-${id}`,

      async writeFile(path, content) {
        checkDestroyed();
        files.set(path, content);
      },

      async readFile(path) {
        checkDestroyed();
        const content = files.get(path);
        if (content === undefined) throw new Error(`File not found: ${path}`);
        return content;
      },

      async exec(command, timeout = defaultTimeout) {
        checkDestroyed();
        execLog.push({ command, timestamp: Date.now() });

        // In-memory sandbox: simulate exec by returning command echo
        // Real sandbox would shell out to Docker/child_process
        return {
          stdout: `[sandbox:${id}] Executed: ${command}`,
          stderr: '',
          exitCode: 0,
          duration: 50,
        };
      },

      async listFiles() {
        checkDestroyed();
        return [...files.keys()];
      },

      getExecLog() {
        return [...execLog];
      },

      async destroy() {
        destroyed = true;
        files.clear();
        sandboxes.delete(id);
      },

      isDestroyed() {
        return destroyed;
      },
    };

    sandboxes.set(id, sandbox);
    return sandbox;
  }

  function getSandbox(id) {
    return sandboxes.get(id);
  }

  function getActiveSandboxCount() {
    return sandboxes.size;
  }

  function destroyAll() {
    for (const [id, sb] of sandboxes) {
      sb.destroy();
    }
  }

  return { createSandbox, getSandbox, getActiveSandboxCount, destroyAll };
}

// ─── Codex Worker Factory ─────────────────────────────────────────────────────

export function createCodexWorker(provider, sandboxManager, config = {}) {
  const model = config.model || 'gpt-4o-mini';
  const maxTokens = config.maxTokens || 2000;
  const systemPrompt = config.systemPrompt || CODEX_SYSTEM_PROMPT;
  const costPerMTokInput = config.costInput || 0.15;
  const costPerMTokOutput = config.costOutput || 0.60;
  const autoDestroySandbox = config.autoDestroySandbox !== false; // default true

  async function executeFn(task, context = {}) {
    const sandboxId = task.sandboxId || `codex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sandbox = sandboxManager.createSandbox(sandboxId);

    try {
      // Step 1: Generate code
      const messages = buildCodexMessages(task, context, systemPrompt);
      const response = await callProvider(provider, messages, model, maxTokens);

      const inputTokens = response.usage?.inputTokens || 0;
      const outputTokens = response.usage?.outputTokens || 0;
      const cost = calculateCost(inputTokens, outputTokens);

      // Step 2: Extract code blocks and write to sandbox
      const codeBlocks = extractCodeBlocks(response.content);
      const artifacts = [];

      for (const block of codeBlocks) {
        const filePath = block.path || `generated-${artifacts.length}.${block.lang || 'mjs'}`;
        await sandbox.writeFile(filePath, block.code);
        artifacts.push({ path: filePath, lang: block.lang, size: block.code.length });
      }

      // Step 3: Execute commands if requested
      const execResults = [];
      const commands = task.commands || [];
      for (const cmd of commands) {
        const execResult = await sandbox.exec(cmd);
        execResults.push({ command: cmd, ...execResult });

        // Stop on failure if strict mode
        if (execResult.exitCode !== 0 && task.strictExecution) {
          break;
        }
      }

      const files = await sandbox.listFiles();

      return {
        result: response.content,
        cost,
        model,
        inputTokens,
        outputTokens,
        sandboxId,
        artifacts,
        files,
        execResults,
        codeBlockCount: codeBlocks.length,
      };
    } finally {
      if (autoDestroySandbox) {
        await sandbox.destroy();
      }
    }
  }

  function calculateCost(inputTokens, outputTokens) {
    return ((inputTokens * costPerMTokInput) + (outputTokens * costPerMTokOutput)) / 1_000_000;
  }

  return createBaseWorker('codex', executeFn, config);
}

// ─── Message Builder ──────────────────────────────────────────────────────────

export function buildCodexMessages(task, context, systemPrompt) {
  const messages = [];

  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }

  // Existing code context
  if (task.existingCode) {
    messages.push({
      role: 'system',
      content: `Existing code to work with:\n\`\`\`\n${task.existingCode}\n\`\`\``,
    });
  }

  // File structure context
  if (task.fileStructure) {
    messages.push({
      role: 'system',
      content: `Project file structure:\n${task.fileStructure}`,
    });
  }

  const history = context.history || [];
  messages.push(...history.slice(-6));

  const userMessage = typeof task === 'string' ? task : (task.message || task.instruction || task.content || '');
  if (userMessage) {
    messages.push({ role: 'user', content: userMessage });
  }

  return messages;
}

// ─── Code Block Extractor ─────────────────────────────────────────────────────

export function extractCodeBlocks(content) {
  if (!content || typeof content !== 'string') return [];

  const blocks = [];
  const regex = /```(\w+)?(?:\s*\/\/\s*(.+?))?\n([\s\S]*?)```/g;
  let match;

  while ((match = regex.exec(content)) !== null) {
    blocks.push({
      lang: match[1] || 'text',
      path: match[2] ? match[2].trim() : null,
      code: match[3].trim(),
    });
  }

  return blocks;
}

// ─── Provider Call ────────────────────────────────────────────────────────────

async function callProvider(provider, messages, model, maxTokens) {
  if (typeof provider.complete === 'function') {
    return provider.complete(messages, { model, maxTokens });
  }
  if (typeof provider === 'function') {
    return provider(messages, { model, maxTokens });
  }
  throw new Error('[codexWorker] Provider must implement complete() or be callable');
}
