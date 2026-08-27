import assert from "node:assert/strict";
import test from "node:test";

import {
  CLOUD_PROJECT_ID,
  ENTERPRISE_DATABASE_ID,
  resolveTarget,
} from "../src/target.ts";

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
        CONFORMANCE_CLOUD_ALLOWLIST: CLOUD_PROJECT_ID,
      }),
    /must exactly match/,
  );

  assert.deepEqual(
    resolveTarget({
      CONFORMANCE_TARGET: "cloud",
      CONFORMANCE_CLOUD_PROJECT: CLOUD_PROJECT_ID,
      CONFORMANCE_CLOUD_ALLOWLIST: CLOUD_PROJECT_ID,
    }),
    {
      name: "cloud",
      projectId: CLOUD_PROJECT_ID,
    },
  );
});

test("refuses a different cloud project even when duplicate inputs match", () => {
  assert.throws(
    () =>
      resolveTarget({
        CONFORMANCE_TARGET: "cloud",
        CONFORMANCE_CLOUD_PROJECT: "other-dedicated-project",
        CONFORMANCE_CLOUD_ALLOWLIST: "other-dedicated-project",
      }),
    /only allows cloud project fireside-conformance/,
  );
});

test("only allows the dedicated Enterprise cloud database", () => {
  const environment = {
    CONFORMANCE_TARGET: "cloud",
    CONFORMANCE_CLOUD_PROJECT: CLOUD_PROJECT_ID,
    CONFORMANCE_CLOUD_ALLOWLIST: CLOUD_PROJECT_ID,
  };
  assert.deepEqual(
    resolveTarget({
      ...environment,
      CONFORMANCE_CLOUD_DATABASE: ENTERPRISE_DATABASE_ID,
    }),
    {
      name: "cloud",
      projectId: CLOUD_PROJECT_ID,
      databaseId: ENTERPRISE_DATABASE_ID,
    },
  );
  assert.throws(
    () =>
      resolveTarget({
        ...environment,
        CONFORMANCE_CLOUD_DATABASE: "other-database",
      }),
    /only allows cloud database fireside-enterprise-conformance/,
  );
});

test("rejects unknown targets", () => {
  assert.throws(
    () => resolveTarget({ CONFORMANCE_TARGET: "other" }),
    /unsupported CONFORMANCE_TARGET/,
  );
});
