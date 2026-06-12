# obs-unified-skills

Claude Code skills for [obs-unified](https://github.com/obs-unified/obs-unified) — drop them into your `~/.claude/skills/` directory and AI coding agents working in your repos will know how to wire obs-unified observability in and how to investigate the data once it's flowing.

| Skill | What it does |
| --- | --- |
| **[`instrument-obs-unified`](./instrument-obs-unified/)** | Wires `@obsunified/analytics-sdk` (browser), `@obsunified/telemetry-sdk` (server), and OpenInference AI span helpers into a TypeScript app end-to-end. Verifies telemetry is flowing by querying the collector. |
| **[`investigate-obs-unified`](./investigate-obs-unified/)** | Queries a running obs-unified collector to investigate problems — traces, logs, AI calls, replays. Pivots across signals via the `connected` endpoint. The natural follow-up to the instrument skill. |

## Install

Two paths, depending on how you prefer to manage skills.

### A. As pre-built `.skill` bundles (recommended)

Each skill ships as a `.skill` file (a zip of the skill directory). Drop them into Claude Code's skills location:

```bash
# from this repo's dist/ directory
cp instrument-obs-unified.skill ~/.claude/skills/
cp investigate-obs-unified.skill ~/.claude/skills/

# or install both with one command if your Claude Code version supports it:
claude skill install dist/instrument-obs-unified.skill
claude skill install dist/investigate-obs-unified.skill
```

### B. As source directories (best for hacking on the skills)

```bash
git clone https://github.com/obs-unified/obs-unified-skills.git
ln -s "$(pwd)/obs-unified-skills/instrument-obs-unified" ~/.claude/skills/instrument-obs-unified
ln -s "$(pwd)/obs-unified-skills/investigate-obs-unified" ~/.claude/skills/investigate-obs-unified
```

Restart Claude Code (or re-open your project) and the skills appear in the available-skills list. Trigger them either by typing the slash commands (`/instrument-obs-unified`, `/investigate-obs-unified`) or by asking naturally — see each skill's description for triggers.

## Quick start

### Instrumenting a fresh app

Say to your Claude Code session, in a TypeScript project of your own:

> "Add obs-unified observability to this app end-to-end. React + Vite frontend, Hono on Workers backend."

The skill will:
1. Detect the stack from `package.json`.
2. Ask you for the collector URL + ingest key.
3. Pre-flight probe the collector to confirm reachability + valid key.
4. Wire `<AnalyticsProvider>` into your React entry, the per-request span middleware into your Hono server, and any LLM calls with OpenInference span helpers.
5. Verify the wire-up by firing a sample request and checking the resulting trace lands in the collector.

The canonical reference for what code the skill writes is [`instrument-obs-unified/references/instrument-react-hono.md`](./instrument-obs-unified/references/instrument-react-hono.md) — bundled inside the skill so it works offline.

### Investigating a problem

Once an app is instrumented and data is flowing:

> "Why is /api/checkout slow in the last hour?"

> "Pull everything you can find about the user heavy-spender@example.com — their AI cost, related traces, any failed evaluations."

> "Find the trace for the request I just made and tell me what failed."

The investigate skill knows the collector's `/internal/*` query surface, the right endpoint per question, how to pivot across signals via `connected/<kind>/<id>`, and how to interpret OpenTelemetry + OpenInference span shapes.

## What obs-unified is

[obs-unified](https://github.com/obs-unified/obs-unified) is the upstream project — an OTel-compatible observability platform with first-party SDKs, a Cloudflare Worker collector (with a Node.js variant), and a dashboard. These skills automate the two most common interactions a coding agent has with it: writing the SDK call sites, and reading the resulting telemetry.

If you don't have obs-unified deployed yet, the instrument skill will walk you through the options — local dev (`pnpm dev:collector` in the obs-unified repo) or self-hosted (see the [obs-unified README → "Deploy the Collector"](https://github.com/obs-unified/obs-unified/blob/main/README.md#1-deploy-the-collector)). The skills do not deploy obs-unified itself; they assume a reachable collector.

## How these were built

Both skills were drafted, eval-tested with parallel subagents (with-skill vs baseline runs), graded against per-eval assertions, and benchmarked. Headlines from iteration 1:

| Skill | With-skill pass rate | Baseline pass rate | Time delta |
|---|---|---|---|
| instrument-obs-unified | 100% (3 evals) | 67.9% | +25s slower (worth it) |
| investigate-obs-unified | 100% (3 evals) | 94.4% | −35s faster (−27%) |

The investigate eval also surfaced two doc-accuracy bugs in the skill itself (the `connected/<kind>/<id>` valid-kinds list was wrong and `logs/overview` uses `traceId` not `trace_id`) — both fixed before release.

Eval workspaces and the full per-run grading data live in the upstream [obs-unified](https://github.com/obs-unified/obs-unified) repo under `.claude/skills/*-workspace/iteration-1/`.

## Contributing

Skills live under `instrument-obs-unified/` and `investigate-obs-unified/`. Each is a directory with a `SKILL.md` at the root and any companion files (references, scripts) alongside.

To rebuild the `.skill` artifacts after edits:

```bash
make build      # or invoke scripts/package.sh
```

Validation:

```bash
make validate   # checks SKILL.md frontmatter parses + links resolve
```

CI runs both on every PR — see [.github/workflows/validate.yml](.github/workflows/validate.yml).

## License

MIT. See [LICENSE](./LICENSE).
