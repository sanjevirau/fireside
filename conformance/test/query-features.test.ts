import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  AggregateField,
  FieldPath,
  Timestamp,
  type Query,
} from "@google-cloud/firestore";

import { createFirestore, resolveTarget } from "../src/target.ts";

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

test("queries match the production operator and shaping contract", async (context) => {
  const configuration = resolveTarget(process.env);
  const firestore = createFirestore(configuration);
  const runId = randomUUID();
  const collection = firestore.collection(
    `runs/${runId}/fireside_conformance`,
  );
  const collectionGroupPeer = firestore.doc(
    `peers/${runId}/fireside_conformance/peer`,
  );
  const expiresAt = Timestamp.fromMillis(Date.now() + DAY_MILLISECONDS);
  const documents = [
    { id: "a", inverse: 5, score: 1, group: "x", tags: ["red", "small"] },
    { id: "b", inverse: 4, score: 2, group: "x", tags: ["blue", "small"] },
    { id: "c", inverse: 3, score: 3, group: "y", tags: ["green"] },
    { id: "d", inverse: 2, score: 4, group: "z", tags: ["red", "large"] },
    { id: "e", inverse: 1, score: 5, tags: [] },
  ] as const;

  context.after(async () => {
    const writer = firestore.bulkWriter();
    for (const document of documents) {
      writer.delete(collection.doc(document.id));
    }
    writer.delete(collectionGroupPeer);
    await writer.close().catch(() => undefined);
    await firestore.terminate();
  });

  const writer = firestore.bulkWriter();
  for (const document of documents) {
    writer.set(collection.doc(document.id), {
      ...document,
      _fireside_expires_at: expiresAt,
      runId,
    });
  }
  writer.set(collectionGroupPeer, {
    _fireside_expires_at: expiresAt,
    id: "peer",
    runId,
    score: 6,
  });
  await writer.close();

  assert.deepEqual(await queryIds(collection.where("score", "==", 2)), ["b"]);
  assert.deepEqual(await queryIds(collection.where("score", "<", 3)), ["a", "b"]);
  assert.deepEqual(await queryIds(collection.where("score", "<=", 3)), ["a", "b", "c"]);
  assert.deepEqual(await queryIds(collection.where("score", ">", 3)), ["d", "e"]);
  assert.deepEqual(await queryIds(collection.where("score", ">=", 3)), ["c", "d", "e"]);
  assert.deepEqual(
    (await collection.where("inverse", ">=", 1).get()).docs.map(
      (document) => document.id,
    ),
    ["e", "d", "c", "b", "a"],
  );
  assert.deepEqual(await queryIds(collection.where("group", "!=", "x")), ["c", "d"]);
  assert.deepEqual(await queryIds(collection.where("score", "in", [1, 3])), ["a", "c"]);
  assert.deepEqual(await queryIds(collection.where("group", "not-in", ["x", "y"])), ["d"]);
  assert.deepEqual(await queryIds(collection.where("tags", "array-contains", "red")), ["a", "d"]);
  assert.deepEqual(
    await queryIds(collection.where("tags", "array-contains-any", ["blue", "green"])),
    ["b", "c"],
  );

  const ordered = collection.orderBy("score");
  assert.deepEqual(await queryIds(ordered.startAt(3)), ["c", "d", "e"]);
  assert.deepEqual(await queryIds(ordered.startAfter(3)), ["d", "e"]);
  assert.deepEqual(await queryIds(ordered.endAt(3)), ["a", "b", "c"]);
  assert.deepEqual(await queryIds(ordered.endBefore(3)), ["a", "b"]);
  assert.deepEqual(await queryIds(ordered.offset(1).limit(2)), ["b", "c"]);
  assert.deepEqual(await queryIds(ordered.limitToLast(2)), ["d", "e"]);
  assert.deepEqual(
    (await collection.orderBy("group", "desc").get()).docs.map(
      (document) => document.id,
    ),
    ["d", "c", "b", "a"],
  );

  const missingComposite = collection
    .where("group", "==", "x")
    .orderBy("score");
  if (configuration.name === "cloud") {
    await assert.rejects(missingComposite.get(), (error: unknown) => {
      return hasGrpcCode(error, 9);
    });
  } else {
    assert.deepEqual(await queryIds(missingComposite), ["a", "b"]);
  }

  assert.deepEqual(
    await queryIds(
      collection.where(FieldPath.documentId(), "in", ["b", "d"]),
    ),
    ["b", "d"],
  );

  const projected = await collection.orderBy("score").select("score").get();
  assert.deepEqual(
    projected.docs.map((document) => document.data()),
    documents.map((document) => ({ score: document.score })),
  );

  const groupSnapshot = await firestore
    .collectionGroup("fireside_conformance")
    .where("runId", "==", runId)
    .get();
  assert.deepEqual(
    groupSnapshot.docs.map((document) => document.get("id") as string).sort(),
    ["a", "b", "c", "d", "e", "peer"],
  );

  const count = await collection.count().get();
  assert.equal(count.data().count, 5);
  const aggregate = await collection
    .aggregate({
      average: AggregateField.average("score"),
      sum: AggregateField.sum("score"),
    })
    .get();
  assert.deepEqual(aggregate.data(), { average: 3, sum: 15 });
});

async function queryIds(query: Query): Promise<string[]> {
  const snapshot = await query.get();
  return snapshot.docs.map((document) => document.id).sort();
}

function hasGrpcCode(error: unknown, expected: number): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === expected
  );
}
