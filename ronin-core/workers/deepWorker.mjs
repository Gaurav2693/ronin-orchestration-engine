// ─── workers/deepWorker.mjs ───────────────────────────────────────────────────
// RONIN Worker System — Phase 8 (W7)
//
// Deep Worker: o3-mini. Async/batch ONLY — never blocks the conversation.
// For complex reasoning, architecture decisions, deep analysis.
// Operator gets notified on all surfaces when complete via job.complete message.
//
// Cost: $1.10/$4.40 per MTok (input/output)
// Latency: 2500ms+ first token (thinking model)
// Context: 8192 token output cap
//
// Architecture:
//   1. Operator requests deep analysis (or consensus/critic triggers it)
//   2. Deep worker creates a Job, returns job_id immediately (non-blocking)
//   3. Job executes in background
//   4. Polling or callback delivers result when ready
//   5. Gateway pushes job.complete to all surfaces
// ─────────────────────────────────────────────────────────────────────────────

import { createBaseWorker } from './workerInterface.mjs';

// ─── Job States ───────────────────────────────────────────────────────────────

export const JOB_STATES = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  TIMED_OUT: 'timed_out',
});

// ─── System Prompt ────────────────────────────────────────────────────────────

const DEEP_SYSTEM_PROMPT = `You are a deep reasoning assistant. Take your time to think through problems carefully.
Provide thorough, well-structured analysis with:
1. Problem decomposition
2. Multiple perspectives or approaches
3. Trade-off analysis
4. Clear recommendation with reasoning
5. Edge cases and risks

This is an async task — quality matters more than speed.`;

// ─── Job Store (in-memory, pluggable) ─────────────────────────────────────────

export function createJobStore() {
  const jobs = new Map();

  function createJob(id, task, context) {
    const job = {
      id,
      task,
      context,
      state: JOB_STATES.QUEUED,
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
      result: null,
      error: null,
      cost: 0,
      progress: 0,
    };
    jobs.set(id, job);
    return job;
  }

  function getJob(id) {
    return jobs.get(id) || null;
  }

  function updateJob(id, updates) {
    const job = jobs.get(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    Object.assign(job, updates);
    return job;
  }

  function listJobs(filter = {}) {
    let result = [...jobs.values()];
    if (filter.state) result = result.filter(j => j.state === filter.state);
    return result.sort((a, b) => b.createdAt - a.createdAt);
  }

  function deleteJob(id) {
    return jobs.delete(id);
  }

  function getActiveCount() {
    return [...jobs.values()].filter(j =>
      j.state === JOB_STATES.QUEUED || j.state === JOB_STATES.RUNNING
    ).length;
  }

  function clear() {
    jobs.clear();
  }

  return { createJob, getJob, updateJob, listJobs, deleteJob, getActiveCount, clear };
}

// ─── Deep Worker Factory ──────────────────────────────────────────────────────

export function createDeepWorker(provider, jobStore, config = {}) {
  const model = config.model || 'o3-mini';
  const maxTokens = config.maxTokens || 8192;
  const systemPrompt = config.systemPrompt || DEEP_SYSTEM_PROMPT;
  const costPerMTokInput = config.costInput || 1.10;
  const costPerMTokOutput = config.costOutput || 4.40;
  const defaultTimeoutMs = config.timeoutMs || 120_000; // 2 minutes
  const maxConcurrentJobs = config.maxConcurrentJobs || 3;
  const onJobComplete = config.onJobComplete || null; // callback

  async function executeFn(task, context = {}) {
    // Deep worker always runs async via job system
    const jobId = task.jobId || `deep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Check concurrency limit
    if (jobStore.getActiveCount() >= maxConcurrentJobs) {
      return {
        result: null,
        cost: 0,
        model,
        jobId,
        state: JOB_STATES.QUEUED,
        queuePosition: jobStore.getActiveCount(),
        message: `Job queued. ${jobStore.getActiveCount()} jobs ahead.`,
        async: true,
      };
    }

    // Create and start the job
    const job = jobStore.createJob(jobId, task, context);

    // Run async — don't await, return immediately
    runJobAsync(job, task, context).catch(() => {}); // errors handled inside

    return {
      result: null,
      cost: 0,
      model,
      jobId,
      state: JOB_STATES.RUNNING,
      estimatedMs: estimateCompletionMs(task),
      message: 'Deep analysis started. You will be notified when complete.',
      async: true,
    };
  }

  async function runJobAsync(job, task, context) {
    try {
      jobStore.updateJob(job.id, {
        state: JOB_STATES.RUNNING,
        startedAt: Date.now(),
        progress: 10,
      });

      const messages = buildDeepMessages(task, context, systemPrompt);

      // Execute with timeout
      const timeoutMs = task.timeoutMs || defaultTimeoutMs;
      const response = await withTimeout(
        callProvider(provider, messages, model, maxTokens),
        timeoutMs
      );

      const inputTokens = response.usage?.inputTokens || 0;
      const outputTokens = response.usage?.outputTokens || 0;
      const cost = calculateCost(inputTokens, outputTokens);

      jobStore.updateJob(job.id, {
        state: JOB_STATES.COMPLETED,
        completedAt: Date.now(),
        result: response.content,
        cost,
        progress: 100,
        inputTokens,
        outputTokens,
      });

      // Notify callback if registered
      if (onJobComplete) {
        onJobComplete(jobStore.getJob(job.id));
      }
    } catch (err) {
      const isTimeout = err.message === 'TIMEOUT';
      jobStore.updateJob(job.id, {
        state: isTimeout ? JOB_STATES.TIMED_OUT : JOB_STATES.FAILED,
        completedAt: Date.now(),
        error: err.message,
        progress: 0,
      });
    }
  }

  function calculateCost(inputTokens, outputTokens) {
    return ((inputTokens * costPerMTokInput) + (outputTokens * costPerMTokOutput)) / 1_000_000;
  }

  function estimateCompletionMs(task) {
    const msgLen = typeof task === 'string' ? task.length : (task.message || '').length;
    // Rough estimate: base 5s + 1s per 500 chars input
    return 5000 + Math.ceil(msgLen / 500) * 1000;
  }

  // ── Poll job status ──────────────────────────────────────────────

  function pollJob(jobId) {
    const job = jobStore.getJob(jobId);
    if (!job) return null;
    return {
      jobId: job.id,
      state: job.state,
      progress: job.progress,
      result: job.state === JOB_STATES.COMPLETED ? job.result : null,
      error: job.error,
      cost: job.cost,
      elapsed: job.startedAt ? Date.now() - job.startedAt : 0,
    };
  }

  function listJobs(filter) {
    return jobStore.listJobs(filter);
  }

  const worker = createBaseWorker('deep', executeFn, config);

  // Attach deep-specific methods
  worker.pollJob = pollJob;
  worker.listJobs = listJobs;

  return worker;
}

// ─── Message Builder ──────────────────────────────────────────────────────────

export function buildDeepMessages(task, context, systemPrompt) {
  const messages = [];

  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }

  if (context.taste_block) {
    messages.push({ role: 'system', content: context.taste_block });
  }

  // Include more history for deep analysis (needs full context)
  const history = context.history || [];
  messages.push(...history.slice(-20)); // Last 10 turns

  const userMessage = typeof task === 'string' ? task : (task.message || task.content || '');
  if (userMessage) {
    messages.push({ role: 'user', content: userMessage });
  }

  return messages;
}

// ─── Provider Call ────────────────────────────────────────────────────────────

async function callProvider(provider, messages, model, maxTokens) {
  if (typeof provider.complete === 'function') {
    return provider.complete(messages, { model, maxTokens });
  }
  if (typeof provider === 'function') {
    return provider(messages, { model, maxTokens });
  }
  throw new Error('[deepWorker] Provider must implement complete() or be callable');
}

// ─── Timeout Utility ──────────────────────────────────────────────────────────

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), ms)),
  ]);
}
