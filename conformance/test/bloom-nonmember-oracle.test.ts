import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadPinnedFirebaseBloomOracle } from "./helpers/firebase-bloom-oracle.ts";

const fixture = JSON.parse(await readFile(new URL(
  "../fixtures/firestore-bloom-nonmember-false-positive/fixture.json", import.meta.url,
), "utf8"));

test("official SDK reproduces a legal nonmember positive with no member false negatives", async () => {
  const BloomFilter = await loadPinnedFirebaseBloomOracle();
  const sample = fixture.deterministicReproduction;
  const name = (id: string): string => `${sample.resourcePrefix}/${id}`;
  const members = sample.memberIds.map(name) as string[];
  const filter = BloomFilter.create(sample.bitCount, sample.hashCount, members);
  assert.equal(Buffer.from(filter.bitmap).toString("base64"), sample.bitmapBase64);
  assert.equal(filter.padding, sample.padding);
  assert.equal(filter.hashCount, sample.hashCount);
  assert.equal(filter.bitmap.byteLength * 8 - filter.padding, sample.bitCount);
  for (const expected of sample.membership) {
    assert.equal(members.includes(name(expected.id)), expected.actualMember, expected.id);
    assert.equal(filter.mightContain(name(expected.id)), expected.mightContain, expected.id);
  }
  const captured = new BloomFilter(Buffer.from(sample.bitmapBase64, "base64"), sample.padding, sample.hashCount);
  assert.equal(captured.mightContain(name("missing")), true);
  assert.equal(captured.mightContain(name("not-present")), false);
  for (const member of members) assert.equal(captured.mightContain(member), true);
});

test("collision bit positions independently follow Google's pinned MD5 double-hash contract", async () => {
  const sample = fixture.deterministicReproduction;
  const hash = createHash("md5").update(`${sample.resourcePrefix}/missing`, "utf8").digest();
  const first = hash.readBigUInt64LE(0);
  const second = hash.readBigUInt64LE(8);
  const positions = Array.from({ length: sample.hashCount }, (_, index) =>
    Number(BigInt.asUintN(64, first + BigInt(index) * second) % BigInt(sample.bitCount)));
  assert.deepEqual(positions, sample.missingBitIndices);
  const bitmap = Buffer.from(sample.bitmapBase64, "base64");
  for (const bit of positions) assert.notEqual(bitmap[Math.floor(bit / 8)]! & (1 << (bit % 8)), 0);
  for (const [file, expectedSha256] of [
    [fixture.protocol.bloomSource, fixture.protocol.bloomSourceSha256],
    [fixture.protocol.existenceFilterSource, fixture.protocol.existenceFilterSourceSha256],
  ]) {
    const source = await readFile(new URL(`../../${file}`, import.meta.url), "utf8");
    assert.equal(createHash("sha256").update(source).digest("hex"), expectedSha256, file);
  }
  const existence = await readFile(new URL(`../../${fixture.protocol.existenceFilterSource}`, import.meta.url), "utf8");
  assert.match(existence, /if the document name is NOT in the filter, it means the document no\s*\/\/ longer matches the target/u);
  assert.equal(fixture.protocol.positiveProvesTargetMembership, false);
  assert.equal(fixture.protocol.actualMemberFalseNegativesAllowed, false);
});

test("fixture distinguishes the preserved CI failure from its separate deterministic oracle reproduction", () => {
  assert.equal(fixture.capturedBeforeAssertionCorrection, true);
  assert.equal(fixture.capture.kind, "offline-official-client-oracle");
  assert.equal(fixture.capture.cloudRequests, 0);
  assert.equal(fixture.capture.emulatorWorkloads, 0);
  assert.equal(fixture.ciFailure.runId, 33969616317);
  assert.equal(fixture.ciFailure.jobId, 101315720932);
  assert.equal(fixture.ciFailure.assertionLocation, "conformance/test/listen.test.ts:300:12");
  assert.equal(fixture.ciFailure.actual, true);
  assert.equal(fixture.ciFailure.expected, false);
  assert.equal(fixture.ciFailure.originalRandomUuidAvailable, false);
  assert.equal(fixture.ciFailure.originalFilterBitmapAvailable, false);
  assert.equal(fixture.ciFailure.exactOriginalInputReproduced, false);
  assert.equal(fixture.deterministicReproduction.originalCiInput, false);
  assert.equal(fixture.correctionBoundary.productChangeEstablished, false);
  assert.equal(fixture.correctionBoundary.resumeOrReadTimeRaceEstablished, false);
  assert.equal(fixture.correctionBoundary.memberNoFalseNegativeAssertionsMustRemain, true);
  assert.equal(fixture.correctionBoundary.returnedFilterMayNotBeSearchedForConvenientNegative, true);
});
