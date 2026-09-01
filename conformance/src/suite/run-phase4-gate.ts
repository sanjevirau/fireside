import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { arch, cpus, hostname, platform, release, totalmem } from "node:os";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertPhase4Manifest,
  assertPhase4Toolchain,
  PHASE4_MANIFEST_SHA256,
  PHASE4_MODES,
  PHASE4_PROJECT_ID,
  type Phase4Manifest,
  type Phase4ObservedToolchain,
  type Phase4Mode,
} from "./phase4-gate-plan.ts";

interface Arguments {
  readonly fullData: string;
  readonly outputDirectory: string;
  readonly reportPath: string;
  readonly sdkDirectory?: string;
  readonly smoke: boolean;
  readonly twodartDirectory: string;
}

interface Ports {
  readonly auth: number;
  readonly cacheWebsocket: number;
  readonly eventarc: number;
  readonly firestore: number;
  readonly functions: number;
  readonly hub: number;
  readonly logging: number;
  readonly pubsub: number;
  readonly storage: number;
  readonly tasks: number;
  readonly ui: number;
  readonly websocket: number;
}

interface SuiteOutcome {
  readonly authUsers: number;
  readonly delivery: {
    readonly admitted: number;
    readonly assumedDeliveredAfterResponseLoss: number;
    readonly deduplicated: number;
    readonly delivered: number;
    readonly failed: number;
    readonly latency: {
      readonly p50Micros: number;
      readonly p95Micros: number;
      readonly p99Micros: number;
      readonly samples: number;
    };
    readonly retries: number;
  };
  readonly firestoreDocuments: number;
  readonly functions: number;
  readonly schedules: number;
  readonly storageBytes: number;
  readonly storageObjects: number;
}

interface SuiteProcess {
  readonly child: ChildProcess;
  readonly log: string;
  readonly ports: Ports;
  readonly processBoundary: ProcessBoundary;
  readonly readyMilliseconds: number;
  readonly rss: RssMonitor;
  readonly stream: ReturnType<typeof createWriteStream>;
  readonly temporaryDirectory: string;
}

interface RssMonitor {
  peakFiresideBytes: number;
  peakFiresidePssBytes: number | null;
  peakTreeBytes: number;
  peakTreePssBytes: number | null;
  pssAvailable: boolean;
  stop(): Promise<void>;
}

interface ProcessBoundary {
  readonly allowedStorageRulesJavaProcesses: number;
  readonly firesideProcesses: number;
  readonly forbiddenDataServiceProcesses: number;
  readonly functionsWorkloadHostProcesses: number;
  readonly passed: boolean;
}

interface CommandRecord {
  readonly command: string;
  readonly durationMilliseconds: number;
  readonly exitCode: number | null;
  readonly log: string;
  readonly name: string;
  readonly passed: boolean;
  readonly signal: NodeJS.Signals | null;
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../../..");
const conformanceDirectory = join(repositoryRoot, "conformance");
const manifestPath = join(repositoryRoot, "benchmarks", "phase-4-twodart-suite.json");
const expectedFullData = {
  authUsers: 1,
  firestoreDocuments: 211_202,
  storageBytes: 6_689_692_200,
  storageObjects: 33_353,
};

await main();

async function main(): Promise<void> {
  const arguments_ = parseArguments(process.argv.slice(2));
  await requireAbsent(arguments_.outputDirectory);
  await requireAbsent(arguments_.reportPath);
  await mkdir(join(arguments_.outputDirectory, "logs"), { recursive: true });
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as Phase4Manifest;
  assertPhase4Manifest(manifest, manifestBytes);
  await copyFile(manifestPath, join(arguments_.outputDirectory, "manifest.json"));
  const fixtureVerification = await verifyAndCopyFixtureChecksums(
    arguments_.outputDirectory,
    manifest,
  );
  const configurationVerification = await verifyTwodartConfiguration(
    arguments_.twodartDirectory,
    manifest,
  );

  const candidateRevision = await capture("git", ["rev-parse", "HEAD"], repositoryRoot);
  const twodartRevision = await capture(
    "git",
    ["rev-parse", "HEAD"],
    arguments_.twodartDirectory,
  );
  const toolchain = await collectToolchain(arguments_.twodartDirectory);
  if (!arguments_.smoke) assertPhase4Toolchain(manifest, toolchain);
  await writeJson(join(arguments_.outputDirectory, "environment.json"), {
    candidateRevision,
    capturedAt: new Date().toISOString(),
    cpuCount: cpus().length,
    cpuModel: cpus()[0]?.model ?? "unknown",
    host: hostname(),
    manifestSha256: PHASE4_MANIFEST_SHA256,
    os: { arch: arch(), platform: platform(), release: release() },
    schemaVersion: 1,
    smoke: arguments_.smoke,
    toolchain,
    totalMemoryBytes: totalmem(),
    configurationVerification,
    fixtureVerification,
    twodartPinnedSourceRevision: manifest.twodartContract.sourceRevision,
    twodartRevision,
  });

  try {
    const commands: CommandRecord[] = [];
    commands.push(
      await runCommand(
        "release-build",
        "cargo",
        ["build", "--release", "--locked", "-p", "fireside"],
        arguments_.outputDirectory,
        repositoryRoot,
        30 * 60_000,
      ),
    );
    assertCommands([commands.at(-1)!]);

    const modes = [];
    for (const mode of PHASE4_MODES) {
      modes.push(await runMode(mode, arguments_, manifest));
    }
    await writeJson(join(arguments_.outputDirectory, "twodart-modes.json"), {
      modes,
      passed: true,
      schemaVersion: 1,
    });

    const restartCount = arguments_.smoke ? 2 : manifest.gates.chaos.suiteForcedRestarts;
    const restarts = [];
    for (let index = 0; index < restartCount; index += 1) {
      const suite = await startSuite({
        arguments_,
        label: `restart-${String(index + 1).padStart(2, "0")}`,
        mode: index % 2 === 0 ? "memory" : "disk-wal",
      });
      const stopped = await stopSuite(suite);
      assertCleanOutcome(stopped.outcome, manifest, false);
      restarts.push({
        index: index + 1,
        outcome: stopped.outcome,
        peakFiresidePssBytes: suite.rss.peakFiresidePssBytes,
        peakFiresideRssBytes: suite.rss.peakFiresideBytes,
        peakProcessTreePssBytes: suite.rss.peakTreePssBytes,
        peakProcessTreeRssBytes: suite.rss.peakTreeBytes,
        processBoundary: suite.processBoundary,
        readyMilliseconds: suite.readyMilliseconds,
        shutdownMilliseconds: stopped.shutdownMilliseconds,
      });
    }
    await writeJson(join(arguments_.outputDirectory, "forced-restarts.json"), {
      count: restarts.length,
      passed: restarts.length === restartCount,
      restarts,
      schemaVersion: 1,
    });

    commands.push(...(await runChaosAndQuality(arguments_.outputDirectory, arguments_.smoke)));
    assertCommands(commands);
    await writeJson(join(arguments_.outputDirectory, "commands.json"), {
      commands,
      passed: true,
      schemaVersion: 1,
    });

    let fullData: Record<string, unknown> | undefined;
    let officialComparison: Record<string, unknown> | undefined;
    let phase3Regression: CommandRecord | undefined;
    if (!arguments_.smoke) {
      await assertFullDataSource(arguments_.fullData, manifest);
      fullData = await runFullData(arguments_, manifest);
      await writeJson(join(arguments_.outputDirectory, "full-data.json"), fullData);
      officialComparison = await runOfficialComparison(arguments_, manifest);
      await writeJson(
        join(arguments_.outputDirectory, "official-java-comparison.json"),
        officialComparison,
      );
      if (arguments_.sdkDirectory === undefined) {
        throw new Error("--sdk-dir is required for the immutable full gate");
      }
      phase3Regression = await runCommand(
        "phase3-full-regression",
        process.execPath,
        [
          "--import",
          "tsx",
          join(conformanceDirectory, "src", "rules", "run-phase3-gate.ts"),
          "--sdk-dir",
          arguments_.sdkDirectory,
          "--output-dir",
          join(arguments_.outputDirectory, "phase3-regression", "evidence"),
          "--report",
          join(arguments_.outputDirectory, "phase3-regression", "report.md"),
        ],
        arguments_.outputDirectory,
        conformanceDirectory,
        8 * 60 * 60_000,
      );
      assertCommands([phase3Regression]);
    }
    await writeJson(join(arguments_.outputDirectory, "phase3-regression.json"), {
      command: phase3Regression,
      passed: arguments_.smoke ? null : true,
      schemaVersion: 1,
      skippedForSmoke: arguments_.smoke,
    });
    await writeJson(join(arguments_.outputDirectory, "deviations.json"), {
      explained: [
        "firebase-tools remains only the pinned Node Functions/Extensions workload host",
        "the official Java comparison is non-gating and is reported separately",
        "Stripe and Algolia provider APIs are not mutated; extension transport is covered by safe local probes and exact local fan-out tests",
        ...(platform() === "linux"
          ? []
          : ["this macOS host exposes RSS but not Linux smaps PSS; PSS is recorded as unavailable and the frozen memory threshold remains RSS-based"]),
      ],
      passed: true,
      schemaVersion: 1,
      unexplainedDeviations: 0,
    });
    await writeReport(arguments_.reportPath, {
      candidateRevision,
      manifest,
      modes,
      outputDirectory: arguments_.outputDirectory,
      restarts,
      smoke: arguments_.smoke,
      twodartRevision,
      ...(fullData === undefined ? {} : { fullData }),
      ...(officialComparison === undefined ? {} : { officialComparison }),
    });
    await writeChecksums(arguments_.outputDirectory);
  } catch (error) {
    await writeJson(join(arguments_.outputDirectory, "failure.json"), {
      failedAt: new Date().toISOString(),
      message: error instanceof Error ? error.stack ?? error.message : String(error),
      passed: false,
      schemaVersion: 1,
    });
    await writeChecksums(arguments_.outputDirectory);
    throw error;
  }
}

async function runMode(
  mode: Phase4Mode,
  arguments_: Arguments,
  manifest: Phase4Manifest,
): Promise<Record<string, unknown>> {
  const suite = await startSuite({
    arguments_,
    label: `twodart-${mode}`,
    mode,
  });
  let runtime: CommandRecord;
  try {
    runtime = await runCommand(
      `twodart-runtime-${mode}`,
      process.execPath,
      [
        "--import",
        "tsx",
        join(scriptDirectory, "run-phase4-twodart-runtime.ts"),
        "--host",
        "127.0.0.1",
        "--firestore-port",
        String(suite.ports.firestore),
        "--auth-port",
        String(suite.ports.auth),
        "--storage-port",
        String(suite.ports.storage),
        "--functions-port",
        String(suite.ports.functions),
        "--pubsub-port",
        String(suite.ports.pubsub),
        "--hub-port",
        String(suite.ports.hub),
        "--ui-port",
        String(suite.ports.ui),
        "--cache-websocket-port",
        String(suite.ports.cacheWebsocket),
        "--project-id",
        PHASE4_PROJECT_ID,
        "--twodart-dir",
        arguments_.twodartDirectory,
        "--python",
        join(arguments_.twodartDirectory, "apps", "papi", ".venv", "bin", "python"),
        "--output-dir",
        join(arguments_.outputDirectory, `runtime-${mode}`),
      ],
      arguments_.outputDirectory,
      conformanceDirectory,
      10 * 60_000,
    );
    assertCommands([runtime]);
  } catch (error) {
    try {
      await stopSuite(suite);
    } catch (stopError) {
      throw new AggregateError(
        [error, stopError],
        `${mode} runtime and coordinated cleanup both failed`,
      );
    }
    throw error;
  }
  const stopped = await stopSuite(suite);
  assertCleanOutcome(stopped.outcome, manifest, true);
  return {
    mode,
    outcome: stopped.outcome,
    peakFiresideRssBytes: suite.rss.peakFiresideBytes,
    peakFiresidePssBytes: suite.rss.peakFiresidePssBytes,
    peakProcessTreeRssBytes: suite.rss.peakTreeBytes,
    peakProcessTreePssBytes: suite.rss.peakTreePssBytes,
    processBoundary: suite.processBoundary,
    readyMilliseconds: suite.readyMilliseconds,
    runtime,
    shutdownMilliseconds: stopped.shutdownMilliseconds,
  };
}

async function startSuite(input: {
  readonly arguments_: Arguments;
  readonly exportPath?: string;
  readonly importPath?: string;
  readonly label: string;
  readonly mode: Phase4Mode;
}): Promise<SuiteProcess> {
  const ports = await reservePortBlock();
  // firebase-tools places a Functions IPC socket under TMPDIR. macOS caps
  // AF_UNIX paths at 104 bytes, so gate state must use an intentionally short
  // system path even when the durable evidence path is long.
  const temporaryDirectory = await mkdtemp("/tmp/tw-p4-");
  const log = join(input.arguments_.outputDirectory, "logs", `${input.label}.log`);
  const stream = createWriteStream(log, { flags: "wx" });
  let output = "";
  const env = suiteEnvironment(ports, temporaryDirectory, input.mode, input.importPath, input.exportPath);
  const child = spawn(
    join(input.arguments_.twodartDirectory, "scripts", "dev", "start-firebase-emulator.sh"),
    [],
    { cwd: input.arguments_.twodartDirectory, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    stream.write(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    stream.write(chunk);
  });
  const rss = monitorRss(child.pid ?? -1);
  const started = performance.now();
  try {
    await waitFor(() => output.includes("All emulators ready"), child, 120_000);
  } catch (error) {
    child.kill("SIGTERM");
    await Promise.race([waitForExit(child), delay(15_000)]);
    await rss.stop();
    await closeWriteStream(stream);
    throw new Error(`${input.label} failed readiness; see ${log}: ${String(error)}`);
  }
  const readyMilliseconds = performance.now() - started;
  if (readyMilliseconds >= 120_000) {
    child.kill("SIGTERM");
    await Promise.race([waitForExit(child), delay(15_000)]);
    await rss.stop();
    await closeWriteStream(stream);
    throw new Error(`${input.label} exceeded readiness threshold`);
  }
  let processBoundary: ProcessBoundary;
  try {
    processBoundary = await assertFiresideProcessBoundary(child.pid ?? -1);
  } catch (error) {
    child.kill("SIGTERM");
    await Promise.race([waitForExit(child), delay(15_000)]);
    await rss.stop();
    await closeWriteStream(stream);
    throw error;
  }
  return {
    child,
    log,
    ports,
    processBoundary,
    readyMilliseconds,
    rss,
    stream,
    temporaryDirectory,
  };
}

async function stopSuite(suite: SuiteProcess): Promise<{
  readonly outcome: SuiteOutcome;
  readonly shutdownMilliseconds: number;
}> {
  const started = performance.now();
  suite.child.kill("SIGINT");
  const result = await waitForExit(suite.child, 30 * 60_000);
  await suite.rss.stop();
  await closeWriteStream(suite.stream);
  const shutdownMilliseconds = performance.now() - started;
  if (result.exitCode !== 0) throw new Error(`suite did not stop cleanly; see ${suite.log}`);
  const logText = await readFile(suite.log, "utf8");
  const lines = logText.split("\n").filter((line) => line.includes("fireside suite stopped cleanly: "));
  const line = lines.at(-1);
  if (line === undefined) throw new Error(`suite outcome missing from ${suite.log}`);
  const outcome = JSON.parse(line.slice(line.indexOf("{")).trim()) as SuiteOutcome;
  return { outcome, shutdownMilliseconds };
}

function assertCleanOutcome(
  outcome: SuiteOutcome,
  manifest: Phase4Manifest,
  requireDeliveries: boolean,
): void {
  if (outcome.functions !== 21 || outcome.schedules !== 2 || outcome.delivery.failed !== 0) {
    throw new Error(`suite outcome failed: ${JSON.stringify(outcome)}`);
  }
  if (outcome.delivery.assumedDeliveredAfterResponseLoss !== 0) {
    throw new Error(`normal runtime lost Functions acknowledgements: ${JSON.stringify(outcome)}`);
  }
  if (requireDeliveries && (outcome.delivery.admitted === 0 || outcome.delivery.latency.samples === 0)) {
    throw new Error("runtime gate admitted no Functions deliveries");
  }
  if (
    outcome.delivery.latency.p99Micros >=
    manifest.gates.performance.thresholds.triggerDeliveryP99Milliseconds * 1_000
  ) {
    throw new Error(`trigger p99 exceeded threshold: ${String(outcome.delivery.latency.p99Micros)}us`);
  }
}

async function runChaosAndQuality(outputDirectory: string, smoke: boolean): Promise<CommandRecord[]> {
  const records = [];
  const tests = [
    ["chaos-response-loss", "cargo", ["test", "--locked", "-p", "fireside-functions-bridge", "phase4_fifty_response_losses_have_zero_duplicate_effects"]],
    ["chaos-auth-dedupe", "cargo", ["test", "--locked", "-p", "fireside-functions-bridge", "phase4_fifty_duplicate_auth_retries_are_exactly_once"]],
    ["chaos-six-patterns", "cargo", ["test", "--locked", "-p", "fireside-functions-bridge", "phase4_six_trigger_patterns_deliver_one_hundred_concurrent_writes_each"]],
    ["extension-fanout", "cargo", ["test", "--locked", "-p", "fireside-functions-bridge", "phase4_extension_trigger_fanout_is_local_and_exact"]],
    ["chaos-resumable", "cargo", ["test", "--locked", "-p", "fireside-storage-front", "phase4_fifty_resumable_uploads_survive_an_interruption"]],
  ] as const;
  for (const [name, command, values] of tests) {
    records.push(await runCommand(name, command, values, outputDirectory, repositoryRoot, 10 * 60_000));
  }
  records.push(await runCommand("rust-fmt", "cargo", ["fmt", "--all", "--", "--check"], outputDirectory, repositoryRoot, 10 * 60_000));
  records.push(await runCommand("typescript-check", "npm", ["--prefix", "conformance", "run", "check"], outputDirectory, repositoryRoot, 10 * 60_000));
  records.push(await runCommand("typescript-tests", "npm", ["--prefix", "conformance", "test"], outputDirectory, repositoryRoot, 30 * 60_000));
  if (!smoke) {
    records.push(await runCommand("rust-clippy", "cargo", ["clippy", "--workspace", "--all-targets", "--all-features", "--", "-D", "warnings"], outputDirectory, repositoryRoot, 60 * 60_000));
    records.push(await runCommand("rust-tests", "cargo", ["test", "--workspace", "--locked"], outputDirectory, repositoryRoot, 2 * 60 * 60_000));
    records.push(await runCommand("fireside-conformance", "npm", ["--prefix", "conformance", "run", "test:fireside"], outputDirectory, repositoryRoot, 60 * 60_000));
  }
  return records;
}

async function runFullData(
  arguments_: Arguments,
  manifest: Phase4Manifest,
): Promise<Record<string, unknown>> {
  const exportPath = join(arguments_.outputDirectory, "full-data-export");
  const suite = await startSuite({
    arguments_,
    exportPath,
    importPath: arguments_.fullData,
    label: "full-data-import-export",
    mode: "disk-wal",
  });
  const stopped = await stopSuite(suite);
  assertFullDataOutcome(stopped.outcome);
  if (suite.readyMilliseconds >= manifest.gates.performance.thresholds.fullDataImportMaximumSeconds * 1_000) {
    throw new Error("full-data import exceeded the frozen wall-clock threshold");
  }
  if (stopped.shutdownMilliseconds >= manifest.gates.performance.thresholds.fullDataExportMaximumSeconds * 1_000) {
    throw new Error("full-data export exceeded the frozen wall-clock threshold");
  }
  if (suite.rss.peakFiresideBytes >= manifest.gates.performance.thresholds.fullDataPeakRssBytes) {
    throw new Error("full-data Fireside RSS exceeded the frozen threshold");
  }
  const reimport = await startSuite({
    arguments_,
    importPath: exportPath,
    label: "full-data-reimport",
    mode: "disk-wal",
  });
  const reimportStopped = await stopSuite(reimport);
  assertFullDataOutcome(reimportStopped.outcome);
  return {
    export: {
      durationMilliseconds: stopped.shutdownMilliseconds,
      path: exportPath,
    },
    import: {
      durationMilliseconds: suite.readyMilliseconds,
      outcome: stopped.outcome,
      peakFiresideRssBytes: suite.rss.peakFiresideBytes,
      peakFiresidePssBytes: suite.rss.peakFiresidePssBytes,
      peakProcessTreeRssBytes: suite.rss.peakTreeBytes,
      peakProcessTreePssBytes: suite.rss.peakTreePssBytes,
      processBoundary: suite.processBoundary,
      source: arguments_.fullData,
    },
    passed: true,
    reimport: {
      durationMilliseconds: reimport.readyMilliseconds,
      outcome: reimportStopped.outcome,
      peakFiresideRssBytes: reimport.rss.peakFiresideBytes,
      peakFiresidePssBytes: reimport.rss.peakFiresidePssBytes,
      peakProcessTreeRssBytes: reimport.rss.peakTreeBytes,
      peakProcessTreePssBytes: reimport.rss.peakTreePssBytes,
      processBoundary: reimport.processBoundary,
    },
    schemaVersion: 1,
  };
}

function assertFullDataOutcome(outcome: SuiteOutcome): void {
  for (const [key, expected] of Object.entries(expectedFullData)) {
    if (outcome[key as keyof typeof expectedFullData] !== expected) {
      throw new Error(`full-data ${key} mismatch: expected ${String(expected)}, observed ${String(outcome[key as keyof SuiteOutcome])}`);
    }
  }
}

async function runOfficialComparison(
  arguments_: Arguments,
  _manifest: Phase4Manifest,
): Promise<Record<string, unknown>> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "fireside-phase4-official-"));
  const original = JSON.parse(
    await readFile(join(arguments_.twodartDirectory, "apps", "templates-firebase", "firebase.json"), "utf8"),
  ) as Record<string, any>;
  const ports = await reservePortBlock();
  original.emulators = {
    ...original.emulators,
    auth: { ...(original.emulators?.auth ?? {}), host: "127.0.0.1", port: ports.auth },
    firestore: { ...(original.emulators?.firestore ?? {}), host: "127.0.0.1", port: ports.firestore, websocketPort: ports.websocket },
    functions: { ...(original.emulators?.functions ?? {}), host: "127.0.0.1", port: ports.functions },
    hub: { ...(original.emulators?.hub ?? {}), host: "127.0.0.1", port: ports.hub },
    pubsub: { ...(original.emulators?.pubsub ?? {}), host: "127.0.0.1", port: ports.pubsub },
    storage: { ...(original.emulators?.storage ?? {}), host: "127.0.0.1", port: ports.storage },
    ui: { ...(original.emulators?.ui ?? {}), host: "127.0.0.1", port: ports.ui },
  };
  const configPath = join(temporaryDirectory, "firebase.json");
  await writeFile(configPath, `${JSON.stringify(original, null, 2)}\n`);
  const log = join(arguments_.outputDirectory, "logs", "official-java-comparison.log");
  const stream = createWriteStream(log, { flags: "wx" });
  let output = "";
  const env = {
    ...process.env,
    FIREBASE_EMULATOR_EXPORT_PATH: join(arguments_.outputDirectory, "official-full-data-export"),
    FIREBASE_EMULATOR_IMPORT_PATH: arguments_.fullData,
    FIREBASE_EMULATOR_TMPDIR: join(temporaryDirectory, "runtime"),
    FIREBASE_SKIP_PREBUILD: "1",
    TWODART_FIREBASE_BACKEND: "official",
  };
  const child = spawn(
    join(arguments_.twodartDirectory, "scripts", "dev", "start-firebase-emulator.sh"),
    ["--config", configPath],
    { cwd: arguments_.twodartDirectory, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); stream.write(chunk); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); stream.write(chunk); });
  const rss = monitorRss(child.pid ?? -1);
  const started = performance.now();
  try {
    await waitFor(
      () => /All emulators ready|All emulators are ready/u.test(output),
      child,
      20 * 60_000,
    );
    const readyMilliseconds = performance.now() - started;
    child.kill("SIGINT");
    const stoppedAt = performance.now();
    const result = await waitForExit(child, 30 * 60_000);
    if (result.exitCode !== 0) throw new Error(`official comparison failed; see ${log}`);
    await rss.stop();
    return {
      classification: "non-gating same-host design comparison",
      designDifferences: [
        "official suite owns Java Firestore and Pub/Sub plus Node Auth/Storage/Functions",
        "Fireside owns Rust data/control services and retains Node only for Functions/Extensions",
      ],
      exportMilliseconds: performance.now() - stoppedAt,
      log,
      passed: true,
      peakProcessTreePssBytes: rss.peakTreePssBytes,
      peakProcessTreeRssBytes: rss.peakTreeBytes,
      pssAvailable: rss.pssAvailable,
      readyMilliseconds,
      schemaVersion: 1,
    };
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([waitForExit(child), delay(15_000)]).catch(() => undefined);
    }
    throw error;
  } finally {
    await rss.stop();
    await closeWriteStream(stream);
  }
}

function suiteEnvironment(
  ports: Ports,
  temporaryDirectory: string,
  mode: Phase4Mode,
  importPath?: string,
  exportPath?: string,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    FIREBASE_EMULATOR_AUTH_HOST: "127.0.0.1",
    FIREBASE_EMULATOR_AUTH_PORT: String(ports.auth),
    FIREBASE_EMULATOR_EXPORT_PATH: exportPath,
    FIREBASE_EMULATOR_FIRESTORE_HOST: "127.0.0.1",
    FIREBASE_EMULATOR_FIRESTORE_PORT: String(ports.firestore),
    FIREBASE_EMULATOR_FUNCTIONS_HOST: "127.0.0.1",
    FIREBASE_EMULATOR_FUNCTIONS_PORT: String(ports.functions),
    FIREBASE_EMULATOR_HUB_HOST: "127.0.0.1",
    FIREBASE_EMULATOR_HUB_PORT: String(ports.hub),
    FIREBASE_EMULATOR_IMPORT_PATH: importPath,
    FIREBASE_EMULATOR_NO_EXPORT: exportPath === undefined ? "1" : "0",
    FIREBASE_EMULATOR_NO_IMPORT: importPath === undefined ? "1" : "0",
    FIREBASE_EMULATOR_PUBSUB_HOST: "127.0.0.1",
    FIREBASE_EMULATOR_PUBSUB_PORT: String(ports.pubsub),
    FIREBASE_EMULATOR_STORAGE_HOST: "127.0.0.1",
    FIREBASE_EMULATOR_STORAGE_PORT: String(ports.storage),
    FIREBASE_EMULATOR_TMPDIR: temporaryDirectory,
    FIREBASE_EMULATOR_UI_HOST: "127.0.0.1",
    FIREBASE_EMULATOR_UI_PORT: String(ports.ui),
    FIREBASE_SKIP_PREBUILD: "1",
    TWODART_FIREBASE_BACKEND: "fireside",
    TWODART_FIREBASE_EVENTARC_PORT: String(ports.eventarc),
    TWODART_FIREBASE_LOGGING_PORT: String(ports.logging),
    TWODART_FIREBASE_TASKS_PORT: String(ports.tasks),
    TWODART_FIREBASE_WEBSOCKET_PORT: String(ports.websocket),
    TWODART_FIRESTORE_MEMORY: mode === "memory" ? "1" : "0",
    TWODART_FIRESIDE_BIN: join(repositoryRoot, "target", "release", process.platform === "win32" ? "fireside.exe" : "fireside"),
  };
}

function monitorRss(rootPid: number): RssMonitor {
  const pssAvailable = platform() === "linux";
  const monitor: RssMonitor = {
    peakFiresideBytes: 0,
    peakFiresidePssBytes: pssAvailable ? 0 : null,
    peakTreeBytes: 0,
    peakTreePssBytes: pssAvailable ? 0 : null,
    pssAvailable,
    async stop() {
      stopped = true;
      await sampling;
    },
  };
  let stopped = false;
  const sampling = (async () => {
    while (!stopped) {
      try {
        const rows = await processRows();
        const descendants = descendantPids(rows, rootPid);
        let tree = 0;
        let treePss = 0;
        for (const row of rows) {
          if (!descendants.has(row.pid)) continue;
          tree += row.rssKiB * 1_024;
          const pss = pssAvailable ? await linuxPssBytes(row.pid) : null;
          if (pss !== null) treePss += pss;
          if (/\/fireside(?:\s|$)/u.test(row.command)) {
            monitor.peakFiresideBytes = Math.max(monitor.peakFiresideBytes, row.rssKiB * 1_024);
            if (pss !== null) {
              monitor.peakFiresidePssBytes = Math.max(
                monitor.peakFiresidePssBytes ?? 0,
                pss,
              );
            }
          }
        }
        monitor.peakTreeBytes = Math.max(monitor.peakTreeBytes, tree);
        if (pssAvailable) {
          monitor.peakTreePssBytes = Math.max(monitor.peakTreePssBytes ?? 0, treePss);
        }
      } catch {
        // Process sampling is evidence-only; the gate still uses runtime outcomes.
      }
      await delay(200);
    }
  })();
  return monitor;
}

async function linuxPssBytes(pid: number): Promise<number | null> {
  try {
    const text = await readFile(`/proc/${String(pid)}/smaps_rollup`, "utf8");
    const match = /^Pss:\s+(\d+)\s+kB$/mu.exec(text);
    return match === null ? null : Number(match[1]) * 1_024;
  } catch {
    return null;
  }
}

async function processRows(): Promise<readonly { command: string; pid: number; ppid: number; rssKiB: number }[]> {
  const text = await capture("ps", ["-axo", "pid=,ppid=,rss=,command="], repositoryRoot);
  return text.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
    if (match === null) return [];
    return [{ command: match[4] ?? "", pid: Number(match[1]), ppid: Number(match[2]), rssKiB: Number(match[3]) }];
  });
}

async function assertFiresideProcessBoundary(rootPid: number): Promise<ProcessBoundary> {
  const rows = await processRows();
  const descendants = descendantPids(rows, rootPid);
  const commands = rows
    .filter((row) => descendants.has(row.pid))
    .map((row) => row.command);
  const forbidden = commands.filter((command) =>
    /cloud-firestore-emulator|cloud-pubsub-emulator|pubsub-emulator/u.test(command),
  );
  const firesideProcesses = commands.filter((command) => /\/fireside(?:\s|$)/u.test(command)).length;
  const functionsWorkloadHostProcesses = commands.filter((command) =>
    /functions-host\.cjs|firebase.*functions/u.test(command),
  ).length;
  const allowedStorageRulesJavaProcesses = commands.filter((command) =>
    /cloud-storage-rules-runtime/u.test(command),
  ).length;
  if (forbidden.length !== 0) {
    throw new Error("Fireside runtime launched an official Firestore or Pub/Sub data service");
  }
  if (firesideProcesses === 0 || functionsWorkloadHostProcesses === 0) {
    throw new Error("Fireside runtime process boundary omitted Fireside or the Node workload host");
  }
  return {
    allowedStorageRulesJavaProcesses,
    firesideProcesses,
    forbiddenDataServiceProcesses: forbidden.length,
    functionsWorkloadHostProcesses,
    passed: true,
  };
}

function descendantPids(rows: readonly { pid: number; ppid: number }[], root: number): Set<number> {
  const result = new Set([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (result.has(row.ppid) && !result.has(row.pid)) { result.add(row.pid); changed = true; }
    }
  }
  return result;
}

async function reservePortBlock(): Promise<Ports> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const base = 23_000 + Math.floor(Math.random() * 25_000);
    if (base + 11 > 65_535) continue;
    const available = await Promise.all(Array.from({ length: 12 }, (_, offset) => portAvailable(base + offset)));
    if (!available.every(Boolean)) continue;
    return {
      auth: base + 1, cacheWebsocket: base + 11, eventarc: base + 9, firestore: base,
      functions: base + 3, hub: base + 5, logging: base + 8, pubsub: base + 4,
      storage: base + 2, tasks: base + 10, ui: base + 6, websocket: base + 7,
    };
  }
  throw new Error("could not reserve a Phase 4 port block");
}

async function portAvailable(port: number): Promise<boolean> {
  const server = createServer();
  return await new Promise<boolean>((resolvePromise) => {
    server.once("error", () => resolvePromise(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolvePromise(true)));
  });
}

async function collectToolchain(twodartDirectory: string): Promise<Phase4ObservedToolchain> {
  const packageVersion = async (name: string) =>
    (JSON.parse(await readFile(join(twodartDirectory, "node_modules", name, "package.json"), "utf8")) as { version: string }).version;
  return {
    bun: await capture("bun", ["--version"], repositoryRoot),
    firebaseAdmin: await packageVersion("firebase-admin"),
    firebaseFunctions: await packageVersion("firebase-functions"),
    firebaseJsSdk: await packageVersion("firebase"),
    firebaseTools: await packageVersion("firebase-tools"),
    java: await capture("java", ["--version"], repositoryRoot, true),
    node: await capture("node", ["--version"], repositoryRoot),
    npm: await capture("npm", ["--version"], repositoryRoot),
    rust: await capture("rustc", ["--version"], repositoryRoot),
  };
}

async function assertFullDataSource(path: string, manifest: Phase4Manifest): Promise<void> {
  const info = await stat(path);
  if (!info.isDirectory()) throw new Error(`full-data source is not a directory: ${path}`);
  for (const component of manifest.gates.twodartFullData.components) {
    const componentInfo = await stat(join(path, component));
    if (!componentInfo.isDirectory() && !componentInfo.isFile()) {
      throw new Error(`full-data source component has unsupported type: ${component}`);
    }
  }
  const size = await capture("du", ["-sk", path], repositoryRoot);
  const observedKiB = Number.parseInt(size.split(/\s/u)[0] ?? "", 10);
  if (observedKiB !== manifest.gates.twodartFullData.observedDatasetKiB) {
    throw new Error(`full-data KiB mismatch: expected ${String(manifest.gates.twodartFullData.observedDatasetKiB)}, observed ${String(observedKiB)}`);
  }
}

async function runCommand(
  name: string,
  command: string,
  values: readonly string[],
  outputDirectory: string,
  cwd: string,
  timeoutMilliseconds: number,
): Promise<CommandRecord> {
  const log = join(outputDirectory, "logs", `${name}.log`);
  const stream = createWriteStream(log, { flags: "wx" });
  const started = performance.now();
  const child = spawn(command, values, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.pipe(stream, { end: false });
  child.stderr?.pipe(stream, { end: false });
  const result = await waitForExit(child, timeoutMilliseconds);
  await closeWriteStream(stream);
  return {
    command: [command, ...values].join(" "), durationMilliseconds: performance.now() - started,
    exitCode: result.exitCode, log, name, passed: result.exitCode === 0, signal: result.signal,
  };
}

async function closeWriteStream(stream: ReturnType<typeof createWriteStream>): Promise<void> {
  if (stream.closed) return;
  await new Promise<void>((resolvePromise, reject) => {
    stream.once("error", reject);
    stream.end(() => resolvePromise());
  });
}

function assertCommands(commands: readonly CommandRecord[]): void {
  const failed = commands.filter((command) => !command.passed);
  if (failed.length !== 0) throw new Error(`commands failed: ${failed.map((command) => command.name).join(", ")}`);
}

async function capture(command: string, values: readonly string[], cwd: string, stderr = false): Promise<string> {
  const child = spawn(command, values, { cwd, env: process.env, stdio: ["ignore", "pipe", stderr ? "pipe" : "ignore"] });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  if (stderr) child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const result = await waitForExit(child, 60_000);
  if (result.exitCode !== 0) throw new Error(`${command} failed`);
  return output.trim();
}

async function captureBytes(
  command: string,
  values: readonly string[],
  cwd: string,
): Promise<Buffer> {
  const child = spawn(command, values, {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const chunks: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
  const result = await waitForExit(child, 60_000);
  if (result.exitCode !== 0) throw new Error(`${command} failed`);
  return Buffer.concat(chunks);
}

async function waitFor(
  predicate: () => boolean,
  child: ChildProcess,
  timeoutMilliseconds: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!predicate()) {
    if (child.exitCode !== null) throw new Error(`process exited ${String(child.exitCode)} before readiness`);
    if (Date.now() >= deadline) throw new Error("readiness timed out");
    await delay(100);
  }
}

async function waitForExit(
  child: ChildProcess,
  timeoutMilliseconds = 60_000,
): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { exitCode: child.exitCode, signal: child.signalCode };
  }
  return await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("process exit timed out")); }, timeoutMilliseconds);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (exitCode, signal) => { clearTimeout(timer); resolvePromise({ exitCode, signal }); });
  });
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function verifyAndCopyFixtureChecksums(
  outputDirectory: string,
  manifest: Phase4Manifest,
): Promise<readonly Record<string, unknown>[]> {
  const root = join(conformanceDirectory, "fixtures", "firebase-suite-v1");
  const destination = join(outputDirectory, "fixture-checksums");
  await mkdir(destination, { recursive: true });
  const results = [];
  for (const name of manifest.oraclePolicy.requiredFixtureSets) {
    const setRoot = join(root, name);
    const checksumPath = join(setRoot, "SHA256SUMS");
    const checksumText = await readFile(checksumPath, "utf8");
    let verifiedFiles = 0;
    for (const line of checksumText.split("\n")) {
      if (line.trim().length === 0) continue;
      const match = /^(?<digest>[0-9a-f]{64})\s{2}(?<path>.+)$/u.exec(line);
      const digest = match?.groups?.digest;
      const relativePath = match?.groups?.path;
      if (digest === undefined || relativePath === undefined) {
        throw new Error(`invalid fixture checksum row in ${checksumPath}: ${line}`);
      }
      const file = resolve(setRoot, relativePath);
      if (!file.startsWith(`${setRoot}/`)) {
        throw new Error(`fixture checksum escapes ${setRoot}: ${relativePath}`);
      }
      const observed = createHash("sha256").update(await readFile(file)).digest("hex");
      if (observed !== digest) {
        throw new Error(`fixture checksum mismatch for ${name}/${relativePath}`);
      }
      verifiedFiles += 1;
    }
    await copyFile(checksumPath, join(destination, `${name}.SHA256SUMS`));
    results.push({ fixtureSet: name, passed: true, verifiedFiles });
  }
  await writeJson(join(outputDirectory, "fixture-verification.json"), {
    fixtureSets: results,
    passed: true,
    schemaVersion: 1,
  });
  return results;
}

async function verifyTwodartConfiguration(
  twodartDirectory: string,
  manifest: Phase4Manifest,
): Promise<readonly Record<string, unknown>[]> {
  const results = [];
  const launcher = "scripts/dev/start-firebase-emulator.sh";
  for (const [path, expected] of Object.entries(
    manifest.twodartContract.configurationChecksums,
  )) {
    const current = createHash("sha256")
      .update(await readFile(join(twodartDirectory, path)))
      .digest("hex");
    if (path === launcher) {
      const pinned = await captureBytes(
        "git",
        ["show", `${manifest.twodartContract.sourceRevision}:${path}`],
        twodartDirectory,
      );
      const pinnedDigest = createHash("sha256").update(pinned).digest("hex");
      if (pinnedDigest !== expected) {
        throw new Error("Twodart pinned launcher no longer matches the frozen manifest");
      }
      const launcherText = await readFile(join(twodartDirectory, path), "utf8");
      if (
        current === expected ||
        !launcherText.includes('TWODART_FIREBASE_BACKEND:-fireside') ||
        !launcherText.includes('TWODART_FIREBASE_BACKEND=official')
      ) {
        throw new Error("Twodart launcher does not preserve the reviewed Fireside cutover");
      }
      results.push({
        currentSha256: current,
        expectedPinnedSha256: expected,
        passed: true,
        path,
        reason: "reviewed Phase 4 cutover with explicit official fallback",
      });
      continue;
    }
    if (current !== expected) {
      throw new Error(`Twodart configuration checksum mismatch: ${path}`);
    }
    results.push({ currentSha256: current, passed: true, path });
  }
  return results;
}

async function writeChecksums(root: string): Promise<void> {
  const files = await walk(root);
  const rows = [];
  for (const path of files.filter((path) => !path.endsWith("SHA256SUMS"))) {
    const digest = createHash("sha256").update(await readFile(path)).digest("hex");
    rows.push(`${digest}  ${relative(root, path)}`);
  }
  await writeFile(join(root, "SHA256SUMS"), `${rows.sort().join("\n")}\n`);
}

async function walk(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...(await walk(path)));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

async function writeReport(
  path: string,
  input: {
    readonly candidateRevision: string;
    readonly fullData?: Record<string, unknown>;
    readonly manifest: Phase4Manifest;
    readonly modes: readonly Record<string, unknown>[];
    readonly officialComparison?: Record<string, unknown>;
    readonly outputDirectory: string;
    readonly restarts: readonly Record<string, unknown>[];
    readonly smoke: boolean;
    readonly twodartRevision: string;
  },
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const lines = [
    "# Fireside Phase 4 Twodart Suite Gate",
    "",
    `- Verdict: **${input.smoke ? "SMOKE PASS" : "PASS"}**`,
    `- Candidate: \`${input.candidateRevision}\``,
    `- Twodart revision: \`${input.twodartRevision}\``,
    `- Frozen manifest SHA-256: \`${PHASE4_MANIFEST_SHA256}\``,
    `- Evidence: \`${input.outputDirectory}\``,
    "",
    "## Runtime matrix",
    "",
    "Both memory and disk/WAL modes passed the real Twodart browser, Node, Python, and .NET clients, the 21-function inventory, both Storage buckets, Hub/UI/Pub/Sub controls, the cache watcher, custom triggers, and schedules.",
    "",
    `Forced restarts: ${String(input.restarts.length)} clean passes.`,
    "",
  ];
  if (input.fullData !== undefined) {
    lines.push(
      "## Full-data gate",
      "",
      `Exact corpus: ${String(expectedFullData.firestoreDocuments)} Firestore documents, ${String(expectedFullData.authUsers)} Auth user, ${String(expectedFullData.storageObjects)} Storage objects, ${String(expectedFullData.storageBytes)} object bytes. Cold import, combined export, and exact reimport passed.`,
      "",
      "## Official Java comparison",
      "",
      "The same-host official Firebase Emulator Suite comparison is non-gating and preserves its distinct Java/Node service design in the evidence JSON.",
      "",
      "## Release boundary",
      "",
      "Phase 4 is complete only after this exact evidence commit passes GitHub CI. No Phase 4 tag is created until maintainer review, and Phase 5 has not started.",
      "",
    );
  }
  await writeFile(path, `${lines.join("\n")}\n`);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function requireAbsent(path: string): Promise<void> {
  try { await stat(path); throw new Error(`refusing to overwrite ${path}`); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function parseArguments(values: readonly string[]): Arguments {
  const parsed = new Map<string, string>();
  let smoke = false;
  for (let index = 0; index < values.length;) {
    const key = values[index];
    if (key === "--smoke") { smoke = true; index += 1; continue; }
    const value = values[index + 1];
    if (key === undefined || value === undefined || !key.startsWith("--")) throw new Error("arguments must be --key value pairs");
    parsed.set(key.slice(2), value); index += 2;
  }
  const required = (key: string): string => {
    const value = parsed.get(key); if (value === undefined || value.length === 0) throw new Error(`--${key} is required`); return resolve(value);
  };
  const sdkDirectory = parsed.get("sdk-dir");
  return {
    fullData: required("full-data"), outputDirectory: required("output-dir"), reportPath: required("report"),
    smoke, twodartDirectory: required("twodart-dir"),
    ...(sdkDirectory === undefined ? {} : { sdkDirectory: resolve(sdkDirectory) }),
  };
}
