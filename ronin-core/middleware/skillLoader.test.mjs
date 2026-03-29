// ─── middleware/skillLoader.test.mjs ─────────────────────────────────────────
// Test suite for M4 RONIN Skill Loader
// Target: 40+ tests, 0 failures
// Run: node skillLoader.test.mjs 2>&1
// ─────────────────────────────────────────────────────────────────────────────

import {
  createSkillLoader,
  createSkillRegistry,
  detectDomain,
  loadSkills,
  estimateTokens,
  DOMAINS,
} from './skillLoader.mjs';

// ─── Test utilities ──────────────────────────────────────────────────────

let testCount = 0;
let passCount = 0;
let failCount = 0;

function test(name, fn) {
  testCount++;
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(() => {
        passCount++;
        console.log(`✓ ${name}`);
      }).catch(error => {
        failCount++;
        console.error(`✗ ${name}`);
        console.error(`  ${error.message}`);
      });
    }
    passCount++;
    console.log(`✓ ${name}`);
  } catch (error) {
    failCount++;
    console.error(`✗ ${name}`);
    console.error(`  ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertThrows(fn, substring) {
  try { fn(); throw new Error('Expected throw'); }
  catch (e) { if (substring && !e.message.includes(substring)) throw new Error(`Expected "${substring}" in "${e.message}"`); }
}

// ─── Helper: create a populated registry ────────────────────────────────

function createPopulatedRegistry() {
  const reg = createSkillRegistry();
  reg.register('react-basics', DOMAINS.FRONTEND, 'React is a UI library. Use components and hooks.', 10);
  reg.register('tailwind-guide', DOMAINS.FRONTEND, 'Tailwind CSS utility classes for rapid UI development.', 5);
  reg.register('express-guide', DOMAINS.BACKEND, 'Express.js routing and middleware patterns.', 10);
  reg.register('postgres-guide', DOMAINS.BACKEND, 'PostgreSQL query optimization and indexing.', 5);
  reg.register('figma-workflow', DOMAINS.DESIGN, 'Figma design system workflow and component organization.', 10);
  reg.register('swiftui-patterns', DOMAINS.MOBILE, 'SwiftUI declarative UI patterns for macOS and iOS.', 10);
  reg.register('system-design', DOMAINS.ARCHITECTURE, 'Distributed systems patterns: CQRS, event sourcing, saga.', 10);
  reg.register('docker-basics', DOMAINS.DEVOPS, 'Docker containerization and multi-stage builds.', 10);
  return reg;
}

// ─── Tests: DOMAINS enum ────────────────────────────────────────────────

console.log('\n── DOMAINS ──');

test('DOMAINS has 8 entries', () => {
  assertEqual(Object.keys(DOMAINS).length, 8);
});

test('DOMAINS is frozen', () => {
  assert(Object.isFrozen(DOMAINS));
});

// ─── Tests: estimateTokens ──────────────────────────────────────────────

console.log('\n── estimateTokens ──');

test('empty string → 0 tokens', () => {
  assertEqual(estimateTokens(''), 0);
});

test('null → 0 tokens', () => {
  assertEqual(estimateTokens(null), 0);
});

test('4 chars → 1 token', () => {
  assertEqual(estimateTokens('abcd'), 1);
});

test('100 chars → 25 tokens', () => {
  assertEqual(estimateTokens('a'.repeat(100)), 25);
});

test('5 chars → 2 tokens (rounds up)', () => {
  assertEqual(estimateTokens('abcde'), 2);
});

// ─── Tests: detectDomain ────────────────────────────────────────────────

console.log('\n── detectDomain ──');

test('"Build a React component" → frontend', () => {
  assertEqual(detectDomain('Build a React component for the dashboard'), DOMAINS.FRONTEND);
});

test('"Write an Express API endpoint" → backend', () => {
  assertEqual(detectDomain('Write an Express API endpoint for user auth'), DOMAINS.BACKEND);
});

test('"Figma mockup with spacing and color" → design', () => {
  assertEqual(detectDomain('Create a Figma mockup with better spacing and color palette'), DOMAINS.DESIGN);
});

test('"SwiftUI view for iOS" → mobile', () => {
  assertEqual(detectDomain('Create a SwiftUI view for the iOS app'), DOMAINS.MOBILE);
});

test('"Docker deployment" → devops', () => {
  assertEqual(detectDomain('Set up Docker deployment with Coolify'), DOMAINS.DEVOPS);
});

test('"microservice with CQRS and event sourcing" → architecture', () => {
  assertEqual(detectDomain('Evaluate the microservice architecture with CQRS and event sourcing trade-offs'), DOMAINS.ARCHITECTURE);
});

test('"ML model with embeddings and pandas" → data', () => {
  assertEqual(detectDomain('Train the ML model with embeddings using pandas and numpy'), DOMAINS.DATA);
});

test('empty message → general', () => {
  assertEqual(detectDomain(''), DOMAINS.GENERAL);
});

test('null → general', () => {
  assertEqual(detectDomain(null), DOMAINS.GENERAL);
});

test('ambiguous message → general', () => {
  assertEqual(detectDomain('What should I do next?'), DOMAINS.GENERAL);
});

test('vision classification boosts design', () => {
  const r = detectDomain('Check this out', { modality: 'vision' });
  assertEqual(r, DOMAINS.DESIGN);
});

test('code classification boosts backend', () => {
  const r = detectDomain('Fix the issue', { modality: 'code' });
  assertEqual(r, DOMAINS.BACKEND);
});

// ─── Tests: createSkillRegistry ─────────────────────────────────────────

console.log('\n── createSkillRegistry ──');

test('starts empty', () => {
  const reg = createSkillRegistry();
  assertEqual(reg.size(), 0);
});

test('register adds skill', () => {
  const reg = createSkillRegistry();
  reg.register('test-skill', 'frontend', 'Test content');
  assertEqual(reg.size(), 1);
});

test('getSkillsForDomain returns matching skills', () => {
  const reg = createPopulatedRegistry();
  const frontend = reg.getSkillsForDomain(DOMAINS.FRONTEND);
  assertEqual(frontend.length, 2);
});

test('getSkillsForDomain returns empty for unknown domain', () => {
  const reg = createPopulatedRegistry();
  assertEqual(reg.getSkillsForDomain('unknown').length, 0);
});

test('getSkillByName finds skill', () => {
  const reg = createPopulatedRegistry();
  const skill = reg.getSkillByName('react-basics');
  assertEqual(skill.name, 'react-basics');
  assertEqual(skill.domain, DOMAINS.FRONTEND);
});

test('getSkillByName returns null for unknown', () => {
  const reg = createPopulatedRegistry();
  assertEqual(reg.getSkillByName('nonexistent'), null);
});

test('getAllSkills returns all skills', () => {
  const reg = createPopulatedRegistry();
  assertEqual(reg.getAllSkills().length, 8);
});

test('getDomains lists registered domains', () => {
  const reg = createPopulatedRegistry();
  const domains = reg.getDomains();
  assert(domains.includes(DOMAINS.FRONTEND));
  assert(domains.includes(DOMAINS.BACKEND));
});

test('register throws for missing fields', () => {
  const reg = createSkillRegistry();
  assertThrows(() => reg.register('', 'frontend', 'content'), 'required');
  assertThrows(() => reg.register('name', '', 'content'), 'required');
  assertThrows(() => reg.register('name', 'frontend', ''), 'required');
});

test('skills sorted by priority', () => {
  const reg = createSkillRegistry();
  reg.register('low', 'test', 'low priority', 1);
  reg.register('high', 'test', 'high priority', 10);
  reg.register('mid', 'test', 'mid priority', 5);
  const skills = reg.getSkillsForDomain('test');
  assertEqual(skills[0].name, 'high');
  assertEqual(skills[1].name, 'mid');
  assertEqual(skills[2].name, 'low');
});

test('clear removes all skills', () => {
  const reg = createPopulatedRegistry();
  reg.clear();
  assertEqual(reg.size(), 0);
});

// ─── Tests: loadSkills ──────────────────────────────────────────────────

console.log('\n── loadSkills ──');

test('loads skills within budget', () => {
  const reg = createPopulatedRegistry();
  const result = loadSkills(reg, DOMAINS.FRONTEND, 5000);
  assert(result.skills.length > 0);
  assert(result.totalTokens <= 5000);
  assert(result.content.includes('React'));
});

test('returns empty for unknown domain', () => {
  const reg = createPopulatedRegistry();
  const result = loadSkills(reg, 'unknown', 5000);
  assertEqual(result.skills.length, 0);
  assertEqual(result.content, '');
});

test('respects token budget — trims if needed', () => {
  const reg = createSkillRegistry();
  reg.register('big-skill', 'test', 'x'.repeat(8000), 10); // 2000 tokens
  const result = loadSkills(reg, 'test', 500);
  assert(result.totalTokens <= 500);
  assert(result.skills[0].trimmed);
});

test('skips skills that would exceed budget', () => {
  const reg = createSkillRegistry();
  reg.register('fits', 'test', 'x'.repeat(400), 10); // 100 tokens
  reg.register('too-big', 'test', 'x'.repeat(40000), 5); // 10000 tokens
  const result = loadSkills(reg, 'test', 200);
  assertEqual(result.skills.length, 2); // fits + trimmed too-big
  assertEqual(result.skills[0].name, 'fits');
});

test('content includes skill name markers', () => {
  const reg = createPopulatedRegistry();
  const result = loadSkills(reg, DOMAINS.FRONTEND, 5000);
  assert(result.content.includes('--- Skill: react-basics ---'));
});

// ─── Tests: createSkillLoader (middleware) ───────────────────────────────

console.log('\n── createSkillLoader (middleware) ──');

await test('creates middleware function', async () => {
  const reg = createPopulatedRegistry();
  const mw = createSkillLoader(reg);
  assertEqual(typeof mw, 'function');
});

await test('detects domain and loads skills', async () => {
  const reg = createPopulatedRegistry();
  const mw = createSkillLoader(reg);
  const result = await mw({ message: 'Build a React component' }, (req) => req);
  assertEqual(result._skill_domain, DOMAINS.FRONTEND);
  assert(result._skills_loaded.includes('react-basics'));
  assert(result.skill_context.includes('React'));
});

await test('backend task loads backend skills', async () => {
  const reg = createPopulatedRegistry();
  const mw = createSkillLoader(reg);
  const result = await mw({ message: 'Create an Express API endpoint' }, (req) => req);
  assertEqual(result._skill_domain, DOMAINS.BACKEND);
  assert(result._skills_loaded.includes('express-guide'));
});

await test('no skills for general domain', async () => {
  const reg = createPopulatedRegistry();
  const mw = createSkillLoader(reg);
  const result = await mw({ message: 'How are you?' }, (req) => req);
  assertEqual(result._skill_domain, DOMAINS.GENERAL);
  assertEqual(result._skills_loaded.length, 0);
});

await test('respects maxTokens config', async () => {
  const reg = createPopulatedRegistry();
  const mw = createSkillLoader(reg, { maxTokens: 10 });
  const result = await mw({ message: 'Build a React component' }, (req) => req);
  assert(result._skill_tokens <= 10);
});

await test('tracks usage stats', async () => {
  const reg = createPopulatedRegistry();
  const mw = createSkillLoader(reg);
  const next = (req) => req;
  await mw({ message: 'React component please' }, next);
  await mw({ message: 'Another React component' }, next);
  await mw({ message: 'Express API endpoint' }, next);

  const stats = mw.getSkillUsageStats();
  assertEqual(stats.get('react-basics'), 2);
  assertEqual(stats.get('express-guide'), 1);
});

await test('uses classification from pre-classifier', async () => {
  const reg = createPopulatedRegistry();
  const mw = createSkillLoader(reg);
  const result = await mw({
    message: 'Check this design',
    classification: { modality: 'vision' },
  }, (req) => req);
  assertEqual(result._skill_domain, DOMAINS.DESIGN);
});

await test('returns enriched request when no next function', async () => {
  const reg = createPopulatedRegistry();
  const mw = createSkillLoader(reg);
  const result = await mw({ message: 'React' });
  assertEqual(result._skill_domain, DOMAINS.FRONTEND);
});

await test('preserves original request fields', async () => {
  const reg = createPopulatedRegistry();
  const mw = createSkillLoader(reg);
  const result = await mw({ message: 'React', custom: 42 }, (req) => req);
  assertEqual(result.custom, 42);
});

// ─── Summary ─────────────────────────────────────────────────────────────

await new Promise(r => setTimeout(r, 50));

console.log(`\n${'─'.repeat(60)}`);
console.log(`M4 skillLoader: ${passCount}/${testCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
