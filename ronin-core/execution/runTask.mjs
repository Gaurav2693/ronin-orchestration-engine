// execution/runTask.mjs
// ─────────────────────────────────────────────────────────────────────────────
// THE CAPSTONE — RONIN's main orchestration loop.
//
// This is where everything comes together. Every operator message passes
// through this function. It coordinates:
//
//   1. Pre-flight   — parallel route + compress
//   2. Cost guard   — can we afford this model?
//   3. Rate limit   — is the provider within quota?
//   4. Thinking     — show UI indicator if model is slow
//   5. Stream       — call provider, push chunks to SSE
//   6. Validate     — check structured output if needed
//   7. Escalate     — retry with next model if validation fails
//   8. Log cost     — record token usage in Redis
//   9. Complete     — send final response to client
//
// The function is designed to be called directly OR as a BullMQ job handler.
// When called as a job handler, it receives a Job object whose `data` contains
// the task payload. When called directly, it receives the payload itself.
//
// Invariants enforced here:
//   - Model identity NEVER reaches the client (no modelId in SSE events)
//   - Escalation chain: groq → gemini_flash → sonnet → throw (Opus never auto)
//   - Cost checked BEFORE every paid model call
//   - Rate limit checked BEFORE every free-tier call
//   - Max 3 escalation attempts before hard failure
// ─────────────────────────────────────────────────────────────────────────────

import { IntelligenceRouter } from '../router/intelligence-router.mjs';
import { ContextCompressor } from '../memory/context-compressor.mjs';
import { getProvider } from '../models/providerRegistry.mjs';
import { schedule } from '../queue/priorityScheduler.mjs';
import { canCall, recordCall } from '../queue/rateLimitGuard.mjs';
import { validateStructured } from '../validation/structuredOutputValidator.mjs';
import {
  sendThinkingState,
  sendStreamChunk,
  sendComplete,
  sendError,
} from '../api/sseController.mjs';
import {
  calculateCost,
  log as logCost,
  canAfford,
  logEscalation,
} from '../observability/costTracker.mjs';
import {
  ESCALATION_CHAIN,
  getModelConfig,
} from '../config/modelConfig.mjs';
import {
  normalizeResponse,
  buildSystemPrompt,
} from '../intelligence/voiceNormalizer.mjs';

// ─── Singletons ─────────────────────────────────────────────────────────────
// Router and compressor are stateless enough to share across all tasks.

const router = new IntelligenceRouter();
const compressor = new ContextCompressor();

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_ESCALATIONS = 3;  // Hard cap — prevents infinite escalation loops

// ─── RONIN System Prompt ────────────────────────────────────────────────────
// Now generated from intelligence/voiceSchema.mjs — the single source of truth.
// Adapted per operator via intelligence/operatorProfile.mjs.
// The old hardcoded 5-liner is replaced by a structured, testable schema.
//
// buildSystemPrompt(operatorId) returns:
//   [voice schema base] + [operator adaptation fragment (if learned)]

// ─── runTask(payload) ───────────────────────────────────────────────────────
// Main entry point. Can be called directly or as a BullMQ job handler.
//
// Payload shape:
//   {
//     conversationId: string,
//     messages: Array<{ role: 'user'|'assistant', content: string }>,
//     userMessage: string | { role: 'user', content: string },
//     context: {
//       hasImage?: boolean,
//       directorFlag?: boolean,
//       conversationTokens?: number,
//       taskType?: string,           // for structured validation
//     }
//   }
//
// Returns: { response: string, costUsd: number, modelId: string }
// (modelId is for internal logging only — NEVER sent to client)

export async function runTask(payload) {
  // If called as BullMQ job handler, unwrap the Job object
  const data = payload?.data ?? payload;

  const {
    conversationId,
    messages,
    userMessage,
    operatorId,
    context = {},
  } = data;

  // Validate required fields
  if (!conversationId) throw new Error('[runTask] conversationId is required');
  if (!messages || !Array.isArray(messages)) throw new Error('[runTask] messages array is required');
  if (!userMessage) throw new Error('[runTask] userMessage is required');

  // Extract text for the router
  const messageText = typeof userMessage === 'string'
    ? userMessage
    : userMessage?.content ?? '';

  try {
    // ─── STEP 1: Pre-flight (parallel) ────────────────────────────────────
    // Route decision and context compression run simultaneously.
    // Router is synchronous but wrapped in Promise.resolve for parallel API.
    // Compressor may call Haiku for summarization (async).

    const [decision, compressed] = await Promise.all([
      Promise.resolve(router.route(messageText, {
        hasImage: context.hasImage ?? false,
        directorFlag: context.directorFlag ?? false,
        conversationTokens: context.conversationTokens ?? 0,
      })),
      compressor.compress(messages, conversationId),
    ]);

    console.log(`[runTask] Route: ${decision.lane} | ${decision.reason}`);

    // ─── Build adapted system prompt for this operator ─────────────────
    const systemPrompt = buildSystemPrompt(operatorId || conversationId);

    // ─── STEP 2-7: Execute with escalation ──────────────────────────────
    const result = await _executeWithEscalation(
      conversationId,
      compressed,
      decision,
      context.taskType ?? null,
      0, // escalation depth
      systemPrompt,
    );

    // ─── STEP 8: Log cost ────────────────────────────────────────────────
    if (result.usage) {
      await logCost(
        result.modelId,
        result.usage.inputTokens,
        result.usage.outputTokens,
        { conversationId },
      );
    }

    // ─── STEP 8.5: Voice normalization ───────────────────────────────────
    // Learn from operator's message + validate/rewrite response if needed.
    // Cost: $0 if clean, ~$0.0002 if Haiku rewrite triggers.
    const voiceResult = await normalizeResponse({
      response: result.response,
      operatorMessage: messageText,
      operatorId: operatorId || conversationId,
    });

    const finalResponse = voiceResult.response;
    const totalCostUsd = result.costUsd + (voiceResult.cost?.estimatedUsd || 0);

    if (voiceResult.normalized) {
      console.log(
        `[runTask] Voice normalized | score: ${voiceResult.voiceScore} → ${voiceResult.voiceScoreAfter} | ` +
        `cost: $${voiceResult.cost.estimatedUsd.toFixed(6)} | latency: ${voiceResult.cost.latencyMs}ms`
      );
    }

    // ─── STEP 9: Send complete ───────────────────────────────────────────
    sendComplete(conversationId, finalResponse, totalCostUsd);

    console.log(
      `[runTask] Done | cost: $${totalCostUsd.toFixed(4)} | ` +
      `tokens: ${result.usage?.inputTokens ?? 0}in/${result.usage?.outputTokens ?? 0}out` +
      (voiceResult.normalized ? ' | voice: normalized' : ' | voice: clean')
    );

    return {
      response: finalResponse,
      costUsd: totalCostUsd,
      modelId: result.modelId, // INTERNAL ONLY — never sent to client
      voiceScore: voiceResult.voiceScoreAfter,
    };

  } catch (err) {
    // ─── Terminal failure ─────────────────────────────────────────────────
    console.error(`[runTask] Fatal error for ${conversationId}:`, err.message);
    sendError(conversationId, 'Something went wrong. Please try again.', true);
    throw err;
  }
}

// ─── _executeWithEscalation() ────────────────────────────────────────────────
// Recursive execution with escalation chain.
//
// Flow:
//   1. Check cost guard (paid models)
//   2. Check rate limit (free-tier models)
//   3. Send thinking indicator
//   4. Stream from provider
//   5. Validate structured output
//   6. If validation fails → escalate to next model in chain
//   7. If escalation chain exhausted → throw
//
// Returns: { response, costUsd, modelId, usage }

async function _executeWithEscalation(
  conversationId,
  messages,
  decision,
  taskType,
  depth,
  systemPrompt,
) {
  const { modelId, provider: providerName, maxTokens, thinkingLabel } = decision;

  // ─── Guard: max escalation depth ────────────────────────────────────
  if (depth >= MAX_ESCALATIONS) {
    throw new Error(
      `[runTask] Escalation chain exhausted after ${MAX_ESCALATIONS} attempts. ` +
      `Last model: ${modelId}`
    );
  }

  // ─── STEP 2: Cost guard ──────────────────────────────────────────────
  const affordable = await canAfford(modelId);
  if (!affordable) {
    console.warn(`[runTask] Cost threshold exceeded for ${modelId}. Escalating.`);
    return _escalate(conversationId, messages, decision, taskType, depth, 'cost_exceeded', systemPrompt);
  }

  // ─── STEP 3: Rate limit check ────────────────────────────────────────
  const withinLimits = await canCall(modelId);
  if (!withinLimits) {
    console.warn(`[runTask] Rate limit hit for ${modelId}. Escalating.`);
    return _escalate(conversationId, messages, decision, taskType, depth, 'rate_limited', systemPrompt);
  }

  // ─── STEP 4: Thinking indicator ──────────────────────────────────────
  if (thinkingLabel) {
    sendThinkingState(conversationId, thinkingLabel);
  }

  // ─── STEP 5: Stream from provider ────────────────────────────────────
  const provider = getProvider(providerName);
  let fullResponse = '';
  let usage = null;

  try {
    const stream = provider.stream(messages, {
      model: modelId,
      maxTokens,
      systemPrompt,
    });

    for await (const event of stream) {
      if (event.type === 'text') {
        fullResponse += event.content;
        sendStreamChunk(conversationId, event.content, fullResponse);
      }

      if (event.type === 'usage') {
        usage = {
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
        };
      }
    }
  } catch (streamErr) {
    // Rate limit from provider → escalate
    if (streamErr.status === 429) {
      console.warn(`[runTask] Provider 429 for ${modelId}. Escalating.`);
      return _escalate(conversationId, messages, decision, taskType, depth, 'provider_429', systemPrompt);
    }
    // Other stream errors → rethrow (will be caught by outer try/catch)
    throw streamErr;
  }

  // Record the call for rate limit tracking
  await recordCall(modelId);

  // ─── STEP 6: Validate structured output ──────────────────────────────
  if (taskType) {
    const validation = validateStructured(fullResponse, taskType);
    if (!validation.valid) {
      console.warn(
        `[runTask] Validation failed for ${modelId} (${taskType}): ${validation.error}. Escalating.`
      );
      return _escalate(conversationId, messages, decision, taskType, depth, 'validation_failed', systemPrompt);
    }
  }

  // ─── Calculate cost ────────────────────────────────────────────────────
  const costUsd = usage
    ? calculateCost(modelId, usage.inputTokens, usage.outputTokens)
    : 0;

  return {
    response: fullResponse,
    costUsd,
    modelId,
    usage,
  };
}

// ─── _escalate() ──────────────────────────────────────────────────────────────
// Find the next model in the escalation chain and retry.
//
// If the current model isn't in the chain, or the chain ends (null),
// throw a terminal error — we've exhausted all options.

async function _escalate(
  conversationId,
  messages,
  currentDecision,
  taskType,
  depth,
  reason,
  systemPrompt,
) {
  const { modelId: currentModelId } = currentDecision;
  const nextModelId = ESCALATION_CHAIN[currentModelId];

  // Chain ends here — no fallback available
  if (nextModelId === null || nextModelId === undefined) {
    throw new Error(
      `[runTask] Escalation chain exhausted at ${currentModelId} (reason: ${reason}). ` +
      `No fallback model available.`
    );
  }

  // Log the escalation
  await logEscalation(currentModelId, nextModelId);
  console.log(`[runTask] Escalating: ${currentModelId} → ${nextModelId} (${reason})`);

  // Build new decision for the escalated model
  const nextConfig = getModelConfig(nextModelId);
  const nextDecision = {
    modelId: nextModelId,
    provider: nextConfig.provider,
    maxTokens: nextConfig.maxTokens,
    lane: nextConfig.lane,
    firstTokenMs: nextConfig.firstTokenMs,
    thinkingLabel: nextConfig.thinkingLabel,
    reason: `escalated from ${currentModelId}: ${reason}`,
  };

  // Recursive call with incremented depth
  return _executeWithEscalation(
    conversationId,
    messages,
    nextDecision,
    taskType,
    depth + 1,
    systemPrompt,
  );
}

// ─── getLane(decision) ───────────────────────────────────────────────────────
// Helper to get the queue lane for a routing decision.
// Exported for use by the API layer when submitting jobs.

export function getLane(decision) {
  return schedule(decision.lane);
}

// ─── getRouter() / getCompressor() ──────────────────────────────────────────
// Expose singletons for testing and direct use.

export function getRouter() {
  return router;
}

export function getCompressor() {
  return compressor;
}

// ─── Default export ─────────────────────────────────────────────────────────

export default runTask;
