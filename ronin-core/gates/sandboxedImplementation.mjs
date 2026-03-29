// gates/sandboxedImplementation.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Gate 05 Upgrade: Sandboxed Parallel Implementation
//
// The biggest gate change. Sonnet reads the approved plan, decomposes it into
// independent subtasks, and dispatches each to a separate Codex worker running
// in its own sandbox. All subtasks run in parallel. Results merge back to Sonnet
// for synthesis and quality check.
//
// Flow:
//   approvedPlan → decomposeToManifest() → parallel Codex workers → merge → QA
//
// Usage:
//   const manifest = decomposeToManifest(plan);
//   const result = await executeManifest(manifest, codexWorkers, sandboxManager);
//   // → { results[], mergedOutput, qualityReport, cost, duration }
// ─────────────────────────────────────────────────────────────────────────────

// ─── Task Manifest Types ──────────────────────────────────────────────────────

export const TASK_TYPES = {
  COMPONENT:   'component',
  UTILITY:     'utility',
  TEST:        'test',
  CONFIG:      'config',
  STYLE:       'style',
  INTEGRATION: 'integration',
};

// ─── decomposeToManifest ─────────────────────────────────────────────────────
// Convert a Gate 04 plan into an ordered, dependency-resolved task manifest.
// Tasks with no dependencies can run in parallel.

export function decomposeToManifest(plan) {
  if (!plan || !plan.taskManifest) {
    throw new Error('[sandboxedImplementation] plan must have taskManifest array');
  }

  const tasks = plan.taskManifest;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error('[sandboxedImplementation] taskManifest must be a non-empty array');
  }

  // Validate and normalize each task
  return tasks.map((task, i) => ({
    id: task.id || `T${i + 1}`,
    description: task.description || `Task ${i + 1}`,
    type: task.type || TASK_TYPES.COMPONENT,
    files: Array.isArray(task.files) ? task.files : [],
    critical: task.critical !== false,  // default: critical
    dependencies: Array.isArray(task.dependencies) ? task.dependencies : [],
    context: task.context || '',
    status: 'pending',
    result: null,
    error: null,
  }));
}

// ─── Resolve execution order ─────────────────────────────────────────────────
// Groups tasks by dependency level. Level 0 = no deps (run immediately).
// Level 1 = depends on level 0, etc.

export function resolveExecutionOrder(manifest) {
  const taskMap = new Map(manifest.map(t => [t.id, t]));
  const levels = [];
  const assigned = new Set();

  let remaining = [...manifest];
  let safetyCount = 0;

  while (remaining.length > 0 && safetyCount < 20) {
    safetyCount++;
    const ready = remaining.filter(task =>
      task.dependencies.every(dep => assigned.has(dep))
    );

    if (ready.length === 0) {
      // Circular or missing dep — add remaining as a final level
      levels.push(remaining.map(t => t.id));
      break;
    }

    levels.push(ready.map(t => t.id));
    for (const task of ready) assigned.add(task.id);
    remaining = remaining.filter(t => !assigned.has(t.id));
  }

  return levels;
}

// ─── Build Codex prompt for a single task ────────────────────────────────────

function buildCodexPrompt(task, plan, completedResults) {
  const completedContext = completedResults.length > 0
    ? `\nCompleted tasks context:\n${completedResults.map(r =>
        `${r.id}: ${r.files?.join(', ')} — ${r.summary || 'done'}`
      ).join('\n')}\n`
    : '';

  const fileContext = task.files.length > 0
    ? `\nFiles to create/modify:\n${task.files.join('\n')}\n`
    : '';

  return `
You are implementing a specific task in a larger project.
Generate complete, working code. No placeholders.

Task: ${task.description}
Type: ${task.type}
${fileContext}${completedContext}
Project context:
- Domain: ${plan.domain || 'generic'}
- Dependencies: ${(plan.dependencies || []).map(d => d.name).join(', ') || 'none'}
- Acceptance criteria: ${(plan.acceptanceCriteria || []).join('; ') || 'functional'}

Generate the code. Use \`\`\`language // path/to/file.ext format for each file.
`.trim();
}

// ─── Merge results from all workers ─────────────────────────────────────────

function mergeResults(results) {
  const allFiles = {};
  const allErrors = [];
  let totalCost = 0;
  let totalTokens = 0;

  for (const result of results) {
    totalCost += result.cost || 0;
    totalTokens += result.tokens || 0;

    if (result.error) {
      allErrors.push({ taskId: result.id, error: result.error });
      continue;
    }

    // Merge file outputs (later task wins on conflict)
    for (const [path, content] of Object.entries(result.files || {})) {
      allFiles[path] = content;
    }
  }

  return {
    files: allFiles,
    errors: allErrors,
    totalCost,
    totalTokens,
    fileCount: Object.keys(allFiles).length,
  };
}

// ─── Quality report ──────────────────────────────────────────────────────────

function buildQualityReport(manifest, mergedOutput, plan) {
  const completed = manifest.filter(t => t.status === 'completed');
  const failed    = manifest.filter(t => t.status === 'failed');
  const criticalFailed = failed.filter(t => t.critical);

  return {
    passed: criticalFailed.length === 0,
    tasksTotal: manifest.length,
    tasksCompleted: completed.length,
    tasksFailed: failed.length,
    criticalFailures: criticalFailed.map(t => ({ id: t.id, error: t.error })),
    filesGenerated: mergedOutput.fileCount,
    acceptanceCriteriaMet: plan.acceptanceCriteria?.length > 0
      ? mergedOutput.errors.length === 0
      : true,
    blockingIssues: criticalFailed.map(t =>
      `Task ${t.id} (${t.description}) failed: ${t.error}`
    ),
  };
}

// ─── Execute a single task via Codex worker ──────────────────────────────────

async function executeTask(task, plan, codexWorker, sandboxManager, completedResults) {
  const prompt = buildCodexPrompt(task, plan, completedResults);
  task.status = 'running';

  try {
    const sandboxId = sandboxManager
      ? await sandboxManager.createSandbox(task.id)
      : null;

    const result = await codexWorker.execute(
      {
        messages: [{ role: 'user', content: prompt }],
        sandboxId,
        task,
      },
      {}
    );

    if (sandboxId && sandboxManager) {
      await sandboxManager.destroySandbox(sandboxId).catch(() => {});
    }

    // Extract file outputs from result
    const files = result.files || result.artifacts || {};
    const rawContent = result.result || result.content || '';

    // Parse ```lang // path code blocks if files not already extracted
    const parsedFiles = Object.keys(files).length > 0 ? files : _extractFiles(rawContent);

    task.status = 'completed';
    task.result = rawContent;

    return {
      id: task.id,
      status: 'completed',
      files: parsedFiles,
      cost: result.cost || 0,
      tokens: result.tokens || 0,
      summary: rawContent.slice(0, 100),
    };

  } catch (err) {
    task.status = 'failed';
    task.error = err.message;

    return {
      id: task.id,
      status: 'failed',
      files: {},
      cost: 0,
      tokens: 0,
      error: err.message,
    };
  }
}

function _extractFiles(content) {
  const files = {};
  const regex = /```[\w.+-]+ \/\/ (.+?)\n([\s\S]+?)```/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    files[match[1].trim()] = match[2].trim();
  }
  return files;
}

// ─── Main: executeManifest ───────────────────────────────────────────────────

export async function executeManifest(manifest, codexWorker, sandboxManager, plan = {}, options = {}) {
  if (!manifest || !Array.isArray(manifest) || manifest.length === 0) {
    throw new Error('[sandboxedImplementation] manifest must be a non-empty array');
  }
  if (!codexWorker || typeof codexWorker.execute !== 'function') {
    throw new Error('[sandboxedImplementation] codexWorker must implement execute()');
  }

  const startTime = Date.now();
  const executionLevels = resolveExecutionOrder(manifest);
  const allResults = [];
  const completedResults = [];

  // Execute level by level — within a level, all tasks run in parallel
  for (const level of executionLevels) {
    const levelTasks = level.map(id => manifest.find(t => t.id === id)).filter(Boolean);

    const levelPromises = levelTasks.map(task =>
      executeTask(task, plan, codexWorker, sandboxManager, completedResults)
    );

    const levelResults = await Promise.allSettled(levelPromises);

    for (const settled of levelResults) {
      const result = settled.status === 'fulfilled'
        ? settled.value
        : { id: 'unknown', status: 'failed', files: {}, cost: 0, error: settled.reason?.message };

      allResults.push(result);
      if (result.status === 'completed') completedResults.push(result);
    }

    // Check if a critical task failed — stop execution if so (unless continueOnFailure)
    if (!options.continueOnFailure) {
      const criticalFailed = levelTasks.find(t =>
        t.critical && t.status === 'failed'
      );
      if (criticalFailed) break;
    }
  }

  const mergedOutput = mergeResults(allResults);
  const qualityReport = buildQualityReport(manifest, mergedOutput, plan);
  const totalDuration = Date.now() - startTime;

  return {
    results: allResults,
    mergedOutput: mergedOutput.files,
    qualityReport,
    meta: {
      totalCost: mergedOutput.totalCost,
      totalDuration,
      tasksExecuted: allResults.length,
      filesGenerated: mergedOutput.fileCount,
      parallelLevels: executionLevels.length,
    },
  };
}
