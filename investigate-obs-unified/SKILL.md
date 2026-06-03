---
name: investigate-obs-unified
description: Investigate a running app's behavior by querying its obs-unified collector — pull traces, logs, AI calls, replay sessions, profiles, actions, tool calls, evals, alerts, analyses, and structured evidence; pivot across signals to debug specific problems. Use whenever the user asks questions that need *runtime* telemetry data ("why is /api/checkout slow", "show me recent errors", "find the trace for my last request", "what's spiking AI cost this week", "pull session for user X"), or types `/investigate-obs-unified`. Also use after the instrument-obs-unified skill runs and the user wants to verify their changes are visible in the data. Don't use for instrumenting code (that's instrument-obs-unified) or deploying obs-unified itself (that's the obs-unified repo's README → Deploy the Collector).
---

This is the read-side companion to `instrument-obs-unified`. Where that skill *adds* observability to an app, this skill *uses* observability data to answer questions about a running app.

The collector exposes a rich `/internal/*` HTTP surface. This skill is a map of which endpoint answers which question, plus playbooks for the common multi-step investigations a developer reaches for.

The current product contract is evidence-first. Prefer structured IDs and pivots
over narrative summaries:

- Use `EvidenceReference` objects when present. They carry entity kind, entity
  ID, route, confidence, source, citations, and suggested next pivots.
- Use Connected Rail (`/internal/connected/<kind>/<id>`) as the default way to
  move between neighboring signals.
- Preserve confidence. Explicit action IDs are stronger evidence; fallback
  action IDs are useful but must be reported as inferred.
- Do not invent causality. If the rail reports an informative absence, say what
  is missing and which instrumentation would populate it.

## When this is the wrong skill

- The user wants to instrument an app → `instrument-obs-unified`.
- The user wants to deploy the obs-unified collector/dashboard itself → obs-unified repo's [README → "Deploy the Collector"](https://github.com/obs-unified/obs-unified/blob/main/README.md#1-deploy-the-collector).
- The user wants to read a stack trace from a single error message they pasted → just answer normally; don't ping the collector.
- The user wants conceptual / API-shape questions about obs-unified packages → just read the source / READMEs directly.

## Workflow

### 1. Establish collector access

You need:

- `OBS_COLLECTOR_URL` — base URL of the collector.
- An auth path. The collector's `/internal/*` routes are dashboard-authenticated. Three pragmatic options for an agent:
  1. **`OBS_DASHBOARD_TOKEN`** if the user has a programmatic dashboard token (cleanest).
  2. **`OBS_INGEST_KEY`** as `Authorization: Bearer <key>` — works on collectors configured to accept ingest keys for read endpoints (common for dev / self-hosted).
  3. **Browser session cookie** (`obs_session` cookie value) copied from a logged-in dashboard tab — fallback for ad-hoc investigations.

Confirm with the user which auth they want to use, then probe:

```bash
curl -sf -H "Authorization: Bearer $OBS_INGEST_KEY" \
  "$OBS_COLLECTOR_URL/internal/telemetry/overview?hours=1&limit=1" \
  > /dev/null && echo "OK: read access works" || echo "FAIL: auth or URL wrong"
```

If the probe fails, stop and walk the user through the auth fix before issuing more queries.

### 2. Classify the question

Before hitting endpoints, name what's being asked. Investigation prompts fall into a few shapes:

| Shape | Example prompts | Starting endpoint |
| --- | --- | --- |
| **Recent state** | "show me what's happening right now", "any errors in the last hour?" | `/internal/telemetry/overview` |
| **Specific request** | "trace for the request I just made", "look up trace `abc123`" | `/internal/telemetry/traces/:traceId` |
| **Service health** | "why is checkout-api slow?", "ops for users-api" | `/internal/telemetry/services/:service/operations` |
| **Cross-service** | "show me the service graph", "which service is the bottleneck?" | `/internal/telemetry/service-map` |
| **Specific user** | "user X says checkout is broken", "pull their recent sessions" | `/internal/users/:userId` |
| **AI cost / quality** | "why are LLM costs spiking?", "show me recent rag_faithfulness fails" | `/internal/ai/overview` → `/internal/ai/evaluations` |
| **Replay** | "watch the session where checkout failed" | `/internal/replays/:sessionId` |
| **Analyses** | "are there slow-query patterns?", "error clusters this week?" | `/internal/analyses/results` |
| **Alerts** | "what alerts have fired recently?" | `/internal/alerts/evaluations` |
| **Agent/tool behavior** | "which tool is failing?", "why did this agent write bad data?" | `/internal/actions/aggregates/*` → `/internal/connected/*` |
| **Profiles / code** | "what code is hot?", "which trace caused this profile frame?" | `/internal/profiles/:id` → `/internal/connected/profile/:id` |
| **Missing instrumentation** | "why is this trace incomplete?", "where should I add spans?" | trace detail/analysis evidence → suggested pivots |

When the user's question doesn't cleanly fit, default to "Recent state" and refine after seeing what's there.

### 3. Pivot

Investigation is rarely one query. The collector's `connected` endpoint lets you pivot from any anchor entity to its related signals:

```
GET /internal/connected/<kind>/<id>
  where kind ∈ { span, log, usage, ai_call, replay, alert, analysis, user, profile, action, agent_run, tool_call }
```

For span lookups the id is `<traceId>:<spanId>` (the endpoint needs both to bucket properly). For the others, the id is just the kind-specific id (user_id, session id for usage, log id, etc.). Pivoting from a *trace* is done via `connected/span/<traceId>:<spanId>` on any span in the trace — there is no plain `trace` kind.

The response includes the entity's parents, peers, children, and related signals — bucketed into `up`/`across`/`down`/`related`. Use this whenever you've found one anchor and need its neighbors instead of doing a separate query per signal type.

Read rail links as machine data, not just labels. Keep `entityKind`, `entityId`,
`href`, confidence metadata, and empty reasons in your notes. Empty reasons are
part of the debugging answer: they tell you whether a missing pivot needs better
instrumentation, a profile label, a propagated action ID, or a replay capture.

Typical pivot chains:

- **"Trace just failed"**: `traces/:id` -> look at child spans for the failing one -> `connected/span/<traceId>:<spanId>` -> logs, profiles, AI calls, actions, tools, evals.
- **"Endpoint is slow"**: `services/:service/operations` -> identify slow operation -> `telemetry/overview?service=X&q=opName` -> slowest trace -> hot span -> profile or instrumentation-gap evidence -> code reference.
- **"User reports broken behavior"**: `users/:userId` -> recent sessions -> suspect session -> `connected/usage/<sessionId>` -> replay, usage events, traces, logs, AI calls, and actions.
- **"AI cost spike"**: `ai/overview?hours=N` -> expensive session/call -> `connected/ai_call/<callId>` or `connected/span/<traceId>:<spanId>` -> action -> agent run -> tool/eval context -> prompt/model/version evidence.
- **"Unsafe autonomous write"**: autonomous review aggregate -> action/tool call -> mutation before/after evidence -> eval case or version diff.
- **"Hot profile frame"**: profile detail -> `connected/profile/<profileId>` -> sampled traces/spans -> causing action/tool/eval -> code reference if frame metadata exists.

### 4. Interpret responses

The response shapes follow OTel conventions for telemetry, with some obs-unified additions. A trace span has:

- `traceId`, `spanId`, `parentSpanId`
- `name`, `kind` (0=internal, 1=server, 2=client, 3=producer, 4=consumer)
- `startTimeUnixNano`, `endTimeUnixNano` — durations come from the diff
- `status` (`{ code, message }`) — 0=unset, 1=ok, 2=error
- `attributes` — flat key/value list
- `resource.attributes` including `service.name`
- For AI spans: `openinference.span.kind` (LLM, TOOL, RETRIEVER, CHAIN, EMBEDDING, AGENT), `llm.model_name`, `llm.provider`, `llm.token_count.{prompt,completion,total}`, `llm.cost.total_usd`, `ai.payload.input`, `ai.payload.output`
- For obs-unified click-to-trace: `obs.interaction.id` (root span only; child spans inherit via parent walk)

For logs:
- `severityText` / `severityNumber` (OTel scale: 5=DEBUG, 9=INFO, 13=WARN, 17=ERROR)
- `body`, `attributes`
- `traceId`, `spanId` (if logged inside a span)

When summarizing for the user, surface what's actionable — span name, duration, status, error message if any. Don't dump raw JSON unless they ask.

For evidence references:

- `entityKind` and `entityId` tell you what to query next.
- `route` or `href` is the dashboard link to show the user.
- `confidence` tells you how strongly to phrase the finding.
- `source` tells you which subsystem produced the evidence.
- `citations` and `suggestedNextPivots` are the agent's next-step menu.

### 5. Report findings

Structured handoff, not raw output:

```
Question: why is /api/checkout slow?

Investigation:
  • Hit services/checkout-api/operations: POST /api/checkout p95 = 1.4s (target 300ms)
  • Pulled 10 recent traces; the slowest spent 1.2s in `payment.authorize` (child span)
  • Fetched payment.authorize traces; all of them call api.stripe.com — p95 there is 1.1s
  • Logs for those spans show no retries — the upstream is just slow

Conclusion: bottleneck is upstream (Stripe), not internal logic. Consider:
  • Setting a faster timeout + retry on payment.authorize
  • Caching authorization tokens if your pattern allows

Source data (so the user can dig further themselves):
  • Dashboard: $OBS_DASHBOARD_URL/#/services?service=checkout-api
  • A sample slow trace: $OBS_DASHBOARD_URL/#/traces?trace=<id>
```

The dashboard deep-links matter — they let the user see what you saw with the full UI, not just your summary.

## Endpoint reference

The `/internal/*` query surface, by signal type.

### Traces

| Endpoint | Purpose | Key params |
| --- | --- | --- |
| `GET /internal/telemetry/overview` | Recent traces overview | `hours`, `service`, `status` (ok/error/all), `limit`, `q` (search) |
| `GET /internal/telemetry/service-map` | Service-to-service edges | `hours`, `source` (sdk/ebpf/all) |
| `GET /internal/telemetry/services/:service/operations` | Operations rollup for a service | `hours`, `limit` |
| `GET /internal/telemetry/traces/:traceId` | Full trace tree | (path param only) |
| `GET /internal/telemetry/export` | Bulk export (use sparingly) | `hours`, `limit`, `format` |

### Logs

| Endpoint | Purpose | Key params |
| --- | --- | --- |
| `GET /internal/logs/overview` | Recent logs | `hours`, `severity` (debug/info/warn/error), `service`, `traceId` (camelCase — `trace_id` is silently ignored), `limit`, `search` |

### AI / LLM

| Endpoint | Purpose | Key params |
| --- | --- | --- |
| `GET /internal/ai/overview` | Recent AI calls | `hours`, `provider`, `model`, `limit` |
| `GET /internal/ai/spans` | Span-shaped AI data with full attrs | `hours`, `kind` (LLM/TOOL/...), `trace_id` |
| `GET /internal/ai/sessions` | Multi-turn session list | `hours`, `user_id`, `limit` |
| `GET /internal/ai/sessions/:sessionId` | Specific session's call sequence | (path param) |
| `GET /internal/ai/evaluations` | Eval results (rag_faithfulness, mentions_temperature, etc.) | `hours`, `eval_name`, `session_id` |

### Actions / agents / tools

| Endpoint | Purpose | Key params |
| --- | --- | --- |
| `GET /internal/agent-runs/:id` | Agent run detail plus connected manifest | (path param) |
| `GET /internal/actions/:id` | Action detail, causal tree, tools, evals, evidence | (path param) |
| `GET /internal/tool-calls/:id` | Tool detail, args/result hashes, side-effect evidence | (path param) |
| `GET /internal/actions/aggregates/tool-reliability` | Tool reliability rollup with exemplar pivots | `hours`, `limit` |
| `GET /internal/actions/aggregates/cost-attribution` | Cost attribution by agent/model/prompt/tool/user | `hours`, `limit` |
| `GET /internal/actions/aggregates/autonomous-review` | Risk review for autonomous or side-effecting actions | `hours`, `limit` |
| `GET /internal/actions/aggregates/version-diff` | Agent/prompt/model version comparison | `baseline`, `target` |

### Usage events / users / replay

| Endpoint | Purpose | Key params |
| --- | --- | --- |
| `GET /internal/usage/overview` | Page views, interactions, frontend errors | `hours`, `type`, `q`, `limit` |
| `GET /internal/usage/sessions` | Session list (browser sessions) | `hours`, `limit` |
| `GET /internal/usage/sessions/:sessionId` | Specific session's event sequence | (path param) |
| `GET /internal/users` | User list | `hours`, `q`, `limit` |
| `GET /internal/users/:userId` | User detail + recent sessions | (path param) |
| `GET /internal/replays` | Recent rrweb replay sessions | `hours`, `limit` |
| `GET /internal/replays/:sessionId` | Specific replay's event stream | (path param) |

### Cross-signal

| Endpoint | Purpose |
| --- | --- |
| `GET /internal/connected/:kind/:id` | Get all signals connected to an anchor. `kind ∈ { span, log, usage, ai_call, replay, alert, analysis, user, profile, action, agent_run, tool_call }`. For `span`, id is `<traceId>:<spanId>`. There is no plain `trace` kind — use a span from the trace instead. The cheapest way to do a cross-signal pivot. |

### Analyses / alerts

| Endpoint | Purpose |
| --- | --- |
| `GET /internal/analyses` | List available analyses |
| `GET /internal/analyses/results` | Recent analysis results (slow-query patterns, error clusters, etc.) |
| `POST /internal/analyses/:id/run` | Trigger a specific analysis now |
| `GET /internal/analyses/:id/result` | Latest result for a specific analysis |
| `GET /internal/alerts/rules` | List configured alert rules |
| `GET /internal/alerts/evaluations` | Recent alert evaluations (which rules fired) |

For the canonical source — exact param names, response shapes, edge cases — read the relevant plugin in `packages/obs-collector/src/plugins/`. The files are short and routed: `query-routes.ts`, `connected-routes.ts`, `analyses-routes.ts`, etc.

## Investigation playbooks

Common questions and the query sequence that answers them:

### "Did my recent change make things slower?"

1. Identify the route touched.
2. `GET /internal/telemetry/services/:service/operations?hours=24` — get the operation rollup including p50/p95/p99 latencies.
3. Note the p95 for the touched operation.
4. Have the user check the dashboard's same view for visual confirmation (deep-link).
5. If p95 spiked, drill: `GET /internal/telemetry/overview?service=X&q=opName&hours=2` for recent traces, find the slowest, fetch the trace tree, look for child span shifts.

### "What's the most expensive AI call this week?"

1. `GET /internal/ai/overview?hours=168` — recent AI activity.
2. Sort by cost if the response sorts; otherwise scan for top `totalCostUsd`.
3. For the top expensive call/session, pivot through `connected/ai_call/<callId>` or `connected/span/<traceId>:<spanId>`.
4. Inspect action, agent run, tool call, eval, prompt version, model, and provider context.
5. Check if the session has failed evaluations: `GET /internal/ai/evaluations?session_id=X` — high cost + low quality is the worst case.
6. Report whether the causal action links were explicit or fallback-derived.

### "User reports checkout failed"

1. `GET /internal/users/:userId` if you have a user id, otherwise `GET /internal/users?q=<email>`.
2. From the user's recent sessions, pick the suspect one.
3. `GET /internal/connected/usage/:sessionId` — get all related signals (traces, logs, AI calls, replay) in one shot.
4. The response includes: usage events (which buttons they clicked), traces (what their requests did), logs (any errors), replay (what they actually saw). Walk them in order to reconstruct what happened.

### "Are there obvious error clusters?"

1. `GET /internal/analyses` — list available analyses.
2. `GET /internal/analyses/results?hours=24` — recent results across all analyses.
3. Prefer structured evidence references in each result over narrative text.
4. Follow the first high-confidence evidence pivot via `connected/<kind>/<id>`.
5. If no recent results for an analysis you care about: `POST /internal/analyses/:id/run` to trigger it.
6. `GET /internal/analyses/:id/result` for the freshly computed output.

### "Where is instrumentation missing?"

1. Start from trace detail or analysis output that mentions self-time or missing instrumentation.
2. Use the structured evidence reference for the top gap; it should point at a concrete span or trace.
3. Pivot to `connected/span/<traceId>:<spanId>` to inspect neighboring spans, logs, profiles, and actions.
4. Follow suggested pivots to trace gap data, the uninstrumented span, or profiler/eBPF setup docs.
5. Report it as incomplete evidence, not a root cause by itself: "the trace has a blind spot under span X; add spans/profile coverage here."

### "Which tool or autonomous action is risky?"

1. Start with `GET /internal/actions/aggregates/tool-reliability?hours=24` or `GET /internal/actions/aggregates/autonomous-review?hours=24`.
2. Pick the row with highest debugging value: failures, side effects, approval bypasses, mutation evidence, or high cost.
3. Open the exemplar action/tool via `GET /internal/actions/:id` or `GET /internal/tool-calls/:id`.
4. Inspect side-effect flags, approval state, MCP audit metadata, before/after mutation evidence, related evals, and traces.
5. Pivot to the agent run and source production/eval evidence before recommending a fix.

### "What changed between agent versions?"

1. Use `GET /internal/actions/aggregates/version-diff?baseline=<old>&target=<new>`.
2. Compare costs, latency, tool choices, eval outcomes, and differing steps.
3. Open exemplar actions or agent runs for both sides.
4. Report the changed behavior in terms of evidence: step sequence, tool calls, evals, traces, and source production links.

### "Verify my instrumentation is working"

This is the natural handoff from `instrument-obs-unified`:

1. After the user triggers a request, capture the `x-obs-trace-id` response header.
2. `GET /internal/telemetry/traces/:traceId` — confirm the trace exists.
3. Check it has the expected child spans, AI spans, logs, etc.
4. If an interaction came from the browser, confirm `obs.interaction.id` is set on the root span.

## Common pitfalls

| Pitfall | What to do |
| --- | --- |
| Auth 401/403 | The `/internal/*` routes need dashboard auth — confirm `OBS_DASHBOARD_TOKEN` or that the collector accepts the ingest key for reads. |
| No data returned | Confirm the collector is the one the user's app is sending to (collectors are per-project — `OBS_COLLECTOR_URL` must match what's in `.env` of the app). |
| Time window too narrow | Default `hours` is often 1; widen to 24 or 168 when the user is asking about "this week" / "yesterday." |
| Time window too wide | If a query returns thousands of rows, add a `service` or `q` filter — the dashboard's analyst experience always scopes by service first. |
| Trace exists but child spans missing | Likely `withChildSpan` not used (or LLM call outside `runWithSpan` scope) — point them at `instrument-obs-unified` to fill the gaps. |
| Rail shows fallback confidence | Useful for navigation, but report it as inferred. Ask for explicit action propagation if the conclusion depends on causality. |
| Rail shows no profiles | The trace has no indexed pprof/eBPF profile labels. Suggest profiler setup or trace-id labels rather than claiming no CPU issue exists. |
| Analysis has narrative but no evidence | Treat it as weaker. Prefer results with structured `EvidenceReference` objects or rerun after upgrading instrumentation/collector. |
| Wrong project | Some collectors host multiple projects; the auth token determines which project's data you see. If results look wrong, confirm the ingest-key/token matches the project the user expects. |

## Reporting back

A good investigation report has four sections:

1. **Question** — restate what was asked, in one line.
2. **Investigation** — bullet list of the queries you ran and what each surfaced. Not raw output; the meaningful finding from each step.
3. **Confidence** — call out explicit versus fallback-derived links and any informative absence.
4. **Conclusion** — what the data says, plus a recommendation if the data supports one.
5. **Source data** — dashboard deep-links so the user can verify with the full UI.

The dashboard deep-links are essential. The agent's text summary is fast but lossy; the deep-link lets the user see the full picture in seconds. Build them as `$OBS_DASHBOARD_URL/#/<view>?<params>` per the routing in `apps/web/src/App.tsx:40` — e.g. `/#/traces?trace=<id>`, `/#/users/<userId>`, `/#/replay?session=<id>`.
