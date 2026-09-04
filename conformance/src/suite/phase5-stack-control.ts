import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  appendFile,
  mkdir,
  readFile,
  readdir,
  readlink,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import type { Phase5StackPorts } from "./phase5-host-prepare.ts";
import {
  PHASE5_FRONTEND_PROBE_SECONDS,
  phase5CurlProbe,
  phase5CacheJsonProbe,
  phase5FetchProbe,
  waitForPhase5Readiness,
  type ReadinessAllowance,
  type ReadinessCondition,
} from "./phase5-readiness.ts";

export { PHASE5_DIAGNOSTIC_DEFINITIVE_ERROR_SAMPLES } from "./phase5-readiness.ts";

export type Phase5StackName = "official" | "fireside";

export const PHASE5_EXPORT_SHUTDOWN_SECONDS = 600;
export const PHASE5_DIRECTORY_REAP_SECONDS = 60;
export const PHASE5_DIRECTORY_EMPTY_SCANS = 2;
export const PHASE5_OFFICIAL_JAVA_TOOL_OPTIONS = "-Xmx8g";
export const PHASE5_LOGIN_ROUTE = "/login/overview";
export const PHASE5_PORTLESS_STATE_DIRECTORY = "/home/sanjevi/.portless";
export const PHASE5_TWODARTNET_HEALTH_ROUTE = "/api/HealthCheck";

export interface StackLaunchInput {
  readonly backendOverride?: Phase5StackName | null;
  readonly datasetName: string;
  readonly directory: string;
  readonly evidenceDirectory: string;
  readonly exportPath: string;
  readonly firesideBinary: string;
  readonly javaHome: string;
  readonly javaToolOptions?: string;
  readonly label: string;
  readonly nodeBinary: string;
  readonly ports: Phase5StackPorts;
  readonly runtimeDirectory: string;
  readonly stack: Phase5StackName;
  readonly tmuxSession: string;
  readonly diagnosticFailFast?: boolean;
}

export interface CacheBuildMetrics {
  readonly errors: number;
  readonly inputDocumentCount: number;
  readonly outputCounts: Readonly<Record<string, number | boolean>>;
  readonly peakPssBytes: number | null;
  readonly peakRssBytes: number;
  readonly readyMilliseconds: number;
}

export interface RunningPhase5Stack {
  readonly baseUrl: string;
  readonly cacheBuild: CacheBuildMetrics;
  readonly directory: string;
  readonly exitMarker: string;
  readonly exportPath: string;
  readonly firesideBinary: string;
  readonly label: string;
  readonly launchLog: string;
  readonly ports: Phase5StackPorts;
  readonly processSampler: Phase5ProcessSampler;
  readonly stack: Phase5StackName;
  readonly tmuxSession: string;
  readonly twodartNetUrl: string;
}

export interface Phase5ProcessSampler {
  stop(): Promise<void>;
}

interface Phase5ProcessMeasurement {
  readonly command: string;
  readonly pid: number;
  readonly procStatStartTimeTicks: string;
  readonly pssBytes: number | null;
  readonly rssBytes: number;
}

interface Phase5ProcessPeak {
  command: string;
  firstObservedAt: string;
  lastObservedAt: string;
  pid: number;
  procStatStartTimeTicks: string;
  pssBytes: number | null;
  rssBytes: number;
  samples: number;
}

export interface StoppedPhase5Stack {
  readonly exportMetadataPresent: boolean;
  readonly exitCode: number;
  readonly orphanCheckPassed: boolean;
  readonly remainingDirectoryProcessGroups: number;
  readonly remainingListenerPorts: number;
  readonly shutdownOrder: "emulator-export-first-then-mprocs";
  readonly shutdownMilliseconds: number;
}

export interface Phase5ProcessIdentity {
  readonly pid: number;
  readonly procStatStartTimeTicks: string;
}

export interface Phase5FrontendReadiness {
  readonly readyMilliseconds: number;
  readonly status: number;
}

export interface Phase5MprocsControlCommand {
  readonly arguments: readonly string[];
  readonly command: string;
}

export function renderPhase5MprocsControlCommand(
  directory: string,
  port: number,
): Phase5MprocsControlCommand {
  return {
    arguments: ["--server", `127.0.0.1:${String(port)}`, "--ctl", "c: force-quit"],
    command: path.join(directory, "node_modules", ".bin", "mprocs"),
  };
}

export function phase5EmulatorProcessMatches(
  stack: Phase5StackName,
  command: string,
  firesideBinary: string,
): boolean {
  if (stack === "official") {
    return (
      command.includes(`${path.sep}node_modules${path.sep}.bin${path.sep}firebase\0`) &&
      command.includes("\0emulators:start\0")
    );
  }
  return command.startsWith(`${firesideBinary}\0suite\0`);
}

export function phase5CommandLaunchPathMatches(
  command: string,
  directory: string,
): boolean {
  const resolvedDirectory = path.resolve(directory);
  return command
    .split("\0")
    .slice(0, 2)
    .some((value) => {
      if (!path.isAbsolute(value)) return false;
      const resolvedValue = path.resolve(value);
      return (
        resolvedValue === resolvedDirectory ||
        resolvedValue.startsWith(`${resolvedDirectory}${path.sep}`)
      );
    });
}

export function renderPhase5StackCommand(input: StackLaunchInput): string {
  const exactPath = [
    path.join(input.javaHome, "bin"),
    path.dirname(input.nodeBinary),
    "/home/sanjevi/.local/share/mise/installs/bun/1.3.14/bin",
    "/home/sanjevi/.local/share/mise/dotnet-root",
    "/home/sanjevi/.local/share/mise/installs/python/3.14.6/bin",
    "/home/sanjevi/.rustup/toolchains/1.98.0-x86_64-unknown-linux-gnu/bin",
    "/home/sanjevi/.local/share/mise/shims",
    "/home/sanjevi/.local/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].join(":");
  const environment: Readonly<Record<string, string>> = {
    FIREBASE_EMULATOR_TMPDIR: input.runtimeDirectory,
    FIREBASE_SKIP_PREBUILD: "1",
    JAVA_HOME: input.javaHome,
    JAVA_TOOL_OPTIONS: "",
    PATH: exactPath,
    PORTLESS_STATE_DIR: PHASE5_PORTLESS_STATE_DIRECTORY,
    TWODART_DISABLE_EXTERNALS: "1",
    TWODART_EMULATOR_EXPORT_OVERRIDE: input.exportPath,
    TWODART_EMULATOR_JAVA_BIN: path.join(input.javaHome, "bin", "java"),
    ...(input.javaToolOptions === undefined
      ? {}
      : { TWODART_EMULATOR_JAVA_TOOL_OPTIONS: input.javaToolOptions }),
    ...(input.backendOverride === null
      ? {}
      : { TWODART_FIREBASE_BACKEND: input.backendOverride ?? input.stack }),
    TWODART_FIREBASE_NODE_BIN: input.nodeBinary,
    TWODART_FIRESIDE_BIN: input.firesideBinary,
    TWODART_PHASE5_STACK: `${input.stack}-${input.label}`,
  };
  const exitMarker = path.join(input.evidenceDirectory, `${input.stack}-${input.label}.exit`);
  const exports = Object.entries(environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");
  return [
    "set +e",
    `env ${exports} bun dev:mprocs --data ${shellQuote(input.datasetName)}`,
    "phase5_status=$?",
    `printf '%s\\n' \"$phase5_status\" > ${shellQuote(exitMarker)}`,
  ].join("; ");
}

export async function startPhase5Stack(
  input: StackLaunchInput,
  maximumReadySeconds: number | ReadinessAllowance,
  inputDocumentCount: number,
): Promise<RunningPhase5Stack> {
  await assertAbsent(input.runtimeDirectory);
  await mkdir(input.runtimeDirectory, { recursive: true });
  await mkdir(input.evidenceDirectory, { recursive: true });
  const launchLog = path.join(
    input.evidenceDirectory,
    `${input.stack}-${input.label}-tmux.log`,
  );
  const exitMarker = path.join(input.evidenceDirectory, `${input.stack}-${input.label}.exit`);
  await assertAbsent(launchLog);
  await assertAbsent(exitMarker);
  if ((await run("tmux", ["has-session", "-t", input.tmuxSession])).exitCode === 0) {
    throw new Error(`tmux session already exists: ${input.tmuxSession}`);
  }

  await requireCommand(
    "tmux",
    ["new-session", "-d", "-s", input.tmuxSession, "-c", input.directory],
    "create Phase 5 tmux session",
  );
  await requireCommand(
    "tmux",
    ["pipe-pane", "-o", "-t", input.tmuxSession, `cat >> ${shellQuote(launchLog)}`],
    "attach Phase 5 tmux evidence pipe",
  );
  const command = renderPhase5StackCommand(input);
  await requireCommand(
    "tmux",
    ["send-keys", "-t", input.tmuxSession, "-l", command],
    "send Phase 5 launch command",
  );
  const startedAt = Date.now();
  await requireCommand(
    "tmux",
    ["send-keys", "-t", input.tmuxSession, "Enter"],
    "execute Phase 5 launch command",
  );
  const processSampler = startPhase5ProcessSampler(input);

  try {
    const env = await readPhase5PortEnvironment(input.directory);
    const baseUrl = requiredEnvironment(env, "FE_URL");
    const twodartNetUrl = requiredEnvironment(env, "TWODARTNET_API_URL");
    let peakRssBytes = 0;
    let peakPssBytes: number | null = 0;
    let emulatorProcessObserved = false;
    await waitForPhase5Readiness({
      conditions: phase5ReadinessConditions(input, baseUrl, twodartNetUrl),
      startedAt,
      allowances: typeof maximumReadySeconds === "number"
        ? { emulator: maximumReadySeconds, application: maximumReadySeconds }
        : maximumReadySeconds,
      ledgerPath: path.join(input.evidenceDirectory, `${input.stack}-${input.label}-readiness.jsonl`),
      summaryPath: path.join(input.evidenceDirectory, `${input.stack}-${input.label}-readiness.json`),
      diagnosticFailFast: input.diagnosticFailFast === true,
      checkHealth: async () => {
        const emulatorProcesses = await phase5EmulatorProcesses(
          input.directory,
          input.stack,
          input.firesideBinary,
        );
        if (emulatorProcesses.length > 0) emulatorProcessObserved = true;
        else if (emulatorProcessObserved) {
          throw new Error(`${input.stack} emulator process exited before readiness`);
        }
        const watcher = await processMetricsContaining(
          input.directory,
          "watch-firestore-cache.ts",
        );
        peakRssBytes = Math.max(peakRssBytes, watcher.rssBytes);
        if (watcher.pssBytes === null) peakPssBytes = null;
        else if (peakPssBytes !== null) {
          peakPssBytes = Math.max(peakPssBytes, watcher.pssBytes);
        }

        if (await exists(exitMarker)) {
          const status = (await readFile(exitMarker, "utf8")).trim();
          throw new Error(`${input.stack} exited before readiness with status ${status}`);
        }
      },
    });
    const cacheLog = await readFile(
      path.join(input.directory, ".logs", "firebase-cache-watch.log"),
      "utf8",
    );
    if (input.javaToolOptions !== undefined) {
      const emulatorLog = await readFile(
        path.join(input.directory, ".logs", "firebase-emulator.log"),
        "utf8",
      );
      if (!emulatorLog.includes(`flags: ${input.javaToolOptions}`)) {
        throw new Error(
          `${input.stack} did not report the required Java comparison flags`,
        );
      }
    }
    const cacheBuild: CacheBuildMetrics = {
      errors: cacheErrorCount(cacheLog),
      inputDocumentCount,
      outputCounts: parseCacheOutputCounts(cacheLog),
      peakPssBytes,
      peakRssBytes,
      readyMilliseconds: Date.now() - startedAt,
    };
    if (cacheBuild.errors !== 0) {
      throw new Error(`${input.stack} cache watcher reported ${String(cacheBuild.errors)} errors`);
    }
    return {
      baseUrl,
      cacheBuild,
      directory: input.directory,
      exitMarker,
      exportPath: input.exportPath,
      firesideBinary: input.firesideBinary,
      label: input.label,
      launchLog,
      ports: input.ports,
      processSampler,
      stack: input.stack,
      tmuxSession: input.tmuxSession,
      twodartNetUrl,
    };
  } catch (error: unknown) {
    try {
      await processSampler.stop();
      await cleanupFailedStart(input);
    } catch (cleanupError: unknown) {
      throw new AggregateError(
        [error, cleanupError],
        `${input.stack} startup failed and its isolated process tree did not cleanly stop`,
      );
    }
    throw error;
  }
}

function startPhase5ProcessSampler(input: StackLaunchInput): Phase5ProcessSampler {
  const ledgerPath = path.join(
    input.evidenceDirectory,
    `${input.stack}-${input.label}-process-memory.jsonl`,
  );
  const summaryPath = path.join(
    input.evidenceDirectory,
    `${input.stack}-${input.label}-process-memory.json`,
  );
  const peaks = new Map<string, Phase5ProcessPeak>();
  let peakAggregatePssBytes: number | null = 0;
  let peakAggregateRssBytes = 0;
  let sampleCount = 0;
  let stopRequested = false;
  let resolveStopSignal: () => void = () => undefined;
  const stopSignal = new Promise<void>((resolve) => {
    resolveStopSignal = resolve;
  });

  const loop = (async (): Promise<void> => {
    while (!stopRequested) {
      const observedAt = new Date().toISOString();
      const processes = await measurePhase5DirectoryProcesses(input.directory);
      const aggregateRssBytes = processes.reduce(
        (total, process) => total + process.rssBytes,
        0,
      );
      const aggregatePssBytes = processes.every((process) => process.pssBytes !== null)
        ? processes.reduce((total, process) => total + (process.pssBytes ?? 0), 0)
        : null;
      peakAggregateRssBytes = Math.max(peakAggregateRssBytes, aggregateRssBytes);
      if (aggregatePssBytes === null) peakAggregatePssBytes = null;
      else if (peakAggregatePssBytes !== null) {
        peakAggregatePssBytes = Math.max(peakAggregatePssBytes, aggregatePssBytes);
      }
      for (const process of processes) {
        const key = phase5ProcessIdentityKey(process);
        const existing = peaks.get(key);
        if (existing === undefined) {
          peaks.set(key, {
            ...process,
            firstObservedAt: observedAt,
            lastObservedAt: observedAt,
            samples: 1,
          });
        } else {
          existing.lastObservedAt = observedAt;
          existing.samples += 1;
          existing.rssBytes = Math.max(existing.rssBytes, process.rssBytes);
          if (process.pssBytes === null) existing.pssBytes = null;
          else if (existing.pssBytes !== null) {
            existing.pssBytes = Math.max(existing.pssBytes, process.pssBytes);
          }
        }
      }
      sampleCount += 1;
      await appendFile(
        ledgerPath,
        `${JSON.stringify({
          aggregatePssBytes,
          aggregateRssBytes,
          observedAt,
          processes,
          schemaVersion: 1,
          stack: input.stack,
        })}\n`,
        "utf8",
      );
      if (!stopRequested) {
        await Promise.race([delay(10_000), stopSignal]);
      }
    }
  })();
  let completion: Promise<void> | null = null;
  return {
    stop(): Promise<void> {
      stopRequested = true;
      resolveStopSignal();
      completion ??= loop.then(async () => {
        await writeFile(
          summaryPath,
          `${JSON.stringify({
            completedAt: new Date().toISOString(),
            intervalSeconds: 10,
            peakAggregatePssBytes,
            peakAggregateRssBytes,
            processPeaks: [...peaks.values()].sort((left, right) => left.pid - right.pid),
            sampleCount,
            schemaVersion: 1,
            stack: input.stack,
          }, null, 2)}\n`,
          { encoding: "utf8", flag: "wx" },
        );
      });
      return completion;
    },
  };
}

async function measurePhase5DirectoryProcesses(
  directory: string,
): Promise<readonly Phase5ProcessMeasurement[]> {
  const identities = await phase5DirectoryProcesses(directory);
  const measurements = await Promise.all(
    identities.map(async (identity): Promise<Phase5ProcessMeasurement | null> => {
      try {
        const [commandBytes, status, smaps] = await Promise.all([
          readFile(`/proc/${String(identity.pid)}/cmdline`),
          readFile(`/proc/${String(identity.pid)}/status`, "utf8"),
          readFile(`/proc/${String(identity.pid)}/smaps_rollup`, "utf8"),
        ]);
        const current = phase5ProcessIdentityFromStat(
          identity.pid,
          await readFile(`/proc/${String(identity.pid)}/stat`, "utf8"),
        );
        if (current.procStatStartTimeTicks !== identity.procStatStartTimeTicks) return null;
        const command = commandBytes.toString("utf8").split("\0")[0] ?? "";
        return {
          command: path.basename(command),
          pid: identity.pid,
          procStatStartTimeTicks: identity.procStatStartTimeTicks,
          pssBytes: phase5ProcKilobytes(smaps, "Pss"),
          rssBytes: phase5ProcKilobytes(status, "VmRSS") ?? 0,
        };
      } catch {
        return null;
      }
    }),
  );
  return measurements
    .filter((measurement): measurement is Phase5ProcessMeasurement => measurement !== null)
    .sort((left, right) => left.pid - right.pid);
}

export function phase5ProcKilobytes(content: string, field: string): number | null {
  const prefix = `${field}:`;
  const line = content.split("\n").find((candidate) => candidate.startsWith(prefix));
  if (line === undefined) return null;
  const kilobytes = Number(line.slice(prefix.length).trim().split(/\s+/u)[0]);
  return Number.isFinite(kilobytes) ? kilobytes * 1_024 : null;
}

export async function stopPhase5Stack(
  running: RunningPhase5Stack,
  maximumShutdownSeconds: number,
): Promise<StoppedPhase5Stack> {
  await running.processSampler.stop();
  const started = performance.now();
  const deadline = Date.now() + maximumShutdownSeconds * 1_000;
  const exportMetadata = path.join(running.exportPath, "firebase-export-metadata.json");
  let exitCode: number | null = null;
  let lifecycleError: unknown;
  try {
    await stopPhase5EmulatorProcess(
      running.directory,
      running.stack,
      running.firesideBinary,
      maximumShutdownSeconds,
    );
    await waitForPhase5ExportMetadata(running.stack, exportMetadata, deadline);
    await requestHeadlessMprocsShutdown(running.directory, running.ports.mprocsControl);
    while (!(await exists(running.exitMarker))) {
      if (Date.now() >= deadline) {
        throw new Error(`${running.stack} did not stop within the lifecycle boundary`);
      }
      await delay(1_000);
    }
    exitCode = Number((await readFile(running.exitMarker, "utf8")).trim());
    if (!Number.isInteger(exitCode) || exitCode !== 0) {
      throw new Error(`${running.stack} mprocs exited with ${String(exitCode)}`);
    }
  } catch (error: unknown) {
    lifecycleError = error;
  }

  let cleanupError: unknown;
  try {
    await settlePhase5StackCleanup(running);
  } catch (error: unknown) {
    cleanupError = error;
  }
  const exportMetadataPresent = await exists(exportMetadata);
  if (lifecycleError !== undefined && cleanupError !== undefined) {
    throw new AggregateError(
      [lifecycleError, cleanupError],
      `${running.stack} lifecycle and isolated cleanup both failed`,
    );
  }
  if (lifecycleError !== undefined) throw lifecycleError;
  if (cleanupError !== undefined) throw cleanupError;
  if (exitCode === null) throw new Error(`${running.stack} lifecycle omitted its exit code`);
  const remainingDirectoryProcessGroups = (
    await phase5DirectoryProcesses(running.directory)
  ).length;
  const remainingListenerPorts = (
    await Promise.all(
      Object.values(running.ports).map(async (port) => listenerOpen(port)),
    )
  ).filter(Boolean).length;
  if (remainingDirectoryProcessGroups !== 0 || remainingListenerPorts !== 0) {
    throw new Error(
      `${running.stack} orphan verification failed after settled cleanup`,
    );
  }
  return {
    exitCode,
    exportMetadataPresent,
    orphanCheckPassed: true,
    remainingDirectoryProcessGroups,
    remainingListenerPorts,
    shutdownOrder: "emulator-export-first-then-mprocs",
    shutdownMilliseconds: performance.now() - started,
  };
}

async function waitForPhase5ExportMetadata(
  stack: Phase5StackName,
  exportMetadata: string,
  deadline: number,
): Promise<void> {
  while (!(await exists(exportMetadata))) {
    if (Date.now() >= deadline) {
      throw new Error(`${stack} export-on-exit metadata is missing`);
    }
    await delay(1_000);
  }
}

async function settlePhase5StackCleanup(running: RunningPhase5Stack): Promise<void> {
  if (await listenerOpen(running.ports.mprocsControl)) {
    await requestHeadlessMprocsShutdown(running.directory, running.ports.mprocsControl);
  }
  if ((await run("tmux", ["has-session", "-t", running.tmuxSession])).exitCode === 0) {
    await requireCommand(
      "tmux",
      ["kill-session", "-t", running.tmuxSession],
      "close completed Phase 5 tmux session",
    );
  }
  await reapPhase5DirectoryProcesses(
    running.directory,
    PHASE5_DIRECTORY_REAP_SECONDS,
  );
  const ports = Object.values(running.ports);
  const listenerDeadline = Date.now() + 60_000;
  while ((await Promise.all(ports.map(async (port) => listenerOpen(port)))).some(Boolean)) {
    if (Date.now() >= listenerDeadline) {
      throw new Error(`${running.stack} left a listener after graceful shutdown`);
    }
    await delay(500);
  }
}

async function requestHeadlessMprocsShutdown(
  directory: string,
  port: number,
): Promise<void> {
  const control = renderPhase5MprocsControlCommand(directory, port);
  await requireCommand(
    control.command,
    control.arguments,
    "reap post-export headless mprocs controller",
  );
}

async function cleanupFailedStart(
  input: StackLaunchInput,
): Promise<void> {
  await stopPhase5EmulatorProcess(
    input.directory,
    input.stack,
    input.firesideBinary,
    PHASE5_EXPORT_SHUTDOWN_SECONDS,
  );
  if (await listenerOpen(input.ports.mprocsControl)) {
    await requestHeadlessMprocsShutdown(input.directory, input.ports.mprocsControl);
  }
  if ((await run("tmux", ["has-session", "-t", input.tmuxSession])).exitCode === 0) {
    await requireCommand(
      "tmux",
      ["kill-session", "-t", input.tmuxSession],
      "close failed Phase 5 startup session",
    );
  }
  await reapPhase5DirectoryProcesses(
    input.directory,
    PHASE5_DIRECTORY_REAP_SECONDS,
  );
  if ((await run("tmux", ["has-session", "-t", input.tmuxSession])).exitCode === 0) {
    await requireCommand(
      "tmux",
      ["kill-session", "-t", input.tmuxSession],
      "close cleaned Phase 5 startup session",
    );
  }

  const deadline = Date.now() + PHASE5_EXPORT_SHUTDOWN_SECONDS * 1_000;
  const ports = Object.values(input.ports);
  while (true) {
    const listeners = await Promise.all(ports.map(async (port) => listenerOpen(port)));
    if (!listeners.some(Boolean)) break;
    if (Date.now() >= deadline) {
      throw new Error(`${input.stack} left an isolated listener after startup failure`);
    }
    await delay(1_000);
  }
}

async function stopPhase5EmulatorProcess(
  directory: string,
  stack: Phase5StackName,
  firesideBinary: string,
  maximumShutdownSeconds: number,
): Promise<void> {
  const processes = await phase5EmulatorProcesses(directory, stack, firesideBinary);
  if (processes.length === 0) return;
  if (processes.length !== 1) {
    throw new Error(
      `${stack} has ${String(processes.length)} emulator launch processes instead of exactly one`,
    );
  }
  const identity = processes[0];
  if (identity === undefined || identity.pid <= 1) {
    throw new Error(`${stack} resolved an unsafe emulator process identity`);
  }
  if (!(await assertPhase5EmulatorProcessScope(identity, directory, stack, firesideBinary))) {
    return;
  }
  try {
    process.kill(identity.pid, "SIGINT");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    return;
  }

  const deadline = Date.now() + maximumShutdownSeconds * 1_000;
  while (await phase5ProcessIdentityAlive(identity)) {
    if (Date.now() >= deadline) {
      throw new Error(`${stack} emulator launch process did not stop cleanly`);
    }
    await delay(1_000);
  }
}

async function phase5EmulatorProcesses(
  directory: string,
  stack: Phase5StackName,
  firesideBinary: string,
): Promise<readonly Phase5ProcessIdentity[]> {
  const processes: Phase5ProcessIdentity[] = [];
  for (const entry of await readdir("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    try {
      const command = (await readFile(`/proc/${entry.name}/cmdline`)).toString("utf8");
      if (!phase5EmulatorProcessMatches(stack, command, firesideBinary)) continue;
      const cwd = path.resolve(await readlink(`/proc/${entry.name}/cwd`));
      const resolvedDirectory = path.resolve(directory);
      if (
        cwd !== resolvedDirectory &&
        !cwd.startsWith(`${resolvedDirectory}${path.sep}`) &&
        !phase5CommandLaunchPathMatches(command, resolvedDirectory)
      ) {
        continue;
      }
      const identity = phase5ProcessIdentityFromStat(
        Number(entry.name),
        await readFile(`/proc/${entry.name}/stat`, "utf8"),
      );
      if (identity.pid > 1) processes.push(identity);
    } catch {
      // The process can exit between /proc reads.
    }
  }
  return processes.sort((left, right) => left.pid - right.pid);
}

async function assertPhase5EmulatorProcessScope(
  identity: Phase5ProcessIdentity,
  directory: string,
  stack: Phase5StackName,
  firesideBinary: string,
): Promise<boolean> {
  try {
    const [commandBytes, cwdValue, stat] = await Promise.all([
      readFile(`/proc/${String(identity.pid)}/cmdline`),
      readlink(`/proc/${String(identity.pid)}/cwd`),
      readFile(`/proc/${String(identity.pid)}/stat`, "utf8"),
    ]);
    const current = phase5ProcessIdentityFromStat(identity.pid, stat);
    if (current.procStatStartTimeTicks !== identity.procStatStartTimeTicks) return false;
    const command = commandBytes.toString("utf8");
    if (!phase5EmulatorProcessMatches(stack, command, firesideBinary)) {
      throw new Error(`${stack} emulator process identity no longer matches its launch command`);
    }
    const cwd = path.resolve(cwdValue);
    const resolvedDirectory = path.resolve(directory);
    if (
      cwd !== resolvedDirectory &&
      !cwd.startsWith(`${resolvedDirectory}${path.sep}`) &&
      !phase5CommandLaunchPathMatches(command, resolvedDirectory)
    ) {
      throw new Error(
        `refusing to signal emulator process ${String(identity.pid)} outside ${resolvedDirectory}`,
      );
    }
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function phase5ProcessIdentityAlive(identity: Phase5ProcessIdentity): Promise<boolean> {
  try {
    const current = phase5ProcessIdentityFromStat(
      identity.pid,
      await readFile(`/proc/${String(identity.pid)}/stat`, "utf8"),
    );
    return current.procStatStartTimeTicks === identity.procStatStartTimeTicks;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function reapPhase5DirectoryProcesses(
  directory: string,
  maximumSeconds: number,
): Promise<void> {
  const started = Date.now();
  const termAt = started + Math.floor((maximumSeconds * 1_000) / 2);
  const deadline = started + maximumSeconds * 1_000;
  const interruptedProcesses = new Set<string>();
  const terminatedProcesses = new Set<string>();
  let consecutiveEmptyScans = 0;
  while (true) {
    const processes = await phase5DirectoryProcesses(directory);
    if (processes.length === 0) {
      consecutiveEmptyScans += 1;
      if (consecutiveEmptyScans >= PHASE5_DIRECTORY_EMPTY_SCANS) return;
    } else {
      consecutiveEmptyScans = 0;
      const newlyDiscoveredProcesses = processes.filter(
        (identity) => !interruptedProcesses.has(phase5ProcessIdentityKey(identity)),
      );
      await signalPhase5DirectoryProcesses(
        newlyDiscoveredProcesses,
        directory,
        "SIGINT",
      );
      for (const identity of newlyDiscoveredProcesses) {
        interruptedProcesses.add(phase5ProcessIdentityKey(identity));
      }

      if (Date.now() >= termAt) {
        const unterminatedProcesses = processes.filter(
          (identity) => !terminatedProcesses.has(phase5ProcessIdentityKey(identity)),
        );
        await signalPhase5DirectoryProcesses(
          unterminatedProcesses,
          directory,
          "SIGTERM",
        );
        for (const identity of unterminatedProcesses) {
          terminatedProcesses.add(phase5ProcessIdentityKey(identity));
        }
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Phase 5 directory-owned processes did not stop: ${processes.map(({ pid }) => pid).join(",")}`,
      );
    }
    await delay(500);
  }
}

async function phase5DirectoryProcesses(
  directory: string,
): Promise<readonly Phase5ProcessIdentity[]> {
  const resolvedDirectory = path.resolve(directory);
  const processes: Phase5ProcessIdentity[] = [];
  for (const entry of await readdir("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    try {
      const [commandBytes, cwdValue, stat] = await Promise.all([
        readFile(`/proc/${entry.name}/cmdline`),
        readlink(`/proc/${entry.name}/cwd`),
        readFile(`/proc/${entry.name}/stat`, "utf8"),
      ]);
      const command = commandBytes.toString("utf8");
      const cwd = path.resolve(cwdValue);
      if (
        cwd !== resolvedDirectory &&
        !cwd.startsWith(`${resolvedDirectory}${path.sep}`) &&
        !phase5CommandLaunchPathMatches(command, resolvedDirectory)
      ) {
        continue;
      }
      const identity = phase5ProcessIdentityFromStat(Number(entry.name), stat);
      if (identity.pid > 1) processes.push(identity);
    } catch {
      // The process can exit between /proc reads.
    }
  }
  return processes.sort((left, right) => right.pid - left.pid);
}

async function signalPhase5DirectoryProcesses(
  identities: readonly Phase5ProcessIdentity[],
  directory: string,
  signal: NodeJS.Signals,
): Promise<void> {
  for (const identity of identities) {
    if (!(await assertPhase5DirectoryProcessScope(identity, directory))) continue;
    try {
      process.kill(identity.pid, signal);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

async function assertPhase5DirectoryProcessScope(
  identity: Phase5ProcessIdentity,
  directory: string,
): Promise<boolean> {
  const resolvedDirectory = path.resolve(directory);
  try {
    const [commandBytes, cwdValue, stat] = await Promise.all([
      readFile(`/proc/${String(identity.pid)}/cmdline`),
      readlink(`/proc/${String(identity.pid)}/cwd`),
      readFile(`/proc/${String(identity.pid)}/stat`, "utf8"),
    ]);
    const current = phase5ProcessIdentityFromStat(identity.pid, stat);
    if (current.procStatStartTimeTicks !== identity.procStatStartTimeTicks) {
      return false;
    }
    const command = commandBytes.toString("utf8");
    const cwd = path.resolve(cwdValue);
    if (
      cwd !== resolvedDirectory &&
      !cwd.startsWith(`${resolvedDirectory}${path.sep}`) &&
      !phase5CommandLaunchPathMatches(command, resolvedDirectory)
    ) {
      throw new Error(
        `refusing to signal process ${String(identity.pid)} outside ${resolvedDirectory}`,
      );
    }
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function phase5ProcessIdentityKey(identity: Phase5ProcessIdentity): string {
  return `${String(identity.pid)}:${identity.procStatStartTimeTicks}`;
}

export function phase5ProcessIdentityFromStat(
  pid: number,
  stat: string,
): Phase5ProcessIdentity {
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd < 0) throw new Error("invalid /proc stat record");
  const fields = stat.slice(commandEnd + 2).trim().split(/\s+/u);
  const procStatStartTimeTicks = fields[19];
  if (!Number.isInteger(pid) || pid <= 1 || procStatStartTimeTicks === undefined) {
    throw new Error("invalid Phase 5 process identity");
  }
  return { pid, procStatStartTimeTicks };
}

export function parseCacheOutputCounts(log: string): Readonly<Record<string, number | boolean>> {
  const numeric = (label: string): number => {
    const match = new RegExp(`^\\s*- ${label}: (\\d+)\\s*$`, "mu").exec(log);
    return Number(match?.[1] ?? 0);
  };
  const presence = (label: string): boolean =>
    new RegExp(`^\\s*- ${label}: Yes(?: \\([^)]*\\))?\\s*$`, "mu").test(log);
  return {
    backgroundImagesMetadata: presence("Background Images Metadata"),
    colors: numeric("Colors"),
    coreFreeSlideIds: numeric("Core Free Slide IDs"),
    editorStyles: numeric("Editor Styles"),
    fontPairs: numeric("Font Pairs"),
    fonts: numeric("Fonts"),
    iconLibraries: numeric("Icon Libraries"),
    legacyTemplatesMetadata: presence("Legacy Templates Metadata"),
    tags: numeric("Tags"),
    themeMetadata: presence("Theme Metadata"),
    unsplashTopics: numeric("Unsplash Topics"),
  };
}

export function cacheOutputDigest(counts: Readonly<Record<string, number | boolean>>): string {
  return createHash("sha256").update(JSON.stringify(counts)).digest("hex");
}

export function phase5ReadinessConditions(
  input: StackLaunchInput,
  baseUrl: string,
  twodartNetUrl: string,
): ReadinessCondition[] {
  const cachePath = "/v0/b/assets-local.twodart.com/o/cache%2Fmain-cache-local.json?alt=media";
  const storageAlias = new URL(baseUrl);
  storageAlias.hostname = storageAlias.hostname.replace("templates.", "storage.");
  const aliasCacheUrl = new URL(cachePath, storageAlias).href;
  const markers = [
    ["emulator", "firebase-emulator.log", "All emulators ready"],
    ["application", "firebase-cache-watch.log", "Smart watcher started successfully"],
    ["application", "templates.log", "Ready in"],
    ["application", "dotnet.log", "Now listening on:"],
  ] as const;
  return [
    ...markers.map(([group, name, pattern]): ReadinessCondition => ({
      id: `marker:${name}`, group, kind: "marker", target: pattern,
      check: async () => {
        try {
          const ready = (await readFile(path.join(input.directory, ".logs", name), "utf8")).includes(pattern);
          return { ready, outcome: ready ? "ready" : "not-ready" };
        } catch (error: unknown) {
          return { ready: false, outcome: "error", error: String(error) };
        }
      },
    })),
    ...Object.entries(input.ports).map(([name, port]): ReadinessCondition => ({
      id: `port:${name}`,
      group: name === "cacheWebsocket" || name === "mprocsControl" ? "application" : "emulator",
      kind: "port", target: `127.0.0.1:${String(port)}`,
      check: async () => {
        const ready = name === "mprocsControl" ? await listenerOpen(port) : await portOpen(port);
        return { ready, outcome: ready ? "ready" : "not-ready" };
      },
    })),
    {
      id: "probe:functions-inventory", group: "emulator", kind: "probe",
      target: `http://127.0.0.1:${String(input.ports.functions)}/backends`,
      check: async (signal) => phase5FetchProbe(`http://127.0.0.1:${String(input.ports.functions)}/backends`, signal),
    },
    {
      id: "probe:emulator-hub", group: "emulator", kind: "probe",
      target: `http://127.0.0.1:${String(input.ports.hub)}/emulators`,
      check: async (signal) => phase5FetchProbe(`http://127.0.0.1:${String(input.ports.hub)}/emulators`, signal),
    },
    {
      id: "probe:frontend-login", group: "application", kind: "probe",
      target: new URL(PHASE5_LOGIN_ROUTE, baseUrl).href,
      check: async (signal) => phase5CurlProbe(new URL(PHASE5_LOGIN_ROUTE, baseUrl).href, PHASE5_FRONTEND_PROBE_SECONDS, signal),
    },
    {
      id: "probe:twodartnet-health", group: "application", kind: "probe",
      target: new URL(PHASE5_TWODARTNET_HEALTH_ROUTE, twodartNetUrl).href,
      check: async (signal) => phase5CurlProbe(new URL(PHASE5_TWODARTNET_HEALTH_ROUTE, twodartNetUrl).href, 8, signal),
    },
    ...[
      ["raw", `http://127.0.0.1:${String(input.ports.storage)}${cachePath}`],
      ["alias", aliasCacheUrl],
    ].map(([name, url]): ReadinessCondition => ({
      id: `probe:cache-json-${name}`, group: "application", kind: "probe", target: url!,
      check: async (signal) => phase5CacheJsonProbe(url!, signal),
    })),
    {
      id: "probe:storage-alias-registration", group: "application", kind: "probe",
      target: path.join(PHASE5_PORTLESS_STATE_DIRECTORY, "routes.json"),
      check: async () => {
        const routes: unknown = JSON.parse(await readFile(path.join(PHASE5_PORTLESS_STATE_DIRECTORY, "routes.json"), "utf8"));
        const ready = phase5StorageAliasRegistered(routes, storageAlias.hostname, input.ports.storage);
        return { ready, outcome: ready ? "ready" : "not-ready", error: ready ? null : `Missing Storage alias ${storageAlias.hostname} -> ${String(input.ports.storage)}` };
      },
    },
  ];
}

export function phase5StorageAliasRegistered(routes: unknown, hostname: string, port: number): boolean {
  return Array.isArray(routes) && routes.some((route: { hostname?: unknown; port?: unknown }) =>
    route.hostname === hostname && route.port === port);
}

export async function waitForPhase5FrontendReady(
  baseUrl: string,
  maximumReadySeconds: number,
  evidence: { readonly ledgerPath: string; readonly summaryPath: string },
): Promise<Phase5FrontendReadiness> {
  const loginUrl = new URL(PHASE5_LOGIN_ROUTE, baseUrl).href;
  const result = await waitForPhase5Readiness({
    conditions: [{
      id: "probe:frontend-login", group: "application", kind: "probe", target: loginUrl,
      check: async (signal) => phase5CurlProbe(loginUrl, PHASE5_FRONTEND_PROBE_SECONDS, signal),
    }],
    startedAt: Date.now(),
    allowances: { emulator: maximumReadySeconds, application: maximumReadySeconds },
    diagnosticFailFast: false,
    checkHealth: async () => {},
    ...evidence,
  });
  const status = result.conditions[0]?.result?.status;
  if (status === undefined || status === null) throw new Error("ready frontend omitted HTTP status");
  return { readyMilliseconds: result.elapsedMilliseconds, status };
}

export async function readPhase5PortEnvironment(
  directory: string,
): Promise<Readonly<Record<string, string>>> {
  const contents = await readFile(path.join(directory, ".env.ports"), "utf8");
  return Object.fromEntries(
    contents
      .split("\n")
      .map((line) => /^(?:export\s+)?([A-Z0-9_]+)=(.*)$/u.exec(line.trim()))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => {
        const key = match[1] ?? "";
        const raw = match[2] ?? "";
        const value =
          (raw.startsWith('"') && raw.endsWith('"')) ||
          (raw.startsWith("'") && raw.endsWith("'"))
            ? raw.slice(1, -1)
            : raw;
        return [key, value];
      }),
  );
}

function requiredEnvironment(
  environment: Readonly<Record<string, string>>,
  key: string,
): string {
  const value = environment[key];
  if (value === undefined || value.length === 0) {
    throw new Error(`Phase 5 stack environment omitted ${key}`);
  }
  return value;
}

async function processMetricsContaining(
  directory: string,
  needle: string,
): Promise<{ readonly pssBytes: number | null; readonly rssBytes: number }> {
  const entries = await readdir("/proc", { withFileTypes: true });
  let rssBytes = 0;
  let pssBytes: number | null = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    try {
      const [commandBytes, cwd] = await Promise.all([
        readFile(`/proc/${entry.name}/cmdline`),
        readlink(`/proc/${entry.name}/cwd`),
      ]);
      const command = commandBytes.toString("utf8");
      const resolvedDirectory = path.resolve(directory);
      const resolvedCwd = path.resolve(cwd);
      if (
        !command.includes(needle) ||
        (resolvedCwd !== resolvedDirectory &&
          !resolvedCwd.startsWith(`${resolvedDirectory}${path.sep}`))
      ) {
        continue;
      }
      const [status, smaps] = await Promise.all([
        readFile(`/proc/${entry.name}/status`, "utf8"),
        readFile(`/proc/${entry.name}/smaps_rollup`, "utf8").catch(() => ""),
      ]);
      rssBytes += statusKilobytes(status, "VmRSS") * 1_024;
      if (smaps.length === 0) pssBytes = null;
      else if (pssBytes !== null) pssBytes += statusKilobytes(smaps, "Pss") * 1_024;
    } catch {
      // A watched process can exit between /proc reads.
    }
  }
  return { pssBytes, rssBytes };
}

function statusKilobytes(contents: string, label: string): number {
  const match = new RegExp(`^${label}:\\s+(\\d+)\\s+kB$`, "mu").exec(contents);
  return Number(match?.[1] ?? 0);
}

function cacheErrorCount(log: string): number {
  return [
    /Initial cache build failed/gu,
    /Failed to rebuild cache/gu,
    /Error watching /gu,
    /Failed to start WebSocket server/gu,
  ].reduce((total, pattern) => total + [...log.matchAll(pattern)].length, 0);
}

async function portOpen(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolvePromise) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolvePromise(false);
    }, 500);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolvePromise(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolvePromise(false);
    });
  });
}

async function listenerOpen(port: number): Promise<boolean> {
  const result = await run("ss", ["-ltnH"]);
  if (result.exitCode !== 0) return false;
  return result.stdout.split("\n").some((line) => {
    const localAddress = line.trim().split(/\s+/u)[3];
    return localAddress?.endsWith(`:${String(port)}`) === true;
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function requireCommand(
  command: string,
  arguments_: readonly string[],
  label: string,
): Promise<void> {
  const result = await run(command, arguments_);
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed: ${result.stderr.trim()}`);
  }
}

async function run(
  command: string,
  arguments_: readonly string[],
): Promise<{ readonly exitCode: number | null; readonly stderr: string; readonly stdout: string }> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (exitCode) => resolvePromise({ exitCode, stderr, stdout }));
  });
}

async function assertAbsent(candidate: string): Promise<void> {
  if (await exists(candidate)) throw new Error(`Refusing to overwrite ${candidate}`);
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
