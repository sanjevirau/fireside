import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  existingConformanceCommands,
  existingConformanceCommandSpecifications,
} from "../src/webchannel/phase2-gate-plan.ts";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

test("Phase 2 conformance plan matches the unchanged frozen manifest", async () => {
  const manifest = JSON.parse(
    await readFile(
      join(repositoryRoot, "benchmarks/phase-2-webchannel.json"),
      "utf8",
    ),
  ) as {
    readonly gates: {
      readonly existingConformance: { readonly commands: readonly string[] };
    };
  };

  assert.deepEqual(
    existingConformanceCommands,
    manifest.gates.existingConformance.commands,
  );
});

test("Phase 2 conformance commands execute directly without a shell", () => {
  assert.equal(existingConformanceCommandSpecifications.length, 16);
  for (const specification of existingConformanceCommandSpecifications) {
    assert.match(specification.executable, /^(?:cargo|npm)$/u);
    assert.doesNotMatch(specification.executable, /[\\/]/u);
    assert.deepEqual(
      [specification.executable, ...specification.arguments].join(" "),
      specification.displayCommand,
    );
  }
});
