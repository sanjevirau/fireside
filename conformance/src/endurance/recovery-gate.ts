import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { DurableLog } from "./durable-log.ts";
import type { EnduranceManifest } from "./manifest.ts";
import { startServer, type ServerHandle } from "./server.ts";

const PROJECT_ID = "demo-fireside-endurance-recovery";
const DATABASE_ROOT = `projects/${PROJECT_ID}/databases/(default)`;
const COLLECTION = "phase1_recovery";

export interface RecoveryResult {
  readonly passed: boolean;
  readonly summary: Record<string, unknown>;
  readonly summaryPath: string;
}

export async function runRecoveryGate(
  manifest: EnduranceManifest,
  outputDirectory: string,
  dataDirectory: string,
): Promise<RecoveryResult> {
  await mkdir(outputDirectory, { recursive: true });
  const events = new DurableLog(resolve(outputDirectory, "events.ndjson"));
  const errors = new DurableLog(resolve(outputDirectory, "errors.ndjson"));
  const acknowledgements = new DurableLog(
    resolve(outputDirectory, "acknowledged.ndjson"),
  );
  const attempts = new DurableLog(resolve(outputDirectory, "attempted.ndjson"));
  const rounds = new DurableLog(
    resolve(outputDirectory, "rounds.csv"),
    "round,startup_ms,kill_delay_ms,acknowledged_total,attempted_total,recovered_before_round_documents,lost_acknowledged,partial_commits",
  );
  const acknowledged = new Set<string>();
  const attempted = new Set<string>();
  let lostAcknowledged = 0;
  let partialCommits = 0;
  let state = 0x9e3779b9;
  let active: ServerHandle | undefined;
  const startedAt = Date.now();

  try {
    for (let round = 0; round < manifest.recovery.rounds; round += 1) {
      active = await startServer({
        kind: "fireside-disk",
        projectId: PROJECT_ID,
        outputDirectory,
        dataDirectory,
      });
      const verification = await verifyRecovered(active, attempted, acknowledged);
      lostAcknowledged = verification.lost;
      partialCommits = verification.partial;
      if (verification.lost > 0 || verification.partial > 0) {
        errors.json(event("recovery-mismatch", { round, ...verification }));
        break;
      }

      for (
        let commit = 0;
        commit < manifest.recovery.acknowledgedCommitsBeforeEachKill;
        commit += 1
      ) {
        const id = `round-${String(round).padStart(3, "0")}-seed-${String(commit).padStart(3, "0")}`;
        attempted.add(id);
        attempts.json(event("attempt", { id, round, kind: "seed" }));
        await commitAtomic(active, id, commit);
        acknowledged.add(id);
        acknowledgements.json(event("acknowledged", { id, round, kind: "seed" }));
      }

      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      const span = manifest.recovery.randomKillDelayMilliseconds.maximum
        - manifest.recovery.randomKillDelayMilliseconds.minimum
        + 1;
      const killDelay = manifest.recovery.randomKillDelayMilliseconds.minimum
        + (state % span);
      const liveWriter = writeUntilKilled(active, round);
      await delay(killDelay);
      const startupMilliseconds = active.startupMilliseconds;
      await active.stop("SIGKILL");
      active = undefined;
      await liveWriter;

      const recoveredDocuments = verification.names.size;
      rounds.write([
        round,
        startupMilliseconds,
        killDelay,
        acknowledged.size,
        attempted.size,
        recoveredDocuments,
        lostAcknowledged,
        partialCommits,
      ].join(","));
      events.json(event("sigkill-round", {
        round,
        killDelay,
        acknowledged: acknowledged.size,
        attempted: attempted.size,
      }));
    }

    active = await startServer({
      kind: "fireside-disk",
      projectId: PROJECT_ID,
      outputDirectory,
      dataDirectory,
    });
    const finalVerification = await verifyRecovered(active, attempted, acknowledged);
    lostAcknowledged = finalVerification.lost;
    partialCommits = finalVerification.partial;
    const criteria = {
      rounds: manifest.recovery.rounds === countCompletedRounds(),
      acknowledgedCommits:
        acknowledged.size >= manifest.recovery.minimumAcknowledgedCommits,
      acknowledgedWritesLost:
        lostAcknowledged <= manifest.recovery.acknowledgedWritesLostAllowed,
      partialAtomicCommits:
        partialCommits <= manifest.recovery.partialAtomicCommitsAllowed,
    };
    const passed = Object.values(criteria).every(Boolean);
    const summary = {
      passed,
      elapsedMilliseconds: Date.now() - startedAt,
      completedRounds: countCompletedRounds(),
      acknowledgedCommits: acknowledged.size,
      attemptedCommits: attempted.size,
      recoveredDocuments: finalVerification.names.size,
      lostAcknowledged,
      partialCommits,
      criteria,
    } satisfies Record<string, unknown>;
    const summaryPath = resolve(outputDirectory, "summary.json");
    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    events.json(event("recovery-complete", { passed, acknowledged: acknowledged.size }));
    return { passed, summary, summaryPath };
  } finally {
    await active?.stop().catch(() => undefined);
    events.close();
    errors.close();
    acknowledgements.close();
    attempts.close();
    rounds.close();
  }

  async function writeUntilKilled(server: ServerHandle, round: number): Promise<void> {
    for (let live = 0; live < 1_000; live += 1) {
      const id = `round-${String(round).padStart(3, "0")}-live-${String(live).padStart(4, "0")}`;
      attempted.add(id);
      attempts.json(event("attempt", { id, round, kind: "live" }));
      try {
        await commitAtomic(server, id, live);
        acknowledged.add(id);
        acknowledgements.json(event("acknowledged", { id, round, kind: "live" }));
      } catch (error) {
        if (isInterruption(error)) {
          return;
        }
        throw error;
      }
    }
  }

  function countCompletedRounds(): number {
    return [...acknowledged]
      .filter((id) => id.includes("-seed-000"))
      .length;
  }
}

async function commitAtomic(server: ServerHandle, id: string, value: number): Promise<void> {
  const response = await fetch(
    `http://${server.host}:${String(server.port)}/v1/${DATABASE_ROOT}/documents:commit`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer owner",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        writes: [
          updateWrite(id, "left", value),
          updateWrite(id, "right", value),
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw new Error(`commit ${id} returned HTTP ${String(response.status)}`);
  }
}

function updateWrite(id: string, side: "left" | "right", value: number): object {
  return {
    update: {
      name: documentName(id, side),
      fields: {
        commit: { stringValue: id },
        side: { stringValue: side },
        value: { integerValue: String(value) },
      },
    },
  };
}

async function verifyRecovered(
  server: ServerHandle,
  attempted: ReadonlySet<string>,
  acknowledged: ReadonlySet<string>,
): Promise<{
  readonly names: Set<string>;
  readonly lost: number;
  readonly partial: number;
}> {
  const response = await fetch(
    `http://${server.host}:${String(server.port)}/v1/${DATABASE_ROOT}/documents:runQuery`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer owner",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        structuredQuery: { from: [{ collectionId: COLLECTION }] },
      }),
      signal: AbortSignal.timeout(120_000),
    },
  );
  if (!response.ok) {
    throw new Error(`recovery query returned HTTP ${String(response.status)}`);
  }
  const names = responseNames(await response.json());
  let partial = 0;
  let lost = 0;
  for (const id of attempted) {
    const left = names.has(documentName(id, "left"));
    const right = names.has(documentName(id, "right"));
    if (left !== right) {
      partial += 1;
    }
  }
  for (const id of acknowledged) {
    if (
      !names.has(documentName(id, "left"))
      || !names.has(documentName(id, "right"))
    ) {
      lost += 1;
    }
  }
  return { names, lost, partial };
}

function responseNames(body: unknown): Set<string> {
  if (!Array.isArray(body)) {
    throw new Error("recovery runQuery response is not an array");
  }
  const names = new Set<string>();
  for (const entry of body) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const document = Reflect.get(entry, "document");
    if (typeof document !== "object" || document === null) {
      continue;
    }
    const name = Reflect.get(document, "name");
    if (typeof name === "string") {
      names.add(name);
    }
  }
  return names;
}

function documentName(id: string, side: "left" | "right"): string {
  return `${DATABASE_ROOT}/documents/${COLLECTION}/${id}-${side}`;
}

function isInterruption(error: unknown): boolean {
  return error instanceof TypeError
    || (error instanceof DOMException && error.name === "TimeoutError");
}

function event(type: string, details: Record<string, unknown>): Record<string, unknown> {
  return { timestamp: new Date().toISOString(), type, ...details };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
