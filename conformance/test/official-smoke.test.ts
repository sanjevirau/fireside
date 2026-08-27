import assert from "node:assert/strict";
import test from "node:test";

import { createFirestore, resolveTarget } from "../src/target.ts";

test("official Java emulator accepts an SDK write/read/delete round trip", async (context) => {
  const configuration = resolveTarget(process.env);
  assert.equal(configuration.name, "java");

  const firestore = createFirestore(configuration);
  const document = firestore.doc("phase0/smoke");

  context.after(async () => {
    await document.delete().catch(() => undefined);
    await firestore.terminate();
  });

  const expected = {
    message: "harness reaches the official emulator",
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
