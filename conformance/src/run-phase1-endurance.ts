import { execFile } from "node:child_process";
import {
  access,
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

import { runImportGate } from "./endurance/import-gate.ts";
import { requireGate } from "./endurance/gate.ts";
import { observeJavaCrash } from "./endurance/java-crash.ts";
import {
  loadManifest,
  manifestPath,
  repositoryRoot,
  type EnduranceManifest,
} from "./endurance/manifest.ts";
import { runRecoveryGate } from "./endurance/recovery-gate.ts";
import { startServer, type ServerHandle } from "./endurance/server.ts";
import { runSoak, type SoakResult } from "./endurance/soak.ts";

const execute = promisify(execFile);

await main();

async function main(): Promise<void> {
  const manifest = await loadManifest();
  const artifactDirectory = requiredEnvironment("ENDURANCE_ARTIFACT_DIR");
  const requestedOutput = process.env.ENDURANCE_OUTPUT_DIR;
  const revision = (await execute("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
  })).stdout.trim();
  const outputDirectory = requestedOutput ?? resolve(
    repositoryRoot,
    manifest.telemetry.root,
    `${new Date().toISOString().replaceAll(/[:.]/gu, "-")}-${revision.slice(0, 12)}`,
  );
  await mkdir(outputDirectory, { recursive: true });
  await copyFile(manifestPath, resolve(outputDirectory, basename(manifestPath)));
  const manifestSha256 = createHash("sha256")
    .update(await readFile(manifestPath))
    .digest("hex");
  await writeState(outputDirectory, {
    status: "preflight",
    revision,
    manifestSha256,
    startedAt: new Date().toISOString(),
  });

  try {
    const preflight = await preflightHost(manifest, artifactDirectory);
    await writeFile(
      resolve(outputDirectory, "host-preflight.json"),
      `${JSON.stringify(preflight, null, 2)}\n`,
      "utf8",
    );

    await updateStage("fireside-memory-soak");
    await runFiresideSoak("fireside-memory", "fireside-memory-soak");

    await updateStage("fireside-disk-soak");
    await runFiresideSoak("fireside-disk", "fireside-disk-soak");

    await updateStage("fireside-2gib-import");
    const importResult = await runImportGate(
      manifest,
      "fireside-disk",
      artifactDirectory,
      resolve(outputDirectory, "fireside-2gib-import"),
      resolve(outputDirectory, "state/fireside-import"),
    );
    requireGate(importResult.passed, "fireside-2gib-import", importResult.summary);

    await updateStage("fireside-sigkill-recovery");
    const recovery = await runRecoveryGate(
      manifest,
      resolve(outputDirectory, "fireside-sigkill-recovery"),
      resolve(outputDirectory, "state/fireside-recovery"),
    );
    requireGate(recovery.passed, "fireside-sigkill-recovery", recovery.summary);

    await writeState(outputDirectory, {
      status: "fireside-gate-passed",
      revision,
      manifestSha256,
      completedAt: new Date().toISOString(),
    });

    await updateStage("java-default-soak");
    const defaultJava = await runJavaSoak("java-default-soak");
    let javaToolOptions: string | undefined;
    let comparisonCanContinue = defaultJava.serverSurvived;
    if (!defaultJava.serverSurvived && defaultJava.outOfMemory) {
      javaToolOptions = manifest.javaComparison.heapFailureRetry.javaToolOptions;
      await updateStage("java-heap-capped-soak");
      const capped = await runJavaSoak("java-heap-capped-soak", javaToolOptions);
      comparisonCanContinue = capped.serverSurvived;
    }

    if (comparisonCanContinue) {
      await updateStage("java-2gib-import");
      const javaImport = await runImportGate(
        manifest,
        "java",
        artifactDirectory,
        resolve(outputDirectory, "java-2gib-import"),
        undefined,
        javaToolOptions,
      );
      if (!javaImport.passed && javaToolOptions === undefined) {
        const log = await readOptional(resolve(outputDirectory, "java-2gib-import/server.log"));
        if (isOutOfMemory(log)) {
          javaToolOptions = manifest.javaComparison.heapFailureRetry.javaToolOptions;
          await updateStage("java-heap-capped-2gib-import");
          await runImportGate(
            manifest,
            "java",
            artifactDirectory,
            resolve(outputDirectory, "java-heap-capped-2gib-import"),
            undefined,
            javaToolOptions,
          );
        }
      }

      await updateStage("java-crash-observation");
      await observeJavaCrash(
        resolve(outputDirectory, "java-crash-observation"),
        javaToolOptions,
      );
    }

    await writeState(outputDirectory, {
      status: "complete",
      revision,
      manifestSha256,
      completedAt: new Date().toISOString(),
      firesideGatePassed: true,
      javaComparisonCompleted: comparisonCanContinue,
    });
    console.log(`phase 1 endurance sequence complete: ${outputDirectory}`);
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    await writeState(outputDirectory, {
      status: "failed",
      revision,
      manifestSha256,
      failedAt: new Date().toISOString(),
      error: message,
    });
    console.error(message);
    process.exitCode = 1;
  }

  async function updateStage(stage: string): Promise<void> {
    await writeState(outputDirectory, {
      status: "running",
      stage,
      revision,
      manifestSha256,
      updatedAt: new Date().toISOString(),
    });
    console.log(`${new Date().toISOString()} starting ${stage}`);
  }

  async function runFiresideSoak(
    kind: "fireside-memory" | "fireside-disk",
    label: string,
  ): Promise<void> {
    const directory = resolve(outputDirectory, label);
    let server: ServerHandle | undefined;
    try {
      server = await startServer({
        kind,
        projectId: "demo-fireside-endurance",
        outputDirectory: directory,
        ...(kind === "fireside-disk"
          ? { dataDirectory: resolve(outputDirectory, "state/fireside-soak") }
          : {}),
      });
      const result = await runSoak(manifest, server, kind, directory);
      requireGate(result.passed, label, result.summary);
    } finally {
      await server?.stop().catch(() => undefined);
    }
  }

  async function runJavaSoak(
    label: string,
    javaToolOptions?: string,
  ): Promise<{
    readonly result?: SoakResult;
    readonly outOfMemory: boolean;
    readonly serverSurvived: boolean;
  }> {
    const directory = resolve(outputDirectory, label);
    let server: ServerHandle | undefined;
    let result: SoakResult | undefined;
    let caught: string | undefined;
    try {
      server = await startServer({
        kind: "java",
        projectId: "demo-fireside-endurance",
        outputDirectory: directory,
        ...(javaToolOptions === undefined ? {} : { javaToolOptions }),
      });
      result = await runSoak(manifest, server, "java", directory);
    } catch (error) {
      caught = error instanceof Error ? error.stack ?? error.message : String(error);
      await writeFile(resolve(directory, "runner-error.txt"), `${caught}\n`, "utf8");
    } finally {
      await server?.stop().catch(() => undefined);
    }
    const serverLog = await readOptional(resolve(directory, "server.log"));
    return {
      ...(result === undefined ? {} : { result }),
      outOfMemory: isOutOfMemory(`${serverLog}\n${caught ?? ""}`),
      serverSurvived:
        result !== undefined
        && result.summary.criteria !== undefined
        && typeof result.summary.criteria === "object"
        && result.summary.criteria !== null
        && Reflect.get(result.summary.criteria, "serverAlive") === true,
    };
  }
}

async function preflightHost(
  manifest: EnduranceManifest,
  artifactDirectory: string,
): Promise<Record<string, unknown>> {
  if (process.platform !== "linux") {
    throw new Error("the frozen endurance venue requires Linux");
  }
  await access(resolve(repositoryRoot, "target/release/fireside"));
  await access(requiredEnvironment("FIRESTORE_EMULATOR_JAR"));
  const artifact = await stat(
    resolve(artifactDirectory, "all_namespaces/all_kinds/output-0"),
  );
  if (
    artifact.size < manifest.import.minimumArtifactBytes
    || artifact.size > manifest.import.maximumArtifactBytes
  ) {
    throw new Error(`2 GiB artifact is outside frozen bounds: ${String(artifact.size)}`);
  }
  const memory = await readFile("/proc/meminfo", "utf8");
  const swapTotal = meminfoBytes(memory, "SwapTotal");
  const swapFree = meminfoBytes(memory, "SwapFree");
  const swapUsed = swapTotal - swapFree;
  if (swapUsed !== 0) {
    throw new Error(`frozen venue requires zero swap use at start, found ${String(swapUsed)}`);
  }
  const [rust, node, npm, java, git] = await Promise.all([
    version("rustc", ["--version"]),
    version("node", ["--version"]),
    version("npm", ["--version"]),
    version("java", ["-version"]),
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
    swapTotalBytes: swapTotal,
    swapUsedBytes: swapUsed,
    artifactBytes: artifact.size,
    toolchain: { rust, node, npm, java, git },
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

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

function isOutOfMemory(contents: string): boolean {
  return /OutOfMemoryError|Java heap space/iu.test(contents);
}
