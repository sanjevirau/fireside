export interface KarmaEvidence {
  readonly completedTests: number;
  readonly failedTests: number;
  readonly nativeSkipNames: readonly string[];
  readonly nativeSkips: number;
}

export interface ObservedKarmaProcess {
  readonly exitCode: number | null;
  readonly output: string;
  readonly signal: NodeJS.Signals | null;
}

export function parseKarmaEvidence(output: string): KarmaEvidence {
  const plain = output.replaceAll(/\u001b\[[0-9;]*m/gu, "");
  const total =
    /TOTAL:\s+(?:(\d+)\s+FAILED,\s+)?(\d+)\s+SUCCESS/gu.exec(plain);
  if (total?.[2] === undefined) {
    throw new Error(
      "upstream Karma output did not report its completed test count",
    );
  }
  const nativeSkipNames = [
    ...plain.matchAll(/^\s*✖\s+(.+?)\s+\(skipped\)\s*$/gmu),
  ]
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined);
  const reportedSkips = /ℹ\s+(\d+)\s+tests? skipped/gu.exec(plain)?.[1];
  if (
    reportedSkips !== undefined &&
    Number.parseInt(reportedSkips, 10) !== nativeSkipNames.length
  ) {
    throw new Error(
      "upstream Karma output did not name every reported native skip",
    );
  }
  return {
    completedTests: Number.parseInt(total[2], 10),
    failedTests: total[1] === undefined ? 0 : Number.parseInt(total[1], 10),
    nativeSkipNames: [...new Set(nativeSkipNames)].sort(),
    nativeSkips: nativeSkipNames.length,
  };
}

export function isAcceptedKarmaProcess(
  process: ObservedKarmaProcess,
  evidence: KarmaEvidence,
): boolean {
  if (
    process.signal !== null ||
    evidence.failedTests !== 0 ||
    hasInfrastructureFailure(process.output)
  ) {
    return false;
  }
  if (process.exitCode === 0) {
    return evidence.completedTests > 0;
  }
  return (
    process.exitCode === 1 &&
    evidence.completedTests === 0 &&
    evidence.nativeSkips > 0 &&
    /SUMMARY:\s*[\s\S]*?✔\s+0 tests completed[\s\S]*?ℹ\s+\d+ tests? skipped/gu.test(
      process.output.replaceAll(/\u001b\[[0-9;]*m/gu, ""),
    )
  );
}

function hasInfrastructureFailure(output: string): boolean {
  const plain = output.replaceAll(/\u001b\[[0-9;]*m/gu, "");
  return /\b(?:DISCONNECTED|CRASHED)\b|ERROR \[(?:karma-server|launcher)\]|(?:Chrome|Firefox)[^\n]*\bERROR\b/iu.test(
    plain,
  );
}
