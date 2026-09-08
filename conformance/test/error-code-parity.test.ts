import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Timestamp } from "@google-cloud/firestore";

import {
  createFirestore,
  createV1Firestore,
  resolveTarget,
} from "../src/target.ts";

test("write conflicts return the production gRPC status codes", async (context) => {
  const configuration = resolveTarget(process.env);
  const firestore = createFirestore(configuration);
  const rawFirestore = createV1Firestore(configuration);
  const runId = randomUUID();
  const collection = firestore.collection(
    `runs/${runId}/fireside_conformance`,
  );
  const database = `projects/${configuration.projectId}/databases/(default)`;
  const expiresAt = Timestamp.fromMillis(Date.now() + 24 * 60 * 60 * 1_000);

  context.after(async () => {
    const documents = await collection.listDocuments();
    await Promise.all(documents.map((document) => document.delete())).catch(
      () => undefined,
    );
    await Promise.all([firestore.terminate(), rawFirestore.close()]).catch(
      () => undefined,
    );
  });

  const missing = collection.doc("missing-update");
  assert.equal(await grpcCode(() => missing.update({ value: 1 })), 5);

  const duplicate = collection.doc("duplicate-create");
  await duplicate.create({ _fireside_expires_at: expiresAt, value: 1 });
  assert.equal(
    await grpcCode(() =>
      duplicate.create({ _fireside_expires_at: expiresAt, value: 2 }),
    ),
    6,
  );

  const compareAndSet = collection.doc("stale-update-time");
  await compareAndSet.create({ _fireside_expires_at: expiresAt, value: 1 });
  const staleSnapshot = await compareAndSet.get();
  const staleUpdateTime = staleSnapshot.updateTime;
  assert.ok(staleUpdateTime);
  await compareAndSet.update({ value: 2 });
  assert.equal(
    await grpcCode(() =>
      compareAndSet.update(
        { value: 3 },
        { lastUpdateTime: staleUpdateTime },
      ),
    ),
    9,
  );

  const transactionDocument = collection.doc("transaction-conflict");
  await transactionDocument.create({
    _fireside_expires_at: expiresAt,
    value: 1,
  });
  const [firstBeginResponse] = await rawFirestore.beginTransaction({ database });
  const [secondBeginResponse] = await rawFirestore.beginTransaction({
    database,
  });
  const firstTransaction = firstBeginResponse.transaction;
  const secondTransaction = secondBeginResponse.transaction;
  assert.ok(firstTransaction);
  assert.ok(secondTransaction);
  const transactionName = `${database}/documents/${transactionDocument.path}`;
  await Promise.all([
    rawFirestore.getDocument({
      name: transactionName,
      transaction: firstTransaction,
    }),
    rawFirestore.getDocument({
      name: transactionName,
      transaction: secondTransaction,
    }),
  ]);

  const commits = await Promise.allSettled([
    rawFirestore.commit({
      database,
      transaction: firstTransaction,
      writes: [
        {
          update: {
            name: transactionName,
            fields: { value: { integerValue: "2" } },
          },
          updateMask: { fieldPaths: ["value"] },
        },
      ],
    }),
    rawFirestore.commit({
      database,
      transaction: secondTransaction,
      writes: [
        {
          update: {
            name: transactionName,
            fields: { value: { integerValue: "3" } },
          },
          updateMask: { fieldPaths: ["value"] },
        },
      ],
    }),
  ]);
  const fulfilled = commits.filter((result) => result.status === "fulfilled");
  const rejected = commits.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (configuration.name === "java") {
    assert.ok(fulfilled.length <= 1);
    assert.ok(rejected.length >= 1);
    assert.equal(rejected.every((result) => errorCode(result.reason) === 10), true);
    return;
  }
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(errorCode(rejected[0]?.reason), 10);
});

test("Admin SDK retries an aborted read-write transaction", async (context) => {
  const configuration = resolveTarget(process.env);
  const firestore = createFirestore(configuration);
  const rawFirestore = createV1Firestore(configuration);
  const document = firestore.doc(
    `runs/${randomUUID()}/fireside_conformance/transaction-retry`,
  );
  const database = `projects/${configuration.projectId}/databases/(default)`;
  const documentName = `${database}/documents/${document.path}`;
  const expiresAt = Timestamp.fromMillis(Date.now() + 24 * 60 * 60 * 1_000);
  const callOptions = configuration.host === undefined
    ? {}
    : { otherArgs: { headers: { authorization: "Bearer owner" } } };

  context.after(async () => {
    await document.delete().catch(() => undefined);
    await Promise.all([firestore.terminate(), rawFirestore.close()]).catch(
      () => undefined,
    );
  });

  await document.create({ _fireside_expires_at: expiresAt, value: 0 });
  const [competing] = await rawFirestore.beginTransaction(
    { database },
    callOptions,
  );
  const competingTransaction = competing.transaction;
  assert.ok(competingTransaction);
  await rawFirestore.getDocument(
    { name: documentName, transaction: competingTransaction },
    callOptions,
  );
  let attempts = 0;
  const observedValues: number[] = [];
  const returnedValue = await firestore.runTransaction(
    async (transaction) => {
      const snapshot = await transaction.get(document);
      const value = snapshot.get("value") as number;
      attempts += 1;
      observedValues.push(value);
      if (attempts === 1) {
        await rawFirestore.commit(
          {
            database,
            transaction: competingTransaction,
            writes: [
              {
                update: {
                  name: documentName,
                  fields: { value: { integerValue: "10" } },
                },
                updateMask: { fieldPaths: ["value"] },
              },
            ],
          },
          callOptions,
        );
      }
      transaction.update(document, { value: value + 1 });
      return value;
    },
    { maxAttempts: 3 },
  );

  const retryValue = configuration.name === "java" ? 0 : 10;
  assert.equal(attempts, 2);
  assert.deepEqual(observedValues, [0, retryValue]);
  assert.equal(returnedValue, retryValue);
  assert.equal((await document.get()).get("value"), retryValue + 1);
});

async function grpcCode(operation: () => Promise<unknown>): Promise<number> {
  try {
    await operation();
  } catch (error: unknown) {
    return errorCode(error);
  }
  assert.fail("operation unexpectedly succeeded");
}

function errorCode(error: unknown): number {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (typeof code === "number") {
      return code;
    }
  }
  throw error;
}
