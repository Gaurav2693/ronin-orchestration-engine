// queue/bullQueue.mjs
// ─────────────────────────────────────────────────────────────────────────────
// BullMQ queue setup with 3 priority lanes
//
// This module manages the job queue infrastructure that routes tasks through
// 3 priority lanes based on operator context:
//   - 'live'       → User is watching (SSE active), highest priority, 20 concurrent
//   - 'standard'   → User triggered task, not blocking UI, 10 concurrent
//   - 'background' → System initiated, async work, lowest priority, 5 concurrent
//
// Each lane is a separate BullMQ Queue backed by Redis, allowing independent
// processing strategies and concurrency limits.
// ─────────────────────────────────────────────────────────────────────────────

import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';

// ─── Redis Connection ───────────────────────────────────────────────────────
// Both Queue and Worker need a Redis connection. We use the same connection
// config for all lanes. Environment variables default to local Redis.

const redisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  maxRetriesPerRequest: null,
};

// ─── Queue Instances ───────────────────────────────────────────────────────
// Create one Queue per priority lane. Each queue is independent but backed
// by the same Redis instance. The queue names are namespaced to 'ronin:*'.

export const queues = {
  live: new Queue('ronin:live', { connection: redisConfig }),
  standard: new Queue('ronin:standard', { connection: redisConfig }),
  background: new Queue('ronin:background', { connection: redisConfig }),
};

// ─── Concurrency Configuration ──────────────────────────────────────────────
// Each lane has a different concurrency limit reflecting its priority:
//   - live:       20 workers (user watching, must be fast)
//   - standard:   10 workers (default, most tasks)
//   - background: 5 workers (system tasks, can be slow)
//
// These limits prevent resource exhaustion and ensure high-priority lanes
// get most CPU/memory while background work doesn't starve the system.

const CONCURRENCY_CONFIG = {
  live: 20,
  standard: 10,
  background: 5,
};

// ─── Worker Storage ────────────────────────────────────────────────────────
// We keep references to all workers so we can gracefully shut them down.

const workers = {
  live: null,
  standard: null,
  background: null,
};

// ─── Add Job Function ──────────────────────────────────────────────────────
// Queue.add() is the primary way to submit work to the system.
// Returns a Job promise that resolves when the job completes.
//
// Arguments:
//   lane     — 'live' | 'standard' | 'background'
//   data     — job payload (task definition, model choice, prompt, etc.)
//   priority — BullMQ priority (1 = highest, higher numbers = lower priority)
//
// Note: BullMQ priority only sorts within a lane. Cross-lane prioritization
// is handled by lane concurrency: live workers are more plentiful and run first.

export async function addJob(lane, data, priority = 0) {
  if (!queues[lane]) {
    throw new Error(`Unknown queue lane: ${lane}`);
  }

  const job = await queues[lane].add('task', data, {
    priority,
    removeOnComplete: { age: 3600 }, // Keep completed jobs for 1 hour
    removeOnFail: { age: 86400 },     // Keep failed jobs for 24 hours
  });

  return job;
}

// ─── Create Workers ───────────────────────────────────────────────────────
// This function creates Worker instances for all 3 lanes and attaches the
// provided job handler to each. The handler is typically runTask() which
// will execute the actual LLM call and stream results.
//
// The handler is a function with signature:
//   handler(job: Job) → Promise<result>
//
// Usage (from runTask.mjs):
//   createWorkers(runTask)
//   // Workers now process all incoming jobs through runTask()

export function createWorkers(handler) {
  // Validate that handler is a function
  if (typeof handler !== 'function') {
    throw new Error('Handler must be a function');
  }

  // Create a worker for each lane with its concurrency limit
  Object.entries(CONCURRENCY_CONFIG).forEach(([lane, concurrency]) => {
    workers[lane] = new Worker(
      `ronin:${lane}`,
      async (job) => {
        // The handler receives the entire Job object from BullMQ.
        // It should handle the job, track progress, and return a result.
        return handler(job);
      },
      {
        connection: redisConfig,
        concurrency,
      }
    );

    // Attach event listeners for debugging / observability
    workers[lane].on('completed', (job) => {
      console.log(`[${lane}] Job ${job.id} completed`);
    });

    workers[lane].on('failed', (job, err) => {
      console.error(`[${lane}] Job ${job.id} failed:`, err.message);
    });

    workers[lane].on('error', (err) => {
      console.error(`[${lane}] Worker error:`, err.message);
    });
  });

  console.log('Workers created for all 3 lanes (live, standard, background)');
}

// ─── Queue Stats ───────────────────────────────────────────────────────────
// Get a snapshot of current queue health: how many jobs are waiting,
// active, or delayed in each lane. Useful for monitoring and debugging.
//
// Returns an object like:
//   {
//     live: { waiting: 5, active: 3, delayed: 0 },
//     standard: { waiting: 12, active: 5, delayed: 2 },
//     background: { waiting: 20, active: 2, delayed: 0 }
//   }

export async function getQueueStats() {
  const stats = {};

  for (const [lane, queue] of Object.entries(queues)) {
    const counts = await queue.getJobCounts();
    stats[lane] = {
      waiting: counts.waiting || 0,
      active: counts.active || 0,
      delayed: counts.delayed || 0,
    };
  }

  return stats;
}

// ─── Graceful Shutdown ──────────────────────────────────────────────────────
// Close all workers and queues cleanly. Called on process exit or SIGTERM.
// This prevents Redis connection leaks and allows jobs to finish gracefully.

export async function shutdown() {
  console.log('Shutting down queue workers and connections...');

  // Close all workers
  for (const [lane, worker] of Object.entries(workers)) {
    if (worker) {
      await worker.close();
      console.log(`Closed worker for lane: ${lane}`);
    }
  }

  // Close all queues
  for (const [lane, queue] of Object.entries(queues)) {
    await queue.close();
    console.log(`Closed queue: ${lane}`);
  }

  console.log('All queue resources shut down successfully');
}

// ─── Graceful Shutdown on Process Signals ──────────────────────────────────
// If the process receives SIGTERM or SIGINT, shut down cleanly.

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
