# RONIN — Production Architecture
**Target: 100 concurrent operators | Multi-model OS | Zero-UI model exposure**
_Last updated: March 2026_

---

## 0. The Single Governing Principle

> "What is the cheapest model that can safely execute this task?"

Every architectural decision in this document flows from that question. The user sees RONIN. The system decides which intelligence runs. These are permanently decoupled.

---

## 1. System Overview

```
Operator Input
      ↓
[Pre-flight: 150ms parallel]
  ├── Task Classifier (Groq/Llama — free)
  └── Context Compressor (Groq/Llama — free)
      ↓
[Request Queue — BullMQ]
  ├── Priority lanes: live | standard | background
  └── Rate-limit aware scheduling
      ↓
[Intelligence Router]
  → fast lane    → Groq / Llama (free)
  → standard     → Sonnet 4.6 (paid)
  → specialist   → GPT-4o / o3-mini / GPT-4o-mini (paid)
  → director     → Opus 4.6 (on-demand only, /director command)
  → background   → Gemini Flash-Lite / Gemini Embedding (free)
      ↓
[Validation Layer]
  → structured output enforcement
  → schema validation
  → escalation trigger
      ↓
[Escalation Engine]
  groq → gemini_flash → sonnet → throw
  (Opus never auto-escalates — /director only)
      ↓
[SSE Stream → macOS SwiftUI Client]
      ↓
[Post-Response]
  ├── Cost Logger
  ├── Memory Update
  └── RAG Index Update
```

---

## 2. Infrastructure

### Deployment Target (100 concurrent users)

| Component | Choice | Reason |
|---|---|---|
| Runtime | Node.js 22 ESM | Existing codebase, async streaming, OpenAI-compatible SDK |
| Queue | BullMQ + Redis | Priority lanes, rate-limit awareness, job retries |
| Cache | Redis | Session state, rate-limit counters, dedup |
| RAG store | Qdrant (self-hosted) | Vector search, free, runs on same machine |
| Observability | Postgres + lightweight logger | Cost tracking, per-model failure rates |
| Hosting | Single VPS (8-core, 16GB) or Railway | 100 users is not a massive load if queue is right |
| Process manager | PM2 cluster mode | 4 workers × 2 threads = 8 Node.js processes |

### Why not Kubernetes yet

100 users with a well-structured queue does not need Kubernetes. A single 8-core VPS with PM2 handles ~500 concurrent SSE connections. Add K8s when you hit 1,000+ daily active users. Over-engineering at this stage burns weeks.

---

## 3. Folder Structure

```
ronin-core/
│
├── router/
│   ├── intelligence-router.mjs      ← EXISTS: scoring-based model selector
│   ├── taskSignals.mjs              ← Signal dictionaries (tech/reasoning/bulk)
│   └── providerRegistry.mjs        ← Model ID + cost constants
│
├── models/
│   ├── anthropicProvider.mjs       ← Claude Haiku / Sonnet / Opus
│   ├── openaiProvider.mjs          ← GPT-4o / o3-mini / GPT-4o-mini
│   ├── groqProvider.mjs            ← Llama 3.3 70B / Llama 3.1 8B (free)
│   └── geminiProvider.mjs          ← Flash / Flash-Lite / Embedding (free)
│
├── execution/
│   ├── runTask.mjs                 ← Main execution loop (classify → compress → route → call → validate)
│   ├── streamHandler.mjs           ← SSE token streaming
│   └── escalationEngine.mjs       ← Retry chain: groq → gemini → sonnet → throw
│
├── validation/
│   ├── structuredOutputValidator.mjs  ← JSON schema validation (Zod)
│   ├── codeValidator.mjs              ← AST checks for code output
│   └── confidenceScorer.mjs          ← Uncertainty detection in output
│
├── queue/
│   ├── bullQueue.mjs               ← BullMQ setup: live / standard / background lanes
│   ├── rateLimitGuard.mjs          ← Per-provider limit tracking in Redis
│   └── priorityScheduler.mjs       ← Route jobs to correct lane
│
├── memory/
│   ├── context-compressor.mjs      ← EXISTS: 3-zone compression via Groq
│   ├── warmMemory.mjs              ← Operator profile, preferences, active projects
│   ├── embeddings.mjs              ← Gemini Embedding (10M TPM free)
│   └── ragSearch.mjs               ← Qdrant vector search
│
├── rag/
│   ├── indexer.mjs                 ← Chunk files → embed → store in Qdrant
│   ├── chunker.mjs                 ← Smart chunking: function-boundary aware
│   └── retriever.mjs               ← Query → embed → top-k chunks → context
│
├── observability/
│   ├── costTracker.mjs             ← Token × price per model → daily totals
│   ├── failureLogger.mjs           ← Model / task / escalation failure rates
│   └── latencyMonitor.mjs          ← Per-model P50/P95 latency tracking
│
├── api/
│   ├── messageController.mjs       ← POST /cycles/:id/messages
│   ├── sseController.mjs           ← GET /events (SSE stream)
│   ├── memoryController.mjs        ← GET/POST /memory
│   └── directorController.mjs      ← POST /director (Opus, explicit only)
│
├── prompts/
│   ├── ronin-system.md             ← RONIN's core identity prompt (never changes)
│   ├── classification.mjs          ← Classifier prompt template
│   ├── compression.mjs             ← Summarization prompt template
│   └── director-brief.md           ← Opus director brief (different from RONIN identity)
│
└── config/
    ├── modelConfig.mjs             ← All model IDs, costs, rate limits, lane assignments
    └── costThresholds.mjs          ← Daily spend limits per model tier
```

---

## 4. Model Seat Architecture

A seat is a named role with a contract. It is not a model ID. The model underneath a seat can change — the seat's behavior contract does not.

RONIN operates on six named seats. The operator only ever sees two of them (RONIN and Director). The other four are invisible infrastructure.

---

### Seat 1 — RONIN Core
**The voice. The operator only ever talks to this seat.**

| Property | Value |
|---|---|
| Primary model | Sonnet 4.6 |
| Fallback model | GPT-4o (if Anthropic outage only) |
| Persona | RONIN identity prompt — loaded on every call, never modified at runtime |
| Tone contract | Operator colleague, not assistant. No "I'm sorry", no "I cannot" preambles. |
| Permitted | All operator-facing responses. Code, design critique, architecture, conversation. |
| Prohibited | Never auto-escalated to Opus. Never replaced by Groq/Gemini for operator responses. |
| Context | Always receives compressed context (context-compressor.mjs output). |
| Streaming | Always SSE, token-by-token. Never batch. |

The RONIN voice contract applies regardless of which model executes it. If Sonnet 4.6 is unavailable and GPT-4o runs instead, the system prompt and persona are identical. The operator perceives no change.

---

### Seat 2 — Director
**The second opinion. Invoked deliberately. Never automatic.**

| Property | Value |
|---|---|
| Model | Opus 4.6 (Anthropic) |
| Activation | Explicit `/director` command only |
| Persona | Director brief — separate system prompt from RONIN identity. Consultant, not colleague. |
| Permitted | Architecture review, deep critique, critical product decisions, second opinions. |
| Prohibited | Auto-escalation from failed Sonnet calls. Answering quick questions. Background tasks. |
| Cost guard | Checked against daily Opus budget before every call. Refused if over threshold. |
| UI signal | Shows "RONIN is reviewing..." indicator. The only time a different label appears. |

---

### Seat 3 — Ops
**The background engine. Never speaks. Runs everything the operator doesn't see.**

| Property | Value |
|---|---|
| Primary model | Llama 3.3 70B via Groq (free) |
| Secondary model | Llama 3.1 8B via Groq (free, for simpler ops) |
| Permitted | Task classification, context compression, intent routing, commit messages, bulk text, quick replies (< 20 token input). |
| Prohibited | Operator-facing responses. Code generation for production use. Architecture decisions. |
| Output contract | Always structured JSON. response_format enforced on every call. |
| Fallback | If Groq rate-limited → Gemini Flash-Lite for ops tasks. |
| Daily budget | 14,400 requests/day free. Ops seat never spends money under normal conditions. |

---

### Seat 4 — Analyst
**The long-context processor. File trees, docs, background synthesis.**

| Property | Value |
|---|---|
| Primary model | Gemini 2.5 Flash-Lite (free, 1,000 RPD) |
| Secondary model | Gemini 2.5 Flash (free, 250 RPD — reserved for higher complexity) |
| Permitted | File tree analysis, test scaffold generation, background summarization, structured data extraction from large documents. |
| Prohibited | Operator-facing responses. Real-time user interaction. Core code generation. |
| Context window use | 1M context used only when document genuinely requires it (PDFs, long specs). Never for code repos — RAG handles those. |
| Output contract | Structured JSON or Markdown. Never free-form prose to operator. |

---

### Seat 5 — Memory
**The retrieval engine. Runs the entire RAG and embedding layer.**

| Property | Value |
|---|---|
| Model | Gemini Embedding (text-embedding-004) — 10M TPM free |
| Permitted | Embedding all text for vector storage. Query embedding for RAG retrieval. Semantic similarity search. |
| Prohibited | Any generative output. Never produces text for the operator. |
| Storage | Qdrant (self-hosted vector DB) |
| Run cadence | Index on file save / git commit. Query on every code-related prompt before Sonnet call. |
| Cost | Zero. Embedding is always free tier. This seat has no budget allocation. |

---

### Seat 6 — Specialist
**The precision instrument. Routed to for tasks where generic models genuinely underperform.**

Three specialist slots, activated by signal scoring:

| Slot | Model | Activated by | Prohibited from |
|---|---|---|---|
| Reasoner | o3-mini | Debugging signals, "why is", error stacks, algorithm tasks | Conversation, quick replies, anything Sonnet handles fine |
| Vision | GPT-4o | Image attached (hard override) | Text-only tasks, anything without image input |
| Scribe | GPT-4o-mini | Bulk output patterns (10+ items, docs, jsdoc) | Single responses, anything requiring judgment |

Specialist slots are activated by the intelligence-router signal scorer, never by the user explicitly. The user does not know which specialist ran.

---

### Seat interaction rules

1. Seats 3, 4, 5 (Ops, Analyst, Memory) never produce operator-visible output under any circumstance.
2. Seat 1 (RONIN Core) is the only seat that streams to the operator in real time.
3. Seat 2 (Director) produces operator-visible output but is visually distinguished with a "reviewing" state.
4. Seat 6 (Specialist) output feeds back through Seat 1's voice contract before reaching the operator.
5. No seat can promote itself to a higher seat. Promotion is only via the escalation engine (Seats 3→4→1) or explicit operator command (Seat 2).

---

### Seat map vs model map

```
What the operator sees:        What actually runs:
─────────────────────────      ──────────────────────────────────────────
                               [pre-flight]
                               Seat 3 Ops → Llama 3.1 8B (classify)
                               Seat 3 Ops → Llama 3.3 70B (compress)
RONIN  ←───────────────────── Seat 1 Core → Sonnet 4.6
                                 OR
                               Seat 6 Reasoner → o3-mini (if debug)
                                 OR
                               Seat 6 Vision → GPT-4o (if image)
                               [post-response]
                               Seat 5 Memory → Gemini Embedding (index)
                               Seat 4 Analyst → Gemini Flash-Lite (background)
─────────────────────────      ──────────────────────────────────────────
Director  ←────────────────── Seat 2 Director → Opus 4.6 (/director only)
```

---

## 4a. Model Allocation Table (Seat-Referenced)

| Task | Seat | Model | Provider | Cost tier | Daily free cap |
|---|---|---|---|---|---|
| Task classification | Seat 3 — Ops | Llama 3.1 8B | Groq | Free | 14,400 req |
| Context compression | Seat 3 — Ops | Llama 3.3 70B | Groq | Free | 14,400 req |
| Quick reply (< 20 tokens input) | Seat 3 — Ops | Llama 3.3 70B | Groq | Free | 14,400 req |
| Commit message / bulk text | Seat 3 — Ops | Llama 3.3 70B | Groq | Free | 14,400 req |
| File tree analysis | Seat 4 — Analyst | Gemini 2.5 Flash-Lite | Google | Free | 1,000 req |
| Test scaffold generation | Seat 4 — Analyst | Gemini 2.5 Flash | Google | Free | 250 req |
| Codebase embedding (RAG) | Seat 5 — Memory | Gemini Embedding | Google | Free | 10M TPM |
| Docs generation | Seat 3 — Ops | Llama 3.3 70B | Groq | Free | 14,400 req |
| Schema / API design (light) | Seat 1 — Core | Haiku 4.5 | Anthropic | Paid-$ | — |
| SwiftUI / R3F / GSAP code | Seat 1 — Core | Sonnet 4.6 | Anthropic | Paid-$$ | — |
| RONIN core conversation | Seat 1 — Core | Sonnet 4.6 | Anthropic | Paid-$$ | — |
| Architecture decisions | Seat 1 — Core | Sonnet 4.6 | Anthropic | Paid-$$ | — |
| Complex debugging / logic | Seat 6 — Specialist (Reasoner) | o3-mini | OpenAI | Paid-$ | — |
| Bulk structured output | Seat 6 — Specialist (Scribe) | GPT-4o-mini | OpenAI | Paid-$ | — |
| UI/image critique | Seat 6 — Specialist (Vision) | GPT-4o | OpenAI | Paid-$$ | — |
| Director review | Seat 2 — Director | Opus 4.6 | Anthropic | Paid-$$$$ | /director only |

---

## 5. Rate Limit Math (100 Concurrent Users)

### Free tier bottleneck analysis

**Groq (free):** 30 RPM shared across all users.
At 100 users, if 30% send messages simultaneously = 30 requests/minute.
Groq free tier holds at exactly 100 users without queuing overhead.
At 50% concurrency = 50 req/min → queue kicks in, max 20s delay per overflow.

**Gemini Flash-Lite (free):** 15 RPM, 1,000 RPD.
Background tasks only — not user-facing. At 100 users/day, budget is 10 background calls per user per day. Sufficient for file analysis, test scaffolds.

**Gemini Embedding (free):** 10M TPM.
Not a bottleneck. Entire codebase embedding runs continuously without hitting limits.

**Sonnet 4.6 (paid Tier 1):** 2,000 RPM.
100 users × 1 req/min = 100 RPM. Sonnet is never the bottleneck.

### Queue priority lanes

```
Lane 1 — LIVE (user is watching, SSE active)
  Priority: highest
  Models: Sonnet, GPT-4o, o3-mini
  Max queue depth: 10 jobs
  SLA: first token < 800ms

Lane 2 — STANDARD (user triggered, not blocking UI)
  Priority: medium
  Models: Groq, Gemini Flash
  Max queue depth: 50 jobs
  SLA: complete < 5s

Lane 3 — BACKGROUND (system-initiated, async)
  Priority: lowest
  Models: Groq, Gemini Flash-Lite, Gemini Embedding
  Max queue depth: unlimited
  SLA: complete < 60s
```

---

## 6. The Execution Loop

Every message follows this exact path. No exceptions.

```javascript
// execution/runTask.mjs
export async function runTask(message, conversationId, context = {}) {

  // Step 1: Pre-flight — parallel, ~150ms
  const [decision, compressed] = await Promise.all([
    router.route(message, context),            // intelligence-router.mjs
    compressor.compress(history, conversationId) // context-compressor.mjs
  ]);

  // Step 2: Queue — assign to correct priority lane
  const job = await queue.add(decision.lane, {
    message, compressed, decision, conversationId
  });

  // Step 3: Execute in worker
  const stream = await callModel(decision, compressed, message);

  // Step 4: Stream via SSE
  for await (const chunk of stream) {
    sse.send('ronin.stream', { content: chunk });
  }

  // Step 5: Validate
  const fullResponse = await collectStream(stream);
  const valid = await validate(fullResponse, decision.taskType);

  if (!valid) {
    return await escalate(message, decision.taskType, decision.modelKey);
  }

  // Step 6: Post-response
  await Promise.all([
    costTracker.log(decision.modelId, inputTokens, outputTokens),
    warmMemory.updateAfterSession(conversationId, fullResponse),
    ragIndexer.maybeIndex(fullResponse, conversationId) // only if code output
  ]);

  return fullResponse;
}
```

---

## 7. Validation Layer (Real Implementation)

String matching is not validation. Every task that produces structured output uses forced schema mode.

```javascript
// validation/structuredOutputValidator.mjs
import { z } from 'zod';

const schemas = {
  api_schema: z.object({
    endpoints: z.array(z.object({
      method: z.enum(['GET','POST','PUT','DELETE','PATCH']),
      path: z.string().startsWith('/'),
      description: z.string().min(1)
    })),
    models: z.array(z.string())
  }),

  task_classification: z.object({
    taskType: z.enum(['code','design','conversation','architecture','debug','bulk']),
    confidence: z.number().min(0).max(1),
    signals: z.array(z.string())
  }),

  code_output: z.object({
    language: z.string(),
    code: z.string().min(10),
    explanation: z.string().optional()
  })
};

export function validateStructured(response, taskType) {
  const schema = schemas[taskType];
  if (!schema) return { valid: true }; // no schema = prose output, skip

  try {
    const parsed = JSON.parse(response);
    schema.parse(parsed);
    return { valid: true, parsed };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}
```

When calling models for structured tasks, always force the format:
```javascript
// Anthropic
body: { ..., response_format: { type: 'json_object' } }

// Groq / OpenAI compatible
body: { ..., response_format: { type: 'json_object' } }

// Gemini
body: { ..., generationConfig: { responseMimeType: 'application/json', responseSchema: schema } }
```

---

## 8. Escalation Engine

```javascript
// execution/escalationEngine.mjs

// The chain. Opus is not in it.
const CHAIN = {
  groq_llama:     'gemini_flash',
  gemini_flash:   'sonnet',
  sonnet:         null          // end of chain — throw
};

export async function escalate(message, taskType, failedModelKey) {
  let modelKey = CHAIN[failedModelKey];

  while (modelKey) {
    const decision = { ...router.getModelConfig(modelKey), taskType };
    const response = await callModel(decision, message);
    const result = validateStructured(response, taskType);

    if (result.valid) {
      costTracker.logEscalation(failedModelKey, modelKey);
      return response;
    }

    modelKey = CHAIN[modelKey];
  }

  // All models failed — log, alert, return structured error
  failureLogger.logCritical({ message, taskType, failedChain: true });
  throw new Error(`RONIN: All models failed on ${taskType} task`);
}
```

---

## 9. RAG Pipeline (Chunked, Not Context Dump)

**Rule: never pass a full repo to any model. Embed once, retrieve always.**

### Indexing (runs on file save / git commit hook)

```
File change detected
      ↓
chunker.mjs — splits by function/class boundaries (not character count)
      ↓
Gemini Embedding API — embeds each chunk (free, 10M TPM)
      ↓
Qdrant — stores [vector, metadata: {file, function, lines, language}]
```

### Retrieval (runs before every code-related prompt)

```
User prompt → embed query (Gemini Embedding, ~50ms)
      ↓
Qdrant similarity search → top 5 chunks
      ↓
Build context: [chunk1, chunk2, ...] + user prompt
      ↓
Total context: ~4K tokens (vs 800K for full dump)
      ↓
Pass to Sonnet / o3-mini
```

### Chunking strategy

```javascript
// rag/chunker.mjs
// Split by semantic boundaries, not character count
// Target: 512 tokens per chunk, max 1024
// Split at: function boundaries, class definitions, export statements
// Never split: mid-function, mid-import block
// Overlap: 64 tokens between adjacent chunks (for context continuity)
```

---

## 10. Cost Tracking (Real Implementation)

```javascript
// observability/costTracker.mjs

const PRICE_PER_MILLION = {
  'claude-sonnet-4-6':       { input: 3.00,  output: 15.00 },
  'claude-haiku-4-5':        { input: 0.25,  output: 1.25  },
  'claude-opus-4-6':         { input: 15.00, output: 75.00 },
  'gpt-4o':                  { input: 2.50,  output: 10.00 },
  'gpt-4o-mini':             { input: 0.15,  output: 0.60  },
  'o3-mini':                 { input: 1.10,  output: 4.40  },
  'llama-3.3-70b-versatile': { input: 0.00,  output: 0.00  },
  'gemini-2.5-flash':        { input: 0.00,  output: 0.00  }, // free tier
  'gemini-2.5-flash-lite':   { input: 0.00,  output: 0.00  },
  'text-embedding-004':      { input: 0.00,  output: 0.00  }
};

export function calculateCost(modelId, inputTokens, outputTokens) {
  const rates = PRICE_PER_MILLION[modelId];
  if (!rates) return 0;
  return (inputTokens / 1_000_000 * rates.input) +
         (outputTokens / 1_000_000 * rates.output);
}

export async function log(modelId, inputTokens, outputTokens, taskType) {
  const cost = calculateCost(modelId, inputTokens, outputTokens);
  // write to Postgres: {timestamp, modelId, inputTokens, outputTokens, cost, taskType}
  // increment daily total in Redis for fast threshold checks
  await redis.incrbyfloat(`cost:daily:${today()}`, cost);
}

// Daily cost guardrail — checked before every Opus / GPT-4o call
export async function canAfford(modelId) {
  const dailySpend = parseFloat(await redis.get(`cost:daily:${today()}`) || 0);
  const thresholds = { 'claude-opus-4-6': 5.00, 'gpt-4o': 10.00 }; // per day
  return dailySpend < (thresholds[modelId] ?? Infinity);
}
```

---

## 11. Rate Limit Guard

```javascript
// queue/rateLimitGuard.mjs

const LIMITS = {
  groq:           { rpm: 30,   rpd: 14400 },
  gemini_flash:   { rpm: 10,   rpd: 250   },
  gemini_lite:    { rpm: 15,   rpd: 1000  },
  gemini_embed:   { rpm: null, tpm: 10_000_000 }
};

export async function canCall(provider) {
  const rpm = parseInt(await redis.get(`ratelimit:${provider}:rpm`) || 0);
  const rpd = parseInt(await redis.get(`ratelimit:${provider}:rpd`) || 0);
  const limit = LIMITS[provider];

  if (limit.rpm && rpm >= limit.rpm) return false;
  if (limit.rpd && rpd >= limit.rpd) return false;
  return true;
}

export async function recordCall(provider) {
  await redis.incr(`ratelimit:${provider}:rpm`);
  await redis.incr(`ratelimit:${provider}:rpd`);
  // RPM key expires in 60s, RPD key expires at midnight
}

// intelligence-router.mjs checks this before selecting free models
// If groq is rate-limited → route to gemini_flash
// If both free tiers saturated → route directly to Sonnet (note the cost)
```

---

## 12. API Contract

```
POST   /api/cycles                        → create new conversation cycle
POST   /api/cycles/:id/messages           → send message → full execution loop
GET    /api/events                        → SSE stream (persistent connection per client)
POST   /api/director                      → invoke Opus explicitly (/director command)
GET    /api/memory/:cycleId               → current warm context
POST   /api/memory/compress-reset/:id    → clear summary, restart compression
GET    /api/metrics/cost                  → today's spend by model (internal only)
GET    /api/metrics/health               → queue depths, provider status, error rates
```

SSE event vocabulary:
```
ronin.state        { label: 'thinking' | 'reviewing' | null }
ronin.stream       { content: string, accumulated: string }
ronin.complete     { fullResponse: string, model: string (internal only), cost: number }
ronin.error        { message: string, recoverable: boolean }
system.ratelimit   { provider: string, retryAfter: number }
```

Note: `model` is included in `ronin.complete` for internal cost logging only. It is never surfaced to the macOS client UI.

---

## 13. Failure Modes and Handling

| Failure | Detection | Response |
|---|---|---|
| Groq 429 (rate limit) | `error.status === 429` | Increment Redis counter, route to Gemini Flash |
| Gemini 429 | `error.status === 429` | Route to Sonnet, log free tier saturation |
| Validation failure | Zod parse error | Trigger escalation chain |
| All models fail | Escalation chain exhausted | Return structured error, log critical |
| Silent hallucination | Confidence score < threshold | Flag response, optionally trigger second-model check |
| Cost threshold exceeded | Redis daily total > limit | Downgrade model tier for remainder of day |
| Context too long | Token count > model limit | Force context compression before retry |
| Qdrant unreachable | Connection refused | Fall back to warm memory only (no RAG), log degraded mode |

---

## 14. Cost Projection (100 Users/Day)

Assumptions: 100 users, 20 messages/day each = 2,000 messages/day.
Distribution: 60% chat/quick, 30% code/design, 10% debug/architecture.

| Model | Daily requests | Est. tokens | Daily cost |
|---|---|---|---|
| Groq / Llama (classifier + compression + quick) | ~2,400 | 2.4M | $0 |
| Gemini Flash-Lite (background ops) | ~200 | 500K | $0 |
| Gemini Embedding (RAG) | ~2,000 | 4M | $0 |
| Haiku 4.5 (light API/schema tasks) | ~150 | 300K | ~$0.10 |
| Sonnet 4.6 (core code + conversation) | ~700 | 2.8M | ~$12 |
| o3-mini (debugging) | ~100 | 500K | ~$0.60 |
| GPT-4o-mini (bulk output) | ~80 | 200K | ~$0.04 |
| GPT-4o (image critique, vision) | ~30 | 150K | ~$0.50 |
| Opus 4.6 (director, explicit only) | ~10 | 100K | ~$1.50 |
| **Total** | | | **~$15/day** |

At $15/day for 100 users = $0.15/user/day = ~$4.50/user/month. If you charge $20/user/month, that's a ~77% gross margin before infrastructure.

---

## 15. What Is Not Built Yet (Execution Order)

| Item | Priority | Phase |
|---|---|---|
| BullMQ queue + Redis setup | P0 | Phase 1 |
| Provider clients (Groq, Gemini, Anthropic, OpenAI) | P0 | Phase 1 |
| Rate limit guard in Redis | P0 | Phase 1 |
| Zod validation schemas for each task type | P0 | Phase 1 |
| Real cost tracker (Postgres write) | P0 | Phase 1 |
| SSE streaming handler | P0 | Phase 1 |
| Gemini Embedding client | P1 | Phase 2 |
| Qdrant setup + indexer | P1 | Phase 2 |
| Chunker (function-boundary aware) | P1 | Phase 2 |
| Confidence scorer | P2 | Phase 3 |
| Multi-model consensus (high-risk tasks) | P2 | Phase 3 |
| Cost guardrail auto-downgrade | P2 | Phase 3 |

Items already built: `intelligence-router.mjs`, `context-compressor.mjs`, Anthropic provider streaming.

---

## 16. Architecture Invariants (Never Break These)

1. Model identity is never exposed to the client UI under any circumstance.
2. Opus is never auto-escalated to — only via explicit `/director` command.
3. Every structured output task uses forced JSON schema mode, not string validation.
4. The free tier (Groq + Gemini) absorbs all classification, compression, and background work.
5. Sonnet handles all core operator work. It is the voice of RONIN.
6. Context is always compressed before being passed to any paid model.
7. RAG retrieval is always chunked retrieval. Full repo context dump is never used as a default.
8. Cost is tracked per token, per model, per day. No exceptions.
9. The escalation chain ends at Sonnet. Beyond that, fail loudly with a structured error.
10. Every provider call is wrapped in try/catch with 429 detection and Redis counter increment.

---

_This document is the single source of truth for RONIN's backend architecture.
All implementation decisions that contradict this document need explicit ADR justification._

---

## 17. Scaling Roadmap

Growth breaks different things at different thresholds. Each tier below identifies what breaks, what to fix, and in what order.

---

### Tier 0 — Current: 100 concurrent users

**What holds:** PM2 cluster (4 workers), single Redis, single Qdrant, Groq free tier at 30 RPM.
**What you're watching:** Groq RPM counter in Redis. If it consistently hits 28+/min, you're one traffic spike from degraded responses.
**Cost:** ~$15/day.

---

### Tier 1 — 500 concurrent users

**What breaks first:** Groq free tier. At 500 users with 30% concurrency = 150 simultaneous requests/min hitting a 30 RPM cap. Queue depth on the background lane explodes. Ops seat starts failing silently.

**Fixes:**
- Upgrade Groq to paid dev tier (~$0.59/1M tokens on Llama 3.3 70B — still very cheap).
- Add Together AI as a second Llama inference provider behind the same Ops seat. Round-robin between Groq and Together to double effective RPM.
- Gemini Flash-Lite hits 1,000 RPD — move all Analyst seat tasks that can to Groq (background summarization, file tree).
- Scale PM2 to 8 workers on a 16-core machine, or split into 2 × 8-core servers.
- Redis stays single-instance but move to dedicated machine (off app server).

**New cost floor:** ~$60/day (Groq paid + Together AI + infra).

---

### Tier 2 — 1,000 concurrent users

**What breaks first:** BullMQ queue latency. Single Redis handling queue state + rate limit counters + session cache + cost tracking under 1K users creates lock contention. P95 latency on queue operations starts creeping above 50ms.

**Also breaking:** Qdrant single-node starts showing query latency above 100ms at high concurrency. RAG retrieval becomes the bottleneck for code-heavy sessions.

**Fixes:**
- Split Redis into two instances: one for BullMQ queue state, one for session/cache/rate-limits.
- Qdrant: add a second read replica. All retrieval queries go to replica, writes to primary.
- Introduce horizontal scaling: 3 × app servers behind a load balancer (NGINX or Caddy). BullMQ workers connect to the same Redis queue — load is naturally distributed.
- Add provider health checks: poll Anthropic/OpenAI/Groq status endpoints every 60s. Pre-emptively route around degraded providers before users feel it.
- First formal SLO: Seat 1 (RONIN Core) first token < 800ms at P95.

**Infrastructure shape:**
```
Load Balancer (Caddy)
├── App Server 1 (PM2 × 4 workers)
├── App Server 2 (PM2 × 4 workers)
└── App Server 3 (PM2 × 4 workers)

Redis Primary (queue) + Redis Replica (cache/session)
Qdrant Primary + Qdrant Read Replica
Postgres (cost tracking, logs)
```

**New cost floor:** ~$120/day (infra + model spend).

---

### Tier 3 — 5,000 concurrent users

**What breaks first:** Sonnet 4.6 becomes the cost problem, not the capacity problem. At 5K users × 20 messages/day × 30% going to Sonnet = 30,000 Sonnet calls/day. At ~$0.05/call average, that's $1,500/day. Margins compress.

**Also breaking:** Single Postgres instance for observability starts showing write contention. Cost tracking inserts at 30K+/day with indexes get slow.

**The local model lever activates here.** This is Phase 4 in the product roadmap. A fine-tuned local model handling 60-70% of Sonnet's current tasks cuts Sonnet spend by the same percentage.

**Fixes — infrastructure:**
- Kubernetes (finally justified). Deploy on GKE or EKS. Horizontal Pod Autoscaler on app tier based on BullMQ queue depth.
- Qdrant cluster: 3-node with consistent hashing sharding.
- Postgres → read replicas for observability queries. TimescaleDB extension for cost time-series.
- CDN for static assets if RONIN has a web component.

**Fixes — model cost:**
- Begin local model pipeline. Mac Mini M4 fleet running Ollama with `qwen2.5-coder:7b` or similar.
- Routing logic: complexity score < 15 → local model. Complexity ≥ 15 → Sonnet. This immediately deflects ~40% of Sonnet traffic.
- Fine-tuning pipeline: log every Sonnet interaction → curate high-quality examples → LoRA fine-tune on Qwen base → redeploy to Ollama. First run produces the RONIN-v1 local model.
- Local model routing is invisible to the user. It runs under Seat 1 (RONIN Core). If local model confidence score < threshold, escalate to Sonnet. The user never knows.

**Local model routing architecture:**
```
Seat 1 — Core receives request
      ↓
Complexity score from Ops seat
      ↓
Score < 15 → Local model (Ollama, $0/call)
Score ≥ 15 → Sonnet 4.6 ($$$)
Local output confidence < 0.7 → escalate to Sonnet silently
```

**New cost floor:** ~$400/day (5K users), but with local model handling 60%+ of calls, effective Sonnet spend drops to ~$180/day.

---

### Tier 4 — 10,000 concurrent users

**What breaks first:** Single-region latency for global users. SSE connections from Bengaluru to a US-East server add 180-200ms baseline latency on every streamed token. If RONIN is global, this is felt.

**Also breaking:** The operator profile and warm memory system is currently single-tenant in design. At 10K users, per-operator memory isolation, access controls, and data residency become requirements.

**Fixes — infrastructure:**
- Multi-region: deploy app tier in US-East + EU-West + AP-South (India). Route users to nearest region.
- Qdrant per-region with async replication for shared knowledge bases. Per-operator vector collections stay in user's home region.
- Redis Cluster (not just replicas) — distributed across regions with active-active for session data.
- Dedicated model inference endpoints: negotiate provisioned throughput with Anthropic for Sonnet. Eliminates cold-start latency variance.

**Fixes — product:**
- Operator memory isolation: each operator's warm memory, RAG index, and taste model lives in an isolated namespace in Qdrant and Redis. No cross-contamination.
- Team/org support: shared RAG indexes per team, individual operator profiles. This is the multi-tenant unlock.
- Usage-based billing infrastructure: per-operator cost tracking feeds into billing system. RONIN becomes a product, not a tool.

---

### Tier 5 — Local model maturity (model-independent future)

At some point — likely during Tier 3-4 — the fine-tuned local model becomes good enough that cloud models are the exception, not the rule. This is the target state.

**Target distribution at maturity:**
```
80% of calls → Local fine-tuned RONIN model (Ollama, $0)
15% of calls → Sonnet (complex code, design, architecture)
 4% of calls → Specialists (o3-mini, GPT-4o — specific tasks)
 1% of calls → Director Opus (explicit, deliberate)
```

**At this distribution, cost for 10K users:** ~$500/day (vs ~$15,000/day if everything ran on Sonnet).

**Fine-tuning pipeline (Phase 4+):**
```
Production interactions logged → quality filter (human + automated) →
curated dataset (5K-50K examples) →
LoRA fine-tune on Qwen 2.5 Coder 7B or Llama 3.3 8B →
eval against Sonnet on RONIN-specific tasks →
deploy to Ollama fleet if eval passes →
A/B route 10% of traffic → monitor quality score →
graduate to 50%, then 80% if quality holds
```

**The fine-tuned model learns:**
- RONIN's voice and persona (from logged Sonnet responses)
- Your project-specific patterns (PlotSync, UDIS, RONIN codebase conventions)
- Your stack preferences (R3F, GSAP, SwiftUI, Tailwind v4)
- Your communication style and terminology

This is the moat. A fine-tuned model that knows your taste, your stack, and your patterns is something no general-purpose model can replicate.

---

### Provider resilience at every tier

At every tier, the following provider risks need mitigation:

| Risk | Current exposure | Mitigation |
|---|---|---|
| Anthropic outage | Critical — Sonnet is RONIN's voice | GPT-4o as Seat 1 fallback, same system prompt, auto-activated on 503 |
| Groq rate limits | High at 100 users | Together AI as secondary Ops seat provider (Tier 1) |
| Gemini free tier cuts | Medium — happened Dec 2025 | Groq handles embedding fallback; paid Gemini tier at $0.10/1M is still near-zero |
| OpenAI outage | Low — specialist seat only | Seat 6 tasks queue until restored; non-blocking for core operator flow |
| Local model quality regression | Long-term risk | Always keep Sonnet as fallback escalation target; never remove the cloud path |

---

### Scaling invariants (never break at any tier)

1. Model identity is never exposed to the operator UI at any scale.
2. Seat contracts (role, persona, permissions) are preserved regardless of which model runs underneath.
3. The free tier (Ops + Memory seats) absorbs background work at every scale tier. Only operator-facing work is billable.
4. Local model path is always additive — cloud models remain available as fallback.
5. Observability (cost, latency, failure rates) is non-negotiable at every tier. Flying blind kills margins at scale.
6. Fine-tuning data is curated, not raw-logged. Quality of training data determines quality of the local model. Never skip the curation step.

---

_Sections 4–4a and 17 added March 2026. All other sections unchanged._
