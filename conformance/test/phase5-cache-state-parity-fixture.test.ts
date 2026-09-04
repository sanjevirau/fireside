import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertPhase5GeneratedCacheParity,
  isPhase5GeneratedCacheObject,
  measurePhase5GeneratedCache,
  phase5GeneratedCacheMetadataSize,
  PHASE5_GENERATED_CACHE_BUCKET,
  PHASE5_GENERATED_CACHE_NAME,
} from "../src/suite/phase5-cache-state-parity.ts";

const fixtureUrl = new URL(
  "../fixtures/phase5-cache-state-parity/observations.json",
  import.meta.url,
);

interface Observation {
  readonly attempt: "r29" | "r31";
  readonly decodedBytes: number;
  readonly decodedSha256: string;
  readonly gzipBytes: number;
  readonly gzipSha256: string;
  readonly normalizedSha256: string;
  readonly stack: "official" | "fireside";
}

interface Fixture {
  readonly dynamicPaths: readonly string[];
  readonly observations: readonly Observation[];
  readonly r31InitialStateFailure: {
    readonly fireside: {
      readonly authUsers: number;
      readonly firestoreDocuments: number;
      readonly storageObjectBytes: number;
      readonly storageObjects: number;
    };
    readonly official: {
      readonly authUsers: number;
      readonly firestoreDocuments: number;
      readonly storageObjectBytes: number;
      readonly storageObjects: number;
    };
  };
  readonly syntheticOnly: boolean;
}

test("generated Phase 5 cache bytes vary while normalized oracle values match", async () => {
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8")) as Fixture;
  assert.equal(fixture.syntheticOnly, true);
  assert.deepEqual(fixture.dynamicPaths, [
    "metadata.buildTimestamp",
    "data.general.slideThemeData[].chunkedJsonLink",
  ]);
  assert.equal(fixture.observations.length, 4);
  assert.deepEqual(new Set(fixture.observations.map(({ decodedBytes }) => decodedBytes)), new Set([107_473]));
  assert.equal(new Set(fixture.observations.map(({ normalizedSha256 }) => normalizedSha256)).size, 1);
  assert.equal(new Set(fixture.observations.map(({ decodedSha256 }) => decodedSha256)).size, 4);
  assert.equal(new Set(fixture.observations.map(({ gzipSha256 }) => gzipSha256)).size, 4);

  const official = fixture.observations.filter(({ stack }) => stack === "official");
  assert.deepEqual(official.map(({ gzipBytes }) => gzipBytes), [12_436, 12_437]);
  for (const attempt of ["r29", "r31"] as const) {
    const sizes = fixture.observations
      .filter((observation) => observation.attempt === attempt)
      .map(({ gzipBytes }) => gzipBytes);
    assert.equal(new Set(sizes).size, 1);
  }

  assert.deepEqual(fixture.r31InitialStateFailure, {
    official: {
      authUsers: 0,
      firestoreDocuments: 0,
      storageObjects: 1,
      storageObjectBytes: 11_889,
    },
    fireside: {
      authUsers: 0,
      firestoreDocuments: 0,
      storageObjects: 1,
      storageObjectBytes: 11_891,
    },
  });
});

test("generated cache parity normalizes only the frozen dynamic contract", () => {
  const body = (buildTimestamp: number, storagePort: number, fixed = "same") =>
    Buffer.from(JSON.stringify({
      data: {
        general: {
          fixed,
          slideThemeData: [{
            chunkedJsonLink:
              `http://127.0.0.1:${String(storagePort)}/download/chunk.json`,
          }],
        },
      },
      metadata: { buildTimestamp, retained: "measured" },
    }));
  const official = measurePhase5GeneratedCache(body(1, 23_002), 123);
  const fireside = measurePhase5GeneratedCache(body(999, 23_102), 127);
  assert.equal(official.normalizedSha256, fireside.normalizedSha256);
  assert.equal(official.physicalBytes, 123);
  assert.equal(fireside.physicalBytes, 127);
  assert.doesNotThrow(() =>
    assertPhase5GeneratedCacheParity(official, fireside, "fixture"));
  assert.throws(
    () => assertPhase5GeneratedCacheParity(
      official,
      measurePhase5GeneratedCache(body(999, 23_102, "changed"), 127),
      "fixture",
    ),
    /logical values diverged/u,
  );
  assert.throws(
    () => assertPhase5GeneratedCacheParity(null, fireside, "fixture"),
    /logical values diverged/u,
  );
  assert.equal(
    isPhase5GeneratedCacheObject(
      PHASE5_GENERATED_CACHE_BUCKET,
      PHASE5_GENERATED_CACHE_NAME,
    ),
    true,
  );
  assert.equal(
    isPhase5GeneratedCacheObject(
      PHASE5_GENERATED_CACHE_BUCKET,
      `${PHASE5_GENERATED_CACHE_NAME}.other`,
    ),
    false,
  );
  assert.equal(
    phase5GeneratedCacheMetadataSize({
      bucket: PHASE5_GENERATED_CACHE_BUCKET,
      name: PHASE5_GENERATED_CACHE_NAME,
      size: "752169",
    }),
    752_169,
  );
  assert.equal(
    phase5GeneratedCacheMetadataSize({ bucket: "another", name: "object", size: 3 }),
    null,
  );
  assert.throws(
    () => phase5GeneratedCacheMetadataSize({
      bucket: PHASE5_GENERATED_CACHE_BUCKET,
      name: PHASE5_GENERATED_CACHE_NAME,
      size: "not-a-number",
    }),
    /size is invalid/u,
  );
});
