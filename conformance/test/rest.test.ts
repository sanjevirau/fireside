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
