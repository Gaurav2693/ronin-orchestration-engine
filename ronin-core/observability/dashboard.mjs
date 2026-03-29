// ─── observability/dashboard.mjs ─────────────────────────────────────────────
// RONIN Cost & Token Dashboard — Live Observability Window
//
// Purpose: Lightweight HTTP server that serves a real-time cost/token dashboard.
// Reads from the orchestrator's cost tracker, pipeline metrics, and worker stats.
// Designed to run alongside the engine on a separate port.
//
// Endpoints:
//   GET /                — Dashboard HTML (single-page, no deps)
//   GET /api/stats       — JSON snapshot of all metrics
//   GET /api/models      — Model config + cost tables
//   POST /api/simulate   — Simulate a task cost breakdown
//
// Wiring:
//   Imports from modelConfig, costTracker, pipeline metrics.
//   No external dependencies — uses Node built-in http module.
//
// Usage:
//   import { startDashboard } from './dashboard.mjs';
//   startDashboard({ port: 7777 });
// ─────────────────────────────────────────────────────────────────────────────

import http from 'http';
import { MODELS, COST_THRESHOLDS, RATE_LIMITS } from '../config/modelConfig.mjs';
import { calculateCost } from './costTracker.mjs';

// ─── In-Memory Stats Collector ──────────────────────────────────────────────
// Lightweight alternative to Redis for the dashboard.
// Collects stats in-memory, resets daily.

function createStatsCollector() {
  const state = {
    startedAt: Date.now(),
    tasks: [],
    modelUsage: {},
    totalCost: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    requestCount: 0,
    workerDistribution: {},
    pipelineRuns: 0,
    pipelineErrors: 0,
  };

  function recordTask(task) {
    // task: { model, inputTokens, outputTokens, cost, duration, worker, classification }
    state.tasks.push({
      ...task,
      ts: Date.now(),
    });

    // Keep last 100 tasks
    if (state.tasks.length > 100) state.tasks.shift();

    const model = task.model || 'unknown';
    if (!state.modelUsage[model]) {
      state.modelUsage[model] = { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0, totalMs: 0 };
    }
    state.modelUsage[model].calls++;
    state.modelUsage[model].inputTokens += task.inputTokens || 0;
    state.modelUsage[model].outputTokens += task.outputTokens || 0;
    state.modelUsage[model].cost += task.cost || 0;
    state.modelUsage[model].totalMs += task.duration || 0;

    state.totalCost += task.cost || 0;
    state.totalInputTokens += task.inputTokens || 0;
    state.totalOutputTokens += task.outputTokens || 0;
    state.requestCount++;

    if (task.worker) {
      state.workerDistribution[task.worker] = (state.workerDistribution[task.worker] || 0) + 1;
    }
  }

  function recordPipelineRun(metrics) {
    state.pipelineRuns++;
    if (metrics?.error) state.pipelineErrors++;
  }

  function getSnapshot() {
    const uptimeMs = Date.now() - state.startedAt;
    return {
      uptime: formatUptime(uptimeMs),
      uptimeMs,
      totalCost: round(state.totalCost, 6),
      totalInputTokens: state.totalInputTokens,
      totalOutputTokens: state.totalOutputTokens,
      requestCount: state.requestCount,
      avgCostPerRequest: state.requestCount > 0 ? round(state.totalCost / state.requestCount, 6) : 0,
      modelUsage: state.modelUsage,
      workerDistribution: state.workerDistribution,
      pipelineRuns: state.pipelineRuns,
      pipelineErrors: state.pipelineErrors,
      recentTasks: state.tasks.slice(-20),
      costThresholds: COST_THRESHOLDS,
      dailyBudgetUsed: round((state.totalCost / (COST_THRESHOLDS.daily?.total || 25)) * 100, 1),
    };
  }

  function reset() {
    state.tasks = [];
    state.modelUsage = {};
    state.totalCost = 0;
    state.totalInputTokens = 0;
    state.totalOutputTokens = 0;
    state.requestCount = 0;
    state.workerDistribution = {};
    state.pipelineRuns = 0;
    state.pipelineErrors = 0;
    state.startedAt = Date.now();
  }

  return { recordTask, recordPipelineRun, getSnapshot, reset };
}

function round(n, decimals) {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

// ─── Cost Simulation ────────────────────────────────────────────────────────

export function simulateTaskCost(taskDescription, inputTokenEstimate = 1000, outputTokenEstimate = 500) {
  const breakdown = {};
  for (const [modelId, config] of Object.entries(MODELS)) {
    const cost = calculateCost(modelId, inputTokenEstimate, outputTokenEstimate);
    breakdown[modelId] = {
      provider: config.provider,
      seat: config.seat,
      lane: config.lane,
      inputCost: round((inputTokenEstimate / 1_000_000) * config.cost.input, 6),
      outputCost: round((outputTokenEstimate / 1_000_000) * config.cost.output, 6),
      totalCost: round(cost, 6),
      free: cost === 0,
    };
  }
  return { task: taskDescription, inputTokens: inputTokenEstimate, outputTokens: outputTokenEstimate, breakdown };
}

// ─── Dashboard HTML ─────────────────────────────────────────────────────────

function getDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RONIN — Cost & Token Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0a0a0a; color: #e0e0e0; font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 13px; line-height: 1.5; padding: 16px;
  }
  .header {
    display: flex; align-items: center; justify-content: space-between;
    border-bottom: 1px solid #1a3a3a; padding-bottom: 12px; margin-bottom: 16px;
  }
  .header h1 { font-size: 16px; color: #00d4aa; font-weight: 600; letter-spacing: 1px; }
  .header .uptime { color: #666; font-size: 11px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; margin-bottom: 16px; }
  .card {
    background: #111; border: 1px solid #1a2a2a; border-radius: 6px; padding: 12px;
  }
  .card .label { color: #666; font-size: 10px; text-transform: uppercase; letter-spacing: 1px; }
  .card .value { font-size: 22px; color: #00d4aa; font-weight: 700; margin-top: 4px; }
  .card .sub { color: #555; font-size: 11px; margin-top: 2px; }
  .section { margin-bottom: 16px; }
  .section h2 {
    font-size: 11px; color: #00d4aa; text-transform: uppercase; letter-spacing: 2px;
    margin-bottom: 8px; opacity: 0.7;
  }
  table { width: 100%; border-collapse: collapse; }
  th {
    text-align: left; color: #555; font-size: 10px; text-transform: uppercase;
    letter-spacing: 1px; padding: 6px 8px; border-bottom: 1px solid #1a2a2a;
  }
  td { padding: 6px 8px; border-bottom: 1px solid #0d1a1a; font-size: 12px; }
  tr:hover td { background: #0d1a1a; }
  .free { color: #00ff88; }
  .paid { color: #ff6b6b; }
  .budget-bar {
    width: 100%; height: 6px; background: #1a2a2a; border-radius: 3px; margin-top: 8px;
  }
  .budget-fill {
    height: 100%; background: #00d4aa; border-radius: 3px; transition: width 0.5s;
  }
  .budget-fill.warn { background: #ffaa00; }
  .budget-fill.danger { background: #ff4444; }
  .worker-bar {
    display: inline-block; height: 14px; border-radius: 2px; margin-right: 2px;
    transition: width 0.5s;
  }
  .worker-fast { background: #00ff88; }
  .worker-vision { background: #00aaff; }
  .worker-agent { background: #ffaa00; }
  .worker-deep { background: #ff6b6b; }
  .worker-codex { background: #aa66ff; }
  .worker-local { background: #888; }
  .legend { display: flex; gap: 12px; margin-top: 6px; font-size: 10px; color: #666; }
  .legend span::before { content: ''; display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 4px; }
  .legend .l-fast::before { background: #00ff88; }
  .legend .l-vision::before { background: #00aaff; }
  .legend .l-agent::before { background: #ffaa00; }
  .legend .l-deep::before { background: #ff6b6b; }
  .legend .l-codex::before { background: #aa66ff; }
  .legend .l-local::before { background: #888; }
  .recent { max-height: 200px; overflow-y: auto; }
  .pulse { animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100% { opacity: 0.3; } 50% { opacity: 1; } }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: #00d4aa; display: inline-block; }
</style>
</head>
<body>
<div class="header">
  <h1>RONIN <span style="color:#333">·</span> COST WINDOW</h1>
  <div class="uptime"><span class="dot pulse"></span> <span id="uptime">0s</span></div>
</div>

<div class="grid">
  <div class="card">
    <div class="label">Total Spend</div>
    <div class="value" id="totalCost">$0.000</div>
    <div class="sub" id="avgCost">avg $0/req</div>
  </div>
  <div class="card">
    <div class="label">Tokens In / Out</div>
    <div class="value" id="tokens">0 / 0</div>
    <div class="sub" id="reqCount">0 requests</div>
  </div>
  <div class="card">
    <div class="label">Budget Used</div>
    <div class="value" id="budgetPct">0%</div>
    <div class="budget-bar"><div class="budget-fill" id="budgetBar" style="width:0%"></div></div>
    <div class="sub" id="budgetCap">of $25.00 daily cap</div>
  </div>
</div>

<div class="section">
  <h2>Worker Routing</h2>
  <div id="workerBars" style="height:14px;display:flex;"></div>
  <div class="legend">
    <span class="l-fast">fast (free)</span>
    <span class="l-vision">vision (free)</span>
    <span class="l-agent">agent</span>
    <span class="l-deep">deep</span>
    <span class="l-codex">codex</span>
    <span class="l-local">local (free)</span>
  </div>
</div>

<div class="section">
  <h2>Model Breakdown</h2>
  <table>
    <tr><th>Model</th><th>Calls</th><th>In Tokens</th><th>Out Tokens</th><th>Cost</th><th>Avg ms</th></tr>
    <tbody id="modelTable"></tbody>
  </table>
</div>

<div class="section">
  <h2>Recent Tasks</h2>
  <div class="recent">
    <table>
      <tr><th>Time</th><th>Model</th><th>Worker</th><th>Tokens</th><th>Cost</th><th>ms</th></tr>
      <tbody id="recentTable"></tbody>
    </table>
  </div>
</div>

<script>
const API = '/api/stats';
const COLORS = { fast:'#00ff88', vision:'#00aaff', agent:'#ffaa00', deep:'#ff6b6b', codex:'#aa66ff', local:'#888' };

function fmt$(n) { return '$' + n.toFixed(n < 0.01 ? 6 : 4); }
function fmtK(n) { return n >= 1000 ? (n/1000).toFixed(1)+'K' : n.toString(); }

async function refresh() {
  try {
    const res = await fetch(API);
    const d = await res.json();

    document.getElementById('uptime').textContent = d.uptime;
    document.getElementById('totalCost').textContent = fmt$(d.totalCost);
    document.getElementById('avgCost').textContent = 'avg ' + fmt$(d.avgCostPerRequest) + '/req';
    document.getElementById('tokens').textContent = fmtK(d.totalInputTokens) + ' / ' + fmtK(d.totalOutputTokens);
    document.getElementById('reqCount').textContent = d.requestCount + ' requests';
    document.getElementById('budgetPct').textContent = d.dailyBudgetUsed.toFixed(1) + '%';

    const bar = document.getElementById('budgetBar');
    bar.style.width = Math.min(d.dailyBudgetUsed, 100) + '%';
    bar.className = 'budget-fill' + (d.dailyBudgetUsed > 80 ? ' danger' : d.dailyBudgetUsed > 50 ? ' warn' : '');
    document.getElementById('budgetCap').textContent = 'of $' + (d.costThresholds?.daily?.total || 25).toFixed(2) + ' daily cap';

    // Worker bars
    const wb = document.getElementById('workerBars');
    const total = Object.values(d.workerDistribution).reduce((a,b) => a+b, 0) || 1;
    wb.innerHTML = Object.entries(d.workerDistribution).map(([w,c]) =>
      '<div class="worker-bar worker-'+w+'" style="width:'+((c/total)*100)+'%" title="'+w+': '+c+'"></div>'
    ).join('');

    // Model table
    const mt = document.getElementById('modelTable');
    mt.innerHTML = Object.entries(d.modelUsage).sort((a,b) => b[1].cost - a[1].cost).map(([m,u]) => {
      const avgMs = u.calls > 0 ? Math.round(u.totalMs / u.calls) : 0;
      const cls = u.cost === 0 ? 'free' : 'paid';
      return '<tr><td>'+m.substring(0,28)+'</td><td>'+u.calls+'</td><td>'+fmtK(u.inputTokens)+'</td><td>'+fmtK(u.outputTokens)+'</td><td class="'+cls+'">'+fmt$(u.cost)+'</td><td>'+avgMs+'</td></tr>';
    }).join('');

    // Recent tasks
    const rt = document.getElementById('recentTable');
    rt.innerHTML = d.recentTasks.slice().reverse().map(t => {
      const time = new Date(t.ts).toLocaleTimeString();
      const cls = (t.cost || 0) === 0 ? 'free' : 'paid';
      return '<tr><td>'+time+'</td><td>'+((t.model||'?').substring(0,22))+'</td><td>'+(t.worker||'-')+'</td><td>'+fmtK(t.inputTokens||0)+'/'+fmtK(t.outputTokens||0)+'</td><td class="'+cls+'">'+fmt$(t.cost||0)+'</td><td>'+(t.duration||0)+'</td></tr>';
    }).join('');
  } catch(e) { console.error('Dashboard refresh failed:', e); }
}

refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>`;
}

// ─── HTTP Server ────────────────────────────────────────────────────────────

export function startDashboard(config = {}) {
  const port = config.port || 7777;
  const collector = config.collector || createStatsCollector();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Routes
    if (url.pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(getDashboardHTML());
      return;
    }

    if (url.pathname === '/api/stats' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(collector.getSnapshot()));
      return;
    }

    if (url.pathname === '/api/models' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: MODELS, rateLimits: RATE_LIMITS, thresholds: COST_THRESHOLDS }));
      return;
    }

    if (url.pathname === '/api/simulate' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const { task, inputTokens, outputTokens } = JSON.parse(body);
          const result = simulateTaskCost(task || 'unknown', inputTokens || 1000, outputTokens || 500);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    if (url.pathname === '/api/reset' && req.method === 'POST') {
      collector.reset();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ reset: true }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(port, () => {
    console.log(`\x1b[36m[RONIN]\x1b[0m Cost dashboard: http://localhost:${port}`);
  });

  return { server, collector };
}

// ─── Exports ────────────────────────────────────────────────────────────────

export { createStatsCollector };
