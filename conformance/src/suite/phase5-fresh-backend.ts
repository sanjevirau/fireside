import { createHash } from "node:crypto";
import { readFile, readlink, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  phase5CommandLaunchPathMatches,
  phase5EmulatorProcessMatches,
  phase5EmulatorProcesses,
  phase5ProcessIdentityFromStat,
  type Phase5ProcessIdentity,
  type Phase5StackName,
  type RunningPhase5Stack,
} from "./phase5-stack-control.ts";

interface BackendProcess extends Phase5ProcessIdentity {
  readonly command: string;
  readonly cwd: string;
  readonly backendOverride: string | null;
}

export interface Phase5FreshBackendObservation {
  readonly stack: Phase5StackName;
  readonly expectedOverride: "official" | null;
  readonly directory: string;
  readonly firesideBinary: string;
  readonly launchStartedAtMilliseconds: number;
  readonly serviceLogModifiedAtMilliseconds: number;
  readonly serviceLog: string;
  readonly processes: readonly BackendProcess[];
}

export function validatePhase5FreshBackend(observation: Phase5FreshBackendObservation): void {
  if (!Number.isFinite(observation.serviceLogModifiedAtMilliseconds) ||
      observation.serviceLogModifiedAtMilliseconds < observation.launchStartedAtMilliseconds) {
    throw new Error("Fresh backend service log is stale or has no modification time");
  }
  const marker = observation.stack === "fireside"
    ? `Fireside suite: ${observation.firesideBinary}`
    : "Firebase emulator runtime: Node ";
  if (!observation.serviceLog.includes(marker) || !observation.serviceLog.includes("All emulators ready")) {
    throw new Error(`Fresh ${observation.stack} service log lacks its actual launch/readiness markers`);
  }
  if (observation.processes.length !== 1) {
    throw new Error(`Fresh ${observation.stack} requires exactly one live emulator launch process`);
  }
  const process = observation.processes[0]!;
  if (!phase5EmulatorProcessMatches(observation.stack, process.command, observation.firesideBinary)) {
    throw new Error("Fresh backend process command does not match the exact selected backend");
  }
  const directory = path.resolve(observation.directory);
  const cwd = path.resolve(process.cwd);
  if (cwd !== directory && !cwd.startsWith(`${directory}${path.sep}`) &&
      !phase5CommandLaunchPathMatches(process.command, directory)) {
    throw new Error("Fresh backend process is outside the fresh checkout scope");
  }
  if (process.backendOverride !== observation.expectedOverride) {
    throw new Error(`Fresh backend override must be ${observation.expectedOverride ?? "absent"}`);
  }
}

async function readBackendProcess(identity: Phase5ProcessIdentity): Promise<BackendProcess> {
  const prefix = `/proc/${String(identity.pid)}`;
  const [command, cwd, environment] = await Promise.all([
    readFile(`${prefix}/cmdline`, "utf8"), readlink(`${prefix}/cwd`), readFile(`${prefix}/environ`, "utf8"),
  ]);
  const current = phase5ProcessIdentityFromStat(identity.pid, await readFile(`${prefix}/stat`, "utf8"));
  if (current.procStatStartTimeTicks !== identity.procStatStartTimeTicks) {
    throw new Error("Fresh backend process identity changed while observing it");
  }
  // Never persist the complete environment: inspect only this non-secret selector.
  const key = "TWODART_FIREBASE_BACKEND=";
  const selectors = environment.split("\0").filter((entry) => entry.startsWith(key));
  if (selectors.length > 1) throw new Error("Fresh backend has duplicate override entries");
  return { ...identity, command, cwd, backendOverride: selectors[0]?.slice(key.length) ?? null };
}

export async function recordPhase5FreshBackend(
  running: Pick<RunningPhase5Stack, "directory" | "stack" | "label" | "firesideBinary" | "launchStartedAtMilliseconds">,
  expectedOverride: "official" | null,
  evidenceDirectory: string,
): Promise<void> {
  const logPath = path.join(running.directory, ".logs", "firebase-emulator.log");
  const basename = `${running.stack}-${running.label}-backend`;
  const record: Record<string, unknown> = {
    stack: running.stack, expectedOverride, directory: running.directory,
    firesideBinary: running.firesideBinary,
    launchStartedAtMilliseconds: running.launchStartedAtMilliseconds,
  };
  let failure: Error | null = null;
  try {
    const serviceLog = await readFile(logPath);
    const logStat = await stat(logPath);
    // Each mprocs launch truncates its service log; preserve this launch now.
    await writeFile(path.join(evidenceDirectory, `${basename}.log`), serviceLog, { flag: "wx" });
    record.serviceLogModifiedAtMilliseconds = logStat.mtimeMs;
    record.serviceLogSha256 = createHash("sha256").update(serviceLog).digest("hex");
    const identities = await phase5EmulatorProcesses(running.directory, running.stack, running.firesideBinary);
    const processes = await Promise.all(identities.map(readBackendProcess));
    record.processes = processes;
    validatePhase5FreshBackend({
      stack: running.stack, expectedOverride, directory: running.directory,
      firesideBinary: running.firesideBinary,
      launchStartedAtMilliseconds: running.launchStartedAtMilliseconds,
      serviceLogModifiedAtMilliseconds: logStat.mtimeMs,
      serviceLog: serviceLog.toString("utf8"), processes,
    });
  }
  catch (error: unknown) { failure = error instanceof Error ? error : new Error(String(error)); }
  await writeFile(path.join(evidenceDirectory, `${basename}.json`), `${JSON.stringify({
    ...record, schemaVersion: 1, observedAt: new Date().toISOString(), sourceLog: logPath,
    passed: failure === null, error: failure?.message ?? null,
  }, null, 2)}\n`, { flag: "wx" });
  if (failure !== null) throw failure;
}
