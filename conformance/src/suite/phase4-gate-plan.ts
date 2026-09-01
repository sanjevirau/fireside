import { createHash } from "node:crypto";

export const PHASE4_MANIFEST_SHA256 =
  "38697418c65d667dfcc64480e8b05ff4d16ed0f330beb19c64e9da04508dd3d2";

export const PHASE4_PROJECT_ID = "demo-twodart-local";

export const PHASE4_MODES = ["memory", "disk-wal"] as const;

export type Phase4Mode = (typeof PHASE4_MODES)[number];

export interface Phase4Manifest {
  readonly frozen: boolean;
  readonly name: string;
  readonly oraclePolicy: {
    readonly requiredFixtureSets: readonly string[];
  };
  readonly schemaVersion: number;
  readonly toolchain: {
    readonly gateJavaMajor: number;
    readonly gateNode: string;
    readonly gateNpm: string;
    readonly rust: string;
    readonly twodartBun: string;
    readonly twodartFirebaseAdmin: string;
    readonly twodartFirebaseJsSdk: string;
    readonly twodartFirebaseTools: string;
    readonly twodartFirebaseFunctions: string;
    readonly twodartNodeRuntime: number;
  };
  readonly twodartContract: {
    readonly configurationChecksums: Readonly<Record<string, string>>;
    readonly customFunctions: {
      readonly callable: number;
      readonly firestoreBackground: number;
      readonly http: number;
      readonly scheduled: number;
      readonly total: number;
    };
    readonly projectId: string;
    readonly readyPattern: string;
    readonly sourceRevision: string;
    readonly storageBuckets: readonly string[];
  };
  readonly gates: {
    readonly chaos: {
      readonly authTriggerRetries: number;
      readonly concurrentWritesPerTriggerPattern: number;
      readonly droppedTriggerResponses: number;
      readonly duplicateFirestoreEvents: number;
      readonly duplicateObservableEffects: number;
      readonly lostAcknowledgedEffects: number;
      readonly resumableUploadInterruptions: number;
      readonly suiteForcedRestarts: number;
    };
    readonly performance: {
      readonly thresholds: {
        readonly authOperationP99Milliseconds: number;
        readonly fullDataExportMaximumSeconds: number;
        readonly fullDataImportMaximumSeconds: number;
        readonly fullDataPeakRssBytes: number;
        readonly listenerRegressionFromPhase3MaximumPercent: number;
        readonly smallStorageOperationP99Milliseconds: number;
        readonly suiteReadyMaximumMilliseconds: number;
        readonly triggerDeliveryP99Milliseconds: number;
      };
    };
    readonly twodartFullData: {
      readonly components: readonly string[];
      readonly datasetEnvironmentVariable: string;
      readonly minimumStorageBytes: number;
      readonly minimumStorageObjects: number;
      readonly observedDatasetKiB: number;
      readonly required: boolean;
    };
  };
}

export interface Phase4ObservedToolchain {
  readonly bun: string;
  readonly firebaseAdmin: string;
  readonly firebaseFunctions: string;
  readonly firebaseJsSdk: string;
  readonly firebaseTools: string;
  readonly java: string;
  readonly node: string;
  readonly npm: string;
  readonly rust: string;
}

export function assertPhase4Manifest(
  manifest: Phase4Manifest,
  manifestBytes: Uint8Array,
): void {
  if (
    manifest.schemaVersion !== 1 ||
    manifest.name !== "phase-4-twodart-suite" ||
    !manifest.frozen
  ) {
    throw new Error("Phase 4 manifest is not the frozen schema-v1 manifest");
  }
  const digest = createHash("sha256").update(manifestBytes).digest("hex");
  if (digest !== PHASE4_MANIFEST_SHA256) {
    throw new Error(`Phase 4 manifest SHA-256 mismatch: ${digest}`);
  }
  if (
    manifest.twodartContract.projectId !== PHASE4_PROJECT_ID ||
    manifest.twodartContract.storageBuckets.length !== 2 ||
    manifest.oraclePolicy.requiredFixtureSets.length !== 13
  ) {
    throw new Error("Phase 4 runner constants diverge from the frozen contract");
  }
  const chaos = manifest.gates.chaos;
  if (
    chaos.droppedTriggerResponses !== 50 ||
    chaos.duplicateFirestoreEvents !== 50 ||
    chaos.concurrentWritesPerTriggerPattern !== 100 ||
    chaos.authTriggerRetries !== 50 ||
    chaos.resumableUploadInterruptions !== 50 ||
    chaos.suiteForcedRestarts !== 25 ||
    chaos.duplicateObservableEffects !== 0 ||
    chaos.lostAcknowledgedEffects !== 0
  ) {
    throw new Error("Phase 4 chaos constants diverge from the frozen manifest");
  }
}

export function assertPhase4Toolchain(
  manifest: Phase4Manifest,
  observed: Phase4ObservedToolchain,
): void {
  const expected = manifest.toolchain;
  assertExact("npm", observed.npm, expected.gateNpm);
  assertExact("Bun", observed.bun, expected.twodartBun);
  assertExact("firebase-tools", observed.firebaseTools, expected.twodartFirebaseTools);
  assertVersionRange("Firebase JS SDK", observed.firebaseJsSdk, expected.twodartFirebaseJsSdk);
  assertVersionRange("Firebase Admin SDK", observed.firebaseAdmin, expected.twodartFirebaseAdmin);
  assertVersionRange(
    "Firebase Functions SDK",
    observed.firebaseFunctions,
    expected.twodartFirebaseFunctions,
  );
  if (observed.node !== `v${expected.gateNode}`) {
    throw new Error(`Node mismatch: expected v${expected.gateNode}, observed ${observed.node}`);
  }
  if (!observed.rust.includes(expected.rust)) {
    throw new Error(`Rust mismatch: expected ${expected.rust}, observed ${observed.rust}`);
  }
  const javaMajor = /(?:openjdk|java) (?<major>\d+)/iu.exec(observed.java)?.groups?.major;
  if (Number(javaMajor) !== expected.gateJavaMajor) {
    throw new Error(
      `Java mismatch: expected major ${String(expected.gateJavaMajor)}, observed ${observed.java}`,
    );
  }
}

function assertExact(label: string, observed: string, expected: string): void {
  if (observed !== expected) {
    throw new Error(`${label} mismatch: expected ${expected}, observed ${observed}`);
  }
}

function assertVersionRange(label: string, observed: string, expected: string): void {
  if (expected.startsWith("^") && major(observed) === major(expected.slice(1))) return;
  assertExact(label, observed, expected);
}

function major(version: string): number {
  const value = Number.parseInt(version.split(".")[0] ?? "", 10);
  if (!Number.isInteger(value)) throw new Error(`invalid semantic version: ${version}`);
  return value;
}
