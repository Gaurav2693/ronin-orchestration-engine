// models/geminiProvider.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Google Gemini Provider
//
// Handles Gemini 2.5 Flash, Flash Lite, and embeddings via @google/generative-ai.
// Uses generationConfig.responseMimeType for JSON mode.
//
// Why separate: Google's SDK and streaming format are fundamentally different
// from OpenAI/Anthropic. Their ContentStream API must be mapped to our standard
// interface. Also tracks free tier rate limits (10 rpm flash, 15 rpm lite).
// ─────────────────────────────────────────────────────────────────────────────

import { GoogleGenerativeAI } from '@google/generative-ai';
import { getModelConfig } from '../config/modelConfig.mjs';

// ─── Lazy Init ─────────────────────────────────────────────────────────────────
// SDK is created on first use, not on import.

let _client = null;

function getClient() {
  if (!_client) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error('[geminiProvider] GEMINI_API_KEY not set in environment');
    _client = new GoogleGenerativeAI(key);
  }
  return _client;
}

// ─── Main Provider Class ────────────────────────────────────────────────────────

export class GeminiProvider {

  // options.apiKey — optional BYOK key for this instance.
  constructor(options = {}) {
    this.name = 'gemini';
    this._byok = !!options.apiKey;
    this._client = options.apiKey
      ? new GoogleGenerativeAI(options.apiKey)
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
  // Google's ContentStream returns in a different format. We normalize it
  // to match our standard interface.

  async *stream(messages, options = {}) {
    const { model, maxTokens, systemPrompt, jsonMode } = options;

    // Validate model exists in config
    const modelConfig = getModelConfig(model);

    // Google Gemini expects a different message format:
    // - System prompt goes in systemInstruction (not in messages)
    // - Messages are { role, parts } where parts can be [{ text: string }]
    const geminiMessages = this._convertMessages(messages);

    // Build generation config
    const generationConfig = {
      maxOutputTokens: maxTokens || modelConfig.maxTokens,
      ...(jsonMode && { responseMimeType: 'application/json' }),
    };

    try {
      const model_instance = this._getClient().getGenerativeModel({
        model: model,
        systemInstruction: systemPrompt,
      });

      const response = await model_instance.generateContentStream({
        contents: geminiMessages,
        generationConfig,
      });

      let fullText = '';
      let totalInputTokens = 0;
      let totalOutputTokens = 0;

      // Process the stream
      for await (const chunk of response.stream) {
        // Extract text from candidates (Gemini streaming format)
        const candidates = chunk.candidates || [];
        for (const candidate of candidates) {
          for (const part of candidate.content?.parts || []) {
            if (part.text) {
              fullText += part.text;
              yield { type: 'text', content: part.text };
            }
          }
        }

        // Extract usage from this chunk (if available)
        // Note: Gemini streaming doesn't always provide token counts per chunk
        if (chunk.usageMetadata) {
          totalInputTokens = chunk.usageMetadata.promptTokenCount || 0;
          totalOutputTokens = chunk.usageMetadata.candidatesTokenCount || 0;
        }
      }

      // If we didn't get usage from stream chunks, try final response
      // (This is a backup for incomplete usage metadata in streaming)
      if (totalInputTokens === 0 && totalOutputTokens === 0 && response.response) {
        const usageMetadata = response.response.usageMetadata;
        if (usageMetadata) {
          totalInputTokens = usageMetadata.promptTokenCount || 0;
          totalOutputTokens = usageMetadata.candidatesTokenCount || 0;
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
      // Gemini free tier: 10 rpm (flash), 15 rpm (lite)
      // Error message typically contains "429" or "RESOURCE_EXHAUSTED"
      if (err.status === 429 || err.message?.includes('429')) {
        const error = new Error(`[geminiProvider] Rate limit (429): ${err.message}`);
        error.status = 429;
        throw error;
      }

      if (err.message?.includes('RESOURCE_EXHAUSTED')) {
        const error = new Error(`[geminiProvider] Rate limit (resource exhausted): ${err.message}`);
        error.status = 429;
        throw error;
      }

      // Re-throw with context
      throw new Error(`[geminiProvider] Stream failed: ${err.message}`);
    }
  }

  // ─── Completion interface (non-streaming) ──────────────────────────────────
  // Usage:
  //   const { content, usage } = await provider.complete(messages, options);

  async complete(messages, options = {}) {
    const { model, maxTokens, systemPrompt, jsonMode } = options;

    // Validate model exists in config
    const modelConfig = getModelConfig(model);

    // Convert to Gemini message format
    const geminiMessages = this._convertMessages(messages);

    // Build generation config
    const generationConfig = {
      maxOutputTokens: maxTokens || modelConfig.maxTokens,
      ...(jsonMode && { responseMimeType: 'application/json' }),
    };

    try {
      const model_instance = this._getClient().getGenerativeModel({
        model: model,
        systemInstruction: systemPrompt,
      });

      const response = await model_instance.generateContent({
        contents: geminiMessages,
        generationConfig,
      });

      // Extract text from response
      // The SDK returns GenerateContentResult — use .text() helper or walk candidates
      let textContent = '';
      try {
        textContent = response.response.text();
      } catch {
        // Fallback: walk candidates manually
        const candidates = response.response?.candidates || [];
        for (const candidate of candidates) {
          for (const part of candidate.content?.parts || []) {
            if (part.text) textContent += part.text;
          }
        }
      }

      // Extract usage
      let inputTokens = 0;
      let outputTokens = 0;
      if (response.response?.usageMetadata) {
        inputTokens = response.response.usageMetadata.promptTokenCount || 0;
        outputTokens = response.response.usageMetadata.candidatesTokenCount || 0;
      }

      return {
        content: textContent,
        usage: {
          inputTokens,
          outputTokens,
        },
      };

    } catch (err) {
      // ─── Rate limit detection ──────────────────────────────────────────
      if (err.status === 429 || err.message?.includes('429')) {
        const error = new Error(`[geminiProvider] Rate limit (429): ${err.message}`);
        error.status = 429;
        throw error;
      }

      if (err.message?.includes('RESOURCE_EXHAUSTED')) {
        const error = new Error(`[geminiProvider] Rate limit (resource exhausted): ${err.message}`);
        error.status = 429;
        throw error;
      }

      // Re-throw with context
      throw new Error(`[geminiProvider] Completion failed: ${err.message}`);
    }
  }

  // ─── Private: convert messages from standard format to Gemini format ──────
  //
  // Standard format (what we receive):
  //   [{ role: 'user' | 'assistant', content: string }, ...]
  //
  // Gemini format (what Google SDK expects):
  //   [{ role: 'user' | 'model', parts: [{ text: string }] }, ...]
  //
  // Note: Gemini uses 'model' instead of 'assistant'

  _convertMessages(messages) {
    return messages.map(msg => ({
      role: msg.role === 'assistant' ? 'model' : msg.role,
      parts: [{ text: msg.content }],
    }));
  }
}

// ─── Singleton instance ────────────────────────────────────────────────────────

export const geminiProvider = new GeminiProvider();
