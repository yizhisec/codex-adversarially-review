---
name: reviewing-workspace-changes-adversarially
description: Use when reviewing git changes with adversarial bug-finding across multiple passes, especially for working tree changes, staged diffs, or branch/base diffs where obvious low-risk fixes should be applied directly while ambiguous findings are escalated for confirmation.
---

# Adversarial Review via Codex (5-round)

## Architecture

Claude is the **dispatcher**, not the reviewer. Codex (OpenAI model) executes **5 mandatory rounds** of adversarial review, each with a distinct attack lens, in a read-only sandbox via `codex app-server`. This ensures independent, cross-model, multi-angle review.

## Mandatory Rounds

The script runs Codex at least 5 times sequentially, each focused on a different attack surface:

| Round | Lens | What Codex looks for |
| --- | --- | --- |
| 1 | Semantics and invariants | Wrong behavior, broken contracts, missing guards, misleading assumptions |
| 2 | Failure paths and degraded behavior | Null/empty handling, retries, partial failure, timeout, fallback, rollback gaps |
| 3 | Tests, observability, and recovery | Missing assertions, false positives, absent regression coverage, weak logs/metrics |
| 4 | Duplication, complexity, and unnecessary abstraction | DRY violations, over-abstraction, YAGNI, dead branches, complexity hiding intent |
| 5 | Safety, scope, and integration | Sensitive files, collateral damage, cross-file consistency, user-visible regressions |

If any of rounds 1-5 produces a `needs-attention` verdict, rounds 6-10 are automatically triggered:

| Round | Lens | What Codex looks for |
| --- | --- | --- |
| 6 | Concurrency and state coupling | Race conditions, deadlocks, stale state, ordering assumptions, re-entrancy |
| 7 | Performance and repeated work | N+1 queries, redundant computation, unbounded growth, memory leaks |
| 8 | API, schema, and compatibility | Breaking changes, version skew, migration hazards, schema drift |
| 9 | Security and trust boundaries | Injection, auth bypass, privilege escalation, secret exposure, SSRF |
| 10 | Final hostile pass | Re-examine everything assuming earlier rounds missed something |

If all 5 mandatory rounds return `approve`, extra rounds are skipped.

Each round produces an independent verdict + findings. Results are deduplicated and merged.

## Review Target

Identify the review scope before launching.

| Target | Typical signals | How to confirm |
| --- | --- | --- |
| Working tree | "current changes", "workspace", "uncommitted" | `git status --short`, `git diff --shortstat`, `git diff --shortstat --cached` |
| Branch/base diff | "this branch", "against main", "PR diff" | `git diff --shortstat <base>...HEAD` |

If the user names a scope, use it. If not, default to the narrowest scope that matches and say which you chose.

## Execution

### Step 1: Estimate review size

Before asking the user, check the size:
- For working-tree: `git status --short --untracked-files=all` + `git diff --shortstat --cached` + `git diff --shortstat`
- For branch: `git diff --shortstat <base>...HEAD`
- Treat untracked files as reviewable even when diff is empty
- Only conclude "nothing to review" when the scope is truly empty

### Step 2: Ask execution mode

5 rounds take significantly longer than a single pass. Use `AskUserQuestion` once:
- `Wait for results` — only for tiny reviews (1-2 files)
- `Run in background (Recommended)` — for everything else

### Step 3: Run Codex (5 rounds)

The script path:

```
SKILL_DIR="$HOME/.claude/skills/reviewing-workspace-changes-adversarially"
```

**Foreground:**
```bash
node "${SKILL_DIR}/scripts/codex-review.mjs" [FLAGS] [FOCUS_TEXT]
```

**Background:**
```typescript
Bash({
  command: `node "${SKILL_DIR}/scripts/codex-review.mjs" [FLAGS] [FOCUS_TEXT]`,
  description: "Codex adversarial review (5 rounds)",
  run_in_background: true
})
```

### Flags

| Flag | Purpose |
| --- | --- |
| `--base <ref>` | Review branch diff against a specific base ref |
| `--scope auto\|working-tree\|branch` | Force a specific review scope |
| `--model <model>` | Override the Codex model |
| `--json` | Output raw JSON instead of rendered markdown |
| `[text after flags]` | Additional focus text — appended to each round's lens |

### Step 4: Present Codex results

- Present the multi-round output **verbatim first**, before any triage.
- The output includes a round summary table and deduplicated findings.
- Do **not** paraphrase or supplement Codex findings with your own opinions.

### Step 5: Triage each finding (fix-or-ask)

After presenting results, process each Codex finding through the fix-or-ask decision.

**Classify as `fix-now`** when ALL of the following are true:
- The issue is concrete and reproducible from the code.
- The fix is local and does not require product, UX, API, or rollout judgment.
- The change does not rewrite unrelated user edits.
- The user did not request review-only behavior.

**Classify as `ask-user`** when ANY of the following applies:
- Multiple reasonable interpretations of intended behavior exist.
- The fix changes API, schema, user-visible behavior, migration behavior, or rollout risk.
- The "cleanup" would become a refactor instead of a narrow repair.
- The safest next step is not obvious.

**Classify as `no-action`** when:
- Codex confidence is below 0.3.
- The finding is purely stylistic or speculative with no concrete failure path.
- The finding describes code outside the review scope.

### Step 6: Act on triage

For each finding, announce the classification before acting:

```
Finding: [title] — [severity] — Round N — Action: fix-now | ask-user | no-action
```

- **fix-now**: Edit the file, then run the narrowest relevant verification before moving to the next finding.
- **ask-user**: Present the finding, Codex's recommendation, and the ambiguity. Use `AskUserQuestion` to get the user's decision.
- **no-action**: State why and move on.

### Step 7: Summary

After all findings are processed, output a ledger:

```
## Triage Summary
| # | Round | Finding | Severity | Action | Result |
|---|-------|---------|----------|--------|--------|
| 1 | R1    | ...     | high     | fix-now | patched + tests pass |
| 2 | R2    | ...     | high     | ask-user | user chose to defer |
| 3 | R5    | ...     | medium   | no-action | confidence 0.2 |
```

## Hard Rules

1. **Codex does the adversarial review across 5-10 distinct rounds.** Claude does NOT perform independent adversarial analysis.
2. **All 5 mandatory rounds must complete.** If any produces needs-attention, rounds 6-10 also run automatically.
3. **Codex output is presented first, verbatim.** Then triage begins.
4. **Patches are narrow.** Only fix what the finding specifically identifies.
5. **Verify after every patch.** Run the narrowest relevant test/check immediately.
6. **Preserve the user's focus text** exactly as given when passing to the script.
7. **If the user says "review-only"**, skip steps 5-7 entirely and return Codex output only.

## Output Format

The script outputs:
- **Round summary table**: verdict and finding count per round
- **Deduplicated findings**: merged across all 5 rounds, sorted by severity, tagged with round number
- **Next steps**: merged from all rounds

Use `--json` for raw structured output including per-round details.

## Prerequisite

Requires `codex` CLI installed (`npm install -g @openai/codex`) and authenticated (API key or ChatGPT login).
