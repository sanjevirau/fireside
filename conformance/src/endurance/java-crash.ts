import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { DurableLog } from "./durable-log.ts";
import { startServer, type ServerHandle } from "./server.ts";

const PROJECT_ID = "demo-fireside-java-crash";
const DATABASE_ROOT = `projects/${PROJECT_ID}/databases/(default)`;

export async function observeJavaCrash(
  outputDirectory: string,
  javaToolOptions?: string,
): Promise<Record<string, unknown>> {
  await mkdir(outputDirectory, { recursive: true });
  const events = new DurableLog(resolve(outputDirectory, "events.ndjson"));
  let server: ServerHandle | undefined;
  let beforeKill = 0;
  let afterRestart = 0;
  let firstStartupMilliseconds: number | null = null;
  let restartMilliseconds: number | null = null;
  let error: string | null = null;
  try {
    server = await startServer({
      kind: "java",
      projectId: PROJECT_ID,
      outputDirectory,
      ...(javaToolOptions === undefined ? {} : { javaToolOptions }),
    });
    firstStartupMilliseconds = server.startupMilliseconds;
    await seed(server, 100);
    beforeKill = await count(server);
    events.json(event("before-sigkill", { documents: beforeKill }));
    await server.stop("SIGKILL");
    server = undefined;

    server = await startServer({
      kind: "java",
      projectId: PROJECT_ID,
      outputDirectory,
      ...(javaToolOptions === undefined ? {} : { javaToolOptions }),
    });
    restartMilliseconds = server.startupMilliseconds;
    afterRestart = await count(server);
    events.json(event("after-restart", { documents: afterRestart }));
  } catch (caught) {
    error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
    events.json(event("java-crash-observation-error", { error }));
  } finally {
    await server?.stop().catch(() => undefined);
    events.close();
  }
  const summary = {
    designDifference: "The official Java emulator has no durable persistence across SIGKILL.",
    firstStartupMilliseconds,
    restartMilliseconds,
    documentsBeforeKill: beforeKill,
    documentsAfterRestart: afterRestart,
    dataLost: Math.max(0, beforeKill - afterRestart),
    error,
  } satisfies Record<string, unknown>;
  await writeFile(
    resolve(outputDirectory, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );
  return summary;
}

async function seed(server: ServerHandle, count: number): Promise<void> {
  const writes = Array.from({ length: count }, (_, ordinal) => ({
    update: {
      name: `${DATABASE_ROOT}/documents/java_crash/document-${String(ordinal).padStart(3, "0")}`,
      fields: { ordinal: { integerValue: String(ordinal) } },
    },
  }));
  const response = await fetch(
    `http://${server.host}:${String(server.port)}/v1/${DATABASE_ROOT}/documents:commit`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ writes }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw new Error(`Java crash seed returned HTTP ${String(response.status)}`);
  }
}

async function count(server: ServerHandle): Promise<number> {
  const response = await fetch(
    `http://${server.host}:${String(server.port)}/v1/${DATABASE_ROOT}/documents:runQuery`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        structuredQuery: { from: [{ collectionId: "java_crash" }] },
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw new Error(`Java crash query returned HTTP ${String(response.status)}`);
  }
  const body: unknown = await response.json();
  return Array.isArray(body)
    ? body.filter((entry) =>
      typeof entry === "object"
      && entry !== null
      && Reflect.has(entry, "document")
    ).length
    : 0;
}

function event(type: string, details: Record<string, unknown>): Record<string, unknown> {
  return { timestamp: new Date().toISOString(), type, ...details };
}
