import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { GoogleAuth } from "google-auth-library";

import { resolveTarget } from "../src/target.ts";

interface RestDocument {
  readonly fields?: Readonly<Record<string, RestValue>>;
  readonly name?: string;
}

interface RestError {
  readonly error?: {
    readonly code?: number;
    readonly status?: string;
  };
}

interface RestValue {
  readonly integerValue?: string;
  readonly stringValue?: string;
  readonly timestampValue?: string;
}

interface RestBatchGetResponse {
  readonly found?: RestDocument;
  readonly missing?: string;
}

interface RestCommitResponse {
  readonly commitTime?: string;
  readonly writeResults?: readonly unknown[];
}

interface RestRunQueryResponse {
  readonly document?: RestDocument;
  readonly readTime?: string;
}

test("REST v1 patches, reads, deletes, and reports missing documents", async () => {
  const configuration = resolveTarget(process.env);
  const runId = randomUUID();
  const documentPath = `runs/${runId}/fireside_conformance/rest`;
  const baseUrl = configuration.host === undefined
    ? "https://firestore.googleapis.com"
    : `http://${configuration.host}`;
  const resource = `${baseUrl}/v1/projects/${configuration.projectId}/databases/(default)/documents/${documentPath}`;
  const headers = await authorizationHeaders(configuration.host === undefined);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString();

  const patched = await fetch(resource, {
    method: "PATCH",
    headers: {
      ...headers,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      fields: {
        _fireside_expires_at: { timestampValue: expiresAt },
        count: { integerValue: "7" },
        source: { stringValue: "rest-v1" },
      },
    }),
  });
  assert.equal(patched.status, 200);
  const patchedDocument = await json<RestDocument>(patched);
  assert.equal(patchedDocument.name?.endsWith(`/${documentPath}`), true);
  assert.equal(patchedDocument.fields?.source?.stringValue, "rest-v1");
  assert.equal(patchedDocument.fields?.count?.integerValue, "7");

  const fetched = await fetch(resource, { headers });
  assert.equal(fetched.status, 200);
  const fetchedDocument = await json<RestDocument>(fetched);
  assert.equal(fetchedDocument.fields?.source?.stringValue, "rest-v1");
  assert.equal(fetchedDocument.fields?.count?.integerValue, "7");

  const deleted = await fetch(resource, { method: "DELETE", headers });
  assert.equal(deleted.status, 200);

  const missing = await fetch(resource, { headers });
  assert.equal(missing.status, 404);
  const missingError = await json<RestError>(missing);
  assert.equal(missingError.error?.code, 404);
  assert.equal(missingError.error?.status, "NOT_FOUND");
});

test("REST v1 commit, batchGet, and runQuery share document semantics", async () => {
  const configuration = resolveTarget(process.env);
  const runId = randomUUID();
  const databaseRoot = `projects/${configuration.projectId}/databases/(default)`;
  const documentPath = `runs/${runId}/fireside_conformance/rest-rpc`;
  const documentName = `${databaseRoot}/documents/${documentPath}`;
  const missingName = `${databaseRoot}/documents/runs/${runId}/fireside_conformance/missing`;
  const baseUrl = configuration.host === undefined
    ? "https://firestore.googleapis.com"
    : `http://${configuration.host}`;
  const documentsUrl = `${baseUrl}/v1/${databaseRoot}/documents`;
  const headers = {
    ...await authorizationHeaders(configuration.host === undefined),
    "content-type": "application/json",
  };

  const committed = await fetch(`${documentsUrl}:commit`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      writes: [
        {
          update: {
            name: documentName,
            fields: {
              rank: { integerValue: "1" },
              source: { stringValue: "rest-rpc" },
            },
          },
        },
      ],
    }),
  });
  assert.equal(committed.status, 200);
  const commit = await json<RestCommitResponse>(committed);
  assert.equal(commit.writeResults?.length, 1);
  assert.equal(typeof commit.commitTime, "string");

  const batch = await fetch(`${documentsUrl}:batchGet`, {
    method: "POST",
    headers,
    body: JSON.stringify({ documents: [documentName, missingName] }),
  });
  assert.equal(batch.status, 200);
  const batchResponses = await json<readonly RestBatchGetResponse[]>(batch);
  assert.equal(batchResponses.length, 2);
  assert.equal(
    batchResponses.some((response) => response.found?.name === documentName),
    true,
  );
  assert.equal(
    batchResponses.some((response) => response.missing === missingName),
    true,
  );

  const queried = await fetch(`${documentsUrl}/runs/${runId}:runQuery`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "fireside_conformance" }],
        where: {
          fieldFilter: {
            field: { fieldPath: "source" },
            op: "EQUAL",
            value: { stringValue: "rest-rpc" },
          },
        },
      },
    }),
  });
  assert.equal(queried.status, 200);
  const queryResponses = await json<readonly RestRunQueryResponse[]>(queried);
  assert.deepEqual(
    queryResponses
      .flatMap((response) => response.document?.name ?? [])
      .filter((name) => name === documentName),
    [documentName],
  );
  assert.equal(
    queryResponses.every((response) => typeof response.readTime === "string"),
    true,
  );

  const deleted = await fetch(`${documentsUrl}/${documentPath}`, {
    method: "DELETE",
    headers,
  });
  assert.equal(deleted.status, 200);
});

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
