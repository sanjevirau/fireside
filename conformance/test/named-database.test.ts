import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createV1Firestore, resolveTarget } from "../src/target.ts";

const DATABASE_ID = "fireside-conformance";

test("named databases preserve isolation in the v1 resource path", async (context) => {
  const configuration = resolveTarget(process.env);
  const firestore = createV1Firestore(configuration);
  const runId = randomUUID();
  const parent = `projects/${configuration.projectId}/databases/${DATABASE_ID}/documents/runs/${runId}`;
  const name = `${parent}/fireside_conformance/named`;
  const defaultName = `projects/${configuration.projectId}/databases/(default)/documents/runs/${runId}/fireside_conformance/named`;

  context.after(async () => {
    await Promise.all([
      firestore.deleteDocument({ name }).catch(() => undefined),
      firestore.deleteDocument({ name: defaultName }).catch(() => undefined),
    ]);
    await firestore.close();
  });

  const create = firestore.createDocument({
    parent,
    collectionId: "fireside_conformance",
    documentId: "named",
    document: {
      fields: { database: { stringValue: DATABASE_ID } },
    },
  });
  const [created] = await create;
  assert.equal(created.name, name);
  const [fetched] = await firestore.getDocument({ name });
  assert.equal(fetched.name, name);
  assert.equal(fetched.fields?.database?.stringValue, DATABASE_ID);

  await assert.rejects(
    firestore.getDocument({ name: defaultName }),
    (error: unknown) => grpcCode(error) === 5,
  );
});

function grpcCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const { code } = error as { readonly code?: unknown };
  return typeof code === "number" ? code : undefined;
}
