import { readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import process from "node:process";

import { Firestore, Timestamp } from "@google-cloud/firestore";

interface Arguments {
  readonly host: string;
  readonly output: string;
  readonly pid: number;
  readonly projectId: string;
  readonly stack: "official" | "fireside";
  readonly timeoutMilliseconds: number;
}

interface ProcessMemory {
  readonly pssBytes: number;
  readonly rssBytes: number;
}

interface OperationRecord {
  readonly durationMilliseconds: number;
  readonly memory: {
    readonly end: ProcessMemory;
    readonly peak: ProcessMemory;
    readonly samples: number;
    readonly start: ProcessMemory;
  };
  readonly name: string;
  readonly returnedDocuments: number;
}

const cacheWatcherCollections = [
  "colors",
  "fonts",
  "fontPairs",
  "slidesCore",
  "categoriesCore",
  "themes",
  "editorStyle",
  "tags",
  "icons-library",
  "premade-templates",
  "general",
] as const;

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const firestore = new Firestore({
    host: args.host,
    projectId: args.projectId,
    ssl: false,
  });
  const syntheticOwner = "phase5-query-scaling-oracle";
  const presentation = firestore.collection("presentations").doc("phase5-query-scaling-oracle");
  const slide = presentation.collection("slides").doc("phase5-query-scaling-oracle");
  const operations: OperationRecord[] = [];

  try {
    await presentation.set({
      createdAt: Timestamp.fromMillis(1),
      createdBy: syntheticOwner,
      name: "Phase 5 query scaling oracle",
      presentationFolderId: "personal",
      updatedAt: Timestamp.fromMillis(2),
    });
    await slide.set({
      createdAt: Timestamp.fromMillis(1),
      index: 0,
      updatedAt: Timestamp.fromMillis(2),
    });

    operations.push(await measureOperation(args, "cache-watcher-parallel", async () => {
      const snapshots = await Promise.all(cacheWatcherCollections.map(async (collection) => {
        const reference = firestore.collection(collection);
        return collection === "slidesCore"
          ? reference.where("coreSlideId", "!=", null).get()
          : reference.get();
      }));
      return snapshots.reduce((total, snapshot) => total + snapshot.size, 0);
    }));

    operations.push(await measureOperation(args, "dashboard-presentations", async () => {
      const snapshot = await firestore
        .collection("presentations")
        .where("createdBy", "==", syntheticOwner)
        .orderBy("updatedAt", "desc")
        .limit(12)
        .get();
      return snapshot.size;
    }));

    operations.push(await measureOperation(args, "editor-listener-set", async () => {
      const documentReady = deferred<number>();
      const slidesReady = deferred<number>();
      const unsubscribeDocument = presentation.onSnapshot(
        (snapshot) => documentReady.resolve(snapshot.exists ? 1 : 0),
        documentReady.reject,
      );
      const unsubscribeSlides = presentation.collection("slides").onSnapshot(
        (snapshot) => slidesReady.resolve(snapshot.size),
        slidesReady.reject,
      );
      try {
        const [documentCount, slideCount] = await Promise.all([
          documentReady.promise,
          slidesReady.promise,
        ]);
        return documentCount + slideCount;
      } finally {
        unsubscribeDocument();
        unsubscribeSlides();
      }
    }));

    operations.push(await measureOperation(args, "listen-document-leaves-result-set", async () => {
      const query = firestore
        .collection("presentations")
        .where("createdBy", "==", syntheticOwner);
      const initial = deferred<void>();
      const removed = deferred<void>();
      let initialized = false;
      const unsubscribe = query.onSnapshot(
        (snapshot) => {
          if (!initialized) {
            initialized = true;
            initial.resolve();
          } else if (!snapshot.docs.some((document) => document.id === presentation.id)) {
            removed.resolve();
          }
        },
        (error) => {
          initial.reject(error);
          removed.reject(error);
        },
      );
      try {
        await initial.promise;
        await presentation.update({ createdBy: `${syntheticOwner}-left` });
        await removed.promise;
        return 1;
      } finally {
        unsubscribe();
      }
    }));

    const result = {
      cacheWatcherCollections,
      capturedAt: new Date().toISOString(),
      operations,
      privacy: {
        documentFieldsStored: false,
        documentIdsStored: false,
        syntheticOnlyMutations: true,
        userIdentifiersStored: false,
      },
      process: {
        pid: args.pid,
        scope: "single emulator process",
      },
      projectId: args.projectId,
      schemaVersion: 1,
      stack: args.stack,
    };
    await writeFile(args.output, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  } finally {
    await slide.delete().catch(() => undefined);
    await presentation.delete().catch(() => undefined);
    await firestore.terminate().catch(() => undefined);
  }
}

async function measureOperation(
  args: Arguments,
  name: string,
  operation: () => Promise<number>,
): Promise<OperationRecord> {
  const start = await processMemory(args.pid);
  let peak = start;
  let samples = 1;
  let stopped = false;
  const sampling = (async () => {
    while (!stopped) {
      await delay(100);
      const current = await processMemory(args.pid);
      peak = {
        pssBytes: Math.max(peak.pssBytes, current.pssBytes),
        rssBytes: Math.max(peak.rssBytes, current.rssBytes),
      };
      samples += 1;
    }
  })();
  const started = performance.now();
  try {
    const returnedDocuments = await withTimeout(
      operation(),
      args.timeoutMilliseconds,
      `${name} exceeded ${String(args.timeoutMilliseconds)} ms`,
    );
    stopped = true;
    await sampling;
    const end = await processMemory(args.pid);
    return {
      durationMilliseconds: Math.round(performance.now() - started),
      memory: { end, peak, samples, start },
      name,
      returnedDocuments,
    };
  } catch (error) {
    stopped = true;
    await sampling;
    throw error;
  }
}

async function processMemory(pid: number): Promise<ProcessMemory> {
  const smaps = await readFile(`/proc/${String(pid)}/smaps_rollup`, "utf8");
  return {
    pssBytes: statusKilobytes(smaps, "Pss") * 1_024,
    rssBytes: statusKilobytes(smaps, "Rss") * 1_024,
  };
}

function statusKilobytes(source: string, field: string): number {
  const match = new RegExp(`^${field}:\\s+(\\d+)\\s+kB$`, "mu").exec(source);
  if (match?.[1] === undefined) throw new Error(`missing ${field} in smaps_rollup`);
  return Number.parseInt(match[1], 10);
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly reject: (error: unknown) => void;
  readonly resolve: (value: T) => void;
} {
  let reject!: (error: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseArguments(values: readonly string[]): Arguments {
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (key === undefined || value === undefined || !key.startsWith("--")) {
      throw new Error("arguments must be --name value pairs");
    }
    parsed.set(key.slice(2), value);
  }
  const required = (key: string): string => {
    const value = parsed.get(key);
    if (value === undefined || value.length === 0) throw new Error(`missing --${key}`);
    return value;
  };
  const stack = required("stack");
  if (stack !== "official" && stack !== "fireside") throw new Error("invalid --stack");
  const pid = Number.parseInt(required("pid"), 10);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("invalid --pid");
  const timeoutMilliseconds = Number.parseInt(parsed.get("timeout-ms") ?? "900000", 10);
  if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds <= 0) {
    throw new Error("invalid --timeout-ms");
  }
  return {
    host: required("host"),
    output: required("output"),
    pid,
    projectId: required("project-id"),
    stack,
    timeoutMilliseconds,
  };
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
