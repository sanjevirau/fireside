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

function grpcDetails(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("details" in error)) {
    return undefined;
  }
  return typeof error.details === "string" ? error.details : undefined;
}
