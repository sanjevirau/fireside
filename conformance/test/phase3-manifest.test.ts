import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";

interface Manifest {
  readonly frozen: boolean;
  readonly phase2Baseline: {
    readonly tag: string;
    readonly candidateRevision: string;
  };
  readonly capture: {
    readonly requiredBeforeProductImplementation: boolean;
    readonly minimumGeneratedProductionCases: number;
    readonly requiredFixtures: readonly string[];
    readonly frozenFixtureSha256: Readonly<Record<string, string>>;
  };
  readonly empiricalLimits: {
    readonly functionCallDepth: { readonly maximum: number };
    readonly evaluatedExpressionsPerRequest: { readonly maximum: number };
  };
  readonly complexRuleset: {
    readonly frozenNonBlankLines: number;
    readonly frozenAllowCases: number;
    readonly frozenDenyCases: number;
  };
}

test("the immutable Phase 3 manifest and complete oracle set are checksum-locked", async () => {
  const manifestUrl = new URL("../../benchmarks/phase-3-rules.json", import.meta.url);
  const manifestBytes = await readFile(manifestUrl);
  assert.equal(
    sha256(manifestBytes),
    "5b8547cb0cf7697df6fb98c29b05ccaf412b93c259c22127bd9050d8c495fcc2",
  );
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as Manifest;
  assert.equal(manifest.frozen, true);
  assert.equal(manifest.phase2Baseline.tag, "phase-2");
  assert.equal(
    manifest.phase2Baseline.candidateRevision,
    "eee62330308dd8c1e1965fca9a1f094d582f72c5",
  );
  assert.equal(manifest.capture.requiredBeforeProductImplementation, true);
  assert.equal(manifest.capture.minimumGeneratedProductionCases, 1_024);
  assert.equal(manifest.empiricalLimits.functionCallDepth.maximum, 20);
  assert.equal(
    manifest.empiricalLimits.evaluatedExpressionsPerRequest.maximum,
    1_000,
  );
  assert.equal(manifest.complexRuleset.frozenNonBlankLines, 1_193);
  assert.equal(manifest.complexRuleset.frozenAllowCases, 27);
  assert.equal(manifest.complexRuleset.frozenDenyCases, 18);

  const fixtureRoot = new URL("../fixtures/rules-v2/", import.meta.url);
  for (const name of manifest.capture.requiredFixtures) {
    const expected = manifest.capture.frozenFixtureSha256[name];
    assert.ok(expected !== undefined, `missing frozen hash for ${name}`);
    assert.equal(sha256(await readFile(new URL(name, fixtureRoot))), expected, name);
  }
  const sums = await readFile(new URL("SHA256SUMS", fixtureRoot), "utf8");
  for (const line of sums.trimEnd().split("\n")) {
    const match = /^(?<sha>[0-9a-f]{64})  (?<name>.+)$/u.exec(line);
    assert.ok(match?.groups !== undefined, line);
    assert.equal(
      sha256(await readFile(new URL(match.groups.name!, fixtureRoot))),
      match.groups.sha!,
      match.groups.name!,
    );
  }
});

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
