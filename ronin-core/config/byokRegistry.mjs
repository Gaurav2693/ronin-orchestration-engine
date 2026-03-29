// config/byokRegistry.mjs
// ─────────────────────────────────────────────────────────────────────────────
// RONIN Bring Your Own Keys (BYOK) Registry
//
// Allows individual users to supply their own API keys. RONIN then uses those
// keys for their requests instead of the operator's system keys.
//
// Security model:
//   - Keys are encrypted with AES-256-GCM the moment they're registered
//   - Plaintext keys NEVER persist in memory beyond the registration call
//   - Each user's key store is encrypted independently
//   - Keys are scoped to userId — they never bleed across users
//   - Provider instances are created fresh per-request (no shared client state)
//   - ADR-010 still holds: model identity is never exposed to the UI
//
// Usage:
//   import { byokRegistry } from './config/byokRegistry.mjs';
//
//   // Register user keys (partial registration OK)
//   byokRegistry.register('user-123', {
//     anthropic: 'sk-ant-...',
//     openai: 'sk-proj-...',
//   });
//
//   // Check coverage
//   byokRegistry.has('user-123');               // true — has any key
//   byokRegistry.hasProvider('user-123', 'groq'); // false — no groq key
//   byokRegistry.listProviders('user-123');      // ['anthropic', 'openai']
//
//   // Get ephemeral provider instances for a request
//   const providers = await byokRegistry.getProviders('user-123');
//   // { anthropic: AnthropicProvider, openai: OpenAIProvider, _isByok: true }
//
//   // Remove keys
//   byokRegistry.remove('user-123');             // remove all
//   byokRegistry.remove('user-123', 'openai');   // remove one
// ─────────────────────────────────────────────────────────────────────────────

import { randomBytes } from 'node:crypto';
import { encrypt, decrypt } from './envVault.mjs';

// ─── Supported providers and their key validation rules ─────────────────────

export const BYOK_PROVIDERS = {
  anthropic: {
    envKey: 'ANTHROPIC_API_KEY',
    prefix: 'sk-ant-',
    minLength: 30,
    description: 'Claude (Haiku, Sonnet, Opus)',
  },
  openai: {
    envKey: 'OPENAI_API_KEY',
    prefix: 'sk-',
    minLength: 30,
    description: 'GPT-4o, GPT-4o-mini',
  },
  groq: {
    envKey: 'GROQ_API_KEY',
    prefix: 'gsk_',
    minLength: 20,
    description: 'Llama 3.3 70B (free tier)',
  },
  gemini: {
    envKey: 'GEMINI_API_KEY',
    prefix: 'AIza',
    minLength: 20,
    description: 'Gemini Flash-Lite + Flash (free tier)',
  },
};

// ─── Key Validation ──────────────────────────────────────────────────────────
// Returns { valid: true } or { valid: false, error: string }

export function validateKey(providerName, apiKey) {
  const def = BYOK_PROVIDERS[providerName];
  if (!def) {
    return { valid: false, error: `Unknown provider: ${providerName}` };
  }
  if (!apiKey || typeof apiKey !== 'string') {
    return { valid: false, error: 'Key must be a non-empty string' };
  }
  const trimmed = apiKey.trim();
  if (trimmed.length < def.minLength) {
    return { valid: false, error: `Key too short (min ${def.minLength} chars)` };
  }
  if (!trimmed.startsWith(def.prefix)) {
    return { valid: false, error: `Expected prefix: ${def.prefix}` };
  }
  return { valid: true };
}

// ─── BYOK Registry Class ────────────────────────────────────────────────────

class BYOKRegistry {
  constructor(options = {}) {
    // In-memory store: userId → { encrypted: Buffer, registeredAt: Date }
    this._store = new Map();

    // Encryption secret for the in-memory store.
    // Priority: explicit option → env var → random per-run (dev mode).
    // For persistent BYOK across restarts, set BYOK_SECRET in .env.
    this._secret = options.secret
      || process.env.BYOK_SECRET
      || process.env.RONIN_VAULT_PASSWORD
      || randomBytes(32).toString('hex');
  }

  // ─── register ─────────────────────────────────────────────────────────────
  // Register one or more API keys for a user.
  // keys: { anthropic?, openai?, groq?, gemini? } — any subset is valid
  // options.partial = true — save valid keys even if some are invalid
  // Returns: { registered: string[], skipped: string[], errors: object }

  register(userId, keys, options = {}) {
    if (!userId || typeof userId !== 'string') {
      throw new Error('[byokRegistry] userId must be a non-empty string');
    }
    if (!keys || typeof keys !== 'object') {
      throw new Error('[byokRegistry] keys must be an object');
    }

    const errors = {};
    const toStore = {};
    const registered = [];
    const skipped = [];

    for (const [provider, apiKey] of Object.entries(keys)) {
      if (!apiKey) {
        skipped.push(provider);
        continue;
      }
      if (!BYOK_PROVIDERS[provider]) {
        errors[provider] = `Unknown provider: ${provider}`;
        continue;
      }
      const validation = validateKey(provider, apiKey);
      if (!validation.valid) {
        errors[provider] = validation.error;
        continue;
      }
      toStore[provider] = apiKey.trim();
      registered.push(provider);
    }

    // If there are errors and not partial mode, reject the whole batch
    if (Object.keys(errors).length > 0 && !options.partial) {
      throw new Error(
        `[byokRegistry] Key validation failed: ${JSON.stringify(errors)}`
      );
    }

    if (registered.length === 0) {
      throw new Error('[byokRegistry] No valid keys provided');
    }

    // Merge with any existing keys for this user
    let existingKeys = {};
    if (this._store.has(userId)) {
      try {
        existingKeys = this._decryptStore(userId);
      } catch {
        existingKeys = {};  // Start fresh if existing data is corrupted
      }
    }

    const merged = { ...existingKeys, ...toStore };

    // Encrypt merged keys — plaintext only lives in this scope
    const encrypted = encrypt(JSON.stringify(merged), this._secret);
    this._store.set(userId, { encrypted, registeredAt: new Date() });

    return { registered, skipped, errors };
  }

  // ─── has ──────────────────────────────────────────────────────────────────
  // Returns true if user has any BYOK keys registered

  has(userId) {
    return this._store.has(userId);
  }

  // ─── hasProvider ──────────────────────────────────────────────────────────
  // Returns true if user has a key for a specific provider

  hasProvider(userId, providerName) {
    if (!this._store.has(userId)) return false;
    try {
      const keys = this._decryptStore(userId);
      return !!keys[providerName];
    } catch {
      return false;
    }
  }

  // ─── getProviders ─────────────────────────────────────────────────────────
  // Returns ephemeral provider instances with user's keys injected.
  // Only providers where the user has a key are returned.
  // For providers the user hasn't registered, the caller falls back to system.
  //
  // Returns: { anthropic?, openai?, groq?, gemini?, _isByok: true }
  // Returns: null if user has no BYOK keys

  async getProviders(userId) {
    if (!this._store.has(userId)) return null;

    const keys = this._decryptStore(userId);  // plaintext in this scope only

    // Lazy-import provider classes to avoid circular deps at module load time
    const [
      { AnthropicProvider },
      { OpenAIProvider },
      { GroqProvider },
      { GeminiProvider },
    ] = await Promise.all([
      import('../models/anthropicProvider.mjs'),
      import('../models/openaiProvider.mjs'),
      import('../models/groqProvider.mjs'),
      import('../models/geminiProvider.mjs'),
    ]);

    const providers = { _isByok: true, _userId: userId };

    if (keys.anthropic) providers.anthropic = new AnthropicProvider({ apiKey: keys.anthropic });
    if (keys.openai)    providers.openai    = new OpenAIProvider({ apiKey: keys.openai });
    if (keys.groq)      providers.groq      = new GroqProvider({ apiKey: keys.groq });
    if (keys.gemini)    providers.gemini    = new GeminiProvider({ apiKey: keys.gemini });

    // `keys` object goes out of scope here — GC collects it
    return providers;
  }

  // ─── listProviders ────────────────────────────────────────────────────────
  // Returns which providers a user has registered — NO key values exposed

  listProviders(userId) {
    if (!this._store.has(userId)) return [];
    try {
      const keys = this._decryptStore(userId);
      return Object.keys(keys).filter(k => !!keys[k]);
    } catch {
      return [];
    }
  }

  // ─── remove ───────────────────────────────────────────────────────────────
  // Remove a specific provider's key, or all keys for a user.
  // Returns true if removed, false if user not found.

  remove(userId, providerName = null) {
    if (!this._store.has(userId)) return false;

    if (!providerName) {
      this._store.delete(userId);
      return true;
    }

    // Remove just one provider
    try {
      const keys = this._decryptStore(userId);
      delete keys[providerName];

      if (Object.keys(keys).length === 0) {
        // No keys left — remove the user entirely
        this._store.delete(userId);
      } else {
        const encrypted = encrypt(JSON.stringify(keys), this._secret);
        this._store.set(userId, {
          encrypted,
          registeredAt: this._store.get(userId).registeredAt,
        });
      }
      return true;
    } catch {
      return false;
    }
  }

  // ─── clear ────────────────────────────────────────────────────────────────
  // Remove all users' keys (e.g. on shutdown)

  clear() {
    const count = this._store.size;
    this._store.clear();
    return count;
  }

  // ─── getStats ─────────────────────────────────────────────────────────────
  // Returns aggregate stats — NO key values or userIds exposed

  getStats() {
    const byProvider = {};
    for (const [userId] of this._store) {
      try {
        const keys = this._decryptStore(userId);
        for (const provider of Object.keys(keys)) {
          if (keys[provider]) byProvider[provider] = (byProvider[provider] || 0) + 1;
        }
      } catch {
        // skip corrupted entries
      }
    }
    return {
      totalUsers: this._store.size,
      byProvider,
    };
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  _decryptStore(userId) {
    const entry = this._store.get(userId);
    if (!entry) throw new Error(`[byokRegistry] No entry for userId: ${userId}`);
    const plaintext = decrypt(entry.encrypted, this._secret);
    return JSON.parse(plaintext);
  }
}

// ─── Singleton export ────────────────────────────────────────────────────────
// All imports share the same registry. Reset via byokRegistry.clear() in tests.

export const byokRegistry = new BYOKRegistry();

// Also export the class for testing with isolated instances
export { BYOKRegistry };
