import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertFrozenGateToolchain,
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

test("Phase 2 gate accepts the exact frozen toolchain", () => {
  assert.doesNotThrow(() =>
    assertFrozenGateToolchain(
      { java: "26", node: "24.20.0", npm: "12.0.2", rust: "1.98.0" },
      {
        java:
          "openjdk 26.0.2.1 2026-08-18\nOpenJDK Runtime Environment (build 26.0.2.1)",
        node: "v24.20.0",
        npm: "12.0.2",
        rust: "rustc 1.98.0 (88d9e12ae 2026-08-18)",
      },
    ),
  );
});

test("Phase 2 gate rejects a login-shell Java downgrade", () => {
  assert.throws(
    () =>
      assertFrozenGateToolchain(
        { java: "26", node: "24.20.0", npm: "12.0.2", rust: "1.98.0" },
        {
          java: "openjdk 21.0.2 2024-01-16",
          node: "v24.20.0",
          npm: "12.0.2",
          rust: "rustc 1.98.0 (88d9e12ae 2026-08-18)",
        },
      ),
    /frozen toolchain mismatch: java expected major 26, observed openjdk 21\.0\.2/u,
  );
});

test("Phase 2 gate reports every frozen toolchain mismatch", () => {
  assert.throws(
    () =>
      assertFrozenGateToolchain(
        { java: "26", node: "24.20.0", npm: "12.0.2", rust: "1.98.0" },
        {
          java: "not-java",
          node: "v24.19.0",
          npm: "11.0.0",
          rust: "rustc 1.97.0 (unknown)",
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /java expected major 26/u);
      assert.match(error.message, /node expected 24\.20\.0/u);
      assert.match(error.message, /npm expected 12\.0\.2/u);
      assert.match(error.message, /rust expected 1\.98\.0/u);
      return true;
    },
  );
});
