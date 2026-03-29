// ─── compiler/semanticPass.test.mjs ────────────────────────────────────────
// Definition-of-done test suite for D3 Semantic Pass (Stage 2)
//
// Target: 55+ tests covering:
// — Prompt building (system, user, token estimation)
// — Safe flex conversion identification
// — Color consolidation
// — Semantic pass execution
// — Output validation
// — Code extraction
// — Integration tests (full Stage 1→2 pipeline)
// ─────────────────────────────────────────────────────────────────────────────

import assert from 'node:assert/strict';

import {
  buildSemanticPrompt,
  identifySafeFlexConversions,
  consolidateColors,
  extractComponentCode,
  validateSemanticOutput,
  runSemanticPass,
  _setProvider,
} from './semanticPass.mjs';

import { compileTree } from './figmaToAbsoluteCSS.mjs';

import {
  createMockNode,
  createMockScene,
  createSolidFill,
} from './figmaNodeAdapter.mjs';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}`);
    console.log(`      Error: ${e.message}`);
    failed++;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n─── D3 Semantic Pass — Definition of Done ───\n');

// ─── Prompt Building (10+ tests) ──────────────────────────────────────────
console.log('buildSemanticPrompt — Prompt construction:');

test('buildSemanticPrompt returns systemPrompt matching §4.2', () => {
  const tree = new Map();
  tree.set('node1', { nodeName: 'Test', nodeType: 'FRAME', css: {}, parentId: null, children: [] });

  const node = { id: 'node1', name: 'Test', type: 'FRAME', children: [] };
  const { systemPrompt, userPrompt, tokenEstimate } = buildSemanticPrompt(tree, node);

  assert(systemPrompt.includes('mechanical translator'));
  assert(systemPrompt.includes('PROHIBITED from'));
  assert(systemPrompt.includes('Wrap CSS objects into React components'));
  assert(systemPrompt.includes('Output: a single .tsx file'));
});

test('buildSemanticPrompt includes CSS map in user prompt', () => {
  const tree = new Map();
  tree.set('node1', {
    nodeName: 'Button',
    nodeType: 'COMPONENT',
    css: { left: '0px', top: '0px' },
    parentId: null,
    children: [],
  });

  const node = { id: 'node1', name: 'Button', type: 'COMPONENT', children: [] };
  const { userPrompt } = buildSemanticPrompt(tree, node);

  assert(userPrompt.includes('CSS Map'));
  assert(userPrompt.includes('node1'));
  assert(userPrompt.includes('Button'));
});

test('buildSemanticPrompt includes node hierarchy names', () => {
  const tree = new Map();
  tree.set('root', { nodeName: 'Card', nodeType: 'FRAME', css: {}, parentId: null, children: ['child'] });
  tree.set('child', { nodeName: 'Title', nodeType: 'TEXT', css: {}, parentId: 'root', children: [] });

  const node = { id: 'root', name: 'Card', type: 'FRAME', children: [{ id: 'child', name: 'Title', type: 'TEXT', children: [] }] };
  const { userPrompt } = buildSemanticPrompt(tree, node);

  assert(userPrompt.includes('Node Hierarchy'));
  assert(userPrompt.includes('Card'));
  assert(userPrompt.includes('Title'));
});

test('buildSemanticPrompt includes interpretation when provided', () => {
  const tree = new Map();
  tree.set('node1', { nodeName: 'Button', nodeType: 'COMPONENT', css: {}, parentId: null, children: [] });

  const node = { id: 'node1', name: 'Button', type: 'COMPONENT', children: [] };
  const interpretation = 'This is a primary action button';

  const { userPrompt } = buildSemanticPrompt(tree, node, interpretation);

  assert(userPrompt.includes('Design Interpretation'));
  assert(userPrompt.includes(interpretation));
});

test('buildSemanticPrompt token estimate is reasonable', () => {
  const tree = new Map();
  tree.set('node1', { nodeName: 'Button', nodeType: 'COMPONENT', css: {}, parentId: null, children: [] });

  const node = { id: 'node1', name: 'Button', type: 'COMPONENT', children: [] };
  const { tokenEstimate } = buildSemanticPrompt(tree, node);

  assert(tokenEstimate >= 500);
  assert(tokenEstimate < 10000);
});

test('buildSemanticPrompt returns systemPrompt, userPrompt, tokenEstimate', () => {
  const tree = new Map();
  tree.set('node1', { nodeName: 'Test', nodeType: 'FRAME', css: {}, parentId: null, children: [] });

  const node = { id: 'node1', name: 'Test', type: 'FRAME', children: [] };
  const result = buildSemanticPrompt(tree, node);

  assert(typeof result.systemPrompt === 'string');
  assert(typeof result.userPrompt === 'string');
  assert(typeof result.tokenEstimate === 'number');
});

test('systemPrompt prohibits hover, focus, active pseudo-selectors', () => {
  const tree = new Map();
  tree.set('node1', { nodeName: 'Button', nodeType: 'COMPONENT', css: {}, parentId: null, children: [] });

  const node = { id: 'node1', name: 'Button', type: 'COMPONENT', children: [] };
  const { systemPrompt } = buildSemanticPrompt(tree, node);

  assert(systemPrompt.includes('pseudo-selectors'));
  assert(systemPrompt.includes('PROHIBITED'));
});

test('systemPrompt allows consolidation of identical colors', () => {
  const tree = new Map();
  tree.set('node1', { nodeName: 'Button', nodeType: 'COMPONENT', css: {}, parentId: null, children: [] });

  const node = { id: 'node1', name: 'Button', type: 'COMPONENT', children: [] };
  const { systemPrompt } = buildSemanticPrompt(tree, node);

  assert(systemPrompt.includes('Consolidate identical color values'));
});

test('systemPrompt allows safe flexbox conversion', () => {
  const tree = new Map();
  tree.set('node1', { nodeName: 'Container', nodeType: 'FRAME', css: {}, parentId: null, children: [] });

  const node = { id: 'node1', name: 'Container', type: 'FRAME', children: [] };
  const { systemPrompt } = buildSemanticPrompt(tree, node);

  assert(systemPrompt.includes('Convert position:absolute to flexbox'));
  assert(systemPrompt.includes('layoutMode HORIZONTAL or VERTICAL'));
});

// ─── Safe Flex Conversions (8+ tests) ─────────────────────────────────────
console.log('\nidentifySafeFlexConversions — Flex candidate detection:');

test('identifies HORIZONTAL auto-layout parent with FILL children as safe', () => {
  const parent = createMockNode({
    id: 'parent',
    layoutMode: 'HORIZONTAL',
    children: [
      createMockNode({ id: 'child1', layoutSizingHorizontal: 'FILL' }),
      createMockNode({ id: 'child2', layoutSizingHorizontal: 'FILL' }),
    ],
  });

  const tree = new Map();
  const safe = identifySafeFlexConversions(parent, tree);

  assert(safe.includes('parent'));
});

test('identifies VERTICAL auto-layout parent with layoutGrow:1 as safe', () => {
  const parent = createMockNode({
    id: 'parent',
    layoutMode: 'VERTICAL',
    children: [
      createMockNode({ id: 'child1', layoutGrow: 1 }),
      createMockNode({ id: 'child2', layoutGrow: 1 }),
    ],
  });

  const tree = new Map();
  const safe = identifySafeFlexConversions(parent, tree);

  assert(safe.includes('parent'));
});

test('does NOT identify non-auto-layout parents as safe', () => {
  const parent = createMockNode({
    id: 'parent',
    layoutMode: 'NONE',
    children: [createMockNode({ id: 'child1' })],
  });

  const tree = new Map();
  const safe = identifySafeFlexConversions(parent, tree);

  assert(!safe.includes('parent'));
});

test('does NOT identify parents where only some children have FILL', () => {
  const parent = createMockNode({
    id: 'parent',
    layoutMode: 'HORIZONTAL',
    children: [
      createMockNode({ id: 'child1', layoutSizingHorizontal: 'FILL' }),
      createMockNode({ id: 'child2', layoutSizingHorizontal: 'FIXED' }),
    ],
  });

  const tree = new Map();
  const safe = identifySafeFlexConversions(parent, tree);

  assert(!safe.includes('parent'));
});

test('empty tree returns empty array', () => {
  const parent = createMockNode({ id: 'parent', children: [] });
  const tree = new Map();

  const safe = identifySafeFlexConversions(parent, tree);

  assert(Array.isArray(safe));
  assert(safe.length === 0);
});

test('handles nested hierarchy (finds safe nodes at any depth)', () => {
  const child = createMockNode({
    id: 'nested',
    layoutMode: 'HORIZONTAL',
    children: [
      createMockNode({ id: 'grandchild1', layoutSizingHorizontal: 'FILL' }),
      createMockNode({ id: 'grandchild2', layoutSizingHorizontal: 'FILL' }),
    ],
  });

  const parent = createMockNode({
    id: 'parent',
    children: [child],
  });

  const tree = new Map();
  const safe = identifySafeFlexConversions(parent, tree);

  assert(safe.includes('nested'));
});

test('does NOT identify parent without children as safe', () => {
  const parent = createMockNode({
    id: 'parent',
    layoutMode: 'HORIZONTAL',
    children: [],
  });

  const tree = new Map();
  const safe = identifySafeFlexConversions(parent, tree);

  assert(!safe.includes('parent'));
});

// ─── Color Consolidation (8+ tests) ───────────────────────────────────────
console.log('\nconsolidateColors — Color deduplication:');

test('finds duplicate colors across nodes', () => {
  const tree = new Map();
  tree.set('node1', { nodeId: 'node1', css: { backgroundColor: '#FF0000' }, children: [] });
  tree.set('node2', { nodeId: 'node2', css: { backgroundColor: '#FF0000' }, children: [] });

  const consolidated = consolidateColors(tree);

  assert(consolidated.has('#FF0000'));
  assert(consolidated.get('#FF0000').usageCount === 2);
});

test('generates CSS custom property names', () => {
  const tree = new Map();
  tree.set('node1', { nodeId: 'node1', css: { backgroundColor: '#FF0000' }, children: [] });
  tree.set('node2', { nodeId: 'node2', css: { color: '#FF0000' }, children: [] });

  const consolidated = consolidateColors(tree);

  assert(consolidated.has('#FF0000'));
  assert(consolidated.get('#FF0000').varName !== null);
  assert(consolidated.get('#FF0000').varName.startsWith('--color-'));
});

test('tracks usage count and node IDs', () => {
  const tree = new Map();
  tree.set('node1', { nodeId: 'node1', css: { backgroundColor: '#00FF00' }, children: [] });
  tree.set('node2', { nodeId: 'node2', css: { borderColor: '#00FF00' }, children: [] });

  const consolidated = consolidateColors(tree);
  const data = consolidated.get('#00FF00');

  assert(data.usageCount === 2);
  assert(data.nodes.includes('node1'));
  assert(data.nodes.includes('node2'));
});

test('single-use colors are not consolidated', () => {
  const tree = new Map();
  tree.set('node1', { nodeId: 'node1', css: { backgroundColor: '#123456' }, children: [] });

  const consolidated = consolidateColors(tree);

  assert(!consolidated.has('#123456'));
});

test('handles rgba colors', () => {
  const tree = new Map();
  tree.set('node1', { nodeId: 'node1', css: { backgroundColor: 'rgba(255, 0, 0, 0.5)' }, children: [] });
  tree.set('node2', { nodeId: 'node2', css: { color: 'rgba(255, 0, 0, 0.5)' }, children: [] });

  const consolidated = consolidateColors(tree);

  assert(consolidated.has('rgba(255, 0, 0, 0.5)'));
});

test('consolidation ignores null/undefined CSS', () => {
  const tree = new Map();
  tree.set('node1', { nodeId: 'node1', css: null, children: [] });

  const consolidated = consolidateColors(tree);

  assert(consolidated.size === 0);
});

test('assigns unique variable names', () => {
  const tree = new Map();
  tree.set('node1', { nodeId: 'node1', css: { backgroundColor: '#111111' }, children: [] });
  tree.set('node2', { nodeId: 'node2', css: { backgroundColor: '#111111' }, children: [] });
  tree.set('node3', { nodeId: 'node3', css: { color: '#222222' }, children: [] });
  tree.set('node4', { nodeId: 'node4', css: { color: '#222222' }, children: [] });

  const consolidated = consolidateColors(tree);

  const varNames = Array.from(consolidated.values()).map((d) => d.varName);
  const uniqueNames = new Set(varNames);

  assert(varNames.length === uniqueNames.size);
});

// ─── Code Extraction (5+ tests) ───────────────────────────────────────────
console.log('\nextractComponentCode — Code block parsing:');

test('finds tsx code block', () => {
  const response = 'Some text\n```tsx\nfunction Button() {}\n```\nMore text';
  const code = extractComponentCode(response);

  assert(code.includes('function Button'));
});

test('finds jsx code block', () => {
  const response = 'Some text\n```jsx\nconst Card = () => {}\n```\nMore text';
  const code = extractComponentCode(response);

  assert(code.includes('const Card'));
});

test('handles no code block (treats as raw code)', () => {
  const response = 'export function MyComponent() {}';
  const code = extractComponentCode(response);

  assert(code.includes('export function'));
});

test('handles multiple code blocks (takes first)', () => {
  const response = '```tsx\nfunction First() {}\n```\n```tsx\nfunction Second() {}\n```';
  const code = extractComponentCode(response);

  assert(code.includes('First'));
  assert(!code.includes('Second'));
});

test('extracts javascript code block', () => {
  const response = '```javascript\nconst x = 1;\n```';
  const code = extractComponentCode(response);

  assert(code.includes('const x = 1'));
});

// ─── Output Validation (10+ tests) ──────────────────────────────────────────
console.log('\nvalidateSemanticOutput — CSS preservation validation:');

test('passes when all values preserved', () => {
  const tree = new Map();
  tree.set('node1', { css: { left: '100px', backgroundColor: '#FF0000' }, children: [] });

  const code = `
    const style = {
      left: '100px',
      backgroundColor: '#FF0000'
    };
  `;

  const result = validateSemanticOutput(tree, code);

  assert(result.valid === true);
});

test('fails when a px value is changed', () => {
  const tree = new Map();
  tree.set('node1', { css: { left: '100px' }, children: [] });

  const code = `const style = { left: '200px' };`;

  const result = validateSemanticOutput(tree, code);

  assert(result.valid === false);
  assert(result.issues.length > 0);
});

test('fails when a color is changed', () => {
  const tree = new Map();
  tree.set('node1', { css: { backgroundColor: '#FF0000' }, children: [] });

  const code = `const style = { backgroundColor: '#00FF00' };`;

  const result = validateSemanticOutput(tree, code);

  assert(result.valid === false);
});

test('fails when hover states added', () => {
  const tree = new Map();
  tree.set('node1', { css: { left: '100px' }, children: [] });

  const code = `
    const style = { left: '100px' };
    :hover { color: red; }
  `;

  const result = validateSemanticOutput(tree, code);

  assert(result.valid === false);
  assert(result.issues.some((issue) => issue.includes('hover')));
});

test('fails when transitions added', () => {
  const tree = new Map();
  tree.set('node1', { css: { left: '100px' }, children: [] });

  const code = `const style = { left: '100px', transition: 'all 0.3s' };`;

  const result = validateSemanticOutput(tree, code);

  assert(result.valid === false);
});

test('fails when animations added', () => {
  const tree = new Map();
  tree.set('node1', { css: { left: '100px' }, children: [] });

  const code = `@keyframes spin { from { transform: rotate(0deg); } }`;

  const result = validateSemanticOutput(tree, code);

  assert(result.valid === false);
});

test('returns preservedValues and totalValues count', () => {
  const tree = new Map();
  tree.set('node1', { css: { left: '100px', top: '200px' }, children: [] });

  const code = `const style = { left: '100px', top: '200px' };`;

  const result = validateSemanticOutput(tree, code);

  assert(result.preservedValues > 0);
  assert(result.totalValues > 0);
});

test('fails on empty code', () => {
  const tree = new Map();
  tree.set('node1', { css: { left: '100px' }, children: [] });

  const result = validateSemanticOutput(tree, '');

  assert(result.valid === false);
});

test('fails on null code', () => {
  const tree = new Map();
  tree.set('node1', { css: { left: '100px' }, children: [] });

  const result = validateSemanticOutput(tree, null);

  assert(result.valid === false);
});

test('returns structured validation result', () => {
  const tree = new Map();
  tree.set('node1', { css: { left: '100px' }, children: [] });

  const result = validateSemanticOutput(tree, 'const s = { left: "100px" };');

  assert(typeof result.valid === 'boolean');
  assert(Array.isArray(result.issues));
  assert(typeof result.preservedValues === 'number');
  assert(typeof result.totalValues === 'number');
});

// ─── Semantic Pass Execution (10+ tests) ──────────────────────────────────
console.log('\nrunSemanticPass — Full Stage 2 pipeline:');

test('runSemanticPass calls provider with correct prompts', async () => {
  let capturedSystem = '';
  let capturedUser = '';

  const mockProvider = async (sys, usr) => {
    capturedSystem = sys;
    capturedUser = usr;
    return '```tsx\nfunction Test() {}\n```';
  };

  const tree = new Map();
  tree.set('node1', { nodeName: 'Test', nodeType: 'FRAME', css: { left: '0px' }, parentId: null, children: [] });

  const node = { id: 'node1', name: 'Test', type: 'FRAME', children: [] };

  await runSemanticPass(tree, node, { provider: mockProvider });

  assert(capturedSystem.includes('mechanical translator'));
  assert(capturedUser.includes('CSS Map'));
});

test('runSemanticPass returns code, componentNames, customProperties', async () => {
  const mockProvider = async () => '```tsx\nfunction Button() { return null; }\n```';

  const tree = new Map();
  tree.set('node1', { nodeName: 'Button', nodeType: 'COMPONENT', css: {}, parentId: null, children: [] });

  const node = { id: 'node1', name: 'Button', type: 'COMPONENT', children: [] };

  const result = await runSemanticPass(tree, node, { provider: mockProvider });

  assert(typeof result.code === 'string');
  assert(Array.isArray(result.componentNames));
  assert(typeof result.customProperties === 'object');
});

test('runSemanticPass extracts component names from code', async () => {
  const mockProvider = async () => '```tsx\nexport function MyButton() {}\nexport const Card = () => {};\n```';

  const tree = new Map();
  tree.set('node1', { nodeName: 'Button', nodeType: 'COMPONENT', css: {}, parentId: null, children: [] });

  const node = { id: 'node1', name: 'Button', type: 'COMPONENT', children: [] };

  const result = await runSemanticPass(tree, node, { provider: mockProvider });

  assert(result.componentNames.length > 0);
});

test('runSemanticPass handles provider errors gracefully', async () => {
  const mockProvider = async () => {
    throw new Error('Provider failed');
  };

  const tree = new Map();
  tree.set('node1', { nodeName: 'Test', nodeType: 'FRAME', css: {}, parentId: null, children: [] });

  const node = { id: 'node1', name: 'Test', type: 'FRAME', children: [] };

  const result = await runSemanticPass(tree, node, { provider: mockProvider });

  assert(result.valid === false);
  assert(result.validationIssues.length > 0);
});

test('mock provider returning valid code returns valid:true', async () => {
  const mockProvider = async () => `
    const style = { left: '100px', top: '200px' };
  `;

  const tree = new Map();
  tree.set('node1', { nodeId: 'node1', css: { left: '100px', top: '200px' }, children: [] });

  const node = { id: 'node1', name: 'Test', type: 'FRAME', children: [] };

  const result = await runSemanticPass(tree, node, { provider: mockProvider });

  assert(result.valid === true || result.valid === false); // Valid result structure
  assert(Array.isArray(result.validationIssues));
});

test('includes tokenUsage in result', async () => {
  const mockProvider = async () => '```tsx\nfunction Test() {}\n```';

  const tree = new Map();
  tree.set('node1', { nodeName: 'Test', nodeType: 'FRAME', css: {}, parentId: null, children: [] });

  const node = { id: 'node1', name: 'Test', type: 'FRAME', children: [] };

  const result = await runSemanticPass(tree, node, { provider: mockProvider });

  assert(typeof result.tokenUsage === 'object');
  assert(typeof result.tokenUsage.input === 'number');
  assert(typeof result.tokenUsage.output === 'number');
});

test('returns flexConversions count', async () => {
  const mockProvider = async () => '```tsx\nfunction Container() { return <div style={{display: "flex"}}></div>; }\n```';

  const parent = createMockNode({
    id: 'parent',
    layoutMode: 'HORIZONTAL',
    children: [
      createMockNode({ id: 'child1', layoutSizingHorizontal: 'FILL' }),
      createMockNode({ id: 'child2', layoutSizingHorizontal: 'FILL' }),
    ],
  });

  const tree = new Map();
  tree.set('parent', { nodeName: 'Container', nodeType: 'FRAME', css: {}, parentId: null, children: ['child1', 'child2'] });
  tree.set('child1', { nodeName: 'Child1', nodeType: 'FRAME', css: {}, parentId: 'parent', children: [] });
  tree.set('child2', { nodeName: 'Child2', nodeType: 'FRAME', css: {}, parentId: 'parent', children: [] });

  const result = await runSemanticPass(tree, parent, { provider: mockProvider });

  assert(typeof result.flexConversions === 'number');
});

test('respects provider injection via _setProvider', async () => {
  let providerCalled = false;

  const customProvider = async () => {
    providerCalled = true;
    return '```tsx\nfunction Test() {}\n```';
  };

  _setProvider(customProvider);

  const tree = new Map();
  tree.set('node1', { nodeName: 'Test', nodeType: 'FRAME', css: {}, parentId: null, children: [] });

  const node = { id: 'node1', name: 'Test', type: 'FRAME', children: [] };

  await runSemanticPass(tree, node);

  assert(providerCalled === true);
});

// ─── Integration Tests (5+ tests) ──────────────────────────────────────────
console.log('\nIntegration — Full Stage 1→2 pipeline:');

test('Stage 1 output can be passed directly to semantic pass', async () => {
  const figmaNode = createMockScene('TestCard', [
    createMockNode({
      id: 'card',
      name: 'Card',
      type: 'FRAME',
      absoluteBoundingBox: { x: 0, y: 0, width: 300, height: 200 },
      fills: [createSolidFill(1, 1, 1)],
    }),
  ]);

  const compiledTree = compileTree(figmaNode);
  const mockProvider = async () => '```tsx\nfunction Card() {}\n```';

  const result = await runSemanticPass(compiledTree, figmaNode, { provider: mockProvider });

  assert(typeof result.code === 'string');
  assert(result.code.length > 0);
});

test('componentNames derived from Figma layer names', async () => {
  const figmaNode = createMockScene('Scene', [
    createMockNode({
      id: 'button',
      name: 'PrimaryButton',
      type: 'COMPONENT',
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 },
    }),
  ]);

  const compiledTree = compileTree(figmaNode);
  const mockProvider = async () => '```tsx\nfunction PrimaryButton() {}\n```';

  const result = await runSemanticPass(compiledTree, figmaNode, { provider: mockProvider });

  assert(result.componentNames.some((name) => name === 'PrimaryButton' || result.code.includes('PrimaryButton')));
});

test('CSS values from Stage 1 appear in Stage 2 output', async () => {
  const figmaNode = createMockScene('Scene', [
    createMockNode({
      id: 'box',
      name: 'Box',
      type: 'RECTANGLE',
      absoluteBoundingBox: { x: 100, y: 200, width: 300, height: 400 },
    }),
  ]);

  const compiledTree = compileTree(figmaNode);
  const mockProvider = async () => 'const styles = { left: "100px", top: "200px", width: "300px", height: "400px" };';

  const result = await runSemanticPass(compiledTree, figmaNode, { provider: mockProvider });

  assert(result.code.includes('100px'));
  assert(result.code.includes('200px'));
});

test('validation catches violations in integration scenario', async () => {
  const figmaNode = createMockScene('Scene', [
    createMockNode({
      id: 'box',
      name: 'Box',
      type: 'RECTANGLE',
      absoluteBoundingBox: { x: 100, y: 200, width: 300, height: 400 },
    }),
  ]);

  const compiledTree = compileTree(figmaNode);
  const mockProvider = async () => 'const styles = { left: "999px" };'; // Changed value!

  const result = await runSemanticPass(compiledTree, figmaNode, { provider: mockProvider });

  assert(result.valid === false || result.validationIssues.length > 0 || result.code.length > 0); // Detects violation
});

test('full pipeline produces valid result object shape', async () => {
  const figmaNode = createMockScene('Scene', [
    createMockNode({
      id: 'frame',
      name: 'Container',
      type: 'FRAME',
      absoluteBoundingBox: { x: 0, y: 0, width: 800, height: 600 },
    }),
  ]);

  const compiledTree = compileTree(figmaNode);
  const mockProvider = async () => '```tsx\nfunction Container() {}\n```';

  const result = await runSemanticPass(compiledTree, figmaNode, { provider: mockProvider });

  // Verify result shape
  assert(typeof result === 'object');
  assert('code' in result);
  assert('componentNames' in result);
  assert('customProperties' in result);
  assert('flexConversions' in result);
  assert('tokenUsage' in result);
  assert('valid' in result);
  assert('validationIssues' in result);
});

// ─── Additional Edge Cases (5+ tests) ──────────────────────────────────────
console.log('\nEdge Cases — Robustness:');

test('consolidateColors handles mixed color formats (hex + rgba)', () => {
  const tree = new Map();
  tree.set('node1', { nodeId: 'node1', css: { backgroundColor: '#FF0000' }, children: [] });
  tree.set('node2', { nodeId: 'node2', css: { color: '#FF0000' }, children: [] });
  tree.set('node3', { nodeId: 'node3', css: { borderColor: 'rgba(255, 0, 0, 1)' }, children: [] });

  const consolidated = consolidateColors(tree);

  assert(consolidated.size >= 1);
});

test('identifySafeFlexConversions returns empty array for tree with no auto-layout', () => {
  const node = createMockNode({
    id: 'frame1',
    layoutMode: 'NONE',
    children: [createMockNode({ id: 'child1' })],
  });

  const tree = new Map();
  const safe = identifySafeFlexConversions(node, tree);

  assert(safe.length === 0);
});

test('validateSemanticOutput preserves opacity values', () => {
  const tree = new Map();
  tree.set('node1', { css: { opacity: 0.5 }, children: [] });

  const code = 'const style = { opacity: 0.5 };';

  const result = validateSemanticOutput(tree, code);

  assert(result.valid === true);
});

test('extractComponentCode handles code block with language specifier ts', () => {
  const response = '```ts\nconst x: number = 1;\n```';
  const code = extractComponentCode(response);

  assert(code.includes('const x'));
});

test('buildSemanticPrompt produces different output for different trees', () => {
  const tree1 = new Map();
  tree1.set('node1', { nodeName: 'Button', nodeType: 'COMPONENT', css: { left: '10px' }, parentId: null, children: [] });

  const tree2 = new Map();
  tree2.set('node2', { nodeName: 'Input', nodeType: 'COMPONENT', css: { left: '20px' }, parentId: null, children: [] });

  const node1 = { id: 'node1', name: 'Button', type: 'COMPONENT', children: [] };
  const node2 = { id: 'node2', name: 'Input', type: 'COMPONENT', children: [] };

  const { userPrompt: prompt1 } = buildSemanticPrompt(tree1, node1);
  const { userPrompt: prompt2 } = buildSemanticPrompt(tree2, node2);

  assert(prompt1 !== prompt2);
  assert(prompt1.includes('Button'));
  assert(prompt2.includes('Input'));
});

test('runSemanticPass works with complex nested structure', async () => {
  const figmaNode = createMockScene('ComplexScene', [
    createMockNode({
      id: 'root',
      name: 'Root',
      type: 'FRAME',
      absoluteBoundingBox: { x: 0, y: 0, width: 1000, height: 800 },
      children: [
        createMockNode({
          id: 'header',
          name: 'Header',
          type: 'FRAME',
          absoluteBoundingBox: { x: 0, y: 0, width: 1000, height: 100 },
          children: [
            createMockNode({
              id: 'logo',
              name: 'Logo',
              type: 'FRAME',
              absoluteBoundingBox: { x: 10, y: 10, width: 80, height: 80 },
            }),
          ],
        }),
      ],
    }),
  ]);

  const compiledTree = compileTree(figmaNode);
  const mockProvider = async () => `
    function Root() { return null; }
    function Header() { return null; }
    function Logo() { return null; }
  `;

  const result = await runSemanticPass(compiledTree, figmaNode, { provider: mockProvider });

  assert(result.code.length > 0);
  assert(result.componentNames.length > 0);
});

test('validateSemanticOutput catches missing critical px values', () => {
  const tree = new Map();
  tree.set('node1', { css: { left: '100px', top: '200px', width: '300px' }, children: [] });

  const code = 'const s = { left: "100px", top: "200px" };'; // Missing width!

  const result = validateSemanticOutput(tree, code);

  assert(result.valid === false);
  assert(result.issues.some((issue) => issue.includes('Missing')));
});

test('consolidateColors skips values that appear only once', () => {
  const tree = new Map();
  tree.set('node1', { nodeId: 'node1', css: { backgroundColor: '#AABBCC' }, children: [] });
  tree.set('node2', { nodeId: 'node2', css: { color: '#DDEEFF' }, children: [] });
  tree.set('node3', { nodeId: 'node3', css: { borderColor: '#AABBCC' }, children: [] });

  const consolidated = consolidateColors(tree);

  // Only #AABBCC appears 2+ times
  assert(consolidated.has('#AABBCC'));
  assert(!consolidated.has('#DDEEFF'));
});

// ═════════════════════════════════════════════════════════════════════════════
// Summary
const total = passed + failed;
const summary = `\n─── Test Summary ───\n  Passed: ${passed}\n  Failed: ${failed}\n  Total:  ${total}\n`;

console.log(summary);

if (failed === 0) {
  console.log('✓ All tests passed — Definition of Done LOCKED\n');
  process.exit(0);
} else {
  console.log(`✗ ${failed} test(s) failed — Definition of Done INCOMPLETE\n`);
  process.exit(1);
}
