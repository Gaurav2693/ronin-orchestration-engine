// ─── compiler/figmaNodeAdapter.mjs ──────────────────────────────────────────
// D1 Figma Node Serializer + MCP Bridge Adapter
//
// Provides a unified interface for getting Figma node data from mock or live MCP.
// Defines the canonical node shape that the downstream compiler (Stage 1) expects.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The canonical Figma node shape expected by the compiler.
 * Every node flowing through the pipeline must conform to this.
 */
export const FIGMA_NODE_SCHEMA = {
  id: 'string',              // e.g. "1:2"
  name: 'string',            // layer name in Figma
  type: 'string',            // FRAME | TEXT | RECTANGLE | ELLIPSE | GROUP | COMPONENT | INSTANCE | VECTOR | LINE

  absoluteBoundingBox: {      // THE key property — computed final position
    x: 'number',
    y: 'number',
    width: 'number',
    height: 'number',
  },

  // Visual properties
  fills: [{ type: 'string', color: { r: 'number', g: 'number', b: 'number', a: 'number' }, opacity: 'number' }],
  strokes: [{ type: 'string', color: { r: 'number', g: 'number', b: 'number', a: 'number' } }],
  strokeWeight: 'number',
  cornerRadius: 'number|undefined',
  rectangleCornerRadii: '[number, number, number, number]|undefined',
  opacity: 'number',         // 0-1
  blendMode: 'string',
  effects: [{ type: 'string', visible: 'boolean', radius: 'number', offset: { x: 'number', y: 'number' }, color: { r: 'number', g: 'number', b: 'number', a: 'number' } }],

  // Layout properties
  layoutMode: 'string',      // NONE | HORIZONTAL | VERTICAL
  primaryAxisAlignItems: 'string',
  counterAxisAlignItems: 'string',
  paddingTop: 'number',
  paddingRight: 'number',
  paddingBottom: 'number',
  paddingLeft: 'number',
  itemSpacing: 'number',
  layoutSizingHorizontal: 'string',   // FIXED | FILL | HUG
  layoutSizingVertical: 'string',
  layoutGrow: 'number',      // 0 | 1
  constraints: { horizontal: 'string', vertical: 'string' },

  // Typography (TEXT nodes only)
  fontName: { family: 'string', style: 'string' },
  fontSize: 'number',
  fontWeight: 'number',
  lineHeight: { value: 'number', unit: 'string' },
  letterSpacing: { value: 'number', unit: 'string' },
  textAlignHorizontal: 'string',
  characters: 'string',

  // Children
  children: 'array<node>',  // recursive array of nodes
};

/**
 * Validate that a node conforms to the expected shape.
 * Returns { valid: boolean, errors: string[] }
 */
export function validateNode(node) {
  const errors = [];

  if (!node || typeof node !== 'object') {
    errors.push('Node must be an object');
    return { valid: false, errors };
  }

  // Required fields
  if (typeof node.id !== 'string' || !node.id.trim()) {
    errors.push('Node must have a non-empty string id');
  }
  if (typeof node.name !== 'string' || !node.name.trim()) {
    errors.push('Node must have a non-empty string name');
  }
  if (typeof node.type !== 'string' || !node.type.trim()) {
    errors.push('Node must have a non-empty string type');
  }

  // Required: absoluteBoundingBox with all four properties
  if (!node.absoluteBoundingBox || typeof node.absoluteBoundingBox !== 'object') {
    errors.push('Node must have absoluteBoundingBox object');
  } else {
    const { x, y, width, height } = node.absoluteBoundingBox;
    if (typeof x !== 'number') errors.push('absoluteBoundingBox.x must be a number');
    if (typeof y !== 'number') errors.push('absoluteBoundingBox.y must be a number');
    if (typeof width !== 'number') errors.push('absoluteBoundingBox.width must be a number');
    if (typeof height !== 'number') errors.push('absoluteBoundingBox.height must be a number');
  }

  // Optional fields with type validation
  if (node.opacity !== undefined && typeof node.opacity !== 'number') {
    errors.push('opacity must be a number if present');
  }
  if (node.blendMode !== undefined && typeof node.blendMode !== 'string') {
    errors.push('blendMode must be a string if present');
  }
  if (node.layoutMode !== undefined && typeof node.layoutMode !== 'string') {
    errors.push('layoutMode must be a string if present');
  }
  if (node.strokeWeight !== undefined && typeof node.strokeWeight !== 'number') {
    errors.push('strokeWeight must be a number if present');
  }
  if (node.cornerRadius !== undefined && typeof node.cornerRadius !== 'number') {
    errors.push('cornerRadius must be a number if present');
  }
  if (node.layoutGrow !== undefined && typeof node.layoutGrow !== 'number') {
    errors.push('layoutGrow must be a number if present');
  }
  if (node.fontSize !== undefined && typeof node.fontSize !== 'number') {
    errors.push('fontSize must be a number if present');
  }
  if (node.fontWeight !== undefined && typeof node.fontWeight !== 'number') {
    errors.push('fontWeight must be a number if present');
  }
  if (node.itemSpacing !== undefined && typeof node.itemSpacing !== 'number') {
    errors.push('itemSpacing must be a number if present');
  }
  if (node.paddingTop !== undefined && typeof node.paddingTop !== 'number') {
    errors.push('paddingTop must be a number if present');
  }
  if (node.paddingRight !== undefined && typeof node.paddingRight !== 'number') {
    errors.push('paddingRight must be a number if present');
  }
  if (node.paddingBottom !== undefined && typeof node.paddingBottom !== 'number') {
    errors.push('paddingBottom must be a number if present');
  }
  if (node.paddingLeft !== undefined && typeof node.paddingLeft !== 'number') {
    errors.push('paddingLeft must be a number if present');
  }

  // Validate fills if present
  if (node.fills !== undefined) {
    if (!Array.isArray(node.fills)) {
      errors.push('fills must be an array if present');
    } else {
      node.fills.forEach((fill, idx) => {
        if (typeof fill !== 'object') errors.push(`fills[${idx}] must be an object`);
        if (fill.color && typeof fill.color !== 'object') errors.push(`fills[${idx}].color must be an object`);
      });
    }
  }

  // Validate strokes if present
  if (node.strokes !== undefined) {
    if (!Array.isArray(node.strokes)) {
      errors.push('strokes must be an array if present');
    }
  }

  // Validate children recursively
  if (node.children !== undefined) {
    if (!Array.isArray(node.children)) {
      errors.push('children must be an array if present');
    } else {
      node.children.forEach((child, idx) => {
        const childValidation = validateNode(child);
        if (!childValidation.valid) {
          childValidation.errors.forEach(err => {
            errors.push(`children[${idx}]: ${err}`);
          });
        }
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Normalize raw Figma data to canonical shape.
 * Fills in defaults, converts color formats, cleans up missing fields.
 */
export function normalizeNode(rawNode) {
  if (!rawNode || typeof rawNode !== 'object') {
    throw new Error('normalizeNode requires an object');
  }

  const normalized = {
    id: rawNode.id ?? '',
    name: rawNode.name ?? 'Unnamed',
    type: rawNode.type ?? 'FRAME',

    // absoluteBoundingBox is required — compute defaults if missing
    absoluteBoundingBox: {
      x: rawNode.absoluteBoundingBox?.x ?? rawNode.x ?? 0,
      y: rawNode.absoluteBoundingBox?.y ?? rawNode.y ?? 0,
      width: rawNode.absoluteBoundingBox?.width ?? rawNode.width ?? 100,
      height: rawNode.absoluteBoundingBox?.height ?? rawNode.height ?? 100,
    },

    // Visual properties with sensible defaults
    opacity: rawNode.opacity ?? 1,
    blendMode: rawNode.blendMode ?? 'NORMAL',
    strokeWeight: rawNode.strokeWeight ?? 0,

    // Layout properties
    layoutMode: rawNode.layoutMode ?? 'NONE',
    primaryAxisAlignItems: rawNode.primaryAxisAlignItems ?? 'MIN',
    counterAxisAlignItems: rawNode.counterAxisAlignItems ?? 'MIN',
    paddingTop: rawNode.paddingTop ?? 0,
    paddingRight: rawNode.paddingRight ?? 0,
    paddingBottom: rawNode.paddingBottom ?? 0,
    paddingLeft: rawNode.paddingLeft ?? 0,
    itemSpacing: rawNode.itemSpacing ?? 0,
    layoutSizingHorizontal: rawNode.layoutSizingHorizontal ?? 'FIXED',
    layoutSizingVertical: rawNode.layoutSizingVertical ?? 'FIXED',
    layoutGrow: rawNode.layoutGrow ?? 0,

    // Typography (for TEXT nodes)
    fontSize: rawNode.fontSize ?? 12,
    fontWeight: rawNode.fontWeight ?? 400,
    characters: rawNode.characters ?? '',
  };

  // Optional fields — copy if present
  if (rawNode.cornerRadius !== undefined) normalized.cornerRadius = rawNode.cornerRadius;
  if (rawNode.rectangleCornerRadii !== undefined) normalized.rectangleCornerRadii = rawNode.rectangleCornerRadii;
  if (rawNode.constraints !== undefined) normalized.constraints = rawNode.constraints;
  if (rawNode.fontName !== undefined) normalized.fontName = rawNode.fontName;
  if (rawNode.lineHeight !== undefined) normalized.lineHeight = rawNode.lineHeight;
  if (rawNode.letterSpacing !== undefined) normalized.letterSpacing = rawNode.letterSpacing;
  if (rawNode.textAlignHorizontal !== undefined) normalized.textAlignHorizontal = rawNode.textAlignHorizontal;

  // Normalize fills: convert hex to RGBA if needed
  if (rawNode.fills && Array.isArray(rawNode.fills)) {
    normalized.fills = rawNode.fills.map(fill => ({
      type: fill.type ?? 'SOLID',
      color: normalizeColor(fill.color),
      opacity: fill.opacity ?? 1,
    }));
  } else {
    normalized.fills = [];
  }

  // Normalize strokes
  if (rawNode.strokes && Array.isArray(rawNode.strokes)) {
    normalized.strokes = rawNode.strokes.map(stroke => ({
      type: stroke.type ?? 'SOLID',
      color: normalizeColor(stroke.color),
    }));
  } else {
    normalized.strokes = [];
  }

  // Normalize effects
  if (rawNode.effects && Array.isArray(rawNode.effects)) {
    normalized.effects = rawNode.effects.map(effect => ({
      type: effect.type ?? 'DROP_SHADOW',
      visible: effect.visible ?? true,
      radius: effect.radius ?? 0,
      offset: effect.offset ?? { x: 0, y: 0 },
      color: normalizeColor(effect.color),
    }));
  } else {
    normalized.effects = [];
  }

  // Recursively normalize children
  if (rawNode.children && Array.isArray(rawNode.children)) {
    normalized.children = rawNode.children.map(child => normalizeNode(child));
  } else {
    normalized.children = [];
  }

  return normalized;
}

/**
 * Normalize a color object: ensure it's in RGBA 0-1 range.
 * Accepts: hex string, rgb/rgba object, or already-normalized color.
 */
function normalizeColor(color) {
  if (!color) {
    return { r: 0, g: 0, b: 0, a: 1 };
  }

  // Already normalized RGBA object
  if (typeof color.r === 'number' && typeof color.g === 'number' && typeof color.b === 'number') {
    return {
      r: Math.max(0, Math.min(1, color.r)),
      g: Math.max(0, Math.min(1, color.g)),
      b: Math.max(0, Math.min(1, color.b)),
      a: Math.max(0, Math.min(1, color.a ?? 1)),
    };
  }

  // Hex string: #RRGGBB or #RRGGBBAA
  if (typeof color === 'string' && color.startsWith('#')) {
    return hexToRgba(color);
  }

  return { r: 0, g: 0, b: 0, a: 1 };
}

/**
 * Convert hex string to RGBA (0-1 range)
 */
function hexToRgba(hex) {
  let h = hex.replace('#', '');

  // Handle 3-char hex: #RGB
  if (h.length === 3) {
    h = h.split('').map(c => c + c).join('');
  }

  // 6-char hex: #RRGGBB
  if (h.length === 6) {
    const r = parseInt(h.substring(0, 2), 16) / 255;
    const g = parseInt(h.substring(2, 4), 16) / 255;
    const b = parseInt(h.substring(4, 6), 16) / 255;
    return { r, g, b, a: 1 };
  }

  // 8-char hex: #RRGGBBAA
  if (h.length === 8) {
    const r = parseInt(h.substring(0, 2), 16) / 255;
    const g = parseInt(h.substring(2, 4), 16) / 255;
    const b = parseInt(h.substring(4, 6), 16) / 255;
    const a = parseInt(h.substring(6, 8), 16) / 255;
    return { r, g, b, a };
  }

  return { r: 0, g: 0, b: 0, a: 1 };
}

/**
 * Flatten a node tree into a flat map keyed by node ID.
 * Preserves parent-child relationships via parentId field.
 */
export function serializeNodeTree(rootNode) {
  const map = new Map();

  function traverse(node, parentId = null) {
    const nodeWithParent = { ...node, parentId };
    map.set(node.id, nodeWithParent);

    if (node.children && Array.isArray(node.children)) {
      node.children.forEach(child => {
        traverse(child, node.id);
      });
    }
  }

  traverse(rootNode);
  return map;
}

/**
 * Create a realistic mock Figma node for testing.
 * Returns a fully valid node with reasonable defaults.
 * Overrides let you customize any property.
 */
export function createMockNode(overrides = {}) {
  const defaults = {
    id: `node-${Math.random().toString(36).substring(7)}`,
    name: 'Mock Node',
    type: 'RECTANGLE',
    absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
    opacity: 1,
    blendMode: 'NORMAL',
    layoutMode: 'NONE',
    primaryAxisAlignItems: 'MIN',
    counterAxisAlignItems: 'MIN',
    paddingTop: 0,
    paddingRight: 0,
    paddingBottom: 0,
    paddingLeft: 0,
    itemSpacing: 0,
    layoutSizingHorizontal: 'FIXED',
    layoutSizingVertical: 'FIXED',
    layoutGrow: 0,
    strokeWeight: 0,
    fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 1 }],
    strokes: [],
    effects: [],
    children: [],
    fontSize: 12,
    fontWeight: 400,
    characters: '',
    constraints: { horizontal: 'LEFT', vertical: 'TOP' },
  };

  return { ...defaults, ...overrides };
}

// Presets for common node types
createMockNode.frame = (overrides = {}) =>
  createMockNode({
    type: 'FRAME',
    name: 'Frame',
    layoutMode: 'VERTICAL',
    primaryAxisAlignItems: 'MIN',
    counterAxisAlignItems: 'MIN',
    paddingTop: 16,
    paddingRight: 16,
    paddingBottom: 16,
    paddingLeft: 16,
    itemSpacing: 8,
    ...overrides,
  });

createMockNode.text = (overrides = {}) =>
  createMockNode({
    type: 'TEXT',
    name: 'Text',
    characters: 'Sample text',
    fontSize: 16,
    fontWeight: 400,
    fontName: { family: 'Helvetica', style: 'Regular' },
    lineHeight: { value: 24, unit: 'PIXELS' },
    letterSpacing: { value: 0, unit: 'PIXELS' },
    textAlignHorizontal: 'LEFT',
    fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1 }],
    ...overrides,
  });

createMockNode.rectangle = (overrides = {}) =>
  createMockNode({
    type: 'RECTANGLE',
    name: 'Rectangle',
    cornerRadius: 4,
    fills: [{ type: 'SOLID', color: { r: 0.2, g: 0.2, b: 0.2, a: 1 }, opacity: 1 }],
    ...overrides,
  });

createMockNode.button = (overrides = {}) => {
  const button = createMockNode.frame({
    type: 'COMPONENT',
    name: 'Button',
    absoluteBoundingBox: { x: 0, y: 0, width: 120, height: 44 },
    layoutMode: 'HORIZONTAL',
    paddingTop: 8,
    paddingRight: 16,
    paddingBottom: 8,
    paddingLeft: 16,
    itemSpacing: 8,
    primaryAxisAlignItems: 'CENTER',
    counterAxisAlignItems: 'CENTER',
    cornerRadius: 6,
    fills: [{ type: 'SOLID', color: { r: 0.2, g: 0.2, b: 0.8, a: 1 }, opacity: 1 }],
    ...overrides,
  });

  button.children = [
    createMockNode.text({
      name: 'Label',
      characters: 'Click me',
      fontSize: 14,
      fontWeight: 600,
      fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 1 }],
    }),
  ];

  return button;
};

/**
 * Create complete mock scenes for testing.
 * Types: 'card', 'navbar', 'hero'
 */
export function createMockScene(type) {
  switch (type) {
    case 'card':
      return createCardScene();
    case 'navbar':
      return createNavbarScene();
    case 'hero':
      return createHeroScene();
    default:
      throw new Error(`Unknown scene type: ${type}`);
  }
}

function createCardScene() {
  return createMockNode.frame({
    id: 'card-root',
    name: 'ProductCard',
    absoluteBoundingBox: { x: 0, y: 0, width: 280, height: 360 },
    cornerRadius: 12,
    fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 1 }],
    effects: [{ type: 'DROP_SHADOW', visible: true, radius: 8, offset: { x: 0, y: 2 }, color: { r: 0, g: 0, b: 0, a: 0.1 } }],
    children: [
      createMockNode.rectangle({
        id: 'card-image',
        name: 'Image',
        absoluteBoundingBox: { x: 0, y: 0, width: 280, height: 180 },
        cornerRadius: 12,
        fills: [{ type: 'SOLID', color: { r: 0.8, g: 0.8, b: 0.8, a: 1 }, opacity: 1 }],
      }),
      createMockNode.text({
        id: 'card-title',
        name: 'Title',
        absoluteBoundingBox: { x: 16, y: 200, width: 248, height: 32 },
        characters: 'Product Title',
        fontSize: 18,
        fontWeight: 600,
        lineHeight: { value: 24, unit: 'PIXELS' },
        fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1 }],
      }),
      createMockNode.text({
        id: 'card-subtitle',
        name: 'Subtitle',
        absoluteBoundingBox: { x: 16, y: 240, width: 248, height: 48 },
        characters: 'A brief description of the product',
        fontSize: 14,
        fontWeight: 400,
        lineHeight: { value: 20, unit: 'PIXELS' },
        fills: [{ type: 'SOLID', color: { r: 0.4, g: 0.4, b: 0.4, a: 1 }, opacity: 1 }],
      }),
      createMockNode.button({
        id: 'card-cta',
        name: 'CTA Button',
        absoluteBoundingBox: { x: 16, y: 304, width: 248, height: 40 },
      }),
    ],
  });
}

function createNavbarScene() {
  return createMockNode.frame({
    id: 'navbar-root',
    name: 'Navigation',
    absoluteBoundingBox: { x: 0, y: 0, width: 1440, height: 64 },
    layoutMode: 'HORIZONTAL',
    paddingTop: 16,
    paddingRight: 32,
    paddingBottom: 16,
    paddingLeft: 32,
    itemSpacing: 24,
    primaryAxisAlignItems: 'CENTER',
    counterAxisAlignItems: 'CENTER',
    fills: [{ type: 'SOLID', color: { r: 0.95, g: 0.95, b: 0.95, a: 1 }, opacity: 1 }],
    effects: [{ type: 'DROP_SHADOW', visible: true, radius: 2, offset: { x: 0, y: 1 }, color: { r: 0, g: 0, b: 0, a: 0.05 } }],
    children: [
      createMockNode.text({
        id: 'navbar-logo',
        name: 'Logo',
        absoluteBoundingBox: { x: 32, y: 20, width: 100, height: 24 },
        characters: 'LOGO',
        fontSize: 20,
        fontWeight: 700,
        fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1 }],
      }),
      createMockNode.frame({
        id: 'navbar-links',
        name: 'Links',
        absoluteBoundingBox: { x: 200, y: 16, width: 400, height: 32 },
        layoutMode: 'HORIZONTAL',
        itemSpacing: 32,
        primaryAxisAlignItems: 'CENTER',
        counterAxisAlignItems: 'CENTER',
        children: [
          createMockNode.text({
            id: 'link-1',
            name: 'Link 1',
            characters: 'Home',
            fontSize: 14,
            fontWeight: 400,
            fills: [{ type: 'SOLID', color: { r: 0.2, g: 0.2, b: 0.2, a: 1 }, opacity: 1 }],
          }),
          createMockNode.text({
            id: 'link-2',
            name: 'Link 2',
            characters: 'About',
            fontSize: 14,
            fontWeight: 400,
            fills: [{ type: 'SOLID', color: { r: 0.2, g: 0.2, b: 0.2, a: 1 }, opacity: 1 }],
          }),
          createMockNode.text({
            id: 'link-3',
            name: 'Link 3',
            characters: 'Pricing',
            fontSize: 14,
            fontWeight: 400,
            fills: [{ type: 'SOLID', color: { r: 0.2, g: 0.2, b: 0.2, a: 1 }, opacity: 1 }],
          }),
        ],
      }),
      createMockNode.button({
        id: 'navbar-cta',
        name: 'Sign Up',
        absoluteBoundingBox: { x: 1300, y: 12, width: 108, height: 40 },
        characters: 'Sign Up',
      }),
    ],
  });
}

function createHeroScene() {
  return createMockNode.frame({
    id: 'hero-root',
    name: 'Hero Section',
    absoluteBoundingBox: { x: 0, y: 0, width: 1440, height: 600 },
    layoutMode: 'VERTICAL',
    paddingTop: 80,
    paddingRight: 80,
    paddingBottom: 80,
    paddingLeft: 80,
    itemSpacing: 24,
    primaryAxisAlignItems: 'CENTER',
    counterAxisAlignItems: 'CENTER',
    fills: [{ type: 'SOLID', color: { r: 0.05, g: 0.05, b: 0.15, a: 1 }, opacity: 1 }],
    children: [
      createMockNode.text({
        id: 'hero-heading',
        name: 'Heading',
        absoluteBoundingBox: { x: 200, y: 80, width: 1040, height: 96 },
        characters: 'Welcome to Our Platform',
        fontSize: 48,
        fontWeight: 700,
        lineHeight: { value: 56, unit: 'PIXELS' },
        textAlignHorizontal: 'CENTER',
        fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 1 }],
      }),
      createMockNode.text({
        id: 'hero-paragraph',
        name: 'Paragraph',
        absoluteBoundingBox: { x: 300, y: 200, width: 840, height: 80 },
        characters: 'Build something amazing today. Simple, powerful, and ready to scale.',
        fontSize: 18,
        fontWeight: 400,
        lineHeight: { value: 28, unit: 'PIXELS' },
        textAlignHorizontal: 'CENTER',
        fills: [{ type: 'SOLID', color: { r: 0.8, g: 0.8, b: 0.8, a: 1 }, opacity: 1 }],
      }),
      createMockNode.frame({
        id: 'hero-buttons',
        name: 'Button Group',
        absoluteBoundingBox: { x: 420, y: 320, width: 600, height: 50 },
        layoutMode: 'HORIZONTAL',
        itemSpacing: 16,
        primaryAxisAlignItems: 'CENTER',
        counterAxisAlignItems: 'CENTER',
        children: [
          createMockNode.button({
            id: 'hero-btn-1',
            name: 'Primary CTA',
            absoluteBoundingBox: { x: 420, y: 320, width: 140, height: 50 },
            characters: 'Get Started',
            fills: [{ type: 'SOLID', color: { r: 0, g: 0.7, b: 1, a: 1 }, opacity: 1 }],
          }),
          createMockNode.button({
            id: 'hero-btn-2',
            name: 'Secondary CTA',
            absoluteBoundingBox: { x: 580, y: 320, width: 140, height: 50 },
            characters: 'Learn More',
            fills: [{ type: 'SOLID', color: { r: 0.2, g: 0.2, b: 0.2, a: 1 }, opacity: 1 }],
            strokes: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }],
            strokeWeight: 2,
          }),
        ],
      }),
    ],
  });
}

/**
 * Create the MCP bridge to the Figma MCP.
 * mcpClient has methods: getMetadata, getDesignContext, getScreenshot, getVariableDefs
 */
export function createMCPBridge(mcpClient) {
  if (!mcpClient) {
    throw new Error('createMCPBridge requires an mcpClient object');
  }

  return {
    /**
     * Fetch a node via MCP and normalize to canonical shape.
     * nodeIdOrUrl can be a Figma URL or a node ID string.
     */
    async fetchNode(nodeIdOrUrl) {
      const nodeId = parseNodeId(nodeIdOrUrl);
      if (!nodeId) {
        throw new Error(`Invalid node ID or Figma URL: ${nodeIdOrUrl}`);
      }

      try {
        // Try getDesignContext first (most complete data)
        const context = await mcpClient.getDesignContext(nodeId);
        if (context && context.code) {
          // Parse the context into a node structure
          const node = extractNodeFromContext(context);
          return normalizeNode(node);
        }

        // Fallback: getMetadata
        const metadata = await mcpClient.getMetadata(nodeId);
        if (metadata) {
          return normalizeNode(metadata);
        }

        throw new Error(`No data returned for node ${nodeId}`);
      } catch (error) {
        throw new Error(`MCP fetch failed for ${nodeId}: ${error.message}`);
      }
    },

    /**
     * Fetch a screenshot via MCP.
     */
    async fetchScreenshot(nodeIdOrUrl) {
      const nodeId = parseNodeId(nodeIdOrUrl);
      if (!nodeId) {
        throw new Error(`Invalid node ID or Figma URL: ${nodeIdOrUrl}`);
      }

      try {
        const screenshot = await mcpClient.getScreenshot(nodeId);
        if (!screenshot) {
          throw new Error(`No screenshot returned for ${nodeId}`);
        }
        return screenshot;
      } catch (error) {
        throw new Error(`MCP screenshot fetch failed for ${nodeId}: ${error.message}`);
      }
    },

    /**
     * Parse a node ID from a URL or return as-is if already an ID.
     */
    parseNodeId(input) {
      return parseNodeId(input);
    },
  };
}

/**
 * Extract node ID from a Figma URL or return as-is.
 * Supports:
 *   https://figma.com/design/:fileKey/:fileName?node-id=1-2
 *   https://www.figma.com/file/:key/:name?node-id=1-2
 */
export function extractNodeId(figmaUrl) {
  if (!figmaUrl || typeof figmaUrl !== 'string') {
    return null;
  }

  // Already a node ID (format: "1:2" or "1-2")
  if (/^\d+[-:]\d+$/.test(figmaUrl)) {
    return figmaUrl.replace('-', ':');
  }

  // Try to extract from URL
  const match = figmaUrl.match(/node-id=([^&]+)/);
  if (match && match[1]) {
    return match[1].replace('-', ':');
  }

  return null;
}

/**
 * Parse node ID: extract from URL if needed, otherwise return as-is.
 */
function parseNodeId(input) {
  if (!input || typeof input !== 'string') {
    return null;
  }

  const extracted = extractNodeId(input);
  return extracted || input;
}

// ─── Property Helpers (for test convenience) ─────────────────────────────────

export function createSolidFill(r, g, b, opacity = 1) {
  return { type: 'SOLID', color: { r, g, b, a: 1 }, opacity };
}

export function createLinearGradientFill(stops, handlePositions) {
  return {
    type: 'GRADIENT_LINEAR',
    gradientStops: stops || [
      { position: 0, color: { r: 0, g: 0, b: 0, a: 1 } },
      { position: 1, color: { r: 1, g: 1, b: 1, a: 1 } },
    ],
    gradientHandlePositions: handlePositions || [
      { x: 0, y: 0.5 },
      { x: 1, y: 0.5 },
    ],
  };
}

export function createStroke(r, g, b, weight = 1) {
  return { type: 'SOLID', color: { r, g, b, a: 1 }, weight };
}

export function createDropShadow(offsetX = 0, offsetY = 4, radius = 8, color = { r: 0, g: 0, b: 0, a: 0.25 }) {
  return { type: 'DROP_SHADOW', visible: true, radius, offset: { x: offsetX, y: offsetY }, color };
}

export function createInnerShadow(offsetX = 0, offsetY = 2, radius = 4, color = { r: 0, g: 0, b: 0, a: 0.1 }) {
  return { type: 'INNER_SHADOW', visible: true, radius, offset: { x: offsetX, y: offsetY }, color };
}

export function createBlurEffect(radius = 10) {
  return { type: 'LAYER_BLUR', visible: true, radius };
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Helper: extract minimal node structure from MCP design context response.
 * This is a placeholder — actual structure depends on MCP response format.
 */
function extractNodeFromContext(context) {
  // This would parse the context.code or context.metadata into a node shape
  // For now, return a minimal structure that normalizeNode can handle
  return {
    id: context.nodeId || 'unknown',
    name: context.name || 'Node',
    type: context.type || 'FRAME',
    absoluteBoundingBox: context.boundingBox || { x: 0, y: 0, width: 100, height: 100 },
    opacity: context.opacity || 1,
    fills: context.fills || [],
    strokes: context.strokes || [],
    effects: context.effects || [],
    children: context.children || [],
  };
}
