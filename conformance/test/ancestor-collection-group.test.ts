import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Timestamp } from "@google-cloud/firestore";
import { GoogleAuth } from "google-auth-library";

import {
  createFirestore,
  createV1Firestore,
  resolveTarget,
} from "../src/target.ts";

const COLLECTION_ID = "fireside_ancestor_items";
const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;

interface RunQueryResponse {
  readonly document?: { readonly name?: string };
}

test("collection-group queries honor an ancestor document", async (context) => {
  const configuration = resolveTarget(process.env);
  const firestore = createFirestore(configuration);
  const rawFirestore = createV1Firestore(configuration);
  const runId = randomUUID();
  const database = `projects/${configuration.projectId}/databases/(default)`;
  const parentPath = `runs/${runId}`;
  const paths = [
    `${parentPath}/${COLLECTION_ID}/direct`,
    `${parentPath}/branches/branch/${COLLECTION_ID}/deep`,
    `runs/${runId}-outside/${COLLECTION_ID}/outside`,
  ];
  const expected = paths
    .slice(0, 2)
    .map((path) => `${database}/documents/${path}`)
    .sort();

  context.after(async () => {
    const writer = firestore.bulkWriter();
    for (const path of paths) {
      writer.delete(firestore.doc(path));
    }
    await writer.close().catch(() => undefined);
    await Promise.all([firestore.terminate(), rawFirestore.close()]).catch(
      () => undefined,
    );
  });

  const writer = firestore.bulkWriter();
  for (const path of paths) {
    writer.set(firestore.doc(path), {
      _fireside_expires_at: Timestamp.fromMillis(
        Date.now() + DAY_MILLISECONDS,
      ),
      path,
    });
  }
  await writer.close();

  const structuredQuery = {
    from: [{ collectionId: COLLECTION_ID, allDescendants: true }],
    orderBy: [
      { field: { fieldPath: "__name__" }, direction: "ASCENDING" as const },
    ],
  };
  const parent = `${database}/documents/${parentPath}`;
  const callOptions = configuration.host === undefined
    ? {}
    : { otherArgs: { headers: { authorization: "Bearer owner" } } };
  const grpcResponses = await collect<RunQueryResponse>(
    rawFirestore.runQuery({ parent, structuredQuery }, callOptions),
  );
  assert.deepEqual(
    grpcResponses.flatMap((response) => response.document?.name ?? []).sort(),
    expected,
  );

  const baseUrl = configuration.host === undefined
    ? "https://firestore.googleapis.com"
    : `http://${configuration.host}`;
  const restResponse = await fetch(`${baseUrl}/v1/${parent}:runQuery`, {
    method: "POST",
    headers: {
      ...await authorizationHeaders(configuration.host === undefined),
      "content-type": "application/json",
    },
    body: JSON.stringify({ structuredQuery }),
  });
  assert.equal(restResponse.status, 200);
  const restResponses = await json<readonly RunQueryResponse[]>(restResponse);
  assert.deepEqual(
    restResponses.flatMap((response) => response.document?.name ?? []).sort(),
    expected,
  );
});

async function collect<T>(stream: NodeJS.ReadableStream): Promise<T[]> {
  const values: T[] = [];
  for await (const value of stream as AsyncIterable<T>) {
    values.push(value);
  }
  return values;
}

async function authorizationHeaders(
  cloud: boolean,
): Promise<Record<string, string>> {
  if (!cloud) {
    return { authorization: "Bearer owner" };
  }
  const auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/datastore"],
  });
  const client = await auth.getClient();
  const headers = await client.getRequestHeaders();
  return Object.fromEntries(headers.entries());
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T;
}
