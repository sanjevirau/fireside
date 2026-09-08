import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  circularPhaseSlopes,
  findJointHarmonicPeriod,
  interpolatedQuantile,
  type ResidentSample,
} from "./endurance/oscillation.ts";
import { median, theilSenBytesPerHour } from "./endurance/statistics.ts";

interface RunInput {
  readonly label: string;
  readonly path: string;
}

interface RssRow extends ResidentSample {
  readonly timestamp: string;
  readonly pssBytes: number;
}

function parseArguments(arguments_: readonly string[]): {
  readonly output: string;
  readonly runs: readonly RunInput[];
} {
  const outputIndex = arguments_.indexOf("--output");
  const output = outputIndex >= 0 ? arguments_[outputIndex + 1] : undefined;
  const runArguments = arguments_.filter((argument, index) =>
    argument !== "--output" && index !== outputIndex + 1
  );
  if (output === undefined || runArguments.length !== 3) {
    throw new Error(
      "usage: analyze-disk-rss-oscillation --output <path> label=path label=path label=path",
    );
  }
  return {
    output: resolve(output),
    runs: runArguments.map((argument) => {
      const separator = argument.indexOf("=");
      if (separator <= 0) {
        throw new Error(`invalid run argument: ${argument}`);
      }
      return {
        label: argument.slice(0, separator),
        path: resolve(argument.slice(separator + 1)),
      };
    }),
  };
}

async function loadRss(path: string): Promise<RssRow[]> {
  const rows = (await readFile(path, "utf8")).trim().split("\n");
  const headers = rows.shift()?.split(",") ?? [];
  const index = (name: string): number => {
    const value = headers.indexOf(name);
    if (value < 0) {
      throw new Error(`${path} is missing ${name}`);
    }
    return value;
  };
  const timestamp = index("timestamp");
  const elapsed = index("elapsed_seconds");
  const rss = index("rss_bytes");
  const pss = index("pss_bytes");
  return rows.map((row) => {
    const values = row.split(",");
    return {
      timestamp: values[timestamp] ?? "",
      elapsedSeconds: Number(values[elapsed]),
      rssBytes: Number(values[rss]),
      pssBytes: Number(values[pss]),
    };
  });
}

function summarize(label: string, samples: readonly RssRow[]) {
  const postWarmup = samples.filter((sample) => sample.elapsedSeconds >= 1_800);
  const rssBytes = postWarmup.map((sample) => sample.rssBytes);
  const phaseSlopes = circularPhaseSlopes(postWarmup);
  const lower = interpolatedQuantile(rssBytes, 0.05);
  const upper = interpolatedQuantile(rssBytes, 0.95);
  const slope = theilSenBytesPerHour(postWarmup);
  if (lower === null || upper === null || slope === null) {
    throw new Error(`${label} does not contain enough post-warm-up samples`);
  }
  return {
    label,
    samples: postWarmup.length,
    elapsedSeconds: [postWarmup[0]?.elapsedSeconds, postWarmup.at(-1)?.elapsedSeconds],
    slopeBytesPerHour: slope,
    rssBytes: {
      minimum: Math.min(...rssBytes),
      maximum: Math.max(...rssBytes),
      median: median(rssBytes),
      p05: lower,
      p95: upper,
      central90PercentPeakToPeak: upper - lower,
    },
    circularPhaseSensitivity: {
      minimumSlopeBytesPerHour: Math.min(...phaseSlopes),
      p05SlopeBytesPerHour: interpolatedQuantile(phaseSlopes, 0.05),
      medianSlopeBytesPerHour: median(phaseSlopes),
      p95SlopeBytesPerHour: interpolatedQuantile(phaseSlopes, 0.95),
      maximumSlopeBytesPerHour: Math.max(...phaseSlopes),
      passingFraction: phaseSlopes.filter((value) => value <= 1_048_576).length
        / phaseSlopes.length,
      assumption: "The observed bounded sequence is treated as circular; this is a phase sensitivity, not proof of a stationary periodic process.",
    },
  };
}

const parsed = parseArguments(process.argv.slice(2));
const loaded = await Promise.all(parsed.runs.map(async (run) => ({
  ...run,
  samples: await loadRss(run.path),
})));
const postWarmupRuns = loaded.map((run) =>
  run.samples.filter((sample) => sample.elapsedSeconds >= 1_800)
);
const harmonic = findJointHarmonicPeriod(postWarmupRuns, 120, 1_200);
const summaries = loaded.map((run) => summarize(run.label, run.samples));
const allRssBytes = postWarmupRuns.flatMap((samples) => samples.map((sample) => sample.rssBytes));
const analysis = {
  generatedAt: new Date().toISOString(),
  metric: "process RSS sampled every approximately 10 seconds",
  population: "three controlled one-hour Fireside disk/WAL runs after the frozen 30-minute warm-up",
  thresholdBytesPerHour: 1_048_576,
  combinedEnvelope: {
    minimumRssBytes: Math.min(...allRssBytes),
    maximumRssBytes: Math.max(...allRssBytes),
    medianRssBytes: median(allRssBytes),
  },
  jointHarmonic: {
    periodSeconds: harmonic.periodSeconds,
    normalizedResidualScore: harmonic.normalizedResidualScore,
    fits: harmonic.fits.map((fit, index) => ({
      label: loaded[index]?.label,
      amplitudeBytes: fit.amplitudeBytes,
      rSquared: fit.rSquared,
      phaseRadians: fit.phaseRadians,
      trendBytesPerHour: fit.trendBytesPerHour,
    })),
    limitation: "The shared harmonic is descriptive. Its modest R-squared values and the short observation windows do not establish a stable allocator period.",
  },
  runs: summaries,
  conclusion: "The three windows occupy different phases of a bounded resident-page envelope, making the 30-minute slope phase-sensitive. A deterministic eager-decommit experiment is justified, but the traces do not prove a single stable period or an accumulating logical owner.",
};
await writeFile(parsed.output, `${JSON.stringify(analysis, null, 2)}\n`, "utf8");
