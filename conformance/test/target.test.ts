import assert from "node:assert/strict";
import test from "node:test";

import { resolveTarget } from "../src/target.ts";

test("resolves an emulator target only with an explicit host", () => {
  assert.deepEqual(
    resolveTarget({
      CONFORMANCE_TARGET: "java",
      FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
      GCLOUD_PROJECT: "demo-fixture",
    }),
    {
      name: "java",
      host: "127.0.0.1:8080",
      projectId: "demo-fixture",
    },
  );

  assert.throws(
    () => resolveTarget({ CONFORMANCE_TARGET: "fireside" }),
    /requires FIRESTORE_EMULATOR_HOST/,
  );
});

test("refuses a cloud project without an exact independent allowlist", () => {
  assert.throws(
    () =>
      resolveTarget({
        CONFORMANCE_TARGET: "cloud",
        CONFORMANCE_CLOUD_PROJECT: "unexpected-project",
        CONFORMANCE_CLOUD_ALLOWLIST: "dedicated-conformance-project",
      }),
    /must exactly match/,
  );

  assert.deepEqual(
    resolveTarget({
      CONFORMANCE_TARGET: "cloud",
      CONFORMANCE_CLOUD_PROJECT: "dedicated-conformance-project",
      CONFORMANCE_CLOUD_ALLOWLIST: "dedicated-conformance-project",
    }),
    {
      name: "cloud",
      projectId: "dedicated-conformance-project",
    },
  );
});

test("rejects unknown targets", () => {
  assert.throws(
    () => resolveTarget({ CONFORMANCE_TARGET: "other" }),
    /unsupported CONFORMANCE_TARGET/,
  );
});
