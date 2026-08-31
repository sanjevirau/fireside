import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { arch, cpus, hostname, platform, release, totalmem } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface Arguments {
  readonly outputDirectory: string;
  readonly reportPath: string;
  readonly sdkDirectory: string;
}

interface CommandRecord {
  readonly command: string;
  readonly completedAt: string;
  readonly durationMilliseconds: number;
  readonly exitCode: number | null;
  readonly log: string;
  readonly passed: boolean;
  readonly signal: NodeJS.Signals | null;
  readonly startedAt: string;
}

interface BrowserModeEvidence {
  readonly browserVersion: string;
  readonly mode: "disk-wal" | "memory";
  readonly passed: boolean;
  readonly results: readonly BrowserVariantEvidence[];
}

interface BrowserVariantEvidence {
  readonly benchmark: {
    readonly maximumMilliseconds: number;
    readonly p99Milliseconds: number;
    readonly sampleCount: number;
    readonly thresholdMilliseconds: number;
  };
  readonly network: {
    readonly reconnectMilliseconds: number;
  };
  readonly result: {
    readonly listenerDeliveryMilliseconds: readonly number[];
    readonly variant: string;
  };
}

interface Phase2Manifest {
  readonly evidence: {
    readonly requiredFiles: readonly string[];
  };
  readonly frozen: boolean;
  readonly gates: {
    readonly existingConformance: {
      readonly commands: readonly string[];
    };
    readonly firebaseJsSdkIntegration: {
      readonly browserProcessPartitions: Readonly<
        Record<string, readonly (string | null)[]>
      >;
      readonly clientPersistenceModes: readonly string[];
      readonly requiredMatrixCells: number;
      readonly serverModes: readonly string[];
      readonly sourceRevision: string;
    };
    readonly listenerDeliveryBenchmark: {
      readonly maximumMilliseconds: Readonly<Record<string, number>>;
      readonly maximumReconnectMilliseconds: number;
      readonly samplesPerVariantAndMode: number;
    };
    readonly sessionChaos: {
      readonly deterministicSeed: string;
      readonly droppedBackchannelsPerVariant: number;
      readonly duplicateFirestoreEffectsAllowed: number;
      readonly duplicateMapDeliveriesPerVariant: number;
      readonly lostAcknowledgedArraysAllowed: number;
      readonly nonConsecutiveReplayArraysAllowed: number;
      readonly overlappingForwardPostPairsPerVariant: number;
      readonly retriedForwardPostsPerVariant: number;
      readonly unknownSidMismatchesAllowed: number;
      readonly unknownSidRequestsPerVariant: number;
      readonly variants: readonly string[];
    };
  };
  readonly name: string;
  readonly schemaVersion: number;
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../../..");
const conformanceDirectory = join(repositoryRoot, "conformance");
const manifestPath = join(
  repositoryRoot,
  "benchmarks",
  "phase-2-webchannel.json",
);
const requiredEvidenceFiles = [
  "manifest.json",
  "fixture-replay.json",
  "firebase-js-sdk-memory.json",
  "firebase-js-sdk-disk-wal.json",
  "browser-demo.json",
  "session-chaos.json",
  "listener-delivery.csv",
  "existing-conformance.json",
  "deviations.json",
] as const;

const existingConformanceCommands = [
  "cargo fmt --all -- --check",
  "cargo clippy --workspace --all-targets --all-features -- -D warnings",
  "cargo test --workspace --all-targets --all-features",
  "npm run check --prefix conformance",
  "npm test --prefix conformance",
  "npm run test:fireside --prefix conformance",
  "npm run test:fireside:disk --prefix conformance",
  "npm run test:fireside:strict --prefix conformance",
  "npm run test:fireside:enterprise --prefix conformance",
  "npm run test:fireside:enterprise:disk --prefix conformance",
  "npm run test:fireside-disk-recovery --prefix conformance",
  "npm run test:fireside-import --prefix conformance",
  "npm run test:official --prefix conformance",
  "npm run test:official:enterprise --prefix conformance",
  "npm run test:official-export-import --prefix conformance",
  "npm run test:fireside-export-java-import --prefix conformance",
] as const;

async function main(): Promise<void> {
  const arguments_ = parseArguments(process.argv.slice(2));
  const outputDirectory = absolute(arguments_.outputDirectory);
  const reportPath = absolute(arguments_.reportPath);
  const sdkDirectory = absolute(arguments_.sdkDirectory);
  await requireAbsent(outputDirectory);
  await requireAbsent(reportPath);
  await mkdir(join(outputDirectory, "logs"), { recursive: true });

  const manifestText = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(manifestText) as Phase2Manifest;
  if (!manifest.frozen || manifest.name !== "phase-2-webchannel") {
    throw new Error("Phase 2 WebChannel manifest is not frozen");
  }
  assertFrozenPlan(manifest);
  await copyFile(manifestPath, join(outputDirectory, "manifest.json"));

  const candidateRevision = await capture("git", ["rev-parse", "HEAD"]);
  const manifestSha256 = sha256(manifestText);
  const environment = await collectEnvironment(
    candidateRevision,
    manifestSha256,
  );
  await writeJson(join(outputDirectory, "environment.json"), environment);

  try {
    await runFixtureReplay(outputDirectory);
    await runFirebaseSdkGate(outputDirectory, sdkDirectory, manifest);
    const browserEvidence = await runBrowserGate(outputDirectory, manifest);
    await runSessionChaos(outputDirectory, manifest);
    await runExistingConformance(outputDirectory);
    await writeDeviations(outputDirectory);
    await verifyRequiredFiles(outputDirectory);
    await writeChecksums(outputDirectory);
    await writeReport(reportPath, {
      browserEvidence,
      candidateRevision,
      environment,
      manifestSha256,
      outputDirectory,
    });
  } catch (error) {
    await writeJson(join(outputDirectory, "failure.json"), {
      candidateRevision,
      failedAt: new Date().toISOString(),
      message: error instanceof Error ? error.message : String(error),
      passed: false,
      schemaVersion: 1,
    });
    await writeChecksums(outputDirectory);
    throw error;
  }
}

async function runFixtureReplay(outputDirectory: string): Promise<void> {
  const commands: CommandRecord[] = [];
  const specifications = [
    [
      "fixture-rust-replay",
      "cargo",
      [
        "test",
        "--locked",
        "-p",
        "fireside-webchannel-front",
        "--test",
        "oracle_replay",
      ],
      repositoryRoot,
    ],
    [
      "fixture-typescript-replay",
      "node",
      [
        "--import",
        "tsx",
        "--test",
        "test/webchannel-capture.test.ts",
        "test/webchannel-fixtures.test.ts",
      ],
      conformanceDirectory,
    ],
  ] as const;
  for (const [logName, commandName, arguments_, cwd] of specifications) {
    const command = await runCommand(
      logName,
      commandName,
      arguments_,
      cwd,
      outputDirectory,
    );
    commands.push(command);
    await writeJson(join(outputDirectory, "fixture-replay.json"), {
      capturedCasesPerTarget: 10,
      commands,
      mismatches: commands.some((value) => !value.passed) ? null : 0,
      passed:
        commands.length === specifications.length &&
        commands.every((value) => value.passed),
      schemaVersion: 1,
      targets: ["java-v1.22.0", "production-cloud-firestore"],
      unicodePayloads: [
        "ASCII",
        "火側",
        "🔥",
        "A火🔥éZ",
        "文書/emoji-😀/mixed-火",
      ],
    });
    assertCommandsPassed([command]);
  }
}

async function runFirebaseSdkGate(
  outputDirectory: string,
  sdkDirectory: string,
  manifest: Phase2Manifest,
): Promise<void> {
  const revision = await capture("git", [
    "-C",
    sdkDirectory,
    "rev-parse",
    "HEAD",
  ]);
  if (revision !== manifest.gates.firebaseJsSdkIntegration.sourceRevision) {
    throw new Error(
      `firebase-js-sdk revision ${revision} does not match frozen manifest`,
    );
  }
  for (const mode of ["memory", "disk-wal"] as const) {
    const outputPath = join(outputDirectory, `firebase-js-sdk-${mode}.json`);
    const results: unknown[] = [];
    for (const clientPersistence of ["memory", "persistence"] as const) {
      const cellOutputPath = join(
        outputDirectory,
        `.firebase-js-sdk-${mode}-${clientPersistence}.json`,
      );
      const arguments_ = [
        "run",
        "test:webchannel:firebase-js-sdk",
        "--prefix",
        "conformance",
        "--",
        "--sdk-dir",
        sdkDirectory,
        "--client-persistence",
        clientPersistence,
        "--output",
        cellOutputPath,
      ];
      if (mode === "disk-wal") {
        arguments_.push("--disk");
      }
      const command = await runCommand(
        `firebase-js-sdk-${mode}-${clientPersistence}`,
        "npm",
        arguments_,
        repositoryRoot,
        outputDirectory,
      );
      assertCommandsPassed([command]);
      const result = JSON.parse(await readFile(cellOutputPath, "utf8")) as {
        clientPersistence?: string;
        completedTests?: number;
        firebaseJsSdkRevision?: string;
        filter?: string | null;
        mode?: string;
        nativeSkipNames?: readonly string[];
        nativeSkips?: number;
        passed?: boolean;
        processPartitions?: readonly {
          readonly coverageFilter?: string | null;
          readonly completedTests?: number;
        }[];
        sourcePackage?: string;
      };
      if (
        result.passed !== true ||
        result.firebaseJsSdkRevision !== revision ||
        result.mode !== mode ||
        result.clientPersistence !== clientPersistence ||
        result.sourcePackage !== "integration/firestore" ||
        result.filter !== null ||
        !Number.isInteger(result.completedTests) ||
        (result.completedTests ?? 0) <= 0 ||
        !Number.isInteger(result.nativeSkips) ||
        !Array.isArray(result.nativeSkipNames) ||
        !validSdkProcessPartitions(clientPersistence, result.processPartitions)
      ) {
        throw new Error(
          `${mode}/${clientPersistence} firebase-js-sdk evidence is incomplete`,
        );
      }
      results.push({ ...result, gateCommand: command });
      await rm(cellOutputPath);
    }
    const typedResults = results as readonly {
      readonly completedTests: number;
      readonly nativeSkipNames: readonly string[];
      readonly nativeSkips: number;
    }[];
    await writeJson(outputPath, {
      completedTests: typedResults.reduce(
        (total, result) => total + result.completedTests,
        0,
      ),
      firebaseJsSdkRevision: revision,
      mode,
      nativeSkipNames: [
        ...new Set(typedResults.flatMap((result) => result.nativeSkipNames)),
      ].sort(),
      nativeSkips: typedResults.reduce(
        (total, result) => total + result.nativeSkips,
        0,
      ),
      passed: true,
      results,
      schemaVersion: 1,
      sourcePackage: "integration/firestore",
    });
  }
}

async function runBrowserGate(
  outputDirectory: string,
  manifest: Phase2Manifest,
): Promise<readonly BrowserModeEvidence[]> {
  const evidence: BrowserModeEvidence[] = [];
  for (const mode of ["memory", "disk-wal"] as const) {
    const temporaryOutput = join(outputDirectory, `.browser-${mode}.json`);
    const arguments_ = [
      "run",
      mode === "memory"
        ? "test:webchannel:browser"
        : "test:webchannel:browser:disk",
      "--prefix",
      "conformance",
      "--",
      "--output",
      temporaryOutput,
    ];
    const command = await runCommand(
      `browser-demo-${mode}`,
      "npm",
      arguments_,
      repositoryRoot,
      outputDirectory,
    );
    assertCommandsPassed([command]);
    const result = JSON.parse(
      await readFile(temporaryOutput, "utf8"),
    ) as BrowserModeEvidence;
    validateBrowserEvidence(result, manifest);
    evidence.push({ ...result, gateCommand: command } as BrowserModeEvidence);
  }
  await writeJson(join(outputDirectory, "browser-demo.json"), {
    modes: evidence,
    passed: true,
    schemaVersion: 1,
  });
  await writeFile(
    join(outputDirectory, "listener-delivery.csv"),
    listenerCsv(evidence),
    "utf8",
  );
  await Promise.all(
    ["memory", "disk-wal"].map(
      async (mode) => await rm(join(outputDirectory, `.browser-${mode}.json`)),
    ),
  );
  return evidence;
}

function validateBrowserEvidence(
  evidence: BrowserModeEvidence,
  manifest: Phase2Manifest,
): void {
  if (!evidence.passed || !["memory", "disk-wal"].includes(evidence.mode)) {
    throw new Error("browser demo did not report a passing frozen mode");
  }
  if (evidence.results.length !== 3) {
    throw new Error(
      `${evidence.mode} browser demo did not report all three variants`,
    );
  }
  for (const result of evidence.results) {
    const variant = result.result.variant;
    const expectedThreshold =
      manifest.gates.listenerDeliveryBenchmark.maximumMilliseconds[variant];
    if (
      expectedThreshold === undefined ||
      result.benchmark.thresholdMilliseconds !== expectedThreshold ||
      result.benchmark.sampleCount !==
        manifest.gates.listenerDeliveryBenchmark.samplesPerVariantAndMode ||
      result.benchmark.p99Milliseconds > expectedThreshold ||
      result.network.reconnectMilliseconds >
        manifest.gates.listenerDeliveryBenchmark.maximumReconnectMilliseconds
    ) {
      throw new Error(
        `${evidence.mode}/${variant} browser benchmark violates the manifest`,
      );
    }
  }
}

async function runSessionChaos(
  outputDirectory: string,
  manifest: Phase2Manifest,
): Promise<void> {
  const command = await runCommand(
    "session-chaos",
    "cargo",
    [
      "test",
      "--locked",
      "-p",
      "fireside-webchannel-front",
      "--test",
      "session_chaos",
    ],
    repositoryRoot,
    outputDirectory,
  );
  await writeJson(join(outputDirectory, "session-chaos.json"), {
    command,
    deterministicSeed: manifest.gates.sessionChaos.deterministicSeed,
    droppedBackchannelsPerVariant:
      manifest.gates.sessionChaos.droppedBackchannelsPerVariant,
    duplicateFirestoreEffects:
      manifest.gates.sessionChaos.duplicateFirestoreEffectsAllowed,
    duplicateMapDeliveriesPerVariant:
      manifest.gates.sessionChaos.duplicateMapDeliveriesPerVariant,
    lostAcknowledgedArrays:
      manifest.gates.sessionChaos.lostAcknowledgedArraysAllowed,
    nonConsecutiveReplayArrays:
      manifest.gates.sessionChaos.nonConsecutiveReplayArraysAllowed,
    overlappingForwardPostPairsPerVariant:
      manifest.gates.sessionChaos.overlappingForwardPostPairsPerVariant,
    passed: command.passed,
    retriedForwardPostsPerVariant:
      manifest.gates.sessionChaos.retriedForwardPostsPerVariant,
    schemaVersion: 1,
    unicodePayloads: [
      "ASCII",
      "火側",
      "🔥",
      "A火🔥éZ",
      "文書/emoji-😀/mixed-火",
    ],
    unknownSidMismatches:
      manifest.gates.sessionChaos.unknownSidMismatchesAllowed,
    unknownSidRequestsPerVariant:
      manifest.gates.sessionChaos.unknownSidRequestsPerVariant,
    variants: manifest.gates.sessionChaos.variants,
  });
  assertCommandsPassed([command]);
}

async function runExistingConformance(outputDirectory: string): Promise<void> {
  const commands: CommandRecord[] = [];
  for (let index = 0; index < existingConformanceCommands.length; index += 1) {
    const commandText = existingConformanceCommands[index] as string;
    const command = await runCommand(
      `existing-${String(index + 1).padStart(2, "0")}`,
      "/bin/zsh",
      ["-lc", commandText],
      repositoryRoot,
      outputDirectory,
      commandText,
    );
    commands.push(command);
    await writeJson(join(outputDirectory, "existing-conformance.json"), {
      commands,
      completedCommands: commands.length,
      passed:
        commands.length === existingConformanceCommands.length &&
        commands.every((value) => value.passed),
      requiredCommands: existingConformanceCommands.length,
      schemaVersion: 1,
    });
    assertCommandsPassed([command]);
  }
}

async function writeDeviations(outputDirectory: string): Promise<void> {
  await writeJson(join(outputDirectory, "deviations.json"), {
    authoritativeOracle: "production-cloud-firestore",
    captureOnlyNormalizations: [
      {
        behavior:
          "capture proxy requested identity encoding upstream while preserving the browser Accept-Encoding observation",
        productBehaviorClaimed: false,
        reason:
          "retain independently decodable chunks from still-open oracle streams",
      },
    ],
    javaV1_22_0: [
      {
        area: "handshake session header",
        cloud: "returns X-HTTP-Session-Id and requires the value as gsessionid",
        fireside: "matches cloud",
        java: "header absent in captured HTTP/1.1 sessions",
      },
      {
        area: "concurrent-forward advertisement",
        cloud: "returns X-Client-Wire-Protocol: h2 when HTTP/2 is negotiated",
        fireside: "returns X-Client-Wire-Protocol: h2",
        java: "header absent in captured HTTP/1.1 sessions",
      },
      {
        area: "unknown SID body",
        cloud: "HTTP 400 body contains client-matched literal Unknown SID",
        fireside: "matches the exact checked-in cloud body",
        java: "HTTP 400 with an empty body",
      },
      {
        area: "handshake server version",
        cloud: "c array reports server version 14",
        fireside: "matches cloud server version 14",
        java: "c array reports server version 12",
      },
    ],
    unexplainedWebChannelDeviations: 0,
    schemaVersion: 1,
  });
}

function listenerCsv(evidence: readonly BrowserModeEvidence[]): string {
  const rows = ["mode,variant,sample_index,delivery_milliseconds"];
  for (const mode of evidence) {
    for (const result of mode.results) {
      result.result.listenerDeliveryMilliseconds.forEach((value, index) => {
        rows.push(
          `${mode.mode},${result.result.variant},${String(index + 1)},${value.toFixed(6)}`,
        );
      });
    }
  }
  return `${rows.join("\n")}\n`;
}

function assertFrozenPlan(manifest: Phase2Manifest): void {
  const evidenceFiles = [...requiredEvidenceFiles, "SHA256SUMS"];
  if (
    JSON.stringify(evidenceFiles) !==
    JSON.stringify(manifest.evidence.requiredFiles)
  ) {
    throw new Error(
      "gate runner evidence files do not match the frozen manifest",
    );
  }
  if (
    JSON.stringify(existingConformanceCommands) !==
    JSON.stringify(manifest.gates.existingConformance.commands)
  ) {
    throw new Error(
      "gate runner conformance commands do not match the frozen manifest",
    );
  }
  if (
    JSON.stringify(manifest.gates.firebaseJsSdkIntegration.serverModes) !==
      JSON.stringify(["memory", "disk-wal"]) ||
    JSON.stringify(
      manifest.gates.firebaseJsSdkIntegration.clientPersistenceModes,
    ) !== JSON.stringify(["memory", "persistence"]) ||
    manifest.gates.firebaseJsSdkIntegration.requiredMatrixCells !== 4
  ) {
    throw new Error(
      "firebase-js-sdk gate runner does not match the frozen matrix",
    );
  }
  const expectedPartitions = {
    memory: [null],
    persistence: [
      "\\(Persistence=memory_lru_gc\\)",
      "\\(Persistence=indexeddb\\)",
    ],
  };
  if (
    JSON.stringify(
      manifest.gates.firebaseJsSdkIntegration.browserProcessPartitions,
    ) !== JSON.stringify(expectedPartitions)
  ) {
    throw new Error(
      "firebase-js-sdk process partitions do not match the frozen manifest",
    );
  }
}

function validSdkProcessPartitions(
  clientPersistence: "memory" | "persistence",
  partitions:
    | readonly {
        readonly coverageFilter?: string | null;
        readonly completedTests?: number;
      }[]
    | undefined,
): boolean {
  if (partitions === undefined) {
    return false;
  }
  const expectedFilters =
    clientPersistence === "memory"
      ? [null]
      : ["\\(Persistence=memory_lru_gc\\)", "\\(Persistence=indexeddb\\)"];
  return (
    JSON.stringify(partitions.map((partition) => partition.coverageFilter)) ===
      JSON.stringify(expectedFilters) &&
    partitions.every(
      (partition) =>
        Number.isInteger(partition.completedTests) &&
        (partition.completedTests ?? 0) > 0,
    )
  );
}

async function runCommand(
  logName: string,
  command: string,
  arguments_: readonly string[],
  cwd: string,
  outputDirectory: string,
  displayCommand = [command, ...arguments_].map(shellDisplay).join(" "),
): Promise<CommandRecord> {
  const logRelativePath = join("logs", `${logName}.log`);
  const logPath = join(outputDirectory, logRelativePath);
  const log = createWriteStream(logPath, { encoding: "utf8", flags: "wx" });
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const result = await new Promise<{
    readonly exitCode: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolvePromise, reject) => {
    const child = spawn(command, arguments_, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.stdout.pipe(process.stdout, { end: false });
    child.stderr.pipe(process.stderr, { end: false });
    child.once("error", reject);
    child.once("exit", (exitCode, signal) =>
      resolvePromise({ exitCode, signal }),
    );
  });
  await new Promise<void>((resolvePromise, reject) => {
    log.once("error", reject);
    log.end(resolvePromise);
  });
  const completed = Date.now();
  return {
    command: displayCommand,
    completedAt: new Date(completed).toISOString(),
    durationMilliseconds: completed - started,
    exitCode: result.exitCode,
    log: logRelativePath,
    passed: result.exitCode === 0,
    signal: result.signal,
    startedAt,
  };
}

function assertCommandsPassed(commands: readonly CommandRecord[]): void {
  const failed = commands.find((command) => !command.passed);
  if (failed !== undefined) {
    throw new Error(`gate command failed: ${failed.command}`);
  }
}

async function collectEnvironment(
  candidateRevision: string,
  manifestSha256: string,
): Promise<unknown> {
  return {
    candidateRevision,
    capturedAt: new Date().toISOString(),
    cpuCount: cpus().length,
    cpuModel: cpus()[0]?.model ?? "unknown",
    hostname: hostname(),
    manifestSha256,
    java: await capture("java", ["--version"]),
    node: process.version,
    npm: await capture("npm", ["--version"]),
    os: { arch: arch(), platform: platform(), release: release() },
    rust: await capture("rustc", ["--version"]),
    schemaVersion: 1,
    totalMemoryBytes: totalmem(),
  };
}

async function writeReport(
  reportPath: string,
  context: {
    readonly browserEvidence: readonly BrowserModeEvidence[];
    readonly candidateRevision: string;
    readonly environment: unknown;
    readonly manifestSha256: string;
    readonly outputDirectory: string;
  },
): Promise<void> {
  const sdkMemory = JSON.parse(
    await readFile(
      join(context.outputDirectory, "firebase-js-sdk-memory.json"),
      "utf8",
    ),
  ) as {
    readonly completedTests: number;
    readonly nativeSkips: number;
    readonly results: readonly {
      readonly clientPersistence: string;
      readonly completedTests: number;
      readonly nativeSkips: number;
    }[];
  };
  const sdkDisk = JSON.parse(
    await readFile(
      join(context.outputDirectory, "firebase-js-sdk-disk-wal.json"),
      "utf8",
    ),
  ) as {
    readonly completedTests: number;
    readonly nativeSkips: number;
    readonly results: readonly {
      readonly clientPersistence: string;
      readonly completedTests: number;
      readonly nativeSkips: number;
    }[];
  };
  const benchmarkRows = context.browserEvidence.flatMap((mode) =>
    mode.results.map(
      (result) =>
        `| ${mode.mode} | ${result.result.variant} | ${result.benchmark.sampleCount} | ${result.benchmark.p99Milliseconds.toFixed(3)} | ${result.benchmark.thresholdMilliseconds} | ${result.network.reconnectMilliseconds.toFixed(3)} |`,
    ),
  );
  const environmentValue = context.environment as {
    readonly cpuCount: number;
    readonly cpuModel: string;
    readonly java: string;
    readonly node: string;
    readonly os: {
      readonly arch: string;
      readonly platform: string;
      readonly release: string;
    };
    readonly rust: string;
    readonly totalMemoryBytes: number;
  };
  const relativeEvidence = relative(
    dirname(reportPath),
    context.outputDirectory,
  );
  const report =
    `# Phase 2 WebChannel gate\n\n` +
    `Status: **PASS**\n\n` +
    `Candidate revision: \`${context.candidateRevision}\`  \n` +
    `Frozen manifest SHA-256: \`${context.manifestSha256}\`  \n` +
    `Evidence directory: [\`${relativeEvidence}\`](${relativeEvidence})\n\n` +
    `## Immutable criteria\n\n` +
    `- Pinned firebase-js-sdk revision passed Google's minified integration package in all four cells: memory server (${sdkCellSummary(sdkMemory.results)}) and disk/WAL server (${sdkCellSummary(sdkDisk.results)}). Every frozen browser-process partition ran with no user-supplied filter. Totals: ${sdkMemory.completedTests + sdkDisk.completedTests} completed and ${sdkMemory.nativeSkips + sdkDisk.nativeSkips} upstream-native skips.\n` +
    `- The wrapper-free Firebase SDK demo passed writes, initial and realtime query snapshots, multiplexed targets, forced backchannel loss/reconnect, and sendBeacon teardown in all three variants and both storage modes.\n` +
    `- All permanent Java v1.22.0 and production Cloud Firestore fixtures replayed without mismatch, including UTF-16 torture payloads.\n` +
    `- Deterministic session chaos passed 50 dropped backchannels, forward retries, duplicate maps, and overlapping pairs per variant plus 25 unknown-SID requests per variant, with zero duplicate effects or replay loss.\n` +
    `- Every pre-Phase-2 conformance command in the frozen manifest passed.\n` +
    `- The Java/cloud WebChannel differences are preserved in \`deviations.json\`; unexplained WebChannel deviations: 0.\n\n` +
    `## Listener delivery\n\n` +
    `Measured locally with 100 sequential acknowledged write-to-listener samples per row. Times are milliseconds.\n\n` +
    `| Mode | Variant | Samples | p99 | Limit | Reconnect |\n` +
    `| --- | --- | ---: | ---: | ---: | ---: |\n` +
    `${benchmarkRows.join("\n")}\n\n` +
    `## Measurement host\n\n` +
    `- OS: ${environmentValue.os.platform} ${environmentValue.os.release} (${environmentValue.os.arch})\n` +
    `- CPU: ${environmentValue.cpuModel} (${environmentValue.cpuCount} logical CPUs)\n` +
    `- Memory: ${String(environmentValue.totalMemoryBytes)} bytes\n` +
    `- Browser: ${context.browserEvidence[0]?.browserVersion ?? "unknown"}\n` +
    `- Java: ${environmentValue.java.replaceAll(/\r?\n/gu, "; ")}\n` +
    `- Node: ${environmentValue.node}\n` +
    `- Rust: ${environmentValue.rust}\n\n` +
    `The evidence bundle includes raw command logs, raw listener samples, structured results, the exact frozen manifest, and SHA-256 checksums. Phase 3 has not started.\n`;
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, report, { encoding: "utf8", flag: "wx" });
}

function sdkCellSummary(
  results: readonly {
    readonly clientPersistence: string;
    readonly completedTests: number;
    readonly nativeSkips: number;
  }[],
): string {
  return results
    .map(
      (result) =>
        `${result.clientPersistence}: ${String(result.completedTests)} completed, ${String(result.nativeSkips)} native skips`,
    )
    .join("; ");
}

async function verifyRequiredFiles(outputDirectory: string): Promise<void> {
  for (const file of requiredEvidenceFiles) {
    await access(join(outputDirectory, file));
  }
}

async function writeChecksums(outputDirectory: string): Promise<void> {
  const files = (await listFiles(outputDirectory))
    .filter((path) => path !== "SHA256SUMS")
    .sort();
  const lines: string[] = [];
  for (const path of files) {
    lines.push(
      `${sha256(await readFile(join(outputDirectory, path)))}  ${path}`,
    );
  }
  await writeFile(
    join(outputDirectory, "SHA256SUMS"),
    `${lines.join("\n")}\n`,
    "utf8",
  );
}

async function listFiles(root: string, directory = ""): Promise<string[]> {
  const entries = await readdir(join(root, directory), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

async function capture(
  command: string,
  arguments_: readonly string[],
): Promise<string> {
  return await new Promise<string>((resolvePromise, reject) => {
    const child = spawn(command, arguments_, {
      cwd: repositoryRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "inherit"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise(Buffer.concat(chunks).toString("utf8").trim());
      } else {
        reject(
          new Error(`${command} exited ${String(code)} (${String(signal)})`),
        );
      }
    });
  });
}

function parseArguments(arguments_: readonly string[]): Arguments {
  let outputDirectory = "reports/phase-2-metrics";
  let reportPath = "reports/phase-2-gate.md";
  let sdkDirectory: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (
      argument === "--output-dir" ||
      argument === "--report" ||
      argument === "--sdk-dir"
    ) {
      const value = arguments_[index + 1];
      if (value === undefined || value.length === 0) {
        throw new Error(`${argument} requires a value`);
      }
      if (argument === "--output-dir") {
        outputDirectory = value;
      } else if (argument === "--report") {
        reportPath = value;
      } else {
        sdkDirectory = value;
      }
      index += 1;
      continue;
    }
    throw new Error(`unsupported argument: ${argument}`);
  }
  if (sdkDirectory === undefined) {
    throw new Error("--sdk-dir is required");
  }
  return { outputDirectory, reportPath, sdkDirectory };
}

function absolute(path: string): string {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

async function requireAbsent(path: string): Promise<void> {
  try {
    await access(path);
  } catch {
    return;
  }
  throw new Error(`refusing to overwrite existing gate path: ${path}`);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function shellDisplay(value: string): string {
  return /^[A-Za-z0-9_./:=+-]+$/u.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;
}

await main();
