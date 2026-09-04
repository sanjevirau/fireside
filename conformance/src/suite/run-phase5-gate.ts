import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { arch, cpus, hostname, platform, release, totalmem } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { Firestore } from "@google-cloud/firestore";

import {
  assertPhase5Manifest,
  PHASE5_MANIFEST_SHA256,
  type Phase5Manifest,
} from "./phase5-acceptance-plan.ts";
import {
  applyPhase5PortlessApplicationPorts,
  assertDistinctPhase5ApplicationUrls,
  assertPhase5PortlessPrefix,
  PHASE5_APPLICATION_PORTS,
  PHASE5_APPLICATION_URL_KEYS,
  PHASE5_MPROCS_APPLICATION_CONFIG,
  PHASE5_STACK_PORTS,
  phase5ReservedPorts,
  stageHardlinkedDirectoryTree,
  type Phase5StackName,
} from "./phase5-host-prepare.ts";
import {
  phase5ResourceComparison,
  renderPhase5ResourceComparison,
  validPhase5SwapMeasurement,
  type Phase5ResourceEvidence,
  type Phase5SwapActivity,
} from "./phase5-resource-evidence.ts";
import {
  assertPhase5GeneratedCacheParity,
  isPhase5GeneratedCacheObject,
  measurePhase5GeneratedCache,
  phase5GeneratedCacheMetadataSize,
  PHASE5_GENERATED_CACHE_BUCKET,
  PHASE5_GENERATED_CACHE_NAME,
  type Phase5GeneratedCacheMeasurement,
} from "./phase5-cache-state-parity.ts";
import {
  drainPhase5Swap,
  Phase5ProcessQuiescenceError,
  readPhase5SwapHostState,
  runPhase5SwapCommand,
  waitForPhase5StackQuiescence,
} from "./phase5-swap-preflight.ts";
import {
  phase5RuntimeDirectory,
  preparePhase5RuntimeRoot,
} from "./phase5-runtime-directory.ts";
import {
  cacheOutputDigest,
  PHASE5_EXPORT_SHUTDOWN_SECONDS,
  PHASE5_OFFICIAL_JAVA_TOOL_OPTIONS,
  readPhase5PortEnvironment,
  startPhase5Stack,
  stopPhase5Stack,
  waitForPhase5FrontendReady,
  type RunningPhase5Stack,
  type StoppedPhase5Stack,
} from "./phase5-stack-control.ts";

interface Arguments {
  readonly firesideBinary: string;
  readonly firesideDirectory: string;
  readonly freshDirectory: string;
  readonly fullData: string;
  readonly javaHome: string;
  readonly nodeBinary: string;
  readonly officialDirectory: string;
  readonly officialBaselineEvidence: string | null;
  readonly outputDirectory: string;
  readonly projectId: string;
  readonly reportPath: string;
  readonly runtimeAssetsRoot: string;
  readonly runtimeRoot: string;
  readonly smoke: boolean;
  readonly smokeEvidence: string | null;
  readonly twodartRevision: string;
}

interface OfficialBaselineEvidence {
  readonly copiedEvidenceDirectory: string;
  readonly evidenceChecksumsSha256: string;
  readonly exportDirectory: string;
  readonly exportIdentity: Awaited<ReturnType<typeof treeIdentity>>;
  readonly generatedCache: Phase5GeneratedCacheMeasurement;
  readonly originalCandidateRevision: string;
  readonly originalManifestSha256: string;
  readonly sourceEvidenceDirectory: string;
}

interface StackState {
  readonly authUsers: number;
  readonly firestoreDocuments: number;
  readonly generatedCache: Phase5GeneratedCacheMeasurement | null;
  readonly storageObjectBytes: number;
  readonly storageObjects: number;
  readonly totalStorageObjectBytes: number;
  readonly totalStorageObjects: number;
}

interface CommandEvidence {
  readonly command: string;
  readonly durationMilliseconds: number;
  readonly exitCode: number | null;
  readonly log: string;
  readonly name: string;
  readonly passed: boolean;
  readonly signal: NodeJS.Signals | null;
}

interface BrowserEvidence {
  readonly iteration: "initial" | "restart";
  readonly journeys: readonly unknown[];
  readonly passed: boolean;
  readonly stack: Phase5StackName;
  readonly skippedJourneys?: readonly { readonly id: string; readonly reason: string }[];
}

interface LifecycleRecord {
  readonly initial: {
    readonly browser: BrowserEvidence;
    readonly cacheDigest: string;
    readonly stateAfterJourney: StackState;
    readonly stateBeforeJourney: StackState;
  };
  readonly restart: {
    readonly browser: BrowserEvidence;
    readonly cacheDigest: string;
    readonly stateAfterJourney: StackState;
    readonly stateBeforeJourney: StackState;
  };
  readonly stops: {
    readonly initial: StoppedPhase5Stack;
    readonly restart: StoppedPhase5Stack;
  };
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");
const conformanceDirectory = path.join(repositoryRoot, "conformance");
const tsxImportSpecifier = import.meta.resolve("tsx");
const manifestPath = path.join(
  repositoryRoot,
  "benchmarks",
  "phase-5-twodart-acceptance.json",
);
const collectionIds = [
  "users",
  "private",
  "orders",
  "read",
  "templates",
  "colors",
  "categories",
  "categoriesCore",
  "slidesCore",
  "slides",
  "products",
  "prices",
  "icons-library",
  "icons-list",
  "month",
  "downloads",
  "general",
  "analytics",
  "licenses",
  "invitedUsers",
  "subscriptions",
  "payments",
  "checkout_sessions",
  "payment_info",
  "customer",
  "invoices",
  "brandFetch",
  "branding",
  "brandingCore",
  "studioOrders",
  "editorStyle",
  "backgroundImages",
  "themes",
  "fonts",
  "fontPairs",
  "userFonts",
  "userFontPairs",
  "presentations",
  "premade-templates",
  "tags",
  "algolia",
  "userImages",
  "glossary",
  "betaUsers",
  "featureFlags",
  "appAnnouncements",
  "sharedLinks",
] as const;
const buckets = ["demo-twodart-local.appspot.com", "assets-local.twodart.com"] as const;

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  await requireAbsent(args.outputDirectory);
  await requireAbsent(args.reportPath);
  await mkdir(path.join(args.outputDirectory, "logs"), { recursive: true });

  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as Phase5Manifest;
  assertPhase5Manifest(manifest, manifestBytes);
  await writeFile(path.join(args.outputDirectory, "manifest.json"), manifestBytes, {
    flag: "wx",
  });

  const officialBaseline = args.officialBaselineEvidence === null
    ? null
    : await preserveOfficialBaselineEvidence(args, manifest);
  if (officialBaseline !== null) {
    await writeJson(
      path.join(args.outputDirectory, "official-baseline.json"),
      officialBaseline,
    );
  }

  const smokePrerequisite = args.smoke
    ? null
    : await validateSmokePrerequisite(args, manifest);
  if (smokePrerequisite !== null) {
    await writeJson(
      path.join(args.outputDirectory, "smoke-prerequisite.json"),
      smokePrerequisite,
    );
  }

  const environment = await verifyEnvironment(args, manifest);
  const frozenGeneratedCachePhysicalBytes = args.smoke
    ? null
    : await readFrozenGeneratedCachePhysicalBytes(args.fullData);
  environment.generatedCacheContract = {
    bucket: PHASE5_GENERATED_CACHE_BUCKET,
    frozenPhysicalBytes: frozenGeneratedCachePhysicalBytes,
    name: PHASE5_GENERATED_CACHE_NAME,
    normalizedLogicalParityRequired: true,
    physicalBytesMeasurementOnly: true,
    stableStorageCountsExact: true,
  };
  await writeJson(path.join(args.outputDirectory, "environment.json"), environment);

  const lifecycle = new Map<Phase5StackName, Partial<LifecycleRecord>>();
  const active = new Map<Phase5StackName, RunningPhase5Stack>();
  const initialRunning = new Map<Phase5StackName, RunningPhase5Stack>();
  const initialBefore = new Map<Phase5StackName, StackState>();
  const initialAfter = new Map<Phase5StackName, StackState>();
  const restartRunning = new Map<Phase5StackName, RunningPhase5Stack>();
  const restartBefore = new Map<Phase5StackName, StackState>();
  const restartAfter = new Map<Phase5StackName, StackState>();
  const cleanupFailureHashes: string[] = [];
  let officialExportParity: Record<string, unknown> | null = null;
  let completed = false;
  try {
    for (const stack of stackNames) {
      if (officialBaseline !== null && stack === "official") continue;
      await recordPreflight(args, manifest, environment, `${stack}-soak`);
      const running = await startStack(
        args,
        manifest,
        stack,
        "initial",
        gateDatasetName(args),
        active,
      );
      initialRunning.set(stack, running);
      const initial = await exerciseStack(args, manifest, running, "initial");
      initialBefore.set(stack, initial.before);
      initialAfter.set(stack, initial.after);
      await runSoak(args, manifest, stack);
      const initialStop = await stopPhase5Stack(running, PHASE5_EXPORT_SHUTDOWN_SECONDS);
      active.delete(stack);
      lifecycle.set(stack, {
        initial: {
          browser: initial.browser,
          cacheDigest: cacheOutputDigest(running.cacheBuild.outputCounts),
          stateAfterJourney: initial.after,
          stateBeforeJourney: initial.before,
        },
        stops: { initial: initialStop } as LifecycleRecord["stops"],
      });

      if (!args.smoke) {
        const restartDataset = await stageLifecycleExport(args, stack);
        await recordPreflight(args, manifest, environment, `${stack}-restart`);
        const restarted = await startStack(
          args,
          manifest,
          stack,
          "restart",
          restartDataset,
          active,
        );
        restartRunning.set(stack, restarted);
        const restart = await exerciseStack(args, manifest, restarted, "restart");
        restartBefore.set(stack, restart.before);
        restartAfter.set(stack, restart.after);
        assertExactState(initial.after, restart.before);
        assertPhase5GeneratedCacheParity(
          initial.after.generatedCache,
          restart.before.generatedCache,
          `${stack} lifecycle restart`,
        );
        const restartStop = await stopPhase5Stack(
          restarted,
          PHASE5_EXPORT_SHUTDOWN_SECONDS,
        );
        active.delete(stack);
        const initialRecord = requiredMap(lifecycle, stack).initial;
        if (initialRecord === undefined) {
          throw new Error(`${stack} initial lifecycle record is missing`);
        }
        lifecycle.set(stack, {
          initial: initialRecord,
          restart: {
            browser: restart.browser,
            cacheDigest: cacheOutputDigest(restarted.cacheBuild.outputCounts),
            stateAfterJourney: restart.after,
            stateBeforeJourney: restart.before,
          },
          stops: { initial: initialStop, restart: restartStop },
        });
      }
    }

    if (officialBaseline === null) {
      assertCacheParity(initialRunning, [initialBefore, initialAfter]);
      assertPairState(
        initialBefore,
        manifest,
        frozenGeneratedCachePhysicalBytes,
      );
      assertPairState(initialAfter, manifest, null);
    } else {
      const firesideInitialBefore = requiredMap(initialBefore, "fireside");
      const firesideInitialAfter = requiredMap(initialAfter, "fireside");
      assertStateMatchesFrozen(
        firesideInitialBefore,
        manifest,
        frozenGeneratedCachePhysicalBytes,
      );
      const firesideRestartBefore = requiredMap(restartBefore, "fireside");
      assertExactState(firesideInitialAfter, firesideRestartBefore);
      assertPhase5GeneratedCacheParity(
        firesideInitialAfter.generatedCache,
        firesideRestartBefore.generatedCache,
        "Fireside lifecycle restart",
      );
    }
    if (!args.smoke) {
      if (officialBaseline === null) {
        assertCacheParity(restartRunning, [restartBefore, restartAfter]);
        assertPairState(restartBefore, manifest, null);
        assertPairState(restartAfter, manifest, null);
      } else {
        officialExportParity = await runOfficialExportParity(
          args,
          manifest,
          officialBaseline,
          requiredMap(initialAfter, "fireside"),
          active,
          environment,
        );
      }
      await runFreshColleague(args, manifest, active, environment);
      await runRegressions(args);
    }

    await writeJson(
      path.join(args.outputDirectory, "dataset-final.json"),
      await verifyFinalDatasetIdentity(args, manifest),
    );

    await writeJson(path.join(args.outputDirectory, "lifecycle.json"), {
      allowedCountMismatch: manifest.lifecycle.allowedCountMismatch,
      cacheOutputsMatched: true,
      executionOrder: stackNames,
      generatedCacheParity: {
        bucket: PHASE5_GENERATED_CACHE_BUCKET,
        name: PHASE5_GENERATED_CACHE_NAME,
        normalization: [
          "metadata.buildTimestamp",
          "data.general.slideThemeData[].chunkedJsonLink storage port",
          "data.themeMetadataData.slides[].slideThemeData[].chunkedJsonLink storage port",
        ],
        normalizedLogicalValuesMatched: true,
        physicalBytesMeasurementOnly: true,
        stableStorageCountsExact: true,
      },
      maximumConcurrentStacks: 1,
      officialBaseline: officialBaseline === null
        ? null
        : {
            classification: "host-limited-at-restart",
            initialJourneysPassed: 9,
            originalCandidateRevision: officialBaseline.originalCandidateRevision,
            originalManifestSha256: officialBaseline.originalManifestSha256,
            restartStatus: "host-limited",
            soakPassed: true,
          },
      officialExportParity,
      records: Object.fromEntries(lifecycle),
      schemaVersion: 1,
      smoke: args.smoke,
      smokeRequirements: args.smoke
        ? {
            allNineBrowserJourneys: true,
            bothStacks: true,
            cleanup: true,
            exportFirstShutdown: true,
            orphanCheck: true,
          }
        : null,
    });
    if (!args.smoke) await writeReport(args, manifest, environment);
    await writeJson(path.join(args.outputDirectory, "result.json"), {
      cleanupFailureHashes,
      completedAt: new Date().toISOString(),
      manifestSha256: PHASE5_MANIFEST_SHA256,
      officialBaselineContinuation: officialBaseline === null
        ? null
        : {
            officialStageRerun: false,
            restartStatus: "host-limited",
            sourceEvidenceChecksumsSha256: officialBaseline.evidenceChecksumsSha256,
          },
      officialJavaComparison: {
        defaultHeapFixture:
          "conformance/fixtures/phase5/official-java-default-heap-import.json",
        fullDatasetRetryJavaToolOptions: PHASE5_OFFICIAL_JAVA_TOOL_OPTIONS,
        retryReportedSeparately: true,
      },
      passed: true,
      schemaVersion: 1,
      smoke: args.smoke,
    });
    completed = true;
  } catch (error: unknown) {
    await writeJson(path.join(args.outputDirectory, "failure.json"), {
      candidateIdentityStored: false,
      datasetIdentityStored: false,
      errorHash: digest(errorText(error)),
      failedAt: new Date().toISOString(),
      manifestSha256: PHASE5_MANIFEST_SHA256,
      privateContentStored: false,
      schemaVersion: 1,
      smoke: args.smoke,
    });
    throw error;
  } finally {
    if (!completed) {
      for (const running of [...active.values()].reverse()) {
        try {
          await stopPhase5Stack(running, PHASE5_EXPORT_SHUTDOWN_SECONDS);
        } catch (error: unknown) {
          cleanupFailureHashes.push(digest(errorText(error)));
        }
      }
      if (cleanupFailureHashes.length > 0) {
        await writeJson(path.join(args.outputDirectory, "cleanup-failures.json"), {
          failureHashes: cleanupFailureHashes.sort(),
          schemaVersion: 1,
        });
      }
    }
    // Readiness failures also need a complete ledger checksum, after cleanup has
    // stopped log writers. A failed smoke must never depend on a manual harvest.
    await writeChecksums(args.outputDirectory);
  }
}

async function validateSmokePrerequisite(
  args: Arguments,
  manifest: Phase5Manifest,
): Promise<Record<string, unknown>> {
  if (args.smokeEvidence === null) {
    throw new Error(
      "A passed --smoke-evidence directory is required before a full-data Phase 5 attempt",
    );
  }
  const smokeEvidence = args.smokeEvidence;
  const currentRevision = await capture("git", ["rev-parse", "HEAD"], repositoryRoot);
  const continuingR36 = args.officialBaselineEvidence !== null;
  const expectedManifestSha256 = continuingR36
    ? manifest.officialRestartHostLimitAmendment.previousManifestSha256
    : PHASE5_MANIFEST_SHA256;
  const expectedCandidateRevision = continuingR36
    ? manifest.officialRestartHostLimitAmendment.sourceCandidateRevision
    : currentRevision;
  const [result, environment, lifecycle, dataset, soakOfficial, soakFireside] =
    await Promise.all([
      readJsonRecord(path.join(smokeEvidence, "result.json")),
      readJsonRecord(path.join(smokeEvidence, "environment.json")),
      readJsonRecord(path.join(smokeEvidence, "lifecycle.json")),
      readJsonRecord(path.join(smokeEvidence, "dataset-final.json")),
      readJsonRecord(path.join(smokeEvidence, "soak-smoke-official.json")),
      readJsonRecord(path.join(smokeEvidence, "soak-smoke-fireside.json")),
    ]);
  if (
    result.passed !== true ||
    result.smoke !== true ||
    result.manifestSha256 !== expectedManifestSha256 ||
    environment.candidateRevision !== expectedCandidateRevision ||
    environment.manifestSha256 !== expectedManifestSha256 ||
    environment.smoke !== true ||
    dataset.passed !== true ||
    lifecycle.smoke !== true ||
    lifecycle.maximumConcurrentStacks !== 1 ||
    JSON.stringify(lifecycle.executionOrder) !== JSON.stringify(stackNames)
  ) {
    throw new Error("Phase 5 smoke prerequisite identity or result diverged");
  }
  const generatedCacheParity = lifecycle.generatedCacheParity as
    | Readonly<Record<string, unknown>>
    | undefined;
  if (
    generatedCacheParity?.bucket !== PHASE5_GENERATED_CACHE_BUCKET ||
    generatedCacheParity.name !== PHASE5_GENERATED_CACHE_NAME ||
    generatedCacheParity.normalizedLogicalValuesMatched !== true ||
    generatedCacheParity.physicalBytesMeasurementOnly !== true ||
    generatedCacheParity.stableStorageCountsExact !== true
  ) {
    throw new Error("Phase 5 smoke generated-cache parity prerequisite diverged");
  }
  const records = lifecycle.records as
    | Readonly<Record<string, { readonly initial?: LifecycleRecord["initial"]; readonly stops?: { readonly initial?: StoppedPhase5Stack } }>>
    | undefined;
  for (const stack of stackNames) {
    const record = records?.[stack];
    const stopped = record?.stops?.initial;
    if (
      record?.initial?.browser.passed !== true ||
      record.initial.browser.journeys.length !==
        manifest.differentialJourneys.journeys.length ||
      stopped?.exportMetadataPresent !== true ||
      stopped.orphanCheckPassed !== true ||
      stopped.remainingDirectoryProcessGroups !== 0 ||
      stopped.remainingListenerPorts !== 0 ||
      stopped.shutdownOrder !== "emulator-export-first-then-mprocs"
    ) {
      throw new Error(`Phase 5 ${stack} smoke lifecycle prerequisite diverged`);
    }
  }
  for (const [stack, soak] of [
    ["official", soakOfficial],
    ["fireside", soakFireside],
  ] as const) {
    const swap = soak.swapActivity as Partial<Phase5SwapActivity> | undefined;
    if (
      soak.passed !== true ||
      soak.smoke !== true ||
      soak.stack !== stack ||
      soak.durationSeconds !== manifest.diagnosticSmoke.shortSoakSecondsPerStack ||
      !validPhase5SwapMeasurement(swap)
    ) {
      throw new Error(`Phase 5 ${stack} smoke soak prerequisite diverged`);
    }
  }
  await verifyChecksumManifest(smokeEvidence);
  return {
    acceptedCandidateRevision: expectedCandidateRevision,
    checkedAt: new Date().toISOString(),
    continuationCandidateRevision: continuingR36 ? currentRevision : null,
    directory: smokeEvidence,
    manifestSha256: expectedManifestSha256,
    passed: true,
    resultSha256: await hashFile(path.join(smokeEvidence, "result.json")),
    schemaVersion: 1,
  };
}

async function preserveOfficialBaselineEvidence(
  args: Arguments,
  manifest: Phase5Manifest,
): Promise<OfficialBaselineEvidence> {
  const source = args.officialBaselineEvidence;
  if (source === null || args.smoke) {
    throw new Error("The official r36 baseline is valid only for a full-data continuation");
  }
  if (
    source === args.outputDirectory ||
    source.startsWith(`${args.outputDirectory}${path.sep}`) ||
    args.outputDirectory.startsWith(`${source}${path.sep}`)
  ) {
    throw new Error("The official r36 baseline and continuation output must be disjoint");
  }
  const amendment = manifest.officialRestartHostLimitAmendment;
  await verifyChecksumManifest(source);
  const evidenceChecksumsSha256 = await hashFile(path.join(source, "checksums.sha256"));
  if (evidenceChecksumsSha256 !== amendment.sourceEvidenceChecksumsSha256) {
    throw new Error("The official r36 checksum inventory identity diverged");
  }
  if ((await hashFile(path.join(source, "manifest.json"))) !== amendment.previousManifestSha256) {
    throw new Error("The official r36 source manifest identity diverged");
  }
  const [environment, initial, soak, restartPreflight, restartReadiness, restart] =
    await Promise.all([
      readJsonRecord(path.join(source, "environment.json")),
      readJsonRecord(path.join(source, "browser-official-initial.json")),
      readJsonRecord(path.join(source, "soak-official.json")),
      readJsonRecord(path.join(source, "preflight-official-restart.json")),
      readJsonRecord(path.join(source, "official-restart-readiness.json")),
      readJsonRecord(path.join(source, "browser-official-restart.json")),
    ]);
  if (
    environment.candidateRevision !== amendment.sourceCandidateRevision ||
    environment.manifestSha256 !== amendment.previousManifestSha256 ||
    initial.passed !== true ||
    (initial.journeys as readonly unknown[] | undefined)?.length !== 9 ||
    soak.passed !== true || soak.stack !== "official" || soak.durationSeconds !== 7_200 ||
    (soak.memory as { readonly official?: { readonly samples?: number } } | undefined)
      ?.official?.samples !== 241 ||
    restartPreflight.passed !== true || restartReadiness.ready !== true ||
    restart.passed !== false ||
    (restart.journeys as readonly unknown[] | undefined)?.length !== 3
  ) {
    throw new Error("The official r36 baseline result boundary diverged");
  }
  const restartBrowser = restart.browser as
    | { readonly pageErrors?: number; readonly requestFailures?: number }
    | undefined;
  if (restartBrowser?.pageErrors !== 0 || restartBrowser.requestFailures !== 0) {
    throw new Error("The official r36 restart does not satisfy the zero-error boundary");
  }
  const exactHashes = {
    "browser-official-restart.json":
      "41f04b158bf0468b4feea214a317f7e9832e31cefca70eecb856b41d06bbadbd",
    "browser-official-restart.json.diagnostics.jsonl":
      "225a7228a8d74cd347f5360e7ae3fd45cee9b066d47ef92dac2dfe9c6d382e01",
    "soak-official.json":
      "6ab4eca8f39ca7946d75da2fc2f8876f7efb79111f44fcfad9dac1cc1d982685",
  } as const;
  for (const [relative, expected] of Object.entries(exactHashes)) {
    if ((await hashFile(path.join(source, relative))) !== expected) {
      throw new Error(`The official r36 source file identity diverged: ${relative}`);
    }
  }
  const diagnosticLines = (
    await readFile(path.join(source, "browser-official-restart.json.diagnostics.jsonl"), "utf8")
  ).split("\n").filter((line) => line.length > 0);
  const diagnosticRecords = diagnosticLines.map((line) =>
    JSON.parse(line) as Record<string, unknown>);
  const pending = diagnosticRecords.find(
    ({ kind }) => kind === "pending-requests-at-journey-failure",
  );
  const pendingRequests = pending?.requests as
    | readonly { readonly ageMs?: number; readonly method?: string; readonly url?: string }[]
    | undefined;
  const storageAlias = pendingRequests?.filter(({ url }) =>
    url?.startsWith("https://storage.twodart.localhost/v0/b/") === true) ?? [];
  const rawListen = pendingRequests?.filter(({ ageMs, method, url }) =>
    method === "POST" && url?.startsWith(
      "http://127.0.0.1:23000/google.firestore.v1.Firestore/Listen/channel",
    ) === true && (ageMs ?? 0) >= 239_000) ?? [];
  const nextStatic = pendingRequests?.filter(({ url }) =>
    url === "https://templates.twodart.localhost/assets/video-announcement.jpg") ?? [];
  if (
    storageAlias.length !== 8 || rawListen.length < 1 || nextStatic.length !== 1 ||
    !storageAlias.some(({ ageMs }) => (ageMs ?? 0) > 230_000)
  ) {
    throw new Error("The official r36 raw/proxied pending-request signature diverged");
  }
  const exportDirectory = path.resolve(source, "../exports/official/full-data");
  const exportStat = await lstat(exportDirectory);
  if (!exportStat.isDirectory()) {
    throw new Error("The preserved official r36 export is not a directory");
  }
  const exportIdentity = await treeIdentity(exportDirectory);
  const expectedExportIdentity = amendment.sourceOfficialExport;
  if (
    exportIdentity.fileCount !== expectedExportIdentity.fileCount ||
    exportIdentity.fileBytes !== expectedExportIdentity.fileBytes ||
    exportIdentity.treeSha256 !== expectedExportIdentity.treeSha256
  ) {
    throw new Error("The preserved official r36 export identity diverged");
  }
  const generatedCache = await measureExportGeneratedCache(exportDirectory);
  const copiedEvidenceDirectory = path.join(args.outputDirectory, "official-baseline-evidence");
  await cp(source, copiedEvidenceDirectory, {
    errorOnExist: true,
    force: false,
    recursive: true,
  });
  await verifyChecksumManifest(copiedEvidenceDirectory);
  if (
    (await hashFile(path.join(copiedEvidenceDirectory, "checksums.sha256"))) !==
      evidenceChecksumsSha256
  ) {
    throw new Error("The copied official r36 evidence checksum inventory diverged");
  }
  return {
    copiedEvidenceDirectory,
    evidenceChecksumsSha256,
    exportDirectory,
    exportIdentity,
    generatedCache,
    originalCandidateRevision: amendment.sourceCandidateRevision,
    originalManifestSha256: amendment.previousManifestSha256,
    sourceEvidenceDirectory: source,
  };
}

async function readJsonRecord(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
}

async function verifyChecksumManifest(directory: string): Promise<void> {
  const manifest = await readFile(path.join(directory, "checksums.sha256"), "utf8");
  const lines = manifest.split("\n").filter((line) => line.length > 0);
  if (lines.length === 0) throw new Error("Phase 5 smoke checksum manifest is empty");
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  ([^/].*)$/u.exec(line);
    const expected = match?.[1];
    const relative = match?.[2];
    if (
      expected === undefined ||
      relative === undefined ||
      path.isAbsolute(relative) ||
      relative.split("/").includes("..")
    ) {
      throw new Error("Phase 5 smoke checksum manifest contains an unsafe entry");
    }
    if ((await hashFile(path.join(directory, relative))) !== expected) {
      throw new Error(`Phase 5 smoke checksum mismatch: ${relative}`);
    }
  }
}

async function verifyFinalDatasetIdentity(
  args: Arguments,
  manifest: Phase5Manifest,
): Promise<Record<string, unknown>> {
  const datasetName = gateDatasetName(args);
  const source = args.smoke
    ? path.join(repositoryRoot, manifest.diagnosticSmoke.dataset.path)
    : args.fullData;
  const roots = {
    fireside: path.join(
      args.firesideDirectory,
      `apps/templates-firebase/loadData/datasets/${datasetName}`,
    ),
    frozen: source,
    official: path.join(
      args.officialDirectory,
      `apps/templates-firebase/loadData/datasets/${datasetName}`,
    ),
  };
  const expected = args.smoke ? manifest.diagnosticSmoke.dataset : manifest.dataset;
  const identities: Record<string, Awaited<ReturnType<typeof treeIdentity>>> = Object.fromEntries(
    await Promise.all(
      Object.entries(roots).map(async ([name, root]) => [name, await treeIdentity(root)] as const),
    ),
  );
  for (const [name, identity] of Object.entries(identities)) {
    if (
      identity.fileCount !== expected.fileCount ||
      identity.fileBytes !== expected.fileBytes ||
      identity.treeSha256 !== expected.treeSha256
    ) {
      throw new Error(`Phase 5 ${name} dataset changed during the measured lifecycle`);
    }
  }
  return {
    checkedAt: new Date().toISOString(),
    identities,
    manifestSha256: PHASE5_MANIFEST_SHA256,
    passed: true,
    schemaVersion: 1,
  };
}

const stackNames = ["official", "fireside"] as const;

function gateDatasetName(args: Arguments): string {
  return args.smoke
    ? `phase5-smoke-${digest(args.outputDirectory).slice(0, 16)}`
    : "full-data";
}

async function startStack(
  args: Arguments,
  manifest: Phase5Manifest,
  stack: Phase5StackName,
  label: "initial" | "restart",
  datasetName: string,
  active: Map<Phase5StackName, RunningPhase5Stack>,
): Promise<RunningPhase5Stack> {
  const directory = stack === "official" ? args.officialDirectory : args.firesideDirectory;
  const runNamespace = args.smoke
    ? path.join("smoke", path.basename(args.outputDirectory))
    : label === "initial"
      ? "full-data"
      : "restart-full-data";
  const exportPath = path.join(
    path.dirname(path.dirname(args.fullData)),
    "exports",
    stack,
    runNamespace,
  );
  await mkdir(exportPath, { recursive: true });
  const running = await startPhase5Stack(
    {
      datasetName,
      diagnosticFailFast: args.smoke,
      directory,
      evidenceDirectory: args.outputDirectory,
      exportPath,
      firesideBinary: args.firesideBinary,
      javaHome: args.javaHome,
      ...(stack === "official" && !args.smoke
        ? { javaToolOptions: PHASE5_OFFICIAL_JAVA_TOOL_OPTIONS }
        : {}),
      label,
      nodeBinary: args.nodeBinary,
      ports: PHASE5_STACK_PORTS[stack],
      runtimeDirectory: phase5RuntimeDirectory(
        args.runtimeRoot,
        args.outputDirectory,
        `${stack}-${label}`,
      ),
      stack,
      tmuxSession: `fireside-phase5-${stack}-${label}-${process.pid.toString(36)}`,
    },
    {
      emulator: args.smoke
        ? manifest.diagnosticSmoke.maximumReadySeconds
        : manifest.cacheWatcher.maximumReadySeconds,
      application: manifest.cacheWatcher.maximumReadySeconds,
    },
    args.smoke
      ? manifest.diagnosticSmoke.dataset.baseFirestoreDocuments
      : manifest.dataset.logicalCounts.firestoreDocuments,
  );
  active.set(stack, running);
  return running;
}

async function exerciseStack(
  args: Arguments,
  manifest: Phase5Manifest,
  running: RunningPhase5Stack,
  iteration: "initial" | "restart",
): Promise<{
  readonly after: StackState;
  readonly before: StackState;
  readonly browser: BrowserEvidence;
}> {
  const stack = running.stack;
  const before = await captureStackState(running, args.projectId);
  await waitForPhase5FrontendReady(
    running.baseUrl,
    manifest.cacheWatcher.maximumReadySeconds,
    {
      ledgerPath: path.join(args.outputDirectory, `${stack}-${iteration}-frontend-recheck.jsonl`),
      summaryPath: path.join(args.outputDirectory, `${stack}-${iteration}-frontend-recheck.json`),
    },
  );
  const output = path.join(args.outputDirectory, `browser-${stack}-${iteration}.json`);
  const command = await runCommand(
    `browser-${stack}-${iteration}`,
    process.execPath,
    [
        "--import",
        tsxImportSpecifier,
        "--import",
        path.join(conformanceDirectory, "src/suite/phase5-browser-diagnostics.ts"),
        path.join(conformanceDirectory, "src/suite/run-phase5-browser-journeys.ts"),
        "--stack",
        stack,
        "--iteration",
        iteration,
        "--host",
        "127.0.0.1",
        "--project-id",
        args.projectId,
        "--base-url",
        running.baseUrl,
        "--twodart-dir",
        stack === "official" ? args.officialDirectory : args.firesideDirectory,
        "--firestore-port",
        String(running.ports.firestore),
        "--auth-port",
        String(running.ports.auth),
        "--storage-port",
        String(running.ports.storage),
        "--functions-port",
        String(running.ports.functions),
        "--cache-websocket-port",
        String(running.ports.cacheWebsocket),
        "--output",
        output,
        ...(args.smoke ? ["--seed-smoke"] : []),
    ],
    repositoryRoot,
    args.outputDirectory,
    45 * 60_000,
  );
  assertCommand(command);
  const evidence = JSON.parse(await readFile(output, "utf8")) as BrowserEvidence;
  if ((evidence.skippedJourneys?.length ?? 0) !== 0) {
    throw new Error(`${stack} ${iteration} is diagnostic-only: skipped journeys do not pass the Phase 5 gate: ${JSON.stringify(evidence.skippedJourneys)}`);
  }
  if (
    !evidence.passed ||
    evidence.stack !== stack ||
    evidence.iteration !== iteration ||
    evidence.journeys.length !== manifest.differentialJourneys.journeys.length
  ) {
    throw new Error(`${stack} ${iteration} browser journey evidence diverged`);
  }
  const after = await captureStackState(running, args.projectId);
  return { after, before, browser: evidence };
}

async function runSoak(
  args: Arguments,
  manifest: Phase5Manifest,
  stack: Phase5StackName,
): Promise<void> {
  const prefix = args.smoke ? "soak-smoke" : "soak";
  const output = path.join(args.outputDirectory, `${prefix}-${stack}.json`);
  const soak = await runCommand(
    `${prefix}-${stack}`,
    process.execPath,
    [
      "--import",
      tsxImportSpecifier,
      path.join(conformanceDirectory, "src/suite/run-phase5-soak.ts"),
      "--official-dir",
      args.officialDirectory,
      "--fireside-dir",
      args.firesideDirectory,
      "--project-id",
      args.projectId,
      "--stack",
      stack,
      "--output",
      output,
      ...(args.smoke ? ["--smoke"] : []),
    ],
    repositoryRoot,
    args.outputDirectory,
    args.smoke
      ? (manifest.diagnosticSmoke.shortSoakSecondsPerStack + 10 * 60) * 1_000
      : 3 * 60 * 60_000,
  );
  await writeSoakComparison(args, prefix);
  assertCommand(soak);
  await assertJsonPassed(output, `${stack} ${args.smoke ? "smoke " : ""}soak`);
}

async function writeSoakComparison(args: Arguments, prefix: string): Promise<void> {
  const soaks: Partial<Record<Phase5StackName, Phase5ResourceEvidence>> = {};
  for (const stack of stackNames) {
    try {
      const continuationBaseline =
        prefix === "soak" && stack === "official" && args.officialBaselineEvidence !== null
          ? path.join(
              args.outputDirectory,
              "official-baseline-evidence",
              "soak-official.json",
            )
          : path.join(args.outputDirectory, `${prefix}-${stack}.json`);
      soaks[stack] = JSON.parse(
        await readFile(continuationBaseline, "utf8"),
      ) as Phase5ResourceEvidence;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  // Update after each stack, including a failed soak; an unrun stack remains null.
  await writeFile(path.join(args.outputDirectory, "soak-comparison.json"),
    `${JSON.stringify(phase5ResourceComparison(soaks), null, 2)}\n`);
  await writeFile(path.join(args.outputDirectory, "soak-comparison.md"),
    renderPhase5ResourceComparison(soaks));
}

async function captureStackState(
  running: RunningPhase5Stack,
  projectId: string,
): Promise<StackState> {
  const firestore = new Firestore({
    host: `127.0.0.1:${String(running.ports.firestore)}`,
    projectId,
    ssl: false,
  });
  let firestoreDocuments = 0;
  try {
    for (const collectionId of collectionIds) {
      const snapshot = await firestore.collectionGroup(collectionId).count().get();
      firestoreDocuments += snapshot.data().count;
    }
  } finally {
    await firestore.terminate();
  }
  const auth = await fetch(
    `http://127.0.0.1:${String(running.ports.auth)}/identitytoolkit.googleapis.com/v1/projects/${projectId}/accounts:query`,
    {
      body: JSON.stringify({ order: "ASC", returnUserInfo: true, sortBy: "USER_ID" }),
      headers: {
        authorization: "Bearer owner",
        "content-type": "application/json",
      },
      method: "POST",
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!auth.ok) throw new Error(`${running.stack} Auth count failed with ${String(auth.status)}`);
  const authBody = (await auth.json()) as { readonly userInfo?: readonly unknown[] };
  let generatedCache: Phase5GeneratedCacheMeasurement | null = null;
  let storageObjects = 0;
  let storageObjectBytes = 0;
  let totalStorageObjects = 0;
  let totalStorageObjectBytes = 0;
  for (const bucket of buckets) {
    let token = "";
    do {
      const query = new URLSearchParams({ maxResults: "1000" });
      if (token.length > 0) query.set("pageToken", token);
      const response = await fetch(
        `http://127.0.0.1:${String(running.ports.storage)}/storage/v1/b/${bucket}/o?${query.toString()}`,
        { signal: AbortSignal.timeout(60_000) },
      );
      if (!response.ok) {
        throw new Error(`${running.stack} Storage count failed with ${String(response.status)}`);
      }
      const body = (await response.json()) as {
        readonly items?: readonly {
          readonly name?: string;
          readonly size?: number | string;
        }[];
        readonly nextPageToken?: string;
      };
      const items = body.items ?? [];
      for (const item of items) {
        const name = item.name ?? "";
        const size = Number(item.size ?? 0);
        if (!Number.isSafeInteger(size) || size < 0) {
          throw new Error(`${running.stack} Storage object size is invalid`);
        }
        totalStorageObjects += 1;
        totalStorageObjectBytes += size;
        if (isPhase5GeneratedCacheObject(bucket, name)) {
          if (generatedCache !== null) {
            throw new Error(`${running.stack} listed the generated cache more than once`);
          }
          generatedCache = await captureGeneratedCache(running, size);
        } else {
          storageObjects += 1;
          storageObjectBytes += size;
        }
      }
      token = body.nextPageToken ?? "";
    } while (token.length > 0);
  }
  return {
    authUsers: authBody.userInfo?.length ?? 0,
    firestoreDocuments,
    generatedCache,
    storageObjectBytes,
    storageObjects,
    totalStorageObjectBytes,
    totalStorageObjects,
  };
}

async function captureGeneratedCache(
  running: RunningPhase5Stack,
  physicalBytes: number,
): Promise<Phase5GeneratedCacheMeasurement> {
  const response = await fetch(
    `http://127.0.0.1:${String(running.ports.storage)}/v0/b/${PHASE5_GENERATED_CACHE_BUCKET}/o/${encodeURIComponent(PHASE5_GENERATED_CACHE_NAME)}?alt=media`,
    {
      headers: { "accept-encoding": "identity" },
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (!response.ok) {
    throw new Error(
      `${running.stack} generated cache download failed with ${String(response.status)}`,
    );
  }
  return measurePhase5GeneratedCache(
    new Uint8Array(await response.arrayBuffer()),
    physicalBytes,
  );
}

async function readFrozenGeneratedCachePhysicalBytes(
  fullData: string,
): Promise<number> {
  const metadataDirectory = path.join(fullData, "storage_export", "metadata");
  const files = (await readdir(metadataDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(metadataDirectory, entry.name));
  const matches: number[] = [];
  for (let offset = 0; offset < files.length; offset += 128) {
    const records: unknown[] = await Promise.all(
      files.slice(offset, offset + 128).map(async (file) =>
        JSON.parse(await readFile(file, "utf8")) as unknown),
    );
    for (const record of records) {
      const size = phase5GeneratedCacheMetadataSize(record);
      if (size !== null) matches.push(size);
    }
  }
  if (matches.length !== 1) {
    throw new Error(
      `Frozen Phase 5 dataset must contain one generated cache object; found ${String(matches.length)}`,
    );
  }
  return matches[0] as number;
}

async function measureExportGeneratedCache(
  exportDirectory: string,
): Promise<Phase5GeneratedCacheMeasurement> {
  const metadataDirectory = path.join(exportDirectory, "storage_export", "metadata");
  const metadataFiles = (await readdir(metadataDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name);
  const matches: {
    readonly contentEncoding: unknown;
    readonly file: string;
    readonly size: number;
  }[] = [];
  for (let offset = 0; offset < metadataFiles.length; offset += 128) {
    await Promise.all(
      metadataFiles.slice(offset, offset + 128).map(async (file) => {
        const record = JSON.parse(
          await readFile(path.join(metadataDirectory, file), "utf8"),
        ) as { readonly contentEncoding?: unknown };
        const size = phase5GeneratedCacheMetadataSize(record);
        if (size !== null) {
          matches.push({ contentEncoding: record.contentEncoding, file, size });
        }
      }),
    );
  }
  if (matches.length !== 1) {
    throw new Error(
      `Phase 5 export must contain one generated cache object; found ${String(matches.length)}`,
    );
  }
  const match = matches[0];
  if (match === undefined || match.contentEncoding !== "gzip") {
    throw new Error("Phase 5 exported generated cache must preserve gzip encoding");
  }
  const blob = await readFile(
    path.join(
      exportDirectory,
      "storage_export",
      "blobs",
      path.basename(match.file, ".json"),
    ),
  );
  if (blob.byteLength !== match.size) {
    throw new Error("Phase 5 exported generated cache metadata size diverged");
  }
  return measurePhase5GeneratedCache(gunzipSync(blob), blob.byteLength);
}

function assertPairState(
  states: Map<Phase5StackName, StackState>,
  manifest: Phase5Manifest,
  frozenGeneratedCachePhysicalBytes: number | null,
): void {
  const official = requiredMap(states, "official");
  const fireside = requiredMap(states, "fireside");
  assertExactState(official, fireside);
  assertStateMatchesFrozen(
    official,
    manifest,
    frozenGeneratedCachePhysicalBytes,
  );
}

function assertStateMatchesFrozen(
  state: StackState,
  manifest: Phase5Manifest,
  frozenGeneratedCachePhysicalBytes: number | null,
): void {
  if (frozenGeneratedCachePhysicalBytes !== null) {
    const frozen = manifest.dataset.logicalCounts;
    if (
      state.firestoreDocuments !== frozen.firestoreDocuments ||
      state.authUsers !== frozen.authUsers ||
      state.storageObjects !== frozen.storageObjects - 1 ||
      state.storageObjectBytes !==
        frozen.storageObjectBytes - frozenGeneratedCachePhysicalBytes
    ) {
      throw new Error(
        "Measured imported stable state diverged from the frozen logical counts",
      );
    }
  }
}

function assertExactState(left: StackState, right: StackState): void {
  const stableLeft = stableStackState(left);
  const stableRight = stableStackState(right);
  if (JSON.stringify(stableLeft) !== JSON.stringify(stableRight)) {
    throw new Error(
      `Phase 5 stable state mismatch: ${JSON.stringify({ left: stableLeft, right: stableRight })}`,
    );
  }
}

function stableStackState(state: StackState): Omit<
  StackState,
  "generatedCache" | "totalStorageObjectBytes" | "totalStorageObjects"
> {
  return {
    authUsers: state.authUsers,
    firestoreDocuments: state.firestoreDocuments,
    storageObjectBytes: state.storageObjectBytes,
    storageObjects: state.storageObjects,
  };
}

function assertCacheParity(
  pair: Map<Phase5StackName, RunningPhase5Stack>,
  states: readonly Map<Phase5StackName, StackState>[],
): void {
  const official = requiredMap(pair, "official").cacheBuild;
  const fireside = requiredMap(pair, "fireside").cacheBuild;
  if (
    cacheOutputDigest(official.outputCounts) !== cacheOutputDigest(fireside.outputCounts) ||
    official.inputDocumentCount !== fireside.inputDocumentCount ||
    official.errors !== 0 ||
    fireside.errors !== 0
  ) {
    throw new Error("Official and Fireside cache-watcher outputs diverged");
  }
  for (const [index, state] of states.entries()) {
    assertPhase5GeneratedCacheParity(
      requiredMap(state, "official").generatedCache,
      requiredMap(state, "fireside").generatedCache,
      `cross-stack observation ${String(index + 1)}`,
    );
  }
}

async function stageLifecycleExport(
  args: Arguments,
  stack: Phase5StackName,
): Promise<string> {
  const name = "phase5-lifecycle-export";
  const directory = stack === "official" ? args.officialDirectory : args.firesideDirectory;
  const source = path.join(
    path.dirname(path.dirname(args.fullData)),
    "exports",
    stack,
    "full-data",
  );
  const destination = path.join(
    directory,
    "apps/templates-firebase/loadData/datasets",
    name,
  );
  await stageHardlinkedDirectoryTree(source, destination);
  return name;
}

async function runOfficialExportParity(
  args: Arguments,
  manifest: Phase5Manifest,
  baseline: OfficialBaselineEvidence,
  firesideState: StackState,
  active: Map<Phase5StackName, RunningPhase5Stack>,
  environment: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const datasetName = "phase5-r36-official-export";
  const stagedDirectory = path.join(
    args.firesideDirectory,
    "apps/templates-firebase/loadData/datasets",
    datasetName,
  );
  await stageHardlinkedDirectoryTree(baseline.exportDirectory, stagedDirectory);
  const stagedIdentity = await treeIdentity(stagedDirectory);
  if (JSON.stringify(stagedIdentity) !== JSON.stringify(baseline.exportIdentity)) {
    throw new Error("The staged official r36 export identity diverged");
  }
  const stagedGeneratedCache = await measureExportGeneratedCache(stagedDirectory);
  assertPhase5GeneratedCacheParity(
    baseline.generatedCache,
    stagedGeneratedCache,
    "hardlinked official r36 export",
  );

  await recordPreflight(
    args,
    manifest,
    environment,
    "fireside-official-export-parity",
  );
  const exportPath = path.join(
    path.dirname(path.dirname(args.fullData)),
    "exports",
    "fireside",
    "official-r36-parity",
  );
  await requireAbsent(exportPath);
  await mkdir(exportPath, { recursive: true });
  const running = await startPhase5Stack(
    {
      datasetName,
      directory: args.firesideDirectory,
      evidenceDirectory: args.outputDirectory,
      exportPath,
      firesideBinary: args.firesideBinary,
      javaHome: args.javaHome,
      label: "official-export-parity",
      nodeBinary: args.nodeBinary,
      ports: PHASE5_STACK_PORTS.fireside,
      runtimeDirectory: phase5RuntimeDirectory(
        args.runtimeRoot,
        args.outputDirectory,
        "fireside-official-export-parity",
      ),
      stack: "fireside",
      tmuxSession: `fireside-phase5-official-export-parity-${process.pid.toString(36)}`,
    },
    manifest.cacheWatcher.maximumReadySeconds,
    manifest.dataset.logicalCounts.firestoreDocuments,
  );
  active.set("fireside", running);
  const importedState = await captureStackState(running, args.projectId);
  assertExactState(firesideState, importedState);
  assertPhase5GeneratedCacheParity(
    baseline.generatedCache,
    importedState.generatedCache,
    "preserved official r36 export imported by Fireside",
  );
  assertPhase5GeneratedCacheParity(
    firesideState.generatedCache,
    importedState.generatedCache,
    "Fireside full lifecycle versus official r36 export",
  );
  const stopped = await stopPhase5Stack(
    running,
    PHASE5_EXPORT_SHUTDOWN_SECONDS,
  );
  active.delete("fireside");
  const evidence = {
    cacheOutputs: cacheOutputDigest(running.cacheBuild.outputCounts),
    exactStableStateMatched: true,
    generatedCacheNormalizedLogicalValueMatched: true,
    importedBy: "fireside",
    importedState,
    officialStackRerun: false,
    passed: true,
    preservedOfficialExport: baseline.exportIdentity,
    preservedOfficialGeneratedCache: baseline.generatedCache,
    schemaVersion: 1,
    stagedOfficialExport: stagedIdentity,
    stagedOfficialGeneratedCache: stagedGeneratedCache,
    stop: stopped,
  };
  await writeJson(path.join(args.outputDirectory, "official-export-parity.json"), evidence);
  return evidence;
}

async function runFreshColleague(
  args: Arguments,
  manifest: Phase5Manifest,
  active: Map<Phase5StackName, RunningPhase5Stack>,
  environment: Record<string, unknown>,
): Promise<void> {
  await stageHardlinkedDirectoryTree(
    args.fullData,
    path.join(
      args.freshDirectory,
      "apps/templates-firebase/loadData/datasets/full-data",
    ),
  );
  const documentation = await readFile(
    path.join(args.freshDirectory, "apps/templates-firebase/readme.md"),
    "utf8",
  );
  if (
    !documentation.includes("bun dev:mprocs") ||
    !documentation.includes("TWODART_FIREBASE_BACKEND=official")
  ) {
    throw new Error("Fresh-colleague Fireside default and official fallback are not documented");
  }
  for (const backend of [null, "official"] as const) {
    const label = backend === null ? "fresh-default" : "fresh-official-fallback";
    const exportPath = path.join(
      path.dirname(path.dirname(args.fullData)),
      "exports",
      "fresh",
      label,
    );
    await mkdir(exportPath, { recursive: true });
    await recordPreflight(args, manifest, environment, label);
    const running = await startPhase5Stack(
      {
        backendOverride: backend,
        datasetName: "full-data",
        directory: args.freshDirectory,
        evidenceDirectory: args.outputDirectory,
        exportPath,
        firesideBinary: args.firesideBinary,
        javaHome: args.javaHome,
        ...(backend === "official"
          ? { javaToolOptions: PHASE5_OFFICIAL_JAVA_TOOL_OPTIONS }
          : {}),
        label,
        nodeBinary: args.nodeBinary,
        ports: PHASE5_STACK_PORTS.fireside,
        runtimeDirectory: phase5RuntimeDirectory(
          args.runtimeRoot,
          args.outputDirectory,
          label,
        ),
        stack: backend ?? "fireside",
        tmuxSession: `fireside-phase5-${label}-${process.pid.toString(36)}`,
      },
      manifest.cacheWatcher.maximumReadySeconds,
      manifest.dataset.logicalCounts.firestoreDocuments,
    );
    active.set(running.stack, running);
    const log = await readFile(running.launchLog, "utf8");
    if (backend === null && !log.includes("Fireside suite:")) {
      throw new Error("Fresh documented command did not select Fireside by default");
    }
    if (backend === "official" && !log.includes("official Firebase Emulator Suite")) {
      throw new Error("Fresh documented official fallback did not select firebase-tools");
    }
    await stopPhase5Stack(running, PHASE5_EXPORT_SHUTDOWN_SECONDS);
    active.delete(running.stack);
  }
  await writeJson(path.join(args.outputDirectory, "fresh-colleague.json"), {
    command: "bun dev:mprocs",
    defaultBackend: "fireside",
    documentedStepsOnly: true,
    officialFallback: "TWODART_FIREBASE_BACKEND=official bun dev:mprocs",
    passed: true,
    schemaVersion: 1,
  });
}

async function runRegressions(args: Arguments): Promise<void> {
  const commands = [
    ["fireside-check", "npm", ["run", "check", "--prefix", "conformance"], repositoryRoot, 10 * 60_000],
    ["fireside-tests", "npm", ["test", "--prefix", "conformance"], repositoryRoot, 20 * 60_000],
    ["rust-format", "cargo", ["fmt", "--all", "--", "--check"], repositoryRoot, 10 * 60_000],
    ["rust-clippy", "cargo", ["clippy", "--workspace", "--all-targets", "--locked", "--", "-D", "warnings"], repositoryRoot, 30 * 60_000],
    ["rust-tests", "cargo", ["test", "--workspace", "--locked"], repositoryRoot, 45 * 60_000],
    ["twodart-functions-build", "bun", ["--filter", "@twodart/templates-firebase", "build"], args.officialDirectory, 30 * 60_000],
    ["twodart-application-build", "bun", ["--filter", "@twodart/templates", "build"], args.officialDirectory, 45 * 60_000],
  ] as const;
  const evidence: CommandEvidence[] = [];
  for (const [name, command, commandArgs, cwd, timeout] of commands) {
    const result = await runCommand(
      name,
      command,
      commandArgs,
      cwd,
      args.outputDirectory,
      timeout,
    );
    evidence.push(result);
    assertCommand(result);
  }
  await writeJson(path.join(args.outputDirectory, "regressions.json"), {
    commands: evidence,
    phase4EvidenceRequired: true,
    phase4Tag: "phase-4",
    passed: true,
    schemaVersion: 1,
  });
}

async function verifyEnvironment(
  args: Arguments,
  manifest: Phase5Manifest,
): Promise<Record<string, unknown>> {
  const candidateRevision = await capture("git", ["rev-parse", "HEAD"], repositoryRoot);
  const revisions = Object.fromEntries(
    await Promise.all(
      ([
        ["official", args.officialDirectory],
        ["fireside", args.firesideDirectory],
        ["fresh", args.freshDirectory],
      ] as const).map(async ([name, directory]) => [
        name,
        await capture("git", ["rev-parse", "HEAD"], directory),
      ]),
    ),
  );
  if (Object.values(revisions).some((revision) => revision !== args.twodartRevision)) {
    throw new Error(
      `Phase 5 Twodart checkouts do not use one exact measured revision: ${JSON.stringify({ expected: args.twodartRevision, revisions })}`,
    );
  }
  const stackPortEnvironments = {
    official: await readPhase5PortEnvironment(args.officialDirectory),
    fireside: await readPhase5PortEnvironment(args.firesideDirectory),
  };
  const portlessPrefixes: Record<string, string> = {};
  const portlessApplicationConfigs: Record<string, unknown> = {};
  for (const [name, directory] of [
    ["official", args.officialDirectory], ["fireside", args.firesideDirectory],
  ] as const) {
    const prefix = await capture("bash", ["scripts/dev/portless-prefix.sh"], directory);
    assertPhase5PortlessPrefix(stackPortEnvironments[name], prefix);
    portlessPrefixes[name] = prefix;
  }
  for (const [name, directory, ports] of [
    ["official", args.officialDirectory, PHASE5_APPLICATION_PORTS.official],
    ["fireside", args.firesideDirectory, PHASE5_APPLICATION_PORTS.fireside],
    ["fresh", args.freshDirectory, PHASE5_APPLICATION_PORTS.fireside],
  ] as const) {
    const configPath = path.join(directory, PHASE5_MPROCS_APPLICATION_CONFIG);
    const renderedConfig = applyPhase5PortlessApplicationPorts(
      await readFile(configPath, "utf8"),
      ports,
    );
    await writeFile(configPath, renderedConfig);
    portlessApplicationConfigs[name] = {
      path: PHASE5_MPROCS_APPLICATION_CONFIG,
      ports,
      sha256: digest(renderedConfig),
    };
  }
  assertDistinctPhase5ApplicationUrls(
    stackPortEnvironments.official,
    stackPortEnvironments.fireside,
  );
  const applicationUrls = Object.fromEntries(
    Object.entries(stackPortEnvironments).map(([name, environment]) => [
      name,
      Object.fromEntries(
        PHASE5_APPLICATION_URL_KEYS.map((key) => [key, environment[key]]),
      ),
    ]),
  );
  const datasetSource = args.smoke
    ? path.join(repositoryRoot, manifest.diagnosticSmoke.dataset.path)
    : args.fullData;
  const datasetName = gateDatasetName(args);
  for (const candidate of [
    datasetSource,
    args.runtimeAssetsRoot,
    args.firesideBinary,
    args.javaHome,
    args.nodeBinary,
  ]) {
    await access(candidate);
  }
  const runtimeFilesystem = await preparePhase5RuntimeRoot(
    args.runtimeRoot,
    manifest.host.minimumAvailableDiskBytes,
  );
  const dataset = await treeIdentity(datasetSource);
  const expectedDataset = args.smoke ? manifest.diagnosticSmoke.dataset : manifest.dataset;
  if (
    dataset.fileCount !== expectedDataset.fileCount ||
    dataset.fileBytes !== expectedDataset.fileBytes ||
    dataset.treeSha256 !== expectedDataset.treeSha256
  ) {
    throw new Error("Phase 5 dataset identity diverged from the frozen manifest");
  }
  const stagedDatasets: Record<string, unknown> = {};
  for (const [name, directory] of [
    ["official", args.officialDirectory],
    ["fireside", args.firesideDirectory],
  ] as const) {
    const importRoot = path.join(
      directory,
      `apps/templates-firebase/loadData/datasets/${datasetName}`,
    );
    if (args.smoke) {
      await stageHardlinkedDirectoryTree(datasetSource, importRoot);
    }
    if (!(await lstat(importRoot)).isDirectory()) {
      throw new Error(
        `Phase 5 ${name} import root must be a real directory for firebase-tools lstat parity: ${importRoot}`,
      );
    }
    const identity = await treeIdentity(importRoot);
    if (
      identity.fileCount !== dataset.fileCount ||
      identity.fileBytes !== dataset.fileBytes ||
      identity.treeSha256 !== dataset.treeSha256
    ) {
      throw new Error(`Phase 5 ${name} staged dataset diverged from the frozen input`);
    }
    stagedDatasets[name] = { importRoot, ...identity };
  }
  const runtimeAssets: Record<string, unknown>[] = [];
  for (const expected of manifest.twodartRuntimeAssets.trees) {
    const identity = await treeIdentity(
      path.join(args.runtimeAssetsRoot, path.basename(expected.path)),
    );
    if (
      identity.fileCount !== expected.fileCount ||
      identity.fileBytes !== expected.fileBytes ||
      identity.treeSha256 !== expected.treeSha256
    ) {
      throw new Error(`Phase 5 runtime asset identity diverged: ${expected.path}`);
    }
    runtimeAssets.push({ path: expected.path, ...identity });
  }
  const toolchain = {
    bun: await capture("bun", ["--version"], repositoryRoot),
    chrome: await capture("google-chrome", ["--version"], repositoryRoot),
    dotnet: await capture("dotnet", ["--version"], repositoryRoot),
    firebaseTools: await capture(
      path.join(args.officialDirectory, "node_modules/.bin/firebase"),
      ["--version"],
      args.officialDirectory,
    ),
    java: await capture(path.join(args.javaHome, "bin/java"), ["--version"], repositoryRoot),
    mise: await capture("mise", ["--version"], repositoryRoot),
    node: await capture(args.nodeBinary, ["--version"], repositoryRoot),
    npm: await capture("npm", ["--version"], repositoryRoot),
    python: await capture("python3", ["--version"], repositoryRoot),
    rust: await capture("rustc", ["--version"], repositoryRoot),
  };
  const expectedVersions: Readonly<Record<keyof typeof toolchain, string>> = {
    bun: "1.3.14",
    chrome: "150.0.7871.124",
    dotnet: "10.0.301",
    firebaseTools: "15.22.0",
    java: "26.0.2",
    mise: "2026.7.6",
    node: "24.20.0",
    npm: "12.0.2",
    python: "3.14.6",
    rust: "1.98.0",
  };
  for (const [name, expected] of Object.entries(expectedVersions)) {
    if (!toolchain[name as keyof typeof toolchain].includes(expected)) {
      throw new Error(`Phase 5 ${name} version diverged from ${expected}`);
    }
  }
  for (const emulatorArtifact of [
    "/home/sanjevi/.cache/firebase/emulators/cloud-firestore-emulator-v1.21.0.jar",
    "/home/sanjevi/.cache/firebase/emulators/cloud-storage-rules-runtime-v1.1.3.jar",
  ]) {
    await access(emulatorArtifact);
  }
  const { vmSwappiness } = await readPhase5SwapHostState();
  return {
    applicationUrls,
    portlessApplicationConfigs,
    portlessPrefixes,
    candidateRevision,
    capturedAt: new Date().toISOString(),
    cpuCount: cpus().length,
    cpuModel: cpus()[0]?.model ?? "unknown",
    dataset,
    host: hostname(),
    manifestSha256: PHASE5_MANIFEST_SHA256,
    os: { arch: arch(), platform: platform(), release: release() },
    projectId: args.projectId,
    officialJavaComparison: {
      defaultHeapFixture:
        "conformance/fixtures/phase5/official-java-default-heap-import.json",
      fullDatasetRetryJavaToolOptions: PHASE5_OFFICIAL_JAVA_TOOL_OPTIONS,
      retryReportedSeparately: true,
    },
    runtimeAssets,
    runtimeFilesystem,
    schemaVersion: 1,
    smoke: args.smoke,
    stagedDatasets,
    totalMemoryBytes: totalmem(),
    toolchain,
    preflights: {},
    vmSwappiness,
    twodartRevision: args.twodartRevision,
    twodartRevisions: revisions,
  };
}

async function treeIdentity(directory: string): Promise<{
  readonly fileBytes: number;
  readonly fileCount: number;
  readonly treeSha256: string;
}> {
  const files = await listFiles(directory);
  const aggregate = createHash("sha256");
  let fileBytes = 0;
  for (const relative of files) {
    const absolute = path.join(directory, relative);
    const [hash, metadata] = await Promise.all([hashFile(absolute), stat(absolute)]);
    fileBytes += metadata.size;
    aggregate.update(`${hash}  ./${relative}\n`);
  }
  return {
    fileBytes,
    fileCount: files.length,
    treeSha256: aggregate.digest("hex"),
  };
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(file);
    stream.on("data", (chunk: Buffer) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolvePromise);
  });
  return hash.digest("hex");
}

async function recordPreflight(
  args: Arguments,
  manifest: Phase5Manifest,
  environment: Record<string, unknown>,
  label: string,
): Promise<void> {
  const record: Record<string, unknown> = { label, startedAt: new Date().toISOString(), passed: false };
  try {
    const swapDrain = await drainPhase5Swap({
      assertQuiescent: async () => {
        try {
          record.processQuiescence = await waitForPhase5StackQuiescence([
            args.officialDirectory, args.firesideDirectory, args.freshDirectory,
          ]);
        } catch (error: unknown) {
          if (error instanceof Phase5ProcessQuiescenceError) {
            record.processQuiescence = error.evidence;
          }
          throw error;
        }
        const listeners = await capture("ss", ["-ltnH"], repositoryRoot);
        const gatePorts = phase5ReservedPorts();
        if (
          listeners
            .split("\n")
            .some((line) => gatePorts.some((port) => line.includes(`:${port} `)))
        ) {
          throw new Error("Refusing swap drain while gate listeners are active");
        }
      },
      readState: readPhase5SwapHostState,
      run: runPhase5SwapCommand,
    });
    record.swapDrain = swapDrain;
    if (!swapDrain.passed || swapDrain.after.vmSwappiness !== environment.vmSwappiness) {
      throw new Error("Phase 5 swap drain failed or vm.swappiness changed");
    }
    record.hostHealth = await captureHostHealth(manifest);
    record.passed = true;
  } catch (error: unknown) {
    record.errorText = errorText(error);
    throw error;
  } finally {
    record.completedAt = new Date().toISOString();
    const preflights = environment.preflights as Record<string, unknown>;
    preflights[label] = record;
    await writeJson(path.join(args.outputDirectory, `preflight-${label}.json`), record);
    await writeFile(path.join(args.outputDirectory, "environment.json"), `${JSON.stringify(environment, null, 2)}\n`);
  }
}

async function captureHostHealth(manifest: Phase5Manifest): Promise<Record<string, unknown>> {
  const [systemState, sshState, failed, journal, vmstat, listeners, filesystem] =
    await Promise.all([
      capture("systemctl", ["is-system-running"], repositoryRoot),
      capture("systemctl", ["is-active", "ssh"], repositoryRoot),
      capture("systemctl", ["--failed", "--no-legend", "--plain"], repositoryRoot),
      capture("journalctl", ["-b", "--no-pager", "-o", "cat"], repositoryRoot),
      capture("vmstat", ["-w", "1", "4"], repositoryRoot),
      capture("ss", ["-ltnH"], repositoryRoot),
      statfs(repositoryRoot),
    ]);
  const failedUnits = failed.split("\n").filter((line) => line.trim().length > 0).length;
  const oomPattern = /out of memory|oom-kill|killed process|memory cgroup out of memory|resource temporarily unavailable|fork: retry/giu;
  const oomOrResourceEvidence = [...journal.matchAll(oomPattern)].length;
  const numericVmstatLines = vmstat
    .split("\n")
    .map((line) => line.trim().split(/\s+/u))
    .filter((fields) => fields.length >= 17 && fields.every((field) => /^-?\d+$/u.test(field)));
  const steady = numericVmstatLines.slice(-manifest.host.preflight.steadyVmstatSamples);
  const swapInPagesPerSecond = steady.map((fields) => Number(fields[6] ?? -1));
  const swapOutPagesPerSecond = steady.map((fields) => Number(fields[7] ?? -1));
  const gatePorts = phase5ReservedPorts();
  const conflictingListeners = listeners
    .split("\n")
    .filter((line) => gatePorts.some((port) => line.includes(`:${String(port)} `))).length;
  const availableDiskBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
  const snapshot = {
    availableDiskBytes,
    conflictingListeners,
    failedUnits,
    oomOrResourceEvidence,
    sshState,
    steadyVmstatSamples: steady.length,
    swapInPagesPerSecond,
    swapOutPagesPerSecond,
    vmstatActivityUnit: "KiB/second (legacy field names retained; required value is zero)",
    systemState,
  };
  const violations: string[] = [];
  if (systemState !== "running") violations.push(`systemState=${systemState}`);
  if (sshState !== "active") violations.push(`sshState=${sshState}`);
  if (failedUnits !== manifest.host.preflight.failedUnits) {
    violations.push(`failedUnits=${String(failedUnits)}`);
  }
  if (
    oomOrResourceEvidence !== manifest.host.preflight.currentBootOomOrResourceKills
  ) {
    violations.push(`oomOrResourceEvidence=${String(oomOrResourceEvidence)}`);
  }
  if (steady.length !== manifest.host.preflight.steadyVmstatSamples) {
    violations.push(`steadyVmstatSamples=${String(steady.length)}`);
  }
  if (
    swapInPagesPerSecond.some(
      (value) => value !== manifest.host.preflight.maximumSwapInPagesPerSecond,
    )
  ) {
    violations.push(`swapInPagesPerSecond=${swapInPagesPerSecond.join(",")}`);
  }
  if (
    swapOutPagesPerSecond.some(
      (value) => value !== manifest.host.preflight.maximumSwapOutPagesPerSecond,
    )
  ) {
    violations.push(`swapOutPagesPerSecond=${swapOutPagesPerSecond.join(",")}`);
  }
  if (conflictingListeners !== 0) {
    violations.push(`conflictingListeners=${String(conflictingListeners)}`);
  }
  if (availableDiskBytes < manifest.host.minimumAvailableDiskBytes) {
    violations.push(`availableDiskBytes=${String(availableDiskBytes)}`);
  }
  if (violations.length > 0) {
    throw new Error(
      `Phase 5 controlled-host preflight failed: ${JSON.stringify({ ...snapshot, violations })}`,
    );
  }
  return snapshot;
}

async function listFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) output.push(relative);
    }
  }
  await visit(root);
  return output.sort((left, right) => Buffer.from(`./${left}`).compare(Buffer.from(`./${right}`)));
}

async function writeReport(
  args: Arguments,
  manifest: Phase5Manifest,
  environment: Record<string, unknown>,
): Promise<void> {
  const continuingR36 = args.officialBaselineEvidence !== null;
  const soak = Object.fromEntries(
    await Promise.all(
      stackNames.map(async (stack) => [
        stack,
        JSON.parse(
          await readFile(
            continuingR36 && stack === "official"
              ? path.join(
                  args.outputDirectory,
                  "official-baseline-evidence",
                  "soak-official.json",
                )
              : path.join(args.outputDirectory, `soak-${stack}.json`),
            "utf8",
          ),
        ) as Phase5ResourceEvidence,
      ] as const),
    ),
  );
  const lifecycle = JSON.parse(
    await readFile(path.join(args.outputDirectory, "lifecycle.json"), "utf8"),
  ) as Record<string, unknown>;
  const relativeEvidence = path.relative(repositoryRoot, args.outputDirectory);
  const outcomeSummary = continuingR36
    ? `The preserved official Firebase Emulator Suite r36 baseline and the exact Twodart revision \`${args.twodartRevision}\` completed the authorized schema-v3 continuation. The official initial and soak measurements passed; its restart is reported as host-limited. Fireside passed every unchanged full-data criterion.`
    : `The exact Twodart revision \`${args.twodartRevision}\` completed the frozen full-app differential gate against the official Firebase Emulator Suite and Fireside.`;
  const resultSummary = continuingR36
    ? `| Stack | Initial journeys | 7,200-second soak | Export/restart journeys | Final classification |\n` +
      `|---|---:|---|---|---|\n` +
      `| Official Firebase Emulator Suite | 9/9 pass | Pass | Host-limited during catalog-slide-add after three completed journeys | Baseline measured; restart host-limited |\n` +
      `| Fireside | 9/9 pass | Pass | 9/9 pass | Full gate pass |\n\n` +
      `- The preserved official restart [pending-request diagnostics](${relativeEvidence}/official-baseline-evidence/browser-official-restart.json.diagnostics.jsonl) show raw emulator, proxied Storage, and Next.js requests stalled together with zero page errors and zero gating request failures. The official stage was not rerun.\n` +
      `- Fireside passed readiness, all nine initial journeys, the unchanged sequential 7,200-second soak, export-first shutdown, restart from the exact export, all nine restart journeys, and every zero-tolerance correctness and host-health threshold.\n` +
      `- Exact Firestore, Auth, stable Storage object, and stable Storage byte counts survived the Fireside lifecycle. Fireside also imported the preserved official r36 export and matched that state exactly, including the normalized logical generated-cache value.\n` +
      `- Fresh-colleague acceptance and all Fireside and Twodart regression/build gates passed.\n` +
      `- Resource and swap figures below are measurements under identical sequential conditions. No performance winner is claimed.\n\n`
    : `- All nine real browser journeys passed against both backends before and after graceful export/restart.\n` +
      `- Firestore, Auth, stable Storage object, and stable Storage byte counts matched exactly across backends and lifecycle restart.\n` +
      `- Cache-watcher output counts and the normalized logical value of \`${PHASE5_GENERATED_CACHE_NAME}\` matched exactly; its physical gzip bytes are reported per observation as a measurement because the official oracle proves that representation varies with the generated timestamp. External providers remained disabled.\n` +
      `- The sequential official-then-Fireside 7,200-second two-session-per-backend app-shaped soaks passed under fresh quiescent preflights with all zero-tolerance correctness and health criteria unchanged.\n` +
      `- A fresh checkout started Fireside with \`bun dev:mprocs\` and the documented official fallback also started successfully.\n` +
      `- Existing Fireside and Twodart regression/build gates passed.\n\n`;
  const report = `# Phase 5 Twodart acceptance gate\n\n` +
    `Status: **PASS**\n\n` +
    `${outcomeSummary}\n\n` +
    `## Frozen boundary\n\n` +
    `- Manifest SHA-256: \`${PHASE5_MANIFEST_SHA256}\`\n` +
    `- Phase 4 baseline: \`${manifest.phase4Baseline.tag}\` at \`${manifest.phase4Baseline.taggedRevision}\`\n` +
    `- Evidence directory: [${relativeEvidence}](${relativeEvidence})\n` +
    `- Host: \`${String(environment.host)}\`, ${String((environment.os as Record<string, unknown>).platform)} ${String((environment.os as Record<string, unknown>).release)} ${String((environment.os as Record<string, unknown>).arch)}\n\n` +
    `Schema v3 was amended before measurement from \`${manifest.amendment.previousManifestSha256}\`; \`criteriaWeakened: true\` explicitly records the authorized removal of soak swap zero assertions. Workload and durations are unchanged. The reason is preserved verbatim in the manifest. Each quiescent stack preflight recorded \`swapoff -a\`, \`swapon -a\`, and three steady zero-activity samples in \`environment.json\`. \`vm.swappiness\` remained ${String(environment.vmSwappiness)}.\n\n` +
    (continuingR36
      ? `A second amendment was committed before the Fireside measurement from \`${manifest.officialRestartHostLimitAmendment.previousManifestSha256}\`. Its \`criteriaWeakened: true\` scope is **official-baseline-only** and applies only to the checksum-pinned r36 post-restart host-exhaustion signature. Every Fireside criterion, threshold, workload, and duration remained unchanged.\n\n`
      : "") +
    `## Official Java comparison boundary\n\n` +
    `The exact Java 26 untuned-default attempt exhausted the official Firestore emulator heap while importing the 211,202-document corpus; that failed attempt is preserved by \`conformance/fixtures/phase5/official-java-default-heap-import.json\`. The completed official comparison used the existing explicit \`${PHASE5_OFFICIAL_JAVA_TOOL_OPTIONS}\` HotSpot heap option. This retry is reported separately and did not change any functional, lifecycle, soak, or Fireside threshold.\n\n` +
    `## Results\n\n` +
    resultSummary +
    `Machine-readable lifecycle evidence: \`${digest(JSON.stringify(lifecycle))}\`. Machine-readable soak evidence: \`${digest(JSON.stringify(soak))}\`.\n\n` +
    renderPhase5GeneratedCacheComparison(lifecycle) +
    renderPhase5ResourceComparison(soak) +
    `## Reproduction\n\n` +
    `Use the frozen manifest, exact Twodart revision, isolated Linux port blocks, transferred dataset/assets with their recorded SHA-256 identities, and run \`npm run test:suite:phase5-gate --prefix conformance -- [the recorded environment arguments]\`. On macOS, the ordinary developer command remains \`bun dev:mprocs\`; use \`TWODART_FIREBASE_BACKEND=official bun dev:mprocs\` only for the explicit fallback.\n\n` +
    `No private dataset content, credentials, OTPs, user identifiers, or deck identifiers are included in this report or durable evidence.\n`;
  await writeFile(args.reportPath, report, { flag: "wx" });
}

function renderPhase5GeneratedCacheComparison(
  lifecycle: Record<string, unknown>,
): string {
  const records = lifecycle.records as
    | Partial<Record<Phase5StackName, Partial<LifecycleRecord>>>
    | undefined;
  const rows: string[] = [];
  for (const stack of stackNames) {
    const record = records?.[stack];
    for (const iteration of ["initial", "restart"] as const) {
      const lifecycleIteration = record?.[iteration];
      if (lifecycleIteration === undefined) continue;
      for (const [observation, state] of [
        ["before journeys", lifecycleIteration.stateBeforeJourney],
        ["after journeys", lifecycleIteration.stateAfterJourney],
      ] as const) {
        const cache = state.generatedCache;
        if (cache === null) {
          rows.push(`| ${stack} | ${iteration} | ${observation} | missing | missing | missing |`);
        } else {
          rows.push(
            `| ${stack} | ${iteration} | ${observation} | ${String(cache.physicalBytes)} | ${String(cache.decodedBytes)} | \`${cache.normalizedSha256}\` |`,
          );
        }
      }
    }
  }
  return `### Generated cache measurements\n\n` +
    `Physical gzip bytes are measurements only; normalized logical SHA-256 equality is required.\n\n` +
    `| Stack | Lifecycle | Observation | Physical gzip bytes | Decoded bytes | Normalized logical SHA-256 |\n` +
    `|---|---|---|---:|---:|---|\n${rows.join("\n")}\n\n`;
}

async function writeChecksums(directory: string): Promise<void> {
  const files = (await listFiles(directory)).filter(
    (relative) => relative !== "checksums.sha256" && relative !== "result.json",
  );
  const lines: string[] = [];
  for (const relative of files) {
    const hash = createHash("sha256")
      .update(await readFile(path.join(directory, relative)))
      .digest("hex");
    lines.push(`${hash}  ${relative}`);
  }
  await writeFile(path.join(directory, "checksums.sha256"), `${lines.join("\n")}\n`, {
    flag: "wx",
  });
}

async function runCommand(
  name: string,
  command: string,
  args: readonly string[],
  cwd: string,
  outputDirectory: string,
  timeoutMilliseconds: number,
): Promise<CommandEvidence> {
  const log = path.join(outputDirectory, "logs", `${name}.log`);
  const started = performance.now();
  let timedOut = false;
  const result = await new Promise<{
    readonly exitCode: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMilliseconds);
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      void writeFile(log, Buffer.concat(chunks), { flag: "wx" }).then(
        () => resolvePromise({ exitCode, signal }),
        reject,
      );
    });
  });
  return {
    command: [command, ...args].join(" "),
    durationMilliseconds: performance.now() - started,
    exitCode: result.exitCode,
    log: path.relative(outputDirectory, log),
    name,
    passed: !timedOut && result.exitCode === 0,
    signal: result.signal,
  };
}

function assertCommand(command: CommandEvidence): void {
  if (!command.passed) {
    throw new Error(`${command.name} failed; see ${command.log}`);
  }
}

async function assertJsonPassed(file: string, label: string): Promise<void> {
  const value = JSON.parse(await readFile(file, "utf8")) as { readonly passed?: boolean };
  if (value.passed !== true) throw new Error(`${label} evidence did not pass`);
}

async function capture(command: string, args: readonly string[], cwd: string): Promise<string> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      if (exitCode === 0) resolvePromise(stdout.trim());
      else reject(new Error(`${command} failed: ${stderr.trim()}`));
    });
  });
}

function parseArguments(values: readonly string[]): Arguments {
  const parsed = new Map<string, string>();
  let smoke = false;
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (key === "--smoke") {
      smoke = true;
      continue;
    }
    const value = values[index + 1];
    if (key === undefined || value === undefined || !key.startsWith("--")) {
      throw new Error("Phase 5 gate arguments must be --key value pairs plus --smoke");
    }
    parsed.set(key.slice(2), value);
    index += 1;
  }
  const required = (key: string): string => {
    const value = parsed.get(key);
    if (value === undefined || value.length === 0) throw new Error(`--${key} is required`);
    return path.resolve(value);
  };
  const projectId = parsed.get("project-id") ?? "demo-twodart-local";
  if (projectId !== "demo-twodart-local") {
    throw new Error("Phase 5 gate must use demo-twodart-local");
  }
  const twodartRevision = parsed.get("twodart-revision") ?? "";
  if (!/^[0-9a-f]{40}$/u.test(twodartRevision)) {
    throw new Error("--twodart-revision must be an exact commit");
  }
  const smokeEvidenceValue = parsed.get("smoke-evidence");
  const officialBaselineEvidenceValue = parsed.get("official-baseline-evidence");
  if (!smoke && (smokeEvidenceValue === undefined || smokeEvidenceValue.length === 0)) {
    throw new Error("--smoke-evidence is required for a full-data Phase 5 attempt");
  }
  if (smoke && officialBaselineEvidenceValue !== undefined) {
    throw new Error("--official-baseline-evidence is forbidden for a smoke attempt");
  }
  return {
    firesideBinary: required("fireside-binary"),
    firesideDirectory: required("fireside-dir"),
    freshDirectory: required("fresh-dir"),
    fullData: required("full-data"),
    javaHome: required("java-home"),
    nodeBinary: required("node-binary"),
    officialDirectory: required("official-dir"),
    officialBaselineEvidence: officialBaselineEvidenceValue === undefined
      ? null
      : path.resolve(officialBaselineEvidenceValue),
    outputDirectory: required("output-dir"),
    projectId,
    reportPath: required("report-path"),
    runtimeAssetsRoot: required("runtime-assets-root"),
    runtimeRoot: required("runtime-root"),
    smoke,
    smokeEvidence:
      smokeEvidenceValue === undefined ? null : path.resolve(smokeEvidenceValue),
    twodartRevision,
  };
}

function requiredMap<K, V>(map: Map<K, V>, key: K): V {
  const value = map.get(key);
  if (value === undefined) throw new Error(`Required map value is missing: ${String(key)}`);
  return value;
}

async function requireAbsent(candidate: string): Promise<void> {
  try {
    await access(candidate);
    throw new Error(`Refusing to overwrite Phase 5 evidence: ${candidate}`);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorText(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

await main();
