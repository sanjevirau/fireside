import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { compareSerializationCapture, normalizeFirestoreValueJson, verifySerializationCapture, type SerializationCapture } from "../src/serialization/verify.ts";

const root = new URL("../fixtures/document-map-serialization/", import.meta.url);
const pins = {
  "1.21.0": ["b1dab2c954b47c8425b6063594584f1c92b1204335de798f1dba5ed7d1d1fb45", "c3d3680a89d946a90a027365ea14c26c6472a162bcf37f099bbb1ebd66d25e8e"],
  "1.22.0": ["67e64ec7fb0a42e7c736fa6672e5bae3428bad2d328050cc463ae9d7a6ba2ff9", "9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c"],
};
const sha = (input: string | Uint8Array): string => createHash("sha256").update(input).digest("hex");
const capture = async (version: string): Promise<SerializationCapture> => JSON.parse(await readFile(new URL(`java-${version}/observations.json`, root), "utf8")) as SerializationCapture;

for (const [version, [checksum, jar]] of Object.entries(pins)) {
  test(`Java ${version} freezes 224 stable repeated document reads`, async () => {
    const dir = new URL(`java-${version}/`, root);
    const manifest = await readFile(new URL("SHA256SUMS", dir), "utf8");
    assert.equal(sha(manifest), checksum);
    const lines = manifest.trim().split("\n"); assert.equal(lines.length, 3);
    const names: string[] = [];
    for (const line of lines) {
      const match = /^([0-9a-f]{64})  ([a-zA-Z0-9.-]+)$/u.exec(line); assert.ok(match);
      names.push(match[2]!); assert.equal(sha(await readFile(new URL(match[2]!, dir))), match[1]);
    }
    assert.deepEqual((await readdir(dir)).sort(), [...names, "SHA256SUMS"].sort());
    const metadata = JSON.parse(await readFile(new URL("metadata.json", dir), "utf8"));
    assert.equal(metadata.javaJarSha256, jar); assert.equal(metadata.version, version);
    assert.equal(metadata.syntheticOnly, true); assert.equal(metadata.writesDuringReadGroups, 0);
    assert.equal(metadata.repeatedReads, 224); assert.equal(metadata.operations, 7);
    verifySerializationCapture(await capture(version));
  });
}
test("both pinned JARs return the same recorded field JSON", async () => {
  const older = await capture("1.21.0"), newer = await capture("1.22.0");
  assert.deepEqual(older, newer); compareSerializationCapture(older, newer);
});
test("a reordered map fails stability without being mistaken for changed values", async () => {
  const original = await capture("1.21.0");
  const changed = structuredClone(original);
  const group = changed.observations[0]!;
  (group.reads as string[])[1] = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(group.reads[0]!)).reverse()));
  assert.throws(() => verifySerializationCapture(changed), /unstable response field order/u);
});
test("cross-server comparison accepts only omitted proto3 empty container defaults", () => {
  const omitted = { emptyArray: { arrayValue: {} }, emptyMap: { mapValue: {} } };
  const explicit = { emptyArray: { arrayValue: { values: [] } }, emptyMap: { mapValue: { fields: {} } } };
  assert.deepEqual(normalizeFirestoreValueJson(omitted), explicit);
  assert.notDeepEqual(
    normalizeFirestoreValueJson({ value: { arrayValue: { values: [{ stringValue: "kept" }] } } }),
    normalizeFirestoreValueJson({ value: { arrayValue: {} } }),
  );
  assert.notDeepEqual(
    normalizeFirestoreValueJson({ value: { mapValue: { fields: { kept: { booleanValue: true } } } } }),
    normalizeFirestoreValueJson({ value: { mapValue: {} } }),
  );
});
