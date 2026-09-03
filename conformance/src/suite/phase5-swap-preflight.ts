import { execFile } from "node:child_process";
import { readFile, readdir, readlink } from "node:fs/promises";
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

export function phase5StackDirectoryMatches(directory: string, roots: readonly string[]): boolean {
  return roots.some((root) => directory === root || directory.startsWith(`${root}/`)) ||
    /^\/srv\/dev-fast\/runtime-data\/fireside-phase5-[^/]+\/(?:stack-(?:official|fireside)|(?:twodart-)?fresh-colleague)(?:\/|$)/u.test(directory);
}

export async function assertNoPhase5StackProcesses(roots: readonly string[]): Promise<void> {
  const active: { pid: number; directory: string }[] = [];
  for (const pid of (await readdir("/proc")).filter((name) => /^\d+$/u.test(name))) {
    let directory: string;
    try {
      directory = await readlink(`/proc/${pid}/cwd`);
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EACCES") continue;
      throw error;
    }
    if (phase5StackDirectoryMatches(directory, roots)) active.push({ pid: Number(pid), directory });
  }
  if (active.length > 0) {
    throw new Error(`Refusing swap drain while Phase 5 stack processes are active: ${JSON.stringify(active)}`);
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
