import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type { DocumentChange, QuerySnapshot } from "@google-cloud/firestore";

import { createFirestore, resolveTarget } from "../src/target.ts";

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
