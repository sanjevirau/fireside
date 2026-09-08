import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Timestamp } from "@google-cloud/firestore";

import { createFirestore, resolveTarget } from "../src/target.ts";

test("target accepts an SDK write/read/delete round trip", async (context) => {
  const configuration = resolveTarget(process.env);
  const firestore = createFirestore(configuration);
  const document = firestore.doc(
    `fireside_conformance/smoke-${randomUUID()}`,
  );

  context.after(async () => {
    await document.delete().catch(() => undefined);
    await firestore.terminate();
  });

  const expected = {
    _fireside_expires_at: Timestamp.fromMillis(Date.now() + 24 * 60 * 60 * 1000),
    message: "harness reaches the selected target",
    target: configuration.name,
    unicode: "fireside 🔥",
    value: 42,
  };

  await document.set(expected);
  const snapshot = await document.get();

  assert.equal(snapshot.exists, true);
  assert.deepEqual(snapshot.data(), expected);

  await document.delete();
  const deletedSnapshot = await document.get();
  assert.equal(deletedSnapshot.exists, false);
});
