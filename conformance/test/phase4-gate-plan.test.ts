import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertPhase4Manifest,
  assertPhase4Toolchain,
  type Phase4Manifest,
} from "../src/suite/phase4-gate-plan.ts";

const manifestUrl = new URL(
  "../../benchmarks/phase-4-twodart-suite.json",
  import.meta.url,
);

test("the Phase 4 gate plan accepts only the frozen manifest and exact gate toolchain", async () => {
  const bytes = await readFile(manifestUrl);
  const manifest = JSON.parse(bytes.toString("utf8")) as Phase4Manifest;
  assert.doesNotThrow(() => assertPhase4Manifest(manifest, bytes));
  assert.doesNotThrow(() =>
    assertPhase4Toolchain(manifest, {
      bun: "1.3.14",
      firebaseAdmin: "13.10.0",
      firebaseFunctions: "7.2.5",
      firebaseJsSdk: "12.15.0",
      firebaseTools: "15.22.0",
      java: "openjdk 26 2026-03-17",
      node: "v24.20.0",
      npm: "12.0.2",
      rust: "rustc 1.98.0 (123456789 2026-07-01)",
    }),
  );
});

test("the Phase 4 gate plan rejects manifest drift and transitive toolchain drift", async () => {
  const bytes = await readFile(manifestUrl);
  const manifest = JSON.parse(bytes.toString("utf8")) as Phase4Manifest;
  const drifted = Buffer.from(bytes);
  drifted[0] = drifted[0] === 0x7b ? 0x20 : 0x7b;
  assert.throws(() => assertPhase4Manifest(manifest, drifted), /SHA-256 mismatch/u);
  assert.throws(
    () =>
      assertPhase4Toolchain(manifest, {
        bun: "1.3.14",
        firebaseAdmin: "13.10.0",
        firebaseFunctions: "7.2.5",
        firebaseJsSdk: "12.15.0",
        firebaseTools: "15.22.0",
        java: "openjdk 26 2026-03-17",
        node: "v24.19.0",
        npm: "12.0.2",
        rust: "rustc 1.98.0",
      }),
    /Node mismatch/u,
  );
});
