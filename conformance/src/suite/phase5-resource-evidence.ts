export type ResourceStack = "official" | "fireside";

export interface Phase5SwapActivity {
  readonly residualSwapBytesAtEnd: number | null;
  readonly residualSwapBytesAtStart: number | null;
  readonly sampleCount: number;
  readonly swapInPagesDelta: number | null;
  readonly swapOutPagesDelta: number | null;
}

export interface TopPssProcess {
  readonly command: string;
  readonly pid: number;
  readonly peakPssBytes: number | null;
  readonly peakRssBytes: number;
  readonly samples: number;
}

interface ProcessSample {
  readonly command: string;
  readonly pid: number;
  readonly pssBytes: number | null;
  readonly rssBytes: number;
}

export interface Phase5ResourceEvidence {
  readonly durationSeconds: number;
  readonly passed: boolean;
  readonly swapActivity: Phase5SwapActivity;
  readonly topProcessesByPss: Partial<Record<ResourceStack, readonly TopPssProcess[]>>;
}

// Completeness/validity is required; the size of the activity is not a gate.
export function validPhase5SwapMeasurement(value: Partial<Phase5SwapActivity> | undefined): boolean {
  return value !== undefined && Number.isInteger(value.sampleCount) && (value.sampleCount ?? 0) >= 2 &&
    [value.swapInPagesDelta, value.swapOutPagesDelta, value.residualSwapBytesAtStart, value.residualSwapBytesAtEnd]
      .every((counter) => typeof counter === "number" && Number.isSafeInteger(counter) && counter >= 0);
}

export function topPhase5ProcessesByPss(
  samples: readonly { readonly stacks: Partial<Record<ResourceStack, { readonly processes: readonly ProcessSample[] }>> }[],
  stack: ResourceStack,
): TopPssProcess[] {
  const processes = new Map<string, TopPssProcess>();
  for (const sample of samples) {
    for (const process of sample.stacks[stack]?.processes ?? []) {
      const key = `${process.pid}:${process.command}`;
      const previous = processes.get(key);
      processes.set(key, {
        command: process.command, pid: process.pid,
        peakPssBytes: previous?.peakPssBytes == null ? process.pssBytes :
          Math.max(previous.peakPssBytes, process.pssBytes ?? 0),
        peakRssBytes: Math.max(previous?.peakRssBytes ?? 0, process.rssBytes),
        samples: (previous?.samples ?? 0) + 1,
      });
    }
  }
  return [...processes.values()].sort((a, b) =>
    (b.peakPssBytes ?? -1) - (a.peakPssBytes ?? -1) || a.pid - b.pid,
  ).slice(0, 10);
}

export function phase5ResourceComparison(soaks: Partial<Record<ResourceStack, Phase5ResourceEvidence>>) {
  return {
    schemaVersion: 3,
    swapIsMeasurementOnly: true,
    winnerRequired: false,
    topProcessRanking: "per-PID maximum sampled PSS; independent ranks, not matched process identities",
    stacks: Object.fromEntries((["official", "fireside"] as const).map((stack) => {
      const soak = soaks[stack];
      return [stack, soak === undefined ? null : {
        durationSeconds: soak.durationSeconds, passed: soak.passed,
        swapActivity: soak.swapActivity,
        topProcessesByPss: soak.topProcessesByPss[stack] ?? [],
      }];
    })),
  };
}

export function renderPhase5ResourceComparison(soaks: Partial<Record<ResourceStack, Phase5ResourceEvidence>>): string {
  const value = (stack: ResourceStack, field: keyof Phase5SwapActivity): string =>
    String(soaks[stack]?.swapActivity[field] ?? "not measured");
  const rows = [
    ["Swap-in pages", "swapInPagesDelta"],
    ["Swap-out pages", "swapOutPagesDelta"],
    ["Residual swap at window start (bytes)", "residualSwapBytesAtStart"],
    ["Residual swap at window end (bytes)", "residualSwapBytesAtEnd"],
  ] as const;
  const escape = (text: string): string => text.replaceAll("|", "\\|").replaceAll("\n", " ");
  const process = (stack: ResourceStack, rank: number): readonly [string, string] => {
    const entry = soaks[stack]?.topProcessesByPss[stack]?.[rank];
    if (entry === undefined) return ["not measured", "not measured"];
    return [`${escape(entry.command)} (PID ${entry.pid})`, String(entry.peakPssBytes ?? "unavailable")];
  };
  const count = Math.max(...(["official", "fireside"] as const).map((stack) =>
    soaks[stack]?.topProcessesByPss[stack]?.length ?? 0));
  return "## Soak resource measurements\n\n" +
    "Swap activity is reported, not gated. No performance winner is required. Missing stacks are not measured, never zero.\n\n" +
    "| Measurement | Official | Fireside |\n| --- | ---: | ---: |\n" +
    rows.map(([label, field]) => `| ${label} | ${value("official", field)} | ${value("fireside", field)} |`).join("\n") +
    "\n\nTop processes ranked independently by per-PID maximum sampled PSS (not simultaneous totals):\n\n" +
    "| Rank | Official process | Peak PSS (bytes) | Fireside process | Peak PSS (bytes) |\n| ---: | --- | ---: | --- | ---: |\n" +
    Array.from({ length: count }, (_, rank) =>
      `| ${[rank + 1, ...process("official", rank), ...process("fireside", rank)].join(" | ")} |`,
    ).join("\n") + "\n\n";
}
