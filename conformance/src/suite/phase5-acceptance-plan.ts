import { createHash } from "node:crypto";

export const PHASE5_MANIFEST_SHA256 =
  "e5d43e4f41f7d2276754468e04b4131f76076e37aeb5afd536b6ce9c8d5b77ca";

export const PHASE5_TWODART_REVISION =
  "90881bf9611c9de09bcfc326943494bc28fcd1bd";

export const PHASE5_DATASET_TREE_SHA256 =
  "3505b5fd24dc4e8fb1f9925b5201c6e28dbb993c7a0a2bebb34cb70d13d91fc7";

export interface Phase5Manifest {
  readonly amendment: {
    readonly amendedBeforeMeasurement: boolean;
    readonly criteriaWeakened: boolean;
    readonly previousManifestSha256: string;
    readonly reason: string;
    readonly thresholdsChanged: boolean;
    readonly workloadChanged: boolean;
  };
  readonly cacheWatcher: {
    readonly maximumReadySeconds: number;
    readonly officialAndFiresideOutputsMustMatch: boolean;
  };
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
  readonly diagnosticSmoke: {
    readonly dataset: {
      readonly baseFirestoreDocuments: number;
      readonly fileBytes: number;
      readonly fileCount: number;
      readonly path: string;
      readonly syntheticOnly: boolean;
      readonly treeSha256: string;
    };
    readonly executionOrder: readonly string[];
    readonly immutableGateInterventionAllowed: boolean;
    readonly maximumReadySeconds: number;
    readonly requirements: {
      readonly allNineBrowserJourneys: boolean;
      readonly bothStacks: boolean;
      readonly cleanup: boolean;
      readonly exportFirstShutdown: boolean;
      readonly fullDataForbiddenUntilPass: boolean;
      readonly orphanCheck: boolean;
    };
    readonly requiredBeforeEveryFullDataAttempt: boolean;
    readonly shortSoakSecondsPerStack: number;
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
      readonly swapDrain: {
        readonly requiredBeforeEachStack: boolean;
        readonly commands: readonly string[];
        readonly onlyWhenNoGateStackIsRunning: boolean;
        readonly recordInEnvironment: boolean;
        readonly recordVmSwappiness: boolean;
        readonly changeVmSwappinessAllowed: boolean;
      };
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
  readonly ciGating: {
    readonly finalCandidateRequiresFullMatrix: boolean;
    readonly fullMatrixJobCount: number;
    readonly fullMatrixRequiredScopes: readonly string[];
    readonly harnessOnlyPreSmokeRequiredJobs: readonly string[];
  };
  readonly soak: {
    readonly activeListenersPerEditorSession: number;
    readonly durationSeconds: number;
    readonly editorSessionsPerBackend: number;
    readonly memorySampleIntervalSeconds: number;
    readonly minimumSteadyMemorySamplesPerBackend: number;
    readonly simultaneousBackends: boolean;
    readonly executionOrder: readonly string[];
    readonly freshQuiescentPreflightBeforeEachBackend: boolean;
    readonly identicalConditions: boolean;
    readonly swapActivityPolicy: {
      readonly gating: boolean;
      readonly requiredMeasurement: boolean;
      readonly reportSideBySide: boolean;
      readonly winnerRequired: boolean;
      readonly fields: readonly string[];
    };
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
    readonly executionOrder: readonly string[];
  };
  readonly twodartSource: {
    readonly baselineRevision: string;
    readonly branch: string;
    readonly pullRequestMustRemainUnopened: boolean;
  };
  readonly twodartRuntimeAssets: {
    readonly filesMayAppearInEvidence: boolean;
    readonly trees: readonly {
      readonly fileBytes: number;
      readonly fileCount: number;
      readonly path: string;
      readonly treeSha256: string;
    }[];
  };
}

export function assertPhase5Manifest(
  manifest: Phase5Manifest,
  manifestBytes: Uint8Array,
): void {
  if (
    manifest.schemaVersion !== 3 ||
    manifest.name !== "phase-5-twodart-acceptance" ||
    !manifest.frozen
  ) {
    throw new Error("Phase 5 manifest is not the frozen schema-v3 manifest");
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
  assertRuntimeAssets(manifest);
  assertSafetyContract(manifest);
  assertEfficiencyCorrection(manifest);
  assertSwapBoundary(manifest);
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
    stacks.simultaneous ||
    JSON.stringify(stacks.executionOrder) !== JSON.stringify(["official", "fireside"]) ||
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
    soak.simultaneousBackends ||
    JSON.stringify(soak.executionOrder) !== JSON.stringify(["official", "fireside"]) ||
    !soak.freshQuiescentPreflightBeforeEachBackend ||
    !soak.identicalConditions ||
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

function assertEfficiencyCorrection(manifest: Phase5Manifest): void {
  const correction = manifest.amendment;
  const smoke = manifest.diagnosticSmoke;
  if (
    correction.previousManifestSha256 !==
      "27f643a6e6b5b060bb548359584a133e1bec937b06eb3b3f91982910a985faaa" ||
    !correction.amendedBeforeMeasurement ||
    !correction.criteriaWeakened ||
    !correction.thresholdsChanged ||
    correction.workloadChanged ||
    !smoke.requiredBeforeEveryFullDataAttempt ||
    smoke.maximumReadySeconds !== 60 ||
    smoke.shortSoakSecondsPerStack !== 60 ||
    JSON.stringify(smoke.executionOrder) !== JSON.stringify(["official", "fireside"]) ||
    smoke.immutableGateInterventionAllowed ||
    !Object.values(smoke.requirements).every(Boolean) ||
    smoke.dataset.path !== "conformance/fixtures/official-export-v1.22.0" ||
    !smoke.dataset.syntheticOnly ||
    smoke.dataset.baseFirestoreDocuments !== 4 ||
    smoke.dataset.fileCount !== 5 ||
    smoke.dataset.fileBytes !== 163_041 ||
    smoke.dataset.treeSha256 !==
      "e3a9bca45b0a70942922cc6690f5fbf277bd48ad213840b6981c5fd9ae68ff04"
  ) {
    throw new Error("Phase 5 two-tier diagnostic smoke contract diverged");
  }
  if (
    JSON.stringify(manifest.ciGating.harnessOnlyPreSmokeRequiredJobs) !==
      JSON.stringify(["Phase 5 harness", "Rust quality gate"]) ||
    manifest.ciGating.fullMatrixJobCount !== 6 ||
    manifest.ciGating.fullMatrixRequiredScopes.length !== 4 ||
    !manifest.ciGating.finalCandidateRequiresFullMatrix
  ) {
    throw new Error("Phase 5 tiered CI contract diverged");
  }
}

function assertSwapBoundary(manifest: Phase5Manifest): void {
  const { swapDrain, ...preflight } = manifest.host.preflight;
  const policy = manifest.soak.swapActivityPolicy;
  if (
    !swapDrain.requiredBeforeEachStack ||
    JSON.stringify(swapDrain.commands) !== JSON.stringify(["swapoff -a", "swapon -a"]) ||
    !swapDrain.onlyWhenNoGateStackIsRunning ||
    !swapDrain.recordInEnvironment ||
    !swapDrain.recordVmSwappiness ||
    swapDrain.changeVmSwappinessAllowed ||
    preflight.steadyVmstatSamples !== 3 ||
    preflight.maximumSwapInPagesPerSecond !== 0 ||
    preflight.maximumSwapOutPagesPerSecond !== 0 ||
    policy.gating || !policy.requiredMeasurement || !policy.reportSideBySide ||
    policy.winnerRequired ||
    JSON.stringify(policy.fields) !== JSON.stringify([
      "swapInPagesDelta", "swapOutPagesDelta", "residualSwapBytesAtStart", "residualSwapBytesAtEnd",
    ])
  ) {
    throw new Error("Phase 5 schema-v3 preflight/soak swap boundary diverged");
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
    manifest.dataset.piiMayAppearInEvidence ||
    manifest.twodartRuntimeAssets.filesMayAppearInEvidence
  ) {
    throw new Error("Phase 5 safety boundary diverged");
  }
}

function assertRuntimeAssets(manifest: Phase5Manifest): void {
  const expected = [
    [
      "engines/twodartnet/TwodartNet/Assets/globalFonts",
      46,
      14_315_300,
      "415edbf85ef3d09789b3a64bf14eb65550e8876915d892c0018b7ec96b8a40cf",
    ],
    [
      "engines/twodartnet/TwodartNet/Assets/masterSlidesBase",
      3,
      93_371,
      "27dd0b395aee2f557a90c7b8cb58fbdd2b1dd4fd2b0861cc76911d34ba7685a8",
    ],
    [
      "engines/twodartnet/TwodartNet/Assets/slides",
      10_918,
      522_696_779,
      "b1ecdef81da630d286fabcc5f6973b5544c09e3f381f9c29ffef1b93e543fd63",
    ],
  ] as const;
  const observed = manifest.twodartRuntimeAssets.trees.map((tree) => [
    tree.path,
    tree.fileCount,
    tree.fileBytes,
    tree.treeSha256,
  ]);
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    throw new Error("Phase 5 Twodart runtime asset identity diverged");
  }
}
