# Instrumenting a React + Hono app end-to-end

A complete walkthrough for wiring `@obs-unified/analytics-sdk` and
`@obs-unified/telemetry-sdk` into a new React (Vite) frontend with a Hono
backend on Cloudflare Workers — including AI / LLM calls. Once finished,
every browser interaction propagates through to a backend trace, AI calls
show up in the AI tab with cost / tokens, and structured logs link back to
their originating request.

For other runtimes (Python, JVM, .NET) see [docs/recipes/](https://github.com/obs-unified/obs-unified/blob/main/docs/recipes/).
For deeper detail on the backend SDK specifically, see
[INSTRUMENTATION_GUIDE.md](https://github.com/obs-unified/obs-unified/blob/main/packages/telemetry-sdk/INSTRUMENTATION_GUIDE.md).

## What you'll have when done

- Every click / submit / keydown on the frontend stamped with a fresh
  `interaction_id`.
- That id auto-propagated to backend `fetch` calls so a dashboard user can
  pivot from a replay segment to the trace it caused.
- Per-request OTLP spans with child spans for downstream work (DB, outbound
  HTTP, LLM calls).
- AI calls visible in the AI tab with cost, tokens, and connected sessions.
- Structured logs joined to their originating trace.
- Session replay (rrweb) with PII fields masked by default.

## Prerequisites

- Node ≥ 22, pnpm ≥ 10
- A running collector — locally via `pnpm dev:collector` in the obs-unified
  repo, or your deployed collector URL
- A project ingest key (`OBS_INGEST_KEY`)

## 0. Install

```bash
pnpm add @obs-unified/analytics-sdk     # browser
pnpm add @obs-unified/telemetry-sdk     # server
```

Add to `.env`:

```
OBS_COLLECTOR_URL=https://obs.example.com         # server
OBS_INGEST_KEY=obs_…                              # server
VITE_OBS_COLLECTOR_URL=https://obs.example.com    # browser (same URL)
VITE_OBS_INGEST_KEY=obs_…                         # browser (separate write-only key recommended)
```

## 1. Frontend — bootstrap the React provider

`src/main.tsx`:

```tsx
import { AnalyticsProvider } from "@obs-unified/analytics-sdk/react";
import ReactDOM from "react-dom/client";
import { App } from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <AnalyticsProvider
    collectorUrl={import.meta.env.VITE_OBS_COLLECTOR_URL}
    apiKey={import.meta.env.VITE_OBS_INGEST_KEY}
    autoCorrelate          // installs click/submit/keydown listeners + fetch/XHR patch
    trackPageViews         // hooks pushState/popstate for SPA route changes
    captureErrors          // window.error + unhandledrejection
    replayPrivacyOptions={{
      maskInputOptions: { text: true },
      blockSelector: "[data-no-record]",
    }}
  >
    <App />
  </AnalyticsProvider>,
);
```

Once mounted you get, with no further code:

- Page views on every SPA route change.
- Click / submit / keydown stamped with a fresh `interaction_id`.
- That id auto-propagated on outbound `fetch` and XHR via the
  `x-obs-interaction` header.
- Unhandled errors reported as `frontend_error` usage events.

The SDK's `replayPrivacyOptions` is the consumer-facing knob for rrweb
masking (PII inputs masked by default; tighten further per your forms).

Replay is **off by default**. Call `startReplay()` from `useAnalytics()` to
begin recording (next step).

## 2. Frontend — custom events and replay

```tsx
import { useAnalytics } from "@obs-unified/analytics-sdk/react";
import { useEffect } from "react";

function CheckoutButton() {
  const { trackInteraction, fetch, startReplay } = useAnalytics();

  useEffect(() => {
    startReplay();
  }, []);

  return (
    <button
      onClick={async () => {
        trackInteraction("checkout_clicked", { cartValue: 49.99 });
        const res = await fetch("/api/checkout", { method: "POST" });
        if (!res.ok) trackInteraction("checkout_failed", { status: res.status });
      }}
    >
      Pay
    </button>
  );
}
```

Use the provider's `fetch` rather than the global — it adds the session id
header. Interaction-id correlation works on raw `fetch` too when
`autoCorrelate` is enabled.

For deferred work that escapes microtask scope (setTimeout chains, debounced
fns), wrap the handler with `withInteraction` from the same hook so the
active id stays bound through async awaits.

## 3. Backend — init + per-request middleware

`src/backend/server.ts`:

```ts
import {
  createLogger,
  createRequestSpan,
  flushAICalls,
  flushLogs,
  initObservability,
  runWithSpan,
  stampInteractionFromRequest,
} from "@obs-unified/telemetry-sdk";
import { Hono } from "hono";

type Env = { OBS_COLLECTOR_URL: string; OBS_INGEST_KEY: string };
const app = new Hono<{ Bindings: Env }>();
const logger = createLogger("my-api");

// A. init once per request (idempotent on repeat calls)
app.use("*", async (c, next) => {
  initObservability({
    collectorUrl: c.env.OBS_COLLECTOR_URL,
    apiKey: c.env.OBS_INGEST_KEY,
    serviceName: "my-api",
  });
  await next();
});

// B. per-request span middleware
app.use("*", async (c, next) => {
  const span = createRequestSpan("my-api", `${c.req.method} ${c.req.path}`);
  stampInteractionFromRequest(span, c.req.raw);   // closes click-to-trace loop
  try {
    await runWithSpan(span, () => next());
    span.setStatus(c.res.status >= 400 ? 2 : 1);
  } finally {
    span.end();
    await Promise.all([flushLogs(), flushAICalls()]);
  }
});

export default app;
```

Every inbound request now produces an OTLP span carrying the visitor's
`interaction_id`. Logs and AI spans buffer against the active span and flush
before the response returns. (Workers terminate the isolate at response-end,
so an explicit flush is required — buffered telemetry won't survive.)

## 4. Backend — child spans for downstream work

Inside a route handler, wrap any sub-operation in `withChildSpan`:

```ts
import { withChildSpan } from "@obs-unified/telemetry-sdk";

app.post("/api/checkout", async (c) => {
  const items = await withChildSpan("inventory.check", async () => {
    return await db.prepare("SELECT * FROM stock WHERE …").all();
  });

  const payment = await withChildSpan("payment.authorize", async () => {
    return await fetch("https://api.stripe.com/v1/charges", { /* ... */ });
  });

  return c.json({ ok: true });
});
```

Logs and AI spans emitted inside the wrapped function correlate with that
child span automatically (via `AsyncLocalStorage`-based context).

## 5. Backend — AI / LLM calls

Use the typed AI span helpers — they emit OpenInference-compatible spans
that hang off the active request:

```ts
import {
  setAISessionContext,
  startLLMSpan,
} from "@obs-unified/telemetry-sdk";

app.post("/api/assistant", async (c) => {
  setAISessionContext({
    sessionId: c.req.header("x-obs-session-id"),
    userId,
  });

  const span = startLLMSpan({
    model: "gpt-4o-mini",
    provider: "openai",
    input: messages,
    name: "openai.chat.completions",
  });

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      /* … */
    });
    const json = await res.json();
    span.setOutput(json.choices[0].message);
    span.setTokens({
      prompt: json.usage.prompt_tokens,
      completion: json.usage.completion_tokens,
      total: json.usage.total_tokens,
    });
    span.setCost(estimateCostUSD(json.usage));
    return c.json(json);
  } catch (e) {
    span.setError((e as Error).message);
    throw e;
  } finally {
    span.end();
  }
});
```

Richer AI flows have matching helpers:

| Helper | Purpose |
| --- | --- |
| `startLLMSpan` | LLM call (token usage, cost) |
| `startToolSpan` | Tool / function call |
| `startRetrieverSpan` | RAG retrieval (documents + scores) |
| `startChainSpan` | Orchestration node |
| `startEmbeddingSpan` | Embedding call |
| `startAgentSpan` | Agent loop root |

> Don't use `trackAICall()` for new code. It's marked `@deprecated` in
> [packages/telemetry-sdk/src/ai.ts](https://github.com/obs-unified/obs-unified/blob/main/packages/telemetry-sdk/src/ai.ts)
> — predates the OpenInference helpers and only writes the legacy `ai_calls`
> table.

## 6. Backend — Cloudflare binding wrappers (optional, free)

```ts
import { wrapD1, wrapFetch, wrapR2 } from "@obs-unified/telemetry-sdk/cloudflare";

const db = wrapD1(env.DB);
const bucket = wrapR2(env.REPLAYS, { bucketName: "replays" });
const tracedFetch = wrapFetch(globalThis.fetch);
```

Zero call-site changes — your existing `db.prepare(...).all()` etc.
continues working. Every DB query and outbound HTTP call becomes a child
span under the active request.

## 7. Backend — structured logs

```ts
const logger = createLogger("my-api");

app.post("/api/checkout", async (c) => {
  logger.info("checkout_started", { userId, cartValue });
  if (paymentFailed) {
    logger.warn("payment_retry", { attempt: 2, reason: "timeout" });
  }
});
```

`WARN` / `ERROR` logs auto-attach to the active span as events. Every log
carries the request's `trace_id` and `span_id` so it appears in the Logs
tab linked to its originating request.

## 8. Verify end-to-end

After all the above is wired:

1. **Start dev servers** — Vite for the frontend, `wrangler dev` for the
   Worker.
2. **Click a button** on the frontend that calls a backend route. The
   browser's network panel should show an `x-obs-interaction` header on
   the outbound request.
3. **Find the trace** in the dashboard at `/#/traces` — your request should
   appear within ~5 seconds. Click it to see the request span plus any
   child spans you added.
4. **Confirm via the collector API.** The collector exposes a trace-by-id
   endpoint at `/internal/telemetry/traces/:traceId`:

   ```bash
   curl -H "X-Obs-Ingest-Key: $OBS_INGEST_KEY" \
     "$OBS_COLLECTOR_URL/internal/telemetry/traces/<traceId>" | jq
   ```

   The response includes the root span, child spans, and any AI spans.
5. **Confirm click-to-trace.** Open the dashboard's Replay tab, find your
   session, click an event — it should deep-link to the trace your click
   caused. This proves the `interaction_id` round-tripped through the
   entire stack.

The pattern in step 4 is also the basis for a synthetic monitoring check:
fire a known request, capture the returned `trace_id`, query the API after
a propagation delay, alert if the expected spans are missing.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| No data in the dashboard | Collector unreachable or `OBS_INGEST_KEY` doesn't match a project key. The SDK fails open (bounded buffers drop oldest events) so a wrong URL never crashes the app — but it also never lands data. |
| Spans appear but logs don't | `flushLogs()` not awaited before response. On Workers the isolate dies at response-end and the buffer never sends. |
| AI calls don't show cost | `span.setCost()` not called. The dashboard reads `llm.cost.total_usd` off the span; without it the cost column is empty. |
| Interaction id never reaches the backend | `autoCorrelate` not enabled, or a `fetch` wrapper strips the `x-obs-interaction` header. Confirm in the browser's Network tab. |
| Replay sessions are empty | `startReplay()` not called. It's off by default. |
| AI spans show but aren't under the request span | `startLLMSpan()` called outside the request's `runWithSpan` scope. Move it inside the route handler. |

## Reference

- Frontend SDK:
  [packages/analytics-sdk/README.md](https://github.com/obs-unified/obs-unified/blob/main/packages/analytics-sdk/README.md)
- Backend SDK quick start:
  [packages/telemetry-sdk/README.md](https://github.com/obs-unified/obs-unified/blob/main/packages/telemetry-sdk/README.md)
- Backend SDK deep guide:
  [packages/telemetry-sdk/INSTRUMENTATION_GUIDE.md](https://github.com/obs-unified/obs-unified/blob/main/packages/telemetry-sdk/INSTRUMENTATION_GUIDE.md)
- Interaction-id spec: [docs/spec/interaction-id.md](https://github.com/obs-unified/obs-unified/blob/main/docs/spec/interaction-id.md)
- Non-Node / non-browser runtimes: [docs/recipes/](https://github.com/obs-unified/obs-unified/blob/main/docs/recipes/)
- Full working example: the planned shop-demo repo, see
  [docs/implementation/shop-demo.md](https://github.com/obs-unified/obs-unified/blob/main/docs/implementation/shop-demo.md)
