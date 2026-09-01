import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { cpus, hostname, platform, release, totalmem } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MANIFEST_NAME = "phase-2-java-webchannel-comparison";
const MANIFEST_PATH = "benchmarks/phase-2-java-webchannel-comparison.json";
const PHASE2_PRODUCT_REVISION = "eee62330308dd8c1e1965fca9a1f094d582f72c5";
const JAVA_JAR_SHA256 =
  "9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c";
const VARIANTS = [
  "long-polling",
  "streaming",
  "buffering-proxy-auto-detection",
] as const;
type Target = "fireside" | "java";
type Variant = (typeof VARIANTS)[number];

interface ComparisonManifest {
  readonly frozen: boolean;
  readonly name: string;
  readonly phase2: {
    readonly manifest: string;
    readonly manifestSha256: string;
  };
  readonly toolchain: {
    readonly java: string;
    readonly node: string;
    readonly npm: string;
    readonly rust: string;
  };
  readonly venue: {
    readonly host: string;
    readonly logicalCpus: number;
    readonly memoryBytes: number;
  };
  readonly workload: {
    readonly listenerSamplesPerVariantPerRepetition: number;
    readonly measuredRepetitionsPerBlock: number;
    readonly targetBlockOrder: readonly Target[];
    readonly totalListenerSamplesPerTargetAndVariant: number;
    readonly totalReconnectSamplesPerTargetAndVariant: number;
    readonly variants: readonly Variant[];
    readonly warmupRepetitionsPerBlock: number;
  };
}

interface EnvironmentEvidence {
  readonly capturedAt: string;
  readonly cpu: string;
  readonly hostname: string;
  readonly java: string;
  readonly javaJar: string;
  readonly javaJarSha256: string;
  readonly logicalCpus: number;
  readonly manifestSha256: string;
  readonly node: string;
  readonly npm: string;
  readonly os: string;
  readonly repositoryRevision: string;
  readonly rust: string;
  readonly totalMemoryBytes: number;
}

interface DemoRun {
  readonly browserVersion: string;
  readonly completedAt: string;
  readonly passed: boolean;
  readonly repetitions: number;
  readonly resources: {
    readonly peakRssBytes?: number;
    readonly peakVmHwmBytes?: number;
    readonly sampleCount: number;
    readonly supported: boolean;
  };
  readonly results: ReadonlyArray<{
    readonly network: { readonly reconnectMilliseconds?: number };
    readonly repetition: number;
    readonly result: {
      readonly listenerDeliveryMilliseconds: readonly number[];
      readonly variant: Variant;
    };
  }>;
  readonly target: Target;
  readonly warmupRepetitions: number;
}

interface Distribution {
  readonly maximum: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly samples: number;
}

async function main(): Promise<void> {
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const repositoryRoot = resolve(scriptDirectory, "../../..");
  const outputDirectory = resolve(
    repositoryRoot,
    argumentValue("--output-dir") ?? "reports/phase-2-java-webchannel-comparison/latest",
  );
  const reportPath = resolve(
    repositoryRoot,
    argumentValue("--report") ?? "reports/phase-2-java-webchannel-comparison.md",
  );
  await assertAbsent(outputDirectory);
  await mkdir(join(outputDirectory, "runs"), { recursive: true });
  await mkdir(join(outputDirectory, "logs"), { recursive: true });

  const manifestSource = join(repositoryRoot, MANIFEST_PATH);
  const manifestText = await readFile(manifestSource, "utf8");
  const manifest = JSON.parse(manifestText) as ComparisonManifest;
  validateManifest(manifest);
  await assertPhase2Manifest(repositoryRoot, manifest);
  await assertProductSourceUnchanged(repositoryRoot);
  await copyFile(manifestSource, join(outputDirectory, "manifest.json"));

  const environment = await collectEnvironment(repositoryRoot, manifestText);
  validateEnvironment(environment, manifest);
  await writeJson(join(outputDirectory, "environment.json"), environment);
  await runCommand("cargo", ["build", "--locked", "-p", "fireside", "--release"], {
    cwd: repositoryRoot,
  });

  const runs: Array<{ block: number; run: DemoRun; target: Target }> = [];
  for (const [index, target] of manifest.workload.targetBlockOrder.entries()) {
    const block = index + 1;
    const stem = `${String(block).padStart(2, "0")}-${target}`;
    const runPath = join(outputDirectory, "runs", `${stem}.json`);
    const logPath = join(outputDirectory, "logs", `${stem}.log`);
    const commandArguments = [
      "--import",
      "tsx",
      "src/webchannel/run-browser-demo.ts",
      "--target",
      target,
      "--release",
      "--skip-build",
      "--warmup-repetitions",
      String(manifest.workload.warmupRepetitionsPerBlock),
      "--repetitions",
      String(manifest.workload.measuredRepetitionsPerBlock),
      "--output",
      runPath,
    ];
    const result = await runCommandCapture("node", commandArguments, {
      cwd: join(repositoryRoot, "conformance"),
    });
    await writeFile(
      logPath,
      [
        `$ node ${commandArguments.join(" ")}`,
        `exit_code=${String(result.exitCode)}`,
        "",
        result.output,
      ].join("\n"),
      "utf8",
    );
    if (result.exitCode !== 0) {
      await writeChecksums(outputDirectory);
      throw new Error(`${stem} comparison block failed; evidence preserved at ${outputDirectory}`);
    }
    const run = JSON.parse(await readFile(runPath, "utf8")) as DemoRun;
    validateRun(run, target, manifest);
    runs.push({ block, run, target });
  }

  const listenerRows = [
    "target,block,variant,repetition,sample_index,milliseconds",
  ];
  const reconnectRows = ["target,block,variant,repetition,milliseconds"];
  const listenerByTarget = new Map<string, number[]>();
  const reconnectByTarget = new Map<string, number[]>();
  for (const { block, run, target } of runs) {
    for (const result of run.results) {
      const variant = result.result.variant;
      const key = `${target}:${variant}`;
      const listenerValues = listenerByTarget.get(key) ?? [];
      for (const [sampleIndex, milliseconds] of
        result.result.listenerDeliveryMilliseconds.entries()) {
        listenerValues.push(milliseconds);
        listenerRows.push(
          [target, block, variant, result.repetition, sampleIndex + 1, milliseconds]
            .map(String)
            .join(","),
        );
      }
      listenerByTarget.set(key, listenerValues);
      const reconnectMilliseconds = result.network.reconnectMilliseconds;
      if (reconnectMilliseconds === undefined || !Number.isFinite(reconnectMilliseconds)) {
        throw new Error(`${key} repetition ${String(result.repetition)} has no reconnect sample`);
      }
      const reconnectValues = reconnectByTarget.get(key) ?? [];
      reconnectValues.push(reconnectMilliseconds);
      reconnectByTarget.set(key, reconnectValues);
      reconnectRows.push(
        [target, block, variant, result.repetition, reconnectMilliseconds]
          .map(String)
          .join(","),
      );
    }
  }
  await writeFile(
    join(outputDirectory, "listener-delivery.csv"),
    `${listenerRows.join("\n")}\n`,
    "utf8",
  );
  await writeFile(
    join(outputDirectory, "reconnect.csv"),
    `${reconnectRows.join("\n")}\n`,
    "utf8",
  );

  const targets = Object.fromEntries(
    (["fireside", "java"] as const).map((target) => {
      const listener = Object.fromEntries(
        VARIANTS.map((variant) => {
          const values = listenerByTarget.get(`${target}:${variant}`) ?? [];
          assertSampleCount(
            `${target}:${variant} listener`,
            values,
            manifest.workload.totalListenerSamplesPerTargetAndVariant,
          );
          return [variant, distribution(values)];
        }),
      );
      const reconnect = Object.fromEntries(
        VARIANTS.map((variant) => {
          const values = reconnectByTarget.get(`${target}:${variant}`) ?? [];
          assertSampleCount(
            `${target}:${variant} reconnect`,
            values,
            manifest.workload.totalReconnectSamplesPerTargetAndVariant,
          );
          return [variant, distribution(values)];
        }),
      );
      const targetRuns = runs.filter((candidate) => candidate.target === target);
      return [
        target,
        {
          listener,
          reconnect,
          resources: {
            peakRssBytes: Math.max(
              ...targetRuns.map(({ run }) => run.resources.peakRssBytes ?? 0),
            ),
            peakVmHwmBytes: Math.max(
              ...targetRuns.map(({ run }) => run.resources.peakVmHwmBytes ?? 0),
            ),
            samples: targetRuns.reduce(
              (sum, { run }) => sum + run.resources.sampleCount,
              0,
            ),
            supported: targetRuns.every(({ run }) => run.resources.supported),
          },
        },
      ];
    }),
  ) as Record<
    Target,
    {
      listener: Record<Variant, Distribution>;
      reconnect: Record<Variant, Distribution>;
      resources: {
        peakRssBytes: number;
        peakVmHwmBytes: number;
        samples: number;
        supported: boolean;
      };
    }
  >;

  const ratios = Object.fromEntries(
    VARIANTS.map((variant) => [
      variant,
      {
        listenerP50FiresideOverJava:
          targets.fireside.listener[variant].p50 / targets.java.listener[variant].p50,
        listenerP95FiresideOverJava:
          targets.fireside.listener[variant].p95 / targets.java.listener[variant].p95,
        listenerP99FiresideOverJava:
          targets.fireside.listener[variant].p99 / targets.java.listener[variant].p99,
        reconnectP50FiresideOverJava:
          targets.fireside.reconnect[variant].p50 / targets.java.reconnect[variant].p50,
      },
    ]),
  );
  const summary = {
    completedAt: new Date().toISOString(),
    manifestSha256: sha256(manifestText),
    passed: true,
    ratios,
    runs: runs.map(({ block, run, target }) => ({
      block,
      browserVersion: run.browserVersion,
      completedAt: run.completedAt,
      resources: run.resources,
      target,
    })),
    schemaVersion: 1,
    targets,
  };
  await writeJson(join(outputDirectory, "summary.json"), summary);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(
    reportPath,
    reportMarkdown(summary, environment, outputDirectory, repositoryRoot),
    "utf8",
  );
  await writeChecksums(outputDirectory);
  process.stdout.write(`${JSON.stringify({ outputDirectory, reportPath, summary }, null, 2)}\n`);
}

function validateManifest(manifest: ComparisonManifest): void {
  if (!manifest.frozen || manifest.name !== MANIFEST_NAME) {
    throw new Error("comparison manifest is not the frozen expected manifest");
  }
  if (JSON.stringify(manifest.workload.variants) !== JSON.stringify(VARIANTS)) {
    throw new Error("comparison variants do not match the frozen runner variants");
  }
  if (
    JSON.stringify(manifest.workload.targetBlockOrder) !==
    JSON.stringify(["fireside", "java", "java", "fireside"])
  ) {
    throw new Error("comparison target order must remain ABBA");
  }
  const targetBlocks = manifest.workload.targetBlockOrder.length / 2;
  const expectedListener =
    targetBlocks *
    manifest.workload.measuredRepetitionsPerBlock *
    manifest.workload.listenerSamplesPerVariantPerRepetition;
  const expectedReconnect =
    targetBlocks * manifest.workload.measuredRepetitionsPerBlock;
  if (
    expectedListener !== manifest.workload.totalListenerSamplesPerTargetAndVariant ||
    expectedReconnect !== manifest.workload.totalReconnectSamplesPerTargetAndVariant
  ) {
    throw new Error("comparison manifest aggregate sample counts are inconsistent");
  }
}

async function assertPhase2Manifest(
  repositoryRoot: string,
  manifest: ComparisonManifest,
): Promise<void> {
  const phase2Manifest = await readFile(join(repositoryRoot, manifest.phase2.manifest));
  const observed = createHash("sha256").update(phase2Manifest).digest("hex");
  if (observed !== manifest.phase2.manifestSha256) {
    throw new Error(
      `Phase 2 manifest hash mismatch: expected ${manifest.phase2.manifestSha256}, found ${observed}`,
    );
  }
}

async function assertProductSourceUnchanged(repositoryRoot: string): Promise<void> {
  const result = await runCommandCapture(
    "git",
    [
      "diff",
      "--exit-code",
      PHASE2_PRODUCT_REVISION,
      "--",
      "crates",
      "Cargo.toml",
      "Cargo.lock",
    ],
    { cwd: repositoryRoot },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Fireside product source differs from Phase 2 candidate ${PHASE2_PRODUCT_REVISION}`,
    );
  }
}

function validateRun(run: DemoRun, target: Target, manifest: ComparisonManifest): void {
  if (!run.passed || run.target !== target) {
    throw new Error(`${target} browser comparison run did not pass`);
  }
  if (
    run.repetitions !== manifest.workload.measuredRepetitionsPerBlock ||
    run.warmupRepetitions !== manifest.workload.warmupRepetitionsPerBlock
  ) {
    throw new Error(`${target} browser comparison run changed frozen repetition counts`);
  }
  if (run.results.length !== VARIANTS.length * run.repetitions) {
    throw new Error(`${target} browser comparison run has incomplete variant coverage`);
  }
}

function assertSampleCount(name: string, values: readonly number[], expected: number): void {
  if (values.length !== expected || !values.every((value) => Number.isFinite(value) && value >= 0)) {
    throw new Error(`${name} has ${String(values.length)} valid samples; expected ${String(expected)}`);
  }
}

function distribution(values: readonly number[]): Distribution {
  return {
    maximum: Math.max(...values),
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    samples: values.length,
  };
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(fraction * sorted.length) - 1),
  );
  return sorted[index] ?? Number.NaN;
}

async function collectEnvironment(
  repositoryRoot: string,
  manifestText: string,
): Promise<EnvironmentEvidence> {
  const javaJar = process.env.FIRESTORE_EMULATOR_JAR ??
    join(
      process.env.HOME ?? "",
      ".cache/firebase/emulators/cloud-firestore-emulator-v1.22.0.jar",
    );
  const jarHash = createHash("sha256").update(await readFile(javaJar)).digest("hex");
  if (jarHash !== JAVA_JAR_SHA256) {
    throw new Error(`official Java emulator hash mismatch: ${jarHash}`);
  }
  return {
    capturedAt: new Date().toISOString(),
    cpu: cpus()[0]?.model ?? "unknown",
    hostname: hostname(),
    java: await commandOutput(process.env.JAVA ?? "java", ["-version"]),
    javaJar,
    javaJarSha256: jarHash,
    logicalCpus: cpus().length,
    manifestSha256: sha256(manifestText),
    node: process.version,
    npm: await commandOutput("npm", ["--version"]),
    os: `${platform()} ${release()}`,
    repositoryRevision: await commandOutput("git", ["rev-parse", "HEAD"], repositoryRoot),
    rust: await commandOutput("rustc", ["--version"]),
    totalMemoryBytes: totalmem(),
  };
}

function validateEnvironment(
  environment: EnvironmentEvidence,
  manifest: ComparisonManifest,
): void {
  const mismatches: string[] = [];
  const expect = (name: string, actual: string | number, expected: string | number) => {
    if (actual !== expected) {
      mismatches.push(`${name}: expected ${String(expected)}, found ${String(actual)}`);
    }
  };
  expect("host", environment.hostname, manifest.venue.host);
  expect("logical CPUs", environment.logicalCpus, manifest.venue.logicalCpus);
  expect("memory bytes", environment.totalMemoryBytes, manifest.venue.memoryBytes);
  expect("Node", environment.node.replace(/^v/, ""), manifest.toolchain.node);
  expect("npm", environment.npm, manifest.toolchain.npm);
  if (!environment.rust.startsWith(`rustc ${manifest.toolchain.rust} `)) {
    mismatches.push(`Rust: expected ${manifest.toolchain.rust}, found ${environment.rust}`);
  }
  if (!environment.java.includes(`version \"${manifest.toolchain.java}.`)) {
    mismatches.push(`Java: expected ${manifest.toolchain.java}.x, found ${environment.java}`);
  }
  if (!environment.os.startsWith("linux ")) {
    mismatches.push(`OS: expected Linux, found ${environment.os}`);
  }
  if (mismatches.length > 0) {
    throw new Error(`comparison environment mismatch:\n- ${mismatches.join("\n- ")}`);
  }
}

function reportMarkdown(
  summary: {
    readonly completedAt: string;
    readonly manifestSha256: string;
    readonly ratios: Record<string, Record<string, number>>;
    readonly targets: Record<
      Target,
      {
        readonly listener: Record<Variant, Distribution>;
        readonly reconnect: Record<Variant, Distribution>;
        readonly resources: { readonly peakRssBytes: number };
      }
    >;
  },
  environment: EnvironmentEvidence,
  outputDirectory: string,
  repositoryRoot: string,
): string {
  const rows = VARIANTS.map((variant) => {
    const fireside = summary.targets.fireside.listener[variant];
    const java = summary.targets.java.listener[variant];
    const ratio = summary.ratios[variant]?.listenerP99FiresideOverJava ?? Number.NaN;
    return `| ${variant} | ${String(fireside.samples)} | ${fireside.p50.toFixed(3)} | ${fireside.p95.toFixed(3)} | ${fireside.p99.toFixed(3)} | ${java.p50.toFixed(3)} | ${java.p95.toFixed(3)} | ${java.p99.toFixed(3)} | ${ratio.toFixed(3)} |`;
  });
  const reconnectRows = VARIANTS.map((variant) => {
    const fireside = summary.targets.fireside.reconnect[variant];
    const java = summary.targets.java.reconnect[variant];
    return `| ${variant} | ${String(fireside.samples)} | ${fireside.p50.toFixed(3)} | ${fireside.p99.toFixed(3)} | ${java.p50.toFixed(3)} | ${java.p99.toFixed(3)} |`;
  });
  const firesideRss = summary.targets.fireside.resources.peakRssBytes;
  const javaRss = summary.targets.java.resources.peakRssBytes;
  return `# Phase 2 Java WebChannel comparison

Status: **COMPLETE — non-gating comparison**

Completed: ${summary.completedAt}

Frozen comparison manifest SHA-256: \`${summary.manifestSha256}\`

Evidence directory: [\`${relative(repositoryRoot, outputDirectory)}\`](${relative(dirname(resolve(repositoryRoot, "reports/phase-2-java-webchannel-comparison.md")), outputDirectory)})

The same pinned vanilla Firebase JS SDK workload ran against the Phase 2
Fireside release build and official Java emulator v1.22.0 on one host. The
target blocks ran in frozen ABBA order. Each block discarded one warm-up
repetition and retained three measured repetitions, producing 600 listener
samples and six reconnect samples per target and transport variant. This is a
post-pass comparison; it does not alter the immutable Phase 2 verdict.

## Listener delivery

Times are milliseconds. The measurement starts immediately before a document
write and ends after both write acknowledgement and the matching listener
observation. A Fireside/Java ratio below 1 favors Fireside; above 1 favors Java.

| Variant | Samples/target | Fireside p50 | Fireside p95 | Fireside p99 | Java p50 | Java p95 | Java p99 | p99 F/J ratio |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${rows.join("\n")}

## Backchannel reconnect

| Variant | Samples/target | Fireside p50 | Fireside p99 | Java p50 | Java p99 |
| --- | ---: | ---: | ---: | ---: | ---: |
${reconnectRows.join("\n")}

## Target-process memory during the comparison

| Target | Peak sampled RSS |
| --- | ---: |
| Fireside release | ${(firesideRss / 1024 / 1024).toFixed(3)} MiB |
| Official Java v1.22.0 default | ${(javaRss / 1024 / 1024).toFixed(3)} MiB |
| Java/Fireside ratio | ${(javaRss / firesideRss).toFixed(3)}x |

## Interpretation limits

- This measures sequential acknowledged write-to-listener delivery, not maximum throughput.
- Java has no comparable disk/WAL mode, so only Fireside memory mode is compared.
- Production Cloud Firestore remains the behavior oracle and is not a local performance target.
- No JVM heap flag, allocator override, cache override, or performance threshold was added.
- Raw samples, per-block results, logs, environment data, and SHA-256 checksums are preserved.

## Environment

- Host: ${String(environment.hostname)}
- OS: ${String(environment.os)}
- CPU: ${String(environment.cpu)} (${String(environment.logicalCpus)} logical CPUs)
- Memory: ${String(environment.totalMemoryBytes)} bytes
- Node: ${String(environment.node)}
- npm: ${String(environment.npm)}
- Rust: ${String(environment.rust)}
- Java: ${String(environment.java).replaceAll("\n", "; ")}
- Browser version is recorded in every raw run JSON.
`;
}

async function writeChecksums(outputDirectory: string): Promise<void> {
  const files = await listFiles(outputDirectory);
  const lines: string[] = [];
  for (const path of files.filter((path) => path !== "SHA256SUMS").sort()) {
    const bytes = await readFile(join(outputDirectory, path));
    lines.push(`${createHash("sha256").update(bytes).digest("hex")}  ${path}`);
  }
  await writeFile(join(outputDirectory, "SHA256SUMS"), `${lines.join("\n")}\n`, "utf8");
}

async function listFiles(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(root, path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

async function assertAbsent(path: string): Promise<void> {
  try {
    await access(path);
    throw new Error(`refusing to overwrite existing comparison evidence: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

async function commandOutput(
  executable: string,
  arguments_: readonly string[],
  cwd = process.cwd(),
): Promise<string> {
  const result = await runCommandCapture(executable, arguments_, { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`${executable} ${arguments_.join(" ")} failed: ${result.output}`);
  }
  return result.output.trim();
}

async function runCommand(
  executable: string,
  arguments_: readonly string[],
  options: { readonly cwd: string },
): Promise<void> {
  const result = await runCommandCapture(executable, arguments_, options, true);
  if (result.exitCode !== 0) {
    throw new Error(`${executable} ${arguments_.join(" ")} failed with ${String(result.exitCode)}`);
  }
}

async function runCommandCapture(
  executable: string,
  arguments_: readonly string[],
  options: { readonly cwd: string },
  inherit = false,
): Promise<{ readonly exitCode: number; readonly output: string }> {
  return await new Promise((resolve_, reject) => {
    const child = spawn(executable, arguments_, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream?.setEncoding("utf8");
      stream?.on("data", (chunk: string) => {
        output += chunk;
        if (inherit) {
          process.stderr.write(chunk);
        }
      });
    }
    child.once("error", reject);
    child.once("exit", (code) => resolve_({ exitCode: code ?? 1, output }));
  });
}

await main();
