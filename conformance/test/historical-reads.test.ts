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

test("read_time reconstructs committed versions after a later delete", async (context) => {
  const configuration = resolveTarget(process.env);
  const firestore = createFirestore(configuration);
  const rawFirestore = createV1Firestore(configuration);
  const runId = randomUUID();
  const database = `projects/${configuration.projectId}/databases/(default)`;
  const document = firestore.doc(
    `runs/${runId}/fireside_historical/document`,
  );
  const name = `${database}/documents/${document.path}`;

  context.after(async () => {
    await document.delete().catch(() => undefined);
    await Promise.all([firestore.terminate(), rawFirestore.close()]).catch(
      () => undefined,
    );
  });

  const first = await document.set({
    _fireside_expires_at: Timestamp.fromMillis(
      Date.now() + DAY_MILLISECONDS,
    ),
    value: "first",
  });
  const second = await document.update({ value: "second" });
  await document.delete();

  const [atFirst] = await rawFirestore.getDocument({
    name,
    readTime: timestamp(first.writeTime),
  });
  const [atSecond] = await rawFirestore.getDocument({
    name,
    readTime: timestamp(second.writeTime),
  });
  assert.equal(atFirst.fields?.value?.stringValue, "first");
  assert.equal(atSecond.fields?.value?.stringValue, "second");

  const readTime = timestamp(first.writeTime);
  const callOptions = configuration.host === undefined
    ? {}
    : { otherArgs: { headers: { authorization: "Bearer owner" } } };
  const batch = await collect<ObservedBatchGet>(
    rawFirestore.batchGetDocuments(
      { database, documents: [name], readTime },
      callOptions,
    ),
  );
  assert.equal(batch[0]?.found?.fields?.value?.stringValue, "first");

  const queryParent = `${database}/documents/runs/${runId}`;
  const structuredQuery = {
    from: [{ collectionId: "fireside_historical" }],
  };
  const query = await collect<ObservedRunQuery>(
    rawFirestore.runQuery(
      { parent: queryParent, structuredQuery, readTime },
      callOptions,
    ),
  );
  assert.deepEqual(
    query.flatMap((response) =>
      response.document?.fields?.value?.stringValue ?? []
    ),
    ["first"],
  );

  const aggregation = await collect<ObservedAggregation>(
    rawFirestore.runAggregationQuery(
      {
        parent: queryParent,
        structuredAggregationQuery: {
          structuredQuery,
          aggregations: [{ alias: "total", count: {} }],
        },
        readTime,
      },
      callOptions,
    ),
  );
  assert.equal(
    String(aggregation[0]?.result?.aggregateFields?.total?.integerValue),
    "1",
  );

  const [listed] = await rawFirestore.listDocuments(
    {
      parent: queryParent,
      collectionId: "fireside_historical",
      pageSize: 10,
      readTime,
    },
    { ...callOptions, autoPaginate: false },
  );
  assert.deepEqual(
    listed.map((entry) => entry.fields?.value?.stringValue),
    ["first"],
  );
  const [collectionIds] = await rawFirestore.listCollectionIds(
    { parent: queryParent, pageSize: 10, readTime },
    { ...callOptions, autoPaginate: false },
  );
  assert.deepEqual(collectionIds, ["fireside_historical"]);

  const [transaction] = await rawFirestore.beginTransaction(
    { database, options: { readOnly: { readTime } } },
    callOptions,
  );
  assert.ok(transaction.transaction);
  const [inTransaction] = await rawFirestore.getDocument(
    { name, transaction: transaction.transaction },
    callOptions,
  );
  assert.equal(inTransaction.fields?.value?.stringValue, "first");
  await rawFirestore.rollback(
    { database, transaction: transaction.transaction },
    callOptions,
  );

  await assert.rejects(
    rawFirestore.getDocument({ name }, callOptions),
    (error: unknown) => grpcCode(error) === 5,
  );
  await assert.rejects(
    rawFirestore.getDocument(
      {
        name,
        readTime: {
          seconds: first.writeTime.seconds,
          nanos: first.writeTime.nanoseconds + 1,
        },
      },
      callOptions,
    ),
    (error: unknown) => grpcCode(error) === 3,
  );
  await assert.rejects(
    rawFirestore.getDocument(
      {
        name,
        readTime: {
          seconds: Math.floor(Date.now() / 1_000) + 3_600,
          nanos: 0,
        },
      },
      callOptions,
    ),
    (error: unknown) => grpcCode(error) === 3,
  );
  await assert.rejects(
    rawFirestore.getDocument(
      {
        name,
        readTime: {
          seconds: Math.floor(Date.now() / 1_000) - 7_200,
          nanos: 0,
        },
      },
      callOptions,
    ),
    (error: unknown) =>
      grpcCode(error) === (configuration.name === "java" ? 5 : 9),
  );
});

interface ObservedBatchGet {
  readonly found?: {
    readonly fields?: {
      readonly value?: { readonly stringValue?: string | null } | null;
    } | null;
  } | null;
}

interface ObservedRunQuery {
  readonly document?: ObservedBatchGet["found"];
}

interface ObservedAggregation {
  readonly result?: {
    readonly aggregateFields?: {
      readonly total?: { readonly integerValue?: unknown } | null;
    } | null;
  } | null;
}

function timestamp(value: Timestamp): { seconds: number; nanos: number } {
  return { seconds: value.seconds, nanos: value.nanoseconds };
}

function grpcCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "number" ? error.code : undefined;
}

async function collect<T>(stream: NodeJS.ReadableStream): Promise<T[]> {
  const values: T[] = [];
  for await (const value of stream as AsyncIterable<T>) {
    values.push(value);
  }
  return values;
}
