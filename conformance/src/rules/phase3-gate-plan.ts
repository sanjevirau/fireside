import { createHash } from "node:crypto";

import {
  assertFrozenGateToolchain,
  type FrozenGateToolchain,
  type ObservedGateToolchain,
} from "../webchannel/phase2-gate-plan.ts";

export interface Phase3GateManifest {
  readonly phase2Baseline: {
    readonly manifestSha256: string;
  };
  readonly toolchain: Omit<FrozenGateToolchain, "java">;
}

interface Phase2BaselineManifest {
  readonly frozen: boolean;
  readonly name: string;
  readonly schemaVersion: number;
  readonly toolchain: FrozenGateToolchain;
}

export function assertPhase3TransitiveToolchain(
  phase3Manifest: Phase3GateManifest,
  phase2ManifestText: string,
  observed: ObservedGateToolchain,
): void {
  const observedManifestSha256 = createHash("sha256")
    .update(phase2ManifestText)
    .digest("hex");
  if (observedManifestSha256 !== phase3Manifest.phase2Baseline.manifestSha256) {
    throw new Error(
      `frozen Phase 2 baseline manifest SHA-256 mismatch: expected ${phase3Manifest.phase2Baseline.manifestSha256}, observed ${observedManifestSha256}`,
    );
  }

  const phase2Manifest = JSON.parse(phase2ManifestText) as Phase2BaselineManifest;
  if (
    !phase2Manifest.frozen ||
    phase2Manifest.name !== "phase-2-webchannel" ||
    phase2Manifest.schemaVersion !== 1
  ) {
    throw new Error("Phase 2 baseline manifest is not frozen");
  }

  const expected = {
    java: phase2Manifest.toolchain.java,
    node: phase3Manifest.toolchain.node,
    npm: phase3Manifest.toolchain.npm,
    rust: phase3Manifest.toolchain.rust,
  };
  for (const key of ["node", "npm", "rust"] as const) {
    if (phase2Manifest.toolchain[key] !== expected[key]) {
      throw new Error(
        `Phase 3 ${key} toolchain ${expected[key]} diverges from frozen Phase 2 baseline ${phase2Manifest.toolchain[key]}`,
      );
    }
  }
  assertFrozenGateToolchain(expected, observed);
}
