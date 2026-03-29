// ─── compiler/figmaToAbsoluteCSS.mjs ────────────────────────────────────────
// D2 Deterministic CSS Compiler — Stage 1
// Pure algorithmic translation from Figma nodes to CSS.
//
// CORE INVARIANTS (from RONIN_DESIGN_INTELLIGENCE.md §4.1):
// — No model touches this stage. Zero LLM. Zero inference.
// — The compiler NEVER infers. If a property is missing, it is omitted.
// — The compiler NEVER adds hover states, transitions, or animations.
// — The compiler NEVER changes a numeric value.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Clamp RGBA value (0-1 range) to 0-255 integer
 */
function clampColor(value) {
  return Math.round(Math.max(0, Math.min(1, value)) * 255);
}

/**
 * Round pixel value to 1 decimal place
 */
function roundPx(value) {
  return Math.round(value * 10) / 10;
}

/**
 * Convert Figma RGBA (0-1 range) to CSS hex or rgba.
 * Returns hex string if opacity === 1, rgba otherwise.
 */
export function rgbaToHex(color, opacity = 1) {
  if (!color) return '#000000';

  const r = clampColor(color.r ?? 0);
  const g = clampColor(color.g ?? 0);
  const b = clampColor(color.b ?? 0);
  const a = opacity ?? 1;

  // If we have an explicit alpha in the color object, use it
  const finalOpacity = color.a !== undefined ? color.a * opacity : opacity;

  if (finalOpacity === 1) {
    // Pure hex
    const hex = [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return '#' + hex.toUpperCase();
  } else {
    // RGBA format
    return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + finalOpacity + ')';
  }
}

/**
 * Compile a linear gradient fill to CSS linear-gradient string
 */
export function compileLinearGradient(fill) {
  if (!fill.gradientStops || fill.gradientStops.length === 0) {
    // Fallback: use first stop color
    if (fill.gradientStops && fill.gradientStops[0]) {
      return 'linear-gradient(to right, ' + rgbaToHex(fill.gradientStops[0].color) + ')';
    }
    return 'linear-gradient(to right, #000000)';
  }

  // Compute angle from handle positions
  let angle = 0;
  if (fill.gradientHandlePositions && fill.gradientHandlePositions.length >= 2) {
    const p1 = fill.gradientHandlePositions[0];
    const p2 = fill.gradientHandlePositions[1];
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    angle = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
  }

  const stops = fill.gradientStops
    .map((stop) => {
      const color = rgbaToHex(stop.color, stop.opacity ?? 1);
      const position = Math.round(stop.position * 100);
      return color + ' ' + position + '%';
    })
    .join(', ');

  return 'linear-gradient(' + angle + 'deg, ' + stops + ')';
}

/**
 * Compile shadow effect to CSS box-shadow string
 */
export function compileShadow(effect) {
  const offsetX = roundPx(effect.offset?.x ?? 0);
  const offsetY = roundPx(effect.offset?.y ?? 0);
  const radius = roundPx(effect.radius ?? 0);
  const color = rgbaToHex(effect.color, effect.color?.a ?? 1);

  const inset = effect.type === 'INNER_SHADOW' ? 'inset ' : '';
  return inset + offsetX + 'px ' + offsetY + 'px ' + radius + 'px ' + color;
}

/**
 * Compile Figma line height to CSS
 */
export function compileLineHeight(lineHeight) {
  if (!lineHeight) return undefined;

  if (lineHeight.unit === 'AUTO') {
    return 'normal';
  }
  if (lineHeight.unit === 'PIXELS') {
    return lineHeight.value + 'px';
  }
  if (lineHeight.unit === 'PERCENT') {
    return (lineHeight.value / 100).toString();
  }

  return undefined;
}

/**
 * Compile Figma letter spacing to CSS
 */
export function compileLetterSpacing(letterSpacing) {
  if (!letterSpacing) return undefined;

  if (letterSpacing.unit === 'PIXELS') {
    return roundPx(letterSpacing.value) + 'px';
  }
  if (letterSpacing.unit === 'PERCENT') {
    return (letterSpacing.value / 100).toFixed(3) + 'em';
  }

  return undefined;
}

/**
 * Compile auto-layout properties to flexbox (raw data, not applied)
 * Returns flexbox CSS or null if not auto-layout
 */
export function compileAutoLayout(node) {
  if (!node.layoutMode || node.layoutMode === 'NONE') {
    return null;
  }

  const flexbox = {
    display: 'flex',
  };

  if (node.layoutMode === 'HORIZONTAL') {
    flexbox.flexDirection = 'row';
  } else if (node.layoutMode === 'VERTICAL') {
    flexbox.flexDirection = 'column';
  }

  // Primary axis alignment
  if (node.primaryAxisAlignItems) {
    const mapping = {
      MIN: 'flex-start',
      CENTER: 'center',
      MAX: 'flex-end',
      SPACE_BETWEEN: 'space-between',
    };
    flexbox.justifyContent = mapping[node.primaryAxisAlignItems] || 'flex-start';
  }

  // Counter axis alignment
  if (node.counterAxisAlignItems) {
    const mapping = {
      MIN: 'flex-start',
      CENTER: 'center',
      MAX: 'flex-end',
    };
    flexbox.alignItems = mapping[node.counterAxisAlignItems] || 'flex-start';
  }

  // Gap from itemSpacing
  if (node.itemSpacing !== undefined && node.itemSpacing > 0) {
    flexbox.gap = roundPx(node.itemSpacing) + 'px';
  }

  // Padding
  if (
    node.paddingTop !== undefined ||
    node.paddingRight !== undefined ||
    node.paddingBottom !== undefined ||
    node.paddingLeft !== undefined
  ) {
    const pt = node.paddingTop ?? 0;
    const pr = node.paddingRight ?? 0;
    const pb = node.paddingBottom ?? 0;
    const pl = node.paddingLeft ?? 0;

    // Use shorthand if all are equal
    if (pt === pr && pr === pb && pb === pl) {
      if (pt > 0) {
        flexbox.padding = roundPx(pt) + 'px';
      }
    } else if (pt === pb && pr === pl) {
      flexbox.padding = roundPx(pt) + 'px ' + roundPx(pr) + 'px';
    } else {
      flexbox.padding = roundPx(pt) + 'px ' + roundPx(pr) + 'px ' + roundPx(pb) + 'px ' + roundPx(pl) + 'px';
    }
  }

  return flexbox;
}

/**
 * Compile a single Figma node to CSS object
 * Returns { position: 'absolute', left: '...' , ... }
 */
export function compileNode(node, parentNode = null) {
  if (!node.absoluteBoundingBox) {
    return {};
  }

  const { x, y, width, height } = node.absoluteBoundingBox;

  const css = {
    position: 'absolute',
    left: roundPx(x) + 'px',
    top: roundPx(y) + 'px',
    width: roundPx(width) + 'px',
    height: roundPx(height) + 'px',
  };

  // ─── Fills (solid or gradient) ────────────────────────────────────────────
  if (node.fills && node.fills.length > 0) {
    const fill = node.fills[0];

    if (fill.type === 'SOLID' && fill.visible !== false) {
      css.backgroundColor = rgbaToHex(fill.color, fill.opacity ?? 1);
    } else if (fill.type === 'GRADIENT_LINEAR' && fill.visible !== false) {
      css.background = compileLinearGradient(fill);
    }
  }

  // ─── Strokes ─────────────────────────────────────────────────────────────
  if (node.strokes && node.strokes.length > 0) {
    const stroke = node.strokes[0];
    if (stroke.visible !== false) {
      const weight = node.strokeWeight ?? 1;
      const color = rgbaToHex(stroke.color, stroke.opacity ?? 1);
      css.border = roundPx(weight) + 'px solid ' + color;
    }
  }

  // ─── Border radius ────────────────────────────────────────────────────────
  if (node.cornerRadius !== undefined && node.cornerRadius !== null) {
    css.borderRadius = roundPx(node.cornerRadius) + 'px';
  } else if (
    node.rectangleCornerRadii &&
    Array.isArray(node.rectangleCornerRadii) &&
    node.rectangleCornerRadii.length === 4
  ) {
    const [tl, tr, br, bl] = node.rectangleCornerRadii;
    css.borderRadius = roundPx(tl) + 'px ' + roundPx(tr) + 'px ' + roundPx(br) + 'px ' + roundPx(bl) + 'px';
  }

  // ─── Opacity (only if !== 1) ─────────────────────────────────────────────
  if (node.opacity !== undefined && node.opacity !== 1) {
    css.opacity = node.opacity;
  }

  // ─── Effects (shadows and blur) ───────────────────────────────────────────
  if (node.effects && node.effects.length > 0) {
    // Collect drop and inner shadows
    const shadows = node.effects
      .filter((e) => (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') && e.visible !== false)
      .map(compileShadow);

    if (shadows.length > 0) {
      css.boxShadow = shadows.join(', ');
    }

    // Blur effect
    const blurs = node.effects.filter((e) => e.type === 'LAYER_BLUR' && e.visible !== false);
    if (blurs.length > 0) {
      const blurRadius = blurs[0].radius ?? 0;
      css.filter = 'blur(' + roundPx(blurRadius) + 'px)';
    }
  }

  // ─── Blend mode (only if !== NORMAL) ──────────────────────────────────────
  if (node.blendMode && node.blendMode !== 'NORMAL') {
    css.mixBlendMode = node.blendMode.toLowerCase();
  }

  // ─── Typography (TEXT nodes) ──────────────────────────────────────────────
  if (node.type === 'TEXT') {
    if (node.fontName) {
      css.fontFamily = '"' + node.fontName.family + '", sans-serif';
    }

    if (node.fontSize !== undefined) {
      css.fontSize = roundPx(node.fontSize) + 'px';
    }

    if (node.fontWeight !== undefined) {
      css.fontWeight = node.fontWeight;
    }

    if (node.lineHeight !== undefined) {
      const lh = compileLineHeight(node.lineHeight);
      if (lh) css.lineHeight = lh;
    }

    if (node.letterSpacing !== undefined) {
      const ls = compileLetterSpacing(node.letterSpacing);
      if (ls) css.letterSpacing = ls;
    }

    if (node.textAlignHorizontal) {
      css.textAlign = node.textAlignHorizontal.toLowerCase();
    }

    // Text color from first fill
    if (node.fills && node.fills.length > 0) {
      const textFill = node.fills[0];
      if (textFill.type === 'SOLID') {
        css.color = rgbaToHex(textFill.color, textFill.opacity ?? 1);
      }
    }
  }

  return css;
}

/**
 * Compile an entire node tree to a flat map
 * Returns Map<nodeId, { nodeId, nodeName, nodeType, css, children }>
 */
export function compileTree(rootNode) {
  const map = new Map();

  function traverse(node, parentId = null) {
    const css = compileNode(node);

    map.set(node.id, {
      nodeId: node.id,
      nodeName: node.name,
      nodeType: node.type,
      css,
      parentId,
      children: [],
    });

    if (node.children && Array.isArray(node.children)) {
      for (const child of node.children) {
        traverse(child, node.id);
        // Add child reference to parent
        const parent = map.get(node.id);
        if (parent) {
          parent.children.push(child.id);
        }
      }
    }
  }

  traverse(rootNode);
  return map;
}

/**
 * Sanitize Figma layer name to valid CSS class name
 */
export function sanitizeClassName(nodeName) {
  if (!nodeName) return 'element';

  return nodeName
    .toLowerCase()
    .replace(/\s+/g, '-') // spaces → hyphens
    .replace(/\//g, '-') // slashes → hyphens
    .replace(/[^a-z0-9-]/g, '') // remove non-alphanumeric except hyphens
    .replace(/^-+|-+$/g, '') // trim hyphens
    .replace(/-+/g, '-'); // collapse multiple hyphens
}

/**
 * Generate CSS string from compiled node map
 */
export function generateCSS(compiledMap) {
  let css = '';

  for (const [nodeId, node] of compiledMap) {
    const className = sanitizeClassName(node.nodeName);

    if (Object.keys(node.css).length === 0) {
      // No CSS properties, skip
      continue;
    }

    css += '.' + className + ' {\n';

    for (const [prop, value] of Object.entries(node.css)) {
      const cssProp = prop.replace(/([A-Z])/g, (m) => '-' + m.toLowerCase());
      css += '  ' + cssProp + ': ' + value + ';\n';
    }

    css += '}\n\n';
  }

  return css;
}
