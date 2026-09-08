import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";

import { FieldValue, Timestamp } from "@google-cloud/firestore";
import { GoogleAuth } from "google-auth-library";

import { createFirestore, resolveTarget } from "../src/target.ts";

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

test("nearest-vector queries match production distance semantics", async (context) => {
  const configuration = resolveTarget(process.env);
  const firestore = createFirestore(configuration);
  const runId = randomUUID();
  const database = `projects/${configuration.projectId}/databases/(default)`;
  const parent = `${database}/documents/runs/${runId}`;
  const collection = firestore.collection(
    `runs/${runId}/fireside_vector_conformance`,
  );
  const documents = [
    collection.doc("a"),
    collection.doc("b"),
    collection.doc("c"),
    collection.doc("d"),
    collection.doc("mismatch"),
    collection.doc("missing"),
  ];
  const expiresAt = Timestamp.fromMillis(Date.now() + DAY_MILLISECONDS);

  context.after(async () => {
    await Promise.all(documents.map(async (document) => document.delete())).catch(
      () => undefined,
    );
    await firestore.terminate().catch(() => undefined);
  });

  await Promise.all([
    documents[0]!.set({
      _fireside_expires_at: expiresAt,
      embedding: FieldValue.vector([1, 0, 0]),
    }),
    documents[1]!.set({
      _fireside_expires_at: expiresAt,
      embedding: FieldValue.vector([0.5, 2, 0]),
    }),
    documents[2]!.set({
      _fireside_expires_at: expiresAt,
      embedding: FieldValue.vector([-2, 0, 0]),
    }),
    documents[3]!.set({
      _fireside_expires_at: expiresAt,
      embedding: FieldValue.vector([0, 10, 0]),
    }),
    documents[4]!.set({
      _fireside_expires_at: expiresAt,
      embedding: FieldValue.vector([1, 0]),
    }),
    documents[5]!.set({ _fireside_expires_at: expiresAt }),
  ]);

  const euclideanQuery = collection.findNearest({
    vectorField: "embedding",
    queryVector: [0, 0, 0],
    limit: 3,
    distanceMeasure: "EUCLIDEAN",
    distanceResultField: "distance",
  });
  const euclidean = await euclideanQuery.get();
  assert.deepEqual(euclidean.docs.map((document) => document.id), ["a", "c", "b"]);
  assertDistances(euclidean.docs.map((document) => document.get("distance")), [
    1,
    2,
    Math.sqrt(4.25),
  ]);

  const cosine = await collection.findNearest({
    vectorField: "embedding",
    queryVector: [1, 0, 0],
    limit: 3,
    distanceMeasure: "COSINE",
    distanceResultField: "distance",
  }).get();
  assert.deepEqual(cosine.docs.map((document) => document.id), ["a", "b", "d"]);
  assertDistances(cosine.docs.map((document) => document.get("distance")), [
    0,
    1 - 0.5 / Math.sqrt(4.25),
    1,
  ]);

  const dotProduct = await collection.findNearest({
    vectorField: "embedding",
    queryVector: [1, 0, 0],
    limit: 3,
    distanceMeasure: "DOT_PRODUCT",
    distanceResultField: "distance",
  }).get();
  assert.deepEqual(dotProduct.docs.map((document) => document.id), ["a", "b", "d"]);
  assertDistances(dotProduct.docs.map((document) => document.get("distance")), [
    1,
    0.5,
    0,
  ]);

  const threshold = await collection.findNearest({
    vectorField: "embedding",
    queryVector: [0, 0, 0],
    limit: 3,
    distanceMeasure: "EUCLIDEAN",
    distanceThreshold: 2,
  }).get();
  assert.deepEqual(threshold.docs.map((document) => document.id), ["a", "c"]);

  const cosineThreshold = await collection.findNearest({
    vectorField: "embedding",
    queryVector: [1, 0, 0],
    limit: 4,
    distanceMeasure: "COSINE",
    distanceThreshold: 1,
  }).get();
  assert.deepEqual(cosineThreshold.docs.map((document) => document.id), ["a", "b", "d"]);

  const dotProductThreshold = await collection.findNearest({
    vectorField: "embedding",
    queryVector: [1, 0, 0],
    limit: 4,
    distanceMeasure: "DOT_PRODUCT",
    distanceThreshold: 0.5,
  }).get();
  assert.deepEqual(dotProductThreshold.docs.map((document) => document.id), ["a", "b"]);

  const wrongDimension = collection.findNearest({
    vectorField: "embedding",
    queryVector: [0, 0],
    limit: 1,
    distanceMeasure: "EUCLIDEAN",
  });
  if (configuration.name === "cloud") {
    await assert.rejects(wrongDimension.get(), (error: unknown) => hasGrpcCode(error, 9));
  } else {
    const snapshot = await wrongDimension.get();
    assert.deepEqual(snapshot.docs.map((document) => document.id), ["mismatch"]);
  }

  const baseUrl = configuration.host === undefined
    ? "https://firestore.googleapis.com"
    : `http://${configuration.host}`;
  const response = await fetch(`${baseUrl}/v1/${parent}:runQuery`, {
    method: "POST",
    headers: {
      ...await authorizationHeaders(configuration.host === undefined),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "fireside_vector_conformance" }],
        findNearest: {
          vectorField: { fieldPath: "embedding" },
          queryVector: vectorValue([0, 0, 0]),
          distanceMeasure: "EUCLIDEAN",
          limit: 3,
          distanceResultField: "distance",
          distanceThreshold: 2,
        },
      },
    }),
  });
  assert.equal(response.status, 200);
  const rest = await json<readonly RestRunQueryResponse[]>(response);
  assert.deepEqual(rest.flatMap((entry) => entry.document?.name ?? []).map(documentId), [
    "a",
    "c",
  ]);
  assertDistances(
    rest.flatMap((entry) => entry.document?.fields?.distance?.doubleValue ?? []),
    [1, 2],
  );
});

interface RestRunQueryResponse {
  readonly document?: {
    readonly fields?: Readonly<Record<string, { readonly doubleValue?: number }>>;
    readonly name?: string;
  };
}

function assertDistances(actual: readonly unknown[], expected: readonly number[]): void {
  assert.equal(actual.length, expected.length);
  for (const [index, value] of actual.entries()) {
    assert.equal(typeof value, "number");
    assert.ok(Math.abs((value as number) - expected[index]!) < 1e-12);
  }
}

function vectorValue(values: readonly number[]): object {
  return {
    mapValue: {
      fields: {
        __type__: { stringValue: "__vector__" },
        value: {
          arrayValue: {
            values: values.map((value) => ({ doubleValue: value })),
          },
        },
      },
    },
  };
}

function documentId(name: string): string {
  return name.slice(name.lastIndexOf("/") + 1);
}

function hasGrpcCode(error: unknown, expected: number): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === expected
  );
}

async function authorizationHeaders(useCloud: boolean): Promise<Record<string, string>> {
  if (!useCloud) {
    return { authorization: "Bearer owner" };
  }
  const auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/datastore"],
  });
  const headers = await auth.getClient().then(async (client) => client.getRequestHeaders());
  return Object.fromEntries(headers.entries());
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T;
}
