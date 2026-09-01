import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertPhase3TransitiveToolchain,
  type Phase3GateManifest,
} from "../src/rules/phase3-gate-plan.ts";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

async function frozenManifests(): Promise<{
  readonly phase2ManifestText: string;
  readonly phase3Manifest: Phase3GateManifest;
}> {
  const [phase2ManifestText, phase3ManifestText] = await Promise.all([
    readFile(join(repositoryRoot, "benchmarks/phase-2-webchannel.json"), "utf8"),
    readFile(join(repositoryRoot, "benchmarks/phase-3-rules.json"), "utf8"),
  ]);
  return {
    phase2ManifestText,
    phase3Manifest: JSON.parse(phase3ManifestText) as Phase3GateManifest,
  };
}

test("Phase 3 gate accepts the complete transitive frozen toolchain", async () => {
  const { phase2ManifestText, phase3Manifest } = await frozenManifests();
  assert.doesNotThrow(() =>
    assertPhase3TransitiveToolchain(phase3Manifest, phase2ManifestText, {
      java: "openjdk 26.0.2.1 2026-08-18",
      node: "v24.20.0",
      npm: "12.0.2",
      rust: "rustc 1.98.0 (88d9e12ae 2026-08-18)",
    }),
  );
});

test("Phase 3 gate rejects Java 21 before starting measured work", async () => {
  const { phase2ManifestText, phase3Manifest } = await frozenManifests();
  assert.throws(
    () =>
      assertPhase3TransitiveToolchain(phase3Manifest, phase2ManifestText, {
        java: "openjdk 21.0.2 2024-01-16",
        node: "v24.20.0",
        npm: "12.0.2",
        rust: "rustc 1.98.0 (88d9e12ae 2026-08-18)",
      }),
    /frozen toolchain mismatch: java expected major 26, observed openjdk 21\.0\.2/u,
  );
});

test("Phase 3 gate rejects a modified Phase 2 baseline manifest", async () => {
  const { phase2ManifestText, phase3Manifest } = await frozenManifests();
  assert.throws(
    () =>
      assertPhase3TransitiveToolchain(
        phase3Manifest,
        `${phase2ManifestText}\n`,
        {
          java: "openjdk 26.0.2.1 2026-08-18",
          node: "v24.20.0",
          npm: "12.0.2",
          rust: "rustc 1.98.0 (88d9e12ae 2026-08-18)",
        },
      ),
    /frozen Phase 2 baseline manifest SHA-256 mismatch/u,
  );
});
