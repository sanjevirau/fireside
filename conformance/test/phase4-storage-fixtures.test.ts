import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import "./storage-content-encoding.test.ts";
import "./storage-list-pagination.test.ts";
import "./storage-missing-object.test.ts";

interface Observation {
  readonly id: string;
  readonly status: number;
  readonly path: string;
  readonly request?: unknown;
  readonly response: unknown;
  readonly responseHeaders: Readonly<Record<string, string>>;
}

interface Fixture {
  readonly schemaVersion: number;
  readonly target: string;
  readonly targetVersion: string;
  readonly targetProject: string;
  readonly credentialsStored: boolean;
  readonly accessTokensStored: boolean;
  readonly realUserDataStored: boolean;
  readonly rulesRuntimeSha256: string;
  readonly observations: readonly Observation[];
  readonly invariants: Readonly<Record<string, unknown>>;
  readonly twodartRules?: Readonly<Record<string, string>>;
  readonly exportInventory?: readonly {
    readonly path: string;
    readonly byteLength: number;
    readonly sha256: string;
    readonly json?: unknown;
  }[];
  readonly dispatches?: readonly {
    readonly method: string;
    readonly path: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Readonly<Record<string, unknown>>;
  }[];
}

const names = [
  "storage-firebase-v0-and-download-tokens",
  "storage-gcs-json-and-resumable-upload",
  "storage-dotnet-gzip-resumable",
  "storage-multi-bucket-rules-and-import-export",
] as const;

test("the Storage v0 fixture freezes token bypass, UTF-8 bytes, metadata, and token rotation", async () => {
  const fixture = await load("storage-firebase-v0-and-download-tokens");
  assertMetadata(fixture);
  assert.deepEqual(
    fixture.observations.map(({ id, status }) => ({ id, status })),
    [
      { id: "readiness", status: 200 },
      { id: "firebase-v0-media-upload", status: 200 },
      { id: "default-bucket-public-read-denied", status: 403 },
      { id: "download-token-bypasses-rules", status: 200 },
      { id: "firebase-v0-get-metadata", status: 200 },
      { id: "firebase-v0-list-prefix", status: 200 },
      { id: "firebase-v0-update-metadata", status: 200 },
      { id: "firebase-v0-create-download-token", status: 200 },
      { id: "firebase-v0-delete-download-token", status: 200 },
    ],
  );
  assert.equal(fixture.invariants.objectName, "users/alice/火🔥.txt");
  assert.equal(fixture.invariants.byteLength, 25);
  assert.equal(fixture.invariants.unauthenticatedDefaultReadStatus, 403);
  assert.equal(fixture.invariants.tokenBypassesReadRules, true);
  const upload = observation(fixture, "firebase-v0-media-upload");
  assert.equal(nestedString(upload.response, ["downloadTokens"]), "<1-download-token>");
  const createToken = observation(fixture, "firebase-v0-create-download-token");
  assert.equal(nestedString(createToken.response, ["downloadTokens"]), "<2-download-tokens>");
  const download = observation(fixture, "download-token-bypasses-rules");
  assert.match(download.path, /token=<download-token>$/u);
  assert.equal(nestedString(download.response, ["utf8"]), "Firebase v0 says 火🔥\n");
  assert.equal(
    nestedString(download.response, ["sha256"]),
    fixture.invariants.sha256,
  );
});

test("the GCS fixture freezes resumable semantics and the Java emulator's copy-path divergence", async () => {
  const fixture = await load("storage-gcs-json-and-resumable-upload");
  assertMetadata(fixture);
  assert.deepEqual(
    fixture.observations.map(({ id, status }) => ({ id, status })),
    [
      { id: "gcs-json-media-upload", status: 200 },
      { id: "gcs-resumable-start", status: 200 },
      { id: "gcs-resumable-upload-and-finalize", status: 200 },
      { id: "gcs-resumable-duplicate-finalize", status: 400 },
      { id: "gcs-list-objects", status: 200 },
      { id: "gcs-download-resumable-object", status: 200 },
      { id: "gcs-canonical-copy-path-not-implemented", status: 501 },
      { id: "gcs-emulator-copy-alias", status: 200 },
    ],
  );
  const start = observation(fixture, "gcs-resumable-start");
  assert.match(start.responseHeaders.location ?? "", /upload_id=<upload-id>$/u);
  const download = observation(fixture, "gcs-download-resumable-object");
  assert.equal(nestedString(download.response, ["utf8"]), "chunk-one-火|chunk-two-🔥");
  assert.equal(
    nestedString(download.response, ["sha256"]),
    nestedString(fixture.invariants, ["resumable", "sha256"]),
  );
  assert.equal(fixture.invariants.duplicateFinalizeStatus, 400);
  assert.equal(fixture.invariants.canonicalCopyPathStatus, 501);
  assert.equal(fixture.invariants.emulatorCopyAliasStatus, 200);
});

test("the Twodart .NET fixture freezes gzip-encoded resumable metadata", async () => {
  const fixture = await load("storage-dotnet-gzip-resumable");
  assertMetadata(fixture);
  assert.deepEqual(
    fixture.observations.map(({ id, status }) => ({ id, status })),
    [
      { id: "dotnet-gzip-resumable-start", status: 200 },
      { id: "dotnet-gzip-resumable-finalize", status: 200 },
      { id: "dotnet-sdk-two-bucket-round-trip", status: 200 },
    ],
  );
  assert.equal(fixture.invariants.contentEncoding, "gzip");
  assert.equal(fixture.invariants.decodedMetadataIsJson, true);
  assert.equal(fixture.invariants.nameComesFromDecodedMetadata, true);
  assert.equal(fixture.invariants.officialStartStatus, 200);
  assert.equal(fixture.invariants.officialFinalizeStatus, 200);
  assert.equal(fixture.invariants.twoBucketRoundTripPassed, true);
  const start = observation(fixture, "dotnet-gzip-resumable-start");
  assert.equal(nestedString(start, ["request", "headers", "content-encoding"]), "gzip");
  assert.equal(
    nestedString(start, ["request", "decoded", "name"]),
    "_firesidePhase4/<run-id>/0-火🔥.txt",
  );
});

test("the two Twodart Storage rules remain distinct and export/re-import is byte exact", async () => {
  const fixture = await load("storage-multi-bucket-rules-and-import-export");
  assertMetadata(fixture);
  assert.deepEqual(fixture.twodartRules, {
    "demo-twodart-local.appspot.com":
      "c5334b21d576b18ca494fd540d1883ca2ca4287b5653b1b990136ec74475400d",
    "assets-local.twodart.com":
      "0a8f28d9597961ecbb59ce8269cf4fecf71add0b9e0b539c13f38b25ca4c6997",
  });
  assert.equal(fixture.invariants.defaultOwnerReadStatus, 200);
  assert.equal(fixture.invariants.defaultOtherUserReadStatus, 403);
  assert.equal(fixture.invariants.assetsPublicReadStatus, 200);
  assert.equal(fixture.invariants.exportImportDispatchCount, 0);

  const inventory = fixture.exportInventory ?? [];
  const blobs = inventory.filter(({ path }) => path.startsWith("blobs/"));
  const metadata = inventory.filter(({ path }) => path.startsWith("metadata/"));
  assert.equal(blobs.length, metadata.length);
  assert.ok(blobs.length >= 6);
  const buckets = inventory.find(({ path }) => path === "buckets.json");
  assert.ok(buckets);
  assert.deepEqual(nestedValue(buckets.json, ["buckets"]), [
    { id: "demo-twodart-local.appspot.com" },
    { id: "assets-local.twodart.com" },
  ]);
  for (const entry of inventory) {
    assert.match(entry.sha256, /^[0-9a-f]{64}$/u);
    assert.ok(entry.byteLength > 0);
  }

  const afterDefault = observation(fixture, "reimported-default-object-byte-check");
  const afterAssets = observation(fixture, "reimported-assets-object-byte-check");
  assert.equal(
    nestedString(afterDefault.response, ["sha256"]),
    fixture.invariants.reimportedDefaultSha256,
  );
  assert.equal(
    nestedString(afterAssets.response, ["sha256"]),
    fixture.invariants.reimportedAssetsSha256,
  );
});

test("Storage lifecycle capture preserves paired v1 and v2 function event shapes", async () => {
  const fixture = await load("storage-multi-bucket-rules-and-import-export");
  const dispatches = fixture.dispatches ?? [];
  assert.ok(dispatches.length >= 12);
  assert.ok(
    dispatches.some(
      ({ body }) => body.eventType === "google.storage.object.finalize",
    ),
  );
  assert.ok(
    dispatches.some(
      ({ body }) => body.type === "google.cloud.storage.object.v1.finalized",
    ),
  );
  assert.ok(
    dispatches.some(
      ({ body }) => body.eventType === "google.storage.object.metadataUpdate",
    ),
  );
  assert.ok(
    dispatches.some(
      ({ body }) => body.type === "google.cloud.storage.object.v1.metadataUpdated",
    ),
  );
  for (const dispatch of dispatches) {
    assert.equal(dispatch.method, "POST");
    assert.equal(
      dispatch.path,
      `/functions/projects/${fixture.targetProject}/trigger_multicast`,
    );
    assert.equal(dispatch.headers.host, "<functions-emulator-host>");
  }
});

test("every permanent Storage fixture has a complete and valid checksum inventory", async () => {
  for (const name of names) {
    const root = fixtureRoot(name);
    const sums = await readFile(new URL("SHA256SUMS", root), "utf8");
    assert.equal(sums.trimEnd().split("\n").length, 2, name);
    for (const line of sums.trimEnd().split("\n")) {
      const match = /^(?<sha>[0-9a-f]{64})  (?<file>.+)$/u.exec(line);
      assert.ok(match?.groups !== undefined, line);
      assert.equal(
        sha256(await readFile(new URL(match.groups.file!, root))),
        match.groups.sha,
        `${name}/${match.groups.file!}`,
      );
    }
  }
});

async function load(name: typeof names[number]): Promise<Fixture> {
  return JSON.parse(
    await readFile(new URL("fixture.json", fixtureRoot(name)), "utf8"),
  ) as Fixture;
}

function fixtureRoot(name: typeof names[number]): URL {
  return new URL(`../fixtures/firebase-suite-v1/${name}/`, import.meta.url);
}

function assertMetadata(fixture: Fixture): void {
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.target, "official-firebase-tools-storage-emulator");
  assert.equal(fixture.targetVersion, "15.22.0");
  assert.match(fixture.targetProject, /^demo-/u);
  assert.equal(fixture.credentialsStored, false);
  assert.equal(fixture.accessTokensStored, false);
  assert.equal(fixture.realUserDataStored, false);
  assert.equal(
    fixture.rulesRuntimeSha256,
    "0cd52db6f6271d62078f805220706377c849220b73bd68aa27078d977df9c900",
  );
}

function observation(fixture: Fixture, id: string): Observation {
  const match = fixture.observations.find((candidate) => candidate.id === id);
  assert.ok(match, id);
  return match;
}

function nestedValue(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function nestedString(value: unknown, path: readonly string[]): string | undefined {
  const nested = nestedValue(value, path);
  return typeof nested === "string" ? nested : undefined;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
