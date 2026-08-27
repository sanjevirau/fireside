import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";

import { Timestamp } from "@google-cloud/firestore";

import {
  createFirestore,
  createV1Firestore,
  resolveTarget,
} from "../src/target.ts";

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

interface ExplainMetrics {
  readonly planSummary?: { readonly indexesUsed?: readonly unknown[] } | null;
  readonly executionStats?: {
    readonly resultsReturned?: unknown;
    readonly executionDuration?: unknown;
    readonly readOperations?: unknown;
    readonly debugStats?: unknown;
  } | null;
}

interface RunQueryResponse {
  readonly document?: { readonly name?: string } | null;
  readonly explainMetrics?: ExplainMetrics | null;
}

interface RunAggregationQueryResponse {
  readonly result?: {
    readonly aggregateFields?: {
      readonly total?: { readonly integerValue?: unknown } | null;
    } | null;
  } | null;
  readonly explainMetrics?: ExplainMetrics | null;
}

test("RunQuery explain separates planning from analyzed execution", async (context) => {
  const configuration = resolveTarget(process.env);
  const firestore = createFirestore(configuration);
  const rawFirestore = createV1Firestore(configuration);
  const runId = randomUUID();
  const database = `projects/${configuration.projectId}/databases/(default)`;
  const parentPath = `runs/${runId}`;
  const parent = `${database}/documents/${parentPath}`;
  const collection = firestore.collection(`${parentPath}/explain`);
  const documents = [collection.doc("a"), collection.doc("b")];
  const expiresAt = Timestamp.fromMillis(Date.now() + DAY_MILLISECONDS);
  const callOptions = configuration.host === undefined
    ? {}
    : { otherArgs: { headers: { authorization: "Bearer owner" } } };

  context.after(async () => {
    await Promise.all(documents.map(async (document) => document.delete())).catch(
      () => undefined,
    );
    await Promise.all([firestore.terminate(), rawFirestore.close()]).catch(
      () => undefined,
    );
  });

  await Promise.all([
    documents[0]!.set({ _fireside_expires_at: expiresAt, score: 2 }),
    documents[1]!.set({ _fireside_expires_at: expiresAt, score: 1 }),
  ]);

  const structuredQuery = {
    from: [{ collectionId: "explain" }],
    orderBy: [
      { field: { fieldPath: "score" }, direction: "ASCENDING" as const },
    ],
  };
  const expectedNames = [documents[1]!.path, documents[0]!.path]
    .map((path) => `${database}/documents/${path}`);
  const planned = await collect<RunQueryResponse>(
    rawFirestore.runQuery(
      { parent, structuredQuery, explainOptions: { analyze: false } },
      callOptions,
    ),
  );
  if (configuration.name === "java") {
    assert.deepEqual(documentNames(planned), expectedNames);
    assert.equal(planned.filter(hasExplainMetrics).length, 0);
  } else {
    assert.deepEqual(documentNames(planned), []);
    assert.equal(planned.filter(hasExplainMetrics).length, 1);
    const plannedMetrics = planned.at(-1)?.explainMetrics;
    assert.ok(plannedMetrics?.planSummary);
    assert.ok((plannedMetrics.planSummary.indexesUsed?.length ?? 0) > 0);
    assert.equal(plannedMetrics.executionStats ?? null, null);
  }

  const analyzed = await collect<RunQueryResponse>(
    rawFirestore.runQuery(
      { parent, structuredQuery, explainOptions: { analyze: true } },
      callOptions,
    ),
  );
  assert.deepEqual(documentNames(analyzed), expectedNames);
  if (configuration.name === "java") {
    assert.equal(analyzed.filter(hasExplainMetrics).length, 0);
  } else {
    assert.equal(analyzed.filter(hasExplainMetrics).length, 1);
    const analyzedMetrics = analyzed.at(-1)?.explainMetrics;
    assert.ok(analyzedMetrics?.planSummary);
    assert.ok((analyzedMetrics.planSummary.indexesUsed?.length ?? 0) > 0);
    assert.equal(String(analyzedMetrics.executionStats?.resultsReturned), "2");
    assert.ok(analyzedMetrics.executionStats?.executionDuration);
    assert.ok(analyzedMetrics.executionStats?.readOperations !== undefined);
    assert.ok(analyzedMetrics.executionStats?.debugStats);
  }
});

test("RunAggregationQuery explain reports the aggregate result count", async (context) => {
  const configuration = resolveTarget(process.env);
  const firestore = createFirestore(configuration);
  const rawFirestore = createV1Firestore(configuration);
  const runId = randomUUID();
  const database = `projects/${configuration.projectId}/databases/(default)`;
  const parentPath = `runs/${runId}`;
  const parent = `${database}/documents/${parentPath}`;
  const collection = firestore.collection(`${parentPath}/aggregate_explain`);
  const documents = [collection.doc("a"), collection.doc("b")];
  const expiresAt = Timestamp.fromMillis(Date.now() + DAY_MILLISECONDS);
  const callOptions = configuration.host === undefined
    ? {}
    : { otherArgs: { headers: { authorization: "Bearer owner" } } };

  context.after(async () => {
    await Promise.all(documents.map(async (document) => document.delete())).catch(
      () => undefined,
    );
    await Promise.all([firestore.terminate(), rawFirestore.close()]).catch(
      () => undefined,
    );
  });

  await Promise.all([
    documents[0]!.set({ _fireside_expires_at: expiresAt, score: 2 }),
    documents[1]!.set({ _fireside_expires_at: expiresAt, score: 1 }),
  ]);

  const structuredAggregationQuery = {
    structuredQuery: {
      from: [{ collectionId: "aggregate_explain" }],
      orderBy: [
        { field: { fieldPath: "score" }, direction: "ASCENDING" as const },
      ],
    },
    aggregations: [{ alias: "total", count: {} }],
  };
  const planned = await collect<RunAggregationQueryResponse>(
    rawFirestore.runAggregationQuery(
      {
        parent,
        structuredAggregationQuery,
        explainOptions: { analyze: false },
      },
      callOptions,
    ),
  );
  if (configuration.name === "java") {
    assert.equal(aggregateCount(planned), "2");
    assert.equal(planned.filter(hasExplainMetrics).length, 0);
  } else {
    assert.equal(aggregateCount(planned), undefined);
    assert.equal(planned.filter(hasExplainMetrics).length, 1);
    const plannedMetrics = planned.at(-1)?.explainMetrics;
    assert.ok(plannedMetrics?.planSummary);
    assert.ok((plannedMetrics.planSummary.indexesUsed?.length ?? 0) > 0);
    assert.equal(plannedMetrics.executionStats ?? null, null);
  }

  const analyzed = await collect<RunAggregationQueryResponse>(
    rawFirestore.runAggregationQuery(
      {
        parent,
        structuredAggregationQuery,
        explainOptions: { analyze: true },
      },
      callOptions,
    ),
  );
  assert.equal(aggregateCount(analyzed), "2");
  if (configuration.name === "java") {
    assert.equal(analyzed.filter(hasExplainMetrics).length, 0);
  } else {
    assert.equal(analyzed.filter(hasExplainMetrics).length, 1);
    const analyzedMetrics = analyzed.at(-1)?.explainMetrics;
    assert.ok(analyzedMetrics?.planSummary);
    assert.ok((analyzedMetrics.planSummary.indexesUsed?.length ?? 0) > 0);
    assert.equal(String(analyzedMetrics.executionStats?.resultsReturned), "1");
    assert.ok(analyzedMetrics.executionStats?.executionDuration);
    assert.ok(analyzedMetrics.executionStats?.readOperations !== undefined);
    assert.ok(analyzedMetrics.executionStats?.debugStats);
  }
});

function hasExplainMetrics(
  response: { readonly explainMetrics?: ExplainMetrics | null },
): boolean {
  return response.explainMetrics !== undefined && response.explainMetrics !== null;
}

function documentNames(responses: readonly RunQueryResponse[]): string[] {
  return responses.flatMap((response) => response.document?.name ?? []);
}

function aggregateCount(
  responses: readonly RunAggregationQueryResponse[],
): string | undefined {
  const value = responses.find((response) => response.result !== undefined)
    ?.result?.aggregateFields?.total?.integerValue;
  return value === undefined ? undefined : String(value);
}

async function collect<T>(stream: NodeJS.ReadableStream): Promise<T[]> {
  const values: T[] = [];
  for await (const value of stream as AsyncIterable<T>) {
    values.push(value);
  }
  return values;
}
