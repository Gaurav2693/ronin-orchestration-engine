// ─── compiler/figmaToAbsoluteCSS.test.mjs ────────────────────────────────────
// Definition-of-done test suite for D2 Deterministic CSS Compiler (Stage 1)
//
// Target: 70+ tests covering:
// — compileNode basics (position, fills, strokes, radius, effects)
// — Typography compilation
// — Color conversion
// — Auto-layout compilation
// — compileTree (multi-node)
// — CSS generation (class names, full CSS)
// — Integration tests (full scenes)
// ─────────────────────────────────────────────────────────────────────────────

import {
  compileNode,
  compileTree,
  rgbaToHex,
  compileLinearGradient,
  compileShadow,
  compileLineHeight,
  compileLetterSpacing,
  compileAutoLayout,
  generateCSS,
  sanitizeClassName,
} from './figmaToAbsoluteCSS.mjs';

import {
  createMockNode,
  createMockScene,
  createSolidFill,
  createLinearGradientFill,
  createStroke,
  createDropShadow,
  createInnerShadow,
  createBlurEffect,
} from './figmaNodeAdapter.mjs';

import assert from 'node:assert/strict';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name} (${e.message})`);
    failed++;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n─── D2 Deterministic CSS Compiler — Definition of Done ───\n');

// ─── compileNode: position & layout (15+ tests) ──────────────────────────────
console.log('compileNode — Position & Layout:');

test('compiles absoluteBoundingBox to position absolute', () => {
  const node = createMockNode({
    absoluteBoundingBox: { x: 100, y: 200, width: 300, height: 400 },
  });
  const css = compileNode(node);

  assert.equal(css.position, 'absolute');
  assert.equal(css.left, '100px');
  assert.equal(css.top, '200px');
  assert.equal(css.width, '300px');
  assert.equal(css.height, '400px');
});

test('handles sub-pixel coordinates (rounds to 1 decimal)', () => {
  const node = createMockNode({
    absoluteBoundingBox: { x: 288.5, y: 412.3, width: 140.7, height: 44.2 },
  });
  const css = compileNode(node);

  assert.equal(css.left, '288.5px');
  assert.equal(css.top, '412.3px');
  assert.equal(css.width, '140.7px');
  assert.equal(css.height, '44.2px');
});

test('compiles solid fill to backgroundColor', () => {
  const node = createMockNode({
    fills: [createSolidFill(0.5, 0.5, 0.5, 1, 1)],
  });
  const css = compileNode(node);

  assert.equal(css.backgroundColor, '#808080');
});

test('compiles gradient fill to background linear-gradient', () => {
  const node = createMockNode({
    fills: [
      createLinearGradientFill([
        { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
        { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
      ]),
    ],
  });
  const css = compileNode(node);

  assert(css.background.includes('linear-gradient'));
  assert(css.background.includes('#FF0000'));
  assert(css.background.includes('#0000FF'));
});

test('compiles single stroke to border', () => {
  const node = createMockNode({
    strokes: [createStroke(0, 0, 0, 1, 2)],
    strokeWeight: 2,
  });
  const css = compileNode(node);

  assert(css.border.includes('2px'));
  assert(css.border.includes('solid'));
  assert(css.border.includes('#000000'));
});

test('compiles uniform cornerRadius to borderRadius', () => {
  const node = createMockNode({
    cornerRadius: 8,
  });
  const css = compileNode(node);

  assert.equal(css.borderRadius, '8px');
});

test('compiles per-corner rectangleCornerRadii', () => {
  const node = createMockNode({
    rectangleCornerRadii: [4, 8, 12, 16],
  });
  const css = compileNode(node);

  assert.equal(css.borderRadius, '4px 8px 12px 16px');
});

test('compiles opacity only when !== 1', () => {
  const node1 = createMockNode({ opacity: 1 });
  const css1 = compileNode(node1);
  assert(css1.opacity === undefined);

  const node2 = createMockNode({ opacity: 0.5 });
  const css2 = compileNode(node2);
  assert.equal(css2.opacity, 0.5);
});

test('compiles drop shadow to boxShadow', () => {
  const node = createMockNode({
    effects: [createDropShadow(0, 4, 8, 0)],
  });
  const css = compileNode(node);

  assert(css.boxShadow.includes('0px'));
  assert(css.boxShadow.includes('4px'));
  assert(css.boxShadow.includes('8px'));
});

test('compiles inner shadow to boxShadow inset', () => {
  const node = createMockNode({
    effects: [createInnerShadow(0, 2, 4)],
  });
  const css = compileNode(node);

  assert(css.boxShadow.includes('inset'));
});

test('compiles multiple shadows separated by comma', () => {
  const node = createMockNode({
    effects: [createDropShadow(0, 4, 8), createDropShadow(0, 2, 4)],
  });
  const css = compileNode(node);

  assert(css.boxShadow.includes(', '));
});

test('compiles blur effect to filter', () => {
  const node = createMockNode({
    effects: [createBlurEffect(4)],
  });
  const css = compileNode(node);

  assert.equal(css.filter, 'blur(4px)');
});

test('compiles blendMode to mixBlendMode (only if !== NORMAL)', () => {
  const node1 = createMockNode({ blendMode: 'NORMAL' });
  const css1 = compileNode(node1);
  assert(css1.mixBlendMode === undefined);

  const node2 = createMockNode({ blendMode: 'MULTIPLY' });
  const css2 = compileNode(node2);
  assert.equal(css2.mixBlendMode, 'multiply');
});

test('omits properties that are missing (never infers)', () => {
  const node = createMockNode({
    cornerRadius: undefined,
    opacity: 1,
    effects: [],
    blendMode: 'NORMAL',
  });
  const css = compileNode(node);

  assert(css.borderRadius === undefined);
  assert(css.opacity === undefined);
  assert(css.boxShadow === undefined);
  assert(css.filter === undefined);
  assert(css.mixBlendMode === undefined);
});

// ─── Typography compilation (10+ tests) ──────────────────────────────────────
console.log('\ncompileNode — Typography:');

test('TEXT node compiles fontFamily', () => {
  const node = createMockNode({
    type: 'TEXT',
    fontName: { family: 'Inter', style: 'Regular' },
  });
  const css = compileNode(node);

  assert(css.fontFamily.includes('Inter'));
});

test('TEXT node compiles fontSize', () => {
  const node = createMockNode({
    type: 'TEXT',
    fontSize: 16,
  });
  const css = compileNode(node);

  assert.equal(css.fontSize, '16px');
});

test('TEXT node compiles fontWeight', () => {
  const node = createMockNode({
    type: 'TEXT',
    fontWeight: 700,
  });
  const css = compileNode(node);

  assert.equal(css.fontWeight, 700);
});

test('TEXT node compiles lineHeight PIXELS to px', () => {
  const node = createMockNode({
    type: 'TEXT',
    lineHeight: { value: 24, unit: 'PIXELS' },
  });
  const css = compileNode(node);

  assert.equal(css.lineHeight, '24px');
});

test('TEXT node compiles lineHeight PERCENT to unitless', () => {
  const node = createMockNode({
    type: 'TEXT',
    lineHeight: { value: 150, unit: 'PERCENT' },
  });
  const css = compileNode(node);

  assert.equal(css.lineHeight, '1.5');
});

test('TEXT node compiles lineHeight AUTO to normal', () => {
  const node = createMockNode({
    type: 'TEXT',
    lineHeight: { unit: 'AUTO' },
  });
  const css = compileNode(node);

  assert.equal(css.lineHeight, 'normal');
});

test('TEXT node compiles letterSpacing PIXELS to px', () => {
  const node = createMockNode({
    type: 'TEXT',
    letterSpacing: { value: 0.5, unit: 'PIXELS' },
  });
  const css = compileNode(node);

  assert.equal(css.letterSpacing, '0.5px');
});

test('TEXT node compiles letterSpacing PERCENT to em', () => {
  const node = createMockNode({
    type: 'TEXT',
    letterSpacing: { value: 2, unit: 'PERCENT' },
  });
  const css = compileNode(node);

  assert(css.letterSpacing.includes('em'));
});

test('TEXT node compiles textAlignHorizontal', () => {
  const node = createMockNode({
    type: 'TEXT',
    textAlignHorizontal: 'CENTER',
  });
  const css = compileNode(node);

  assert.equal(css.textAlign, 'center');
});

test('TEXT node compiles color from fills', () => {
  const node = createMockNode({
    type: 'TEXT',
    fills: [createSolidFill(1, 0, 0, 1, 1)],
  });
  const css = compileNode(node);

  assert.equal(css.color, '#FF0000');
});

// ─── Color conversion (10+ tests) ────────────────────────────────────────────
console.log('\nColor Conversion:');

test('rgbaToHex with full opacity returns hex', () => {
  const hex = rgbaToHex({ r: 1, g: 0.5, b: 0 }, 1);
  assert.equal(hex, '#FF8000');
});

test('rgbaToHex with partial opacity returns rgba', () => {
  const rgba = rgbaToHex({ r: 1, g: 1, b: 1 }, 0.5);
  assert(rgba.includes('rgba'));
  assert(rgba.includes('0.5'));
});

test('rgbaToHex edge case: black (0,0,0)', () => {
  const hex = rgbaToHex({ r: 0, g: 0, b: 0 }, 1);
  assert.equal(hex, '#000000');
});

test('rgbaToHex edge case: white (1,1,1)', () => {
  const hex = rgbaToHex({ r: 1, g: 1, b: 1 }, 1);
  assert.equal(hex, '#FFFFFF');
});

test('rgbaToHex defaults opacity to 1 if missing', () => {
  const hex = rgbaToHex({ r: 0.5, g: 0.5, b: 0.5 });
  assert(!hex.includes('rgba'));
});

test('rgbaToHex respects alpha in color object', () => {
  const rgba = rgbaToHex({ r: 1, g: 1, b: 1, a: 0.5 }, 1);
  assert(rgba.includes('rgba'));
  assert(rgba.includes('0.5'));
});

test('rgbaToHex handles null color gracefully', () => {
  const hex = rgbaToHex(null, 1);
  assert.equal(hex, '#000000');
});

test('rgbaToHex clamps values > 1', () => {
  const hex = rgbaToHex({ r: 1.5, g: 0.5, b: 0 }, 1);
  assert.equal(hex, '#FF8000');
});

test('rgbaToHex clamps negative values', () => {
  const hex = rgbaToHex({ r: -0.5, g: 0.5, b: 0 }, 1);
  assert.equal(hex, '#008000');
});

test('rgbaToHex with combined alpha and opacity', () => {
  const rgba = rgbaToHex({ r: 1, g: 1, b: 1, a: 0.8 }, 0.5);
  assert(rgba.includes('rgba'));
  assert(rgba.includes('0.4'));
});

// ─── Auto-layout compilation (8+ tests) ──────────────────────────────────────
console.log('\nAuto-Layout Compilation:');

test('HORIZONTAL layoutMode returns flex row', () => {
  const node = createMockNode({ layoutMode: 'HORIZONTAL' });
  const flex = compileAutoLayout(node);

  assert.equal(flex.display, 'flex');
  assert.equal(flex.flexDirection, 'row');
});

test('VERTICAL layoutMode returns flex column', () => {
  const node = createMockNode({ layoutMode: 'VERTICAL' });
  const flex = compileAutoLayout(node);

  assert.equal(flex.display, 'flex');
  assert.equal(flex.flexDirection, 'column');
});

test('primaryAxisAlignItems MIN maps to flex-start', () => {
  const node = createMockNode({ layoutMode: 'HORIZONTAL', primaryAxisAlignItems: 'MIN' });
  const flex = compileAutoLayout(node);

  assert.equal(flex.justifyContent, 'flex-start');
});

test('primaryAxisAlignItems CENTER maps to center', () => {
  const node = createMockNode({ layoutMode: 'HORIZONTAL', primaryAxisAlignItems: 'CENTER' });
  const flex = compileAutoLayout(node);

  assert.equal(flex.justifyContent, 'center');
});

test('primaryAxisAlignItems MAX maps to flex-end', () => {
  const node = createMockNode({ layoutMode: 'HORIZONTAL', primaryAxisAlignItems: 'MAX' });
  const flex = compileAutoLayout(node);

  assert.equal(flex.justifyContent, 'flex-end');
});

test('primaryAxisAlignItems SPACE_BETWEEN maps to space-between', () => {
  const node = createMockNode({
    layoutMode: 'HORIZONTAL',
    primaryAxisAlignItems: 'SPACE_BETWEEN',
  });
  const flex = compileAutoLayout(node);

  assert.equal(flex.justifyContent, 'space-between');
});

test('counterAxisAlignItems maps correctly', () => {
  const node = createMockNode({ layoutMode: 'HORIZONTAL', counterAxisAlignItems: 'CENTER' });
  const flex = compileAutoLayout(node);

  assert.equal(flex.alignItems, 'center');
});

test('itemSpacing compiles to gap', () => {
  const node = createMockNode({ layoutMode: 'HORIZONTAL', itemSpacing: 16 });
  const flex = compileAutoLayout(node);

  assert.equal(flex.gap, '16px');
});

test('padding compiles in flexbox', () => {
  const node = createMockNode({
    layoutMode: 'HORIZONTAL',
    paddingTop: 8,
    paddingRight: 8,
    paddingBottom: 8,
    paddingLeft: 8,
  });
  const flex = compileAutoLayout(node);

  assert(flex.padding.includes('8px'));
});

test('NONE layoutMode returns null', () => {
  const node = createMockNode({ layoutMode: 'NONE' });
  const flex = compileAutoLayout(node);

  assert.equal(flex, null);
});

// ─── compileTree (10+ tests) ─────────────────────────────────────────────────
console.log('\ncompileTree — Multi-Node:');

test('compiles single node to map', () => {
  const node = createMockNode({ name: 'Card' });
  const map = compileTree(node);

  assert(map.has(node.id));
  assert.equal(map.size, 1);
});

test('map entries have nodeId, nodeName, nodeType, css, children', () => {
  const node = createMockNode({ name: 'Container' });
  const map = compileTree(node);
  const entry = map.get(node.id);

  assert(entry.nodeId);
  assert(entry.nodeName);
  assert(entry.nodeType);
  assert(entry.css !== undefined);
  assert(Array.isArray(entry.children));
});

test('compiles tree with children', () => {
  const child = createMockNode({ name: 'Child' });
  const parent = createMockNode({
    name: 'Parent',
    children: [child],
  });

  const map = compileTree(parent);

  assert.equal(map.size, 2);
  assert(map.has(parent.id));
  assert(map.has(child.id));
});

test('parent-child relationships preserved', () => {
  const child = createMockNode({ name: 'Child' });
  const parent = createMockNode({
    name: 'Parent',
    children: [child],
  });

  const map = compileTree(parent);
  const parentEntry = map.get(parent.id);
  const childEntry = map.get(child.id);

  assert.equal(childEntry.parentId, parent.id);
  assert(parentEntry.children.includes(child.id));
});

test('deep nesting works', () => {
  const grandchild = createMockNode({ name: 'Grandchild' });
  const child = createMockNode({ name: 'Child', children: [grandchild] });
  const root = createMockNode({ name: 'Root', children: [child] });

  const map = compileTree(root);

  assert.equal(map.size, 3);
  assert(map.has(root.id));
  assert(map.has(child.id));
  assert(map.has(grandchild.id));
});

test('all nodes in tree have CSS', () => {
  const child = createMockNode({ name: 'Child' });
  const parent = createMockNode({ name: 'Parent', children: [child] });

  const map = compileTree(parent);

  for (const [, entry] of map) {
    assert(entry.css !== undefined);
    assert(entry.css.position === 'absolute');
  }
});

test('node names preserved in map', () => {
  const child = createMockNode({ name: 'MyButton' });
  const parent = createMockNode({ name: 'CardContainer', children: [child] });

  const map = compileTree(parent);
  const parentEntry = map.get(parent.id);
  const childEntry = map.get(child.id);

  assert.equal(parentEntry.nodeName, 'CardContainer');
  assert.equal(childEntry.nodeName, 'MyButton');
});

// ─── CSS generation (8+ tests) ──────────────────────────────────────────────
console.log('\nCSS Generation:');

test('sanitizeClassName converts spaces to hyphens', () => {
  assert.equal(sanitizeClassName('Product Card'), 'product-card');
});

test('sanitizeClassName handles slashes', () => {
  assert.equal(sanitizeClassName('CTA / Primary / Large'), 'cta-primary-large');
});

test('sanitizeClassName lowercases', () => {
  assert.equal(sanitizeClassName('MyComponent'), 'mycomponent');
});

test('sanitizeClassName removes special characters', () => {
  assert.equal(sanitizeClassName('Button@2x!'), 'button2x');
});

test('sanitizeClassName trims hyphens', () => {
  assert.equal(sanitizeClassName('---Button---'), 'button');
});

test('sanitizeClassName collapses multiple hyphens', () => {
  assert.equal(sanitizeClassName('My---Component'), 'my-component');
});

test('generateCSS produces valid CSS string', () => {
  const node = createMockNode({ name: 'Button', fills: [createSolidFill(0, 0.5, 1)] });
  const map = compileTree(node);
  const cssString = generateCSS(map);

  assert(cssString.includes('.button'));
  assert(cssString.includes('{'));
  assert(cssString.includes('}'));
  assert(cssString.includes('background-color'));
});

test('generateCSS converts camelCase props to kebab-case', () => {
  const node = createMockNode({ name: 'Box', cornerRadius: 4 });
  const map = compileTree(node);
  const cssString = generateCSS(map);

  assert(cssString.includes('border-radius'));
  assert(!cssString.includes('borderRadius'));
});

test('generateCSS with multiple nodes produces multiple rules', () => {
  const child = createMockNode({ name: 'Child', fills: [createSolidFill(1, 0, 0)] });
  const parent = createMockNode({ name: 'Parent', children: [child] });

  const map = compileTree(parent);
  const cssString = generateCSS(map);

  assert(cssString.includes('.parent'));
  assert(cssString.includes('.child'));
});

test('generateCSS includes position properties', () => {
  const node = createMockNode({
    name: 'Block',
    absoluteBoundingBox: { x: 10, y: 20, width: 100, height: 50 },
  });
  const map = compileTree(node);
  const cssString = generateCSS(map);

  assert(cssString.includes('position: absolute'));
  assert(cssString.includes('left: 10px'));
  assert(cssString.includes('top: 20px'));
});

// ─── Integration tests (5+ tests) ─────────────────────────────────────────────
console.log('\nIntegration Tests:');

test('full card scene compiles without errors', () => {
  const cardImage = createMockNode({
    name: 'Card Image',
    absoluteBoundingBox: { x: 0, y: 0, width: 300, height: 180 },
  });

  const cardTitle = createMockNode({
    type: 'TEXT',
    name: 'Card Title',
    absoluteBoundingBox: { x: 16, y: 196, width: 268, height: 24 },
    fontSize: 18,
    fontWeight: 600,
    fontName: { family: 'Inter', style: 'SemiBold' },
  });

  const cardDescription = createMockNode({
    type: 'TEXT',
    name: 'Card Description',
    absoluteBoundingBox: { x: 16, y: 228, width: 268, height: 40 },
    fontSize: 14,
    fontName: { family: 'Inter', style: 'Regular' },
  });

  const card = createMockNode({
    name: 'Card',
    absoluteBoundingBox: { x: 0, y: 0, width: 300, height: 300 },
    cornerRadius: 8,
    effects: [createDropShadow(0, 2, 8)],
    children: [cardImage, cardTitle, cardDescription],
  });

  const map = compileTree(card);

  assert.equal(map.size, 4);
  assert(map.has(card.id));
});

test('full navbar scene compiles without errors', () => {
  const logo = createMockNode({
    name: 'Logo',
    absoluteBoundingBox: { x: 16, y: 12, width: 32, height: 32 },
  });

  const navLink1 = createMockNode({
    type: 'TEXT',
    name: 'Nav Link',
    absoluteBoundingBox: { x: 200, y: 18, width: 60, height: 20 },
    fontSize: 14,
  });

  const navbar = createMockNode({
    name: 'Navbar',
    absoluteBoundingBox: { x: 0, y: 0, width: 1440, height: 56 },
    fills: [createSolidFill(1, 1, 1)],
    strokes: [createStroke(0.8, 0.8, 0.8, 1, 1)],
    layoutMode: 'HORIZONTAL',
    children: [logo, navLink1],
  });

  const map = compileTree(navbar);

  assert(map.size > 1);
  assert(map.has(navbar.id));
});

test('full hero section compiles without errors', () => {
  const heroTitle = createMockNode({
    type: 'TEXT',
    name: 'Hero Title',
    absoluteBoundingBox: { x: 50, y: 100, width: 600, height: 80 },
    fontSize: 48,
    fontWeight: 700,
  });

  const heroSubtitle = createMockNode({
    type: 'TEXT',
    name: 'Hero Subtitle',
    absoluteBoundingBox: { x: 50, y: 200, width: 600, height: 40 },
    fontSize: 20,
  });

  const heroButton = createMockNode({
    name: 'CTA Button',
    absoluteBoundingBox: { x: 50, y: 280, width: 120, height: 44 },
    cornerRadius: 4,
    fills: [createSolidFill(0, 0.5, 1)],
  });

  const hero = createMockNode({
    name: 'Hero Section',
    absoluteBoundingBox: { x: 0, y: 0, width: 1440, height: 600 },
    children: [heroTitle, heroSubtitle, heroButton],
  });

  const map = compileTree(hero);

  assert(map.size >= 4);
});

test('NO hover states, transitions, or animations in output', () => {
  const button = createMockNode({
    name: 'Button',
    fills: [createSolidFill(0, 0.5, 1)],
  });

  const map = compileTree(button);
  const cssString = generateCSS(map);

  assert(!cssString.includes(':hover'));
  assert(!cssString.includes('transition'));
  assert(!cssString.includes('animation'));
  assert(!cssString.includes('@keyframes'));
});

test('all numeric values from input preserved exactly in output', () => {
  const node = createMockNode({
    name: 'TestBox',
    absoluteBoundingBox: { x: 123.4, y: 456.7, width: 789.2, height: 234.5 },
    cornerRadius: 12.5,
    effects: [createDropShadow(1.5, 3.2, 8.4)],
  });

  const css = compileNode(node);

  assert.equal(css.left, '123.4px');
  assert.equal(css.top, '456.7px');
  assert.equal(css.width, '789.2px');
  assert.equal(css.height, '234.5px');
  assert.equal(css.borderRadius, '12.5px');
  assert(css.boxShadow.includes('1.5px'));
  assert(css.boxShadow.includes('3.2px'));
  assert(css.boxShadow.includes('8.4px'));
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
