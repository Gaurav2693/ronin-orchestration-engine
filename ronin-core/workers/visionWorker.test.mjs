// ─── workers/visionWorker.test.mjs ────────────────────────────────────────────
// Tests for RONIN Vision Worker (W3)
// Run: node visionWorker.test.mjs 2>&1
// ─────────────────────────────────────────────────────────────────────────────

import { createVisionWorker, buildVisionMessages, parseAnalysis, ANALYSIS_MODES } from './visionWorker.mjs';
import { WORKER_STATES } from './workerInterface.mjs';

let testCount = 0;
let passCount = 0;
let failCount = 0;

function test(name, fn) {
  testCount++;
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(() => { passCount++; console.log(`✓ ${name}`); })
        .catch(e => { failCount++; console.error(`✗ ${name}\n  ${e.message}`); });
    }
    passCount++;
    console.log(`✓ ${name}`);
  } catch (e) {
    failCount++;
    console.error(`✗ ${name}\n  ${e.message}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }
function assertEqual(a, b, m) { if (a !== b) throw new Error(m || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

// ─── Mock Provider ──────────────────────────────────────────────────────

function mockVisionProvider(response = 'Analysis complete.', usage = {}) {
  const calls = [];
  return {
    calls,
    complete: async (messages, opts) => {
      calls.push({ messages, opts });
      return { content: response, usage };
    },
  };
}

const MOCK_ANALYSIS = `Component hierarchy:
- Header (nav, height: 64px)
  - Logo (img, 32x32px)
  - NavBar with links
- Main container (section)
  - Card (border-radius: 12px, background: #1a1a1a)
    - Button (background: #00d4aa, color: #ffffff, padding: 12px 24px)
    - Input (border: 1px solid #333, font-size: 14px)
- Footer (font-family: Inter, font-weight: 400)

Design tokens: #00d4aa (primary), #1a1a1a (surface), #ffffff (text), #333333 (border)
Spacing: 8px, 12px, 16px, 24px, 32px, 64px`;

// ─── createVisionWorker ─────────────────────────────────────────────────

console.log('\n── createVisionWorker ──');

test('creates worker with type vision', () => {
  const w = createVisionWorker(mockVisionProvider());
  assertEqual(w.type, 'vision');
});

await test('analyzes single image', async () => {
  const provider = mockVisionProvider(MOCK_ANALYSIS);
  const w = createVisionWorker(provider);
  const result = await w.execute({ image: 'base64data...', message: 'Analyze this screenshot' });

  assertEqual(result.worker, 'vision');
  assertEqual(result.model_hidden, true);
  assertEqual(result.cost, 0);
  assert(result.result.includes('Component hierarchy'));
});

await test('uses correct model', async () => {
  const provider = mockVisionProvider('ok');
  const w = createVisionWorker(provider);
  await w.execute({ image: 'data', message: 'analyze' });

  assertEqual(provider.calls[0].opts.model, 'gemini-2.5-flash');
});

await test('respects custom model', async () => {
  const provider = mockVisionProvider('ok');
  const w = createVisionWorker(provider, { model: 'custom-vision' });
  await w.execute({ image: 'data', message: 'analyze' });

  assertEqual(provider.calls[0].opts.model, 'custom-vision');
});

await test('extracts structured analysis', async () => {
  const provider = mockVisionProvider(MOCK_ANALYSIS);
  const w = createVisionWorker(provider);
  const result = await w.execute({ image: 'data', message: 'analyze' });

  assert(result.analysis !== undefined);
  assert(result.analysis.colors.includes('#00d4aa'));
  assert(result.analysis.colors.includes('#1a1a1a'));
  assert(result.analysis.spacingValues.includes('12px'));
  assert(result.analysis.components.includes('button'));
  assert(result.analysis.components.includes('card'));
});

await test('returns mode in result', async () => {
  const provider = mockVisionProvider('ok');
  const w = createVisionWorker(provider);
  const result = await w.execute({ image: 'data', mode: ANALYSIS_MODES.DESIGN_TOKENS });

  assertEqual(result.mode, ANALYSIS_MODES.DESIGN_TOKENS);
});

await test('cost is always 0 (free tier)', async () => {
  const provider = mockVisionProvider('ok');
  const w = createVisionWorker(provider);
  await w.execute({ image: 'data', message: 'test' });
  await w.execute({ image: 'data', message: 'test' });

  assertEqual(w.getMetrics().totalCost, 0);
});

// ─── Batch Analysis ─────────────────────────────────────────────────────

console.log('\n── Batch Analysis ──');

await test('processes batch of frames', async () => {
  const provider = mockVisionProvider('Frame analyzed');
  const w = createVisionWorker(provider);

  const result = await w.execute({
    frames: [
      { id: 'frame-1', image: 'base64-1' },
      { id: 'frame-2', image: 'base64-2' },
      { id: 'frame-3', image: 'base64-3' },
    ],
    message: 'Analyze these Figma frames',
  });

  assertEqual(result.batchSize, 3);
  assertEqual(result.analyses.length, 3);
  assertEqual(result.cost, 0);
  assertEqual(provider.calls.length, 3);
});

await test('batch handles partial failures', async () => {
  let callCount = 0;
  const provider = {
    complete: async (messages, opts) => {
      callCount++;
      if (callCount === 2) throw new Error('Vision API error');
      return { content: 'Analyzed', usage: {} };
    },
  };
  const w = createVisionWorker(provider);

  const result = await w.execute({
    frames: ['img1', 'img2', 'img3'],
    message: 'analyze',
  });

  assertEqual(result.batchSize, 3);
  assertEqual(result.errors.length, 1);
  assert(result.errors[0].error.includes('Vision API error'));
});

await test('batch respects maxParallel', async () => {
  let maxConcurrent = 0;
  let current = 0;
  const provider = {
    complete: async () => {
      current++;
      if (current > maxConcurrent) maxConcurrent = current;
      await new Promise(r => setTimeout(r, 10));
      current--;
      return { content: 'ok', usage: {} };
    },
  };

  const w = createVisionWorker(provider, { maxParallel: 2 });
  await w.execute({
    frames: ['a', 'b', 'c', 'd'],
    message: 'analyze',
  });

  assert(maxConcurrent <= 2, `Max concurrent was ${maxConcurrent}, expected <= 2`);
});

await test('batch with empty frames', async () => {
  const provider = mockVisionProvider('ok');
  const w = createVisionWorker(provider);
  const result = await w.execute({ frames: [], message: 'test' });

  assertEqual(result.batchSize, 0);
  assertEqual(result.analyses.length, 0);
});

// ─── Analysis Modes ─────────────────────────────────────────────────────

console.log('\n── Analysis Modes ──');

test('ANALYSIS_MODES has all modes', () => {
  assertEqual(Object.keys(ANALYSIS_MODES).length, 5);
  assert(ANALYSIS_MODES.GENERAL === 'general');
  assert(ANALYSIS_MODES.COMPONENT_TREE === 'component');
  assert(ANALYSIS_MODES.DESIGN_TOKENS === 'tokens');
  assert(ANALYSIS_MODES.COMPARISON === 'comparison');
  assert(ANALYSIS_MODES.FIGMA_FRAME === 'figma');
});

await test('component mode adds instruction', async () => {
  const provider = mockVisionProvider('ok');
  const w = createVisionWorker(provider);
  await w.execute({ image: 'data', mode: ANALYSIS_MODES.COMPONENT_TREE });

  const msgs = provider.calls[0].messages;
  assert(msgs.some(m => m.content && m.content.includes('component hierarchy')));
});

await test('design tokens mode adds instruction', async () => {
  const provider = mockVisionProvider('ok');
  const w = createVisionWorker(provider);
  await w.execute({ image: 'data', mode: ANALYSIS_MODES.DESIGN_TOKENS });

  const msgs = provider.calls[0].messages;
  assert(msgs.some(m => m.content && m.content.includes('design tokens')));
});

await test('comparison mode includes both images', async () => {
  const provider = mockVisionProvider('ok');
  const w = createVisionWorker(provider);
  await w.execute({
    image: 'before-image',
    comparisonImage: 'after-image',
    mode: ANALYSIS_MODES.COMPARISON,
  });

  const msgs = provider.calls[0].messages;
  const userMsg = msgs.find(m => m.role === 'user');
  const imageContents = userMsg.content.filter(c => c.type === 'image');
  assertEqual(imageContents.length, 2);
});

await test('figma mode adds instruction', async () => {
  const provider = mockVisionProvider('ok');
  const w = createVisionWorker(provider);
  await w.execute({ image: 'data', mode: ANALYSIS_MODES.FIGMA_FRAME });

  const msgs = provider.calls[0].messages;
  assert(msgs.some(m => m.content && m.content.includes('Figma')));
});

// ─── buildVisionMessages ────────────────────────────────────────────────

console.log('\n── buildVisionMessages ──');

test('includes system prompt', () => {
  const msgs = buildVisionMessages({ image: 'data' }, {}, 'Analyze.', 'general');
  assertEqual(msgs[0].role, 'system');
  assertEqual(msgs[0].content, 'Analyze.');
});

test('includes image in user message', () => {
  const msgs = buildVisionMessages({ image: 'base64data' }, {}, 'sys', 'general');
  const userMsg = msgs.find(m => m.role === 'user');
  assert(Array.isArray(userMsg.content));
  assert(userMsg.content.some(c => c.type === 'image'));
});

test('includes text query', () => {
  const msgs = buildVisionMessages({ image: 'data', query: 'What is this?' }, {}, 'sys', 'general');
  const userMsg = msgs.find(m => m.role === 'user');
  assert(userMsg.content.some(c => c.type === 'text' && c.text === 'What is this?'));
});

test('includes taste block', () => {
  const msgs = buildVisionMessages({ image: 'data' }, { taste_block: 'Prefers minimal.' }, 'sys', 'general');
  assert(msgs.some(m => m.content && m.content.includes('Prefers minimal.')));
});

test('default query when none provided', () => {
  const msgs = buildVisionMessages({ image: 'data' }, {}, 'sys', 'general');
  const userMsg = msgs.find(m => m.role === 'user');
  assert(userMsg.content.some(c => c.type === 'text' && c.text === 'Analyze this image.'));
});

// ─── parseAnalysis ──────────────────────────────────────────────────────

console.log('\n── parseAnalysis ──');

test('extracts hex colors', () => {
  const a = parseAnalysis('Colors: #ff0000, #00ff00, #0000ff', 'general');
  assert(a.colors.includes('#ff0000'));
  assert(a.colors.includes('#00ff00'));
  assertEqual(a.colors.length, 3);
});

test('deduplicates colors', () => {
  const a = parseAnalysis('#aaa and #aaa again', 'general');
  assertEqual(a.colors.length, 1);
});

test('extracts pixel values', () => {
  const a = parseAnalysis('Padding: 8px, margin: 16px, gap: 8px', 'general');
  assert(a.spacingValues.includes('8px'));
  assert(a.spacingValues.includes('16px'));
});

test('extracts component names', () => {
  const a = parseAnalysis('Contains a Button, a Card, and a Modal component', 'general');
  assert(a.components.includes('button'));
  assert(a.components.includes('card'));
  assert(a.components.includes('modal'));
});

test('extracts font references', () => {
  const a = parseAnalysis('font-family: Inter\nfont-size: 14px\nfont-weight: 600', 'general');
  assert(a.fontReferences.length > 0);
});

test('handles null content', () => {
  const a = parseAnalysis(null, 'general');
  assertEqual(a.structured, false);
});

test('handles empty content', () => {
  const a = parseAnalysis('', 'general');
  assertEqual(a.structured, false);
});

// ─── Metrics ────────────────────────────────────────────────────────────

console.log('\n── Metrics ──');

await test('tracks single calls', async () => {
  const w = createVisionWorker(mockVisionProvider('ok'));
  await w.execute({ image: 'data', message: 'test' });
  assertEqual(w.getMetrics().calls, 1);
});

await test('tracks batch as single execute', async () => {
  const w = createVisionWorker(mockVisionProvider('ok'));
  await w.execute({ frames: ['a', 'b', 'c'], message: 'test' });
  // createBaseWorker tracks the outer execute call, not inner provider calls
  assertEqual(w.getMetrics().calls, 1);
});

await test('health stays healthy', async () => {
  const w = createVisionWorker(mockVisionProvider('ok'));
  await w.execute({ image: 'data', message: 'test' });
  assertEqual(w.getHealth().status, WORKER_STATES.HEALTHY);
});

// ─── Summary ────────────────────────────────────────────────────────────

await new Promise(r => setTimeout(r, 100));
console.log(`\n${'─'.repeat(60)}`);
console.log(`VisionWorker: ${passCount}/${testCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
