// config/envVault.mjs
// ─────────────────────────────────────────────────────────────────────────────
// RONIN Environment Vault — AES-256-GCM encrypted .env protection
//
// Flow:
//   1. First run:  `node config/envVault.mjs encrypt` reads .env → writes .env.enc
//   2. Production: `loadEnv()` reads .env.enc → decrypts → injects into process.env
//   3. Dev mode:   Falls back to dotenv if .env exists and no .env.enc found
//
// The encryption key is derived from a master password using PBKDF2 (100k rounds).
// After encrypting, you can safely DELETE .env — the vault has your keys.
//
// Usage in code:
//   import { loadEnv } from './config/envVault.mjs';
//   await loadEnv();  // keys now in process.env
//
// CLI:
//   node config/envVault.mjs encrypt   — encrypt .env → .env.enc (prompts for password)
//   node config/envVault.mjs decrypt   — decrypt .env.enc → stdout (prompts for password)
//   node config/envVault.mjs rotate    — re-encrypt with new password
// ─────────────────────────────────────────────────────────────────────────────

import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const ENV_PATH     = resolve(ROOT, '.env');
const VAULT_PATH   = resolve(ROOT, '.env.enc');
const ALGORITHM    = 'aes-256-gcm';
const KEY_LENGTH   = 32;  // 256 bits
const IV_LENGTH    = 16;  // 128 bits
const SALT_LENGTH  = 32;  // 256 bits
const TAG_LENGTH   = 16;  // 128 bits (GCM auth tag)
const PBKDF2_ROUNDS = 100_000;
const VAULT_MAGIC   = 'RONIN_VAULT_V1';  // file format identifier

// ─── Key Derivation ─────────────────────────────────────────────────────────

function deriveKey(password, salt) {
  return pbkdf2Sync(password, salt, PBKDF2_ROUNDS, KEY_LENGTH, 'sha512');
}

// ─── Encrypt ────────────────────────────────────────────────────────────────

export function encrypt(plaintext, password) {
  const salt = randomBytes(SALT_LENGTH);
  const key  = deriveKey(password, salt);
  const iv   = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  // File format: MAGIC | salt (32) | iv (16) | tag (16) | ciphertext
  const magic = Buffer.from(VAULT_MAGIC, 'utf8');
  return Buffer.concat([magic, salt, iv, tag, encrypted]);
}

// ─── Decrypt ────────────────────────────────────────────────────────────────

export function decrypt(vaultBuffer, password) {
  // Verify magic header
  const magic = vaultBuffer.subarray(0, VAULT_MAGIC.length).toString('utf8');
  if (magic !== VAULT_MAGIC) {
    throw new Error('[envVault] Invalid vault file — not a RONIN vault or corrupted');
  }

  let offset = VAULT_MAGIC.length;
  const salt = vaultBuffer.subarray(offset, offset + SALT_LENGTH);
  offset += SALT_LENGTH;
  const iv = vaultBuffer.subarray(offset, offset + IV_LENGTH);
  offset += IV_LENGTH;
  const tag = vaultBuffer.subarray(offset, offset + TAG_LENGTH);
  offset += TAG_LENGTH;
  const ciphertext = vaultBuffer.subarray(offset);

  const key = deriveKey(password, salt);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  try {
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch (err) {
    throw new Error('[envVault] Decryption failed — wrong password or corrupted vault');
  }
}

// ─── Parse .env content into key-value pairs ────────────────────────────────

function parseEnv(content) {
  const env = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

// ─── Load Environment ───────────────────────────────────────────────────────
// Priority: .env.enc (vault) > .env (plaintext fallback for dev)

export async function loadEnv(options = {}) {
  const { password, envPath, vaultPath } = options;
  const resolvedEnvPath   = envPath   || ENV_PATH;
  const resolvedVaultPath = vaultPath || VAULT_PATH;

  // 1. Try encrypted vault first
  if (existsSync(resolvedVaultPath)) {
    const vaultPassword = password || process.env.RONIN_VAULT_PASSWORD;

    if (!vaultPassword) {
      console.warn('[envVault] .env.enc found but no password provided.');
      console.warn('[envVault] Set RONIN_VAULT_PASSWORD env var or pass { password } option.');
      console.warn('[envVault] Falling back to .env if available...');
    } else {
      const vaultData = readFileSync(resolvedVaultPath);
      const plaintext = decrypt(vaultData, vaultPassword);
      const parsed = parseEnv(plaintext);

      let loaded = 0;
      for (const [key, value] of Object.entries(parsed)) {
        process.env[key] = value;  // override: true — vault always wins
        loaded++;
      }

      console.log(`[envVault] Loaded ${loaded} keys from encrypted vault`);
      return { source: 'vault', keysLoaded: loaded };
    }
  }

  // 2. Fallback: plain .env (dev mode)
  if (existsSync(resolvedEnvPath)) {
    const content = readFileSync(resolvedEnvPath, 'utf8');
    const parsed = parseEnv(content);

    let loaded = 0;
    for (const [key, value] of Object.entries(parsed)) {
      process.env[key] = value;  // override to handle pre-set empty vars
      loaded++;
    }

    console.log(`[envVault] Loaded ${loaded} keys from .env (plaintext — encrypt for production)`);
    return { source: 'plaintext', keysLoaded: loaded };
  }

  console.warn('[envVault] No .env or .env.enc found — environment not loaded');
  return { source: 'none', keysLoaded: 0 };
}

// ─── CLI ────────────────────────────────────────────────────────────────────

async function promptPassword(prompt) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function cli() {
  const command = process.argv[2];

  if (!command || !['encrypt', 'decrypt', 'rotate'].includes(command)) {
    console.log('Usage: node config/envVault.mjs <encrypt|decrypt|rotate>');
    console.log();
    console.log('  encrypt  — Read .env → write .env.enc (AES-256-GCM)');
    console.log('  decrypt  — Read .env.enc → print to stdout');
    console.log('  rotate   — Re-encrypt .env.enc with a new password');
    process.exit(0);
  }

  if (command === 'encrypt') {
    if (!existsSync(ENV_PATH)) {
      console.error('[envVault] No .env file found at:', ENV_PATH);
      process.exit(1);
    }

    const password = await promptPassword('Enter vault password: ');
    const confirm  = await promptPassword('Confirm password: ');
    if (password !== confirm) {
      console.error('[envVault] Passwords do not match.');
      process.exit(1);
    }
    if (password.length < 8) {
      console.error('[envVault] Password must be at least 8 characters.');
      process.exit(1);
    }

    const plaintext = readFileSync(ENV_PATH, 'utf8');
    const vaultData = encrypt(plaintext, password);
    writeFileSync(VAULT_PATH, vaultData);

    // Count keys for feedback
    const keyCount = parseEnv(plaintext);
    console.log(`[envVault] ✓ Encrypted ${Object.keys(keyCount).length} keys → .env.enc`);
    console.log('[envVault] You can now safely delete .env:');
    console.log('           rm ronin-core/.env');
    console.log('[envVault] To load at runtime, set RONIN_VAULT_PASSWORD or pass { password } to loadEnv()');
  }

  if (command === 'decrypt') {
    if (!existsSync(VAULT_PATH)) {
      console.error('[envVault] No .env.enc found at:', VAULT_PATH);
      process.exit(1);
    }

    const password = await promptPassword('Enter vault password: ');
    const vaultData = readFileSync(VAULT_PATH);
    const plaintext = decrypt(vaultData, password);
    process.stdout.write(plaintext);
  }

  if (command === 'rotate') {
    if (!existsSync(VAULT_PATH)) {
      console.error('[envVault] No .env.enc found at:', VAULT_PATH);
      process.exit(1);
    }

    const oldPassword = await promptPassword('Current password: ');
    const vaultData = readFileSync(VAULT_PATH);
    const plaintext = decrypt(vaultData, oldPassword);

    const newPassword = await promptPassword('New password: ');
    const confirm     = await promptPassword('Confirm new password: ');
    if (newPassword !== confirm) {
      console.error('[envVault] Passwords do not match.');
      process.exit(1);
    }
    if (newPassword.length < 8) {
      console.error('[envVault] Password must be at least 8 characters.');
      process.exit(1);
    }

    const newVaultData = encrypt(plaintext, newPassword);
    writeFileSync(VAULT_PATH, newVaultData);
    console.log('[envVault] ✓ Vault re-encrypted with new password');
  }
}

// Run CLI if executed directly
const isMainModule = process.argv[1] &&
  process.argv[1].endsWith('envVault.mjs');
if (isMainModule) {
  cli().catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}
