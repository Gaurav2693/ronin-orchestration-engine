// gates/durableBuild.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Gate 07 Upgrade: Durable Build Pipeline
//
// State machine build pipeline with checkpointing. If a build step fails,
// the pipeline can resume from the last checkpoint instead of restarting.
// Survives process crashes, network interruptions, and worker failures.
//
// Build stages:
//   INIT → PREPARE → COMPILE → BUNDLE → TEST → PACKAGE → DONE
//   Any stage → FAILED (with checkpoint saved for resume)
//
// Checkpoint storage: pluggable (in-memory default, Redis/SQLite in prod).
//
// Usage:
//   const pipeline = createBuildPipeline(stages, checkpointStore);
//   const result   = await pipeline.run(artifacts, context);
//   // → { passed, output, stage, checkpointId, cost, duration }
//
//   // Resume from checkpoint:
//   const result = await pipeline.resume(checkpointId, artifacts, context);
// ─────────────────────────────────────────────────────────────────────────────

// ─── Build Stages ─────────────────────────────────────────────────────────────

export const BUILD_STAGES = {
  INIT:    'init',
  PREPARE: 'prepare',
  COMPILE: 'compile',
  BUNDLE:  'bundle',
  TEST:    'test',
  PACKAGE: 'package',
  DONE:    'done',
  FAILED:  'failed',
};

const STAGE_ORDER = [
  BUILD_STAGES.INIT,
  BUILD_STAGES.PREPARE,
  BUILD_STAGES.COMPILE,
  BUILD_STAGES.BUNDLE,
  BUILD_STAGES.TEST,
  BUILD_STAGES.PACKAGE,
  BUILD_STAGES.DONE,
];

// ─── Checkpoint Schema ────────────────────────────────────────────────────────

export function createCheckpoint(overrides = {}) {
  return {
    id:           null,           // string checkpoint ID
    stage:        BUILD_STAGES.INIT,
    completedStages: [],          // stages that finished successfully
    artifacts:    {},             // current artifact state
    stageOutputs: {},             // { stageName: output }
    context:      {},             // build context (plan, options, etc.)
    error:        null,           // last error if FAILED
    createdAt:    new Date().toISOString(),
    updatedAt:    new Date().toISOString(),
    ...overrides,
  };
}

// ─── In-memory checkpoint store ───────────────────────────────────────────────

export class InMemoryCheckpointStore {
  constructor() {
    this._store = new Map();
    this._counter = 0;
  }

  async save(checkpoint) {
    const id = checkpoint.id || `ckpt_${++this._counter}_${Date.now()}`;
    const saved = { ...checkpoint, id, updatedAt: new Date().toISOString() };
    this._store.set(id, saved);
    return id;
  }

  async load(id) {
    return this._store.get(id) || null;
  }

  async delete(id) {
    this._store.delete(id);
  }

  async list() {
    return [...this._store.values()];
  }

  clear() {
    this._store.clear();
  }

  get size() {
    return this._store.size;
  }
}

// ─── Default in-memory store (singleton) ─────────────────────────────────────

const _defaultStore = new InMemoryCheckpointStore();
export function getDefaultCheckpointStore() { return _defaultStore; }

// ─── Stage executor ───────────────────────────────────────────────────────────

async function _executeStage(stage, artifacts, stageOutputs, context, stageHandlers) {
  const handler = stageHandlers[stage];

  // No handler = pass-through (stage auto-succeeds)
  if (!handler || typeof handler !== 'function') {
    return { artifacts, output: null };
  }

  const result = await handler(artifacts, stageOutputs, context);

  if (result && typeof result === 'object') {
    return {
      artifacts: result.artifacts || artifacts,
      output:    result.output    || result,
    };
  }

  return { artifacts, output: result };
}

// ─── Build pipeline factory ───────────────────────────────────────────────────

export function createBuildPipeline(stageHandlers = {}, checkpointStore = null) {
  const store = checkpointStore || _defaultStore;

  // ─── Run from scratch ────────────────────────────────────────────────────
  async function run(initialArtifacts, context = {}, options = {}) {
    const checkpoint = createCheckpoint({
      artifacts: initialArtifacts || {},
      context,
    });

    const checkpointId = await store.save(checkpoint);
    checkpoint.id = checkpointId;

    return _runFrom(BUILD_STAGES.INIT, checkpoint, store, stageHandlers, options);
  }

  // ─── Resume from checkpoint ──────────────────────────────────────────────
  async function resume(checkpointId, options = {}) {
    const checkpoint = await store.load(checkpointId);
    if (!checkpoint) {
      throw new Error(`[durableBuild] checkpoint ${checkpointId} not found`);
    }

    const resumeFrom = checkpoint.stage === BUILD_STAGES.FAILED
      ? checkpoint.completedStages[checkpoint.completedStages.length - 1] || BUILD_STAGES.INIT
      : checkpoint.stage;

    // Find the next stage after the last completed one
    const resumeIndex = STAGE_ORDER.indexOf(resumeFrom);
    const nextStage   = STAGE_ORDER[resumeIndex + 1] || BUILD_STAGES.DONE;

    return _runFrom(nextStage, checkpoint, store, stageHandlers, options);
  }

  return { run, resume };
}

// ─── Core runner ─────────────────────────────────────────────────────────────

async function _runFrom(startStage, checkpoint, store, stageHandlers, options = {}) {
  const startTime = Date.now();
  let totalCost   = 0;

  let currentArtifacts = { ...(checkpoint.artifacts || {}) };
  let stageOutputs     = { ...(checkpoint.stageOutputs || {}) };

  const startIndex = STAGE_ORDER.indexOf(startStage);
  const stagesToRun = STAGE_ORDER.slice(
    startIndex >= 0 ? startIndex : 0
  ).filter(s => s !== BUILD_STAGES.DONE);

  for (const stage of stagesToRun) {
    // Update checkpoint to mark current stage
    checkpoint.stage     = stage;
    checkpoint.artifacts = currentArtifacts;
    await store.save(checkpoint);

    try {
      const stageStart  = Date.now();
      const { artifacts: nextArtifacts, output } = await _executeStage(
        stage,
        currentArtifacts,
        stageOutputs,
        checkpoint.context,
        stageHandlers
      );

      // Stage succeeded
      currentArtifacts       = nextArtifacts;
      stageOutputs[stage]    = output;
      totalCost             += (output?.cost || 0);

      checkpoint.completedStages = [...(checkpoint.completedStages || []), stage];
      checkpoint.stageOutputs    = stageOutputs;
      checkpoint.artifacts       = currentArtifacts;
      checkpoint.stage           = stage;
      await store.save(checkpoint);

      // Early exit on test failure if stopOnTestFailure option set
      if (stage === BUILD_STAGES.TEST && output?.passed === false && options.stopOnTestFailure) {
        checkpoint.stage = BUILD_STAGES.FAILED;
        checkpoint.error = 'Test stage failed';
        await store.save(checkpoint);

        return _buildResult(false, currentArtifacts, BUILD_STAGES.TEST, checkpoint.id, totalCost, Date.now() - startTime, output?.error || 'Test stage failed', stageOutputs);
      }

    } catch (err) {
      // Stage failed — save checkpoint for resume
      checkpoint.stage = BUILD_STAGES.FAILED;
      checkpoint.error = err.message;
      await store.save(checkpoint);

      return _buildResult(false, currentArtifacts, stage, checkpoint.id, totalCost, Date.now() - startTime, err.message, stageOutputs);
    }
  }

  // All stages complete
  checkpoint.stage = BUILD_STAGES.DONE;
  checkpoint.error = null;
  await store.save(checkpoint);

  return _buildResult(true, currentArtifacts, BUILD_STAGES.DONE, checkpoint.id, totalCost, Date.now() - startTime, null, stageOutputs);
}

function _buildResult(passed, artifacts, stage, checkpointId, cost, duration, error, stageOutputs) {
  return {
    passed,
    output:       artifacts,
    stage,
    checkpointId,
    stageOutputs,
    error,
    meta: {
      totalCost: cost,
      totalDuration: duration,
      completedStages: Object.keys(stageOutputs),
      resumable: !passed && !!checkpointId,
    },
  };
}

// ─── Default pipeline with no-op handlers ────────────────────────────────────
// Production stages inject real handlers (transpile, bundle, test runner, etc.)

export function createDefaultPipeline(overrides = {}, checkpointStore = null) {
  const handlers = {
    [BUILD_STAGES.INIT]:    async (artifacts) => ({ artifacts }),
    [BUILD_STAGES.PREPARE]: async (artifacts) => ({ artifacts }),
    [BUILD_STAGES.COMPILE]: async (artifacts) => ({ artifacts }),
    [BUILD_STAGES.BUNDLE]:  async (artifacts) => ({ artifacts }),
    [BUILD_STAGES.TEST]:    async (artifacts) => ({ artifacts, output: { passed: true } }),
    [BUILD_STAGES.PACKAGE]: async (artifacts) => ({ artifacts }),
    ...overrides,
  };

  return createBuildPipeline(handlers, checkpointStore);
}
