import { createHash } from "node:crypto";

export const PHASE5_MANIFEST_SHA256 =
  "7838a8c5cd97791b506c3ce93749620360da4849a99352fb01fef1f26ce098b3";

export const PHASE5_TWODART_REVISION =
  "90881bf9611c9de09bcfc326943494bc28fcd1bd";

export const PHASE5_DATASET_TREE_SHA256 =
  "3505b5fd24dc4e8fb1f9925b5201c6e28dbb993c7a0a2bebb34cb70d13d91fc7";

export interface Phase5Manifest {
  readonly dataset: {
    readonly fileBytes: number;
    readonly fileCount: number;
    readonly logicalCounts: {
      readonly authUsers: number;
      readonly firestoreDocuments: number;
      readonly storageObjectBytes: number;
      readonly storageObjects: number;
    };
    readonly piiMayAppearInEvidence: boolean;
    readonly realDataMayAppearInEvidence: boolean;
    readonly treeSha256: string;
  };
  readonly differentialJourneys: {
    readonly allowedFunctionalDivergences: number;
    readonly assertionLayers: readonly string[];
    readonly journeys: readonly {
      readonly id: string;
      readonly requirements: readonly string[];
    }[];
    readonly rerunAfterLifecycleRestart: boolean;
  };
  readonly frozen: boolean;
  readonly host: {
    readonly minimumAvailableDiskBytes: number;
    readonly preflight: {
      readonly currentBootOomOrResourceKills: number;
      readonly failedUnits: number;
      readonly maximumSwapInPagesPerSecond: number;
      readonly maximumSwapOutPagesPerSecond: number;
      readonly steadyVmstatSamples: number;
    };
    readonly sshAlias: string;
  };
  readonly lifecycle: {
    readonly acknowledgedWriteLossAllowed: number;
    readonly allowedCountMismatch: number;
    readonly exportOnExitRequired: boolean;
    readonly rerunAllJourneysRequired: boolean;
    readonly restartFromExactExportRequired: boolean;
  };
  readonly name: string;
  readonly phase4Baseline: {
    readonly manifestSha256: string;
    readonly tag: string;
    readonly taggedRevision: string;
  };
  readonly safety: {
    readonly customEmulatorUiAllowed: boolean;
    readonly evalLabRunsAllowed: boolean;
    readonly externalProviderMutationsAllowed: boolean;
    readonly liveMacMprocsMustRemainUntouched: boolean;
    readonly productionSecretsAllowed: boolean;
  };
  readonly schemaVersion: number;
  readonly soak: {
    readonly activeListenersPerEditorSession: number;
    readonly durationSeconds: number;
    readonly editorSessionsPerBackend: number;
    readonly memorySampleIntervalSeconds: number;
    readonly minimumSteadyMemorySamplesPerBackend: number;
    readonly simultaneousBackends: boolean;
    readonly thresholds: {
      readonly acknowledgedStateMismatches: number;
      readonly duplicateObservableEffects: number;
      readonly errors: number;
      readonly failedUnits: number;
      readonly listenerGaps: number;
      readonly oomOrResourceKills: number;
      readonly stalls: number;
      readonly syntheticArtifactsRemaining: number;
    };
    readonly workload: {
      readonly catalogRead: {
        readonly expectedReadsPerBackend: number;
        readonly intervalSecondsPerSession: number;
      };
      readonly gatewayJob: {
        readonly expectedWritesPerBackend: number;
        readonly intervalSecondsPerSession: number;
      };
      readonly runAndCaseStatus: {
        readonly expectedWritesPerBackend: number;
        readonly intervalSecondsPerSession: number;
      };
      readonly storageCycle: {
        readonly expectedCyclesPerBackend: number;
        readonly intervalSecondsPerSession: number;
        readonly payloadBytes: number;
      };
      readonly tokenBatch: {
        readonly expectedBatchesPerSession: number;
        readonly expectedTokenWritesPerBackend: number;
        readonly intervalSecondsPerSession: number;
        readonly writesPerBatch: number;
      };
      readonly twodartFunctionTrigger: {
        readonly expectedDispatchesPerBackend: number;
        readonly intervalSecondsPerSession: number;
      };
    };
  };
  readonly stacks: {
    readonly fireside: {
      readonly portBlock: Readonly<Record<string, number>>;
    };
    readonly official: {
      readonly portBlock: Readonly<Record<string, number>>;
    };
    readonly sameDataset: boolean;
    readonly sameFunctionsBuild: boolean;
    readonly sameSourceRevision: boolean;
    readonly sameToolchain: boolean;
    readonly simultaneous: boolean;
  };
  readonly twodartSource: {
    readonly baselineRevision: string;
    readonly branch: string;
    readonly pullRequestMustRemainUnopened: boolean;
  };
}

export function assertPhase5Manifest(
  manifest: Phase5Manifest,
  manifestBytes: Uint8Array,
): void {
  if (
    manifest.schemaVersion !== 1 ||
    manifest.name !== "phase-5-twodart-acceptance" ||
    !manifest.frozen
  ) {
    throw new Error("Phase 5 manifest is not the frozen schema-v1 manifest");
  }

  const digest = createHash("sha256").update(manifestBytes).digest("hex");
  if (digest !== PHASE5_MANIFEST_SHA256) {
    throw new Error(`Phase 5 manifest SHA-256 mismatch: ${digest}`);
  }
  if (
    manifest.phase4Baseline.tag !== "phase-4" ||
    manifest.twodartSource.baselineRevision !== PHASE5_TWODART_REVISION ||
    manifest.dataset.treeSha256 !== PHASE5_DATASET_TREE_SHA256
  ) {
    throw new Error("Phase 5 immutable source baseline diverged");
  }

  assertJourneyContract(manifest);
  assertStackContract(manifest);
  assertSoakContract(manifest);
  assertSafetyContract(manifest);
}

function assertJourneyContract(manifest: Phase5Manifest): void {
  const expected = [
    "otp-auth-login",
    "dashboard-and-deck-list",
    "existing-deck-and-listener-edit",
    "catalog-slide-add",
    "deck-image-upload",
    "duplicate-and-delete-deck",
    "dotnet-deck-export",
    "dev-admin-pages",
    "sign-out-and-sign-in",
  ];
  const observed = manifest.differentialJourneys.journeys.map(({ id }) => id);
  if (
    JSON.stringify(observed) !== JSON.stringify(expected) ||
    manifest.differentialJourneys.allowedFunctionalDivergences !== 0 ||
    manifest.differentialJourneys.assertionLayers.length !== 3 ||
    !manifest.differentialJourneys.rerunAfterLifecycleRestart
  ) {
    throw new Error("Phase 5 differential journey contract diverged");
  }
}

function assertStackContract(manifest: Phase5Manifest): void {
  const stacks = manifest.stacks;
  if (
    !stacks.simultaneous ||
    !stacks.sameDataset ||
    !stacks.sameSourceRevision ||
    !stacks.sameToolchain ||
    !stacks.sameFunctionsBuild
  ) {
    throw new Error("Phase 5 two-stack parity contract diverged");
  }
  const officialPorts = Object.values(stacks.official.portBlock);
  const firesidePorts = Object.values(stacks.fireside.portBlock);
  const allPorts = [...officialPorts, ...firesidePorts];
  if (new Set(allPorts).size !== allPorts.length) {
    throw new Error("Phase 5 stack ports must be globally unique");
  }
}

function assertSoakContract(manifest: Phase5Manifest): void {
  const soak = manifest.soak;
  const thresholds = Object.values(soak.thresholds);
  if (
    soak.durationSeconds !== 7_200 ||
    soak.editorSessionsPerBackend !== 2 ||
    soak.memorySampleIntervalSeconds !== 30 ||
    soak.minimumSteadyMemorySamplesPerBackend !== 240 ||
    soak.activeListenersPerEditorSession !== 1 ||
    !soak.simultaneousBackends ||
    thresholds.some((value) => value !== 0)
  ) {
    throw new Error("Phase 5 soak boundary diverged");
  }
  const workload = soak.workload;
  if (
    workload.tokenBatch.intervalSecondsPerSession !== 5 ||
    workload.tokenBatch.writesPerBatch !== 20 ||
    workload.tokenBatch.expectedBatchesPerSession !== 1_440 ||
    workload.tokenBatch.expectedTokenWritesPerBackend !== 57_600 ||
    workload.gatewayJob.expectedWritesPerBackend !== 1_440 ||
    workload.runAndCaseStatus.expectedWritesPerBackend !== 960 ||
    workload.catalogRead.expectedReadsPerBackend !== 480 ||
    workload.storageCycle.payloadBytes !== 65_536 ||
    workload.storageCycle.expectedCyclesPerBackend !== 240 ||
    workload.twodartFunctionTrigger.expectedDispatchesPerBackend !== 240
  ) {
    throw new Error("Phase 5 app-shaped workload diverged");
  }
}

function assertSafetyContract(manifest: Phase5Manifest): void {
  const safety = manifest.safety;
  if (
    !safety.liveMacMprocsMustRemainUntouched ||
    safety.productionSecretsAllowed ||
    safety.externalProviderMutationsAllowed ||
    safety.customEmulatorUiAllowed ||
    safety.evalLabRunsAllowed ||
    manifest.twodartSource.pullRequestMustRemainUnopened === false ||
    manifest.dataset.realDataMayAppearInEvidence ||
    manifest.dataset.piiMayAppearInEvidence
  ) {
    throw new Error("Phase 5 safety boundary diverged");
  }
}
