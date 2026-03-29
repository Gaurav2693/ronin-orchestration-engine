// ─── workers/agentWorker.mjs ──────────────────────────────────────────────────
// RONIN Worker System — Phase 8 (W4)
//
// Agent Worker: GPT-4o. For multi-step build tasks that require tool use —
// file read/write, shell execution, web fetch. Reports step-by-step results
// back to Sonnet for synthesis.
//
// Cost: $2.50/$10.00 per MTok (input/output)
// Latency: ~1100ms first token
// Context: 2048 token output cap per step
//
// The agent worker has its own scoped tool registry. It can only use tools
// that have been explicitly registered. This prevents runaway tool use.
//
// Multi-step execution: Given a task manifest, executes each step in sequence.
// Each step can use tools. If a step fails, the worker reports which step
// failed and returns partial results.
// ─────────────────────────────────────────────────────────────────────────────

import { createBaseWorker } from './workerInterface.mjs';

// ─── System Prompt ────────────────────────────────────────────────────────────

const AGENT_SYSTEM_PROMPT = `You are RONIN, an AI execution agent running inside a macOS developer environment. You have real tools you can call right now.

Your tools:
- read_file(path) — read any file in the project (blocked: .env, secrets, keys)
- write_file(path, content) — write a file (core engine files require approval)
- bash(command) — run shell commands (blocked: rm -rf /, sudo, docker)
- list_directory(path) — list files in a directory
- run_tests(pattern?) — run the test suite
- search_code(pattern, glob?) — search code with regex across the project
- web_fetch(url) — fetch a URL

When the operator gives you a task: use your tools to do it, don't describe what you would do. Read files, write code, run commands. Report what you actually found or changed. Current working directory is the ronin-core project root.`;

// ─── Tool Registry ────────────────────────────────────────────────────────────

export function createToolRegistry() {
  const tools = new Map();

  function register(name, handler, schema = {}) {
    tools.set(name, { handler, schema, name });
  }

  function getTool(name) {
    const tool = tools.get(name);
    if (!tool) throw new Error(`[toolRegistry] Unknown tool: "${name}". Available: ${[...tools.keys()].join(', ')}`);
    return tool;
  }

  function hasTool(name) {
    return tools.has(name);
  }

  function listTools() {
    return [...tools.entries()].map(([name, t]) => ({
      name,
      schema: t.schema,
    }));
  }

  function getToolSchemas() {
    return listTools().map(t => ({
      type: 'function',
      function: { name: t.name, ...t.schema },
    }));
  }

  async function executeTool(name, args) {
    const tool = getTool(name);
    return tool.handler(args);
  }

  return { register, getTool, hasTool, listTools, getToolSchemas, executeTool };
}

// ─── Agent Worker Factory ─────────────────────────────────────────────────────

export function createAgentWorker(provider, toolRegistry, config = {}) {
  const model = config.model || 'gpt-4o';
  const maxTokens = config.maxTokens || 2048;
  const maxSteps = config.maxSteps || 10;
  const systemPrompt = config.systemPrompt || AGENT_SYSTEM_PROMPT;
  const costPerMTokInput = config.costInput || 2.50;
  const costPerMTokOutput = config.costOutput || 10.00;

  async function executeFn(task, context = {}) {
    // Multi-step manifest mode
    if (task.manifest && Array.isArray(task.manifest)) {
      return executeManifest(task.manifest, task, context);
    }

    // Single-step execution
    return executeSingleStep(task, context);
  }

  async function executeSingleStep(task, context) {
    const messages = buildAgentMessages(task, context, systemPrompt);
    const toolSchemas = toolRegistry ? toolRegistry.getToolSchemas() : [];

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let steps = 0;
    const toolCalls = [];

    // Agent loop: model may request tool calls, we execute and feed back
    while (steps < maxSteps) {
      steps++;

      const response = await callProvider(provider, messages, model, maxTokens, toolSchemas);
      totalInputTokens += response.usage?.inputTokens || 0;
      totalOutputTokens += response.usage?.outputTokens || 0;

      // No tool calls — final response
      if (!response.toolCalls || response.toolCalls.length === 0) {
        const cost = calculateCost(totalInputTokens, totalOutputTokens);
        return {
          result: response.content,
          cost,
          model,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          steps,
          toolCalls,
        };
      }

      // Execute tool calls — store rawContent so toAnthropicMessages can rebuild tool_use blocks
      messages.push({ role: 'assistant', content: response.content, tool_calls: response.toolCalls, _rawContent: response.rawContent });

      for (const tc of response.toolCalls) {
        try {
          const toolResult = await toolRegistry.executeTool(tc.function.name, tc.function.arguments);
          toolCalls.push({ tool: tc.function.name, args: tc.function.arguments, result: toolResult, success: true });
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult),
          });
        } catch (err) {
          toolCalls.push({ tool: tc.function.name, args: tc.function.arguments, error: err.message, success: false });
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: `Error: ${err.message}`,
          });
        }
      }
    }

    // Max steps reached
    const cost = calculateCost(totalInputTokens, totalOutputTokens);
    return {
      result: 'Max steps reached. Partial results available in toolCalls.',
      cost,
      model,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      steps,
      toolCalls,
      maxStepsReached: true,
    };
  }

  async function executeManifest(manifest, task, context) {
    const results = [];
    let totalCost = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    const errors = [];

    for (let i = 0; i < manifest.length; i++) {
      const step = manifest[i];
      try {
        const stepResult = await executeSingleStep(
          { message: step.instruction || step.task || step, ...step },
          { ...context, stepIndex: i, totalSteps: manifest.length }
        );
        results.push({ step: i, instruction: step.instruction || step.task || step, ...stepResult, success: true });
        totalCost += stepResult.cost;
        totalInputTokens += stepResult.inputTokens || 0;
        totalOutputTokens += stepResult.outputTokens || 0;
      } catch (err) {
        errors.push({ step: i, instruction: step.instruction || step.task || step, error: err.message });
        results.push({ step: i, success: false, error: err.message });

        // If step is critical, stop the manifest
        if (step.critical) break;
      }
    }

    return {
      result: results.filter(r => r.success).map(r => r.result).join('\n\n'),
      cost: totalCost,
      model,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      steps: results,
      stepsCompleted: results.filter(r => r.success).length,
      stepsTotal: manifest.length,
      errors,
    };
  }

  function calculateCost(inputTokens, outputTokens) {
    return ((inputTokens * costPerMTokInput) + (outputTokens * costPerMTokOutput)) / 1_000_000;
  }

  return createBaseWorker('agent', executeFn, config);
}

// ─── Message Builder ──────────────────────────────────────────────────────────

export function buildAgentMessages(task, context, systemPrompt) {
  const messages = [];

  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }

  if (context.taste_block) {
    messages.push({ role: 'system', content: context.taste_block });
  }

  if (context.skills) {
    messages.push({ role: 'system', content: `Available skills:\n${context.skills}` });
  }

  // Step context for manifest execution
  if (context.stepIndex !== undefined) {
    messages.push({
      role: 'system',
      content: `Executing step ${context.stepIndex + 1} of ${context.totalSteps}.`,
    });
  }

  const history = context.history || [];
  messages.push(...history.slice(-10)); // Last 5 turns

  const userMessage = typeof task === 'string' ? task : (task.message || task.instruction || task.content || '');
  if (userMessage) {
    messages.push({ role: 'user', content: userMessage });
  }

  return messages;
}

// ─── Provider Call ────────────────────────────────────────────────────────────

// Convert an OpenAI-format messages array to Anthropic format.
// Handles: system (extracted), tool (→ tool_result), assistant w/ tool_calls (→ raw content blocks)
function toAnthropicMessages(messages) {
  const result = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    if (msg.role === 'system') { i++; continue; } // extracted separately

    if (msg.role === 'user') {
      result.push({ role: 'user', content: msg.content });
      i++;

    } else if (msg.role === 'assistant') {
      // If we stored rawContent (Anthropic content blocks), use it directly
      if (msg._rawContent) {
        result.push({ role: 'assistant', content: msg._rawContent });
      } else {
        result.push({ role: 'assistant', content: msg.content || '' });
      }
      i++;

    } else if (msg.role === 'tool') {
      // Collect consecutive tool results into a single user message with tool_result blocks
      const toolResults = [];
      while (i < messages.length && messages[i].role === 'tool') {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: messages[i].tool_call_id,
          content: messages[i].content,
        });
        i++;
      }
      result.push({ role: 'user', content: toolResults });

    } else {
      i++;
    }
  }
  return result;
}

async function callProvider(provider, messages, model, maxTokens, tools) {
  // Extract system messages → top-level systemPrompt (Anthropic requirement)
  const systemParts = messages.filter(m => m.role === 'system').map(m => m.content);

  // Convert message array to Anthropic format
  const anthropicMessages = toAnthropicMessages(messages);

  const opts = { model, maxTokens };
  if (systemParts.length > 0) opts.systemPrompt = systemParts.join('\n\n');
  if (tools && tools.length > 0) opts.tools = tools;

  if (typeof provider.complete === 'function') {
    return provider.complete(anthropicMessages, opts);
  }
  if (typeof provider === 'function') {
    return provider(anthropicMessages, opts);
  }
  throw new Error('[agentWorker] Provider must implement complete() or be callable');
}
