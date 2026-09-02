import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  readlink,
} from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import type { Phase5StackPorts } from "./phase5-host-prepare.ts";

export type Phase5StackName = "official" | "fireside";

export const PHASE5_EXPORT_SHUTDOWN_SECONDS = 600;
export const PHASE5_DIRECTORY_REAP_SECONDS = 60;
export const PHASE5_OFFICIAL_JAVA_TOOL_OPTIONS = "-Xmx8g";
export const PHASE5_LOGIN_ROUTE = "/login/overview";
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
  readonly stack: Phase5StackName;
  readonly tmuxSession: string;
  readonly twodartNetUrl: string;
}

export interface StoppedPhase5Stack {
  readonly exportMetadataPresent: boolean;
  readonly exitCode: number;
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

export function renderPhase5StackCommand(input: StackLaunchInput): string {
  const exactPath = [
    path.join(input.javaHome, "bin"),
    path.dirname(input.nodeBinary),
    "/home/sanjevi/.local/share/mise/installs/bun/1.3.14/bin",
    "/home/sanjevi/.local/share/mise/installs/dotnet/10.0.301",
    "/home/sanjevi/.local/share/mise/installs/python/3.14.6/bin",
    "/home/sanjevi/.local/share/mise/installs/rust/1.98.0/bin",
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
  maximumReadySeconds: number,
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
  await requireCommand(
    "tmux",
    ["send-keys", "-t", input.tmuxSession, "Enter"],
    "execute Phase 5 launch command",
  );

  try {
    const env = await readPhase5PortEnvironment(input.directory);
    const baseUrl = requiredEnvironment(env, "FE_URL");
    const twodartNetUrl = requiredEnvironment(env, "TWODARTNET_API_URL");
    const started = performance.now();
    let peakRssBytes = 0;
    let peakPssBytes: number | null = 0;
    let emulatorProcessObserved = false;
    const deadline = Date.now() + maximumReadySeconds * 1_000;
    while (true) {
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

      const ready = await stackReady(input, baseUrl, twodartNetUrl);
      if (ready) break;
      if (await exists(exitMarker)) {
        const status = (await readFile(exitMarker, "utf8")).trim();
        throw new Error(`${input.stack} exited before readiness with status ${status}`);
      }
      if (Date.now() >= deadline) {
        throw new Error(`${input.stack} exceeded ${String(maximumReadySeconds)} seconds to ready`);
      }
      await delay(1_000);
    }
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
      readyMilliseconds: performance.now() - started,
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
      stack: input.stack,
      tmuxSession: input.tmuxSession,
      twodartNetUrl,
    };
  } catch (error: unknown) {
    try {
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

export async function stopPhase5Stack(
  running: RunningPhase5Stack,
  maximumShutdownSeconds: number,
): Promise<StoppedPhase5Stack> {
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
  return {
    exitCode,
    exportMetadataPresent,
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
  await reapPhase5DirectoryProcessGroups(
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
  } else if ((await run("tmux", ["has-session", "-t", input.tmuxSession])).exitCode === 0) {
    await requireCommand(
      "tmux",
      ["kill-session", "-t", input.tmuxSession],
      "close failed Phase 5 startup session",
    );
  }
  await reapPhase5DirectoryProcessGroups(
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
        !command.includes(resolvedDirectory)
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
      !command.includes(resolvedDirectory)
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

async function reapPhase5DirectoryProcessGroups(
  directory: string,
  maximumSeconds: number,
): Promise<void> {
  let groups = await phase5DirectoryProcessGroups(directory);
  if (groups.length === 0) return;
  for (const group of groups) await assertPhase5ProcessGroupScope(group, directory);
  signalPhase5Groups(groups, "SIGINT");

  const started = Date.now();
  const termAt = started + Math.floor((maximumSeconds * 1_000) / 2);
  const deadline = started + maximumSeconds * 1_000;
  let termSent = false;
  while ((groups = await phase5DirectoryProcessGroups(directory)).length > 0) {
    if (!termSent && Date.now() >= termAt) {
      for (const group of groups) await assertPhase5ProcessGroupScope(group, directory);
      signalPhase5Groups(groups, "SIGTERM");
      termSent = true;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Phase 5 directory-owned process groups did not stop: ${groups.join(",")}`,
      );
    }
    await delay(500);
  }
}

async function phase5DirectoryProcessGroups(directory: string): Promise<readonly number[]> {
  const resolvedDirectory = path.resolve(directory);
  const groups = new Set<number>();
  for (const entry of await readdir("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    try {
      const cwd = path.resolve(await readlink(`/proc/${entry.name}/cwd`));
      if (cwd !== resolvedDirectory && !cwd.startsWith(`${resolvedDirectory}${path.sep}`)) {
        continue;
      }
      const group = processGroupFromStat(await readFile(`/proc/${entry.name}/stat`, "utf8"));
      if (group > 1) groups.add(group);
    } catch {
      // The process can exit between /proc reads.
    }
  }
  return [...groups].sort((left, right) => left - right);
}

function signalPhase5Groups(groups: readonly number[], signal: NodeJS.Signals): void {
  for (const group of groups) {
    try {
      process.kill(-group, signal);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

async function assertPhase5ProcessGroupScope(
  group: number,
  directory: string,
): Promise<void> {
  const resolvedDirectory = path.resolve(directory);
  let members = 0;
  for (const entry of await readdir("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    try {
      const stat = await readFile(`/proc/${entry.name}/stat`, "utf8");
      if (processGroupFromStat(stat) !== group) continue;
      members += 1;
      const [commandBytes, cwdValue] = await Promise.all([
        readFile(`/proc/${entry.name}/cmdline`),
        readlink(`/proc/${entry.name}/cwd`),
      ]);
      const command = commandBytes.toString("utf8");
      const cwd = path.resolve(cwdValue);
      if (
        cwd !== resolvedDirectory &&
        !cwd.startsWith(`${resolvedDirectory}${path.sep}`) &&
        !command.includes(resolvedDirectory)
      ) {
        throw new Error(
          `refusing to signal process group ${String(group)} outside ${resolvedDirectory}`,
        );
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (members === 0) {
    throw new Error(`emulator process group ${String(group)} disappeared before shutdown`);
  }
}

function processGroupFromStat(stat: string): number {
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd < 0) return 0;
  const fields = stat.slice(commandEnd + 2).trim().split(/\s+/u);
  return Number(fields[2] ?? 0);
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

async function stackReady(
  input: StackLaunchInput,
  baseUrl: string,
  twodartNetUrl: string,
): Promise<boolean> {
  const logs = await Promise.all(
    [
      ["firebase-emulator.log", "All emulators ready"],
      ["firebase-cache-watch.log", "Smart watcher started successfully"],
      ["templates.log", "Ready in"],
      ["dotnet.log", "Now listening on:"],
    ].map(async ([name, pattern]) => {
      if (name === undefined || pattern === undefined) return false;
      try {
        return (await readFile(path.join(input.directory, ".logs", name), "utf8")).includes(pattern);
      } catch {
        return false;
      }
    }),
  );
  if (!logs.every(Boolean)) return false;
  const portsReady = await Promise.all(
    Object.entries(input.ports).map(async ([name, port]) =>
      name === "mprocsControl" ? listenerOpen(port) : portOpen(port),
    ),
  );
  if (!portsReady.every(Boolean)) return false;
  const [functions, hub, frontend, dotnet] = await Promise.all([
    fetchOk(`http://127.0.0.1:${String(input.ports.functions)}/backends`),
    fetchOk(`http://127.0.0.1:${String(input.ports.hub)}/emulators`),
    curlOk(new URL(PHASE5_LOGIN_ROUTE, baseUrl).href),
    curlOk(new URL(PHASE5_TWODARTNET_HEALTH_ROUTE, twodartNetUrl).href),
  ]);
  return functions && hub && frontend && dotnet;
}

async function curlOk(url: string): Promise<boolean> {
  const status = await curlStatus(url);
  return status !== null && status >= 200 && status < 400;
}

async function curlStatus(url: string): Promise<number | null> {
  const result = await run("curl", [
    "--connect-timeout",
    "3",
    "--max-time",
    "8",
    "-k",
    "-sS",
    "-o",
    "/dev/null",
    "-w",
    "%{http_code}",
    url,
  ]);
  if (result.exitCode !== 0) return null;
  const status = Number(result.stdout.trim());
  return Number.isInteger(status) ? status : null;
}

export async function waitForPhase5FrontendReady(
  baseUrl: string,
  maximumReadySeconds: number,
): Promise<Phase5FrontendReadiness> {
  const started = performance.now();
  const deadline = Date.now() + maximumReadySeconds * 1_000;
  const loginUrl = new URL(PHASE5_LOGIN_ROUTE, baseUrl).href;
  let lastStatus: number | null = null;
  while (true) {
    lastStatus = await curlStatus(loginUrl);
    if (lastStatus !== null && lastStatus >= 200 && lastStatus < 400) {
      return {
        readyMilliseconds: performance.now() - started,
        status: lastStatus,
      };
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Phase 5 frontend ${PHASE5_LOGIN_ROUTE} did not become ready; last status ${lastStatus === null ? "unavailable" : String(lastStatus)}`,
      );
    }
    await delay(1_000);
  }
}

async function fetchOk(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    return response.ok;
  } catch {
    return false;
  }
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
