// models/openaiProvider.mjs
// ─────────────────────────────────────────────────────────────────────────────
// OpenAI Provider
//
// Handles GPT-4o, o3-mini, GPT-4o-mini via openai SDK.
// Supports JSON mode via response_format: { type: 'json_object' }.
//
// Why separate: OpenAI's JSON mode requires special handling at request time,
// and streaming format differs from Anthropic. This adapter implements our
// normalized interface.
// ─────────────────────────────────────────────────────────────────────────────

import OpenAI from 'openai';
import { getModelConfig } from '../config/modelConfig.mjs';

// ─── Lazy Init ─────────────────────────────────────────────────────────────────
// SDK is created on first use, not on import.

let _client = null;

function getClient() {
  if (!_client) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error('[openaiProvider] OPENAI_API_KEY not set in environment');
    _client = new OpenAI({ apiKey: key });
  }
  return _client;
}

// ─── Main Provider Class ────────────────────────────────────────────────────────

export class OpenAIProvider {

  // options.apiKey — optional BYOK key for this instance.
  constructor(options = {}) {
    this.name = 'openai';
    this._byok = !!options.apiKey;
    this._client = options.apiKey
      ? new OpenAI({ apiKey: options.apiKey })
      : null;
  }

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
  // OpenAI's streaming is an async iterable of ChatCompletionChunk events.
  // We map these to our standard interface.

  async *stream(messages, options = {}) {
    const { model, maxTokens, systemPrompt, jsonMode } = options;

    // Validate model exists in config
    const modelConfig = getModelConfig(model);

    // Build request payload
    // Note: OpenAI requires a system message to be sent as a separate message,
    // not as a parameter. If systemPrompt is provided, we prepend it.
    let messagesPayload = messages;
    if (systemPrompt) {
      messagesPayload = [{ role: 'system', content: systemPrompt }, ...messages];
    }

    const requestParams = {
      model: model,
      max_tokens: maxTokens || modelConfig.maxTokens,
      messages: messagesPayload,
      stream: true,
      // JSON mode: if enabled, OpenAI enforces JSON output format
      ...(jsonMode && { response_format: { type: 'json_object' } }),
    };

    try {
      const stream = await this._getClient().chat.completions.create(requestParams);

      let totalInputTokens = 0;
      let totalOutputTokens = 0;

      // Iterate through stream chunks
      for await (const chunk of stream) {
        // ─── Extract text deltas ───────────────────────────────────────
        if (chunk.choices && chunk.choices.length > 0) {
          const choice = chunk.choices[0];

          // Text delta
          if (choice.delta?.content) {
            yield { type: 'text', content: choice.delta.content };
          }
        }

        // ─── Extract token usage (comes in final chunk) ────────────────
        if (chunk.usage) {
          totalInputTokens = chunk.usage.prompt_tokens;
          totalOutputTokens = chunk.usage.completion_tokens;
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
        const error = new Error(`[openaiProvider] Rate limit (429): ${err.message}`);
        error.status = 429;
        throw error;
      }

      // Check for rate limit in error code
      if (err.code === 'rate_limit_exceeded') {
        const error = new Error(`[openaiProvider] Rate limit error: ${err.message}`);
        error.status = 429;
        throw error;
      }

      // Re-throw with context
      throw new Error(`[openaiProvider] Stream failed: ${err.message}`);
    }
  }

  // ─── Completion interface (non-streaming) ──────────────────────────────────
  // Usage:
  //   const { content, usage } = await provider.complete(messages, options);

  async complete(messages, options = {}) {
    const { model, maxTokens, systemPrompt, jsonMode } = options;

    // Validate model exists in config
    const modelConfig = getModelConfig(model);

    // Prepare messages with system prompt if provided
    let messagesPayload = messages;
    if (systemPrompt) {
      messagesPayload = [{ role: 'system', content: systemPrompt }, ...messages];
    }

    const requestParams = {
      model: model,
      max_tokens: maxTokens || modelConfig.maxTokens,
      messages: messagesPayload,
      ...(jsonMode && { response_format: { type: 'json_object' } }),
    };

    try {
      const response = await this._getClient().chat.completions.create(requestParams);

      // Extract text from first choice
      const textContent = response.choices[0]?.message?.content || '';

      return {
        content: textContent,
        usage: {
          inputTokens: response.usage.prompt_tokens,
          outputTokens: response.usage.completion_tokens,
        },
      };

    } catch (err) {
      // ─── Rate limit detection ──────────────────────────────────────────
      if (err.status === 429) {
        const error = new Error(`[openaiProvider] Rate limit (429): ${err.message}`);
        error.status = 429;
        throw error;
      }

      if (err.code === 'rate_limit_exceeded') {
        const error = new Error(`[openaiProvider] Rate limit error: ${err.message}`);
        error.status = 429;
        throw error;
      }

      // Re-throw with context
      throw new Error(`[openaiProvider] Completion failed: ${err.message}`);
    }
  }
}

// ─── Singleton instance ────────────────────────────────────────────────────────

export const openaiProvider = new OpenAIProvider();
