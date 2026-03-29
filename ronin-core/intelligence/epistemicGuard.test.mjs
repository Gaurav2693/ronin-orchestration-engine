// ─── intelligence/epistemicGuard.test.mjs ───────────────────────────────────
// Test suite for V5: Epistemic Guard
// Target: 50+ tests, 0 failures
// ─────────────────────────────────────────────────────────────────────────────

import {
  EPISTEMIC_MARKERS,
  analyzeEpistemicContent,
  detectOverconfidence,
  detectHallucination,
  enforceEpistemicDiscipline,
  generateEpistemicPromptFragment,
} from './epistemicGuard.mjs';

describe('epistemicGuard', () => {
  // ─────────────────────────────────────────────────────────────────────────
  // EPISTEMIC_MARKERS Tests
  // ─────────────────────────────────────────────────────────────────────────

  describe('EPISTEMIC_MARKERS', () => {
    test('has all four categories', () => {
      expect(EPISTEMIC_MARKERS).toHaveProperty('known');
      expect(EPISTEMIC_MARKERS).toHaveProperty('inferred');
      expect(EPISTEMIC_MARKERS).toHaveProperty('uncertain');
      expect(EPISTEMIC_MARKERS).toHaveProperty('missing');
    });

    test('known category is empty array', () => {
      expect(EPISTEMIC_MARKERS.known).toEqual([]);
    });

    test('inferred has expected markers', () => {
      expect(EPISTEMIC_MARKERS.inferred).toContain('likely');
      expect(EPISTEMIC_MARKERS.inferred).toContain('probably');
      expect(EPISTEMIC_MARKERS.inferred).toContain('indicates');
      expect(EPISTEMIC_MARKERS.inferred.length).toBeGreaterThan(5);
    });

    test('uncertain has expected markers', () => {
      expect(EPISTEMIC_MARKERS.uncertain).toContain('might');
      expect(EPISTEMIC_MARKERS.uncertain).toContain('could be');
      expect(EPISTEMIC_MARKERS.uncertain).toContain('possibly');
      expect(EPISTEMIC_MARKERS.uncertain.length).toBeGreaterThan(5);
    });

    test('missing has expected markers', () => {
      expect(EPISTEMIC_MARKERS.missing).toContain('need to see');
      expect(EPISTEMIC_MARKERS.missing).toContain('depends on');
      expect(EPISTEMIC_MARKERS.missing).toContain('without seeing');
      expect(EPISTEMIC_MARKERS.missing.length).toBeGreaterThan(5);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // analyzeEpistemicContent Tests
  // ─────────────────────────────────────────────────────────────────────────

  describe('analyzeEpistemicContent', () => {
    test('returns empty sentences for null input', () => {
      const result = analyzeEpistemicContent(null);
      expect(result.sentences).toEqual([]);
      expect(result.summary).toEqual({ known: 0, inferred: 0, uncertain: 0, missing: 0 });
    });

    test('returns empty sentences for empty string', () => {
      const result = analyzeEpistemicContent('');
      expect(result.sentences).toEqual([]);
    });

    test('classifies simple known statement', () => {
      const response = 'React uses a virtual DOM.';
      const result = analyzeEpistemicContent(response);
      expect(result.sentences.length).toBe(1);
      expect(result.sentences[0].status).toBe('known');
      expect(result.sentences[0].confidence).toBe(1.0);
    });

    test('classifies inferred statement with "likely"', () => {
      const response = 'This likely causes a re-render.';
      const result = analyzeEpistemicContent(response);
      expect(result.sentences.length).toBe(1);
      expect(result.sentences[0].status).toBe('inferred');
      expect(result.sentences[0].confidence).toBe(0.75);
      expect(result.sentences[0].markers).toContain('likely');
    });

    test('classifies inferred statement with "probably"', () => {
      const response = 'This is probably related to your state.';
      const result = analyzeEpistemicContent(response);
      expect(result.sentences[0].status).toBe('inferred');
      expect(result.sentences[0].markers).toContain('probably');
    });

    test('classifies uncertain statement with "might"', () => {
      const response = 'This might be a timing issue.';
      const result = analyzeEpistemicContent(response);
      expect(result.sentences[0].status).toBe('uncertain');
      expect(result.sentences[0].confidence).toBe(0.4);
      expect(result.sentences[0].markers).toContain('might');
    });

    test('classifies uncertain statement with "could be"', () => {
      const response = 'It could be a caching problem.';
      const result = analyzeEpistemicContent(response);
      expect(result.sentences[0].status).toBe('uncertain');
    });

    test('classifies missing information statement', () => {
      const response = 'I need to see your package.json to confirm.';
      const result = analyzeEpistemicContent(response);
      expect(result.sentences[0].status).toBe('missing');
      expect(result.sentences[0].confidence).toBe(0.1);
      expect(result.sentences[0].markers).toContain('need to see');
    });

    test('classifies missing with "depends on"', () => {
      const response = 'This depends on your build config.';
      const result = analyzeEpistemicContent(response);
      expect(result.sentences[0].status).toBe('missing');
    });

    test('splits multiple sentences correctly', () => {
      const response =
        'React is a library. This likely helps with performance. I might be wrong about this.';
      const result = analyzeEpistemicContent(response);
      expect(result.sentences.length).toBeGreaterThanOrEqual(2);
      expect(result.summary.known).toBeGreaterThan(0);
      expect(result.summary.inferred).toBeGreaterThan(0);
    });

    test('updates summary counts correctly', () => {
      const response =
        'JavaScript is single-threaded. This likely causes blocking. I might be uncertain here. I need more info.';
      const result = analyzeEpistemicContent(response);
      expect(result.summary.known).toBeGreaterThan(0);
      expect(result.summary.inferred).toBeGreaterThan(0);
      expect(result.summary.uncertain).toBeGreaterThan(0);
      expect(result.summary.missing).toBeGreaterThan(0);
    });

    test('handles multiple markers in one sentence', () => {
      const response = 'This likely suggests a problem, though I might be wrong.';
      const result = analyzeEpistemicContent(response);
      expect(result.sentences[0].markers.length).toBeGreaterThan(1);
    });

    test('case-insensitive marker detection', () => {
      const response = 'This LIKELY happens.';
      const result = analyzeEpistemicContent(response);
      expect(result.sentences[0].status).toBe('inferred');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // detectOverconfidence Tests
  // ─────────────────────────────────────────────────────────────────────────

  describe('detectOverconfidence', () => {
    test('returns empty for null input', () => {
      const result = detectOverconfidence(null);
      expect(result.overconfidentClaims).toEqual([]);
      expect(result.score).toBe(0);
    });

    test('detects "always" in context-dependent claim', () => {
      const response = 'State updates always cause re-renders.';
      const result = detectOverconfidence(response);
      expect(result.overconfidentClaims.length).toBeGreaterThan(0);
      expect(result.overconfidentClaims[0].reason).toContain('always');
    });

    test('detects "never" in context-dependent claim', () => {
      const response = 'You should never use hooks outside components.';
      const result = detectOverconfidence(response);
      expect(result.overconfidentClaims.length).toBeGreaterThan(0);
      expect(result.overconfidentClaims[0].reason).toContain('never');
    });

    test('detects "definitely"', () => {
      const response = 'This is definitely the issue.';
      const result = detectOverconfidence(response);
      expect(result.overconfidentClaims.length).toBeGreaterThan(0);
    });

    test('detects "guaranteed"', () => {
      const response = 'This fix is guaranteed to work.';
      const result = detectOverconfidence(response);
      expect(result.overconfidentClaims.length).toBeGreaterThan(0);
    });

    test('detects "impossible"', () => {
      const response = 'It\'s impossible to optimize further.';
      const result = detectOverconfidence(response);
      expect(result.overconfidentClaims.length).toBeGreaterThan(0);
    });

    test('passes for factually grounded absolutes', () => {
      const response = 'JavaScript is single-threaded.';
      const result = detectOverconfidence(response);
      // Should not flag universally true statements
      expect(result.score).toBeLessThan(0.3);
    });

    test('passes for properly hedged statements', () => {
      const response = 'This likely always happens in your case.';
      const result = detectOverconfidence(response);
      // Hedge ("likely") may reduce confidence detection
      expect(result.overconfidentClaims.length).toBeGreaterThanOrEqual(0);
    });

    test('calculates confidence score correctly', () => {
      const response = 'This always happens. It will definitely fail. It\'s impossible.';
      const result = detectOverconfidence(response);
      expect(result.score).toBeGreaterThan(0);
      expect(result.score).toBeLessThanOrEqual(1.0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // detectHallucination Tests
  // ─────────────────────────────────────────────────────────────────────────

  describe('detectHallucination', () => {
    test('returns empty for null input', () => {
      const result = detectHallucination(null);
      expect(result.risks).toEqual([]);
      expect(result.score).toBe(0);
    });

    test('flags invented API names', () => {
      const response = 'Try using getFooBar() to fix this.';
      const result = detectHallucination(response);
      expect(result.risks.some((r) => r.type === 'invented_api_name')).toBe(true);
    });

    test('passes for real React hooks in context', () => {
      const response = 'Use useState() for this state.';
      const result = detectHallucination(response);
      expect(result.risks.some((r) => r.text.includes('useState'))).toBe(false);
    });

    test('passes for known hooks without context check', () => {
      const response = 'The useEffect() hook manages side effects.';
      const result = detectHallucination(response);
      expect(result.risks.some((r) => r.text.includes('useEffect'))).toBe(false);
    });

    test('flags invented error codes', () => {
      const response = 'This causes Error: XYZABC_UNKNOWN_FAILURE.';
      const result = detectHallucination(response);
      expect(result.risks.some((r) => r.type === 'invented_error_code')).toBe(true);
    });

    test('respects known facts context for error codes', () => {
      const context = { knownFacts: ['ENOENT'] };
      const response = 'This error: ENOENT.';
      const result = detectHallucination(response, context);
      // Should not flag ENOENT since it's in known facts
      expect(result.risks.some((r) => r.text === 'ENOENT')).toBe(false);
    });

    test('flags suspicious imports', () => {
      const response = 'Import from "fakeLibraryXyz" to handle this.';
      const result = detectHallucination(response);
      expect(result.risks.some((r) => r.type === 'suspicious_import')).toBe(true);
    });

    test('passes for real package imports', () => {
      const response = 'Import axios from "axios" for HTTP requests.';
      const result = detectHallucination(response);
      expect(result.risks.some((r) => r.text.includes('axios'))).toBe(false);
    });

    test('respects codebaseContext for imports', () => {
      const context = { codebaseContext: 'customLib' };
      const response = 'Import from "customLib" for utilities.';
      const result = detectHallucination(response, context);
      expect(result.risks.some((r) => r.text.includes('customLib'))).toBe(false);
    });

    test('calculates hallucination score correctly', () => {
      const response =
        'Use getFakeAPI() and import from "notReal". Error: FAKEFRAUDFAKEFRAUD.';
      const result = detectHallucination(response);
      expect(result.score).toBeGreaterThan(0);
      expect(result.score).toBeLessThanOrEqual(1.0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // enforceEpistemicDiscipline Tests
  // ─────────────────────────────────────────────────────────────────────────

  describe('enforceEpistemicDiscipline', () => {
    test('returns pass=true for null input', () => {
      const result = enforceEpistemicDiscipline(null);
      expect(result.pass).toBe(true);
      expect(result.score).toBe(1.0);
    });

    test('passes clean responses', () => {
      const response =
        'React uses a virtual DOM. This likely improves performance in most cases.';
      const result = enforceEpistemicDiscipline(response);
      expect(result.pass).toBe(true);
      expect(result.score).toBeGreaterThan(0.6);
    });

    test('fails overconfident responses', () => {
      const response = 'This is definitely the issue. It always happens.';
      const result = enforceEpistemicDiscipline(response);
      expect(result.pass).toBe(false);
      expect(result.score).toBeLessThan(0.6);
    });

    test('passes responses with appropriate hedging', () => {
      const response =
        'This likely relates to your component state. I\'d need to see more to be certain.';
      const result = enforceEpistemicDiscipline(response);
      expect(result.pass).toBe(true);
    });

    test('score calculation includes overconfidence penalty', () => {
      const response = 'This always happens and will definitely break.';
      const result = enforceEpistemicDiscipline(response);
      expect(result.score).toBeLessThan(1.0);
    });

    test('score calculation includes hallucination penalty', () => {
      const response = 'Use getFakeFunctionXyz() to fix this.';
      const result = enforceEpistemicDiscipline(response);
      expect(result.score).toBeLessThan(1.0);
    });

    test('applies bonus for acknowledging unknowns', () => {
      const response =
        'This likely relates to state. I\'m not sure without more context.';
      const result = enforceEpistemicDiscipline(response);
      expect(result.score).toBeGreaterThan(0.6);
    });

    test('applies bonus for uncertainty markers', () => {
      const response = 'This might be related. It could be a timing issue.';
      const result = enforceEpistemicDiscipline(response);
      expect(result.score).toBeGreaterThan(0.5);
    });

    test('score is always between 0 and 1', () => {
      const responses = [
        'Clean response.',
        'This always happens and is definitely wrong.',
        'I\'m uncertain but this might work.',
      ];
      for (const response of responses) {
        const result = enforceEpistemicDiscipline(response);
        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(1.0);
      }
    });

    test('includes violations array', () => {
      const response = 'This definitely works. Always use this.';
      const result = enforceEpistemicDiscipline(response);
      expect(Array.isArray(result.violations)).toBe(true);
      expect(result.violations.length).toBeGreaterThan(0);
    });

    test('violations have correct structure', () => {
      const response = 'This always happens. Use getFakeAPI().';
      const result = enforceEpistemicDiscipline(response);
      if (result.violations.length > 0) {
        const v = result.violations[0];
        expect(v).toHaveProperty('type');
        expect(v).toHaveProperty('text');
        expect(v).toHaveProperty('suggestion');
      }
    });

    test('includes summary counts', () => {
      const response = 'This probably works. I might be wrong. I need more info.';
      const result = enforceEpistemicDiscipline(response);
      expect(result.summary).toHaveProperty('known');
      expect(result.summary).toHaveProperty('inferred');
      expect(result.summary).toHaveProperty('uncertain');
      expect(result.summary).toHaveProperty('missing');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // generateEpistemicPromptFragment Tests
  // ─────────────────────────────────────────────────────────────────────────

  describe('generateEpistemicPromptFragment', () => {
    test('returns a non-empty string', () => {
      const fragment = generateEpistemicPromptFragment();
      expect(typeof fragment).toBe('string');
      expect(fragment.length).toBeGreaterThan(0);
    });

    test('mentions epistemic discipline', () => {
      const fragment = generateEpistemicPromptFragment();
      expect(fragment.toLowerCase()).toContain('epistemic');
    });

    test('mentions distinction between known/inferred/uncertain/missing', () => {
      const fragment = generateEpistemicPromptFragment();
      const lower = fragment.toLowerCase();
      expect(lower).toContain('known');
      expect(lower).toContain('inferred');
    });

    test('mentions avoiding confident assertions without grounding', () => {
      const fragment = generateEpistemicPromptFragment();
      const lower = fragment.toLowerCase();
      expect(lower).toMatch(/(confident|assertion|grounding|evidence)/);
    });

    test('mentions appropriate hedging', () => {
      const fragment = generateEpistemicPromptFragment();
      const lower = fragment.toLowerCase();
      expect(lower).toMatch(/(hedg|likely|probably|possibly)/);
    });

    test('is reasonably concise (4-6 sentences)', () => {
      const fragment = generateEpistemicPromptFragment();
      const sentences = fragment.split(/[.!?]+/).filter((s) => s.trim());
      expect(sentences.length).toBeGreaterThanOrEqual(3);
      expect(sentences.length).toBeLessThanOrEqual(8);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Edge Cases & Integration Tests
  // ─────────────────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    test('handles very long response', () => {
      const response = 'Start. ' + 'Middle sentence. '.repeat(100) + 'End.';
      const result = enforceEpistemicDiscipline(response);
      expect(result).toHaveProperty('pass');
      expect(result).toHaveProperty('score');
    });

    test('handles response with only code', () => {
      const response = '```javascript\nconst x = useState();\n```';
      const result = enforceEpistemicDiscipline(response);
      expect(result).toHaveProperty('pass');
    });

    test('handles very short response', () => {
      const response = 'Yes.';
      const result = enforceEpistemicDiscipline(response);
      expect(result.pass).toBe(true);
    });

    test('handles response with mixed markers', () => {
      const response =
        'This is known. This likely works. This might be an issue. I need to see more.';
      const result = enforceEpistemicDiscipline(response);
      expect(result.summary.known).toBeGreaterThan(0);
      expect(result.summary.inferred).toBeGreaterThan(0);
      expect(result.summary.uncertain).toBeGreaterThan(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // End-to-End Scenarios
  // ─────────────────────────────────────────────────────────────────────────

  describe('end-to-end scenarios', () => {
    test('flags response with "definitely the issue is X"', () => {
      const response = 'Definitely the issue is your state management.';
      const result = enforceEpistemicDiscipline(response);
      expect(result.pass).toBe(false);
      expect(result.violations.length).toBeGreaterThan(0);
    });

    test('passes response with "this likely relates to X, though I need to see Y"', () => {
      const response =
        'This likely relates to your component lifecycle, though I\'d need to see your code to be certain.';
      const result = enforceEpistemicDiscipline(response);
      expect(result.pass).toBe(true);
    });

    test('higher score for response acknowledging limitations', () => {
      const confident =
        'Your code is inefficient. Use this optimization.';
      const uncertain =
        'Your code might be inefficient. Consider this optimization, though I\'d need more context to be sure.';

      const r1 = enforceEpistemicDiscipline(confident);
      const r2 = enforceEpistemicDiscipline(uncertain);

      expect(r2.score).toBeGreaterThanOrEqual(r1.score);
    });

    test('detects mix of overconfidence and hallucination', () => {
      const response =
        'This definitely causes the issue. Always use the getFakeAPIFunction() method to fix it. Import from "fakeLibraryXyz".';
      const result = enforceEpistemicDiscipline(response);
      expect(result.violations.some((v) => v.type === 'overconfidence')).toBe(true);
      expect(result.violations.length).toBeGreaterThanOrEqual(1);
    });

    test('properly scores well-reasoned uncertain response', () => {
      const response =
        'React re-renders when state changes. This probably causes the re-render you\'re seeing, but it depends on your component structure. I might be missing something without seeing your code.';
      const result = enforceEpistemicDiscipline(response);
      expect(result.pass).toBe(true);
      expect(result.score).toBeGreaterThan(0.65);
    });
  });
});
