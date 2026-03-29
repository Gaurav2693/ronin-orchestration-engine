// models/groqProvider.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Groq Provider
//
// Handles Llama models (3.3-70b, 3.1-8b) via openai SDK with Groq baseURL.
// Groq provides OpenAI-compatible API, so we reuse the OpenAI SDK but point
// to Groq's endpoint. This is the cheapest/fastest option for ops tasks.
//
// Why separate: Different API endpoint + free tier rate limits that need
// tracking (30 rpm, 14400 rpd). Kept separate for clarity even though SDK
// is same as OpenAI.
// ─────────────────────────────────────────────────────────────────────────────

import OpenAI from 'openai';
import { getModelConfig } from '../config/modelConfig.mjs';

// ─── Lazy Init ─────────────────────────────────────────────────────────────────
// SDK is created on first use, not on import.

let _client = null;

function getClient() {
  if (!_client) {
    const key = process.env.GROQ_API_KEY;
    if (!key) throw new Error('[groqProvider] GROQ_API_KEY not set in environment');
    _client = new OpenAI({
      apiKey: key,
      baseURL: 'https://api.groq.com/openai/v1',
    });
  }
  return _client;
}

// ─── Main Provider Class ────────────────────────────────────────────────────────

export class GroqProvider {

  // options.apiKey — optional BYOK key for this instance.
  constructor(options = {}) {
    this.name = 'groq';
    this._byok = !!options.apiKey;
    this._client = options.apiKey
      ? new OpenAI({ apiKey: options.apiKey, baseURL: 'https://api.groq.com/openai/v1' })
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
  // Since Groq uses OpenAI-compatible API, the streaming format is identical.

  async *stream(messages, options = {}) {
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
      stream: true,
      // Note: jsonMode generally not supported on Groq's free tier,
      // but we accept the flag for API compatibility
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
      // Groq free tier: 30 rpm (requests per minute), 14400 rpd (requests per day)
      if (err.status === 429) {
        const error = new Error(`[groqProvider] Rate limit (429): ${err.message}`);
        error.status = 429;
        throw error;
      }

      if (err.code === 'rate_limit_exceeded') {
        const error = new Error(`[groqProvider] Rate limit error: ${err.message}`);
        error.status = 429;
        throw error;
      }

      // Re-throw with context
      throw new Error(`[groqProvider] Stream failed: ${err.message}`);
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
        const error = new Error(`[groqProvider] Rate limit (429): ${err.message}`);
        error.status = 429;
        throw error;
      }

      if (err.code === 'rate_limit_exceeded') {
        const error = new Error(`[groqProvider] Rate limit error: ${err.message}`);
        error.status = 429;
        throw error;
      }

      // Re-throw with context
      throw new Error(`[groqProvider] Completion failed: ${err.message}`);
    }
  }
}

// ─── Singleton instance ────────────────────────────────────────────────────────

export const groqProvider = new GroqProvider();
