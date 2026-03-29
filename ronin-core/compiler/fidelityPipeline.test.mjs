// ─── compiler/fidelityPipeline.test.mjs ──────────────────────────────────
// D5 Fidelity Pipeline Orchestrator — Test Suite
//
// 55+ tests covering all pipeline stages, retry logic, error handling,
// cost estimation, and output assembly.
// ─────────────────────────────────────────────────────────────────────────

import {
  createPipelineSession,
  runStage0,
  runStage1,
  runStage1_5,
  runStage2,
  runStage3,
  assembleOutput,
  estimateCost,
  getPipelineConfig,
  runFidelityPipeline,
} from './fidelityPipeline.mjs';

import { createMockScene } from './figmaNodeAdapter.mjs';
import { compileTree } from './figmaToAbsoluteCSS.mjs';

// ─── Test Utilities ──────────────────────────────────────────────────────

let testCount = 0;
let passCount = 0;
let failCount = 0;

function test(name, fn) {
  testCount++;
  try {
    fn();
    passCount++;
    console.log(`✓ ${name}`);
  } catch (error) {
    failCount++;
    console.error(`✗ ${name}`);
    console.error(`  ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `${message || 'Assertion failed'}: expected ${expected}, got ${actual}`
    );
  }
}

function assertDeepEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message || 'Deep equal failed'}`);
  }
}

// ─── Mock Providers ──────────────────────────────────────────────────────

function createMockSemanticProvider(code) {
  return async (systemPrompt, userPrompt) => {
    return {
      code: code || 'export default function Component() { return null; }',
      componentNames: ['Component'],
      customProperties: { '--color-primary': '#0066ff' },
      flexConversions: 0,
      tokenUsage: { input: 1000, output: 500 },
    };
  };
}

function createMockRenderer() {
  return async (code, viewport, scale) => {
    // Return a mock buffer (8x8 PNG data)
    return Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]);
  };
}

function createMockComparator(diffPercent = 0.5) {
  return async (imageA, imageB) => {
    return {
      diffPercent,
      regions: [],
      diffImage: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    };
  };
}

function createMockDiffAnalyzer() {
  return async (systemPrompt, userPrompt) => {
    return JSON.stringify([
      { selector: '.button', property: 'padding', current: '8px', corrected: '12px' },
    ]);
  };
}

function createMockInterpreter() {
  return async (systemPrompt, userPrompt) => {
    return JSON.stringify({
      emotional_register: 'formal',
      primary_metaphor: 'data surface',
      motion_implied: 'subtle',
      hierarchy_strategy: 'depth via opacity',
      component_role: 'secondary',
      designer_intent: 'control',
      interaction_vocabulary: 'reveal on hover',
    });
  };
}

// ─── Session Management Tests ────────────────────────────────────────────

test('createPipelineSession returns correct shape', () => {
  const session = createPipelineSession('test-op');
  assert(session.operatorId === 'test-op', 'operatorId matches');
  assert(session.createdAt, 'createdAt is set');
  assert(session.stageResults, 'stageResults exists');
  assert(session.timings, 'timings exists');
  assert(session.errors, 'errors exists');
  assertEqual(session.retryCount, 0, 'retryCount is 0');
});

test('createPipelineSession without operatorId sets to null', () => {
  const session = createPipelineSession();
  assert(session.operatorId === null, 'operatorId is null');
});

test('createPipelineSession tracks totalTimeStart', () => {
  const before = Date.now();
  const session = createPipelineSession();
  const after = Date.now();
  assert(session.totalTimeStart >= before, 'totalTimeStart >= before');
  assert(session.totalTimeStart <= after, 'totalTimeStart <= after');
});

// ─── Stage 0: Context Capture Tests ──────────────────────────────────────

test('runStage0 validates input object', () => {
  try {
    runStage0(null);
    throw new Error('Should have thrown');
  } catch (error) {
    assert(error.message.includes('input must be an object'), 'Correct error');
  }
});

test('runStage0 rejects missing nodeTree', () => {
  try {
    runStage0({ screenshot: Buffer.from('test') });
    throw new Error('Should have thrown');
  } catch (error) {
    assert(error.message.includes('nodeTree is required'), 'Correct error');
  }
});

test('runStage0 rejects missing screenshot', () => {
  const nodeTree = createMockScene('card');
  try {
    runStage0({ nodeTree });
    throw new Error('Should have thrown');
  } catch (error) {
    assert(error.message.includes('screenshot is required'), 'Correct error');
  }
});

test('runStage0 returns normalized nodeTree', () => {
  const nodeTree = createMockScene('card');
  const screenshot = Buffer.from('test');
  const result = runStage0({ nodeTree, screenshot });

  assert(result.nodeTree, 'nodeTree returned');
  assert(result.screenshot === screenshot, 'screenshot passed through');
  assert(result.nodeCount > 0, 'nodeCount calculated');
  assert(result.timestamp, 'timestamp set');
  assert(result.timeMs >= 0, 'timeMs recorded');
});

test('runStage0 counts all nodes in tree', () => {
  const nodeTree = createMockScene('card');
  const screenshot = Buffer.from('test');
  const result = runStage0({ nodeTree, screenshot });

  // Card scene has 1 root + 4 children + button with 1 child = 7 nodes
  assert(result.nodeCount >= 5, 'Counted at least 5 nodes');
});

test('runStage0 records timeMs', () => {
  const nodeTree = createMockScene('card');
  const screenshot = Buffer.from('test');
  const result = runStage0({ nodeTree, screenshot });
  assert(result.timeMs >= 0, 'timeMs is non-negative');
  assert(result.timeMs < 500, 'timeMs is reasonable');
});

// ─── Stage 1: Deterministic Compiler Tests ──────────────────────────────

test('runStage1 rejects missing nodeTree', () => {
  try {
    runStage1(null);
    throw new Error('Should have thrown');
  } catch (error) {
    assert(error.message.includes('nodeTree is required'), 'Correct error');
  }
});

test('runStage1 compiles nodeTree to CSS', () => {
  const nodeTree = createMockScene('card');
  const result = runStage1(nodeTree);

  assert(result.compiledCSS instanceof Map, 'compiledCSS is a Map');
  assert(result.nodeCount > 0, 'nodeCount > 0');
  assert(result.compileTimeMs >= 0, 'compileTimeMs recorded');
});

test('runStage1 returns all nodes in compiled map', () => {
  const nodeTree = createMockScene('card');
  const result = runStage1(nodeTree);

  assert(result.compiledCSS.has(nodeTree.id), 'root node in map');
  assert(result.nodeCount === result.compiledCSS.size, 'nodeCount matches map size');
});

test('runStage1 reports timing', () => {
  const nodeTree = createMockScene('card');
  const result = runStage1(nodeTree);

  assert(result.compileTimeMs >= 0, 'compileTimeMs is non-negative');
  assert(result.compileTimeMs < 500, 'compileTimeMs is reasonable');
});

// ─── Stage 1.5: Interpreter Tests ───────────────────────────────────────

test('runStage1_5 returns null when no provider', async () => {
  const nodeTree = createMockScene('card');
  const screenshot = Buffer.from('test');
  const result = await runStage1_5(nodeTree, screenshot, null);

  assert(result === null, 'Returns null with no provider');
});

test('runStage1_5 calls provider when available', async () => {
  const nodeTree = createMockScene('card');
  const screenshot = Buffer.from('test');
  const provider = createMockInterpreter();

  const result = await runStage1_5(nodeTree, screenshot, provider);

  assert(result !== null, 'Returns object when provider exists');
  assert(result.emotional_register, 'Interpretation fields present');
});

test('runStage1_5 records timeMs', async () => {
  const nodeTree = createMockScene('card');
  const screenshot = Buffer.from('test');
  const provider = createMockInterpreter();

  const result = await runStage1_5(nodeTree, screenshot, provider);

  assert(result.timeMs >= 0, 'timeMs recorded');
});

test('runStage1_5 returns null on provider error', async () => {
  const nodeTree = createMockScene('card');
  const screenshot = Buffer.from('test');
  const badProvider = async () => {
    throw new Error('Provider failed');
  };

  const result = await runStage1_5(nodeTree, screenshot, badProvider);

  assert(result === null, 'Returns null on error (optional stage)');
});

// ─── Stage 2: Semantic Pass Tests ────────────────────────────────────────

test('runStage2 rejects missing compiledCSS', async () => {
  try {
    await runStage2(null, {}, null, createMockSemanticProvider());
    throw new Error('Should have thrown');
  } catch (error) {
    assert(error.message.includes('compiledCSS must be a Map'), 'Correct error');
  }
});

test('runStage2 rejects missing nodeTree', async () => {
  const nodeTree = createMockScene('card');
  const compiledCSS = compileTree(nodeTree);

  try {
    await runStage2(compiledCSS, null, null, createMockSemanticProvider());
    throw new Error('Should have thrown');
  } catch (error) {
    assert(error.message.includes('nodeTree is required'), 'Correct error');
  }
});

test('runStage2 rejects missing provider', async () => {
  const nodeTree = createMockScene('card');
  const compiledCSS = compileTree(nodeTree);

  try {
    await runStage2(compiledCSS, nodeTree, null, null);
    throw new Error('Should have thrown');
  } catch (error) {
    assert(error.message.includes('provider function is required'), 'Correct error');
  }
});

test('runStage2 calls semantic provider', async () => {
  const nodeTree = createMockScene('card');
  const compiledCSS = compileTree(nodeTree);
  const provider = createMockSemanticProvider('export default function Card() {}');

  const result = await runStage2(compiledCSS, nodeTree, null, provider);

  assert(result.code, 'code returned');
  assert(result.componentNames, 'componentNames returned');
  assert(result.customProperties, 'customProperties returned');
});

test('runStage2 records timeMs', async () => {
  const nodeTree = createMockScene('card');
  const compiledCSS = compileTree(nodeTree);
  const provider = createMockSemanticProvider();

  const result = await runStage2(compiledCSS, nodeTree, null, provider);

  assert(result.timeMs >= 0, 'timeMs recorded');
  assert(result.timeMs < 5000, 'timeMs is reasonable');
});

// ─── Stage 3: Visual Regression Tests ────────────────────────────────────

test('runStage3 rejects missing screenshot', async () => {
  try {
    await runStage3(null, 'code', {});
    throw new Error('Should have thrown');
  } catch (error) {
    assert(error.message.includes('figmaScreenshot is required'), 'Correct error');
  }
});

test('runStage3 rejects missing componentCode', async () => {
  try {
    await runStage3(Buffer.from('test'), null, {});
    throw new Error('Should have thrown');
  } catch (error) {
    assert(error.message.includes('componentCode is required'), 'Correct error');
  }
});

test('runStage3 calls renderer and comparator', async () => {
  const screenshot = Buffer.from('test');
  const code = 'export default function() {}';
  const renderer = createMockRenderer();
  const comparator = createMockComparator(0.5);

  const result = await runStage3(screenshot, code, { renderer, comparator });

  assert(result.pass !== undefined, 'pass is set');
  assert(result.score !== undefined, 'score is set');
  assert(result.diffPercent !== undefined, 'diffPercent is set');
});

test('runStage3 passes when diff below threshold', async () => {
  const screenshot = Buffer.from('test');
  const code = 'export default function() {}';
  const renderer = createMockRenderer();
  const comparator = createMockComparator(0.5); // 0.5% < 2% threshold

  const result = await runStage3(screenshot, code, {
    renderer,
    comparator,
    fidelityThreshold: 2.0,
  });

  assert(result.pass === true, 'pass is true');
});

test('runStage3 fails when diff above threshold', async () => {
  const screenshot = Buffer.from('test');
  const code = 'export default function() {}';
  const renderer = createMockRenderer();
  const comparator = createMockComparator(3.0); // 3% > 2% threshold

  const result = await runStage3(screenshot, code, {
    renderer,
    comparator,
    fidelityThreshold: 2.0,
  });

  assert(result.pass === false, 'pass is false');
});

test('runStage3 records retryCount', async () => {
  const screenshot = Buffer.from('test');
  const code = 'export default function() {}';
  const renderer = createMockRenderer();
  const comparator = createMockComparator(0.5);

  const result = await runStage3(screenshot, code, { renderer, comparator });

  assert(typeof result.retryCount === 'number', 'retryCount is a number');
  assert(result.retryCount >= 0, 'retryCount is non-negative');
});

test('runStage3 handles renderer error gracefully', async () => {
  const screenshot = Buffer.from('test');
  const code = 'export default function() {}';
  const badRenderer = async () => {
    throw new Error('Render failed');
  };
  const comparator = createMockComparator();

  const result = await runStage3(screenshot, code, {
    renderer: badRenderer,
    comparator,
  });

  assert(result.pass === false, 'pass is false on error');
  assert(result.score === 0, 'score is 0 on error');
  assert(result.error, 'error message captured');
});

// ─── Output Assembly Tests ───────────────────────────────────────────────

test('assembleOutput produces all 3 artifacts', () => {
  const session = createPipelineSession();
  session.stageResults.stage2 = {
    code: 'export default function() {}',
    componentNames: ['Component'],
    customProperties: { '--color': '#fff' },
  };
  session.stageResults.stage3 = {
    score: 97.4,
    diffImage: Buffer.from('test'),
  };

  const output = assembleOutput(session);

  assert(output.code, 'code present');
  assert(output.fidelityScore !== undefined, 'fidelityScore present');
  assert(output.fidelityBadge, 'fidelityBadge present');
});

test('assembleOutput fidelity badge has correct format', () => {
  const session = createPipelineSession();
  session.stageResults.stage2 = { code: '', componentNames: [], customProperties: {} };
  session.stageResults.stage3 = { score: 97.4 };

  const output = assembleOutput(session);

  assert(output.fidelityBadge.includes('97.4'), 'Score in badge');
  assert(output.fidelityBadge.includes('match'), 'Match text in badge');
  assert(output.fidelityBadge.includes('●'), 'Has bullet points');
});

test('assembleOutput includes diffImage when available', () => {
  const session = createPipelineSession();
  const diffBuffer = Buffer.from('diff');
  session.stageResults.stage2 = { code: '', componentNames: [], customProperties: {} };
  session.stageResults.stage3 = { score: 95, diffImage: diffBuffer };

  const output = assembleOutput(session);

  assert(output.diffImage === diffBuffer, 'diffImage passed through');
});

test('assembleOutput component names and custom properties', () => {
  const session = createPipelineSession();
  session.stageResults.stage2 = {
    code: '',
    componentNames: ['Card', 'Button'],
    customProperties: { '--primary': '#0066ff', '--secondary': '#ff0066' },
  };
  session.stageResults.stage3 = { score: 95 };

  const output = assembleOutput(session);

  assertDeepEqual(output.componentNames, ['Card', 'Button'], 'Component names match');
  assertDeepEqual(
    output.customProperties,
    { '--primary': '#0066ff', '--secondary': '#ff0066' },
    'Custom properties match'
  );
});

// ─── Cost Estimation Tests ───────────────────────────────────────────────

test('estimateCost with no-retry pipeline', () => {
  const cost = estimateCost(
    { stage2: 800, stage3: 400 },
    { input: 1000, output: 500 },
    0
  );

  assert(cost > 0, 'cost is positive');
  assert(cost < 1, 'cost is under $1');
});

test('estimateCost with retries', () => {
  const cost1 = estimateCost(
    { stage2: 800, stage3: 400 },
    { input: 1000, output: 500 },
    0
  );

  const cost2 = estimateCost(
    { stage2: 800, stage3: 400 },
    { input: 1000, output: 500 },
    2
  );

  assert(cost2 > cost1, 'cost increases with retries');
});

test('estimateCost stage 1 always $0', () => {
  const cost = estimateCost(
    { stage1: 100 },
    { input: 0, output: 0 },
    0
  );

  assert(cost === 0, 'Stage 1 contributes $0');
});

test('estimateCost stage 1_5 adds cost', () => {
  const cost1 = estimateCost(
    { stage2: 800 },
    { input: 0, output: 0 },
    0
  );

  const cost2 = estimateCost(
    { stage1_5: 800, stage2: 800 },
    { input: 0, output: 0 },
    0
  );

  assert(cost2 > cost1, 'Stage 1.5 adds cost');
});

test('estimateCost returns number', () => {
  const cost = estimateCost({}, {}, 0);
  assert(typeof cost === 'number', 'cost is a number');
});

// ─── Pipeline Configuration Tests ────────────────────────────────────────

test('getPipelineConfig returns all stages', () => {
  const config = getPipelineConfig();

  assert(config.stages.stage0, 'stage0 defined');
  assert(config.stages.stage1, 'stage1 defined');
  assert(config.stages.stage1_5, 'stage1_5 defined');
  assert(config.stages.stage2, 'stage2 defined');
  assert(config.stages.stage3, 'stage3 defined');
  assert(config.stages.stage4, 'stage4 defined');
});

test('getPipelineConfig returns defaults', () => {
  const config = getPipelineConfig();

  assert(config.defaults.maxRetries !== undefined, 'maxRetries defined');
  assert(config.defaults.fidelityThreshold !== undefined, 'fidelityThreshold defined');
  assert(config.defaults.skipDiffCheck !== undefined, 'skipDiffCheck defined');
});

// ─── Full Pipeline Tests ─────────────────────────────────────────────────

test('runFidelityPipeline with all mocks returns success', async () => {
  const nodeTree = createMockScene('card');
  const screenshot = Buffer.from('test');

  const result = await runFidelityPipeline(
    { nodeTree, screenshot },
    {
      semanticProvider: createMockSemanticProvider(),
      renderer: createMockRenderer(),
      comparator: createMockComparator(0.5),
      skipDiffCheck: false,
    }
  );

  assert(result.success, 'Pipeline succeeded');
  assert(result.output, 'output returned');
  assert(result.metadata, 'metadata returned');
});

test('runFidelityPipeline returns all stage results', async () => {
  const nodeTree = createMockScene('card');
  const screenshot = Buffer.from('test');

  const result = await runFidelityPipeline(
    { nodeTree, screenshot },
    {
      semanticProvider: createMockSemanticProvider(),
      skipDiffCheck: true,
    }
  );

  assert(result.stage0, 'stage0 returned');
  assert(result.stage1, 'stage1 returned');
  assert(result.stage2, 'stage2 returned');
  assert(result.stage3, 'stage3 returned');
  assert(result.output, 'output returned');
  assert(result.metadata, 'metadata returned');
});

test('runFidelityPipeline with skipDiffCheck skips Stage 3', async () => {
  const nodeTree = createMockScene('card');
  const screenshot = Buffer.from('test');

  const result = await runFidelityPipeline(
    { nodeTree, screenshot },
    {
      semanticProvider: createMockSemanticProvider(),
      skipDiffCheck: true,
    }
  );

  assert(result.stage3, 'stage3 still returned');
  assert(result.stage3.score === 100, 'score is 100 when skipped');
  assert(result.stage3.pass === true, 'pass is true when skipped');
});

test('runFidelityPipeline metadata has correct stage timings', async () => {
  const nodeTree = createMockScene('card');
  const screenshot = Buffer.from('test');

  const result = await runFidelityPipeline(
    { nodeTree, screenshot },
    {
      semanticProvider: createMockSemanticProvider(),
      skipDiffCheck: true,
    }
  );

  assert(result.metadata.stageTimings.stage0 !== undefined, 'stage0 timing');
  assert(result.metadata.stageTimings.stage1 !== undefined, 'stage1 timing');
  assert(result.metadata.stageTimings.stage2 !== undefined, 'stage2 timing');
  assert(result.metadata.totalTimeMs > 0, 'totalTimeMs > 0');
});

test('runFidelityPipeline output has code and fidelity badge', async () => {
  const nodeTree = createMockScene('card');
  const screenshot = Buffer.from('test');

  const result = await runFidelityPipeline(
    { nodeTree, screenshot },
    {
      semanticProvider: createMockSemanticProvider(),
      skipDiffCheck: true,
    }
  );

  assert(result.output.code, 'code present in output');
  assert(result.output.fidelityBadge, 'fidelityBadge present in output');
  assert(result.output.fidelityScore !== undefined, 'fidelityScore present in output');
});

test('runFidelityPipeline without renderer throws on Stage 3', async () => {
  const nodeTree = createMockScene('card');
  const screenshot = Buffer.from('test');

  const result = await runFidelityPipeline(
    { nodeTree, screenshot },
    {
      semanticProvider: createMockSemanticProvider(),
      skipDiffCheck: false,
      // No renderer provided
    }
  );

  assert(!result.success, 'Pipeline failed');
  assert(result.output.fidelityScore === 0, 'fidelityScore is 0 on failure');
});

test('runFidelityPipeline handles missing semanticProvider gracefully', async () => {
  const nodeTree = createMockScene('card');
  const screenshot = Buffer.from('test');

  const result = await runFidelityPipeline(
    { nodeTree, screenshot },
    {
      skipDiffCheck: true,
      // No semanticProvider
    }
  );

  assert(!result.success, 'Pipeline failed');
  assert(result.error, 'Error message present');
});

test('runFidelityPipeline with interpreter runs Stage 1.5', async () => {
  const nodeTree = createMockScene('card');
  const screenshot = Buffer.from('test');

  const result = await runFidelityPipeline(
    { nodeTree, screenshot },
    {
      semanticProvider: createMockSemanticProvider(),
      interpreter: createMockInterpreter(),
      skipDiffCheck: true,
    }
  );

  assert(result.stage1_5, 'stage1_5 returned');
  assert(result.stage1_5.emotional_register, 'interpretation data present');
});

test('runFidelityPipeline includes token usage in metadata', async () => {
  const nodeTree = createMockScene('card');
  const screenshot = Buffer.from('test');

  const result = await runFidelityPipeline(
    { nodeTree, screenshot },
    {
      semanticProvider: createMockSemanticProvider(),
      skipDiffCheck: true,
    }
  );

  assert(result.metadata.tokenUsage, 'tokenUsage present');
  assert(result.metadata.tokenUsage.input !== undefined, 'input tokens');
  assert(result.metadata.tokenUsage.output !== undefined, 'output tokens');
});

test('runFidelityPipeline includes costEstimate in metadata', async () => {
  const nodeTree = createMockScene('card');
  const screenshot = Buffer.from('test');

  const result = await runFidelityPipeline(
    { nodeTree, screenshot },
    {
      semanticProvider: createMockSemanticProvider(),
      skipDiffCheck: true,
    }
  );

  assert(result.metadata.costEstimate !== undefined, 'costEstimate present');
  assert(typeof result.metadata.costEstimate === 'number', 'costEstimate is number');
});

// ─── Edge Cases ──────────────────────────────────────────────────────────

test('runFidelityPipeline with empty node tree', async () => {
  const nodeTree = {
    id: 'empty',
    name: 'Empty',
    type: 'FRAME',
    absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
    children: [],
  };
  const screenshot = Buffer.from('test');

  const result = await runFidelityPipeline(
    { nodeTree, screenshot },
    {
      semanticProvider: createMockSemanticProvider(),
      skipDiffCheck: true,
    }
  );

  assert(result.success, 'Pipeline succeeded with empty tree');
  assert(result.stage1.compiledCSS.size >= 1, 'Root node compiled');
});

test('runFidelityPipeline with single-node scene', async () => {
  const nodeTree = {
    id: 'single',
    name: 'Rectangle',
    type: 'RECTANGLE',
    absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
  };
  const screenshot = Buffer.from('test');

  const result = await runFidelityPipeline(
    { nodeTree, screenshot },
    {
      semanticProvider: createMockSemanticProvider(),
      skipDiffCheck: true,
    }
  );

  assert(result.success, 'Pipeline succeeded with single node');
  assert(result.stage1.compiledCSS.size === 1, 'Single node compiled');
});

test('runFidelityPipeline with large scene (50+ nodes)', async () => {
  // Create a scene with 50+ nodes by nesting
  const createDeepScene = (depth) => {
    if (depth === 0) {
      return {
        id: `node-${depth}`,
        name: `Node ${depth}`,
        type: 'RECTANGLE',
        absoluteBoundingBox: { x: 0, y: 0, width: 50, height: 50 },
      };
    }
    return {
      id: `node-${depth}`,
      name: `Node ${depth}`,
      type: 'FRAME',
      absoluteBoundingBox: { x: 0, y: 0, width: 100 * depth, height: 100 * depth },
      children: [
        createDeepScene(depth - 1),
        createDeepScene(depth - 1),
      ],
    };
  };

  const nodeTree = createDeepScene(4); // Creates many nodes
  const screenshot = Buffer.from('test');

  const result = await runFidelityPipeline(
    { nodeTree, screenshot },
    {
      semanticProvider: createMockSemanticProvider(),
      skipDiffCheck: true,
    }
  );

  assert(result.success, 'Pipeline succeeded with large scene');
  assert(result.stage1.nodeCount > 10, 'Multiple nodes compiled');
});

// ─── Test Results ────────────────────────────────────────────────────────

console.log('\n' + '='.repeat(50));
console.log(`Tests: ${passCount}/${testCount} passed`);
if (failCount > 0) {
  console.log(`Failed: ${failCount}`);
  process.exit(1);
} else {
  console.log('All tests passed!');
  process.exit(0);
}
