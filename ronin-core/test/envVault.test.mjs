// test/envVault.test.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Tests for RONIN Environment Vault (AES-256-GCM encryption)
// ─────────────────────────────────────────────────────────────────────────────

import { encrypt, decrypt, loadEnv } from '../config/envVault.mjs';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'Assertion failed'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

console.log('\n─── envVault.test.mjs ───────────────────────────────────\n');

// ─── Encrypt / Decrypt round-trip ────────────────────────────────────────────

console.log('Encrypt / Decrypt:');

test('encrypts and decrypts simple text', () => {
  const plaintext = 'HELLO=world';
  const password = 'testpassword123';
  const encrypted = encrypt(plaintext, password);
  const decrypted = decrypt(encrypted, password);
  assertEqual(decrypted, plaintext);
});

test('encrypts and decrypts multi-line .env content', () => {
  const env = `# Comment
GEMINI_API_KEY=AIzaSyTest123
GROQ_API_KEY=gsk_testkey456
ANTHROPIC_API_KEY=sk-ant-api03-testkey
OPENAI_API_KEY=sk-proj-testkey789`;

  const password = 'strong-password-here';
  const encrypted = encrypt(env, password);
  const decrypted = decrypt(encrypted, password);
  assertEqual(decrypted, env);
});

test('encrypted output is a Buffer', () => {
  const encrypted = encrypt('test', 'password123456');
  assert(Buffer.isBuffer(encrypted), 'Expected Buffer');
});

test('encrypted output starts with RONIN_VAULT_V1 magic', () => {
  const encrypted = encrypt('test', 'password123456');
  const magic = encrypted.subarray(0, 14).toString('utf8');
  assertEqual(magic, 'RONIN_VAULT_V1');
});

test('encrypted output is longer than plaintext (salt + iv + tag + cipher)', () => {
  const plaintext = 'SHORT';
  const encrypted = encrypt(plaintext, 'password123456');
  assert(encrypted.length > plaintext.length + 64, 'Encrypted should be much longer');
});

test('same plaintext + password produces different ciphertext (random salt/iv)', () => {
  const plaintext = 'SAME=content';
  const password = 'password123456';
  const enc1 = encrypt(plaintext, password);
  const enc2 = encrypt(plaintext, password);
  assert(!enc1.equals(enc2), 'Two encryptions should differ (random salt)');
});

// ─── Wrong password ──────────────────────────────────────────────────────────

console.log('\nWrong password / corruption:');

test('throws on wrong password', () => {
  const encrypted = encrypt('SECRET=value', 'correct-password');
  let threw = false;
  try {
    decrypt(encrypted, 'wrong-password');
  } catch (err) {
    threw = true;
    assert(err.message.includes('wrong password'), `Expected 'wrong password' in: ${err.message}`);
  }
  assert(threw, 'Should have thrown');
});

test('throws on corrupted vault (bad magic)', () => {
  const badData = Buffer.from('NOT_A_VAULT_xxxxxxxxxxxxxxxxxxxx');
  let threw = false;
  try {
    decrypt(badData, 'any-password');
  } catch (err) {
    threw = true;
    assert(err.message.includes('Invalid vault'), `Expected 'Invalid vault' in: ${err.message}`);
  }
  assert(threw, 'Should have thrown');
});

test('throws on truncated vault', () => {
  const encrypted = encrypt('data=test', 'password123456');
  const truncated = encrypted.subarray(0, 20);  // way too short
  let threw = false;
  try {
    decrypt(truncated, 'password123456');
  } catch (err) {
    threw = true;
  }
  assert(threw, 'Should have thrown on truncated data');
});

test('throws on tampered ciphertext', () => {
  const encrypted = encrypt('data=test', 'password123456');
  // Flip a byte in the ciphertext area
  encrypted[encrypted.length - 1] ^= 0xFF;
  let threw = false;
  try {
    decrypt(encrypted, 'password123456');
  } catch (err) {
    threw = true;
  }
  assert(threw, 'Should have thrown on tampered data');
});

// ─── Special characters ─────────────────────────────────────────────────────

console.log('\nSpecial characters:');

test('handles keys with special characters', () => {
  const env = 'KEY=value-with-$pecial_chars!@#%^&*()';
  const decrypted = decrypt(encrypt(env, 'pass12345678'), 'pass12345678');
  assertEqual(decrypted, env);
});

test('handles unicode in values', () => {
  const env = 'KEY=日本語テスト';
  const decrypted = decrypt(encrypt(env, 'pass12345678'), 'pass12345678');
  assertEqual(decrypted, env);
});

test('handles empty value', () => {
  const env = 'KEY=';
  const decrypted = decrypt(encrypt(env, 'pass12345678'), 'pass12345678');
  assertEqual(decrypted, env);
});

test('handles very long keys', () => {
  const longValue = 'X'.repeat(10000);
  const env = `LONG_KEY=${longValue}`;
  const decrypted = decrypt(encrypt(env, 'pass12345678'), 'pass12345678');
  assertEqual(decrypted, env);
});

// ─── loadEnv from vault ─────────────────────────────────────────────────────

console.log('\nloadEnv():');

const TMP_ENV = resolve('/tmp', '.ronin-test.env');
const TMP_VAULT = resolve('/tmp', '.ronin-test.env.enc');

function cleanup() {
  if (existsSync(TMP_ENV)) unlinkSync(TMP_ENV);
  if (existsSync(TMP_VAULT)) unlinkSync(TMP_VAULT);
}

await testAsync('loads from plaintext .env when no vault exists', async () => {
  cleanup();
  writeFileSync(TMP_ENV, 'TEST_VAR_A=hello_from_env\nTEST_VAR_B=42');
  delete process.env.TEST_VAR_A;
  delete process.env.TEST_VAR_B;

  const result = await loadEnv({ envPath: TMP_ENV, vaultPath: TMP_VAULT });
  assertEqual(result.source, 'plaintext');
  assertEqual(result.keysLoaded, 2);
  assertEqual(process.env.TEST_VAR_A, 'hello_from_env');
  assertEqual(process.env.TEST_VAR_B, '42');

  delete process.env.TEST_VAR_A;
  delete process.env.TEST_VAR_B;
  cleanup();
});

await testAsync('loads from encrypted vault with password', async () => {
  cleanup();
  const envContent = 'VAULT_TEST_KEY=encrypted_secret\nVAULT_TEST_NUM=99';
  const vaultData = encrypt(envContent, 'vault-test-pass');
  writeFileSync(TMP_VAULT, vaultData);
  delete process.env.VAULT_TEST_KEY;
  delete process.env.VAULT_TEST_NUM;

  const result = await loadEnv({ password: 'vault-test-pass', envPath: TMP_ENV, vaultPath: TMP_VAULT });
  assertEqual(result.source, 'vault');
  assertEqual(result.keysLoaded, 2);
  assertEqual(process.env.VAULT_TEST_KEY, 'encrypted_secret');
  assertEqual(process.env.VAULT_TEST_NUM, '99');

  delete process.env.VAULT_TEST_KEY;
  delete process.env.VAULT_TEST_NUM;
  cleanup();
});

await testAsync('vault takes priority over plaintext .env', async () => {
  cleanup();
  writeFileSync(TMP_ENV, 'PRIORITY_KEY=from_plaintext');
  const vaultData = encrypt('PRIORITY_KEY=from_vault', 'pass12345678');
  writeFileSync(TMP_VAULT, vaultData);
  delete process.env.PRIORITY_KEY;

  const result = await loadEnv({ password: 'pass12345678', envPath: TMP_ENV, vaultPath: TMP_VAULT });
  assertEqual(result.source, 'vault');
  assertEqual(process.env.PRIORITY_KEY, 'from_vault');

  delete process.env.PRIORITY_KEY;
  cleanup();
});

await testAsync('returns source: none when no files exist', async () => {
  cleanup();
  const result = await loadEnv({ envPath: TMP_ENV, vaultPath: TMP_VAULT });
  assertEqual(result.source, 'none');
  assertEqual(result.keysLoaded, 0);
});

await testAsync('skips comments and empty lines in plaintext', async () => {
  cleanup();
  writeFileSync(TMP_ENV, '# This is a comment\n\nCOMMENT_TEST=works\n\n# Another comment');
  delete process.env.COMMENT_TEST;

  const result = await loadEnv({ envPath: TMP_ENV, vaultPath: TMP_VAULT });
  assertEqual(result.keysLoaded, 1);
  assertEqual(process.env.COMMENT_TEST, 'works');

  delete process.env.COMMENT_TEST;
  cleanup();
});

await testAsync('strips quotes from values', async () => {
  cleanup();
  writeFileSync(TMP_ENV, 'QUOTED_DOUBLE="hello"\nQUOTED_SINGLE=\'world\'');
  delete process.env.QUOTED_DOUBLE;
  delete process.env.QUOTED_SINGLE;

  const result = await loadEnv({ envPath: TMP_ENV, vaultPath: TMP_VAULT });
  assertEqual(process.env.QUOTED_DOUBLE, 'hello');
  assertEqual(process.env.QUOTED_SINGLE, 'world');

  delete process.env.QUOTED_DOUBLE;
  delete process.env.QUOTED_SINGLE;
  cleanup();
});

await testAsync('overrides pre-existing empty env vars', async () => {
  cleanup();
  process.env.OVERRIDE_TEST = '';
  writeFileSync(TMP_ENV, 'OVERRIDE_TEST=loaded_value');

  const result = await loadEnv({ envPath: TMP_ENV, vaultPath: TMP_VAULT });
  assertEqual(process.env.OVERRIDE_TEST, 'loaded_value');

  delete process.env.OVERRIDE_TEST;
  cleanup();
});

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\n─── Results: ${passed} passed, ${failed} failed ───\n`);
process.exit(failed > 0 ? 1 : 0);
