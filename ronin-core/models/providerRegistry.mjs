// models/providerRegistry.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Provider Registry
//
// Single point of lookup for all provider instances.
// Returns the correct provider based on provider name.
//
// Usage:
//   import { getProvider } from './providerRegistry.mjs';
//   const provider = getProvider('anthropic');
//   const { content, usage } = await provider.complete(messages, options);
//
// Rules:
//   - Each provider exists as a singleton (initialized once, reused everywhere)
//   - Unknown provider names throw immediately with clear error
//   - All providers implement the same interface: stream() and complete()
// ─────────────────────────────────────────────────────────────────────────────

import { anthropicProvider } from './anthropicProvider.mjs';
import { openaiProvider } from './openaiProvider.mjs';
import { groqProvider } from './groqProvider.mjs';
import { geminiProvider } from './geminiProvider.mjs';

// ─── Registry: provider name → instance ────────────────────────────────────────

const PROVIDERS = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  groq: groqProvider,
  gemini: geminiProvider,
};

// ─── Main lookup function ─────────────────────────────────────────────────────

export function getProvider(providerName) {
  const provider = PROVIDERS[providerName];

  if (!provider) {
    const available = Object.keys(PROVIDERS).join(', ');
    throw new Error(
      `[providerRegistry] Unknown provider: "${providerName}". Available: ${available}`
    );
  }

  return provider;
}

// ─── List all available providers ──────────────────────────────────────────────
// Useful for logging, diagnostics, or iterating all providers.

export function listProviders() {
  return Object.keys(PROVIDERS);
}

// ─── Get all provider instances ────────────────────────────────────────────────
// Useful if you need to validate all providers are initialized.

export function getAllProviders() {
  return { ...PROVIDERS };
}
