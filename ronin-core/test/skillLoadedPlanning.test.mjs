// test/skillLoadedPlanning.test.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Tests for Gate 04: Skill-Loaded Planning
// ─────────────────────────────────────────────────────────────────────────────

import {
  DOMAINS,
  detectDomain,
  getSkillForDomain,
  createPlanStructure,
  generatePlan,
} from '../gates/skillLoadedPlanning.mjs';

let passed = 0;
let failed = 0;

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

function assert(cond, msg)      { if (!cond) throw new Error(msg || 'Assertion failed'); }
function assertEqual(a, b, msg) { if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

// ─── Mock planner and skill loader ────────────────────────────────────────────

function makePlanner(options = {}) {
  return {
    async execute(payload) {
      if (options.fail) throw new Error('Planner failed');
      const plan = options.plan || {
        fileStructure: [{ path: 'src/App.tsx', type: 'component', purpose: 'root' }],
        componentTree: [{ name: 'App', parent: null, children: [], props: [] }],
        dependencies: [{ name: 'react', version: '^18', reason: 'core' }],
        taskManifest: [
          { id: 'T1', description: 'Create App component', type: 'component', files: ['src/App.tsx'], critical: true },
        ],
        edgeCases: [],
        acceptanceCriteria: ['App renders without errors'],
      };
      return {
        result: options.raw ? options.raw : JSON.stringify(plan),
        cost:   0.002,
      };
    },
  };
}

function makeSkillLoader(options = {}) {
  return {
    async load(skillName, maxTokens) {
      if (options.fail) throw new Error('Skill load failed');
      return {
        content:    options.content || `Skill context for ${skillName} (${maxTokens} tokens max)`,
        tokenCount: options.tokenCount || 500,
      };
    },
  };
}

console.log('\n─── skillLoadedPlanning.test.mjs ────────────────────────\n');

// ─── detectDomain ─────────────────────────────────────────────────────────────

console.log('detectDomain:');

await testAsync('detects REACT domain from brief', async () => {
  assertEqual(detectDomain('build a React component with useState'), DOMAINS.REACT, 'domain');
});

await testAsync('detects REACT from jsx mention', async () => {
  assertEqual(detectDomain('create a .jsx file with hooks'), DOMAINS.REACT, 'domain');
});

await testAsync('detects SWIFT domain from brief', async () => {
  assertEqual(detectDomain('build a SwiftUI view for macOS'), DOMAINS.SWIFT, 'domain');
});

await testAsync('detects ARCHITECTURE domain', async () => {
  assertEqual(detectDomain('design the system architecture for a microservice pipeline'), DOMAINS.ARCHITECTURE, 'domain');
});

await testAsync('detects DESIGN domain from figma mention', async () => {
  assertEqual(detectDomain('convert this Figma design system to tokens'), DOMAINS.DESIGN, 'domain');
});

await testAsync('detects BACKEND domain from api mention', async () => {
  assertEqual(detectDomain('build a REST API with postgres and express'), DOMAINS.BACKEND, 'domain');
});

await testAsync('returns GENERIC when no signals match', async () => {
  assertEqual(detectDomain('do something vague'), DOMAINS.GENERIC, 'domain');
});

await testAsync('considers direction string in detection', async () => {
  // Brief has no signals, direction has React signals
  const domain = detectDomain('build it nicely', 'use React hooks and JSX components');
  assertEqual(domain, DOMAINS.REACT, 'direction should influence domain');
});

await testAsync('picks highest-signal domain', async () => {
  // Multiple react signals should beat one backend signal
  const domain = detectDomain('create a React component using useState, useEffect, JSX, and Tailwind');
  assertEqual(domain, DOMAINS.REACT, 'react signals dominate');
});

// ─── getSkillForDomain ────────────────────────────────────────────────────────

console.log('\ngetSkillForDomain:');

await testAsync('REACT → ronin-frontend-craft', async () => {
  assertEqual(getSkillForDomain(DOMAINS.REACT), 'ronin-frontend-craft', 'skill name');
});

await testAsync('SWIFT → swiftui-macos-native', async () => {
  assertEqual(getSkillForDomain(DOMAINS.SWIFT), 'swiftui-macos-native', 'skill name');
});

await testAsync('ARCHITECTURE → ronin-architect', async () => {
  assertEqual(getSkillForDomain(DOMAINS.ARCHITECTURE), 'ronin-architect', 'skill name');
});

await testAsync('DESIGN → ronin-product-craft', async () => {
  assertEqual(getSkillForDomain(DOMAINS.DESIGN), 'ronin-product-craft', 'skill name');
});

await testAsync('BACKEND → agent-orchestrator', async () => {
  assertEqual(getSkillForDomain(DOMAINS.BACKEND), 'agent-orchestrator', 'skill name');
});

await testAsync('GENERIC → null', async () => {
  assertEqual(getSkillForDomain(DOMAINS.GENERIC), null, 'generic has no skill');
});

// ─── createPlanStructure ──────────────────────────────────────────────────────

console.log('\ncreatePlanStructure:');

await testAsync('returns canonical plan shape', async () => {
  const plan = createPlanStructure();
  assert(Array.isArray(plan.fileStructure), 'fileStructure');
  assert(Array.isArray(plan.taskManifest), 'taskManifest');
  assert(Array.isArray(plan.dependencies), 'dependencies');
  assert(Array.isArray(plan.acceptanceCriteria), 'acceptanceCriteria');
  assert(plan.awaitingApproval === true, 'awaitingApproval default true');
});

await testAsync('accepts overrides', async () => {
  const plan = createPlanStructure({ domain: DOMAINS.REACT, awaitingApproval: false });
  assertEqual(plan.domain, DOMAINS.REACT, 'domain override');
  assertEqual(plan.awaitingApproval, false, 'awaitingApproval override');
});

// ─── generatePlan ─────────────────────────────────────────────────────────────

console.log('\ngeneratePlan:');

await testAsync('throws if brief is missing', async () => {
  try {
    await generatePlan('', 'direction', makeSkillLoader(), makePlanner());
    assert(false, 'Should have thrown');
  } catch (err) {
    assert(err.message.includes('brief'));
  }
});

await testAsync('throws if planner has no execute()', async () => {
  try {
    await generatePlan('build an app', 'direction', makeSkillLoader(), {});
    assert(false, 'Should have thrown');
  } catch (err) {
    assert(err.message.includes('planner'));
  }
});

await testAsync('returns plan object', async () => {
  const result = await generatePlan('build a React app', 'use hooks', makeSkillLoader(), makePlanner());
  assert(result.plan, 'should have plan');
  assert(Array.isArray(result.plan.taskManifest), 'taskManifest should be array');
});

await testAsync('detects domain and loads matching skill', async () => {
  const result = await generatePlan('build a React component', '', makeSkillLoader(), makePlanner());
  assertEqual(result.domain, DOMAINS.REACT, 'domain should be REACT');
  assert(result.loadedSkills.includes('ronin-frontend-craft'), 'should load frontend skill');
});

await testAsync('does not load skill for GENERIC domain', async () => {
  const result = await generatePlan('do something', '', makeSkillLoader(), makePlanner());
  assertEqual(result.loadedSkills.length, 0, 'no skills for generic');
});

await testAsync('returns awaitingApproval: true', async () => {
  const result = await generatePlan('build a SwiftUI view', '', makeSkillLoader(), makePlanner());
  assert(result.awaitingApproval === true, 'always awaiting approval');
});

await testAsync('returns cost and duration', async () => {
  const result = await generatePlan('build API', '', makeSkillLoader(), makePlanner());
  assert(typeof result.cost === 'number', 'cost should be number');
  assert(typeof result.duration === 'number', 'duration should be number');
});

await testAsync('still works if skill loader fails', async () => {
  const failLoader = makeSkillLoader({ fail: true });
  const result     = await generatePlan('build a React app', '', failLoader, makePlanner());
  // Should not throw — non-fatal
  assert(result.plan, 'plan returned despite skill load failure');
});

await testAsync('still works with no skill loader', async () => {
  const result = await generatePlan('build a component', '', null, makePlanner());
  assert(result.plan, 'plan returned without skill loader');
});

await testAsync('handles malformed JSON from planner gracefully', async () => {
  const badPlanner = makePlanner({ raw: 'this is not JSON {{{}}}' });
  const result     = await generatePlan('build something', '', null, badPlanner);
  // Should fall back to single-task manifest
  assert(result.plan.taskManifest.length >= 1, 'should have fallback task manifest');
});

await testAsync('plan has all canonical fields', async () => {
  const result = await generatePlan('build a backend API', '', makeSkillLoader(), makePlanner());
  const plan   = result.plan;
  assert('fileStructure'      in plan, 'fileStructure');
  assert('componentTree'      in plan, 'componentTree');
  assert('dependencies'       in plan, 'dependencies');
  assert('taskManifest'       in plan, 'taskManifest');
  assert('edgeCases'          in plan, 'edgeCases');
  assert('acceptanceCriteria' in plan, 'acceptanceCriteria');
  assert('domain'             in plan, 'domain');
  assert('skillUsed'          in plan, 'skillUsed');
});

await testAsync('options.maxSkillTokens is passed to skill loader', async () => {
  let loadedMaxTokens = null;
  const spyLoader = {
    async load(skillName, maxTokens) {
      loadedMaxTokens = maxTokens;
      return { content: 'skill content', tokenCount: 100 };
    },
  };
  await generatePlan('build a React app', '', spyLoader, makePlanner(), { maxSkillTokens: 1500 });
  assertEqual(loadedMaxTokens, 1500, 'maxSkillTokens passed to loader');
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n─── Results: ${passed} passed, ${failed} failed ───\n`);
process.exit(failed > 0 ? 1 : 0);
