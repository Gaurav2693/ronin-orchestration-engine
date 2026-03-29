// ─── intelligence/critic.test.mjs ─────────────────────────────────────────────
// 55+ comprehensive tests for the V6 Critic Layer
// ─────────────────────────────────────────────────────────────────────────────

import {
  DIMENSIONS,
  critique,
  scoreIdentityFidelity,
  scoreHallucinationRisk,
  scoreEpistemicDiscipline,
  scoreOperatorFit,
  scoreStructuralClarity,
  scoreUsefulness,
  detectFailureSignals,
  getCriticPromptFragment,
} from './critic.mjs';

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

console.log('\n─── V6: Critic Layer — Definition of Done ───\n');

// ════════════════════════════════════════════════════════════════════════════
// DIMENSIONS Constant (5 tests)
// ════════════════════════════════════════════════════════════════════════════
console.log('DIMENSIONS configuration:');
{
  const keys = Object.keys(DIMENSIONS);
  assert(keys.length === 6, 'has 6 dimensions');
  assert(keys.includes('identityFidelity'), 'includes identityFidelity');
  assert(keys.includes('hallucinationRisk'), 'includes hallucinationRisk');
  assert(keys.includes('epistemicDiscipline'), 'includes epistemicDiscipline');
  assert(keys.includes('operatorFit'), 'includes operatorFit');
  assert(keys.includes('structuralClarity'), 'includes structuralClarity');
  assert(keys.includes('usefulness'), 'includes usefulness');
}

console.log('\nDimension weights:');
{
  const sum = Object.values(DIMENSIONS).reduce((acc, d) => acc + d.weight, 0);
  assert(Math.abs(sum - 1.0) < 0.001, `weights sum to 1.0 (actual: ${sum})`);
  assert(DIMENSIONS.identityFidelity.weight === 0.25, 'identityFidelity: 0.25');
  assert(DIMENSIONS.hallucinationRisk.weight === 0.20, 'hallucinationRisk: 0.20');
  assert(DIMENSIONS.epistemicDiscipline.weight === 0.15, 'epistemicDiscipline: 0.15');
  assert(DIMENSIONS.operatorFit.weight === 0.15, 'operatorFit: 0.15');
  assert(DIMENSIONS.structuralClarity.weight === 0.15, 'structuralClarity: 0.15');
  assert(DIMENSIONS.usefulness.weight === 0.10, 'usefulness: 0.10');
}

// ════════════════════════════════════════════════════════════════════════════
// scoreIdentityFidelity (8 tests)
// ════════════════════════════════════════════════════════════════════════════
console.log('\nscoreIdentityFidelity:');
{
  const result = scoreIdentityFidelity('Test response');
  assert(typeof result === 'object', 'returns object');
  assert(typeof result.score === 'number', 'has score property');
  assert(Array.isArray(result.issues), 'has issues array');

  const cleanResult = scoreIdentityFidelity('Your component re-renders because the dependency array is missing.');
  assert(cleanResult.score > 0.8, 'scores clean RONIN response high');
  assert(cleanResult.issues.length === 0, 'no issues for clean response');

  const badResult = scoreIdentityFidelity('I\'d be happy to help you with that.');
  assert(badResult.score < 0.9, 'scores assistant tone lower');
  assert(badResult.issues.length > 0, 'detects assistant phrases');

  const result2 = scoreIdentityFidelity('x');
  assert(result2.score >= 0 && result2.score <= 1, 'score is bounded [0, 1]');
}

// ════════════════════════════════════════════════════════════════════════════
// scoreHallucinationRisk (7 tests)
// ════════════════════════════════════════════════════════════════════════════
console.log('\nscoreHallucinationRisk:');
{
  const result = scoreHallucinationRisk('Test response');
  assert(typeof result === 'object', 'returns object');
  assert(typeof result.score === 'number', 'has score property');

  const absolute = scoreHallucinationRisk('This always fails and never works correctly.');
  assert(absolute.score < 0.9, 'penalizes absolute claims');

  const hedged = scoreHallucinationRisk('This might fail, and could have issues.');
  assert(hedged.score > 0.6, 'rewards hedged responses');

  const unknown = scoreHallucinationRisk('I don\'t know the exact reason, but here\'s what I think.');
  assert(unknown.score > 0.75, 'rewards acknowledgment of unknowns');

  const definitive = scoreHallucinationRisk('This definitely is the solution and will absolutely work.');
  assert(definitive.score < 0.9, 'penalizes definitive statements');

  const result2 = scoreHallucinationRisk('x');
  assert(result2.score >= 0 && result2.score <= 1, 'score is bounded [0, 1]');
}

// ════════════════════════════════════════════════════════════════════════════
// scoreEpistemicDiscipline (6 tests)
// ════════════════════════════════════════════════════════════════════════════
console.log('\nscoreEpistemicDiscipline:');
{
  const result = scoreEpistemicDiscipline('Test response');
  assert(typeof result === 'object', 'returns object');
  assert(typeof result.score === 'number', 'has score property');

  const hedging = scoreEpistemicDiscipline('This might indicate that the issue could be related to the API.');
  assert(hedging.score > 0.5, 'boosts score for hedging');

  const unknown = scoreEpistemicDiscipline('I don\'t know for certain, but the pattern suggests...');
  assert(unknown.score > 0.6, 'boosts score for acknowledging unknowns');

  const inference = scoreEpistemicDiscipline('This clearly proves that your implementation is flawed.');
  assert(inference.score < 0.5, 'penalizes inference as fact');

  const result2 = scoreEpistemicDiscipline('x');
  assert(result2.score >= 0 && result2.score <= 1, 'score is bounded [0, 1]');
}

// ════════════════════════════════════════════════════════════════════════════
// scoreOperatorFit (7 tests)
// ════════════════════════════════════════════════════════════════════════════
console.log('\nscoreOperatorFit:');
{
  const result = scoreOperatorFit('Test response', null);
  assert(typeof result === 'object', 'returns object');
  assert(typeof result.score === 'number', 'has score property');

  const noProfile = scoreOperatorFit('Some response', null);
  assert(noProfile.score >= 0.65 && noProfile.score <= 0.75, 'defaults around 0.7');

  const verboseOp = scoreOperatorFit('word '.repeat(400), { dimensions: { verbosity: 0.2 } });
  assert(verboseOp.score < 0.8, 'penalizes verbose for terse operator');

  const terseOp = scoreOperatorFit('No.', { dimensions: { verbosity: 0.8 } });
  assert(terseOp.score < 0.8, 'penalizes brief for verbose operator');

  const structured = scoreOperatorFit('# Section\n- item 1\n```code```', { dimensions: { responseFormat: 0.8 } });
  assert(structured.score > 0.65, 'scores structured response well for structured operator');

  const result2 = scoreOperatorFit('x', {});
  assert(result2.score >= 0 && result2.score <= 1, 'score is bounded [0, 1]');
}

// ════════════════════════════════════════════════════════════════════════════
// scoreStructuralClarity (7 tests)
// ════════════════════════════════════════════════════════════════════════════
console.log('\nscoreStructuralClarity:');
{
  const result = scoreStructuralClarity('Test response');
  assert(typeof result === 'object', 'returns object');
  assert(typeof result.score === 'number', 'has score property');

  const short = scoreStructuralClarity('Short, clear response.');
  assert(short.score > 0.9, 'scores short response well');

  const longPara = 'word '.repeat(300);
  const longResult = scoreStructuralClarity(longPara);
  assert(longResult.score < 0.9, 'penalizes very long paragraphs');

  const badHeadings = scoreStructuralClarity('# Level 1\n### Level 3\n## Level 2');
  assert(badHeadings.score < 0.95, 'penalizes inconsistent heading levels');

  const goodStructure = scoreStructuralClarity('# Section\nParagraph here.\n## Subsection\n```js\ncode\n```');
  assert(goodStructure.score > 0.9, 'scores well-structured response highly');

  const result2 = scoreStructuralClarity('x');
  assert(result2.score >= 0 && result2.score <= 1, 'score is bounded [0, 1]');
}

// ════════════════════════════════════════════════════════════════════════════
// scoreUsefulness (8 tests)
// ════════════════════════════════════════════════════════════════════════════
console.log('\nscoreUsefulness:');
{
  const result = scoreUsefulness('Test response', 'Test question');
  assert(typeof result === 'object', 'returns object');
  assert(typeof result.score === 'number', 'has score property');

  const overlap = scoreUsefulness(
    'Your useEffect has a missing dependency. Add items to the array and it will stop re-rendering.',
    'Why does my useEffect run every render?'
  );
  assert(overlap.score > 0.6, `boosts score with keyword overlap: ${overlap.score}`);

  const noOverlap = scoreUsefulness(
    'The weather is nice today',
    'How do I implement authentication?'
  );
  assert(noOverlap.score < 0.5, 'penalizes low keyword overlap');

  const withCode = scoreUsefulness(
    'You should organize your code into functions. Here\'s an example: const x = 1; function test() { return x; }. This keeps your code modular.',
    'How do I structure my JavaScript code?'
  );
  assert(withCode.score > 0.5, `rewards code in technical question: ${withCode.score}`);

  const tooShort = scoreUsefulness(
    'OK',
    'This is a long and detailed question about architecture'
  );
  assert(tooShort.score < 0.5, 'penalizes very brief response');

  const result2 = scoreUsefulness('x', 'y');
  assert(result2.score >= 0 && result2.score <= 1, 'score is bounded [0, 1]');
}

// ════════════════════════════════════════════════════════════════════════════
// detectFailureSignals (9 tests)
// ════════════════════════════════════════════════════════════════════════════
console.log('\ndetectFailureSignals:');
{
  const result = detectFailureSignals('Test response');
  assert(Array.isArray(result), 'returns array');

  const assistant = detectFailureSignals('As an AI, I\'d be happy to help you with this.');
  assert(assistant.some(s => s.toLowerCase().includes('assistant')), 'detects assistant-like tone');

  const enthusiastic = detectFailureSignals('Great question!!! This is amazing!!!');
  assert(enthusiastic.length > 0, 'detects excessive enthusiasm');

  const certain = detectFailureSignals('This will always work and never fail.');
  assert(certain.length > 0, 'detects unsupported certainty');

  const generic = detectFailureSignals('In conclusion, to summarize, we can see...');
  assert(generic.length > 0, 'detects generic phrasing');

  const longText = 'word '.repeat(200);
  const loss = detectFailureSignals(longText);
  assert(loss.length > 0, 'detects loss of structure');

  const clean = detectFailureSignals('Your function has a bug in error handling.');
  assert(clean.length === 0, 'detects no signals in clean response');

  const multi = detectFailureSignals('As an AI, I\'d be happy!!! In conclusion...');
  assert(multi.length > 1, 'detects multiple signals');
}

// ════════════════════════════════════════════════════════════════════════════
// critique (main function) (15 tests)
// ════════════════════════════════════════════════════════════════════════════
console.log('\ncrituque function:');
{
  const result = critique('Test response', {});
  assert(typeof result === 'object', 'returns object');
  assert(typeof result.pass === 'boolean', 'has pass property');
  assert(typeof result.score === 'number', 'has score property');
  assert(typeof result.dimensions === 'object', 'has dimensions object');
  assert(Array.isArray(result.failureSignals), 'has failureSignals array');
  assert(Array.isArray(result.suggestions), 'has suggestions array');

  assert(result.dimensions.identityFidelity !== undefined, 'has identityFidelity dimension');
  assert(result.dimensions.hallucinationRisk !== undefined, 'has hallucinationRisk dimension');
  assert(result.dimensions.epistemicDiscipline !== undefined, 'has epistemicDiscipline dimension');
  assert(result.dimensions.operatorFit !== undefined, 'has operatorFit dimension');
  assert(result.dimensions.structuralClarity !== undefined, 'has structuralClarity dimension');
  assert(result.dimensions.usefulness !== undefined, 'has usefulness dimension');

  for (const dim of Object.values(result.dimensions)) {
    assert(typeof dim.score === 'number' && typeof dim.weight === 'number' && Array.isArray(dim.issues), 'each dimension has score, weight, issues');
  }
}

console.log('\ncrituque pass/fail decisions:');
{
  const goodResponse = critique('Your component re-renders because of a missing dependency. Add items to the array.', {
    operatorMessage: 'Why does my component re-render?',
  });
  assert(goodResponse.pass === true, 'high-quality response passes (score >= 0.65)');
  assert(goodResponse.score >= 0.65, 'good response scores >= 0.65');

  const badResponse = critique('I\'d be happy to help you with this great question! In conclusion, here\'s the answer: it\'s amazing!!!', {
    operatorMessage: 'What is this?',
  });
  assert(badResponse.pass === false, 'chatbot-style response fails');
  assert(badResponse.score < 0.65, 'bad response scores < 0.65');
}

console.log('\ncrituque scoring accuracy:');
{
  const result = critique('Test response', {});
  let calculated = 0;
  for (const [, dim] of Object.entries(result.dimensions)) {
    calculated += dim.score * dim.weight;
  }
  calculated = Math.round(calculated * 100) / 100;
  assert(result.score === calculated, `weighted score calculation is correct (${result.score} === ${calculated})`);

  const result2 = critique('x', {});
  assert(result2.score >= 0 && result2.score <= 1, 'score is bounded [0, 1]');
}

console.log('\ncrituque edge cases:');
{
  const empty = critique('', {});
  assert(empty.pass === false, 'empty response fails');
  assert(empty.score === 0, 'empty response scores 0');

  const veryLong = 'word '.repeat(10000);
  const longResult = critique(veryLong, {});
  assert(typeof longResult.score === 'number', 'handles very long response');
  assert(longResult.score >= 0 && longResult.score <= 1, 'very long response score is valid');

  const codeOnly = '```javascript\nconst x = 1;\nreturn x;\n```';
  const codeResult = critique(codeOnly, { operatorMessage: 'How do I write this in JavaScript?' });
  assert(codeResult.score > 0, 'code-only response scores above 0');
}

console.log('\ncrituque end-to-end scenarios:');
{
  const chatgpt = 'Great question! I\'d be happy to help you with this. As an AI language model, I should note that in conclusion, this is a fantastic inquiry!';
  const cgResult = critique(chatgpt, {});
  assert(cgResult.pass === false, 'ChatGPT-style response fails');
  assert(cgResult.score < 0.65, 'ChatGPT-style scores below threshold');
  assert(cgResult.failureSignals.length > 0, 'ChatGPT-style triggers failure signals');

  const ronin = 'The issue is in your selector. It\'s matching too broadly because the regex lacks anchors. Change /form/ to /^form$/ and the problem disappears.';
  const rResult = critique(ronin, { operatorMessage: 'My selector is matching the wrong elements' });
  assert(rResult.pass === true, 'clean RONIN response passes');
  assert(rResult.score >= 0.65, 'RONIN response scores >= 0.65');
}

// ════════════════════════════════════════════════════════════════════════════
// getCriticPromptFragment (3 tests)
// ════════════════════════════════════════════════════════════════════════════
console.log('\ngetCriticPromptFragment:');
{
  const fragment = getCriticPromptFragment();
  assert(typeof fragment === 'string', 'returns string');
  assert(fragment.length > 50, 'contains meaningful content');
  assert(fragment.toLowerCase().includes('ronin') || fragment.toLowerCase().includes('sound'), 'mentions key themes');
}

// ════════════════════════════════════════════════════════════════════════════
// Consistency tests (3 tests)
// ════════════════════════════════════════════════════════════════════════════
console.log('\nDeterministic scoring:');
{
  const response = 'Direct answer here.';
  const context = { operatorMessage: 'How?' };

  const result1 = critique(response, context);
  const result2 = critique(response, context);
  assert(result1.score === result2.score, 'same response scores consistently');
  assert(result1.pass === result2.pass, 'pass/fail decision is consistent');
}

// ════════════════════════════════════════════════════════════════════════════
// Summary
// ════════════════════════════════════════════════════════════════════════════

console.log('\n' + '─'.repeat(70));
console.log(`Total: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);

if (failed === 0) {
  console.log('✓ All tests passed!');
  process.exit(0);
} else {
  console.log(`✗ ${failed} test(s) failed`);
  process.exit(1);
}
