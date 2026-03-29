# RONIN Orchestration Engine — v1.0

> A multi-agent AI orchestration engine built for the design-engineer.  
> Think, plan, execute, review — with your API key and full local control.

---

## What is this?

RONIN is a personal AI operating system. This repo contains the **orchestration engine** — the Node.js backend that powers multi-agent build cycles, streaming chat, job management, and real-time state via SSE.

It is not a SaaS product. It runs on your machine, uses your API key, and operates entirely under your control.

The engine was built alongside a native macOS SwiftUI shell (not included here) over 9 days of daily build sessions. This is the backend core — open-sourced at v1.0.

---

## Architecture

```
ronin-core/
├── api/              # chatServer, agentManager, cycleManager, SSE controller
├── compiler/         # Figma → code pipeline (design interpreter, semantic pass, visual regression)
├── config/           # Model config, env validation, BYOK registry
├── director/         # Creative Director — parallel directions, plan review
├── execution/        # Task runner
├── forge/            # Forge session, task tree, tool registry
├── gates/            # Build gates (durable build, parallel directions, sandboxed impl, deploy verify)
├── gateway/          # Auth, device registry, sync server, middleware
├── infra/            # Sandbox manager, migration manager, deploy config, Tailscale
├── intelligence/     # Confidence scorer, critic, cost guardrail, consensus, insight engine, renderer
├── middleware/       # Pipeline, pre-classifier, skill loader, loop detection, context summarizer
├── models/           # Provider registry — Anthropic, OpenAI, Gemini, Groq
├── observability/    # Cost tracker, dashboard
├── queue/            # Bull queue, priority scheduler, rate limit guard
├── rag/              # Chunker, embeddings, Qdrant client, retriever
├── router/           # Intelligence router
├── validation/       # Structured output validator
└── workers/          # Agent, fast, deep, codex, vision, local workers + dispatcher
```

The engine exposes a REST + SSE API on `localhost:8787`. Any frontend — web, native, CLI — can connect.

---

## Quick Start

### 1. Clone

```bash
git clone https://github.com/chaosarchitect/ronin-orchestration-engine.git
cd ronin-orchestration-engine
```

### 2. Install dependencies

```bash
cd ronin-core
npm install
cd ..
```

### 3. Configure environment

```bash
cp .env.example ronin-core/.env
```

Edit `ronin-core/.env` and add your API key:

```env
ANTHROPIC_API_KEY=sk-ant-...
# Optional — for multi-provider routing:
# OPENAI_API_KEY=sk-...
# GEMINI_API_KEY=...
# GROQ_API_KEY=...
```

### 4. Start the engine

```bash
./start.sh --engine-only
```

The server boots on `http://localhost:8787`.

---

## API Overview

| Endpoint | Method | Description |
|---|---|---|
| `/api/events` | `GET` (SSE) | Live event stream — tokens, job updates, state changes |
| `/api/chat/stream` | `POST` | Stream a chat message through the pipeline |
| `/api/cycles/start` | `POST` | Start a new build cycle |
| `/api/cycles/:id/approve-direction` | `POST` | Approve a creative direction |
| `/api/cycles/:id/revise-direction` | `POST` | Request direction revision |
| `/api/cycles/:id/approve-plan` | `POST` | Approve the implementation plan |
| `/api/cycles/:id/revise-plan` | `POST` | Revise plan with taste signals |
| `/api/state` | `GET` | Live cycle state, crew status |
| `/api/jobs` | `GET` | Active, queued, completed jobs |
| `/api/usage` | `GET` | Session token and cost usage |
| `/api/mcp/status` | `GET` | Connected tool status |
| `/api/diff` | `GET` | Latest git diff |
| `/api/file-tree` | `GET` | Current project file tree |

---

## Build Cycle

A RONIN build cycle moves through gates:

```
briefing → creative → dialogue → direction_review
→ architecture → plan_review → execution → integration_review → complete
```

Each gate is a managed state. The operator approves or revises at review gates. Workers execute in parallel during implementation.

---

## Multi-Provider Support

The engine routes to Anthropic, OpenAI, Gemini, or Groq depending on task type and cost thresholds. You only need one key to start — Anthropic is the default.

See `ronin-core/models/PROVIDERS_README.md` for routing logic.

---

## Running Tests

```bash
cd ronin-core
npm test
```

Tests use Jest with ESM support. Each module has a collocated `.test.mjs` file.

---

## What's NOT in this repo

- **Taste memory** — operator profile compression and taste signal injection (private, in-progress)
- **macOS SwiftUI shell** — the native desktop app (separate, not open-sourced)
- **Operator profiles** — personal `.env` and trained data

---

## Philosophy

Built by one design-engineer, for design-engineers.

No dashboard. No pricing page. No account required. You own the model, the memory, and the output.

This is a personal AI command center — not a tool you subscribe to.

---

## License

MIT — see [LICENSE](./LICENSE).

Built by [@chaosarchitect](https://github.com/chaosarchitect) · Day 1–9 · March 2026
