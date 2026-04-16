#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
  getCodexAvailability,
  parseStructuredOutput,
  readOutputSchema,
  runAppServerTurn
} from "./lib/codex.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { renderMultiRoundResult } from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");

/** 前 5 轮强制审查，每轮不同攻击视角 */
const MANDATORY_ROUNDS = [
  {
    round: 1,
    lens: "Semantics and invariants",
    focus: "Focus exclusively on SEMANTICS AND INVARIANTS: wrong behavior, broken contracts, missing guards, misleading assumptions, violated preconditions/postconditions. Ignore all other categories."
  },
  {
    round: 2,
    lens: "Failure paths and degraded behavior",
    focus: "Focus exclusively on FAILURE PATHS AND DEGRADED BEHAVIOR: null/empty handling, retries, partial failure, timeout, fallback, rollback gaps, error propagation. Ignore all other categories."
  },
  {
    round: 3,
    lens: "Tests, observability, and recovery",
    focus: "Focus exclusively on TESTS, OBSERVABILITY, AND RECOVERY: missing assertions, false-positive tests, absent regression coverage, weak logs/metrics, poor recoverability, silent failures. Ignore all other categories."
  },
  {
    round: 4,
    lens: "Duplication, complexity, and unnecessary abstraction",
    focus: "Focus exclusively on DUPLICATION, COMPLEXITY, AND UNNECESSARY ABSTRACTION: DRY violations, repeated helpers, over-abstraction, YAGNI violations, dead branches, unused extension points, complexity hiding intent. Ignore all other categories."
  },
  {
    round: 5,
    lens: "Safety, scope, and integration",
    focus: "Focus exclusively on SAFETY, SCOPE, AND INTEGRATION: sensitive files, collateral damage to unrelated code, cross-file consistency, user-visible regressions, auth/permission gaps, secret exposure. Ignore all other categories."
  }
];

/** 第 6-10 轮延续审查：仅在前 5 轮出现 needs-attention 时触发 */
const EXTRA_ROUNDS = [
  {
    round: 6,
    lens: "Concurrency and state coupling",
    focus: "Focus exclusively on CONCURRENCY AND STATE COUPLING: race conditions, deadlocks, stale state, lock contention, shared mutable state, ordering assumptions, re-entrancy, cross-goroutine/thread/async hazards. Ignore all other categories."
  },
  {
    round: 7,
    lens: "Performance and repeated work",
    focus: "Focus exclusively on PERFORMANCE AND REPEATED WORK: N+1 queries, unnecessary allocations, hot loops, redundant computation, missing caching, unbounded growth, memory leaks, repeated I/O. Ignore all other categories."
  },
  {
    round: 8,
    lens: "API, schema, and compatibility",
    focus: "Focus exclusively on API, SCHEMA, AND COMPATIBILITY: breaking changes, version skew, migration hazards, backward-incompatible payloads, missing deprecation paths, schema drift between services. Ignore all other categories."
  },
  {
    round: 9,
    lens: "Security and trust boundaries",
    focus: "Focus exclusively on SECURITY AND TRUST BOUNDARIES: injection vectors, auth bypass, privilege escalation, secret exposure, SSRF, insecure deserialization, missing input validation at trust boundaries, CORS misconfiguration. Ignore all other categories."
  },
  {
    round: 10,
    lens: "Final hostile pass",
    focus: "This is the FINAL HOSTILE PASS. Assume all previous rounds missed something. Re-examine the entire change with maximum skepticism. Look for subtle interactions between components, second-order effects, edge cases that only manifest under production load, and any assumption that earlier rounds may have taken for granted. Report only findings not already covered."
  }
];

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function buildRoundPrompt(context, roundDef, userFocus, priorFindings) {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
  const combinedFocus = userFocus
    ? `${roundDef.focus}\n\nAdditional user focus: ${userFocus}`
    : roundDef.focus;
  const priorText = priorFindings.length === 0
    ? "No prior findings yet. This is the first round."
    : priorFindings.map((f, i) =>
        `${i + 1}. [${f.severity}] ${f.title} (${f.file}:${f.line_start}-${f.line_end})`
      ).join("\n");
  return interpolateTemplate(template, {
    REVIEW_KIND: `Adversarial Review — Round ${roundDef.round}: ${roundDef.lens}`,
    TARGET_LABEL: context.target.label,
    USER_FOCUS: combinedFocus,
    PRIOR_FINDINGS: priorText,
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

function severityRank(severity) {
  switch (severity) {
    case "critical": return 0;
    case "high": return 1;
    case "medium": return 2;
    default: return 3;
  }
}

function deduplicateFindings(allFindings) {
  const byKey = new Map();
  for (const f of allFindings) {
    const key = `${f.file}:${f.line_start}:${(f.title || "").slice(0, 40)}`;
    const existing = byKey.get(key);
    if (!existing || severityRank(f.severity) < severityRank(existing.severity)) {
      byKey.set(key, f);
    }
  }
  return [...byKey.values()];
}

async function main() {
  const argv = normalizeArgv(process.argv.slice(2));
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["base", "scope", "model"],
    booleanOptions: ["json"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = process.cwd();

  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    process.stderr.write(
      "Codex CLI is not installed or is missing required runtime support.\n" +
      "Install it with: npm install -g @openai/codex\n"
    );
    process.exitCode = 1;
    return;
  }

  ensureGitRepository(cwd);

  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  const userFocus = positionals.join(" ").trim();
  const context = collectReviewContext(cwd, target);
  const outputSchema = readOutputSchema(REVIEW_SCHEMA);

  const progressHandler = (update) => {
    const message = typeof update === "string" ? update : update?.message;
    if (message) {
      process.stderr.write(`[codex] ${message}\n`);
    }
  };

  // 逐轮执行 Codex 审查——先跑 5 轮强制，再根据结果决定是否继续 6-10 轮
  const roundResults = [];
  const accumulatedFindings = [];

  async function runRound(roundDef) {
    process.stderr.write(`\n=== Round ${roundDef.round}: ${roundDef.lens} ===\n`);
    const prompt = buildRoundPrompt(context, roundDef, userFocus, accumulatedFindings);
    let result;
    try {
      result = await runAppServerTurn(context.repoRoot, {
        prompt,
        model: options.model ?? null,
        sandbox: "read-only",
        outputSchema,
        onProgress: progressHandler
      });
    } catch (err) {
      process.stderr.write(`[codex] Round ${roundDef.round} failed: ${err.message}\n`);
      roundResults.push({
        round: roundDef.round,
        lens: roundDef.lens,
        threadId: null,
        status: 1,
        parsed: { parsed: null, parseError: err.message, rawOutput: "" },
        reasoningSummary: [],
        stderr: "",
        error: err
      });
      return;
    }
    const parsed = parseStructuredOutput(result.finalMessage, {
      status: result.status,
      failureMessage: result.error?.message ?? result.stderr
    });
    // Accumulate findings for PRIOR_FINDINGS in subsequent rounds
    if (parsed.parsed?.findings) {
      for (const f of parsed.parsed.findings) {
        accumulatedFindings.push({ ...f, _round: roundDef.round, _lens: roundDef.lens });
      }
    }
    roundResults.push({
      round: roundDef.round,
      lens: roundDef.lens,
      threadId: result.threadId,
      status: result.status,
      parsed,
      reasoningSummary: result.reasoningSummary,
      stderr: result.stderr,
      error: result.error
    });
  }

  // Phase 1: 5 轮强制审查
  for (const roundDef of MANDATORY_ROUNDS) {
    await runRound(roundDef);
  }

  // Phase 2: 检查前 5 轮是否有 needs-attention，如有则继续 6-10 轮
  const hasOpenConcerns = roundResults.some(
    rr => rr.parsed.parsed?.verdict === "needs-attention"
  );
  if (hasOpenConcerns) {
    process.stderr.write(
      "\n>>> Rounds 1-5 produced needs-attention findings. Continuing with rounds 6-10. <<<\n"
    );
    for (const roundDef of EXTRA_ROUNDS) {
      await runRound(roundDef);
    }
  } else {
    process.stderr.write(
      "\n>>> All 5 mandatory rounds passed clean. Skipping extra rounds 6-10. <<<\n"
    );
  }

  const totalRounds = roundResults.length;

  // 汇总所有 findings 并去重
  const allNextSteps = [];
  const allReasoningSummary = [];
  let worstVerdict = "approve";

  for (const rr of roundResults) {
    if (rr.parsed.parsed) {
      if (rr.parsed.parsed.verdict === "needs-attention") {
        worstVerdict = "needs-attention";
      }
      for (const step of rr.parsed.parsed.next_steps || []) {
        allNextSteps.push(step);
      }
    }
    if (rr.reasoningSummary) {
      allReasoningSummary.push(...rr.reasoningSummary);
    }
  }

  const uniqueFindings = deduplicateFindings(accumulatedFindings);
  const uniqueNextSteps = [...new Set(allNextSteps)];
  const roundsWithFindings = roundResults.filter(r => r.parsed.parsed?.findings?.length > 0).length;

  // 构建汇总结果
  const mergedResult = {
    verdict: worstVerdict,
    summary: worstVerdict === "approve"
      ? `All ${totalRounds} rounds passed without material findings.`
      : `${uniqueFindings.length} material finding(s) across ${roundsWithFindings} of ${totalRounds} rounds.`,
    findings: uniqueFindings,
    next_steps: uniqueNextSteps
  };

  if (options.json) {
    const payload = {
      review: `Adversarial Review (${totalRounds}-round)`,
      target,
      rounds: roundResults.map(rr => ({
        round: rr.round,
        lens: rr.lens,
        threadId: rr.threadId,
        verdict: rr.parsed.parsed?.verdict ?? "error",
        findingCount: rr.parsed.parsed?.findings?.length ?? 0,
        parseError: rr.parsed.parseError
      })),
      context: {
        repoRoot: context.repoRoot,
        branch: context.branch,
        summary: context.summary
      },
      merged: mergedResult,
      reasoningSummary: allReasoningSummary
    };
    console.log(JSON.stringify(payload, null, 2));
  } else {
    const rendered = renderMultiRoundResult(roundResults, mergedResult, {
      targetLabel: context.target.label,
      reasoningSummary: allReasoningSummary
    });
    process.stdout.write(rendered);
  }

  const hasFailure = roundResults.some(rr => rr.status !== 0);
  if (hasFailure) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
