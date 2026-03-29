// models/anthropicProvider.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Anthropic Provider
//
// Handles Claude models (Sonnet, Haiku, Opus) via @anthropic-ai/sdk.
// Implements standard streaming and completion interfaces.
//
// Why separate: Anthropic's SDK has unique streaming format (MessageStream with
// event handlers) that differs from OpenAI's async generator pattern. This adapter
// normalizes both to the same interface.
// ─────────────────────────────────────────────────────────────────────────────

import Anthropic from '@anthropic-ai/sdk';
import { getModelConfig } from '../config/modelConfig.mjs';

// ─── Lazy Init ─────────────────────────────────────────────────────────────────
// SDK is created on first use, not on import. This lets tests import the module
// without needing real API keys in the environment.

let _client = null;

function getClient() {
  if (!_client) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('[anthropicProvider] ANTHROPIC_API_KEY not set in environment');
    _client = new Anthropic({ apiKey: key });
  }
  return _client;
}

// ─── Main Provider Class ────────────────────────────────────────────────────────

export class AnthropicProvider {

  // options.apiKey — optional BYOK key. If provided, creates a dedicated client
  // for this instance instead of using the shared singleton. System key is used
  // when no apiKey is passed (standard operator flow).
  constructor(options = {}) {
    this.name = 'anthropic';
    this._byok = !!options.apiKey;
    this._client = options.apiKey
      ? new Anthropic({ apiKey: options.apiKey })
      : null;
  }

  // Returns either the BYOK instance client or the shared singleton
  _getClient() {
    return this._client || getClient();
  }

  // ─── Streaming interface ────────────────────────────────────────────────────
  // Usage:
  //   async for (const event of provider.stream(messages, options)) {
  //     if (event.type === 'text') console.log(event.content);
  //     if (event.type === 'usage') console.log(event.inputTokens);
  //   }
  //
  // Yields objects:
  //   { type: 'text', content: string }         — chunk of output text
  //   { type: 'usage', inputTokens, outputTokens }  — final token counts

  async *stream(messages, options = {}) {
    const { model, maxTokens, systemPrompt, jsonMode } = options;

    // Validate model exists in config
    const modelConfig = getModelConfig(model);

    // Build request payload
    const requestParams = {
      model: model,
      max_tokens: maxTokens || modelConfig.maxTokens,
      messages: messages,
      ...(systemPrompt && { system: systemPrompt }),
      // Note: jsonMode not supported by Anthropic in same way as OpenAI,
      // but we acknowledge the flag for API compatibility
    };

    try {
      // Use Anthropic's streaming API
      const stream = await this._getClient().messages.create({
        ...requestParams,
        stream: true,
      });

      let totalInputTokens = 0;
      let totalOutputTokens = 0;

      // Process the stream events
      for await (const event of stream) {
        // ─── Content block start: new text chunk coming ────────────────────
        if (event.type === 'content_block_start') {
          // Anthropic signals that a new content block is starting
          // (we don't yield anything here, just track it)
          continue;
        }

        // ─── Content block delta: actual text ──────────────────────────────
        if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            yield { type: 'text', content: event.delta.text };
          }
          continue;
        }

        // ─── Message delta: token usage updates ────────────────────────────
        if (event.type === 'message_delta') {
          if (event.usage) {
            totalOutputTokens = event.usage.output_tokens;
          }
          continue;
        }

        // ─── Message start: initial token counts ───────────────────────────
        if (event.type === 'message_start') {
          if (event.message.usage) {
            totalInputTokens = event.message.usage.input_tokens;
          }
          continue;
        }

        // ─── Message stop: stream finished ─────────────────────────────────
        if (event.type === 'message_stop') {
          // Final event — don't yield anything here, we'll emit usage below
          continue;
        }
      }

      // Yield final usage stats
      yield {
        type: 'usage',
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
      };

    } catch (err) {
      // ─── Rate limit detection ──────────────────────────────────────────
      if (err.status === 429) {
        const error = new Error(`[anthropicProvider] Rate limit (429): ${err.message}`);
        error.status = 429;
        throw error;
      }

      // ─── Other errors ──────────────────────────────────────────────────
      if (err.error?.type === 'rate_limit_error') {
        const error = new Error(`[anthropicProvider] Rate limit error: ${err.message}`);
        error.status = 429;
        throw error;
      }

      // Re-throw with context
      throw new Error(`[anthropicProvider] Stream failed: ${err.message}`);
    }
  }

  // ─── Completion interface (non-streaming) ──────────────────────────────────
  // Usage:
  //   const { content, usage } = await provider.complete(messages, options);
  //
  // Returns:
  //   { content: string, usage: { inputTokens, outputTokens } }

  async complete(messages, options = {}) {
    const { model, maxTokens, systemPrompt, tools: rawTools } = options;

    // Validate model exists in config
    const modelConfig = getModelConfig(model);

    // Convert OpenAI-format tool schemas to Anthropic format
    // OpenAI: { type: 'function', function: { name, description, parameters } }
    // Anthropic: { name, description, input_schema }
    const anthropicTools = rawTools?.length
      ? rawTools.map(t => {
          const fn = t.function || t;
          return {
            name: fn.name,
            description: fn.description || '',
            input_schema: fn.parameters || fn.input_schema || { type: 'object', properties: {} },
          };
        })
      : undefined;

    // Build request payload
    const requestParams = {
      model: model,
      max_tokens: maxTokens || modelConfig.maxTokens,
      messages: messages,
      ...(systemPrompt && { system: systemPrompt }),
      ...(anthropicTools?.length && { tools: anthropicTools }),
    };

    try {
      const response = await this._getClient().messages.create(requestParams);

      // Extract text and tool_use blocks from response
      const textContent = response.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('');

      // Normalize tool_use blocks to OpenAI-like format for agentWorker compatibility
      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
      const toolCalls = toolUseBlocks.map(b => ({
        id: b.id,
        type: 'function',
        function: {
          name: b.name,
          arguments: typeof b.input === 'string' ? b.input : JSON.stringify(b.input),
        },
      }));

      return {
        content: textContent,
        rawContent: response.content, // kept so agentWorker can rebuild Anthropic-format messages
        toolCalls: toolCalls.length ? toolCalls : undefined,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
        stopReason: response.stop_reason,
      };

    } catch (err) {
      // ─── Rate limit detection ──────────────────────────────────────────
      if (err.status === 429) {
        const error = new Error(`[anthropicProvider] Rate limit (429): ${err.message}`);
        error.status = 429;
        throw error;
      }

      if (err.error?.type === 'rate_limit_error') {
        const error = new Error(`[anthropicProvider] Rate limit error: ${err.message}`);
        error.status = 429;
        throw error;
      }

      // Re-throw with context
      throw new Error(`[anthropicProvider] Completion failed: ${err.message}`);
    }
  }
}

// ─── Singleton instance ────────────────────────────────────────────────────────
// All imports of anthropicProvider get the same instance.

export const anthropicProvider = new AnthropicProvider();
