// test/visionPipeline.test.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Tests for Gate 03: Vision Pipeline
// ─────────────────────────────────────────────────────────────────────────────

import {
  createDesignTokens,
  mergeDesignTokens,
  parseTokensFromAnalysis,
  runVisionPipeline,
} from '../gates/visionPipeline.mjs';

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

// ─── Mock workers ─────────────────────────────────────────────────────────────

function makeVisionWorker(options = {}) {
  let callCount = 0;
  return {
    get callCount() { return callCount; },
    async execute(task) {
      callCount++;
      if (options.fail) throw new Error('Vision worker failed');
      return {
        result: options.response || `Analyzed frame. Colors: #FF0000, #0000FF. Font: Inter. Spacing: 16px. Components: Button, Card.`,
        cost:   0.001,
      };
    },
  };
}

function makeSynthesizer(options = {}) {
  let callCount = 0;
  return {
    get callCount() { return callCount; },
    async execute(payload) {
      callCount++;
      if (options.fail) throw new Error('Synthesizer failed');
      return {
        result: options.response || 'Design Interpretation Document: minimal, dark-themed UI with Inter typography.',
        cost:   0.002,
      };
    },
  };
}

const SAMPLE_FRAMES = [
  { id: 'frame_1', name: 'Home', imageBase64: 'base64data1', context: 'Home screen' },
  { id: 'frame_2', name: 'Settings', imageBase64: 'base64data2', context: 'Settings panel' },
];

console.log('\n─── visionPipeline.test.mjs ─────────────────────────────\n');

// ─── createDesignTokens ───────────────────────────────────────────────────────

console.log('createDesignTokens:');

await testAsync('returns empty token scaffold', async () => {
  const tokens = createDesignTokens();
  assert(Array.isArray(tokens.colors), 'colors should be array');
  assert(Array.isArray(tokens.typography), 'typography should be array');
  assert(Array.isArray(tokens.spacing), 'spacing should be array');
  assert(Array.isArray(tokens.radii), 'radii should be array');
  assert(Array.isArray(tokens.shadows), 'shadows should be array');
  assert(Array.isArray(tokens.components), 'components should be array');
});

// ─── parseTokensFromAnalysis ──────────────────────────────────────────────────

console.log('\nparseTokensFromAnalysis:');

await testAsync('extracts hex colors', async () => {
  const tokens = parseTokensFromAnalysis('Primary color is #FF0000 and secondary is #00FF00');
  assert(tokens.colors.length >= 2, `expected >= 2 colors, got ${tokens.colors.length}`);
  assert(tokens.colors.some(c => c.hex === '#FF0000'), 'should find #FF0000');
  assert(tokens.colors.some(c => c.hex === '#00FF00'), 'should find #00FF00');
});

await testAsync('deduplicates hex colors', async () => {
  const tokens = parseTokensFromAnalysis('#FF0000 is used here and #FF0000 is also used there');
  const count  = tokens.colors.filter(c => c.hex === '#FF0000').length;
  assertEqual(count, 1, 'should deduplicate');
});

await testAsync('extracts px spacing values', async () => {
  const tokens = parseTokensFromAnalysis('padding: 16px, margin: 24px, gap: 8px');
  assert(tokens.spacing.length >= 3, `expected >= 3 spacing values, got ${tokens.spacing.length}`);
});

await testAsync('filters out extreme px values (< 4 or > 200)', async () => {
  const tokens = parseTokensFromAnalysis('size: 2px, huge: 500px, normal: 16px');
  assert(!tokens.spacing.some(s => s.value === '2px'), 'should filter 2px');
  assert(!tokens.spacing.some(s => s.value === '500px'), 'should filter 500px');
  assert(tokens.spacing.some(s => s.value === '16px'), 'should keep 16px');
});

await testAsync('extracts font families', async () => {
  const tokens = parseTokensFromAnalysis('font-family: Inter, sans-serif. The heading uses "Geist Mono".');
  assert(tokens.typography.length >= 1, `expected >= 1 font, got ${tokens.typography.length}`);
});

await testAsync('extracts known component names', async () => {
  const tokens = parseTokensFromAnalysis('The Button component uses a Card layout with a Modal overlay.');
  assert(tokens.components.some(c => c.name === 'Button'), 'should find Button');
  assert(tokens.components.some(c => c.name === 'Card'), 'should find Card');
  assert(tokens.components.some(c => c.name === 'Modal'), 'should find Modal');
});

await testAsync('returns empty tokens for empty input', async () => {
  const tokens = parseTokensFromAnalysis('');
  assertEqual(tokens.colors.length, 0, 'no colors');
});

await testAsync('handles null input gracefully', async () => {
  const tokens = parseTokensFromAnalysis(null);
  assertEqual(tokens.colors.length, 0, 'no colors for null');
});

// ─── mergeDesignTokens ────────────────────────────────────────────────────────

console.log('\nmergeDesignTokens:');

await testAsync('merges colors from two sets', async () => {
  const set1 = { ...createDesignTokens(), colors: [{ hex: '#FF0000', usage: 'primary' }] };
  const set2 = { ...createDesignTokens(), colors: [{ hex: '#0000FF', usage: 'secondary' }] };
  const merged = mergeDesignTokens([set1, set2]);
  assert(merged.colors.length === 2, `expected 2 colors, got ${merged.colors.length}`);
});

await testAsync('deduplicates by hex value', async () => {
  const set1 = { ...createDesignTokens(), colors: [{ hex: '#FF0000', usage: 'primary' }] };
  const set2 = { ...createDesignTokens(), colors: [{ hex: '#FF0000', usage: 'accent' }] };
  const merged = mergeDesignTokens([set1, set2]);
  assertEqual(merged.colors.length, 1, 'should deduplicate same hex');
});

await testAsync('deduplicates by name', async () => {
  const set1 = { ...createDesignTokens(), typography: [{ family: 'Inter', role: 'body' }] };
  const set2 = { ...createDesignTokens(), typography: [{ family: 'Inter', role: 'heading' }] };
  const merged = mergeDesignTokens([set1, set2]);
  assertEqual(merged.typography.filter(t => t.family === 'Inter').length, 1, 'deduplicate Inter');
});

await testAsync('handles null token sets gracefully', async () => {
  const set1 = { ...createDesignTokens(), colors: [{ hex: '#FF0000' }] };
  const merged = mergeDesignTokens([set1, null, undefined]);
  assertEqual(merged.colors.length, 1, 'should skip null/undefined sets');
});

// ─── runVisionPipeline ────────────────────────────────────────────────────────

console.log('\nrunVisionPipeline:');

await testAsync('throws on empty frames array', async () => {
  try {
    await runVisionPipeline([], makeVisionWorker(), makeSynthesizer());
    assert(false, 'Should have thrown');
  } catch (err) {
    assert(err.message.includes('figmaFrames'));
  }
});

await testAsync('throws if visionWorker has no execute()', async () => {
  try {
    await runVisionPipeline(SAMPLE_FRAMES, {}, makeSynthesizer());
    assert(false, 'Should have thrown');
  } catch (err) {
    assert(err.message.includes('visionWorker'));
  }
});

await testAsync('throws if synthesizer has no execute()', async () => {
  try {
    await runVisionPipeline(SAMPLE_FRAMES, makeVisionWorker(), {});
    assert(false, 'Should have thrown');
  } catch (err) {
    assert(err.message.includes('synthesizer'));
  }
});

await testAsync('returns interpretations array', async () => {
  const worker = makeVisionWorker();
  const synth  = makeSynthesizer();
  const result = await runVisionPipeline(SAMPLE_FRAMES, worker, synth);
  assert(Array.isArray(result.interpretations), 'interpretations should be array');
  assertEqual(result.interpretations.length, 2, 'should have 2 interpretations for 2 frames');
});

await testAsync('analyzes all frames in parallel (calls worker N times)', async () => {
  const worker = makeVisionWorker({ delay: 0 });
  const synth  = makeSynthesizer();
  await runVisionPipeline(SAMPLE_FRAMES, worker, synth);
  assertEqual(worker.callCount, 2, 'should call visionWorker once per frame');
});

await testAsync('calls synthesizer exactly once', async () => {
  const worker = makeVisionWorker();
  const synth  = makeSynthesizer();
  await runVisionPipeline(SAMPLE_FRAMES, worker, synth);
  assertEqual(synth.callCount, 1, 'synthesizer should be called once');
});

await testAsync('returns merged design tokens', async () => {
  const worker = makeVisionWorker();
  const synth  = makeSynthesizer();
  const result = await runVisionPipeline(SAMPLE_FRAMES, worker, synth);
  assert(result.designTokens, 'should have designTokens');
  assert(Array.isArray(result.designTokens.colors), 'colors should be array');
  assert(result.designTokens.colors.length > 0, 'should extract colors from mock analysis');
});

await testAsync('returns synthesizedDocument string', async () => {
  const worker = makeVisionWorker();
  const synth  = makeSynthesizer();
  const result = await runVisionPipeline(SAMPLE_FRAMES, worker, synth);
  assert(typeof result.synthesizedDocument === 'string', 'synthesizedDocument should be string');
  assert(result.synthesizedDocument.length > 0, 'should not be empty');
});

await testAsync('returns meta with cost and duration', async () => {
  const worker = makeVisionWorker();
  const synth  = makeSynthesizer();
  const result = await runVisionPipeline(SAMPLE_FRAMES, worker, synth);
  assert(result.meta, 'should have meta');
  assertEqual(result.meta.framesTotal, 2, 'framesTotal');
  assert(typeof result.meta.totalCost === 'number', 'totalCost should be number');
});

await testAsync('handles frame analysis failure gracefully', async () => {
  const failWorker = makeVisionWorker({ fail: true });
  const synth      = makeSynthesizer();
  const result     = await runVisionPipeline(SAMPLE_FRAMES, failWorker, synth);
  // Should not throw — failed frames get error annotations
  assertEqual(result.interpretations.length, 2, 'still returns 2 interpretations');
  assert(result.interpretations.every(i => i.error === true), 'all should have error flag');
  assertEqual(result.meta.framesFailed, 2, 'framesFailed should be 2');
});

await testAsync('handles synthesis failure gracefully', async () => {
  const worker    = makeVisionWorker();
  const failSynth = makeSynthesizer({ fail: true });
  const result    = await runVisionPipeline(SAMPLE_FRAMES, worker, failSynth);
  assert(result.synthesizedDocument.includes('failed') || result.synthesizedDocument.length > 0,
    'should return fallback document');
});

await testAsync('injects tasteProfile into synthesis prompt', async () => {
  const worker      = makeVisionWorker();
  let synthPrompt   = null;
  const spySynth = {
    async execute(payload) {
      synthPrompt = payload.messages[0]?.content || '';
      return { result: 'synthesis done', cost: 0 };
    },
  };
  const tasteProfile = { style: 'minimal', darkMode: true };
  await runVisionPipeline(SAMPLE_FRAMES, worker, spySynth, tasteProfile);
  assert(synthPrompt.includes('minimal') || synthPrompt.includes('darkMode'), 'taste profile injected');
});

// ─── Single frame ─────────────────────────────────────────────────────────────

console.log('\nSingle frame:');

await testAsync('works with a single frame', async () => {
  const worker = makeVisionWorker();
  const synth  = makeSynthesizer();
  const result = await runVisionPipeline([SAMPLE_FRAMES[0]], worker, synth);
  assertEqual(result.meta.framesTotal, 1, 'framesTotal should be 1');
  assertEqual(result.interpretations.length, 1, 'one interpretation');
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n─── Results: ${passed} passed, ${failed} failed ───\n`);
process.exit(failed > 0 ? 1 : 0);
