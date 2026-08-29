import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";

import {
  loadManifest,
  manifestPath,
  repositoryRoot,
} from "./endurance/manifest.ts";
import { startServer, type ServerHandle } from "./endurance/server.ts";
import { runSoak } from "./endurance/soak.ts";

const execute = promisify(execFile);
const OBSERVATION_DURATION_SECONDS = 3_600;
const REDB_4_2_DEFAULT_CACHE_BYTES = 1_024 * 1_024 * 1_024;

await main();

async function main(): Promise<void> {
  const manifest = await loadManifest();
  const outputDirectory = requiredEnvironment("ENDURANCE_OUTPUT_DIR");
  const cacheSizeBytes = positiveIntegerEnvironment("ENDURANCE_REDB_CACHE_SIZE_BYTES");
  const revision = (await execute("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
  })).stdout.trim();
  const manifestSha256 = createHash("sha256")
    .update(await readFile(manifestPath))
    .digest("hex");
  await mkdir(outputDirectory, { recursive: true });
  await copyFile(manifestPath, resolve(outputDirectory, basename(manifestPath)));
  await writeState(outputDirectory, {
    status: "preflight",
    stage: "redb-cache-bound-diagnostic",
    revision,
    manifestSha256,
    startedAt: new Date().toISOString(),
  });

  let server: ServerHandle | undefined;
  try {
    const preflight = await preflightHost();
    await writeFile(
      resolve(outputDirectory, "host-preflight.json"),
      `${JSON.stringify(preflight, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      resolve(outputDirectory, "diagnostic-control.json"),
      `${JSON.stringify({
        hypothesis: "redb internal cache warming toward its configured bound",
        redbVersion: "4.2.0",
        productionBehaviorCacheBytes: REDB_4_2_DEFAULT_CACHE_BYTES,
        diagnosticCacheBytes: cacheSizeBytes,
        observationDurationSeconds: OBSERVATION_DURATION_SECONDS,
        manifestDurationSeconds: manifest.soak.durationSeconds,
        manifestSha256,
        frozenThresholds: manifest.soak.memory,
        onlyIntentionalRuntimeDifference: "--redb-cache-size",
      }, null, 2)}\n`,
      "utf8",
    );
    const stageDirectory = resolve(outputDirectory, "fireside-disk-soak");
    server = await startServer({
      kind: "fireside-disk",
      projectId: "demo-fireside-endurance",
      outputDirectory: stageDirectory,
      dataDirectory: resolve(outputDirectory, "state/fireside-soak"),
      diskCacheSizeBytes: cacheSizeBytes,
    });
    await writeState(outputDirectory, {
      status: "running",
      stage: "redb-cache-bound-diagnostic",
      revision,
      manifestSha256,
      serverPid: server.pid,
      cacheSizeBytes,
      observationDurationSeconds: OBSERVATION_DURATION_SECONDS,
      measurementStatus: "seeding-or-measuring",
      updatedAt: new Date().toISOString(),
    });
    const result = await runSoak(
      manifest,
      server,
      "fireside-disk",
      stageDirectory,
      { observationDurationSeconds: OBSERVATION_DURATION_SECONDS },
    );
    await writeState(outputDirectory, {
      status: result.passed ? "complete" : "failed",
      stage: "redb-cache-bound-diagnostic",
      revision,
      manifestSha256,
      cacheSizeBytes,
      completedAt: new Date().toISOString(),
      passed: result.passed,
      summaryPath: result.summaryPath,
    });
    if (!result.passed) {
      process.exitCode = 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    await writeState(outputDirectory, {
      status: "failed",
      stage: "redb-cache-bound-diagnostic",
      revision,
      manifestSha256,
      failedAt: new Date().toISOString(),
      error: message,
    });
    await writeFile(resolve(outputDirectory, "runner-error.txt"), `${message}\n`, "utf8");
    process.exitCode = 1;
  } finally {
    await server?.stop().catch(() => undefined);
  }
}

async function preflightHost(): Promise<Record<string, unknown>> {
  if (process.platform !== "linux") {
    throw new Error("the controlled disk diagnostic venue requires Linux");
  }
  await access(resolve(repositoryRoot, "target/release/fireside"));
  const memory = await readFile("/proc/meminfo", "utf8");
  const swapTotalBytes = meminfoBytes(memory, "SwapTotal");
  const swapUsedBytes = swapTotalBytes - meminfoBytes(memory, "SwapFree");
  if (swapUsedBytes !== 0) {
    throw new Error(`controlled venue requires zero swap use at start, found ${String(swapUsedBytes)}`);
  }
  const [rust, node, npm, git] = await Promise.all([
    version("rustc", ["--version"]),
    version("node", ["--version"]),
    version("npm", ["--version"]),
    version("git", ["--version"]),
  ]);
  return {
    timestamp: new Date().toISOString(),
    hostname: (await readFile("/etc/hostname", "utf8")).trim(),
    osRelease: await readFile("/etc/os-release", "utf8"),
    architecture: process.arch,
    cpu: cpus()[0]?.model ?? null,
    logicalCpus: cpus().length,
    totalMemoryBytes: totalmem(),
    memAvailableBytes: meminfoBytes(memory, "MemAvailable"),
    swapTotalBytes,
    swapUsedBytes,
    toolchain: { rust, node, npm, git },
  };
}

async function writeState(
  outputDirectory: string,
  state: Record<string, unknown>,
): Promise<void> {
  const destination = resolve(outputDirectory, "run-state.json");
  const temporary = resolve(outputDirectory, ".run-state.json.tmp");
  const handle = await open(temporary, "w", 0o644);
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    await handle.datasync();
  } finally {
    await handle.close();
  }
  await rename(temporary, destination);
}

function positiveIntegerEnvironment(name: string): number {
  const value = Number(requiredEnvironment(name));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function version(command: string, arguments_: readonly string[]): Promise<string> {
  try {
    const result = await execute(command, arguments_);
    return `${result.stdout}${result.stderr}`.trim();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function meminfoBytes(contents: string, name: string): number {
  const match = contents.match(new RegExp(`^${name}:\\s+(\\d+)\\s+kB$`, "mu"));
  if (match?.[1] === undefined) {
    throw new Error(`missing ${name} in /proc/meminfo`);
  }
  return Number.parseInt(match[1], 10) * 1_024;
}
