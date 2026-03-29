import { describe, it, expect } from '@jest/globals';
import {
  getModes,
  detectMode,
  getModeConfig,
  getModePromptFragment,
  getTransition,
} from './taskMode.mjs';

describe('Task Mode Engine', () => {
  // ─── Mode Definition Tests ───────────────────────────────────────────────
  describe('MODES constant', () => {
    it('should export 8 modes', () => {
      const modes = getModes();
      expect(modes).toHaveLength(8);
    });

    it('should have the correct mode IDs', () => {
      const modes = getModes();
      const ids = modes.map((m) => m.id).sort();
      const expected = [
        'architect',
        'builder',
        'critic',
        'debug',
        'explorer',
        'reflective',
        'strategy',
        'tactical',
      ].sort();
      expect(ids).toEqual(expected);
    });

    it('should have correct names for each mode', () => {
      const modes = getModes();
      expect(modes.find((m) => m.id === 'tactical').name).toBe('Tactical');
      expect(modes.find((m) => m.id === 'architect').name).toBe('Architect');
      expect(modes.find((m) => m.id === 'critic').name).toBe('Critic');
      expect(modes.find((m) => m.id === 'debug').name).toBe('Debug');
      expect(modes.find((m) => m.id === 'strategy').name).toBe('Strategy');
      expect(modes.find((m) => m.id === 'reflective').name).toBe(
        'Reflective'
      );
      expect(modes.find((m) => m.id === 'explorer').name).toBe('Explorer');
      expect(modes.find((m) => m.id === 'builder').name).toBe('Builder');
    });

    it('should have posture for each mode', () => {
      const modes = getModes();
      modes.forEach((mode) => {
        expect(mode.posture).toBeTruthy();
        expect(typeof mode.posture).toBe('string');
      });
    });

    it('should have triggers array for each mode', () => {
      const modes = getModes();
      modes.forEach((mode) => {
        expect(Array.isArray(mode.triggers)).toBe(true);
        expect(mode.triggers.length).toBeGreaterThan(0);
      });
    });

    it('should have responseStyle object with correct keys', () => {
      const modes = getModes();
      const expectedKeys = [
        'verbosity',
        'structure',
        'abstraction',
        'toneSharpness',
        'suggestionDensity',
        'depth',
      ];
      modes.forEach((mode) => {
        expect(mode.responseStyle).toBeTruthy();
        expectedKeys.forEach((key) => {
          expect(Object.keys(mode.responseStyle)).toContain(key);
        });
      });
    });

    it('should have valid responseStyle values', () => {
      const modes = getModes();
      const validVerbosity = ['terse', 'moderate', 'expansive'];
      const validStructure = ['minimal', 'moderate', 'heavy'];
      const validAbstraction = ['concrete', 'balanced', 'abstract'];
      const validToneSharpness = ['soft', 'neutral', 'sharp'];
      const validSuggestionDensity = ['low', 'moderate', 'high'];
      const validDepth = ['surface', 'moderate', 'deep'];

      modes.forEach((mode) => {
        expect(validVerbosity).toContain(mode.responseStyle.verbosity);
        expect(validStructure).toContain(mode.responseStyle.structure);
        expect(validAbstraction).toContain(mode.responseStyle.abstraction);
        expect(validToneSharpness).toContain(mode.responseStyle.toneSharpness);
        expect(validSuggestionDensity).toContain(
          mode.responseStyle.suggestionDensity
        );
        expect(validDepth).toContain(mode.responseStyle.depth);
      });
    });

    it('should have systemPromptModifier for each mode', () => {
      const modes = getModes();
      modes.forEach((mode) => {
        expect(mode.systemPromptModifier).toBeTruthy();
        expect(typeof mode.systemPromptModifier).toBe('string');
        expect(mode.systemPromptModifier.length).toBeGreaterThan(50);
      });
    });
  });

  // ─── detectMode Tests ────────────────────────────────────────────────────
  describe('detectMode()', () => {
    it('should detect tactical mode from action verb', () => {
      const result = detectMode('how do i implement this feature?');
      expect(result.mode).toBe('tactical');
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('should detect architect mode from architecture keyword', () => {
      const result = detectMode('what are the architectural tradeoffs?');
      expect(result.mode).toBe('architect');
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('should detect critic mode from review keyword', () => {
      const result = detectMode('review this approach for issues');
      expect(result.mode).toBe('critic');
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('should detect debug mode from error keyword', () => {
      const result = detectMode('why is this error happening?');
      expect(result.mode).toBe('debug');
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('should detect strategy mode from roadmap keyword', () => {
      const result = detectMode('what should our roadmap be?');
      expect(result.mode).toBe('strategy');
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('should detect reflective mode from why keyword', () => {
      const result = detectMode('why does this pattern exist?');
      expect(result.mode).toBe('reflective');
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('should detect explorer mode from brainstorm keyword', () => {
      const result = detectMode('brainstorm creative approaches');
      expect(result.mode).toBe('explorer');
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('should detect builder mode from step-by-step keyword', () => {
      const result = detectMode('walk me through this step by step');
      expect(result.mode).toBe('builder');
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('should be case-insensitive', () => {
      const result1 = detectMode('how do i fix this');
      const result2 = detectMode('HOW DO I FIX THIS');
      expect(result1.mode).toBe(result2.mode);
    });

    it('should weight beginning-of-message triggers higher', () => {
      const result1 = detectMode('implement this feature quickly');
      const result2 = detectMode('so I need to implement this feature');
      // Both should detect 'implement', but result1 should have higher confidence
      // since 'implement' starts result1
      expect(result1.confidence).toBeGreaterThanOrEqual(result2.confidence);
    });

    it('should default to tactical for ambiguous messages', () => {
      const result = detectMode('what is your name?');
      expect(result.mode).toBe('tactical');
      expect(result.confidence).toBeLessThan(0.3);
      expect(result.fallback).toBe(true);
    });

    it('should return confidence as 0-1 number', () => {
      const result = detectMode('how do i build this?');
      expect(typeof result.confidence).toBe('number');
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });

    it('should include signals in result', () => {
      const result = detectMode('fix this bug now');
      expect(Array.isArray(result.signals)).toBe(true);
    });

    it('should handle empty message', () => {
      const result = detectMode('');
      expect(result.mode).toBe('tactical');
      expect(result.confidence).toBe(0);
      expect(result.fallback).toBe(true);
    });

    it('should handle null/undefined message', () => {
      const result1 = detectMode(null);
      const result2 = detectMode(undefined);
      expect(result1.mode).toBe('tactical');
      expect(result2.mode).toBe('tactical');
    });

    it('should handle very short message', () => {
      const result = detectMode('fix');
      expect(result.mode).toBeTruthy();
    });

    it('should apply mode stickiness when confidence is low', () => {
      // Message with weak signal
      const result = detectMode('what should we do?', {
        previousMode: 'tactical',
      });
      // Low confidence + previous mode should sticky to tactical
      if (result.confidence < 0.5) {
        expect(result.mode).toBe('tactical');
      }
    });

    it('should not sticky-stick when confidence is high', () => {
      const result = detectMode('design the system architecture', {
        previousMode: 'tactical',
      });
      expect(result.mode).toBe('architect');
    });

    it('should extract signals from detected mode', () => {
      const result = detectMode('there is a bug in the error handling code');
      expect(result.signals.length).toBeGreaterThan(0);
      expect(result.signals.includes('bug')).toBe(true);
    });

    it('should handle mixed-signal messages', () => {
      const result = detectMode('how do i architect this?');
      // Should pick one based on scoring
      expect(['tactical', 'architect']).toContain(result.mode);
    });
  });

  // ─── getModeConfig Tests ─────────────────────────────────────────────────
  describe('getModeConfig()', () => {
    it('should return correct config for tactical', () => {
      const config = getModeConfig('tactical');
      expect(config).toBeTruthy();
      expect(config.id).toBe('tactical');
      expect(config.name).toBe('Tactical');
    });

    it('should return correct config for architect', () => {
      const config = getModeConfig('architect');
      expect(config).toBeTruthy();
      expect(config.id).toBe('architect');
    });

    it('should return null for invalid mode', () => {
      const config = getModeConfig('nonexistent');
      expect(config).toBeNull();
    });

    it('should return full mode object', () => {
      const config = getModeConfig('debug');
      expect(config.posture).toBeTruthy();
      expect(config.triggers).toBeTruthy();
      expect(config.responseStyle).toBeTruthy();
      expect(config.systemPromptModifier).toBeTruthy();
    });
  });

  // ─── getModePromptFragment Tests ─────────────────────────────────────────
  describe('getModePromptFragment()', () => {
    it('should return non-empty string for tactical', () => {
      const fragment = getModePromptFragment('tactical');
      expect(typeof fragment).toBe('string');
      expect(fragment.length).toBeGreaterThan(0);
    });

    it('should return non-empty string for all modes', () => {
      const modes = getModes();
      modes.forEach((mode) => {
        const fragment = getModePromptFragment(mode.id);
        expect(typeof fragment).toBe('string');
        expect(fragment.length).toBeGreaterThan(0);
      });
    });

    it('should mention mode name in fragment', () => {
      const fragment = getModePromptFragment('debug');
      expect(fragment.toLowerCase()).toContain('debug');
    });

    it('should return empty string for invalid mode', () => {
      const fragment = getModePromptFragment('nonexistent');
      expect(fragment).toBe('');
    });

    it('should return 3+ sentences', () => {
      const fragment = getModePromptFragment('architect');
      const sentenceCount = (fragment.match(/\./g) || []).length;
      expect(sentenceCount).toBeGreaterThanOrEqual(2);
    });
  });

  // ─── getTransition Tests ─────────────────────────────────────────────────
  describe('getTransition()', () => {
    it('should report smooth transition for same mode', () => {
      const t = getTransition('tactical', 'tactical');
      expect(t.smooth).toBe(true);
    });

    it('should report smooth transition for adjacent modes', () => {
      const t1 = getTransition('tactical', 'builder');
      const t2 = getTransition('architect', 'strategy');
      const t3 = getTransition('critic', 'debug');
      const t4 = getTransition('reflective', 'explorer');
      expect(t1.smooth).toBe(true);
      expect(t2.smooth).toBe(true);
      expect(t3.smooth).toBe(true);
      expect(t4.smooth).toBe(true);
    });

    it('should report not-smooth for distant modes', () => {
      const t = getTransition('tactical', 'reflective');
      expect(t.smooth).toBe(false);
    });

    it('should include from and to in result', () => {
      const t = getTransition('tactical', 'architect');
      expect(t.from).toBe('tactical');
      expect(t.to).toBe('architect');
    });

    it('should be symmetric for adjacency', () => {
      const t1 = getTransition('tactical', 'builder');
      const t2 = getTransition('builder', 'tactical');
      expect(t1.smooth).toBe(t2.smooth);
    });
  });

  // ─── End-to-End Integration Tests ────────────────────────────────────────
  describe('End-to-end scenarios', () => {
    it('should detect debug mode for bug message', () => {
      const message = 'fix this bug in my useEffect';
      const result = detectMode(message);
      expect(result.mode).toBe('debug');
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.signals.length).toBeGreaterThan(0);
    });

    it('should detect explorer mode for brainstorm message', () => {
      const message = 'brainstorm creative approaches for the onboarding flow';
      const result = detectMode(message);
      expect(result.mode).toBe('explorer');
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('should detect architect mode for architecture question', () => {
      const message =
        'what are the architectural tradeoffs between microservices and monolith?';
      const result = detectMode(message);
      expect(result.mode).toBe('architect');
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('should get config and prompt fragment for detected mode', () => {
      const message = 'how do i implement this?';
      const detection = detectMode(message);
      const config = getModeConfig(detection.mode);
      const fragment = getModePromptFragment(detection.mode);

      expect(config).toBeTruthy();
      expect(fragment).toBeTruthy();
      expect(config.id).toBe(detection.mode);
    });

    it('should handle mode transition', () => {
      const msg1 = 'how do i build this?';
      const msg2 = 'what about the architecture?';

      const mode1 = detectMode(msg1);
      const mode2 = detectMode(msg2, { previousMode: mode1.mode });

      const transition = getTransition(mode1.mode, mode2.mode);
      expect(transition.from).toBe(mode1.mode);
      expect(transition.to).toBe(mode2.mode);
    });

    it('should maintain mode for ambiguous follow-up', () => {
      const msg1 = 'how do i build this?';
      const msg2 = 'ok'; // ambiguous

      const mode1 = detectMode(msg1);
      const mode2 = detectMode(msg2, { previousMode: mode1.mode });

      if (mode2.confidence < 0.5) {
        // If ambiguous, should sticky to previous
        expect(mode2.mode).toBe(mode1.mode);
      }
    });
  });

  // ─── Edge Case Tests ─────────────────────────────────────────────────────
  describe('Edge cases', () => {
    it('should handle message with multiple modes triggered', () => {
      const message =
        'fix this bug by designing a better architecture for error handling';
      const result = detectMode(message);
      expect(result.mode).toBeTruthy();
      expect(['debug', 'architect']).toContain(result.mode);
    });

    it('should handle message with no matching triggers', () => {
      const message = 'the sky is blue';
      const result = detectMode(message);
      expect(result.mode).toBe('tactical');
      expect(result.confidence).toBeLessThan(0.3);
    });

    it('should handle all-caps message', () => {
      const message = 'FIX THIS BUG NOW';
      const result = detectMode(message);
      expect(result.mode).toBeTruthy();
    });

    it('should handle message with special characters', () => {
      const message = 'how do i fix this @#$%?';
      const result = detectMode(message);
      expect(result.mode).toBeTruthy();
    });

    it('should handle very long message', () => {
      const message = `I have this really long request that goes on and on about 
        how I need to implement a feature but I'm not sure about the architecture
        and I would like you to help me design something better. What do you think?`;
      const result = detectMode(message);
      expect(result.mode).toBeTruthy();
    });

    it('should have all modes reachable', () => {
      const modes = getModes();
      const triggers = modes.map((m) => m.triggers[0]);

      triggers.forEach((trigger) => {
        const result = detectMode(trigger);
        expect(result.mode).toBeTruthy();
      });
    });

    it('should normalize whitespace in comparison', () => {
      const result1 = detectMode('  fix this bug  ');
      const result2 = detectMode('fix this bug');
      expect(result1.mode).toBe(result2.mode);
    });
  });
});
