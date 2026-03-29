# Provider Layer — Task 2 Complete

## Overview
Built 4 provider clients + registry for RONIN Orchestration Engine. All implement the same interface but use different SDKs and API endpoints.

**Files created:**
- `models/anthropicProvider.mjs` — Claude models (Sonnet, Haiku, Opus)
- `models/openaiProvider.mjs` — GPT-4o, o3-mini, GPT-4o-mini + JSON mode support
- `models/groqProvider.mjs` — Llama models via Groq (OpenAI-compatible endpoint)
- `models/geminiProvider.mjs` — Gemini 2.5 Flash models + embeddings
- `models/providerRegistry.mjs` — Registry to get provider by name
- `models/providers.test.mjs` — Validation tests

## Standard Interface

Every provider implements this contract:

```javascript
// Streaming: yields text chunks + final usage stats
async *stream(messages, options) {
  // yields: { type: 'text', content: string }
  //      or { type: 'usage', inputTokens, outputTokens }
}

// Blocking completion: returns full response + usage
async complete(messages, options) {
  return { content: string, usage: { inputTokens, outputTokens } }
}
```

Options shape:
```javascript
{
  model: string,           // model ID from modelConfig
  maxTokens: number,       // from modelConfig
  systemPrompt: string,    // optional
  jsonMode: boolean,       // optional — forces JSON output
}
```

## Provider Details

### 1. Anthropic (`anthropicProvider.mjs`)
- **SDK:** `@anthropic-ai/sdk`
- **Models:** claude-sonnet-4-6, claude-haiku-4-5-20251001, claude-opus-4-6
- **Streaming:** Uses MessageStream event handlers, normalized to standard interface
- **System prompt:** Passed as `system` parameter
- **JSON mode:** Not natively supported; flag accepted for compatibility
- **Rate limits:** Paid tier (tracked in costTracker, not here)

### 2. OpenAI (`openaiProvider.mjs`)
- **SDK:** `openai` (npm package)
- **Models:** gpt-4o, o3-mini, gpt-4o-mini
- **Streaming:** Async iterable of ChatCompletionChunk events
- **System prompt:** Prepended as first message with role='system'
- **JSON mode:** Via `response_format: { type: 'json_object' }`
- **Rate limits:** Paid tier (tracked in costTracker, not here)

### 3. Groq (`groqProvider.mjs`)
- **SDK:** `openai` SDK pointed at Groq baseURL
- **Models:** llama-3.3-70b-versatile, llama-3.1-8b-instant
- **Streaming:** Same as OpenAI (OpenAI-compatible API)
- **System prompt:** Same as OpenAI
- **JSON mode:** Generally not supported on free tier; flag accepted
- **Rate limits:** Free tier (30 rpm, 14400 rpd) — must be tracked by rateLimitGuard

### 4. Gemini (`geminiProvider.mjs`)
- **SDK:** `@google/generative-ai`
- **Models:** gemini-2.5-flash-lite, gemini-2.5-flash, text-embedding-004
- **Streaming:** ContentStream with async iteration, normalized to standard interface
- **System prompt:** Passed as `systemInstruction` parameter
- **JSON mode:** Via `generationConfig.responseMimeType: 'application/json'`
- **Message format:** Google uses `{ role, parts: [{ text }] }` — auto-converted
- **Rate limits:** Free tier (10 rpm flash, 15 rpm lite) — must be tracked by rateLimitGuard
- **Token tracking:** Gemini streaming may not provide per-chunk usage; uses fallback from final response

## Registry Usage

```javascript
import { getProvider } from './providerRegistry.mjs';

// Get a provider
const provider = getProvider('anthropic');

// Use it
const { content, usage } = await provider.complete(messages, {
  model: 'claude-haiku-4-5-20251001',
  maxTokens: 1500,
  systemPrompt: 'You are helpful.',
  jsonMode: false,
});

// Helper functions
const names = getProvider.listProviders(); // ['anthropic', 'openai', 'groq', 'gemini']
const all = getProvider.getAllProviders();  // { anthropic, openai, groq, gemini }
```

## Error Handling

All providers:
- Wrap calls in try/catch
- Detect 429 rate limit errors and throw with `error.status = 429` for caller detection
- Re-throw other errors with provider-prefixed context messages
- Never swallow errors — always propagate with context

Rate limit detection patterns:
- **Anthropic:** `err.status === 429` or `err.error?.type === 'rate_limit_error'`
- **OpenAI:** `err.status === 429` or `err.code === 'rate_limit_exceeded'`
- **Groq:** Same as OpenAI (compatible API)
- **Gemini:** `err.status === 429` or `err.message.includes('RESOURCE_EXHAUSTED')`

## API Keys

All providers read from environment variables:
- `ANTHROPIC_API_KEY` → anthropicProvider
- `OPENAI_API_KEY` → openaiProvider
- `GROQ_API_KEY` → groqProvider
- `GEMINI_API_KEY` → geminiProvider

If a key is missing, the provider module throws at import time with a clear error.

## Configuration

All providers import from `../config/modelConfig.mjs`:
- `getModelConfig(modelId)` — validate and retrieve model config
- `MODELS` — full model catalog with maxTokens, costs, etc.
- Never hardcode model IDs in provider code

## Testing

Run tests:
```bash
node models/providers.test.mjs
```

Tests validate:
- All 4 providers can be imported
- Registry returns correct provider for each name
- Each provider has stream() and complete() methods
- Registry throws on unknown provider name
- Helper functions work (listProviders, getAllProviders)

## Next Steps (Task 3)

These providers will be consumed by:
1. **rateLimitGuard** — checks Groq/Gemini free tier limits before calls
2. **costTracker** — tracks Anthropic/OpenAI spending
3. **intelligenceRouter** — selects best provider for each task
4. **runTask.mjs** — orchestrates everything together

## Design Notes

- **Provider abstraction:** All differences (SDK, message format, response shape) are hidden inside each provider
- **Caller simplicity:** Router just calls provider.stream() or provider.complete(), doesn't care which SDK
- **Extensibility:** Adding a new provider (Claude.ai, Cohere, etc.) only requires: new file, implement interface, add to registry
- **Error consistency:** 429 rate limits bubble up with status code for caller to handle retry logic
- **Config-driven:** All model IDs and limits come from modelConfig, not hardcoded anywhere
