import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Timestamp } from "@google-cloud/firestore";

import {
  createFirestore,
  createV1Firestore,
  resolveTarget,
} from "../src/target.ts";

const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;

test("CreateDocument assigns an ID, preserves masked fields, and rejects conflicts", async (context) => {
  const configuration = resolveTarget(process.env);
  const firestore = createFirestore(configuration);
  const rawFirestore = createV1Firestore(configuration);
  const runId = randomUUID();
  const database = `projects/${configuration.projectId}/databases/(default)`;
  const parentPath = `runs/${runId}`;
  const parent = `${database}/documents/${parentPath}`;
  const collectionId = "fireside_conformance";
  const expiresAt = Timestamp.fromMillis(Date.now() + DAY_MILLISECONDS);
  const callOptions = configuration.host === undefined
    ? {}
    : { otherArgs: { headers: { authorization: "Bearer owner" } } };
  let createdPath: string | undefined;

  context.after(async () => {
    if (createdPath !== undefined) {
      await firestore.doc(createdPath).delete().catch(() => undefined);
    }
    await Promise.all([firestore.terminate(), rawFirestore.close()]).catch(
      () => undefined,
    );
  });

  const request = {
    parent,
    collectionId,
    document: {
      fields: {
        _fireside_expires_at: {
          timestampValue: {
            seconds: Math.floor(expiresAt.toMillis() / 1_000),
            nanos: 0,
          },
        },
        hidden: { stringValue: "persisted" },
        visible: { stringValue: "returned" },
      },
    },
    mask: { fieldPaths: ["visible"] },
  };
  const [created] = await rawFirestore.createDocument(request, callOptions);
  assert.ok(created.name?.startsWith(`${parent}/${collectionId}/`));
  const documentId = created.name?.slice(created.name.lastIndexOf("/") + 1);
  assert.ok(documentId);
  createdPath = `${parentPath}/${collectionId}/${documentId}`;
  assert.deepEqual(Object.keys(created.fields ?? {}), ["visible"]);
  assert.equal(created.createTime !== null, true);
  assert.equal(created.updateTime !== null, true);

  const stored = await firestore.doc(createdPath).get();
  assert.equal(stored.get("visible"), "returned");
  assert.equal(stored.get("hidden"), "persisted");

  await assert.rejects(
    rawFirestore.createDocument(
      {
        parent,
        collectionId,
        documentId,
        document: request.document,
      },
      callOptions,
    ),
    (error: unknown) => grpcCode(error) === 6,
  );
});

test("BulkWriter commits independent writes and surfaces per-write errors", async (context) => {
  const configuration = resolveTarget(process.env);
  const firestore = createFirestore(configuration);
  const runId = randomUUID();
  const collection = firestore.collection(
    `runs/${runId}/fireside_bulk_writer`,
  );
  const expiresAt = Timestamp.fromMillis(Date.now() + DAY_MILLISECONDS);
  const created = collection.doc("created");
  const upserted = collection.doc("upserted");
  const updated = collection.doc("updated");
  const deleted = collection.doc("deleted");
  const conflict = collection.doc("conflict");
  const missing = collection.doc("missing");
  const documents = [created, upserted, updated, deleted, conflict, missing];

  context.after(async () => {
    await Promise.all(documents.map((document) => document.delete())).catch(
      () => undefined,
    );
    await firestore.terminate().catch(() => undefined);
  });

  await Promise.all([
    updated.set({ _fireside_expires_at: expiresAt, value: "before" }),
    deleted.set({ _fireside_expires_at: expiresAt, value: "delete me" }),
    conflict.set({ _fireside_expires_at: expiresAt, value: "original" }),
  ]);

  const writer = firestore.bulkWriter({ throttling: false });
  const observedErrors: Array<{ code: number; path: string }> = [];
  const observedResults: string[] = [];
  writer.onWriteError((error) => {
    observedErrors.push({ code: error.code, path: error.documentRef.path });
    return false;
  });
  writer.onWriteResult((document) => {
    observedResults.push(document.path);
  });

  const operations = [
    writer.create(created, {
      _fireside_expires_at: expiresAt,
      value: "created",
    }),
    writer.set(upserted, {
      _fireside_expires_at: expiresAt,
      value: "upserted",
    }),
    writer.update(updated, { value: "after" }),
    writer.delete(deleted),
    writer.create(conflict, { value: "duplicate" }),
    writer.update(missing, { value: "not found" }),
  ];
  const outcomesPromise = Promise.allSettled(operations);
  await writer.close();
  const outcomes = await outcomesPromise;

  assert.deepEqual(
    observedErrors.sort((left, right) => left.code - right.code),
    [
      { code: 5, path: missing.path },
      { code: 6, path: conflict.path },
    ],
  );
  assert.deepEqual(
    outcomes.map((outcome) => outcome.status),
    ["fulfilled", "fulfilled", "fulfilled", "fulfilled", "rejected", "rejected"],
  );
  assert.equal(grpcCode(rejectionReason(outcomes[4])), 6);
  assert.equal(grpcCode(rejectionReason(outcomes[5])), 5);
  assert.deepEqual(
    observedResults.sort(),
    [created.path, deleted.path, updated.path, upserted.path].sort(),
  );

  const [createdSnapshot, upsertedSnapshot, updatedSnapshot, deletedSnapshot] =
    await firestore.getAll(created, upserted, updated, deleted);
  assert.equal(createdSnapshot!.get("value"), "created");
  assert.equal(upsertedSnapshot!.get("value"), "upserted");
  assert.equal(updatedSnapshot!.get("value"), "after");
  assert.equal(deletedSnapshot!.exists, false);
});

test("BulkWriter accepts a near-5-MiB batch of individually valid documents", async (context) => {
  const configuration = resolveTarget(process.env);
  const firestore = createFirestore(configuration);
  const runId = randomUUID();
  const collection = firestore.collection(
    `runs/${runId}/fireside_large_bulk_writer`,
  );
  const expiresAt = Timestamp.fromMillis(Date.now() + DAY_MILLISECONDS);
  const sizes = [102_400, 307_200, 512_000, 716_800, 921_600];
  const documents = Array.from({ length: 10 }, (_, index) =>
    collection.doc(`document-${String(index).padStart(2, "0")}`)
  );

  context.after(async () => {
    await Promise.all(documents.map((document) => document.delete())).catch(
      () => undefined,
    );
    await firestore.terminate().catch(() => undefined);
  });

  const writer = firestore.bulkWriter({ throttling: false });
  writer.onWriteError(() => false);
  const operations = documents.map((document, index) =>
    writer.set(document, {
      _fireside_expires_at: expiresAt,
      ordinal: index,
      payload: Buffer.alloc(sizes[index % sizes.length]!, 0x4c),
    })
  );
  const outcomesPromise = Promise.allSettled(operations);
  await writer.close();
  const outcomes = await outcomesPromise;

  assert.deepEqual(
    outcomes.map((outcome) => outcome.status),
    Array<string>(documents.length).fill("fulfilled"),
  );
  const [first, last] = await firestore.getAll(documents[0]!, documents.at(-1)!);
  assert.equal(first!.get("ordinal"), 0);
  assert.equal(last!.get("ordinal"), documents.length - 1);
});

test("list RPCs paginate direct children and preserve masks", async (context) => {
  const configuration = resolveTarget(process.env);
  const firestore = createFirestore(configuration);
  const rawFirestore = createV1Firestore(configuration);
  const runId = randomUUID();
  const database = `projects/${configuration.projectId}/databases/(default)`;
  const parentPath = `runs/${runId}`;
  const parent = `${database}/documents/${parentPath}`;
  const expiresAt = Timestamp.fromMillis(Date.now() + DAY_MILLISECONDS);
  const pageOptions = configuration.host === undefined
    ? { autoPaginate: false }
    : {
      autoPaginate: false,
      otherArgs: { headers: { authorization: "Bearer owner" } },
    };
  const alpha = firestore.collection(`${parentPath}/alpha`);
  const beta = firestore.collection(`${parentPath}/beta`);
  const documents = [alpha.doc("a"), alpha.doc("b"), beta.doc("only")];

  context.after(async () => {
    await Promise.all(documents.map((document) => document.delete())).catch(
      () => undefined,
    );
    await Promise.all([firestore.terminate(), rawFirestore.close()]).catch(
      () => undefined,
    );
  });

  await Promise.all([
    documents[0]!.set({
      _fireside_expires_at: expiresAt,
      hidden: "not projected",
      visible: "alpha-a",
    }),
    documents[1]!.set({
      _fireside_expires_at: expiresAt,
      hidden: "not projected",
      visible: "alpha-b",
    }),
    documents[2]!.set({
      _fireside_expires_at: expiresAt,
      visible: "beta",
    }),
  ]);

  const listRequest = {
    parent,
    collectionId: "alpha",
    pageSize: 1,
    orderBy: "__name__",
    mask: { fieldPaths: ["visible"] },
  };
  const [firstDocuments, , firstPage] = await rawFirestore.listDocuments(
    listRequest,
    pageOptions,
  );
  assert.equal(firstDocuments.length, 1);
  const documentPageToken = requiredPageToken(firstPage.nextPageToken);
  assert.deepEqual(Object.keys(firstDocuments[0]?.fields ?? {}), ["visible"]);
  const secondRequest = { ...listRequest, pageToken: documentPageToken };
  if (configuration.name === "java") {
    await assert.rejects(
      rawFirestore.listDocuments(secondRequest, pageOptions),
      (error: unknown) => grpcCode(error) === 2,
    );
  } else {
    const [secondDocuments, , secondPage] = await rawFirestore.listDocuments(
      secondRequest,
      pageOptions,
    );
    assert.equal(secondPage.nextPageToken ?? "", "");
    assert.deepEqual(
      [...firstDocuments, ...secondDocuments].map((document) => document.name),
      [`${parent}/alpha/a`, `${parent}/alpha/b`],
    );
  }

  const [firstCollectionIds, , firstCollections] = await rawFirestore
    .listCollectionIds({ parent, pageSize: 1 }, pageOptions);
  assert.equal(firstCollectionIds.length, 1);
  const collectionPageToken = requiredPageToken(
    firstCollections.nextPageToken,
  );
  const [secondCollectionIds, , secondCollections] = await rawFirestore
    .listCollectionIds(
      {
        parent,
        pageSize: 1,
        pageToken: collectionPageToken,
      },
      pageOptions,
    );
  if (configuration.name === "java") {
    const trailingToken = requiredPageToken(secondCollections.nextPageToken);
    const [trailingCollectionIds, , trailingCollections] = await rawFirestore
      .listCollectionIds(
        { parent, pageSize: 1, pageToken: trailingToken },
        pageOptions,
      );
    assert.deepEqual(trailingCollectionIds, []);
    assert.equal(trailingCollections.nextPageToken ?? "", "");
  } else {
    assert.equal(secondCollections.nextPageToken ?? "", "");
  }
  assert.deepEqual(
    [...firstCollectionIds, ...secondCollectionIds],
    ["alpha", "beta"],
  );
});

test("ListDocuments orders fields and requires a collection selector", async (context) => {
  const configuration = resolveTarget(process.env);
  const firestore = createFirestore(configuration);
  const rawFirestore = createV1Firestore(configuration);
  const runId = randomUUID();
  const database = `projects/${configuration.projectId}/databases/(default)`;
  const parentPath = `runs/${runId}`;
  const parent = `${database}/documents/${parentPath}`;
  const ordered = firestore.collection(`${parentPath}/ordered`);
  const other = firestore.collection(`${parentPath}/other`);
  const documents = [
    ordered.doc("a"),
    ordered.doc("b"),
    ordered.doc("c"),
    ordered.doc("missing"),
    other.doc("x"),
  ];
  const expiresAt = Timestamp.fromMillis(Date.now() + DAY_MILLISECONDS);
  const pageOptions = configuration.host === undefined
    ? { autoPaginate: false }
    : {
      autoPaginate: false,
      otherArgs: { headers: { authorization: "Bearer owner" } },
    };

  context.after(async () => {
    await Promise.all(documents.map(async (document) => document.delete())).catch(
      () => undefined,
    );
    await Promise.all([firestore.terminate(), rawFirestore.close()]).catch(
      () => undefined,
    );
  });

  await Promise.all([
    documents[0]!.set({ _fireside_expires_at: expiresAt, rank: 2 }),
    documents[1]!.set({ _fireside_expires_at: expiresAt, rank: 1 }),
    documents[2]!.set({ _fireside_expires_at: expiresAt, rank: 1 }),
    documents[3]!.set({ _fireside_expires_at: expiresAt }),
    documents[4]!.set({ _fireside_expires_at: expiresAt, rank: 0 }),
  ]);

  const request = {
    parent,
    collectionId: "ordered",
    pageSize: 2,
    orderBy: "rank",
  };
  const [first, , firstResponse] = await rawFirestore.listDocuments(
    request,
    pageOptions,
  );
  assert.deepEqual(first.map((document) => document.name), [
    `${parent}/ordered/b`,
    `${parent}/ordered/c`,
  ]);
  const token = requiredPageToken(firstResponse.nextPageToken);
  if (configuration.name === "java") {
    await assert.rejects(
      rawFirestore.listDocuments({ ...request, pageToken: token }, pageOptions),
      (error: unknown) => grpcCode(error) === 2,
    );
  } else {
    const [second, , secondResponse] = await rawFirestore.listDocuments(
      { ...request, pageToken: token },
      pageOptions,
    );
    assert.deepEqual(second.map((document) => document.name), [
      `${parent}/ordered/a`,
    ]);
    assert.equal(secondResponse.nextPageToken ?? "", "");
  }

  const [descending] = await rawFirestore.listDocuments(
    { ...request, pageSize: 10, orderBy: "rank desc" },
    pageOptions,
  );
  assert.deepEqual(descending.map((document) => document.name), [
    `${parent}/ordered/a`,
    `${parent}/ordered/c`,
    `${parent}/ordered/b`,
  ]);

  await assert.rejects(
    rawFirestore.listDocuments(
      { parent, pageSize: 10, orderBy: "rank" },
      pageOptions,
    ),
    (error: unknown) =>
      grpcCode(error) === 3 &&
      grpcDetails(error) ===
        "kind is required for all orders except __key__ ascending",
  );
});

test("ListDocuments showMissing returns name-only ancestor placeholders", async (context) => {
  const configuration = resolveTarget(process.env);
  const firestore = createFirestore(configuration);
  const rawFirestore = createV1Firestore(configuration);
  const runId = randomUUID();
  const database = `projects/${configuration.projectId}/databases/(default)`;
  const parentPath = `runs/${runId}`;
  const parent = `${database}/documents/${parentPath}`;
  const collectionPath = `${parentPath}/containers`;
  const existing = firestore.doc(`${collectionPath}/existing`);
  const missingChild = firestore.doc(
    `${collectionPath}/missing/children/leaf`,
  );
  const expiresAt = Timestamp.fromMillis(Date.now() + DAY_MILLISECONDS);
  const pageOptions = configuration.host === undefined
    ? { autoPaginate: false }
    : {
      autoPaginate: false,
      otherArgs: { headers: { authorization: "Bearer owner" } },
    };

  context.after(async () => {
    await Promise.all([
      existing.delete().catch(() => undefined),
      missingChild.delete().catch(() => undefined),
    ]);
    await Promise.all([firestore.terminate(), rawFirestore.close()]).catch(
      () => undefined,
    );
  });

  await Promise.all([
    existing.set({ _fireside_expires_at: expiresAt, state: "present" }),
    missingChild.set({ _fireside_expires_at: expiresAt, state: "child" }),
  ]);

  const [ordinary] = await rawFirestore.listDocuments(
    { parent, collectionId: "containers", pageSize: 10 },
    pageOptions,
  );
  assert.deepEqual(ordinary.map((document) => document.name), [
    `${parent}/containers/existing`,
  ]);

  const [withMissing] = await rawFirestore.listDocuments(
    {
      parent,
      collectionId: "containers",
      pageSize: 10,
      showMissing: true,
    },
    pageOptions,
  );
  assert.deepEqual(withMissing.map((document) => document.name), [
    `${parent}/containers/existing`,
    `${parent}/containers/missing`,
  ]);
  assert.equal(withMissing[0]?.fields?.state?.stringValue, "present");
  const placeholder = withMissing[1];
  assert.deepEqual(placeholder?.fields ?? {}, {});
  assert.equal(placeholder?.createTime ?? null, null);
  assert.equal(placeholder?.updateTime ?? null, null);

  const paginatedRequest = {
    parent,
    collectionId: "containers",
    pageSize: 1,
    showMissing: true,
  };
  const [firstPage, , firstResponse] = await rawFirestore.listDocuments(
    paginatedRequest,
    pageOptions,
  );
  assert.deepEqual(firstPage.map((document) => document.name), [
    `${parent}/containers/existing`,
  ]);
  const token = requiredPageToken(firstResponse.nextPageToken);
  const [secondPage, , secondResponse] = await rawFirestore.listDocuments(
    { ...paginatedRequest, pageToken: token },
    pageOptions,
  );
  assert.deepEqual(secondPage.map((document) => document.name), [
    `${parent}/containers/missing`,
  ]);
  if (configuration.name === "java") {
    const trailingToken = requiredPageToken(secondResponse.nextPageToken);
    const [trailingPage, , trailingResponse] = await rawFirestore.listDocuments(
      { ...paginatedRequest, pageToken: trailingToken },
      pageOptions,
    );
    assert.deepEqual(trailingPage, []);
    assert.equal(trailingResponse.nextPageToken ?? "", "");
  } else {
    assert.equal(secondResponse.nextPageToken ?? "", "");
  }

  await assert.rejects(
    rawFirestore.listDocuments(
      {
        parent,
        collectionId: "containers",
        orderBy: "__name__",
        showMissing: true,
      },
      pageOptions,
    ),
    (error: unknown) => grpcCode(error) === 3,
  );
});

test("BatchWrite reports per-write conflicts and commits independent writes", async (context) => {
  const configuration = resolveTarget(process.env);
  const firestore = createFirestore(configuration);
  const rawFirestore = createV1Firestore(configuration);
  const runId = randomUUID();
  const database = `projects/${configuration.projectId}/databases/(default)`;
  const collection = firestore.collection(
    `runs/${runId}/fireside_conformance`,
  );
  const existing = collection.doc("existing");
  const created = collection.doc("created");
  const expiresAt = Timestamp.fromMillis(Date.now() + DAY_MILLISECONDS);
  const callOptions = configuration.host === undefined
    ? {}
    : { otherArgs: { headers: { authorization: "Bearer owner" } } };

  context.after(async () => {
    await Promise.all([
      existing.delete().catch(() => undefined),
      created.delete().catch(() => undefined),
    ]);
    await Promise.all([firestore.terminate(), rawFirestore.close()]).catch(
      () => undefined,
    );
  });

  await existing.create({ _fireside_expires_at: expiresAt, value: "old" });
  const [response] = await rawFirestore.batchWrite(
    {
      database,
      writes: [
        {
          update: {
            name: `${database}/documents/${existing.path}`,
            fields: { value: { stringValue: "must-not-replace" } },
          },
          currentDocument: { exists: false },
        },
        {
          update: {
            name: `${database}/documents/${created.path}`,
            fields: {
              _fireside_expires_at: {
                timestampValue: {
                  seconds: Math.floor(expiresAt.toMillis() / 1_000),
                  nanos: 0,
                },
              },
              value: { stringValue: "created" },
            },
          },
          currentDocument: { exists: false },
        },
      ],
    },
    callOptions,
  );

  assert.deepEqual(response.status?.map((status) => status.code), [6, 0]);
  assert.equal(response.writeResults?.length, 2);
  assert.equal((await existing.get()).get("value"), "old");
  assert.equal((await created.get()).get("value"), "created");
});

function requiredPageToken(value: string | null | undefined): string {
  assert.equal(typeof value, "string");
  assert.notEqual(value, "");
  return value as string;
}

function grpcCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "number" ? error.code : undefined;
}

function rejectionReason(result: PromiseSettledResult<unknown> | undefined): unknown {
  assert.equal(result?.status, "rejected");
  return result?.status === "rejected" ? result.reason : undefined;
}

function grpcDetails(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("details" in error)) {
    return undefined;
  }
  return typeof error.details === "string" ? error.details : undefined;
}
