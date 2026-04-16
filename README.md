# Codex Adversarial Review — Claude Code Skill

A Claude Code skill that uses **OpenAI Codex** to perform multi-round adversarial code review on git changes. Instead of Claude reviewing its own work, an independent model does the review across 5-10 distinct attack surfaces.

## How It Works

```
Claude (dispatcher) → Codex CLI (reviewer) × 5-10 rounds → Structured findings → Claude triage (fix/ask/skip)
```

1. **Rounds 1-5 (mandatory)**: Each round uses a different lens — semantics, failure paths, tests, complexity, safety
2. **Rounds 6-10 (conditional)**: If any mandatory round finds issues, 5 extra rounds automatically run — concurrency, performance, API compatibility, security, final hostile pass
3. **Triage**: Claude classifies each finding as `fix-now`, `ask-user`, or `no-action`

## Prerequisites

- [Codex CLI](https://github.com/openai/codex) installed: `npm install -g @openai/codex`
- OpenAI authentication configured: `codex login`
- Claude Code (CC) with skill support

## Installation

```bash
# Clone to Claude Code global skills directory
mkdir -p ~/.claude/skills
cp -r . ~/.claude/skills/reviewing-workspace-changes-adversarially
```

Or symlink:

```bash
git clone git@github.com:yizhisec/codex-adversarially-review.git
ln -s "$(pwd)/codex-adversarially-review" ~/.claude/skills/reviewing-workspace-changes-adversarially
```

## Usage

In Claude Code, trigger with natural language:

```
> 对抗式审查当前改动
> adversarial review against main
> review this branch
```

Or with flags:

```bash
# Review working tree
node ~/.claude/skills/reviewing-workspace-changes-adversarially/scripts/codex-review.mjs

# Review branch against main
node ~/.claude/skills/reviewing-workspace-changes-adversarially/scripts/codex-review.mjs --base main

# With focus area
node ~/.claude/skills/reviewing-workspace-changes-adversarially/scripts/codex-review.mjs "focus on auth and permissions"

# JSON output
node ~/.claude/skills/reviewing-workspace-changes-adversarially/scripts/codex-review.mjs --json
```

## Review Rounds

### Mandatory (always run)

| Round | Lens | Focus |
|---|---|---|
| 1 | Semantics and invariants | Wrong behavior, broken contracts, missing guards |
| 2 | Failure paths | Null handling, retries, partial failure, rollback |
| 3 | Tests and observability | Missing assertions, false positives, weak logs |
| 4 | Complexity and YAGNI | DRY violations, over-abstraction, dead code |
| 5 | Safety and integration | Sensitive files, cross-file consistency, regressions |

### Extra (triggered by needs-attention in rounds 1-5)

| Round | Lens | Focus |
|---|---|---|
| 6 | Concurrency | Race conditions, stale state, re-entrancy |
| 7 | Performance | N+1 queries, unbounded growth, memory leaks |
| 8 | API compatibility | Breaking changes, schema drift, migration hazards |
| 9 | Security | Injection, auth bypass, secret exposure |
| 10 | Final hostile pass | Assume everything above missed something |

## Output Format

Each round produces structured JSON:

```json
{
  "verdict": "approve | needs-attention",
  "summary": "terse ship/no-ship assessment",
  "findings": [{
    "severity": "critical | high | medium | low",
    "title": "...",
    "body": "...",
    "file": "path/to/file.ts",
    "line_start": 42,
    "line_end": 58,
    "confidence": 0.92,
    "recommendation": "..."
  }],
  "next_steps": ["..."]
}
```

Results are deduplicated across rounds and rendered as markdown.

## Architecture

```
SKILL.md                    # Claude behavior rules
plugin.json                 # App-server client identity
scripts/
├── codex-review.mjs        # Main entry: 5-10 round loop
├── lib/
│   ├── codex.mjs           # Codex app-server client (from codex-plugin-cc)
│   ├── app-server.mjs      # JSON-RPC over stdio
│   ├── git.mjs             # Diff/context collection
│   ├── render.mjs           # Multi-round result rendering
│   └── ...                 # Supporting modules
├── prompts/
│   └── adversarial-review.md  # Per-round prompt template
└── schemas/
    └── review-output.schema.json  # Structured output schema
```

Runtime modules under `scripts/lib/` are adapted from [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (MIT licensed).

## Community

Built with [Claude Code](https://claude.ai/code). More Claude Code skills and workflows at [cdcode.org](https://cdcode.org).

## License

MIT
