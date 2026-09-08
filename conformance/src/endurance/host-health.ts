import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);

export const RECENT_SSH_WINDOW_SECONDS = 300;
export const MAX_RECENT_SSH_ACCEPTS = 30;
export const MAX_RECENT_SSH_ACCEPTS_PER_MINUTE = 6;

const OOM_PATTERN = /(?:invoked oom-killer|out of memory|killed process \d+|oom_reaper|memory cgroup out of memory)/iu;
const HOST_RESOURCE_FAILURE_PATTERN = /(?:failed to spawn executor|failed to fork|fork.*resource temporarily unavailable|cannot allocate memory|input\/output error|buffer i\/o error|read-only file system|no space left on device)/iu;
const ACCEPTED_SSH_PATTERN = /Accepted (?:publickey|password|keyboard-interactive)/u;

export interface ControlledHostHealthInput {
  readonly bootId: string;
  readonly uptimeSeconds: number;
  readonly sshServiceState: string;
  readonly kernelJournal: string;
  readonly errorJournal: string;
  readonly sshJournal: string;
  readonly failedUnits: string;
}

export interface ControlledHostHealth {
  readonly bootId: string;
  readonly uptimeSeconds: number;
  readonly sshServiceState: string;
  readonly failedUnits: readonly string[];
  readonly kernelOomEvidence: readonly string[];
  readonly hostResourceFailureEvidence: readonly string[];
  readonly recentSshWindowSeconds: number;
  readonly recentSshAcceptedSessions: number;
  readonly recentSshAcceptedSessionsPerMinute: number;
}

export async function preflightControlledHostHealth(): Promise<ControlledHostHealth> {
  const [
    bootId,
    uptime,
    sshServiceState,
    kernelJournal,
    errorJournal,
    sshJournal,
    failedUnits,
  ] = await Promise.all([
    readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    readFile("/proc/uptime", "utf8"),
    command("systemctl", ["show", "--property=ActiveState", "--value", "ssh.service"]),
    privilegedJournal(["-b", "-k"]),
    privilegedJournal(["-b", "-p", "err"]),
    privilegedJournal([
      "-b",
      "-u",
      "ssh.service",
      "--since",
      `-${String(RECENT_SSH_WINDOW_SECONDS)}seconds`,
    ]),
    command("systemctl", ["--failed", "--no-legend", "--plain"]),
  ]);
  const uptimeSeconds = Number.parseFloat(uptime.split(/\s+/u)[0] ?? "");
  if (!Number.isFinite(uptimeSeconds) || uptimeSeconds < 0) {
    throw new Error(`invalid /proc/uptime value: ${JSON.stringify(uptime)}`);
  }
  const health = evaluateControlledHostHealth({
    bootId: bootId.trim(),
    uptimeSeconds,
    sshServiceState: sshServiceState.trim(),
    kernelJournal,
    errorJournal,
    sshJournal,
    failedUnits,
  });
  assertControlledHostHealth(health);
  return health;
}

export function evaluateControlledHostHealth(
  input: ControlledHostHealthInput,
): ControlledHostHealth {
  const recentSshWindowSeconds = Math.min(
    RECENT_SSH_WINDOW_SECONDS,
    Math.max(1, input.uptimeSeconds),
  );
  const recentSshAcceptedSessions = lines(input.sshJournal)
    .filter((line) => ACCEPTED_SSH_PATTERN.test(line)).length;
  return {
    bootId: input.bootId,
    uptimeSeconds: input.uptimeSeconds,
    sshServiceState: input.sshServiceState,
    failedUnits: lines(input.failedUnits),
    kernelOomEvidence: lines(input.kernelJournal)
      .filter((line) => OOM_PATTERN.test(line)),
    hostResourceFailureEvidence: lines(input.errorJournal)
      .filter((line) => HOST_RESOURCE_FAILURE_PATTERN.test(line)),
    recentSshWindowSeconds,
    recentSshAcceptedSessions,
    recentSshAcceptedSessionsPerMinute:
      recentSshAcceptedSessions * 60 / recentSshWindowSeconds,
  };
}

export function assertControlledHostHealth(health: ControlledHostHealth): void {
  const failures: string[] = [];
  if (health.sshServiceState !== "active") {
    failures.push(`ssh.service is ${JSON.stringify(health.sshServiceState)}`);
  }
  if (health.failedUnits.length > 0) {
    failures.push(`failed systemd units: ${health.failedUnits.join("; ")}`);
  }
  if (health.kernelOomEvidence.length > 0) {
    failures.push(`current boot contains OOM evidence: ${health.kernelOomEvidence.join("; ")}`);
  }
  if (health.hostResourceFailureEvidence.length > 0) {
    failures.push(
      `current boot contains host resource failures: ${health.hostResourceFailureEvidence.join("; ")}`,
    );
  }
  if (
    health.recentSshAcceptedSessions > MAX_RECENT_SSH_ACCEPTS
    || (
      health.recentSshAcceptedSessions >= 10
      && health.recentSshAcceptedSessionsPerMinute
        > MAX_RECENT_SSH_ACCEPTS_PER_MINUTE
    )
  ) {
    failures.push(
      `recent SSH login churn is unsafe: ${String(health.recentSshAcceptedSessions)} accepted sessions in ${String(health.recentSshWindowSeconds)} seconds (${health.recentSshAcceptedSessionsPerMinute.toFixed(2)}/minute)`,
    );
  }
  if (failures.length > 0) {
    throw new Error(`controlled host preflight failed: ${failures.join(" | ")}`);
  }
}

async function privilegedJournal(arguments_: readonly string[]): Promise<string> {
  return await command("sudo", [
    "-n",
    "journalctl",
    ...arguments_,
    "--no-pager",
    "--output=short-iso",
  ]);
}

async function command(commandName: string, arguments_: readonly string[]): Promise<string> {
  const result = await execute(commandName, arguments_, { maxBuffer: 8 * 1_024 * 1_024 });
  return `${result.stdout}${result.stderr}`;
}

function lines(contents: string): string[] {
  return contents.split("\n").map((line) => line.trim()).filter(Boolean);
}
