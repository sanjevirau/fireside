import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPhase5Manifest,
  PHASE5_DATASET_TREE_SHA256,
  PHASE5_MANIFEST_SHA256,
  PHASE5_TWODART_REVISION,
  type Phase5Manifest,
} from "../src/suite/phase5-acceptance-plan.ts";

const manifestUrl = new URL(
  "../../benchmarks/phase-5-twodart-acceptance.json",
  import.meta.url,
);

test("the immutable Phase 5 manifest freezes the full Twodart differential gate", async () => {
  const bytes = await readFile(manifestUrl);
  const manifest = JSON.parse(bytes.toString("utf8")) as Phase5Manifest;

  assert.doesNotThrow(() => assertPhase5Manifest(manifest, bytes));
  assert.equal(manifest.phase4Baseline.tag, "phase-4");
  assert.equal(manifest.twodartSource.baselineRevision, PHASE5_TWODART_REVISION);
  assert.equal(manifest.dataset.treeSha256, PHASE5_DATASET_TREE_SHA256);
  assert.equal(manifest.dataset.fileCount, 66_758);
  assert.equal(manifest.dataset.fileBytes, 8_180_616_677);
  assert.deepEqual(manifest.dataset.logicalCounts, {
    firestoreDocuments: 211_202,
    authUsers: 1,
    storageObjects: 33_353,
    storageObjectBytes: 6_689_692_200,
  });
  assert.equal(manifest.host.sshAlias, "sanjevi-linux");
  assert.equal(manifest.host.minimumAvailableDiskBytes, 80_000_000_000);
  assert.equal(manifest.lifecycle.allowedCountMismatch, 0);
  assert.equal(manifest.lifecycle.acknowledgedWriteLossAllowed, 0);
  assert.equal(manifest.twodartRuntimeAssets.trees.length, 3);
  assert.equal(
    manifest.twodartRuntimeAssets.trees.reduce(
      (total, tree) => total + tree.fileCount,
      0,
    ),
    10_967,
  );
});

test("the Phase 5 manifest rejects byte drift before any measurement", async () => {
  const bytes = await readFile(manifestUrl);
  const manifest = JSON.parse(bytes.toString("utf8")) as Phase5Manifest;
  const drifted = Buffer.from(bytes);
  drifted[0] = drifted[0] === 0x7b ? 0x20 : 0x7b;

  assert.equal(PHASE5_MANIFEST_SHA256.length, 64);
  assert.throws(() => assertPhase5Manifest(manifest, drifted), /SHA-256 mismatch/u);
});
