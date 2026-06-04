#!/usr/bin/env node
// messaging-check.mjs — RFC 0012 messaging parity lint.
//
// Reads the vendored ./messaging.manifest.json and scans the skill SKILL.md
// files for drift against the canonical messaging contract. No dependencies.
//
// Rules:
//   1. package scope  — every @obs[-]unified/<pkg> token in a SKILL.md must be a
//      real package name in manifest.derived.packages[].name. Catches the
//      @obs-unified/mcp-server -> @obsunified/mcp-server rename class.
//   2. tool names     — every standalone backticked token shaped like an MCP
//      tool must exist in manifest.derived.mcpTools. Catches a referenced tool
//      that was renamed/removed.
//   3. evidence fields — a backticked `suggestedPivots` (or other detectable
//      near-miss of an evidence field) must not appear; the canonical field is
//      `suggestedNextPivots`.
//
// Exit 0 when clean, exit 1 (with ✗ messages) on any violation.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

const MANIFEST_PATH = join(repoRoot, "messaging.manifest.json");
const SKILL_FILES = [
  "investigate-obs-unified/SKILL.md",
  "instrument-obs-unified/SKILL.md",
];

const errors = [];

// --- load manifest ---------------------------------------------------------
let manifest;
try {
  manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
} catch (err) {
  console.error(`✗ could not read/parse ${MANIFEST_PATH}: ${err.message}`);
  process.exit(1);
}

const derived = manifest.derived ?? {};
const packageNames = new Set((derived.packages ?? []).map((p) => p.name));
const mcpTools = new Set(derived.mcpTools ?? []);
const allowedEvidenceFields = new Set([
  ...(derived.evidenceReferenceFields ?? []),
  ...(derived.evidenceRetrievalRefFields ?? []),
  "href",
]);

if (packageNames.size === 0 || mcpTools.size === 0) {
  console.error("✗ manifest.derived is missing packages/mcpTools — refusing to run");
  process.exit(1);
}

// --- per-file scan ---------------------------------------------------------
const PKG_RE = /@obs-?unified\/[a-z0-9-]+/g;
const BACKTICK_RE = /`([^`]+)`/g;
const TOOL_SHAPE_RE =
  /^(obs_status|get_[a-z_]+|search_[a-z_]+|retrieve_[a-z_]+|recent_[a-z_]+|service_[a-z_]+|ai_[a-z_]+|connected_[a-z_]+)$/;

// Evidence near-misses we can flag deterministically without false positives.
// Canonical field is `suggestedNextPivots`.
const EVIDENCE_NEAR_MISSES = new Set(["suggestedPivots", "suggestedNextPivot"]);

for (const rel of SKILL_FILES) {
  const path = join(repoRoot, rel);
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    errors.push(`${rel}: could not read file: ${err.message}`);
    continue;
  }

  const lines = text.split("\n");

  lines.forEach((line, i) => {
    const lineNo = i + 1;

    // RULE 1 — package scope (token need not be backticked)
    for (const match of line.matchAll(PKG_RE)) {
      const pkg = match[0];
      if (!packageNames.has(pkg)) {
        errors.push(
          `${rel}:${lineNo}: RULE 1 (package scope) — '${pkg}' is not a real package in the manifest`
        );
      }
    }

    // RULE 2 & 3 — backticked tokens
    for (const match of line.matchAll(BACKTICK_RE)) {
      const token = match[1];

      // RULE 2 — tool name shape
      if (TOOL_SHAPE_RE.test(token) && !mcpTools.has(token)) {
        errors.push(
          `${rel}:${lineNo}: RULE 2 (tool names) — \`${token}\` matches MCP-tool shape but is not in manifest.derived.mcpTools`
        );
      }

      // RULE 3 — evidence field near-miss
      if (
        EVIDENCE_NEAR_MISSES.has(token) &&
        !allowedEvidenceFields.has(token)
      ) {
        errors.push(
          `${rel}:${lineNo}: RULE 3 (evidence field) — \`${token}\` is not a canonical evidence field; did you mean \`suggestedNextPivots\`?`
        );
      }
    }
  });
}

// --- report ----------------------------------------------------------------
if (errors.length > 0) {
  for (const e of errors) console.error(`✗ ${e}`);
  console.error(`\n✗ messaging-check: ${errors.length} violation(s) found.`);
  process.exit(1);
}

console.log(
  `✓ messaging-check: ${SKILL_FILES.length} SKILL.md files clean against messaging.manifest.json ` +
    `(${packageNames.size} packages, ${mcpTools.size} tools, ${allowedEvidenceFields.size} evidence fields).`
);
process.exit(0);
