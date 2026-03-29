// compiler/figmaNodeAdapter.test.mjs
// Definition-of-done test for D1: Figma Node Serializer + MCP Bridge Adapter
//
// ✓ Canonical node shape exported
// ✓ Validation works correctly
// ✓ Normalization handles defaults and color conversion
// ✓ Tree serialization preserves parent-child relationships
// ✓ Mock nodes and scenes pass validation
// ✓ MCP bridge interface correct
// ✓ Node ID extraction from Figma URLs works

import {
  FIGMA_NODE_SCHEMA,
  validateNode,
  normalizeNode,
  serializeNodeTree,
  createMockNode,
  createMockScene,
  createMCPBridge,
  extractNodeId,
} from './figmaNodeAdapter.mjs';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ ${message}`);
    failed++;
  }
}

console.log('\n─── D1: Figma Node Serializer + MCP Bridge Adapter ───\n');

// ── Test 1: FIGMA_NODE_SCHEMA is exported ────────────────────────────────
console.log('Schema:');
assert(FIGMA_NODE_SCHEMA !== undefined, 'FIGMA_NODE_SCHEMA is exported');
assert(FIGMA_NODE_SCHEMA.id === 'string', 'Schema has id field');
assert(FIGMA_NODE_SCHEMA.name === 'string', 'Schema has name field');
assert(FIGMA_NODE_SCHEMA.type === 'string', 'Schema has type field');
assert(FIGMA_NODE_SCHEMA.absoluteBoundingBox !== undefined, 'Schema has absoluteBoundingBox');
assert(FIGMA_NODE_SCHEMA.fills !== undefined, 'Schema has fills');
assert(FIGMA_NODE_SCHEMA.children === 'array<node>', 'Schema has children');

// ── Test 2: validateNode accepts valid complete nodes ──────────────────────
console.log('\nvalidateNode — complete valid node:');
const validNode = {
  id: '1:2',
  name: 'Button',
  type: 'COMPONENT',
  absoluteBoundingBox: { x: 10, y: 20, width: 100, height: 50 },
  opacity: 1,
  blendMode: 'NORMAL',
  fills: [{ type: 'SOLID', color: { r: 0.5, g: 0.5, b: 0.5, a: 1 }, opacity: 1 }],
  children: [],
};
const result = validateNode(validNode);
assert(result.valid === true, 'Valid complete node passes validation');
assert(result.errors.length === 0, 'No errors reported');

// ── Test 3: validateNode catches missing required fields ──────────────────
console.log('\nvalidateNode — missing required fields:');
const missingId = { name: 'Node', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 } };
let result2 = validateNode(missingId);
assert(!result2.valid, 'Missing id fails validation');
assert(result2.errors.some(e => e.includes('id')), 'Error mentions missing id');

const missingBbox = { id: '1:1', name: 'Node', type: 'FRAME' };
result2 = validateNode(missingBbox);
assert(!result2.valid, 'Missing absoluteBoundingBox fails validation');
assert(result2.errors.some(e => e.includes('absoluteBoundingBox')), 'Error mentions missing bounding box');

// ── Test 4: validateNode catches wrong types ─────────────────────────────
console.log('\nvalidateNode — wrong types:');
const wrongType = {
  id: '1:2',
  name: 'Node',
  type: 'FRAME',
  absoluteBoundingBox: { x: 'not-a-number', y: 0, width: 100, height: 100 },
};
result2 = validateNode(wrongType);
assert(!result2.valid, 'Invalid bbox x type fails validation');
assert(result2.errors.some(e => e.includes('x')), 'Error mentions x property');

const wrongOpacity = {
  id: '1:2',
  name: 'Node',
  type: 'FRAME',
  absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
  opacity: 'not-a-number',
};
result2 = validateNode(wrongOpacity);
assert(!result2.valid, 'Invalid opacity type fails validation');
assert(result2.errors.some(e => e.includes('opacity')), 'Error mentions opacity');

// ── Test 5: validateNode recursively validates children ──────────────────
console.log('\nvalidateNode — recursive children:');
const parentNode = {
  id: 'parent',
  name: 'Parent',
  type: 'FRAME',
  absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 200 },
  children: [
    { id: 'child1', name: 'Child 1', type: 'RECTANGLE', absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 } },
    { id: 'bad-child', name: 'Bad Child', type: 'TEXT' }, // missing bbox
  ],
};
result2 = validateNode(parentNode);
assert(!result2.valid, 'Parent with invalid child fails validation');
assert(result2.errors.some(e => e.includes('children[1]')), 'Error references child index');

const goodParent = {
  id: 'parent',
  name: 'Parent',
  type: 'FRAME',
  absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 200 },
  children: [
    { id: 'child1', name: 'Child 1', type: 'RECTANGLE', absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 } },
    { id: 'child2', name: 'Child 2', type: 'RECTANGLE', absoluteBoundingBox: { x: 100, y: 0, width: 100, height: 100 } },
  ],
};
result2 = validateNode(goodParent);
assert(result2.valid === true, 'Parent with valid children passes validation');

// ── Test 6: normalizeNode fills in defaults ─────────────────────────────
console.log('\nnormalizeNode — defaults:');
const raw = { id: '1:1', name: 'Test', type: 'FRAME' };
const normalized = normalizeNode(raw);
assert(normalized.opacity === 1, 'Sets default opacity = 1');
assert(normalized.blendMode === 'NORMAL', 'Sets default blendMode = NORMAL');
assert(normalized.layoutMode === 'NONE', 'Sets default layoutMode = NONE');
assert(normalized.layoutGrow === 0, 'Sets default layoutGrow = 0');
assert(normalized.absoluteBoundingBox.x === 0, 'Sets default absoluteBoundingBox.x = 0');
assert(normalized.absoluteBoundingBox.width === 100, 'Sets default absoluteBoundingBox.width = 100');
assert(normalized.fills.length >= 0, 'Initializes fills array');
assert(normalized.children.length === 0, 'Initializes empty children array');

// ── Test 7: normalizeNode converts hex colors to RGBA ──────────────────────
console.log('\nnormalizeNode — color conversion:');
const rawWithHex = {
  id: '1:1',
  name: 'Test',
  type: 'RECTANGLE',
  fills: [{ type: 'SOLID', color: '#FF0000', opacity: 1 }],
};
const normalized2 = normalizeNode(rawWithHex);
assert(normalized2.fills[0].color.r > 0.99, 'Hex #FF0000 converts to R ~1.0');
assert(normalized2.fills[0].color.g < 0.01, 'Hex #FF0000 converts to G ~0');
assert(normalized2.fills[0].color.b < 0.01, 'Hex #FF0000 converts to B ~0');

// ── Test 8: normalizeNode handles missing optional fields ──────────────────
console.log('\nnormalizeNode — optional fields:');
const minimal = { id: '1:1', name: 'Test', type: 'FRAME' };
const normalized3 = normalizeNode(minimal);
assert(normalized3.cornerRadius === undefined, 'Missing cornerRadius stays undefined');
assert(normalized3.lineHeight === undefined, 'Missing lineHeight stays undefined');
assert(normalized3.fontName === undefined, 'Missing fontName stays undefined');

// ── Test 9: serializeNodeTree flattens correctly ──────────────────────────
console.log('\nserializeNodeTree:');
const treeRoot = {
  id: 'root',
  name: 'Root',
  type: 'FRAME',
  absoluteBoundingBox: { x: 0, y: 0, width: 300, height: 300 },
  children: [
    {
      id: 'child-a',
      name: 'Child A',
      type: 'RECTANGLE',
      absoluteBoundingBox: { x: 0, y: 0, width: 150, height: 150 },
      children: [
        { id: 'grandchild-1', name: 'GrandChild 1', type: 'TEXT', absoluteBoundingBox: { x: 10, y: 10, width: 100, height: 50 } },
      ],
    },
    {
      id: 'child-b',
      name: 'Child B',
      type: 'RECTANGLE',
      absoluteBoundingBox: { x: 150, y: 0, width: 150, height: 150 },
    },
  ],
};
const serialized = serializeNodeTree(treeRoot);
assert(serialized instanceof Map, 'Returns a Map');
assert(serialized.get('root') !== undefined, 'Root node exists in map');
assert(serialized.get('child-a') !== undefined, 'Child A exists in map');
assert(serialized.get('grandchild-1') !== undefined, 'GrandChild 1 exists in map');
assert(serialized.get('root').parentId === null, 'Root has parentId = null');
assert(serialized.get('child-a').parentId === 'root', 'Child A has correct parentId');
assert(serialized.get('grandchild-1').parentId === 'child-a', 'GrandChild 1 has correct parentId');

// ── Test 10: serializeNodeTree handles deeply nested trees ──────────────
console.log('\nserializeNodeTree — deep nesting:');
let deepNode = { id: 'l1', name: 'Level 1', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 } };
let currentLevel = deepNode;
for (let i = 2; i <= 5; i++) {
  const child = { id: `l${i}`, name: `Level ${i}`, type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 }, children: [] };
  currentLevel.children = [child];
  currentLevel = child;
}
const deepSerialized = serializeNodeTree(deepNode);
assert(deepSerialized.get('l5') !== undefined, 'Deep level 5 node serialized');
assert(deepSerialized.get('l5').parentId === 'l4', 'Level 5 parent link correct');

// ── Test 11: createMockNode returns valid nodes ──────────────────────────
console.log('\ncreateMockNode:');
const mock = createMockNode();
let validation = validateNode(mock);
assert(validation.valid, 'Default mock node passes validation');

const mockCustom = createMockNode({ name: 'CustomNode', type: 'TEXT' });
assert(mockCustom.name === 'CustomNode', 'Overrides apply correctly');
assert(mockCustom.type === 'TEXT', 'Override type works');
validation = validateNode(mockCustom);
assert(validation.valid, 'Customized mock node passes validation');

// ── Test 12: createMockNode presets work ────────────────────────────────
console.log('\ncreateMockNode presets:');
const frame = createMockNode.frame();
assert(frame.type === 'FRAME', 'frame() preset has FRAME type');
assert(frame.layoutMode === 'VERTICAL', 'frame() preset has layoutMode VERTICAL');
validation = validateNode(frame);
assert(validation.valid, 'frame() preset passes validation');

const text = createMockNode.text();
assert(text.type === 'TEXT', 'text() preset has TEXT type');
assert(text.characters === 'Sample text', 'text() preset has sample text');
validation = validateNode(text);
assert(validation.valid, 'text() preset passes validation');

const rectangle = createMockNode.rectangle();
assert(rectangle.type === 'RECTANGLE', 'rectangle() preset has RECTANGLE type');
assert(rectangle.cornerRadius === 4, 'rectangle() preset has cornerRadius');
validation = validateNode(rectangle);
assert(validation.valid, 'rectangle() preset passes validation');

const button = createMockNode.button();
assert(button.type === 'COMPONENT', 'button() preset has COMPONENT type');
assert(button.children.length === 1, 'button() preset has 1 child (label)');
validation = validateNode(button);
assert(validation.valid, 'button() preset passes validation');

// ── Test 13: createMockScene('card') returns realistic card ──────────────
console.log('\ncreateMockScene — card:');
const card = createMockScene('card');
assert(card.name === 'ProductCard', 'Card has correct name');
assert(card.type === 'FRAME', 'Card is a FRAME');
assert(card.children.length >= 4, 'Card has image, title, subtitle, button');
validation = validateNode(card);
assert(validation.valid, 'Card scene passes validation');

// Find children by name
const cardImage = card.children.find(c => c.name === 'Image');
const cardTitle = card.children.find(c => c.name === 'Title');
const cardButton = card.children.find(c => c.name === 'CTA Button');
assert(cardImage !== undefined, 'Card has Image child');
assert(cardTitle !== undefined, 'Card has Title child');
assert(cardButton !== undefined, 'Card has CTA Button child');

// ── Test 14: createMockScene('navbar') returns realistic navbar ──────────
console.log('\ncreateMockScene — navbar:');
const navbar = createMockScene('navbar');
assert(navbar.name === 'Navigation', 'Navbar has correct name');
assert(navbar.layoutMode === 'HORIZONTAL', 'Navbar uses horizontal layout');
assert(navbar.children.length >= 3, 'Navbar has logo, links, CTA');
validation = validateNode(navbar);
assert(validation.valid, 'Navbar scene passes validation');

const navLogo = navbar.children.find(c => c.name === 'Logo');
const navLinks = navbar.children.find(c => c.name === 'Links');
assert(navLogo !== undefined, 'Navbar has Logo');
assert(navLinks !== undefined, 'Navbar has Links container');

// ── Test 15: createMockScene('hero') returns realistic hero ────────────────
console.log('\ncreateMockScene — hero:');
const hero = createMockScene('hero');
assert(hero.name === 'Hero Section', 'Hero has correct name');
assert(hero.children.length >= 3, 'Hero has heading, paragraph, buttons');
validation = validateNode(hero);
assert(validation.valid, 'Hero scene passes validation');

const heroHeading = hero.children.find(c => c.name === 'Heading');
const heroParagraph = hero.children.find(c => c.name === 'Paragraph');
const heroButtons = hero.children.find(c => c.name === 'Button Group');
assert(heroHeading !== undefined, 'Hero has Heading');
assert(heroParagraph !== undefined, 'Hero has Paragraph');
assert(heroButtons !== undefined, 'Hero has Button Group');

// ── Test 16: createMCPBridge returns correct interface ──────────────────
console.log('\ncreateMCPBridge:');
const mockMCPClient = {
  async getMetadata(nodeId) { return { id: nodeId, name: 'Test' }; },
  async getDesignContext(nodeId) { return null; },
  async getScreenshot(nodeId) { return 'screenshot-base64'; },
};
const bridge = createMCPBridge(mockMCPClient);
assert(typeof bridge.fetchNode === 'function', 'Bridge has fetchNode method');
assert(typeof bridge.fetchScreenshot === 'function', 'Bridge has fetchScreenshot method');
assert(typeof bridge.parseNodeId === 'function', 'Bridge has parseNodeId method');

// ── Test 17: createMCPBridge throws on missing client ──────────────────
console.log('\ncreateMCPBridge — error handling:');
let threwOnMissing = false;
try { createMCPBridge(null); } catch { threwOnMissing = true; }
assert(threwOnMissing, 'Throws when mcpClient is null');

// ── Test 18: extractNodeId parses Figma URLs ──────────────────────────────
console.log('\nextractNodeId — URL parsing:');
const url1 = 'https://figma.com/design/abc123/MyFile?node-id=1-2';
const extracted1 = extractNodeId(url1);
assert(extracted1 === '1:2', 'Extracts node ID from design URL');

const url2 = 'https://www.figma.com/file/xyz789/AnotherFile?node-id=5-10&param=value';
const extracted2 = extractNodeId(url2);
assert(extracted2 === '5:10', 'Extracts node ID from file URL with extra params');

const url3 = 'https://figma.com/design/key/name?node-id=100-200';
const extracted3 = extractNodeId(url3);
assert(extracted3 === '100:200', 'Converts dash to colon in extracted ID');

// ── Test 19: extractNodeId handles raw node IDs ──────────────────────────
console.log('\nextractNodeId — raw IDs:');
const rawId1 = '1:2';
assert(extractNodeId(rawId1) === '1:2', 'Accepts node ID with colon');

const rawId2 = '1-2';
assert(extractNodeId(rawId2) === '1:2', 'Normalizes dash to colon');

// ── Test 20: extractNodeId returns null for invalid input ──────────────────
console.log('\nextractNodeId — invalid input:');
assert(extractNodeId('https://google.com') === null, 'Returns null for non-Figma URL');
assert(extractNodeId('not-a-url') === null, 'Returns null for invalid input');
assert(extractNodeId(null) === null, 'Returns null for null');
assert(extractNodeId('') === null, 'Returns null for empty string');

// ── Test 21: Edge case — empty children array ──────────────────────────────
console.log('\nEdge cases:');
const emptyChildren = {
  id: '1:1',
  name: 'Node',
  type: 'FRAME',
  absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
  children: [],
};
validation = validateNode(emptyChildren);
assert(validation.valid, 'Node with empty children array is valid');

// ── Test 22: Edge case — node with no fills ────────────────────────────────
const noFills = {
  id: '1:1',
  name: 'Node',
  type: 'FRAME',
  absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
  fills: [],
};
validation = validateNode(noFills);
assert(validation.valid, 'Node with no fills is valid');

// ── Test 23: Edge case — TEXT node with all typography ────────────────────
const textWithTypography = {
  id: '1:1',
  name: 'Rich Text',
  type: 'TEXT',
  absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 50 },
  characters: 'Sample text with full typography',
  fontSize: 16,
  fontWeight: 600,
  fontName: { family: 'Helvetica', style: 'Bold' },
  lineHeight: { value: 24, unit: 'PIXELS' },
  letterSpacing: { value: 0.5, unit: 'PIXELS' },
  textAlignHorizontal: 'CENTER',
  fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1 }],
};
validation = validateNode(textWithTypography);
assert(validation.valid, 'TEXT node with full typography is valid');

// ── Test 24: normalizeNode preserves explicit values ─────────────────────
console.log('\nnormalizeNode — preserves explicit values:');
const explicit = {
  id: '1:1',
  name: 'Test',
  type: 'FRAME',
  absoluteBoundingBox: { x: 50, y: 75, width: 250, height: 300 },
  opacity: 0.5,
  cornerRadius: 8,
};
const normalized4 = normalizeNode(explicit);
assert(normalized4.absoluteBoundingBox.x === 50, 'Preserves explicit x');
assert(normalized4.absoluteBoundingBox.y === 75, 'Preserves explicit y');
assert(normalized4.opacity === 0.5, 'Preserves explicit opacity');
assert(normalized4.cornerRadius === 8, 'Preserves explicit cornerRadius');

// ── Test 25: normalizeNode handles nested children recursively ───────────
console.log('\nnormalizeNode — recursive children:');
const parentWithChildren = {
  id: 'parent',
  name: 'Parent',
  type: 'FRAME',
  children: [
    {
      id: 'child',
      name: 'Child',
      type: 'RECTANGLE',
      children: [{ id: 'grandchild', name: 'GrandChild', type: 'TEXT' }],
    },
  ],
};
const normalized5 = normalizeNode(parentWithChildren);
assert(normalized5.children.length === 1, 'Parent has 1 child');
assert(normalized5.children[0].children.length === 1, 'Child has 1 grandchild');
assert(normalized5.children[0].children[0].id === 'grandchild', 'GrandChild normalized correctly');

// ─── Summary ───────────────────────────────────────────────────────────────
console.log(`\n─── Results ───\n`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`Total:  ${passed + failed}\n`);

if (failed === 0) {
  console.log('✓ All tests passed.\n');
  process.exit(0);
} else {
  console.log(`✗ ${failed} test(s) failed.\n`);
  process.exit(1);
}
