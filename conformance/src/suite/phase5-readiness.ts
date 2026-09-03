import { spawn } from "node:child_process";
import { appendFile, writeFile } from "node:fs/promises";

export const PHASE5_DIAGNOSTIC_DEFINITIVE_ERROR_SAMPLES = 3;
export const PHASE5_FRONTEND_PROBE_SECONDS = 30;
export type ReadinessGroup = "emulator" | "application";
export type ReadinessKind = "marker" | "port" | "probe";

export interface ReadinessObservation {
  readonly ready: boolean;
  readonly outcome: "ready" | "not-ready" | "http" | "timeout" | "error";
  readonly status?: number | null;
  readonly error?: string | null;
}

export interface ReadinessCondition {
  readonly id: string;
  readonly group: ReadinessGroup;
  readonly kind: ReadinessKind;
  readonly target: string;
  readonly check: (signal: AbortSignal) => Promise<ReadinessObservation>;
}

export interface ReadinessAllowance {
  readonly emulator: number;
  readonly application: number;
}

interface ConditionState {
  readonly id: string;
  readonly group: ReadinessGroup;
  readonly kind: ReadinessKind;
  readonly target: string;
  attempts: number;
  pending: boolean;
  attemptStartedAt: string | null;
  observedAt: string | null;
  elapsedMilliseconds: number | null;
  firstReadyAt: string | null;
  firstReadyMilliseconds: number | null;
  result: ReadinessObservation | null;
}

/** Pure policy: all condition clocks use the same launch origin, never a probe's start. */
export class Phase5ReadinessTracker {
  readonly states: ConditionState[];
  readonly groupReadyMilliseconds: Record<ReadinessGroup, number | null> = {
    emulator: null, application: null,
  };
  private previousDefinitiveError: string | null = null;
  private previousErrorObservation: string | null = null;
  private consecutiveDefinitiveErrors = 0;

  constructor(
    conditions: readonly ReadinessCondition[],
    readonly startedAt: number,
    readonly allowances: ReadinessAllowance,
  ) {
    if (conditions.length === 0 || new Set(conditions.map(({ id }) => id)).size !== conditions.length) {
      throw new Error("readiness requires unique, nonempty conditions");
    }
    for (const seconds of Object.values(allowances)) {
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("invalid readiness allowance");
    }
    this.states = conditions.map(({ id, group, kind, target }) => ({
      id, group, kind, target, attempts: 0, pending: false, attemptStartedAt: null,
      observedAt: null, elapsedMilliseconds: null, firstReadyAt: null,
      firstReadyMilliseconds: null, result: null,
    }));
  }

  begin(id: string, now: number): void {
    const state = this.state(id);
    state.attempts += 1;
    state.pending = true;
    state.attemptStartedAt = new Date(now).toISOString();
  }

  observe(id: string, result: ReadinessObservation, now: number): void {
    const state = this.state(id);
    state.pending = false;
    state.result = result;
    state.observedAt = new Date(now).toISOString();
    state.elapsedMilliseconds = now - this.startedAt;
    if (result.ready && state.firstReadyAt === null) {
      state.firstReadyAt = state.observedAt;
      state.firstReadyMilliseconds = state.elapsedMilliseconds;
    }
    const groupStates = this.states.filter(({ group }) => group === state.group);
    if (this.groupReadyMilliseconds[state.group] === null &&
        groupStates.every(({ result: observation }) => observation?.ready === true)) {
      this.groupReadyMilliseconds[state.group] = now - this.startedAt;
    }
  }

  sample(now: number, diagnosticFailFast: boolean) {
    const elapsedMilliseconds = now - this.startedAt;
    const unmetConditions = this.states.filter(({ result }) => result?.ready !== true).map(({ id }) => id);
    const expiredGroups = (Object.keys(this.allowances) as ReadinessGroup[]).filter((group) => {
      if (!this.states.some((state) => state.group === group)) return false;
      const readyAt = this.groupReadyMilliseconds[group];
      const maximum = this.allowances[group] * 1_000;
      return readyAt === null ? elapsedMilliseconds >= maximum : readyAt > maximum;
    });
    // A group that became ready and subsequently regressed cannot wait forever.
    if (elapsedMilliseconds >= this.allowances.application * 1_000 && unmetConditions.length > 0) {
      for (const state of this.states.filter(({ result }) => result?.ready !== true)) {
        if (!expiredGroups.includes(state.group)) expiredGroups.push(state.group);
      }
    }
    let failure: string | null = null;
    if (expiredGroups.length > 0) {
      const conditions = this.states.filter((state) => expiredGroups.includes(state.group) &&
        (state.result?.ready !== true || state.firstReadyMilliseconds === null ||
          state.firstReadyMilliseconds > this.allowances[state.group] * 1_000));
      // Include group conditions if each passed separately but never together in time.
      const names = conditions.length > 0 ? conditions : this.states.filter((state) => expiredGroups.includes(state.group));
      failure = `readiness deadline exceeded (${expiredGroups.map((group) => `${group}: ${String(this.allowances[group])} seconds`).join(", ")}); unmet or late conditions: ${names.map(({ id }) => id).join(", ")}`;
    }
    const healthy = this.states.filter(({ kind }) => kind !== "probe").every(({ result }) => result?.ready === true);
    const definitive = healthy ? this.states.find(({ kind, result }) => kind === "probe" &&
      result?.status !== null && result?.status !== undefined && result.status >= 400) : undefined;
    if (diagnosticFailFast && definitive !== undefined) {
      const fingerprint = `${definitive.id} returned ${String(definitive.result?.status)}`;
      const observation = `${definitive.id}:${definitive.observedAt}`;
      if (observation !== this.previousErrorObservation) {
        this.consecutiveDefinitiveErrors = fingerprint === this.previousDefinitiveError
          ? this.consecutiveDefinitiveErrors + 1 : 1;
        this.previousDefinitiveError = fingerprint;
        this.previousErrorObservation = observation;
      }
      if (this.consecutiveDefinitiveErrors >= PHASE5_DIAGNOSTIC_DEFINITIVE_ERROR_SAMPLES) {
        failure ??= `definitive readiness failure after ${String(this.consecutiveDefinitiveErrors)} identical samples: ${fingerprint}`;
      }
    } else {
      this.previousDefinitiveError = null;
      this.previousErrorObservation = null;
      this.consecutiveDefinitiveErrors = 0;
    }
    return {
      timestamp: new Date(now).toISOString(),
      elapsedMilliseconds,
      deadlines: Object.fromEntries(Object.entries(this.allowances).map(([group, seconds]) => [group, {
        maximumSeconds: seconds,
        deadlineAt: new Date(this.startedAt + seconds * 1_000).toISOString(),
        readyMilliseconds: this.groupReadyMilliseconds[group as ReadinessGroup],
      }])),
      conditions: this.states.map((state) => ({ ...state })),
      unmetConditions, expiredGroups, failure,
      ready: unmetConditions.length === 0 && failure === null,
      consecutiveDefinitiveErrors: this.consecutiveDefinitiveErrors,
    };
  }

  private state(id: string): ConditionState {
    const state = this.states.find((candidate) => candidate.id === id);
    if (state === undefined) throw new Error(`unknown readiness condition: ${id}`);
    return state;
  }
}

export async function waitForPhase5Readiness(options: {
  readonly conditions: readonly ReadinessCondition[];
  readonly startedAt: number;
  readonly allowances: ReadinessAllowance;
  readonly ledgerPath: string;
  readonly summaryPath: string;
  readonly diagnosticFailFast: boolean;
  readonly checkHealth: () => Promise<void>;
  readonly sampleMilliseconds?: number;
}) {
  const tracker = new Phase5ReadinessTracker(options.conditions, options.startedAt, options.allowances);
  const controller = new AbortController();
  const pending = new Map<string, Promise<void>>();
  await writeFile(options.ledgerPath, "", { flag: "wx" });
  let failure: string | null = null;
  let finalSample = tracker.sample(Date.now(), options.diagnosticFailFast);
  try {
    while (true) {
      await options.checkHealth();
      for (const condition of options.conditions) {
        if (pending.has(condition.id)) continue;
        tracker.begin(condition.id, Date.now());
        const task = Promise.resolve().then(async () => condition.check(controller.signal))
          .catch((error: unknown): ReadinessObservation => ({ ready: false, outcome: "error", error: String(error) }))
          .then((result) => {
            tracker.observe(condition.id, result, Date.now());
            pending.delete(condition.id);
          });
        pending.set(condition.id, task);
      }
      // Probe promises deliberately are NOT awaited here: frontend cold SSR cannot
      // hide an emulator deadline or suppress health sampling for 30 seconds.
      finalSample = tracker.sample(Date.now(), options.diagnosticFailFast);
      await appendFile(options.ledgerPath, `${JSON.stringify(finalSample)}\n`);
      if (finalSample.failure !== null) throw new Error(finalSample.failure);
      if (finalSample.ready) return finalSample;
      await new Promise((resolve) => setTimeout(resolve, options.sampleMilliseconds ?? 1_000));
    }
  } catch (error: unknown) {
    failure = error instanceof Error ? error.message : String(error);
    finalSample = tracker.sample(Date.now(), options.diagnosticFailFast);
    await appendFile(options.ledgerPath, `${JSON.stringify({ ...finalSample, failure })}\n`);
    throw error;
  } finally {
    controller.abort();
    await Promise.allSettled(pending.values());
    await writeFile(options.summaryPath, `${JSON.stringify({
      schemaVersion: 1, startedAt: new Date(options.startedAt).toISOString(),
      ...finalSample, failure, passed: failure === null && finalSample.ready,
    }, null, 2)}\n`, { flag: "wx" });
  }
}

export function phase5CurlArguments(url: string, maximumSeconds: number): string[] {
  return ["--connect-timeout", "3", "--max-time", String(maximumSeconds), "-k", "-sS",
    "-o", "/dev/null", "-w", "%{http_code}", url];
}

export async function phase5CurlProbe(url: string, maximumSeconds: number, signal: AbortSignal): Promise<ReadinessObservation> {
  return await new Promise((resolve, reject) => {
    const child = spawn("curl", phase5CurlArguments(url, maximumSeconds), {
      stdio: ["ignore", "pipe", "pipe"], signal,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      if (exitCode !== 0) {
        resolve({ ready: false, outcome: exitCode === 28 ? "timeout" : "error", status: null, error: stderr.trim() });
      } else {
        resolve(httpObservation(Number(stdout.trim())));
      }
    });
  });
}

export async function phase5FetchProbe(url: string, signal: AbortSignal): Promise<ReadinessObservation> {
  try {
    const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]) });
    await response.body?.cancel();
    return httpObservation(response.status);
  } catch (error: unknown) {
    return { ready: false, outcome: error instanceof Error && error.name === "TimeoutError" ? "timeout" : "error",
      status: null, error: String(error) };
  }
}

function httpObservation(status: number): ReadinessObservation {
  return { ready: Number.isInteger(status) && status >= 200 && status < 400, outcome: "http", status };
}
