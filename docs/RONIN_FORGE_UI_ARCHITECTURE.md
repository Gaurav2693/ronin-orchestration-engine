# RONIN Forge + Dev Window — UI Architecture

> Saved from planning session 2026-03-24. This is the reference document for all UI work.
> Do NOT build UI from memory — read this first.

---

## 1. Overview

RONIN Forge is a self-hosted agentic build environment inside the Build tab. It gives the operator (Gaurav) the ability to direct AI agents through chat to modify RONIN's own codebase, run tests, manage sandboxes, and see everything happen in a live visual tree.

The Dev Window is a separate tab (DEV / COCKPIT) that exposes the intelligence layer — raw model access, pipeline inspection, cost tracking, operator profile, taste memory.

Both share a common widget library. Both run as React inside the existing WKWebView shell.

---

## 2. Dev Window Layout — 4-Zone Grid

```
┌──────────────────┬──────────────────────────────┬───────────────┐
│                  │                              │               │
│   MODEL RAIL     │       CHAT COCKPIT           │  COST PANEL   │
│   (left, narrow) │       (center, primary)      │  (right, fixed│
│                  │                              │   width)      │
├──────────────────┴──────────────────────────────┴───────────────┤
│                                                                  │
│                  PIPELINE INSPECTOR (bottom, collapsible)        │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Zone 1 — Model Rail (Left Column)

Vertical scrollable list of all 11 models, grouped by seat.

Each model card shows:
- Model display name (never raw ID)
- Seat badge (Core / Director / Ops / Analyst / Memory / Specialist)
- Provider logo (Anthropic / OpenAI / Groq / Gemini)
- Cost: `$3.00 in / $15.00 out per 1M tokens` or FREE badge
- Latency badge: expected first-token time (e.g. `~700ms`)
- Rate limit bar (free-tier): remaining quota as thin progress bar
- Status dot: green (available), yellow (rate limited), red (no API key), grey (unconfigured)

Below model list:
- ESCALATION CHAIN visualizer: `groq → gemini_flash → sonnet → (stop)` as linked nodes
- ROUTING MODE toggle: `AUTO` / `LOCKED` / `COMPARE`

### Zone 2 — Chat Cockpit (Center)

Same chat surface as main shell with extra layers:

Header bar:
- Current target badge: `→ Seat 1 / claude-sonnet-4-6`
- Task Mode badge: `MODE: BUILDER` (clickable to force override)
- Sandbox toggle: `SANDBOX` vs `LIVE`
- System Prompt badge: `DEFAULT` vs `CUSTOM`

Message metadata (collapsible strip beneath each response):
- `Seat 1 · claude-sonnet-4-6 · 847 tokens · $0.0034 · 1.2s TTFT · Mode: BUILDER`
- Diff toggle: raw pre-normalization vs final normalized output
- Quality badge from critic.mjs: 6-dimension radar
- Confidence badge from confidenceScorer.mjs: HIGH / MED / LOW

System Prompt Editor (drawer):
- Tabs: `Voice Schema`, `Operator Profile Fragment`, `Task Mode Injection`, `Full Combined`
- `Reset to production`, `Test with current input`, `Save as variant`

Input bar extras:
- `@model-id` targeting syntax (`@opus` = Director seat)
- `@worker:vision`, `@worker:codex`, `@worker:deep`
- `/force-mode ARCHITECT`
- `/compare` — all models simultaneously
- `/trace` — full middleware pipeline trace

### Zone 3 — Cost Panel (Right Column, Always Visible)

Section A — Live Session Counter:
- Running total: `$0.0412 this session`
- Token breakdown: `4,204 in / 1,847 out`
- Request count: `12 calls`
- Sparkline bar (last 10 requests)

Section B — Per-Model Breakdown:
- Model | Calls | Tokens | Cost | % of total

Section C — Budget Gauges:
- Daily spend vs $25.00 hard cap (4-tier colour: green→yellow→orange→red)
- Estimated end-of-day extrapolation

Section D — Escalation Log:
- Timestamp, failed model, reason, escalated to, succeeded?

### Zone 4 — Pipeline Inspector (Bottom, Collapsible)

Collapsed: 32px bar, 13 dots in sequence (grey/blue/green/orange/red)
Expanded: 13 cards in 2 rows

Each card:
- Slot number (1–13)
- Middleware name
- Status badge
- Last execution time
- What it found/did (truncated)

Sub-panels:
- Worker Status Board: 8 worker cards (health, queue depth, last response time)
- Gate Debugger: 7 gate cards (GU1-GU7), each with manual fire button

### Additional Drawers

Operator Profile Viewer (brain icon):
- 4 signal classification buckets (bar charts)
- Accepted/rejected pattern tag clouds
- Taste dimensions radar chart (7 axes)
- Anti-learning flags
- `Reset learnings` button

Taste Memory Viewer (palette icon):
- Timeline of last 30 taste signals
- 7 taste dimension fill bars
- Latest Sonnet-synthesized narrative (full text)
- Rate limit indicator for next synthesis

Memory Inspector (layers icon):
- 3-tier memory: working, session, long-term
- Compression stats
- RAG chunk search box

Voice Diff Inspector (waveform icon):
- Raw vs normalized side-by-side
- Diff highlighting
- Cost of normalization

### The Trace Command

`/trace [question]` returns annotated execution trace:
```
→ Received: "should I use Opus for this design question?"
→ Slot 01 — Taste injected: 3 dimensions loaded
→ Slot 02 — Pre-classified: complexity=low, urgency=low, worker=fast
→ Slot 10 — Worker Dispatch: → fastWorker (free tier)
→ Voice normalization: 1 banned pattern removed
→ COMPLETE: $0.000 (free tier). 380ms wall clock.
```

---

## 3. Forge Mode Layout — 4-Zone Grid

```
┌──────────────────────┬─────────────────────┐
│                      │                     │
│   CHAT COCKPIT       │   BUILD TREE        │
│   (left, primary)    │   (right, primary)  │
│                      │                     │
├──────────────────────┴─────────────────────┤
│  FILE TREE   │   TEST RUNNER   │   DIFF    │
│  (bottom L)  │   (bottom C)    │  (bot R)  │
└──────────────────────────────────────────────┘
```

Bottom strip collapses to status bar.

### Zone 1 — Forge Chat Cockpit

Agent with tools (file read/write, bash, test runner). Messages have two layers:
- Layer 1: Live narration of actions
- Layer 2: Collapsed summary card with tool calls, file changes, test results

### Zone 2 — Build Tree (Core Widget)

Persistent SwiftUI-hosted React panel. Driven by SSE events.

Each tree node:
- Status dot: ○ pending, ● spinning, ✓ done, ✗ failed
- Task label (plain language)
- Expanded: files read/written, commands ran, duration
- Cost badge per task
- → arrow to jump to Diff zone

Tree states:
- PLANNING — agent decomposing task
- EXECUTING — live progress
- AWAITING APPROVAL — operator must approve before proceeding

AUTO-APPROVE toggle available.

### Zone 3 — File Tree

Scoped to `ronin-core/`. Three layers:
- Currently open (blue eye icon)
- Modified (orange pencil icon)
- Test coverage (green/red/grey per file)

File stats: token count, last modified, test count badge.

### Zone 4a — Test Runner

Live streaming test output:
- Currently running file (spinner)
- Pass/fail counts updating in real-time
- Failed test names with error messages inline
- Total count + elapsed time

### Zone 4b — Diff View

Unified diff format. RONIN-styled (muted green additions, muted red removals).
Controls: ← PREV / NEXT →, REVERT THIS FILE, COPY PATCH

### Zone 4c — VM Control Panel

Collapsible within bottom strip:
- Active container: ID, image, uptime, CPU/memory
- SPIN UP NEW SANDBOX
- CLONE CURRENT
- DESTROY ALL
- Named sandbox rows, targetable via `@sandbox-2`

---

## 4. Shared Widget Library

```
macos-shell/src/app/components/
├── shared/
│   ├── LiveTaskTree.tsx      — Build tree nodes with SSE subscription
│   ├── StreamingText.tsx     — Token-by-token animated text
│   ├── ModelBadge.tsx        — Seat + tier display (never raw model ID)
│   ├── CostMeter.tsx         — Running cost (small badge or expanded panel)
│   ├── PipelineRail.tsx      — 13-dot pipeline visualizer (compact/expanded)
│   ├── FileDiff.tsx          — Unified diff with syntax highlighting
│   ├── SandboxCard.tsx       — VM/container card with status + controls
│   └── TestStatusBar.tsx     — Compact pass/fail/total summary
├── forge/
│   ├── ForgeView.tsx         — 4-zone layout
│   ├── ForgeCockpit.tsx      — Chat with agent
│   ├── ForgeBuildTree.tsx    — Right panel (uses LiveTaskTree)
│   ├── ForgeFileTree.tsx     — Bottom left
│   ├── ForgeTestRunner.tsx   — Bottom centre
│   ├── ForgeDiff.tsx         — Bottom right (uses FileDiff)
│   └── ForgeVMPanel.tsx      — VM control (uses SandboxCard)
└── dev-window/
    ├── DevWindowView.tsx
    ├── ModelRail.tsx
    ├── CostPanel.tsx
    └── PipelineInspector.tsx  — (uses PipelineRail)
```

---

## 5. Security Decisions

1. **Prompt injection**: Firewall layer in tool registry sanitizes file read results
2. **Self-modification loop**: Protected files list — intelligence/ and execution/runTask.mjs require double-confirmation
3. **Container config**: No --privileged, no socket mount, no host network, resource limits
4. **API key exposure**: Blocklist in read_file tool: .env, *.pem, *.key, secrets.*
5. **Test side effects**: NODE_ENV=test enforced, integration tests require explicit permission
6. **Voice module**: NEVER accessible from Forge agent. Baked into architecture, not a runtime decision.

---

## 6. Server Endpoints (New for Forge)

```
POST   /api/forge/start                    → starts session, spins up container
POST   /api/forge/:id/message              → routes to Forge agent
GET    /api/forge/:id/tree                  → current task tree snapshot
POST   /api/forge/:id/approve              → operator approval to proceed
POST   /api/forge/:id/sandbox/create       → spin up additional VM
DELETE /api/forge/:id/sandbox/:sandboxId   → destroy a VM
GET    /api/forge/:id/files                → file tree snapshot
GET    /api/forge/:id/diff/:filename       → diff for a specific file
```

---

## 7. Native vs React Split

Native SwiftUI: window, tab bar, Forge mode toggle, keyboard shortcuts, WKWebView container, ForgeSessionManager (lifecycle)

React (WKWebView): everything inside Forge view, all widgets, all panels, all real-time rendering

Communication: Swift → React via WKWebView JavaScript message bridge (session ID, lifecycle events)

---

## 8. Mobile Surface Notes (Future)

- Build Tree widget is the primary mobile Forge surface
- Chat cockpit adapts to single-column
- Diff/File Tree/Test Runner become swipeable panels
- VM control reduced to status indicator only (management stays on desktop)
- Cost panel becomes a persistent floating badge (bottom-right)

---

*This document is the source of truth for all RONIN Forge and Dev Window UI decisions.*
*Read before building. Update after shipping.*
