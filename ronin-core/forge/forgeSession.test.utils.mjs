// ─── forge/forgeSession.test.utils.mjs ────────────────────────────────────
// Test utilities for forgeSession
// ──────────────────────────────────────────────────────────────────────────

export function createMockProvider() {
  return {
    chat: async (messages, options) => {
      // Return a mock response
      return {
        output: 'Mock response to: ' + messages[messages.length - 1]?.content,
        response: 'Mock response to: ' + messages[messages.length - 1]?.content,
        toolCalls: [],
        costUsd: 0.001,
        steps: [],
      };
    },
    // For agentWorker compatibility
    complete: async (messages, options) => {
      const userMessage = messages.find(m => m.role === 'user');
      return {
        content: 'Mock response to: ' + userMessage?.content,
        toolCalls: [],
        usage: {
          inputTokens: 10,
          outputTokens: 20,
        },
      };
    },
  };
}

export function createErrorProvider() {
  return {
    chat: async () => {
      throw new Error('Provider error');
    },
    complete: async () => {
      throw new Error('Provider error');
    },
  };
}

export function createApprovalProvider() {
  return {
    chat: async (messages, options) => {
      // Return a response that needs approval
      if (messages[messages.length - 1]?.content.includes('protected')) {
        return {
          approvalNeeded: true,
          protectedFile: 'intelligence/test.mjs',
          proposedChange: 'new code',
          output: 'Needs approval',
        };
      }
      return {
        output: 'Mock response',
        response: 'Mock response',
        toolCalls: [],
        costUsd: 0.001,
      };
    },
    complete: async (messages, options) => {
      const userMessage = messages.find(m => m.role === 'user');
      if (userMessage?.content.includes('protected')) {
        return {
          content: 'Needs approval',
          toolCalls: [],
          usage: { inputTokens: 10, outputTokens: 20 },
        };
      }
      return {
        content: 'Mock response',
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 20 },
      };
    },
  };
}

export function createSlowProvider(delayMs = 100) {
  return {
    chat: async (messages, options) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return {
        output: 'Delayed response',
        response: 'Delayed response',
        toolCalls: [],
        costUsd: 0.001,
      };
    },
    complete: async (messages, options) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return {
        content: 'Delayed response',
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 20 },
      };
    },
  };
}
