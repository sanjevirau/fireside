import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";

import type { DocumentChange, QuerySnapshot } from "@google-cloud/firestore";

import {
  createFirestore,
  createV1Firestore,
  resolveTarget,
} from "../src/target.ts";

type ListenStream = ReturnType<ReturnType<typeof createV1Firestore>["listen"]>;

interface ObservedListenResponse {
  readonly documentChange?: {
    readonly document?: { readonly name?: string | null } | null;
  } | null;
  readonly targetChange?: {
    readonly resumeToken?: string | Uint8Array | null;
    readonly targetChangeType?: number | string | null;
    readonly targetIds?: readonly number[] | null;
  } | null;
  readonly filter?: {
    readonly count?: number | null;
    readonly targetId?: number | null;
    readonly unchangedNames?: {
      readonly bits?: {
        readonly bitmap?: string | Uint8Array | null;
        readonly padding?: number | null;
      } | null;
      readonly hashCount?: number | null;
    } | null;
  } | null;
}

interface ListenCheckpoint {
  readonly documentIds: readonly string[];
  readonly filters: ReadonlyArray<{
    readonly count: number;
    readonly bitmap: Uint8Array;
    readonly hasUnchangedNames: boolean;
    readonly hasBits: boolean;
    readonly hashCount: number;
    readonly bitmapBytes: number;
    readonly padding: number;
    readonly targetId: number;
  }>;
  readonly resumeToken: string | Uint8Array;
  readonly targetChangeTypes: readonly string[];
}

interface ObservedSnapshot {
  readonly changes: ReadonlyArray<{
    readonly id: string;
    readonly type: DocumentChange["type"];
  }>;
  readonly ids: readonly string[];
}

test("query listeners deliver an initial snapshot and ordered changes", async (context) => {
  const configuration = resolveTarget(process.env);
  const firestore = createFirestore(configuration);
  const collection = firestore.collection(
    `runs/${randomUUID()}/fireside_conformance`,
  );
  const alpha = collection.doc("alpha");
  const beta = collection.doc("beta");
  const queue = snapshotQueue();

  await alpha.set({ rank: 1 });
  const unsubscribe = collection.orderBy("rank").onSnapshot(
    queue.push,
    queue.reject,
  );

  context.after(async () => {
    unsubscribe();
    await Promise.all([
      alpha.delete().catch(() => undefined),
      beta.delete().catch(() => undefined),
    ]);
    await firestore.terminate();
  });

  assert.deepEqual(await queue.next(), {
    changes: [{ id: "alpha", type: "added" }],
    ids: ["alpha"],
  });

  await beta.set({ rank: 2 });
  assert.deepEqual(await queue.next(), {
    changes: [{ id: "beta", type: "added" }],
    ids: ["alpha", "beta"],
  });

  await beta.update({ rank: 0 });
  assert.deepEqual(await queue.next(), {
    changes: [{ id: "beta", type: "modified" }],
    ids: ["beta", "alpha"],
  });

  await alpha.delete();
  assert.deepEqual(await queue.next(), {
    changes: [{ id: "alpha", type: "removed" }],
    ids: ["beta"],
  });
});

test("raw Listen resumes after a CURRENT checkpoint without replaying prior documents", async (context) => {
  const configuration = resolveTarget(process.env);
  const firestore = createFirestore(configuration);
  const rawFirestore = createV1Firestore(configuration);
  const runId = randomUUID();
  const collection = firestore.collection(`runs/${runId}/fireside_conformance`);
  const alpha = collection.doc("alpha");
  const beta = collection.doc("beta");
  const database = `projects/${configuration.projectId}/databases/(default)`;
  const addTarget = {
    query: {
      parent: `${database}/documents/runs/${runId}`,
      structuredQuery: {
        from: [{ collectionId: "fireside_conformance" }],
        orderBy: [
          { field: { fieldPath: "rank" }, direction: "ASCENDING" },
        ],
      },
    },
    targetId: 7,
  } as const;
  const listenOptions = {
    otherArgs: { headers: { "google-cloud-resource-prefix": database } },
  } as const;
  const streams: ListenStream[] = [];

  context.after(async () => {
    for (const stream of streams) {
      stream.end();
    }
    await Promise.all([
      alpha.delete().catch(() => undefined),
      beta.delete().catch(() => undefined),
    ]);
    await Promise.all([firestore.terminate(), rawFirestore.close()]);
  });

  await alpha.set({ rank: 1 });
  const initialStream = rawFirestore.listen(listenOptions);
  streams.push(initialStream);
  const initialResponses = rawResponseQueue(initialStream);
  initialStream.write({ database, addTarget });
  const initial = await readCheckpoint(initialResponses);
  assert.deepEqual(initial.documentIds, ["alpha"]);
  assert.deepEqual(initial.targetChangeTypes, ["ADD", "CURRENT"]);
  initialStream.end();

  const mismatchStream = rawFirestore.listen(listenOptions);
  streams.push(mismatchStream);
  const mismatchResponses = rawResponseQueue(mismatchStream);
  mismatchStream.write({
    database,
    addTarget: {
      ...addTarget,
      expectedCount: { value: 99 },
      resumeToken: initial.resumeToken,
    },
  });
  const mismatch = await readCheckpoint(mismatchResponses);
  assert.deepEqual(
    mismatch.documentIds,
    configuration.name === "java" ? ["alpha"] : [],
  );
  assert.deepEqual(
    filterMetadata(mismatch.filters),
    configuration.name === "java"
      ? []
      : [{
        bitmapBytes: 4,
        count: 1,
        hasBits: true,
        hasUnchangedNames: true,
        hashCount: 20,
        padding: 3,
        targetId: 7,
      }],
  );
  assert.deepEqual(
    mismatch.targetChangeTypes,
    configuration.name === "java"
      ? ["ADD", "RESET", "CURRENT"]
      : ["ADD", "CURRENT"],
  );
  if (configuration.name !== "java") {
    assert.equal(
      bloomMightContain(mismatch.filters[0], `${database}/documents/${alpha.path}`),
      true,
    );
  }
  mismatchStream.end();

  await beta.set({ rank: 2 });
  const resumedStream = rawFirestore.listen(listenOptions);
  streams.push(resumedStream);
  const resumedResponses = rawResponseQueue(resumedStream);
  resumedStream.write({
    database,
    addTarget: {
      ...addTarget,
      expectedCount: { value: 99 },
      resumeToken: initial.resumeToken,
    },
  });
  const resumed = await readCheckpoint(resumedResponses);
  assert.deepEqual(
    resumed.documentIds,
    configuration.name === "java" ? ["alpha", "beta"] : ["beta"],
  );
  assert.deepEqual(
    filterMetadata(resumed.filters),
    configuration.name === "java"
      ? []
      : [{
        bitmapBytes: 7,
        count: 2,
        hasBits: true,
        hasUnchangedNames: true,
        hashCount: 18,
        padding: 3,
        targetId: 7,
      }],
  );
  assert.deepEqual(
    resumed.targetChangeTypes,
    configuration.name === "java"
      ? ["ADD", "RESET", "CURRENT"]
      : ["ADD", "CURRENT"],
  );
  if (configuration.name !== "java") {
    const filter = resumed.filters[0];
    assert.equal(
      bloomMightContain(filter, `${database}/documents/${alpha.path}`),
      true,
    );
    assert.equal(
      bloomMightContain(filter, `${database}/documents/${beta.path}`),
      true,
    );
    assert.equal(
      bloomMightContain(filter, `${database}/documents/${collection.path}/missing`),
      false,
    );
  }
});

test("raw Listen read_time delivers only changes after the historical snapshot", async (context) => {
  const configuration = resolveTarget(process.env);
  const firestore = createFirestore(configuration);
  const rawFirestore = createV1Firestore(configuration);
  const runId = randomUUID();
  const collection = firestore.collection(`runs/${runId}/fireside_conformance`);
  const alpha = collection.doc("alpha");
  const beta = collection.doc("beta");
  const database = `projects/${configuration.projectId}/databases/(default)`;
  const stream = rawFirestore.listen({
    otherArgs: { headers: { "google-cloud-resource-prefix": database } },
  });

  context.after(async () => {
    stream.end();
    await Promise.all([
      alpha.delete().catch(() => undefined),
      beta.delete().catch(() => undefined),
    ]);
    await Promise.all([firestore.terminate(), rawFirestore.close()]);
  });

  const first = await alpha.set({ rank: 1 });
  await beta.set({ rank: 2 });
  const responses = rawResponseQueue(stream);
  stream.write({
    database,
    addTarget: {
      query: {
        parent: `${database}/documents/runs/${runId}`,
        structuredQuery: {
          from: [{ collectionId: "fireside_conformance" }],
          orderBy: [
            { field: { fieldPath: "rank" }, direction: "ASCENDING" },
          ],
        },
      },
      targetId: 9,
      readTime: {
        seconds: first.writeTime.seconds,
        nanos: first.writeTime.nanoseconds,
      },
    },
  });
  const checkpoint = await readCheckpoint(responses);
  assert.deepEqual(
    checkpoint.documentIds,
    configuration.name === "java" ? ["alpha", "beta"] : ["beta"],
  );
  assert.deepEqual(
    checkpoint.targetChangeTypes,
    configuration.name === "java"
      ? ["ADD", "RESET", "CURRENT"]
      : ["ADD", "CURRENT"],
  );
});

test("raw Listen falls back to the full target when read_time has expired", async (context) => {
  const configuration = resolveTarget(process.env);
  const firestore = createFirestore(configuration);
  const rawFirestore = createV1Firestore(configuration);
  const runId = randomUUID();
  const collection = firestore.collection(`runs/${runId}/fireside_conformance`);
  const alpha = collection.doc("alpha");
  const database = `projects/${configuration.projectId}/databases/(default)`;
  const stream = rawFirestore.listen({
    otherArgs: { headers: { "google-cloud-resource-prefix": database } },
  });

  context.after(async () => {
    stream.end();
    await alpha.delete().catch(() => undefined);
    await Promise.all([firestore.terminate(), rawFirestore.close()]);
  });

  await alpha.set({ rank: 1 });
  const responses = rawResponseQueue(stream);
  stream.write({
    database,
    addTarget: {
      query: {
        parent: `${database}/documents/runs/${runId}`,
        structuredQuery: {
          from: [{ collectionId: "fireside_conformance" }],
        },
      },
      targetId: 11,
      readTime: {
        seconds: Math.floor((Date.now() - 2 * 60 * 60 * 1_000) / 1_000),
        nanos: 0,
      },
    },
  });
  const checkpoint = await readCheckpoint(responses);

  assert.deepEqual(checkpoint.documentIds, ["alpha"]);
  assert.deepEqual(
    checkpoint.targetChangeTypes,
    configuration.name === "java"
      ? ["ADD", "RESET", "CURRENT"]
      : ["ADD", "CURRENT"],
  );
  assert.deepEqual(
    filterMetadata(checkpoint.filters),
    configuration.name === "java"
      ? []
      : [{
        bitmapBytes: 0,
        count: 1,
        hasBits: true,
        hasUnchangedNames: true,
        hashCount: 0,
        padding: 0,
        targetId: 11,
      }],
  );
});

function snapshotQueue(): {
  readonly next: () => Promise<ObservedSnapshot>;
  readonly push: (snapshot: QuerySnapshot) => void;
  readonly reject: (error: Error) => void;
} {
  const snapshots: ObservedSnapshot[] = [];
  const waiters: Array<{
    readonly resolve: (snapshot: ObservedSnapshot) => void;
    readonly reject: (error: Error) => void;
  }> = [];
  let terminalError: Error | undefined;

  return {
    next: async () => {
      const snapshot = snapshots.shift();
      if (snapshot !== undefined) {
        return snapshot;
      }
      if (terminalError !== undefined) {
        throw terminalError;
      }
      return await new Promise<ObservedSnapshot>((resolvePromise, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("timed out waiting for a listener snapshot"));
        }, 45_000);
        waiters.push({
          resolve: (value) => {
            clearTimeout(timeout);
            resolvePromise(value);
          },
          reject: (error) => {
            clearTimeout(timeout);
            reject(error);
          },
        });
      });
    },
    push: (snapshot) => {
      const observed = observe(snapshot);
      const waiter = waiters.shift();
      if (waiter === undefined) {
        snapshots.push(observed);
      } else {
        waiter.resolve(observed);
      }
    },
    reject: (error) => {
      terminalError = error;
      for (const waiter of waiters.splice(0)) {
        waiter.reject(error);
      }
    },
  };
}

function observe(snapshot: QuerySnapshot): ObservedSnapshot {
  return {
    changes: snapshot.docChanges().map((change) => ({
      id: change.doc.id,
      type: change.type,
    })),
    ids: snapshot.docs.map((document) => document.id),
  };
}

function rawResponseQueue(stream: ListenStream): {
  readonly next: () => Promise<ObservedListenResponse>;
} {
  const responses: ObservedListenResponse[] = [];
  const waiters: Array<{
    readonly resolve: (response: ObservedListenResponse) => void;
    readonly reject: (error: Error) => void;
  }> = [];
  let terminalError: Error | undefined;

  stream.on("data", (response: ObservedListenResponse) => {
    const waiter = waiters.shift();
    if (waiter === undefined) {
      responses.push(response);
    } else {
      waiter.resolve(response);
    }
  });
  stream.on("error", (error: Error) => {
    terminalError = error;
    for (const waiter of waiters.splice(0)) {
      waiter.reject(error);
    }
  });

  return {
    next: async () => {
      const response = responses.shift();
      if (response !== undefined) {
        return response;
      }
      if (terminalError !== undefined) {
        throw terminalError;
      }
      return await new Promise<ObservedListenResponse>((resolvePromise, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("timed out waiting for a raw Listen response"));
        }, 45_000);
        waiters.push({
          resolve: (value) => {
            clearTimeout(timeout);
            resolvePromise(value);
          },
          reject: (error) => {
            clearTimeout(timeout);
            reject(error);
          },
        });
      });
    },
  };
}

async function readCheckpoint(
  queue: ReturnType<typeof rawResponseQueue>,
): Promise<ListenCheckpoint> {
  const documentIds: string[] = [];
  const filters: ListenCheckpoint["filters"][number][] = [];
  const targetChangeTypes: string[] = [];
  let seenCurrent = false;
  for (let index = 0; index < 32; index += 1) {
    const response = await queue.next();
    const filter = response.filter;
    if (filter !== undefined && filter !== null) {
      filters.push({
        bitmap: bytes(filter.unchangedNames?.bits?.bitmap ?? ""),
        bitmapBytes: byteLength(filter.unchangedNames?.bits?.bitmap ?? ""),
        count: filter.count ?? 0,
        hasBits: filter.unchangedNames?.bits !== undefined &&
          filter.unchangedNames?.bits !== null,
        hasUnchangedNames: filter.unchangedNames !== undefined &&
          filter.unchangedNames !== null,
        hashCount: filter.unchangedNames?.hashCount ?? 0,
        padding: filter.unchangedNames?.bits?.padding ?? 0,
        targetId: filter.targetId ?? 0,
      });
    }
    const name = response.documentChange?.document?.name;
    if (name !== undefined && name !== null) {
      documentIds.push(name.slice(name.lastIndexOf("/") + 1));
    }
    const targetChange = response.targetChange;
    if (targetChange === undefined || targetChange === null) {
      continue;
    }
    const type = targetChangeType(targetChange.targetChangeType);
    if (type !== "NO_CHANGE") {
      targetChangeTypes.push(type);
    }
    if (type === "CURRENT") {
      seenCurrent = true;
    }
    const token = targetChange.resumeToken;
    if (seenCurrent && token !== undefined && token !== null && byteLength(token) > 0) {
      return { documentIds, filters, resumeToken: token, targetChangeTypes };
    }
  }
  throw new Error("Listen produced no CURRENT checkpoint");
}

function targetChangeType(value: number | string | null | undefined): string {
  if (typeof value === "string") {
    return value;
  }
  return ["NO_CHANGE", "ADD", "REMOVE", "CURRENT", "RESET"][value ?? -1] ??
    `UNKNOWN_${String(value)}`;
}

function byteLength(value: string | Uint8Array): number {
  return typeof value === "string" ? Buffer.from(value, "base64").byteLength : value.byteLength;
}

function bytes(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? Buffer.from(value, "base64") : value;
}

function filterMetadata(filters: ListenCheckpoint["filters"]): ReadonlyArray<{
  readonly bitmapBytes: number;
  readonly count: number;
  readonly hasBits: boolean;
  readonly hasUnchangedNames: boolean;
  readonly hashCount: number;
  readonly padding: number;
  readonly targetId: number;
}> {
  return filters.map(({ bitmap: _bitmap, ...metadata }) => metadata);
}

function bloomMightContain(
  filter: ListenCheckpoint["filters"][number] | undefined,
  value: string,
): boolean {
  if (filter === undefined) {
    throw new Error("existence filter is missing");
  }
  const bitmap = Buffer.from(filter.bitmap);
  const bitCount = BigInt(bitmap.byteLength * 8 - filter.padding);
  const digest = createHash("md5").update(value, "utf8").digest();
  const first = digest.readBigUInt64LE(0);
  const second = digest.readBigUInt64LE(8);
  for (let index = 0n; index < BigInt(filter.hashCount); index += 1n) {
    const hash = BigInt.asUintN(64, first + index * second);
    const bit = Number(hash % bitCount);
    if ((bitmap[Math.floor(bit / 8)]! & (1 << (bit % 8))) === 0) {
      return false;
    }
  }
  return true;
}
