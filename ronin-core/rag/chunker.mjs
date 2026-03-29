// rag/chunker.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Function-Boundary-Aware Code Chunker
//
// The dumbest possible RAG chunker splits on character count: "every 500 chars."
// That guarantees you'll cut a function in half, and the retriever will return
// a useless fragment. This chunker is smarter.
//
// Strategy:
//   1. Detect language from file extension
//   2. Split source code at structural boundaries:
//      - function/method declarations
//      - class declarations
//      - export statements
//      - top-level const/let/var blocks
//      - markdown headers (for docs)
//   3. If a structural block exceeds MAX_TOKENS, split it with overlap
//   4. If a block is tiny, merge it with the next block (avoid micro-chunks)
//
// Token estimation: 1 token ≈ 4 characters (standard LLM approximation).
// This is intentionally rough — exact tokenization is model-specific and slow.
//
// Output: Array of chunks, each with metadata for the vector store:
//   { content, startLine, endLine, language, type, name }
// ─────────────────────────────────────────────────────────────────────────────

// ─── Configuration ──────────────────────────────────────────────────────────

const CONFIG = {
  TARGET_TOKENS: 512,       // Ideal chunk size
  MAX_TOKENS: 1024,         // Hard cap — split beyond this
  MIN_TOKENS: 64,           // Below this, merge with neighbor
  OVERLAP_TOKENS: 64,       // Overlap between split chunks
  CHARS_PER_TOKEN: 4,       // Rough token estimation
};

// ─── Language Detection ─────────────────────────────────────────────────────

const EXTENSION_MAP = {
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.py': 'python',
  '.rb': 'ruby',
  '.go': 'go',
  '.rs': 'rust',
  '.swift': 'swift',
  '.java': 'java',
  '.kt': 'kotlin',
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.css': 'css',
  '.scss': 'css',
  '.html': 'html',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.sh': 'shell',
  '.bash': 'shell',
};

export function detectLanguage(filePath) {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  return EXTENSION_MAP[ext] || 'unknown';
}

// ─── Boundary Patterns ──────────────────────────────────────────────────────
// Each language has patterns that mark structural boundaries.
// We split BEFORE these lines (the matched line starts a new chunk).

const BOUNDARY_PATTERNS = {
  javascript: [
    /^export\s+(default\s+)?(async\s+)?function\s/,         // export function foo()
    /^export\s+(default\s+)?class\s/,                        // export class Foo
    /^export\s+(const|let|var)\s/,                           // export const foo =
    /^(async\s+)?function\s+\w+/,                            // function foo()
    /^class\s+\w+/,                                          // class Foo
    /^(const|let|var)\s+\w+\s*=\s*(async\s+)?\(/,           // const foo = (
    /^(const|let|var)\s+\w+\s*=\s*(async\s+)?function/,     // const foo = function
    /^(const|let|var)\s+\w+\s*=\s*class/,                   // const Foo = class
    /^\/\/\s*─{3,}/,                                         // // ─── Section Header
    /^\/\/\s*={3,}/,                                         // // === Section Header
  ],
  typescript: null,  // Falls back to javascript
  python: [
    /^def\s+\w+/,                                            // def foo():
    /^async\s+def\s+\w+/,                                    // async def foo():
    /^class\s+\w+/,                                          // class Foo:
    /^@\w+/,                                                 // @decorator (starts a block)
    /^#{1,3}\s/,                                             // Markdown headers in docstrings
  ],
  swift: [
    /^(public|private|internal|open|fileprivate)?\s*(static\s+)?(func|class|struct|enum|protocol)\s/,
    /^extension\s+\w+/,
    /^import\s+\w+/,
    /^\/\/\s*MARK:\s*/,                                      // // MARK: - Section
  ],
  go: [
    /^func\s+(\(\w+\s+\*?\w+\)\s+)?\w+/,                   // func (r *Receiver) Method()
    /^type\s+\w+\s+(struct|interface)/,                      // type Foo struct
    /^package\s+\w+/,
  ],
  rust: [
    /^(pub\s+)?(fn|struct|enum|impl|trait|mod)\s/,
    /^use\s+/,
    /^\/\/\/\s/,                                             // Doc comments
  ],
  markdown: [
    /^#{1,4}\s/,                                             // # Heading
    /^---\s*$/,                                              // Horizontal rule
  ],
  css: [
    /^[.#@]\w/,                                              // .class, #id, @media
    /^\/\*\s*─{3,}/,                                         // /* ─── Section
  ],
};

// Fallback for unknown languages: split on blank lines and common patterns
const FALLBACK_PATTERNS = [
  /^(export\s+)?(function|class|const|let|var|def|func|type|pub|fn)\s/,
  /^#{1,4}\s/,
  /^\/\/\s*─{3,}/,
];

function getBoundaryPatterns(language) {
  if (BOUNDARY_PATTERNS[language]) return BOUNDARY_PATTERNS[language];
  // Typescript falls back to javascript
  if (language === 'typescript') return BOUNDARY_PATTERNS['javascript'];
  return FALLBACK_PATTERNS;
}

// ─── Token Estimation ───────────────────────────────────────────────────────

function estimateTokens(text) {
  return Math.ceil(text.length / CONFIG.CHARS_PER_TOKEN);
}

function tokensToChars(tokens) {
  return tokens * CONFIG.CHARS_PER_TOKEN;
}

// ─── chunkFile(content, filePath) ───────────────────────────────────────────
// Main entry point. Takes file content and path, returns chunks.
//
// Returns: Array<{
//   content: string,        — the actual code/text
//   startLine: number,      — 1-indexed start line
//   endLine: number,        — 1-indexed end line (inclusive)
//   language: string,       — detected language
//   type: string,           — 'function' | 'class' | 'export' | 'block' | 'section'
//   name: string | null,    — extracted identifier (function/class name) or null
//   tokenEstimate: number,  — rough token count
// }>

export function chunkFile(content, filePath) {
  if (!content || typeof content !== 'string') {
    return [];
  }

  const language = detectLanguage(filePath);
  const lines = content.split('\n');

  // Step 1: Find boundary lines
  const boundaries = _findBoundaries(lines, language);

  // Step 2: Split into raw blocks at boundaries
  const rawBlocks = _splitAtBoundaries(lines, boundaries);

  // Step 3: Merge tiny blocks, split oversized blocks
  const chunks = _normalizeBlocks(rawBlocks, language);

  return chunks;
}

// ─── chunkText(content, language?) ──────────────────────────────────────────
// Convenience function for non-file text (e.g., documentation, messages).
// Uses the same logic but with a synthetic file path.

export function chunkText(content, language = 'markdown') {
  const ext = Object.entries(EXTENSION_MAP).find(([_, lang]) => lang === language)?.[0] || '.md';
  return chunkFile(content, `text${ext}`);
}

// ─── _findBoundaries(lines, language) ───────────────────────────────────────
// Returns array of { lineIndex, type, name } for each boundary found.

function _findBoundaries(lines, language) {
  const patterns = getBoundaryPatterns(language);
  const boundaries = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();

    for (const pattern of patterns) {
      if (pattern.test(trimmed)) {
        boundaries.push({
          lineIndex: i,
          type: _classifyLine(trimmed),
          name: _extractName(trimmed),
        });
        break; // Only match one pattern per line
      }
    }
  }

  return boundaries;
}

// ─── _classifyLine(line) ────────────────────────────────────────────────────
// Determine the type of structural boundary.

function _classifyLine(line) {
  if (/\bfunction\b/.test(line)) return 'function';
  if (/\bclass\b/.test(line)) return 'class';
  if (/\bexport\b/.test(line)) return 'export';
  if (/^#{1,4}\s/.test(line)) return 'section';
  if (/\b(def|func|fn|struct|enum|impl|trait|type)\b/.test(line)) return 'function';
  return 'block';
}

// ─── _extractName(line) ─────────────────────────────────────────────────────
// Try to extract the function/class/variable name from a boundary line.

function _extractName(line) {
  // function foo(, async function foo(
  let match = line.match(/(?:async\s+)?function\s+(\w+)/);
  if (match) return match[1];

  // class Foo
  match = line.match(/class\s+(\w+)/);
  if (match) return match[1];

  // export const/let/var foo =
  match = line.match(/(?:export\s+)?(?:const|let|var)\s+(\w+)/);
  if (match) return match[1];

  // def foo( (python)
  match = line.match(/def\s+(\w+)/);
  if (match) return match[1];

  // func foo( (go)
  match = line.match(/func\s+(?:\([^)]*\)\s+)?(\w+)/);
  if (match) return match[1];

  // # Heading (markdown)
  match = line.match(/^#{1,4}\s+(.+)/);
  if (match) return match[1].trim();

  return null;
}

// ─── _splitAtBoundaries(lines, boundaries) ──────────────────────────────────
// Split lines into blocks at boundary points.

function _splitAtBoundaries(lines, boundaries) {
  if (boundaries.length === 0) {
    // No boundaries found → treat the whole file as one block
    return [{
      lines: lines,
      startLine: 1,
      endLine: lines.length,
      type: 'block',
      name: null,
    }];
  }

  const blocks = [];

  // If there's content before the first boundary, capture it
  if (boundaries[0].lineIndex > 0) {
    const preLines = lines.slice(0, boundaries[0].lineIndex);
    // Only add if it's not just whitespace/comments
    const hasContent = preLines.some(l => l.trim().length > 0);
    if (hasContent) {
      blocks.push({
        lines: preLines,
        startLine: 1,
        endLine: boundaries[0].lineIndex,
        type: 'block',
        name: null,
      });
    }
  }

  // Split between each pair of boundaries
  for (let i = 0; i < boundaries.length; i++) {
    const start = boundaries[i].lineIndex;
    const end = i + 1 < boundaries.length
      ? boundaries[i + 1].lineIndex
      : lines.length;

    blocks.push({
      lines: lines.slice(start, end),
      startLine: start + 1, // Convert to 1-indexed
      endLine: end,
      type: boundaries[i].type,
      name: boundaries[i].name,
    });
  }

  return blocks;
}

// ─── _normalizeBlocks(rawBlocks, language) ──────────────────────────────────
// Merge tiny blocks and split oversized blocks to hit target token range.

function _normalizeBlocks(rawBlocks, language) {
  const chunks = [];
  let pendingMerge = null;

  for (const block of rawBlocks) {
    const content = block.lines.join('\n');
    const tokens = estimateTokens(content);

    // ─── Tiny block: accumulate for merge ────────────────────────────
    if (tokens < CONFIG.MIN_TOKENS) {
      if (pendingMerge) {
        // Merge into pending
        pendingMerge.lines = [...pendingMerge.lines, ...block.lines];
        pendingMerge.endLine = block.endLine;
        // Keep the first block's name unless it's null
        if (!pendingMerge.name && block.name) {
          pendingMerge.name = block.name;
          pendingMerge.type = block.type;
        }
      } else {
        pendingMerge = { ...block, lines: [...block.lines] };
      }

      // Check if merged block is now big enough to emit
      const mergedTokens = estimateTokens(pendingMerge.lines.join('\n'));
      if (mergedTokens >= CONFIG.MIN_TOKENS) {
        chunks.push(_toChunk(pendingMerge, language));
        pendingMerge = null;
      }
      continue;
    }

    // Flush any pending merge before processing a normal/large block
    if (pendingMerge) {
      chunks.push(_toChunk(pendingMerge, language));
      pendingMerge = null;
    }

    // ─── Normal block: emit as-is ────────────────────────────────────
    if (tokens <= CONFIG.MAX_TOKENS) {
      chunks.push(_toChunk(block, language));
      continue;
    }

    // ─── Oversized block: split with overlap ─────────────────────────
    const splitChunks = _splitOversizedBlock(block, language);
    chunks.push(...splitChunks);
  }

  // Flush final pending merge
  if (pendingMerge) {
    chunks.push(_toChunk(pendingMerge, language));
  }

  return chunks;
}

// ─── _splitOversizedBlock(block, language) ───────────────────────────────────
// Split a block that exceeds MAX_TOKENS into overlapping sub-chunks.

function _splitOversizedBlock(block, language) {
  const chunks = [];
  const lines = block.lines;
  const targetChars = tokensToChars(CONFIG.TARGET_TOKENS);
  const overlapChars = tokensToChars(CONFIG.OVERLAP_TOKENS);

  let startIdx = 0;
  let partIndex = 0;

  while (startIdx < lines.length) {
    // Accumulate lines until we hit target
    let charCount = 0;
    let endIdx = startIdx;

    while (endIdx < lines.length && charCount < targetChars) {
      charCount += lines[endIdx].length + 1; // +1 for newline
      endIdx++;
    }

    // Build the sub-chunk
    const subLines = lines.slice(startIdx, endIdx);
    const subStartLine = block.startLine + startIdx;
    const subEndLine = block.startLine + endIdx - 1;

    chunks.push({
      content: subLines.join('\n'),
      startLine: subStartLine,
      endLine: subEndLine,
      language,
      type: block.type,
      name: partIndex === 0
        ? block.name
        : block.name ? `${block.name} (part ${partIndex + 1})` : null,
      tokenEstimate: estimateTokens(subLines.join('\n')),
    });

    partIndex++;

    // Move start forward, minus overlap
    const overlapLines = Math.max(1, Math.floor(overlapChars / 40)); // Rough chars per line
    startIdx = Math.max(startIdx + 1, endIdx - overlapLines);

    // If remaining content is tiny, absorb it into the last chunk
    const remainingLines = lines.slice(startIdx);
    const remainingTokens = estimateTokens(remainingLines.join('\n'));
    if (remainingTokens < CONFIG.MIN_TOKENS && startIdx < lines.length) {
      // Extend last chunk to end of block
      const last = chunks[chunks.length - 1];
      last.content = lines.slice(
        last.startLine - block.startLine, lines.length
      ).join('\n');
      last.endLine = block.startLine + lines.length - 1;
      last.tokenEstimate = estimateTokens(last.content);
      break;
    }
  }

  return chunks;
}

// ─── _toChunk(block, language) ──────────────────────────────────────────────
// Convert a raw block to the final chunk shape.

function _toChunk(block, language) {
  const content = block.lines.join('\n');
  return {
    content,
    startLine: block.startLine,
    endLine: block.endLine,
    language,
    type: block.type,
    name: block.name,
    tokenEstimate: estimateTokens(content),
  };
}

// ─── Exports ────────────────────────────────────────────────────────────────

export { CONFIG, EXTENSION_MAP, BOUNDARY_PATTERNS };

export default {
  chunkFile,
  chunkText,
  detectLanguage,
  CONFIG,
};
