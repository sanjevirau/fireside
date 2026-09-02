import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
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

import { Firestore } from "@google-cloud/firestore";

import {
  assertPhase5Manifest,
  PHASE5_MANIFEST_SHA256,
  type Phase5Manifest,
} from "./phase5-acceptance-plan.ts";
import {
  assertDistinctPhase5ApplicationUrls,
  PHASE5_APPLICATION_URL_KEYS,
  PHASE5_STACK_PORTS,
  stageHardlinkedDirectoryTree,
  type Phase5StackName,
} from "./phase5-host-prepare.ts";
import {
  cacheOutputDigest,
  readPhase5PortEnvironment,
  startPhase5Stack,
  stopPhase5Stack,
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
  readonly outputDirectory: string;
  readonly projectId: string;
  readonly reportPath: string;
  readonly runtimeAssetsRoot: string;
  readonly smoke: boolean;
  readonly twodartRevision: string;
}

interface StackState {
  readonly authUsers: number;
  readonly firestoreDocuments: number;
  readonly storageObjectBytes: number;
  readonly storageObjects: number;
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

  const environment = await verifyEnvironment(args, manifest);
  await writeJson(path.join(args.outputDirectory, "environment.json"), environment);

  const lifecycle = new Map<Phase5StackName, Partial<LifecycleRecord>>();
  const active = new Map<Phase5StackName, RunningPhase5Stack>();
  const cleanupFailureHashes: string[] = [];
  let completed = false;
  try {
    const initial = await startPair(args, manifest, "initial", "full-data", active);
    const initialSnapshots = await exercisePair(
      args,
      manifest,
      initial,
      "initial",
    );
    assertCacheParity(initial);
    assertPairState(initialSnapshots.before, manifest, true);
    assertPairState(initialSnapshots.after, manifest, true);

    if (!args.smoke) {
      for (const stack of stackNames) {
        const running = requiredMap(initial, stack);
        const stopped = await stopPhase5Stack(running, 180);
        active.delete(stack);
        lifecycle.set(stack, {
          initial: {
            browser: requiredMap(initialSnapshots.browser, stack),
            cacheDigest: cacheOutputDigest(running.cacheBuild.outputCounts),
            stateAfterJourney: requiredMap(initialSnapshots.after, stack),
            stateBeforeJourney: requiredMap(initialSnapshots.before, stack),
          },
          stops: { initial: stopped } as LifecycleRecord["stops"],
        });
      }
      const restartDataset = await stageLifecycleExports(args);
      const restarted = await startPair(
        args,
        manifest,
        "restart",
        restartDataset,
        active,
      );
      const restartSnapshots = await exercisePair(
        args,
        manifest,
        restarted,
        "restart",
      );
      assertCacheParity(restarted);
      assertPairState(restartSnapshots.before, manifest, false);
      assertPairState(restartSnapshots.after, manifest, false);
      for (const stack of stackNames) {
        const initialRecord = lifecycle.get(stack)?.initial;
        if (initialRecord === undefined) throw new Error(`${stack} initial record is missing`);
        assertExactState(initialRecord.stateAfterJourney, requiredMap(restartSnapshots.before, stack));
      }

      const soak = await runCommand(
        "two-hour-differential-soak",
        process.execPath,
        [
          "--import",
          "tsx",
          path.join(conformanceDirectory, "src/suite/run-phase5-soak.ts"),
          "--official-dir",
          args.officialDirectory,
          "--fireside-dir",
          args.firesideDirectory,
          "--project-id",
          args.projectId,
          "--output",
          path.join(args.outputDirectory, "soak.json"),
        ],
        repositoryRoot,
        args.outputDirectory,
        3 * 60 * 60_000,
      );
      assertCommand(soak);
      await assertJsonPassed(path.join(args.outputDirectory, "soak.json"), "soak");

      for (const stack of stackNames) {
        const running = requiredMap(restarted, stack);
        const stopped = await stopPhase5Stack(running, 180);
        active.delete(stack);
        const record = lifecycle.get(stack);
        if (record?.initial === undefined || record.stops?.initial === undefined) {
          throw new Error(`${stack} lifecycle record is incomplete`);
        }
        lifecycle.set(stack, {
          initial: record.initial,
          restart: {
            browser: requiredMap(restartSnapshots.browser, stack),
            cacheDigest: cacheOutputDigest(running.cacheBuild.outputCounts),
            stateAfterJourney: requiredMap(restartSnapshots.after, stack),
            stateBeforeJourney: requiredMap(restartSnapshots.before, stack),
          },
          stops: { initial: record.stops.initial, restart: stopped },
        });
      }

      await runFreshColleague(args, manifest, active);
      await runRegressions(args);
    } else {
      const soak = await runCommand(
        "differential-soak-smoke",
        process.execPath,
        [
          "--import",
          "tsx",
          path.join(conformanceDirectory, "src/suite/run-phase5-soak.ts"),
          "--official-dir",
          args.officialDirectory,
          "--fireside-dir",
          args.firesideDirectory,
          "--project-id",
          args.projectId,
          "--output",
          path.join(args.outputDirectory, "soak-smoke.json"),
          "--smoke",
        ],
        repositoryRoot,
        args.outputDirectory,
        15 * 60_000,
      );
      assertCommand(soak);
      await assertJsonPassed(path.join(args.outputDirectory, "soak-smoke.json"), "soak smoke");
      for (const stack of stackNames) {
        const running = requiredMap(initial, stack);
        const stopped = await stopPhase5Stack(running, 180);
        active.delete(stack);
        lifecycle.set(stack, {
          initial: {
            browser: requiredMap(initialSnapshots.browser, stack),
            cacheDigest: cacheOutputDigest(running.cacheBuild.outputCounts),
            stateAfterJourney: requiredMap(initialSnapshots.after, stack),
            stateBeforeJourney: requiredMap(initialSnapshots.before, stack),
          },
          stops: { initial: stopped } as LifecycleRecord["stops"],
        });
      }
    }

    await writeJson(
      path.join(args.outputDirectory, "dataset-final.json"),
      await verifyFinalDatasetIdentity(args, manifest),
    );

    await writeJson(path.join(args.outputDirectory, "lifecycle.json"), {
      allowedCountMismatch: manifest.lifecycle.allowedCountMismatch,
      cacheOutputsMatched: true,
      records: Object.fromEntries(lifecycle),
      schemaVersion: 1,
      smoke: args.smoke,
    });
    await writeChecksums(args.outputDirectory);
    if (!args.smoke) await writeReport(args, manifest, environment);
    await writeJson(path.join(args.outputDirectory, "result.json"), {
      cleanupFailureHashes,
      completedAt: new Date().toISOString(),
      manifestSha256: PHASE5_MANIFEST_SHA256,
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
          await stopPhase5Stack(running, 180);
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
  }
}

async function verifyFinalDatasetIdentity(
  args: Arguments,
  manifest: Phase5Manifest,
): Promise<Record<string, unknown>> {
  const roots = {
    fireside: path.join(
      args.firesideDirectory,
      "apps/templates-firebase/loadData/datasets/full-data",
    ),
    frozen: args.fullData,
    official: path.join(
      args.officialDirectory,
      "apps/templates-firebase/loadData/datasets/full-data",
    ),
  };
  const identities: Record<string, Awaited<ReturnType<typeof treeIdentity>>> = Object.fromEntries(
    await Promise.all(
      Object.entries(roots).map(async ([name, root]) => [name, await treeIdentity(root)] as const),
    ),
  );
  for (const [name, identity] of Object.entries(identities)) {
    if (
      identity.fileCount !== manifest.dataset.fileCount ||
      identity.fileBytes !== manifest.dataset.fileBytes ||
      identity.treeSha256 !== manifest.dataset.treeSha256
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

async function startPair(
  args: Arguments,
  manifest: Phase5Manifest,
  label: "initial" | "restart",
  datasetName: string,
  active: Map<Phase5StackName, RunningPhase5Stack>,
): Promise<Map<Phase5StackName, RunningPhase5Stack>> {
  const pair = new Map<Phase5StackName, RunningPhase5Stack>();
  for (const stack of stackNames) {
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
        directory,
        evidenceDirectory: args.outputDirectory,
        exportPath,
        firesideBinary: args.firesideBinary,
        javaHome: args.javaHome,
        label,
        nodeBinary: args.nodeBinary,
        ports: PHASE5_STACK_PORTS[stack],
        runtimeDirectory: path.join(
          path.dirname(path.dirname(args.fullData)),
          `runtime-${path.basename(args.outputDirectory)}`,
          `${stack}-${label}`,
        ),
        stack,
        tmuxSession: `fireside-phase5-${stack}-${label}-${process.pid.toString(36)}`,
      },
      manifest.cacheWatcher.maximumReadySeconds,
      manifest.dataset.logicalCounts.firestoreDocuments,
    );
    pair.set(stack, running);
    active.set(stack, running);
  }
  return pair;
}

async function exercisePair(
  args: Arguments,
  manifest: Phase5Manifest,
  running: Map<Phase5StackName, RunningPhase5Stack>,
  iteration: "initial" | "restart",
): Promise<{
  readonly after: Map<Phase5StackName, StackState>;
  readonly before: Map<Phase5StackName, StackState>;
  readonly browser: Map<Phase5StackName, BrowserEvidence>;
}> {
  const before = new Map<Phase5StackName, StackState>();
  const after = new Map<Phase5StackName, StackState>();
  const browser = new Map<Phase5StackName, BrowserEvidence>();
  for (const stack of stackNames) {
    const item = requiredMap(running, stack);
    before.set(stack, await captureStackState(item, args.projectId));
    const output = path.join(args.outputDirectory, `browser-${stack}-${iteration}.json`);
    const command = await runCommand(
      `browser-${stack}-${iteration}`,
      process.execPath,
      [
        "--import",
        "tsx",
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
        item.baseUrl,
        "--twodart-dir",
        stack === "official" ? args.officialDirectory : args.firesideDirectory,
        "--firestore-port",
        String(item.ports.firestore),
        "--auth-port",
        String(item.ports.auth),
        "--storage-port",
        String(item.ports.storage),
        "--functions-port",
        String(item.ports.functions),
        "--cache-websocket-port",
        String(item.ports.cacheWebsocket),
        "--output",
        output,
      ],
      repositoryRoot,
      args.outputDirectory,
      45 * 60_000,
    );
    assertCommand(command);
    const evidence = JSON.parse(await readFile(output, "utf8")) as BrowserEvidence;
    if (
      !evidence.passed ||
      evidence.stack !== stack ||
      evidence.iteration !== iteration ||
      evidence.journeys.length !== manifest.differentialJourneys.journeys.length
    ) {
      throw new Error(`${stack} ${iteration} browser journey evidence diverged`);
    }
    browser.set(stack, evidence);
    after.set(stack, await captureStackState(item, args.projectId));
  }
  return { after, before, browser };
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
  let storageObjects = 0;
  let storageObjectBytes = 0;
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
        readonly items?: readonly { readonly size?: number | string }[];
        readonly nextPageToken?: string;
      };
      const items = body.items ?? [];
      storageObjects += items.length;
      storageObjectBytes += items.reduce((total, item) => total + Number(item.size ?? 0), 0);
      token = body.nextPageToken ?? "";
    } while (token.length > 0);
  }
  return {
    authUsers: authBody.userInfo?.length ?? 0,
    firestoreDocuments,
    storageObjectBytes,
    storageObjects,
  };
}

function assertPairState(
  states: Map<Phase5StackName, StackState>,
  manifest: Phase5Manifest,
  requireFrozenDatasetCounts: boolean,
): void {
  const official = requiredMap(states, "official");
  const fireside = requiredMap(states, "fireside");
  assertExactState(official, fireside);
  if (requireFrozenDatasetCounts) {
    const frozen = manifest.dataset.logicalCounts;
    if (
      official.firestoreDocuments !== frozen.firestoreDocuments ||
      official.authUsers !== frozen.authUsers ||
      official.storageObjects !== frozen.storageObjects ||
      official.storageObjectBytes !== frozen.storageObjectBytes
    ) {
      throw new Error("Measured imported state diverged from the frozen logical counts");
    }
  }
}

function assertExactState(left: StackState, right: StackState): void {
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(`Phase 5 state mismatch: ${JSON.stringify({ left, right })}`);
  }
}

function assertCacheParity(pair: Map<Phase5StackName, RunningPhase5Stack>): void {
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
}

async function stageLifecycleExports(args: Arguments): Promise<string> {
  const name = "phase5-lifecycle-export";
  for (const stack of stackNames) {
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
  }
  return name;
}

async function runFreshColleague(
  args: Arguments,
  manifest: Phase5Manifest,
  active: Map<Phase5StackName, RunningPhase5Stack>,
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
    const running = await startPhase5Stack(
      {
        backendOverride: backend,
        datasetName: "full-data",
        directory: args.freshDirectory,
        evidenceDirectory: args.outputDirectory,
        exportPath,
        firesideBinary: args.firesideBinary,
        javaHome: args.javaHome,
        label,
        nodeBinary: args.nodeBinary,
        ports: PHASE5_STACK_PORTS.fireside,
        runtimeDirectory: path.join(
          path.dirname(path.dirname(args.fullData)),
          `runtime-${path.basename(args.outputDirectory)}`,
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
    await stopPhase5Stack(running, 180);
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
  for (const candidate of [
    args.fullData,
    args.runtimeAssetsRoot,
    args.firesideBinary,
    args.javaHome,
    args.nodeBinary,
  ]) {
    await access(candidate);
  }
  const dataset = await treeIdentity(args.fullData);
  if (
    dataset.fileCount !== manifest.dataset.fileCount ||
    dataset.fileBytes !== manifest.dataset.fileBytes ||
    dataset.treeSha256 !== manifest.dataset.treeSha256
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
      "apps/templates-firebase/loadData/datasets/full-data",
    );
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
  const hostHealth = await captureHostHealth(manifest, args.smoke);
  return {
    applicationUrls,
    candidateRevision,
    capturedAt: new Date().toISOString(),
    cpuCount: cpus().length,
    cpuModel: cpus()[0]?.model ?? "unknown",
    dataset,
    host: hostname(),
    manifestSha256: PHASE5_MANIFEST_SHA256,
    os: { arch: arch(), platform: platform(), release: release() },
    projectId: args.projectId,
    runtimeAssets,
    schemaVersion: 1,
    smoke: args.smoke,
    stagedDatasets,
    totalMemoryBytes: totalmem(),
    toolchain,
    hostHealth,
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

async function captureHostHealth(
  manifest: Phase5Manifest,
  smoke: boolean,
): Promise<Record<string, unknown>> {
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
  const gatePorts = Object.values(PHASE5_STACK_PORTS).flatMap((ports) => Object.values(ports));
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
    systemState,
  };
  const violations: string[] = [];
  if (systemState !== "running") violations.push(`systemState=${systemState}`);
  if (sshState !== "active") violations.push(`sshState=${sshState}`);
  if (failedUnits !== manifest.host.preflight.failedUnits) {
    violations.push(`failedUnits=${String(failedUnits)}`);
  }
  if (
    !smoke &&
    oomOrResourceEvidence !== manifest.host.preflight.currentBootOomOrResourceKills
  ) {
    violations.push(`oomOrResourceEvidence=${String(oomOrResourceEvidence)}`);
  }
  if (steady.length !== manifest.host.preflight.steadyVmstatSamples) {
    violations.push(`steadyVmstatSamples=${String(steady.length)}`);
  }
  if (
    swapInPagesPerSecond.some(
      (value) => value > manifest.host.preflight.maximumSwapInPagesPerSecond,
    )
  ) {
    violations.push(`swapInPagesPerSecond=${swapInPagesPerSecond.join(",")}`);
  }
  if (
    swapOutPagesPerSecond.some(
      (value) => value > manifest.host.preflight.maximumSwapOutPagesPerSecond,
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
  const soak = JSON.parse(
    await readFile(path.join(args.outputDirectory, "soak.json"), "utf8"),
  ) as Record<string, unknown>;
  const lifecycle = JSON.parse(
    await readFile(path.join(args.outputDirectory, "lifecycle.json"), "utf8"),
  ) as Record<string, unknown>;
  const relativeEvidence = path.relative(repositoryRoot, args.outputDirectory);
  const report = `# Phase 5 Twodart acceptance gate\n\n` +
    `Status: **PASS**\n\n` +
    `The exact Twodart revision \`${args.twodartRevision}\` completed the frozen full-app differential gate against the official Firebase Emulator Suite and Fireside.\n\n` +
    `## Frozen boundary\n\n` +
    `- Manifest SHA-256: \`${PHASE5_MANIFEST_SHA256}\`\n` +
    `- Phase 4 baseline: \`${manifest.phase4Baseline.tag}\` at \`${manifest.phase4Baseline.taggedRevision}\`\n` +
    `- Evidence directory: [${relativeEvidence}](${relativeEvidence})\n` +
    `- Host: \`${String(environment.host)}\`, ${String((environment.os as Record<string, unknown>).platform)} ${String((environment.os as Record<string, unknown>).release)} ${String((environment.os as Record<string, unknown>).arch)}\n\n` +
    `## Results\n\n` +
    `- All nine real browser journeys passed against both backends before and after graceful export/restart.\n` +
    `- Firestore, Auth, Storage object, and Storage byte counts matched exactly across backends and lifecycle restart.\n` +
    `- Cache-watcher output counts matched exactly; external providers remained disabled.\n` +
    `- The simultaneous 7,200-second two-session-per-backend app-shaped soak passed all zero-tolerance correctness and health criteria.\n` +
    `- A fresh checkout started Fireside with \`bun dev:mprocs\` and the documented official fallback also started successfully.\n` +
    `- Existing Fireside and Twodart regression/build gates passed.\n\n` +
    `Machine-readable lifecycle evidence: \`${digest(JSON.stringify(lifecycle))}\`. Machine-readable soak evidence: \`${digest(JSON.stringify(soak))}\`.\n\n` +
    `## Reproduction\n\n` +
    `Use the frozen manifest, exact Twodart revision, isolated Linux port blocks, transferred dataset/assets with their recorded SHA-256 identities, and run \`npm run test:suite:phase5-gate --prefix conformance -- [the recorded environment arguments]\`. On macOS, the ordinary developer command remains \`bun dev:mprocs\`; use \`TWODART_FIREBASE_BACKEND=official bun dev:mprocs\` only for the explicit fallback.\n\n` +
    `No private dataset content, credentials, OTPs, user identifiers, or deck identifiers are included in this report or durable evidence.\n`;
  await writeFile(args.reportPath, report, { flag: "wx" });
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
    child.once("exit", (exitCode, signal) => {
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
    child.once("exit", (exitCode) => {
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
  return {
    firesideBinary: required("fireside-binary"),
    firesideDirectory: required("fireside-dir"),
    freshDirectory: required("fresh-dir"),
    fullData: required("full-data"),
    javaHome: required("java-home"),
    nodeBinary: required("node-binary"),
    officialDirectory: required("official-dir"),
    outputDirectory: required("output-dir"),
    projectId,
    reportPath: required("report-path"),
    runtimeAssetsRoot: required("runtime-assets-root"),
    smoke,
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
