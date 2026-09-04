import { execFile } from "node:child_process";
import { readFile, readdir, readlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

export interface SwapHostState {
  readonly residualSwapBytes: number;
  readonly vmSwappiness: number;
  readonly configuredSwap: string;
}

interface DrainCommand {
  readonly command: "swapoff" | "swapon";
  readonly args: readonly ["-a"];
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SwapDrainDependencies {
  readonly assertQuiescent: () => Promise<void>;
  readonly readState: () => Promise<SwapHostState>;
  readonly run: (command: "swapoff" | "swapon") => Promise<DrainCommand>;
}

const execute = promisify(execFile);

export const PHASE5_QUIESCENCE_REQUIRED_EMPTY_SAMPLES = 3;
export const PHASE5_QUIESCENCE_SAMPLE_INTERVAL_MILLISECONDS = 250;
export const PHASE5_QUIESCENCE_MAXIMUM_WAIT_MILLISECONDS = 30_000;

export interface Phase5StackProcess {
  readonly pid: number;
  readonly parentPid: number;
  readonly elapsedMilliseconds: number;
  readonly commandName: string;
  readonly commandLine: string;
  readonly directory: string;
}

export interface Phase5ProcessQuiescenceSample {
  readonly observedAt: string;
  readonly activeProcesses: readonly Phase5StackProcess[];
}

export interface Phase5ProcessQuiescenceEvidence {
  readonly startedAt: string;
  readonly completedAt: string;
  readonly maximumWaitMilliseconds: number;
  readonly sampleIntervalMilliseconds: number;
  readonly requiredConsecutiveEmptySamples: number;
  readonly samples: readonly Phase5ProcessQuiescenceSample[];
  readonly passed: boolean;
}

export interface Phase5ProcessQuiescenceDependencies {
  readonly now: () => Date;
  readonly scan: () => Promise<readonly Phase5StackProcess[]>;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

export interface Phase5ProcessQuiescenceOptions {
  readonly maximumWaitMilliseconds?: number;
  readonly sampleIntervalMilliseconds?: number;
  readonly requiredConsecutiveEmptySamples?: number;
}

export class Phase5ProcessQuiescenceError extends Error {
  constructor(readonly evidence: Phase5ProcessQuiescenceEvidence) {
    const last = evidence.samples.at(-1)?.activeProcesses ?? [];
    super(`Refusing swap drain while Phase 5 stack processes remain active: ${JSON.stringify(last)}`);
    this.name = "Phase5ProcessQuiescenceError";
  }
}

export function phase5StackDirectoryMatches(directory: string, roots: readonly string[]): boolean {
  return roots.some((root) => directory === root || directory.startsWith(`${root}/`)) ||
    /^\/srv\/dev-fast\/runtime-data\/fireside-phase5-[^/]+\/(?:stack-(?:official|fireside)|(?:twodart-)?fresh-colleague)(?:\/|$)/u.test(directory);
}

let clockTicksPerSecond: number | undefined;

async function readClockTicksPerSecond(): Promise<number> {
  if (clockTicksPerSecond !== undefined) return clockTicksPerSecond;
  const result = await execute("getconf", ["CLK_TCK"]);
  const parsed = Number(result.stdout.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("Linux omitted CLK_TCK");
  clockTicksPerSecond = parsed;
  return parsed;
}

function processReadMayRace(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "EACCES" || code === "EPERM";
}

export async function snapshotPhase5StackProcesses(
  roots: readonly string[],
): Promise<readonly Phase5StackProcess[]> {
  const active: Phase5StackProcess[] = [];
  const uptimeSeconds = Number((await readFile("/proc/uptime", "utf8")).split(/\s+/u)[0]);
  if (!Number.isFinite(uptimeSeconds)) throw new Error("Linux omitted system uptime");
  for (const pid of (await readdir("/proc")).filter((name) => /^\d+$/u.test(name))) {
    let directory: string;
    try {
      directory = await readlink(`/proc/${pid}/cwd`);
    } catch (error: unknown) {
      if (processReadMayRace(error)) continue;
      throw error;
    }
    if (!phase5StackDirectoryMatches(directory, roots)) continue;
    try {
      const [status, commandName, commandLine, stat, ticksPerSecond] = await Promise.all([
        readFile(`/proc/${pid}/status`, "utf8"),
        readFile(`/proc/${pid}/comm`, "utf8"),
        readFile(`/proc/${pid}/cmdline`, "utf8"),
        readFile(`/proc/${pid}/stat`, "utf8"),
        readClockTicksPerSecond(),
      ]);
      const parentPid = Number(status.match(/^PPid:\s+(\d+)$/mu)?.[1]);
      const statTail = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/u);
      const startClockTicks = Number(statTail[19]);
      if (!Number.isInteger(parentPid) || !Number.isFinite(startClockTicks)) {
        throw new Error(`Linux omitted process identity fields for PID ${pid}`);
      }
      active.push({
        pid: Number(pid),
        parentPid,
        elapsedMilliseconds: Math.max(
          0,
          Math.round((uptimeSeconds - (startClockTicks / ticksPerSecond)) * 1_000),
        ),
        commandName: commandName.trim(),
        commandLine: commandLine.replace(/\0/gu, " ").trim(),
        directory,
      });
    } catch (error: unknown) {
      if (processReadMayRace(error)) continue;
      throw error;
    }
  }
  return active.sort((left, right) => left.pid - right.pid);
}

export async function assertNoPhase5StackProcesses(roots: readonly string[]): Promise<void> {
  const active = await snapshotPhase5StackProcesses(roots);
  if (active.length > 0) {
    throw new Error(`Refusing swap drain while Phase 5 stack processes are active: ${JSON.stringify(active)}`);
  }
}

export async function waitForPhase5StackQuiescence(
  roots: readonly string[],
  options: Phase5ProcessQuiescenceOptions = {},
  suppliedDependencies: Partial<Phase5ProcessQuiescenceDependencies> = {},
): Promise<Phase5ProcessQuiescenceEvidence> {
  const maximumWaitMilliseconds = options.maximumWaitMilliseconds ??
    PHASE5_QUIESCENCE_MAXIMUM_WAIT_MILLISECONDS;
  const sampleIntervalMilliseconds = options.sampleIntervalMilliseconds ??
    PHASE5_QUIESCENCE_SAMPLE_INTERVAL_MILLISECONDS;
  const requiredConsecutiveEmptySamples = options.requiredConsecutiveEmptySamples ??
    PHASE5_QUIESCENCE_REQUIRED_EMPTY_SAMPLES;
  if (
    !Number.isInteger(maximumWaitMilliseconds) || maximumWaitMilliseconds < 0 ||
    !Number.isInteger(sampleIntervalMilliseconds) || sampleIntervalMilliseconds <= 0 ||
    !Number.isInteger(requiredConsecutiveEmptySamples) || requiredConsecutiveEmptySamples <= 0
  ) {
    throw new Error("Phase 5 quiescence wait must be nonnegative and sample counts must be positive integers");
  }
  const dependencies: Phase5ProcessQuiescenceDependencies = {
    now: suppliedDependencies.now ?? (() => new Date()),
    scan: suppliedDependencies.scan ?? (() => snapshotPhase5StackProcesses(roots)),
    sleep: suppliedDependencies.sleep ?? (async (milliseconds) => delay(milliseconds)),
  };
  const startedAt = dependencies.now();
  const samples: Phase5ProcessQuiescenceSample[] = [];
  let consecutiveEmptySamples = 0;
  while (true) {
    const activeProcesses = await dependencies.scan();
    const observedAt = dependencies.now();
    samples.push({ observedAt: observedAt.toISOString(), activeProcesses });
    consecutiveEmptySamples = activeProcesses.length === 0 ? consecutiveEmptySamples + 1 : 0;
    if (consecutiveEmptySamples >= requiredConsecutiveEmptySamples) {
      return {
        startedAt: startedAt.toISOString(),
        completedAt: observedAt.toISOString(),
        maximumWaitMilliseconds,
        sampleIntervalMilliseconds,
        requiredConsecutiveEmptySamples,
        samples,
        passed: true,
      };
    }
    const elapsedMilliseconds = observedAt.getTime() - startedAt.getTime();
    if (elapsedMilliseconds >= maximumWaitMilliseconds) {
      throw new Phase5ProcessQuiescenceError({
        startedAt: startedAt.toISOString(),
        completedAt: observedAt.toISOString(),
        maximumWaitMilliseconds,
        sampleIntervalMilliseconds,
        requiredConsecutiveEmptySamples,
        samples,
        passed: false,
      });
    }
    await dependencies.sleep(Math.min(
      sampleIntervalMilliseconds,
      maximumWaitMilliseconds - elapsedMilliseconds,
    ));
  }
}

export async function readPhase5SwapHostState(): Promise<SwapHostState> {
  const [memory, swappiness, configuredSwap] = await Promise.all([
    readFile("/proc/meminfo", "utf8"),
    readFile("/proc/sys/vm/swappiness", "utf8"),
    readFile("/proc/swaps", "utf8"),
  ]);
  const kib = (name: string): number => {
    const value = memory.match(new RegExp(`^${name}:\\s+(\\d+) kB$`, "mu"))?.[1];
    if (value === undefined) throw new Error(`Host omitted ${name}`);
    return Number(value);
  };
  const vmSwappiness = Number(swappiness.trim());
  if (!Number.isInteger(vmSwappiness)) throw new Error("Host omitted vm.swappiness");
  return {
    residualSwapBytes: (kib("SwapTotal") - kib("SwapFree")) * 1_024,
    vmSwappiness,
    configuredSwap,
  };
}

export async function runPhase5SwapCommand(command: "swapoff" | "swapon"): Promise<DrainCommand> {
  try {
    const result = await execute("sudo", ["-n", command, "-a"], { timeout: 120_000 });
    return { command, args: ["-a"], exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error: unknown) {
    const failure = error as { code?: unknown; stdout?: string; stderr?: string; message?: string };
    return {
      command, args: ["-a"],
      exitCode: typeof failure.code === "number" ? failure.code : null,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message ?? String(error),
    };
  }
}

/** Authorized v3 preflight only. Never invoke while a gate stack is running. */
export async function drainPhase5Swap(dependencies: SwapDrainDependencies) {
  await dependencies.assertQuiescent();
  const startedAt = new Date().toISOString();
  const before = await dependencies.readState();
  const commands: DrainCommand[] = [];
  try {
    commands.push(await dependencies.run("swapoff"));
  } finally {
    // Restore configured swap even when swapoff reports a partial failure.
    commands.push(await dependencies.run("swapon"));
  }
  const after = await dependencies.readState();
  return {
    startedAt,
    completedAt: new Date().toISOString(),
    authorization: "phase-5-schema-v3-quiescent-preflight",
    invocationPrefix: "sudo -n",
    before, after, commands,
    swappinessChanged: before.vmSwappiness !== after.vmSwappiness,
    passed: commands.length === 2 && commands.every(({ exitCode }) => exitCode === 0) &&
      before.vmSwappiness === after.vmSwappiness,
  };
}
