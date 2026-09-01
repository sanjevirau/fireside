import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("Java WebChannel comparison plan is frozen, balanced, and non-gating", async () => {
  const manifest = JSON.parse(
    await readFile(
      join(repositoryRoot, "benchmarks/phase-2-java-webchannel-comparison.json"),
      "utf8",
    ),
  ) as {
    readonly classification: string;
    readonly failurePolicy: {
      readonly startPhase3: boolean;
      readonly tagPhase2: boolean;
    };
    readonly frozen: boolean;
    readonly interpretation: {
      readonly noPassFailPerformanceThreshold: boolean;
      readonly phase2VerdictMayNotBeChangedByComparison: boolean;
    };
    readonly name: string;
    readonly phase2: {
      readonly manifest: string;
      readonly manifestSha256: string;
    };
    readonly workload: {
      readonly listenerSamplesPerVariantPerRepetition: number;
      readonly measuredRepetitionsPerBlock: number;
      readonly targetBlockOrder: readonly string[];
      readonly totalListenerSamplesPerTargetAndVariant: number;
      readonly totalReconnectSamplesPerTargetAndVariant: number;
      readonly variants: readonly string[];
    };
  };
  assert.equal(manifest.frozen, true);
  assert.equal(manifest.name, "phase-2-java-webchannel-comparison");
  assert.equal(manifest.classification, "non-gating-post-pass-comparison");
  assert.deepEqual(manifest.workload.targetBlockOrder, [
    "fireside",
    "java",
    "java",
    "fireside",
  ]);
  assert.deepEqual(manifest.workload.variants, [
    "long-polling",
    "streaming",
    "buffering-proxy-auto-detection",
  ]);
  const targetBlocks = manifest.workload.targetBlockOrder.length / 2;
  assert.equal(
    targetBlocks *
      manifest.workload.measuredRepetitionsPerBlock *
      manifest.workload.listenerSamplesPerVariantPerRepetition,
    manifest.workload.totalListenerSamplesPerTargetAndVariant,
  );
  assert.equal(
    targetBlocks * manifest.workload.measuredRepetitionsPerBlock,
    manifest.workload.totalReconnectSamplesPerTargetAndVariant,
  );
  assert.equal(manifest.interpretation.noPassFailPerformanceThreshold, true);
  assert.equal(manifest.interpretation.phase2VerdictMayNotBeChangedByComparison, true);
  assert.equal(manifest.failurePolicy.tagPhase2, false);
  assert.equal(manifest.failurePolicy.startPhase3, false);

  const phase2Manifest = await readFile(
    join(repositoryRoot, manifest.phase2.manifest),
  );
  assert.equal(
    createHash("sha256").update(phase2Manifest).digest("hex"),
    manifest.phase2.manifestSha256,
  );
});

test("browser runner exposes pinned Java and repeatable measurement controls", async () => {
  const source = await readFile(
    join(repositoryRoot, "conformance/src/webchannel/run-browser-demo.ts"),
    "utf8",
  );
  for (const contract of [
    'argumentValue("--target")',
    'positiveIntegerArgument("--repetitions"',
    'positiveIntegerArgument("--warmup-repetitions"',
    "official Java emulator hash mismatch",
    "startResourceMonitor(targetProcess)",
  ]) {
    assert.match(source, new RegExp(contract.replaceAll(/[()]/g, "\\$&")));
  }
});
