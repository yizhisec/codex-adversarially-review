function severityRank(severity) {
  switch (severity) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    default:
      return 3;
  }
}

function formatLineRange(finding) {
  if (!finding.line_start) {
    return "";
  }
  if (!finding.line_end || finding.line_end === finding.line_start) {
    return `:${finding.line_start}`;
  }
  return `:${finding.line_start}-${finding.line_end}`;
}

function appendReasoningSection(lines, reasoningSummary) {
  if (!Array.isArray(reasoningSummary) || reasoningSummary.length === 0) {
    return;
  }

  lines.push("", "Reasoning:");
  for (const section of reasoningSummary) {
    lines.push(`- ${section}`);
  }
}

export function renderMultiRoundResult(roundResults, mergedResult, meta) {
  const totalRounds = roundResults.length;
  const lines = [
    `# Codex Adversarial Review (${totalRounds}-round)`,
    "",
    `Target: ${meta.targetLabel}`,
    `Verdict: ${mergedResult.verdict}`,
    "",
    mergedResult.summary,
    ""
  ];

  // 逐轮摘要
  lines.push("## Round Summary");
  lines.push("| Round | Lens | Verdict | Findings |");
  lines.push("| --- | --- | --- | --- |");
  for (const rr of roundResults) {
    const verdict = rr.parsed.parsed?.verdict ?? "error";
    const count = rr.parsed.parsed?.findings?.length ?? 0;
    const errorNote = rr.parsed.parseError ? ` (parse error)` : "";
    lines.push(`| ${rr.round} | ${rr.lens} | ${verdict}${errorNote} | ${count} |`);
  }
  lines.push("");

  // 汇总 findings（去重后）
  const findings = [...mergedResult.findings].sort(
    (left, right) => severityRank(left.severity) - severityRank(right.severity)
  );

  if (findings.length === 0) {
    lines.push(`No material findings across all ${totalRounds} rounds.`);
  } else {
    lines.push("## Findings (deduplicated)");
    for (const finding of findings) {
      const lineSuffix = formatLineRange(finding);
      const roundTag = finding._round ? `R${finding._round}` : "";
      lines.push(`- [${finding.severity}]${roundTag ? ` (${roundTag})` : ""} ${finding.title} (${finding.file}${lineSuffix})`);
      lines.push(`  ${finding.body}`);
      if (finding.recommendation) {
        lines.push(`  Recommendation: ${finding.recommendation}`);
      }
    }
  }

  if (mergedResult.next_steps.length > 0) {
    lines.push("", "## Next Steps");
    for (const step of mergedResult.next_steps) {
      lines.push(`- ${step}`);
    }
  }

  appendReasoningSection(lines, meta.reasoningSummary);

  return `${lines.join("\n").trimEnd()}\n`;
}
