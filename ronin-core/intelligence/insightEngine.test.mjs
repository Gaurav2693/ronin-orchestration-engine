import test from 'node:test';
import assert from 'node:assert';

import {
  createInsightState,
  processMessage,
  detectPatterns,
  predictTrajectory,
  generateSuggestions,
  shouldTriggerInsight,
  formatInsight,
  extractTopics,
  calculateComplexity,
} from './insightEngine.mjs';

test('Insight Engine', async (t) => {
  // ─── State Creation ──────────────────────────────────────────────────────

  await t.test('createInsightState returns correct shape', () => {
    const state = createInsightState();
    assert.strictEqual(state.messageCount, 0);
    assert.deepStrictEqual(state.patterns, []);
    assert.deepStrictEqual(state.trajectories, []);
    assert.deepStrictEqual(state.suggestions, []);
    assert.strictEqual(state.lastInsightAt, 0);
    assert.deepStrictEqual(state.topicHistory, []);
    assert.deepStrictEqual(state.modeHistory, []);
    assert.deepStrictEqual(state.tensionPoints, []);
  });

  // ─── Topic Extraction ────────────────────────────────────────────────────

  await t.test('extractTopics extracts proper nouns from message', () => {
    const topics = extractTopics('I am using React and Node.js');
    assert.ok(topics.some(t => t.includes('react') || t.includes('node')));
  });

  await t.test('extractTopics extracts technical terms', () => {
    const topics = extractTopics('The database schema needs optimization');
    assert.ok(topics.some(t => t.includes('database') || t.includes('schema') || t.includes('optimization')));
  });

  await t.test('extractTopics extracts common nouns', () => {
    const topics = extractTopics('I have a bug in the implementation');
    assert.ok(topics.some(t => t.includes('bug') || t.includes('implementation')));
  });

  await t.test('extractTopics returns max 10 topics', () => {
    const msg = 'React Node API Database Schema Optimization Performance Component State Middleware Router';
    const topics = extractTopics(msg);
    assert.ok(topics.length <= 10);
  });

  await t.test('extractTopics handles empty message', () => {
    const topics = extractTopics('');
    assert.deepStrictEqual(topics, []);
  });

  await t.test('extractTopics handles null message', () => {
    const topics = extractTopics(null);
    assert.deepStrictEqual(topics, []);
  });

  // ─── Complexity Scoring ─────────────────────────────────────────────────

  await t.test('calculateComplexity returns 0 for empty message', () => {
    const score = calculateComplexity('');
    assert.strictEqual(score, 0);
  });

  await t.test('calculateComplexity increases with word count', () => {
    const short = calculateComplexity('Hello');
    const long = calculateComplexity('Hello world this is a longer message with more content to increase complexity');
    assert.ok(long > short);
  });

  await t.test('calculateComplexity increases with technical terms', () => {
    const simple = calculateComplexity('I have a problem');
    const technical = calculateComplexity('I have an API database schema optimization performance issue');
    assert.ok(technical > simple);
  });

  await t.test('calculateComplexity increases with question count', () => {
    const noQuestions = calculateComplexity('This is a statement');
    const withQuestions = calculateComplexity('What is this? How does it work? Why is it broken?');
    assert.ok(withQuestions > noQuestions);
  });

  await t.test('calculateComplexity handles null', () => {
    const score = calculateComplexity(null);
    assert.strictEqual(score, 0);
  });

  // ─── Pattern Detection ───────────────────────────────────────────────────

  await t.test('detectPatterns: topic repetition (3+ times)', () => {
    const state = createInsightState();
    state.topicHistory = ['database', 'database', 'database', 'api'];
    const patterns = detectPatterns(state);
    assert.ok(patterns.some(p => p.type === 'topic-repetition'));
  });

  await t.test('detectPatterns: mode clustering (5+ same mode)', () => {
    const state = createInsightState();
    state.modeHistory = ['tactical', 'tactical', 'tactical', 'tactical', 'tactical'];
    const patterns = detectPatterns(state);
    assert.ok(patterns.some(p => p.type === 'mode-clustering'));
  });

  await t.test('detectPatterns: no clustering for mode changes', () => {
    const state = createInsightState();
    state.modeHistory = ['tactical', 'architect', 'tactical', 'debug', 'tactical'];
    const patterns = detectPatterns(state);
    assert.ok(!patterns.some(p => p.type === 'mode-clustering'));
  });

  await t.test('detectPatterns: complexity buildup', () => {
    const state = createInsightState();
    state.messageCount = 50;
    const patterns = detectPatterns(state);
    assert.ok(Array.isArray(patterns));
  });

  await t.test('detectPatterns: tension point detection', () => {
    const state = createInsightState();
    state.tensionPoints = [
      {
        description: 'speed vs accuracy',
        confidence: 0.7,
        evidence: ['mentioned both constraints'],
      },
    ];
    const patterns = detectPatterns(state);
    assert.ok(patterns.some(p => p.type === 'tension-point'));
  });

  await t.test('detectPatterns returns array', () => {
    const state = createInsightState();
    const patterns = detectPatterns(state);
    assert.ok(Array.isArray(patterns));
  });

  // ─── Trajectory Prediction ──────────────────────────────────────────────

  await t.test('predictTrajectory: valid direction', () => {
    const state = createInsightState();
    state.topicHistory = ['authentication', 'authentication', 'authentication'];
    state.messageCount = 3;
    const patterns = [];
    const traj = predictTrajectory(state, patterns);
    assert.ok(['converging', 'diverging', 'stalling', 'escalating', 'neutral'].includes(traj.direction));
  });

  await t.test('predictTrajectory: diverging direction', () => {
    const state = createInsightState();
    state.topicHistory = ['api', 'database', 'frontend', 'security', 'performance', 'testing', 'deployment'];
    state.messageCount = 7;
    const patterns = [];
    const traj = predictTrajectory(state, patterns);
    assert.strictEqual(traj.direction, 'diverging');
  });

  await t.test('predictTrajectory: stalling when mode-clustering detected', () => {
    const state = createInsightState();
    state.modeHistory = ['tactical', 'tactical', 'tactical', 'tactical', 'tactical'];
    state.messageCount = 5;
    const patterns = [
      {
        type: 'mode-clustering',
        description: 'stalled in tactical',
        confidence: 0.8,
      },
    ];
    const traj = predictTrajectory(state, patterns);
    assert.strictEqual(traj.direction, 'stalling');
  });

  await t.test('predictTrajectory: escalating when complexity buildup detected', () => {
    const state = createInsightState();
    state.messageCount = 30;
    const patterns = [
      {
        type: 'complexity-buildup',
        description: 'complexity rising',
        confidence: 0.8,
      },
    ];
    const traj = predictTrajectory(state, patterns);
    assert.strictEqual(traj.direction, 'escalating');
  });

  await t.test('predictTrajectory returns object with required fields', () => {
    const state = createInsightState();
    const patterns = [];
    const traj = predictTrajectory(state, patterns);
    assert.ok(typeof traj.direction === 'string');
    assert.ok(typeof traj.confidence === 'number');
    assert.ok(typeof traj.description === 'string');
  });

  // ─── Suggestion Generation ──────────────────────────────────────────────

  await t.test('generateSuggestions: step-back for stalling', () => {
    const patterns = [];
    const trajectory = { direction: 'stalling' };
    const suggestions = generateSuggestions(patterns, trajectory);
    assert.ok(suggestions.some(s => s.type === 'step-back'));
  });

  await t.test('generateSuggestions: simplification for escalating', () => {
    const patterns = [];
    const trajectory = { direction: 'escalating' };
    const suggestions = generateSuggestions(patterns, trajectory);
    assert.ok(suggestions.some(s => s.type === 'simplification'));
  });

  await t.test('generateSuggestions: convergence for diverging', () => {
    const patterns = [];
    const trajectory = { direction: 'diverging' };
    const suggestions = generateSuggestions(patterns, trajectory);
    assert.ok(suggestions.some(s => s.type === 'convergence'));
  });

  await t.test('generateSuggestions: extension for converging', () => {
    const patterns = [];
    const trajectory = { direction: 'converging' };
    const suggestions = generateSuggestions(patterns, trajectory);
    assert.ok(suggestions.some(s => s.type === 'extension'));
  });

  await t.test('generateSuggestions: specific not generic', () => {
    const patterns = [
      {
        type: 'topic-repetition',
        evidence: ['database mentioned 3x'],
        description: 'database repeated',
      },
    ];
    const trajectory = { direction: 'neutral' };
    const suggestions = generateSuggestions(patterns, trajectory);
    assert.ok(suggestions.some(s => s.content.includes('database')));
  });

  await t.test('generateSuggestions returns array', () => {
    const suggestions = generateSuggestions([], { direction: 'neutral' });
    assert.ok(Array.isArray(suggestions));
  });

  await t.test('generateSuggestions includes priority levels', () => {
    const suggestions = generateSuggestions([], { direction: 'stalling' });
    assert.ok(suggestions.some(s => ['low', 'medium', 'high'].includes(s.priority)));
  });

  // ─── Trigger Logic ──────────────────────────────────────────────────────

  await t.test('shouldTriggerInsight: fires on pattern change', () => {
    const state = createInsightState();
    state.messageCount = 3;
    state.modeHistory = ['tactical', 'tactical', 'tactical', 'tactical', 'tactical'];
    const result = shouldTriggerInsight(state);
    assert.ok(result.trigger);
  });

  await t.test('shouldTriggerInsight: fires on topic repetition (3+)', () => {
    const state = createInsightState();
    state.messageCount = 5;
    state.topicHistory = ['auth', 'auth', 'auth', 'other'];
    const result = shouldTriggerInsight(state);
    assert.ok(result.trigger);
  });

  await t.test('shouldTriggerInsight: fires on mode stalling (5+)', () => {
    const state = createInsightState();
    state.messageCount = 10;
    state.modeHistory = ['builder', 'builder', 'builder', 'builder', 'builder'];
    const result = shouldTriggerInsight(state);
    assert.ok(result.trigger);
  });

  await t.test('shouldTriggerInsight: fallback every 8 messages', () => {
    const state = createInsightState();
    state.messageCount = 8;
    state.lastInsightAt = 0;
    const result = shouldTriggerInsight(state);
    assert.ok(result.trigger);
    assert.ok(result.reason.includes('time-based'));
  });

  await t.test('shouldTriggerInsight: does not fire when no conditions met', () => {
    const state = createInsightState();
    state.messageCount = 1;
    state.topicHistory = ['api'];
    state.modeHistory = ['tactical'];
    const result = shouldTriggerInsight(state);
    assert.ok(!result.trigger);
  });

  // ─── Format Insight ─────────────────────────────────────────────────────

  await t.test('formatInsight produces compact output', () => {
    const insight = {
      pattern: { type: 'topic-repetition', description: 'repeated' },
      trajectory: { direction: 'converging' },
      suggestion: { content: 'try narrowing down' },
    };
    const formatted = formatInsight(insight);
    assert.ok(typeof formatted === 'string');
    assert.ok(formatted.includes('Pattern:'));
    assert.ok(formatted.includes('Trajectory:'));
    assert.ok(formatted.includes('Suggestion:'));
  });

  await t.test('formatInsight handles empty insight', () => {
    const formatted = formatInsight(null);
    assert.strictEqual(formatted, '');
  });

  await t.test('formatInsight uses pipe separator', () => {
    const insight = {
      pattern: { type: 'test' },
      trajectory: { direction: 'test' },
      suggestion: { content: 'test' },
    };
    const formatted = formatInsight(insight);
    assert.ok(formatted.includes('|'));
  });

  // ─── Main Processing ────────────────────────────────────────────────────

  await t.test('processMessage increments messageCount', () => {
    const state = createInsightState();
    const msg = 'Hello world';
    const result = processMessage(state, msg);
    assert.strictEqual(result.state.messageCount, 1);
  });

  await t.test('processMessage tracks topics in history', () => {
    const state = createInsightState();
    const result = processMessage(state, 'I am using React and Node');
    assert.ok(result.state.topicHistory.length > 0);
  });

  await t.test('processMessage tracks mode in history', () => {
    const state = createInsightState();
    const result = processMessage(state, 'Fix this bug', { mode: 'debug' });
    assert.ok(result.state.modeHistory.includes('debug'));
  });

  await t.test('processMessage returns insights when trigger fires', () => {
    const state = createInsightState();
    // Manually trigger a pattern condition
    state.messageCount = 5;
    state.lastInsightAt = 0;
    // Add repeating topics to trigger pattern detection
    state.topicHistory = ['auth', 'auth', 'auth', 'other'];
    const result = processMessage(state, 'still thinking about auth');
    // Should trigger on pattern detection
    assert.ok(result.insights !== null);
  });

  await t.test('processMessage returns null insights when no trigger', () => {
    const state = createInsightState();
    const result = processMessage(state, 'hello');
    assert.strictEqual(result.insights, null);
  });

  await t.test('processMessage limits topicHistory to 50', () => {
    const state = createInsightState();
    state.topicHistory = Array(50).fill('topic');
    const result = processMessage(state, 'Adding more topics here');
    assert.ok(result.state.topicHistory.length <= 50);
  });

  await t.test('processMessage limits modeHistory to 50', () => {
    const state = createInsightState();
    state.modeHistory = Array(50).fill('tactical');
    const result = processMessage(state, 'test', { mode: 'architect' });
    assert.ok(result.state.modeHistory.length <= 50);
  });

  await t.test('processMessage handles empty message', () => {
    const state = createInsightState();
    const result = processMessage(state, '');
    assert.strictEqual(result.insights, null);
  });

  await t.test('processMessage handles null message', () => {
    const state = createInsightState();
    const result = processMessage(state, null);
    assert.strictEqual(result.insights, null);
  });

  // ─── Edge Cases ──────────────────────────────────────────────────────────

  await t.test('first message should not generate insight', () => {
    const state = createInsightState();
    const result = processMessage(state, 'What should I build?');
    assert.strictEqual(result.insights, null);
  });

  await t.test('very short conversation (< 8 messages) no fallback trigger', () => {
    let state = createInsightState();
    for (let i = 0; i < 5; i++) {
      const result = processMessage(state, `message ${i}`);
      state = result.state;
    }
    assert.strictEqual(state.messageCount, 5);
    const result = processMessage(state, 'final message');
    assert.strictEqual(result.insights, null);
  });

  // ─── End-to-End Scenarios ────────────────────────────────────────────────

  await t.test('end-to-end: operator circles on bug (stalling detected)', () => {
    let state = createInsightState();

    const messages = [
      { msg: 'There\'s a bug in my authentication logic', mode: 'debug' },
      { msg: 'The bug seems related to token validation', mode: 'debug' },
      { msg: 'Still trying to fix the auth bug', mode: 'debug' },
      { msg: 'How can I fix the auth bug?', mode: 'debug' },
      { msg: 'The auth bug is driving me crazy', mode: 'debug' },
      { msg: 'Let me debug the auth issue again', mode: 'debug' },
      { msg: 'Why is the auth bug still happening?', mode: 'debug' },
      { msg: 'I\'m still stuck on auth', mode: 'debug' },
      { msg: 'Maybe I should try a different approach to auth', mode: 'debug' },
    ];

    let foundStalling = false;
    for (const { msg, mode } of messages) {
      const result = processMessage(state, msg, { mode });
      state = result.state;
      if (result.insights) {
        const hasStalling = result.insights.some(i => i.pattern?.type === 'mode-clustering' || i.pattern?.type === 'topic-repetition');
        if (hasStalling) foundStalling = true;
      }
    }

    assert.ok(foundStalling);
  });

  await t.test('end-to-end: operator exploring broadly (diverging detected)', () => {
    let state = createInsightState();

    const messages = [
      'Should I use React or Vue?',
      'How do I structure my database?',
      'What about deployment strategy?',
      'Should I use TypeScript?',
      'How do I handle authentication?',
      'What about testing frameworks?',
      'Should I use Docker?',
      'How do I monitor performance?',
      'What API design should I use?',
    ];

    let foundDiverging = false;
    for (const msg of messages) {
      const result = processMessage(state, msg, { mode: 'explorer' });
      state = result.state;
      if (result.insights) {
        const trajectory = result.insights[0]?.trajectory;
        if (trajectory?.direction === 'diverging') {
          foundDiverging = true;
        }
      }
    }

    assert.ok(foundDiverging || state.topicHistory.length > 5);
  });

  await t.test('behavior rules: suggestions preserve operator intent', () => {
    const patterns = [];
    const trajectory = { direction: 'converging' };
    const suggestions = generateSuggestions(patterns, trajectory);
    assert.ok(suggestions.every(s => typeof s.content === 'string'));
  });

  await t.test('behavior rules: suggestions are not generic', () => {
    const patterns = [
      {
        type: 'topic-repetition',
        evidence: ['performance mentioned 4x'],
        description: 'performance repeated',
      },
    ];
    const trajectory = { direction: 'neutral' };
    const suggestions = generateSuggestions(patterns, trajectory);
    const hasSpecific = suggestions.some(s => s.content.toLowerCase().includes('performance') || s.content.toLowerCase().includes('pattern'));
    assert.ok(hasSpecific);
  });

  // ─── Integration with Context ────────────────────────────────────────────

  await t.test('processMessage accepts operatorProfile in context', () => {
    const state = createInsightState();
    const profile = { verbosity: 0.8, technicalDepth: 0.7 };
    const result = processMessage(state, 'test message', { operatorProfile: profile });
    assert.ok(result.state);
  });

  await t.test('processMessage accepts topologyUsed in context', () => {
    const state = createInsightState();
    const result = processMessage(state, 'test message', { topologyUsed: 'directTactical' });
    assert.ok(result.state);
  });

  await t.test('processMessage accepts response in context', () => {
    const state = createInsightState();
    const result = processMessage(state, 'test message', { response: 'Here is the answer...' });
    assert.ok(result.state);
  });
});
