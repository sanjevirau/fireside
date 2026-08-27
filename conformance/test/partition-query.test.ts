import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { FieldPath, Timestamp } from "@google-cloud/firestore";

import {
  createFirestore,
  createV1Firestore,
  resolveTarget,
} from "../src/target.ts";

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;
const DOCUMENT_COUNT = 256;
const COLLECTION_ID = "fireside_partition_conformance";

test("partitionQuery returns ordered document-name split cursors", async (context) => {
  const configuration = resolveTarget(process.env);
  const firestore = createFirestore(configuration);
  const rawFirestore = createV1Firestore(configuration);
  const runId = randomUUID();
  const collection = firestore.collection(
    `runs/${runId}/${COLLECTION_ID}`,
  );
  let seeded = false;

  context.after(async () => {
    if (seeded) {
      const writer = firestore.bulkWriter();
      for (let index = 0; index < DOCUMENT_COUNT; index += 1) {
        writer.delete(collection.doc(index.toString().padStart(3, "0")));
      }
      await writer.close().catch(() => undefined);
    }
    await Promise.all([firestore.terminate(), rawFirestore.close()]).catch(
      () => undefined,
    );
  });

  const request = {
    parent: `projects/${configuration.projectId}/databases/(default)/documents`,
    structuredQuery: {
      from: [{ collectionId: COLLECTION_ID, allDescendants: true }],
      orderBy: [
        { field: { fieldPath: "__name__" }, direction: "ASCENDING" as const },
      ],
    },
    partitionCount: 4,
  };

  if (configuration.name === "java") {
    await assert.rejects(
      rawFirestore.partitionQuery(request),
      (error: unknown) => grpcCode(error) === 12,
    );
    return;
  }

  const writer = firestore.bulkWriter();
  for (let index = 0; index < DOCUMENT_COUNT; index += 1) {
    writer.set(collection.doc(index.toString().padStart(3, "0")), {
      _fireside_expires_at: Timestamp.fromMillis(
        Date.now() + DAY_MILLISECONDS,
      ),
      ordinal: index,
    });
  }
  await writer.close();
  seeded = true;

  const [partitions] = await rawFirestore.partitionQuery(request);
  const references = partitions.map((partition) => {
    assert.equal(partition.values?.length, 1);
    const reference = partition.values?.[0]?.referenceValue;
    assert.equal(typeof reference, "string");
    return reference as string;
  });
  assert.equal(references.length <= request.partitionCount, true);
  assert.equal(partitions.every((partition) => !partition.before), true);
  assert.deepEqual(references, [...new Set(references)].sort());
  assert.equal(
    references.every((reference) =>
      reference.startsWith(
        `projects/${configuration.projectId}/databases/(default)/documents/runs/${runId}/${COLLECTION_ID}/`,
      ),
    ),
    true,
  );

  const base = firestore
    .collectionGroup(COLLECTION_ID)
    .orderBy(FieldPath.documentId());
  const boundaries = references.map((reference) =>
    firestore.doc(reference.split("/documents/")[1] ?? "invalid/reference"),
  );
  const queries = Array.from({ length: boundaries.length + 1 }, (_, index) => {
    let query = base;
    if (index > 0) {
      query = query.startAt(boundaries[index - 1]);
    }
    if (index < boundaries.length) {
      query = query.endBefore(boundaries[index]);
    }
    return query;
  });
  const snapshots = await Promise.all(queries.map(async (query) => query.get()));
  const actualPaths = snapshots
    .flatMap((snapshot) => snapshot.docs.map((entry) => entry.ref.path))
    .sort();
  assert.deepEqual(
    actualPaths,
    Array.from(
      { length: DOCUMENT_COUNT },
      (_, index) =>
        `runs/${runId}/${COLLECTION_ID}/${index.toString().padStart(3, "0")}`,
    ),
  );
});

function grpcCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "number" ? error.code : undefined;
}
