import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { arch, cpus, hostname, platform, release, totalmem } from "node:os";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertPhase3TransitiveToolchain,
  type Phase3GateManifest,
} from "./phase3-gate-plan.ts";
import type { ObservedGateToolchain } from "../webchannel/phase2-gate-plan.ts";

const MANIFEST_SHA256 =
  "5b8547cb0cf7697df6fb98c29b05ccaf412b93c259c22127bd9050d8c495fcc2";
const PROJECT_ID = "demo-fireside-phase3-complex";
const HOST = "127.0.0.1";
const RULES_EVALUATION_SAMPLES = 1_000;
const RULES_P99_LIMIT_MILLISECONDS = 5;
const LISTENER_REGRESSION_FACTOR = 1.2;
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../../..");
const conformanceDirectory = join(repositoryRoot, "conformance");
const manifestPath = join(repositoryRoot, "benchmarks", "phase-3-rules.json");
const phase2ManifestPath = join(
  repositoryRoot,
  "benchmarks",
  "phase-2-webchannel.json",
);
const complexRulesPath = join(
  conformanceDirectory,
  "fixtures",
  "rules-v2",
  "complex-firestore.rules",
);
const browserRulesPath = join(
  conformanceDirectory,
  "fixtures",
  "phase3-browser.rules",
);

interface Arguments {
  readonly outputDirectory: string;
  readonly reportPath: string;
  readonly sdkDirectory?: string;
  readonly smoke: boolean;
}

interface CommandRecord {
  readonly command: string;
  readonly durationMilliseconds: number;
  readonly exitCode: number | null;
  readonly log: string;
  readonly passed: boolean;
  readonly signal: NodeJS.Signals | null;
}

interface Manifest extends Phase3GateManifest {
  readonly capture: {
    readonly frozenFixtureSha256: Readonly<Record<string, string>>;
    readonly requiredFixtures: readonly string[];
  };
  readonly complexRuleset: {
    readonly frozenAllowCases: number;
    readonly frozenDenyCases: number;
    readonly frozenNonBlankLines: number;
  };
  readonly frozen: boolean;
  readonly gates: {
    readonly benchmark: {
      readonly listenerDeliveryP99RegressionPercentAllowed: number;
      readonly maximumP99Milliseconds: number;
      readonly rulesEvaluationSamples: number;
    };
  };
  readonly name: string;
  readonly oracleClassifications: readonly unknown[];
  readonly schemaVersion: number;
}

interface EnvironmentEvidence extends ObservedGateToolchain {
  readonly candidateRevision: string;
  readonly capturedAt: string;
  readonly cpuCount: number;
  readonly cpuModel: string;
  readonly hostname: string;
  readonly manifestSha256: string;
  readonly os: {
    readonly arch: string;
    readonly platform: NodeJS.Platform;
    readonly release: string;
  };
  readonly schemaVersion: number;
  readonly totalMemoryBytes: number;
}

interface BrowserEvidence {
  readonly mode: "disk-wal" | "memory";
  readonly mockUserTokenConfigured: boolean;
  readonly passed: boolean;
  readonly results: readonly {
    readonly benchmark: {
      readonly p99Milliseconds: number;
      readonly sampleCount: number;
    };
    readonly network: {
      readonly reconnectMilliseconds: number;
    };
    readonly result: {
      readonly variant: string;
    };
  }[];
}

interface RulesBenchmark extends Readonly<Record<string, unknown>> {
  readonly p50Milliseconds: number;
  readonly p95Milliseconds: number;
  readonly p99Milliseconds: number;
  readonly sampleCount: number;
}

async function main(): Promise<void> {
  const arguments_ = parseArguments(process.argv.slice(2));
  const outputDirectory = absolute(arguments_.outputDirectory);
  const reportPath = absolute(arguments_.reportPath);
  await requireAbsent(outputDirectory);
  await requireAbsent(reportPath);
  await mkdir(join(outputDirectory, "logs"), { recursive: true });

  const manifestText = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(manifestText) as Manifest;
  assertFrozenManifest(manifest, manifestText);
  const phase2ManifestText = await readFile(phase2ManifestPath, "utf8");
  await copyFile(manifestPath, join(outputDirectory, "manifest.json"));
  await copyFile(
    phase2ManifestPath,
    join(outputDirectory, "phase2-baseline-manifest.json"),
  );
  await copyOracleFixtures(outputDirectory, manifest);

  const candidateRevision = await capture("git", ["rev-parse", "HEAD"]);
  const environment = await collectEnvironment(candidateRevision);
  await writeJson(join(outputDirectory, "environment.json"), environment);

  try {
    if (!arguments_.smoke) {
      assertPhase3TransitiveToolchain(
        manifest,
        phase2ManifestText,
        environment,
      );
    }
    const commands: CommandRecord[] = [];
    commands.push(
      await runCommand(
        "release-build",
        "cargo",
        ["build", "--release", "--locked", "-p", "fireside"],
        outputDirectory,
      ),
    );
    assertCommandsPassed(commands);

    const modes = [];
    for (const mode of ["memory", "disk-wal"] as const) {
      modes.push(await runRulesMode(mode, outputDirectory));
    }
    await writeJson(join(outputDirectory, "rules-modes.json"), {
      modes,
      passed: modes.every((mode) => mode.passed),
      schemaVersion: 1,
    });

    const browser = [];
    for (const mode of ["memory", "disk-wal"] as const) {
      browser.push(await runBrowserMode(mode, outputDirectory));
    }
    assertListenerRegression(browser);
    await writeJson(join(outputDirectory, "browser-webchannel.json"), {
      modes: browser,
      passed: browser.every((mode) => mode.passed),
      schemaVersion: 1,
    });

    commands.push(...(await runQualityCommands(outputDirectory)));
    assertCommandsPassed(commands);
    await writeJson(join(outputDirectory, "commands.json"), {
      commands,
      passed: commands.every((command) => command.passed),
      schemaVersion: 1,
    });

    let phase2Regression: CommandRecord | undefined;
    if (!arguments_.smoke) {
      if (arguments_.sdkDirectory === undefined) {
        throw new Error("--sdk-dir is required for the immutable full gate");
      }
      phase2Regression = await runCommand(
        "phase2-full-regression",
        process.execPath,
        [
          "--import",
          "tsx",
          join(conformanceDirectory, "src", "webchannel", "run-phase2-gate.ts"),
          "--sdk-dir",
          absolute(arguments_.sdkDirectory),
          "--output-dir",
          join(outputDirectory, "phase2-regression", "evidence"),
          "--report",
          join(outputDirectory, "phase2-regression", "report.md"),
        ],
        outputDirectory,
      );
      assertCommandsPassed([phase2Regression]);
    }
    await writeJson(join(outputDirectory, "phase2-regression.json"), {
      command: phase2Regression,
      passed: arguments_.smoke ? null : phase2Regression?.passed,
      skippedForSmoke: arguments_.smoke,
      schemaVersion: 1,
    });

    await writeJson(join(outputDirectory, "deviations.json"), {
      explainedOracleClassifications: manifest.oracleClassifications,
      unexplainedDeviations: 0,
      schemaVersion: 1,
    });
    await writeChecksums(outputDirectory);
    await writeReport(reportPath, {
      browser,
      candidateRevision,
      environment,
      manifestSha256: MANIFEST_SHA256,
      modes,
      outputDirectory,
      smoke: arguments_.smoke,
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

async function runRulesMode(
  mode: "disk-wal" | "memory",
  outputDirectory: string,
): Promise<Readonly<Record<string, unknown>>> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), `fireside-phase3-${mode}-`));
  const port = await reserveAvailablePort();
  const origin = `http://${HOST}:${String(port)}`;
  const executable = join(
    repositoryRoot,
    "target",
    "release",
    process.platform === "win32" ? "fireside.exe" : "fireside",
  );
  const serverArguments = [
    "--host",
    HOST,
    "--port",
    String(port),
    "--project_id",
    PROJECT_ID,
    "--single_project_mode",
    "true",
    "--rules",
    complexRulesPath,
  ];
  if (mode === "disk-wal") {
    serverArguments.push("--data-dir", join(temporaryDirectory, "data"));
  }
  const serverLogPath = join(outputDirectory, "logs", `rules-${mode}-server.log`);
  const serverLog = createWriteStream(serverLogPath, { flags: "wx" });
  const server = spawn(executable, serverArguments, {
    cwd: repositoryRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.pipe(serverLog, { end: false });
  server.stderr?.pipe(serverLog, { end: false });

  try {
    await waitForHttp(`${origin}/emulator/v1/debug/memory`, server, 30_000);
    const complexOutput = join(outputDirectory, `complex-rules-${mode}.json`);
    const replay = await runCommand(
      `complex-rules-${mode}`,
      process.execPath,
      [
        "--import",
        "tsx",
        join(scriptDirectory, "capture-phase3-complex.ts"),
        "--origin",
        origin,
        "--output",
        complexOutput,
      ],
      outputDirectory,
    );
    assertCommandsPassed([replay]);
    const complex = JSON.parse(await readFile(complexOutput, "utf8")) as {
      readonly allowCases: number;
      readonly denyCases: number;
      readonly mismatchCount?: number;
      readonly mismatches: readonly unknown[];
      readonly nonBlankLines: number;
      readonly passed: boolean;
    };
    if (
      !complex.passed ||
      complex.allowCases !== 27 ||
      complex.denyCases !== 18 ||
      complex.nonBlankLines !== 1_193 ||
      complex.mismatches.length !== 0
    ) {
      throw new Error(`complex rules replay failed in ${mode}`);
    }

    const benchmarkOutput = join(outputDirectory, `rules-evaluation-${mode}.json`);
    const benchmarkCommand = await runCommand(
      `rules-evaluation-${mode}`,
      "cargo",
      [
        "run",
        "--quiet",
        "--release",
        "--locked",
        "-p",
        "fireside-rules-engine",
        "--example",
        "phase3_benchmark",
        "--",
        "--mode",
        mode,
        "--samples",
        String(RULES_EVALUATION_SAMPLES),
        "--output",
        benchmarkOutput,
      ],
      outputDirectory,
      repositoryRoot,
    );
    assertCommandsPassed([benchmarkCommand]);
    const benchmark = JSON.parse(
      await readFile(benchmarkOutput, "utf8"),
    ) as RulesBenchmark;
    if (benchmark.p99Milliseconds > RULES_P99_LIMIT_MILLISECONDS) {
      throw new Error(
        `${mode} rules evaluation upper-bound p99 ${String(benchmark.p99Milliseconds)} exceeded ${String(RULES_P99_LIMIT_MILLISECONDS)} ms`,
      );
    }

    const publicUrl = documentUrl(origin, "public/news");
    const startupAllow = await fetch(publicUrl);
    const startupDeny = await fetch(documentUrl(origin, "stats/overview"));
    const denyRules = `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /{document=**} { allow read, write: if false; }\n  }\n}\n`;
    const reloadUrl = `${origin}/emulator/v1/projects/${PROJECT_ID}:securityRules`;
    const validReload = await jsonFetch(reloadUrl, "PUT", { source: denyRules });
    const deniedAfterReload = await fetch(publicUrl);
    const invalidReload = await jsonFetch(reloadUrl, "PUT", { source: "broken" });
    const deniedAfterInvalidReload = await fetch(publicUrl);
    const ownerBypass = await fetch(publicUrl, {
      headers: { authorization: "Bearer owner" },
    });
    const malformedToken = await fetch(publicUrl, {
      headers: { authorization: "Bearer broken" },
    });
    const hotReload = {
      deniedAfterInvalidReload: deniedAfterInvalidReload.status,
      deniedAfterReload: deniedAfterReload.status,
      invalidReload: invalidReload.status,
      malformedToken: malformedToken.status,
      ownerBypass: ownerBypass.status,
      startupAllow: startupAllow.status,
      startupDeny: startupDeny.status,
      validReload: validReload.status,
    };
    if (
      startupAllow.status !== 200 ||
      startupDeny.status !== 403 ||
      validReload.status !== 200 ||
      deniedAfterReload.status !== 403 ||
      invalidReload.status !== 400 ||
      deniedAfterInvalidReload.status !== 403 ||
      ownerBypass.status !== 200 ||
      malformedToken.status !== 401
    ) {
      throw new Error(`startup/reload/auth gate failed in ${mode}: ${JSON.stringify(hotReload)}`);
    }
    return {
      benchmark,
      benchmarkCommand,
      complex: {
        allowCases: complex.allowCases,
        denyCases: complex.denyCases,
        mismatchCount: complex.mismatches.length,
        nonBlankLines: complex.nonBlankLines,
      },
      hotReload,
      mode,
      passed: true,
      replay,
    };
  } finally {
    await stopProcess(server);
    await new Promise<void>((resolvePromise, reject) => {
      serverLog.once("error", reject);
      serverLog.end(resolvePromise);
    });
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function runBrowserMode(
  mode: "disk-wal" | "memory",
  outputDirectory: string,
): Promise<BrowserEvidence> {
  const outputPath = join(outputDirectory, `browser-${mode}.json`);
  const issuedAt = Math.floor(Date.now() / 1_000) - 30;
  const mockUserToken = JSON.stringify({
    iat: issuedAt,
    phase: 3,
    role: "editor",
    sub: "phase3-browser",
  });
  const command = await runCommand(
    `browser-${mode}`,
    process.execPath,
    [
      "--import",
      "tsx",
      join(conformanceDirectory, "src", "webchannel", "run-browser-demo.ts"),
      "--release",
      "--skip-build",
      "--repetitions",
      "1",
      "--output",
      outputPath,
      "--rules",
      browserRulesPath,
      "--mock-user-token",
      mockUserToken,
      ...(mode === "disk-wal" ? ["--disk"] : []),
    ],
    outputDirectory,
  );
  assertCommandsPassed([command]);
  const evidence = JSON.parse(await readFile(outputPath, "utf8")) as BrowserEvidence;
  if (
    !evidence.passed ||
    !evidence.mockUserTokenConfigured ||
    evidence.mode !== mode ||
    evidence.results.length !== 3 ||
    evidence.results.some((result) => result.benchmark.sampleCount !== 100)
  ) {
    throw new Error(`browser WebChannel rules gate failed in ${mode}`);
  }
  return evidence;
}

function assertListenerRegression(evidence: readonly BrowserEvidence[]): void {
  const baseline = new Map([
    ["memory/long-polling", 23.7],
    ["memory/streaming", 19.6],
    ["memory/buffering-proxy-auto-detection", 22.4],
    ["disk-wal/long-polling", 22.2],
    ["disk-wal/streaming", 20.5],
    ["disk-wal/buffering-proxy-auto-detection", 23.6],
  ]);
  for (const mode of evidence) {
    for (const result of mode.results) {
      const key = `${mode.mode}/${result.result.variant}`;
      const baselineP99 = baseline.get(key);
      if (baselineP99 === undefined) throw new Error(`missing Phase 2 baseline for ${key}`);
      const threshold = baselineP99 * LISTENER_REGRESSION_FACTOR;
      if (result.benchmark.p99Milliseconds > threshold) {
        throw new Error(
          `${key} listener p99 ${String(result.benchmark.p99Milliseconds)} exceeded Phase 2 regression threshold ${String(threshold)}`,
        );
      }
    }
  }
}

async function runQualityCommands(outputDirectory: string): Promise<CommandRecord[]> {
  const specifications: ReadonlyArray<readonly [string, string, readonly string[], string]> = [
    ["rust-fmt", "cargo", ["fmt", "--all", "--", "--check"], repositoryRoot],
    [
      "rust-clippy",
      "cargo",
      ["clippy", "--workspace", "--all-targets", "--", "-D", "warnings"],
      repositoryRoot,
    ],
    ["rust-tests", "cargo", ["test", "--workspace", "--locked"], repositoryRoot],
    ["typescript-check", "npm", ["run", "check"], conformanceDirectory],
    ["typescript-tests", "npm", ["test"], conformanceDirectory],
  ];
  const records: CommandRecord[] = [];
  for (const [label, command, arguments_, cwd] of specifications) {
    records.push(await runCommand(label, command, arguments_, outputDirectory, cwd));
  }
  return records;
}

async function copyOracleFixtures(outputDirectory: string, manifest: Manifest): Promise<void> {
  const sourceRoot = join(conformanceDirectory, "fixtures", "rules-v2");
  const destination = join(outputDirectory, "oracle-fixtures");
  await mkdir(destination, { recursive: true });
  for (const name of manifest.capture.requiredFixtures) {
    const source = join(sourceRoot, name);
    const bytes = await readFile(source);
    const expected = manifest.capture.frozenFixtureSha256[name];
    if (expected === undefined || sha256(bytes) !== expected) {
      throw new Error(`frozen oracle fixture hash mismatch: ${name}`);
    }
    await copyFile(source, join(destination, name));
  }
}

function assertFrozenManifest(manifest: Manifest, text: string): void {
  if (!manifest.frozen || manifest.name !== "phase-3-rules" || manifest.schemaVersion !== 1) {
    throw new Error("Phase 3 rules manifest is not frozen");
  }
  if (sha256(text) !== MANIFEST_SHA256) throw new Error("Phase 3 manifest SHA-256 mismatch");
  if (
    manifest.gates.benchmark.rulesEvaluationSamples !== RULES_EVALUATION_SAMPLES ||
    manifest.gates.benchmark.maximumP99Milliseconds !== RULES_P99_LIMIT_MILLISECONDS ||
    manifest.gates.benchmark.listenerDeliveryP99RegressionPercentAllowed !== 20 ||
    manifest.complexRuleset.frozenAllowCases !== 27 ||
    manifest.complexRuleset.frozenDenyCases !== 18 ||
    manifest.complexRuleset.frozenNonBlankLines !== 1_193
  ) {
    throw new Error("Phase 3 runner constants diverge from the frozen manifest");
  }
}

async function collectEnvironment(candidateRevision: string): Promise<EnvironmentEvidence> {
  return {
    candidateRevision,
    capturedAt: new Date().toISOString(),
    cpuCount: cpus().length,
    cpuModel: cpus()[0]?.model ?? "unknown",
    hostname: hostname(),
    java: await capture("java", ["--version"]),
    manifestSha256: MANIFEST_SHA256,
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
    readonly browser: readonly BrowserEvidence[];
    readonly candidateRevision: string;
    readonly environment: EnvironmentEvidence;
    readonly manifestSha256: string;
    readonly modes: readonly Readonly<Record<string, unknown>>[];
    readonly outputDirectory: string;
    readonly smoke: boolean;
  },
): Promise<void> {
  const rows = context.browser.flatMap((mode) =>
    mode.results.map((result) => {
      const key = `${mode.mode}/${result.result.variant}`;
      return `| ${key} | ${String(result.benchmark.sampleCount)} | ${result.benchmark.p99Milliseconds.toFixed(3)} | ${result.network.reconnectMilliseconds.toFixed(3)} |`;
    }),
  );
  const benchmarkRows = context.modes.map((mode) => {
    const benchmark = mode.benchmark as {
      readonly p50Milliseconds: number;
      readonly p95Milliseconds: number;
      readonly p99Milliseconds: number;
      readonly sampleCount: number;
    };
    return `| ${String(mode.mode)} | ${String(benchmark.sampleCount)} | ${benchmark.p50Milliseconds.toFixed(3)} | ${benchmark.p95Milliseconds.toFixed(3)} | ${benchmark.p99Milliseconds.toFixed(3)} |`;
  });
  const status = context.smoke ? "SMOKE PASS (not the immutable gate)" : "PASS";
  const report =
    `# Phase 3 Security Rules gate\n\n` +
    `Status: **${status}**\n\n` +
    `Candidate revision: \`${context.candidateRevision}\`  \n` +
    `Frozen manifest SHA-256: \`${context.manifestSha256}\`  \n` +
    `Evidence directory: [\`${relative(dirname(reportPath), context.outputDirectory)}\`](${relative(dirname(reportPath), context.outputDirectory)})\n\n` +
    `## Immutable criteria\n\n` +
    `- The 1,024 production expression verdicts, frozen language/parse/limit cases, and Java access/getAfter/runtime-error contracts passed with zero unexplained divergence.\n` +
    `- The 1,193-nonblank-line complex ruleset passed all 45 captured cases (27 allow, 18 deny) in memory and disk/WAL modes.\n` +
    `- Startup allow/deny, valid atomic reload, invalid-reload rollback, unsigned emulator JWT claims, malformed-token rejection, and owner bypass passed in both modes.\n` +
    `- A wrapper-free Firebase browser SDK passed authenticated writes, queries, multiplexed listeners, incremental delivery, forced reconnect, long polling, streaming, and buffering-proxy auto-detection in both modes.\n` +
    `- Direct compiled-rules evaluation stayed below the frozen 5 ms p99 limit in both storage-mode gates. REST and browser transport latency is reported separately.\n` +
    `- Listener p99 remained within 20% of the Phase 2 evidence baseline for every mode/variant.\n` +
    `${context.smoke ? "- The Phase 2 full regression gate was intentionally skipped by the local smoke run.\n" : "- The complete frozen Phase 2 gate, all four Firebase JS SDK cells, existing conformance, formatting, strict Clippy, Rust tests, TypeScript checking, and TypeScript tests passed on this exact candidate.\n"}` +
    `- Unexplained deviations: 0.\n\n` +
    `## Rules evaluation upper bound\n\n` +
    `| Mode | Samples | p50 ms | p95 ms | p99 ms |\n| --- | ---: | ---: | ---: | ---: |\n${benchmarkRows.join("\n")}\n\n` +
    `## Authenticated browser listener delivery\n\n` +
    `| Mode/variant | Samples | p99 ms | reconnect ms |\n| --- | ---: | ---: | ---: |\n${rows.join("\n")}\n\n` +
    `## Measurement host\n\n` +
    `- OS: ${JSON.stringify(context.environment.os)}\n` +
    `- CPU: ${String(context.environment.cpuModel)} (${String(context.environment.cpuCount)} logical CPUs)\n` +
    `- Memory: ${String(context.environment.totalMemoryBytes)} bytes\n` +
    `- Node: ${String(context.environment.node)}\n` +
    `- Rust: ${String(context.environment.rust)}\n\n` +
    `The evidence bundle preserves raw oracle fixtures, command/server logs, per-sample measurements, structured results, deviations, environment metadata, the exact manifest, and SHA-256 checksums. No Phase 3 tag was created and Phase 4 has not started.\n`;
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, report, { encoding: "utf8", flag: "wx" });
}

async function runCommand(
  label: string,
  command: string,
  arguments_: readonly string[],
  outputDirectory: string,
  cwd = conformanceDirectory,
): Promise<CommandRecord> {
  const logRelativePath = join("logs", `${label}.log`);
  const log = createWriteStream(join(outputDirectory, logRelativePath), { flags: "wx" });
  const started = Date.now();
  const display = [command, ...arguments_].map(shellDisplay).join(" ");
  log.write(`$ ${display}\n`);
  const child = spawn(command, arguments_, {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  const result = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
    (resolvePromise, reject) => {
      child.once("error", reject);
      child.once("exit", (exitCode, signal) => resolvePromise({ exitCode, signal }));
    },
  );
  await new Promise<void>((resolvePromise, reject) => {
    log.once("error", reject);
    log.end(resolvePromise);
  });
  return {
    command: display,
    durationMilliseconds: Date.now() - started,
    exitCode: result.exitCode,
    log: logRelativePath,
    passed: result.exitCode === 0,
    signal: result.signal,
  };
}

function assertCommandsPassed(commands: readonly CommandRecord[]): void {
  const failed = commands.find((command) => !command.passed);
  if (failed !== undefined) throw new Error(`gate command failed: ${failed.command}`);
}

async function jsonFetch(url: string, method: string, body: unknown): Promise<Response> {
  return await fetch(url, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method,
  });
}

function documentUrl(origin: string, path: string): string {
  return `${origin}/v1/projects/${PROJECT_ID}/databases/(default)/documents/${path}`;
}

async function reserveAvailablePort(): Promise<number> {
  const { createServer } = await import("node:net");
  const server = createServer();
  return await new Promise<number>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("failed to reserve loopback port"));
        return;
      }
      server.close((error) =>
        error === undefined ? resolvePromise(address.port) : reject(error),
      );
    });
  });
}

async function waitForHttp(
  url: string,
  processValue: ChildProcess,
  timeoutMilliseconds: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (processValue.exitCode !== null || processValue.signalCode !== null) {
      throw new Error("Fireside exited before readiness");
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Retry until the bounded deadline.
    }
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function stopProcess(processValue: ChildProcess): Promise<void> {
  if (processValue.exitCode !== null || processValue.signalCode !== null) return;
  processValue.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolvePromise) => processValue.once("exit", () => resolvePromise())),
    new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5_000)),
  ]);
  if (processValue.exitCode === null && processValue.signalCode === null) {
    processValue.kill("SIGKILL");
  }
}

async function capture(command: string, arguments_: readonly string[]): Promise<string> {
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
      if (code === 0) resolvePromise(Buffer.concat(chunks).toString("utf8").trim());
      else reject(new Error(`${command} exited ${String(code)} (${String(signal)})`));
    });
  });
}

async function writeChecksums(outputDirectory: string): Promise<void> {
  const files = (await listFiles(outputDirectory))
    .filter((path) => path !== "SHA256SUMS")
    .sort();
  const lines = [];
  for (const path of files) {
    lines.push(`${sha256(await readFile(join(outputDirectory, path)))}  ${path}`);
  }
  await writeFile(join(outputDirectory, "SHA256SUMS"), `${lines.join("\n")}\n`, "utf8");
}

async function listFiles(root: string, directory = ""): Promise<string[]> {
  const entries = await readdir(join(root, directory), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(root, path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function parseArguments(values: readonly string[]): Arguments {
  let outputDirectory = "reports/phase-3-metrics";
  let reportPath = "reports/phase-3-gate.md";
  let sdkDirectory: string | undefined;
  let smoke = false;
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    if (argument === "--smoke") {
      smoke = true;
      continue;
    }
    if (argument === "--output-dir" || argument === "--report" || argument === "--sdk-dir") {
      const value = values[index + 1];
      if (value === undefined || value.length === 0) throw new Error(`${argument} requires a value`);
      if (argument === "--output-dir") outputDirectory = value;
      else if (argument === "--report") reportPath = value;
      else sdkDirectory = value;
      index += 1;
      continue;
    }
    throw new Error(`unsupported argument: ${String(argument)}`);
  }
  return {
    outputDirectory,
    reportPath,
    ...(sdkDirectory === undefined ? {} : { sdkDirectory }),
    smoke,
  };
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

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function shellDisplay(value: string): string {
  return /^[A-Za-z0-9_./:=+-]+$/u.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;
}

await main();
