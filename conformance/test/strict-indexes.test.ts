import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { FieldValue, type Query } from "@google-cloud/firestore";

import { createFirestore, resolveTarget } from "../src/target.ts";

interface RestError {
  readonly error?: {
    readonly code?: number;
    readonly status?: string;
  };
}

test("strict indexes enforce the production missing-index contract", async (context) => {
  const configuration = resolveTarget(process.env);
  assert.equal(configuration.name, "fireside");
  assert.equal(process.env.CONFORMANCE_STRICT_INDEXES, "1");

  const firestore = createFirestore(configuration);
  const runId = randomUUID();
  const collection = firestore.collection(`runs/${runId}/strict_index_fixture`);
  const documents = [collection.doc("first"), collection.doc("second")];
  context.after(async () => {
    await Promise.all(documents.map(async (document) => document.delete()));
    await firestore.terminate();
  });

  await Promise.all([
    documents[0]?.set({ group: "x", missingScore: 2, score: 1 }),
    documents[1]?.set({ group: "x", missingScore: 1, score: 2 }),
  ]);

  assert.deepEqual(
    await queryIds(collection.where("group", "==", "x").orderBy("score")),
    ["first", "second"],
  );
  await assert.rejects(
    collection.where("group", "==", "x").orderBy("missingScore").get(),
    (error: unknown) => hasGrpcCode(error, 9),
  );

  const databaseRoot = `projects/${configuration.projectId}/databases/(default)`;
  const response = await fetch(
    `http://${configuration.host}/v1/${databaseRoot}/documents/runs/${runId}:runQuery`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer owner",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: "strict_index_fixture" }],
          where: {
            fieldFilter: {
              field: { fieldPath: "group" },
              op: "EQUAL",
              value: { stringValue: "x" },
            },
          },
          orderBy: [
            {
              field: { fieldPath: "missingScore" },
              direction: "ASCENDING",
            },
          ],
        },
      }),
    },
  );
  assert.equal(response.status, 400);
  const errors = await json<readonly RestError[]>(response);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.error?.code, 400);
  assert.equal(errors[0]?.error?.status, "FAILED_PRECONDITION");
});

test("strict indexes require an explicit vector configuration", async (context) => {
  const configuration = resolveTarget(process.env);
  assert.equal(configuration.name, "fireside");
  assert.equal(process.env.CONFORMANCE_STRICT_INDEXES, "1");

  const firestore = createFirestore(configuration);
  const runId = randomUUID();
  const indexed = firestore.collection(
    `runs/${runId}/fireside_vector_conformance`,
  );
  const missing = firestore.collection(`runs/${runId}/strict_vector_missing`);
  const documents = [indexed.doc("indexed"), missing.doc("missing")];
  context.after(async () => {
    await Promise.all(documents.map(async (document) => document.delete()));
    await firestore.terminate();
  });

  await Promise.all(documents.map(async (document) => document.set({
    embedding: FieldValue.vector([1, 0, 0]),
  })));
  const snapshot = await indexed.findNearest({
    vectorField: "embedding",
    queryVector: [0, 0, 0],
    limit: 1,
    distanceMeasure: "EUCLIDEAN",
  }).get();
  assert.deepEqual(snapshot.docs.map((document) => document.id), ["indexed"]);
  await assert.rejects(
    indexed.findNearest({
      vectorField: "embedding",
      queryVector: [0, 0],
      limit: 1,
      distanceMeasure: "EUCLIDEAN",
    }).get(),
    (error: unknown) => hasGrpcCode(error, 9),
  );
  await assert.rejects(
    missing.findNearest({
      vectorField: "embedding",
      queryVector: [0, 0, 0],
      limit: 1,
      distanceMeasure: "EUCLIDEAN",
    }).get(),
    (error: unknown) => hasGrpcCode(error, 9),
  );
});

async function queryIds(query: Query): Promise<string[]> {
  const snapshot = await query.get();
  return snapshot.docs.map((document) => document.id);
}

function hasGrpcCode(error: unknown, expected: number): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === expected
  );
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T;
}
