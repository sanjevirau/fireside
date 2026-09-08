import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import FirestorePackage, { Timestamp } from "@google-cloud/firestore";

import { createFirestore, resolveTarget } from "../src/target.ts";

const { ascending, descending, field } = FirestorePackage.Pipelines;
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

test("Enterprise pipelines filter, sort, shape, and preserve selected metadata", async (context) => {
  const configuration = resolveTarget(process.env);
  const firestore = createFirestore(configuration);
  const runId = randomUUID();
  const collection = firestore.collection(
    `runs/${runId}/fireside_pipeline_conformance`,
  );
  const documents = [collection.doc("a"), collection.doc("b"), collection.doc("c")];
  const expiresAt = Timestamp.fromMillis(Date.now() + DAY_MILLISECONDS);

  context.after(async () => {
    await Promise.all(documents.map(async (document) => document.delete())).catch(
      () => undefined,
    );
    await firestore.terminate().catch(() => undefined);
  });

  await Promise.all([
    documents[0]!.set({ _fireside_expires_at: expiresAt, label: "alpha", score: 1 }),
    documents[1]!.set({ _fireside_expires_at: expiresAt, label: "beta", score: 3 }),
    documents[2]!.set({ _fireside_expires_at: expiresAt, label: "gamma", score: 2 }),
  ]);

  const projected = await firestore
    .pipeline()
    .collection(collection)
    .where(field("score").greaterThan(1))
    .sort(descending("score"))
    .limit(2)
    .select("label", "score")
    .execute();
  assert.deepEqual(projected.results.map((result) => result.data()), [
    { label: "beta", score: 3 },
    { label: "gamma", score: 2 },
  ]);
  assert.ok(projected.results.every((result) => result.id === undefined));
  assert.ok(projected.results.every((result) => result.ref === undefined));
  assert.ok(projected.results.every((result) => result.createTime === undefined));
  assert.ok(projected.results.every((result) => result.updateTime === undefined));
  assert.ok(projected.executionTime instanceof Timestamp);

  const complete = await firestore
    .pipeline()
    .collection(collection)
    .sort(descending("score"))
    .limit(1)
    .execute();
  assert.equal(complete.results.length, 1);
  assert.equal(complete.results[0]!.id, "b");
  assert.equal(complete.results[0]!.ref?.path, collection.doc("b").path);
  assert.equal(complete.results[0]!.data().label, "beta");
  assert.equal(complete.results[0]!.data().score, 3);
  assert.ok(complete.results[0]!.createTime instanceof Timestamp);
  assert.ok(complete.results[0]!.updateTime instanceof Timestamp);

  const paged = await firestore
    .pipeline()
    .collection(collection)
    .sort(ascending("score"))
    .offset(1)
    .limit(1)
    .select(
      field("__name__"),
      field("__create_time__"),
      field("__update_time__"),
      "label",
      "score",
    )
    .execute();
  assert.equal(paged.results.length, 1);
  assert.equal(paged.results[0]!.id, "c");
  assert.equal(paged.results[0]!.ref?.path, collection.doc("c").path);
  assert.deepEqual(paged.results[0]!.data(), { label: "gamma", score: 2 });
  assert.ok(paged.results[0]!.createTime instanceof Timestamp);
  assert.ok(paged.results[0]!.updateTime instanceof Timestamp);
});
