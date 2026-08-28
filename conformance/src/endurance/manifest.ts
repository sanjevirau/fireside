import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface EnduranceManifest {
  readonly name: string;
  readonly frozen: boolean;
  readonly soak: {
    readonly durationSeconds: number;
    readonly warmupSeconds: number;
    readonly rssSampleIntervalSeconds: number;
    readonly metricRollupIntervalSeconds: number;
    readonly targetWritesPerSecond: number;
    readonly minimumCompletionRatio: number;
    readonly maxConcurrentOperations: number;
    readonly transactionSchedule: {
      readonly modulus: number;
      readonly remainder: number;
      readonly hotDocumentCount: number;
      readonly maxAttempts: number;
    };
    readonly targetSchedule: {
      readonly largeDocument: ModulusSchedule;
      readonly listenerDocument: ModulusSchedule;
    };
    readonly workingSet: {
      readonly documentCount: number;
      readonly collection: string;
      readonly smallDocumentCount: number;
      readonly smallPayloadBytes: number;
      readonly largeDocumentCount: number;
      readonly largeDocumentSizesBytes: readonly number[];
      readonly maximumObservedFiresideRssBytes: number;
      readonly listenerDocumentCount: number;
      readonly listenerDocumentIndexes: readonly number[];
      readonly seedBatchSize: number;
    };
    readonly listeners: {
      readonly activeCount: number;
      readonly churnIntervalSeconds: number;
      readonly finalDrainSeconds: number;
      readonly requireMonotonicPerDocumentSequence: boolean;
      readonly requireFinalExpectedState: boolean;
    };
    readonly progress: {
      readonly maximumNoCompletionSeconds: number;
      readonly unexpectedErrorsAllowed: number;
      readonly listenerMismatchesAllowed: number;
    };
    readonly memory: {
      readonly maximumRssSlopeBytesPerHour: number;
      readonly initialMedianWindowStartSeconds: number;
      readonly initialMedianWindowEndSeconds: number;
      readonly finalMedianWindowSeconds: number;
      readonly maximumFinalMedianIncreaseFraction: number;
      readonly maximumFinalMedianIncreaseBytesFloor: number;
      readonly failFast: {
        readonly sustainedWindowSeconds: number;
        readonly maximumSlopeMultiple: number;
      };
    };
  };
  readonly import: {
    readonly documentCount: number;
    readonly payloadBytesPerDocument: number;
    readonly minimumArtifactBytes: number;
    readonly maximumArtifactBytes: number;
    readonly maximumPeakRssBytes: number;
    readonly rssSampleIntervalMilliseconds: number;
    readonly verificationRandomReads: number;
    readonly verificationConcurrency: number;
    readonly unexpectedErrorsAllowed: number;
  };
  readonly recovery: {
    readonly rounds: number;
    readonly minimumAcknowledgedCommits: number;
    readonly acknowledgedCommitsBeforeEachKill: number;
    readonly documentsPerAtomicCommit: number;
    readonly randomKillDelayMilliseconds: {
      readonly minimum: number;
      readonly maximum: number;
    };
    readonly acknowledgedWritesLostAllowed: number;
    readonly partialAtomicCommitsAllowed: number;
  };
  readonly javaComparison: {
    readonly heapFailureRetry: {
      readonly maximumAdditionalRuns: number;
      readonly javaToolOptions: string;
    };
  };
  readonly telemetry: {
    readonly root: string;
    readonly files: Record<string, string>;
  };
}

interface ModulusSchedule {
  readonly modulus: number;
  readonly remainder: number;
}

export const repositoryRoot = resolve(import.meta.dirname, "../../..");
export const manifestPath = resolve(
  repositoryRoot,
  "benchmarks/phase-1-endurance.json",
);

export async function loadManifest(): Promise<EnduranceManifest> {
  const parsed: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("endurance manifest must be a JSON object");
  }
  const manifest = parsed as EnduranceManifest;
  if (manifest.frozen !== true || manifest.name !== "phase-1-endurance") {
    throw new Error("refusing to run an unfrozen or unexpected endurance manifest");
  }
  if (manifest.soak.workingSet.documentCount !== 100_000) {
    throw new Error("frozen endurance working set must contain 100,000 documents");
  }
  if (manifest.soak.listeners.activeCount !== 8) {
    throw new Error("frozen endurance manifest must keep eight listeners active");
  }
  if (
    manifest.soak.memory.failFast.sustainedWindowSeconds !== 3_600
    || manifest.soak.memory.failFast.maximumSlopeMultiple !== 10
  ) {
    throw new Error("frozen endurance fail-fast observation rule was changed");
  }
  return manifest;
}
