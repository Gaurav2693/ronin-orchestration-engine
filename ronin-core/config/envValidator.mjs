// config/envValidator.mjs
// ─────────────────────────────────────────────────────────────────────────────
// RONIN Environment Validator
//
// Validates that all required API keys and config are present and well-formed
// BEFORE any provider tries to use them. Call once at startup.
//
// Usage:
//   import { validateEnv } from './config/envValidator.mjs';
//   const result = validateEnv();
//   if (!result.valid) process.exit(1);
// ─────────────────────────────────────────────────────────────────────────────

// ─── Key Definitions ────────────────────────────────────────────────────────
// Each key has: name, required (hard fail), prefix (format check), tier

const KEY_DEFINITIONS = [
  // Free tier — powers 60%+ of requests
  {
    name: 'GEMINI_API_KEY',
    required: true,
    prefix: 'AIza',
    tier: 'free',
    description: 'Google Gemini (Flash-Lite + Flash) — fast worker + vision',
  },
  {
    name: 'GROQ_API_KEY',
    required: true,
    prefix: 'gsk_',
    tier: 'free',
    description: 'Groq (Llama 3.3 70B) — fast fallback',
  },

  // Paid tier — premium tasks only
  {
    name: 'ANTHROPIC_API_KEY',
    required: true,
    prefix: 'sk-ant-',
    tier: 'paid',
    description: 'Anthropic (Claude Haiku + Sonnet) — core brain + ops',
  },
  {
    name: 'OPENAI_API_KEY',
    required: true,
    prefix: 'sk-',
    tier: 'paid',
    description: 'OpenAI (GPT-4o + GPT-4o-mini) — agent + codex workers',
  },

  // Local — optional
  {
    name: 'OLLAMA_HOST',
    required: false,
    prefix: null,  // URL, no prefix check
    tier: 'local',
    description: 'Ollama local model server',
  },
];

// ─── Validation ─────────────────────────────────────────────────────────────

export function validateEnv(options = {}) {
  const { silent = false, strict = false } = options;
  const errors   = [];
  const warnings = [];
  const loaded   = [];

  for (const def of KEY_DEFINITIONS) {
    const value = process.env[def.name];

    // Missing check
    if (!value || value.trim() === '') {
      if (def.required) {
        errors.push(`✗ ${def.name} — MISSING (${def.description})`);
      } else {
        warnings.push(`○ ${def.name} — not set (optional: ${def.description})`);
      }
      continue;
    }

    // Format check (prefix validation)
    if (def.prefix && !value.startsWith(def.prefix)) {
      errors.push(`✗ ${def.name} — invalid format (expected prefix: ${def.prefix}*)`);
      continue;
    }

    // Length sanity check — most API keys are 30+ characters
    if (value.length < 20) {
      warnings.push(`⚠ ${def.name} — suspiciously short (${value.length} chars)`);
    }

    loaded.push(`✓ ${def.name} [${def.tier}] — ${value.slice(0, 8)}...${value.slice(-4)}`);
  }

  // ─── Additional config checks ───────────────────────────────────────────

  const dailyLimit = parseFloat(process.env.DAILY_COST_LIMIT);
  if (isNaN(dailyLimit) || dailyLimit <= 0) {
    warnings.push('⚠ DAILY_COST_LIMIT — not set or invalid (defaulting to $1.00)');
  }

  // ─── Report ─────────────────────────────────────────────────────────────

  const valid = errors.length === 0;

  if (!silent) {
    console.log('\n┌─── RONIN Environment Check ─────────────────────────┐');

    if (loaded.length > 0) {
      for (const l of loaded) console.log(`│  ${l}`);
    }
    if (warnings.length > 0) {
      console.log('│');
      for (const w of warnings) console.log(`│  ${w}`);
    }
    if (errors.length > 0) {
      console.log('│');
      for (const e of errors) console.log(`│  ${e}`);
    }

    console.log('│');
    if (valid) {
      console.log(`│  🟢 All ${loaded.length} keys valid. RONIN ready.`);
    } else {
      console.log(`│  🔴 ${errors.length} error(s). Fix before starting RONIN.`);
    }
    console.log('└────────────────────────────────────────────────────┘\n');
  }

  if (!valid && strict) {
    throw new Error(`[envValidator] ${errors.length} required key(s) missing or invalid`);
  }

  return {
    valid,
    loaded: loaded.length,
    errors,
    warnings,
  };
}

// ─── CLI: run directly for a quick check ────────────────────────────────────

const isMainModule = process.argv[1] &&
  process.argv[1].endsWith('envValidator.mjs');
if (isMainModule) {
  // Load env first
  const { loadEnv } = await import('./envVault.mjs');
  await loadEnv();
  const result = validateEnv();
  process.exit(result.valid ? 0 : 1);
}
