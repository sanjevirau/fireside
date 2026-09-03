import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { gunzipSync } from "node:zlib";

const root = new URL("../fixtures/firebase-suite-v1/storage-content-encoding/", import.meta.url);
interface Bytes { readonly byteLength: number; readonly base64: string; readonly sha256: string }
export interface EncodingFixture {
  readonly targetVersion: string;
  readonly syntheticOnly: boolean;
  readonly credentialsStored: boolean;
  readonly bucket: string;
  readonly json: Bytes;
  readonly gzip: Bytes;
  readonly metadata: Record<string, unknown>;
  readonly objects: readonly { readonly name: string; readonly observations: readonly {
    readonly api: string; readonly kind: string; readonly status: number;
    readonly headers: Record<string, string>; readonly body: Bytes;
  }[] }[];
  readonly recordings: readonly { readonly label: string; readonly method: string; readonly path: string;
    readonly requestHeaders: Record<string, string>; readonly requestBody: Bytes; readonly status: number;
    readonly responseHeaders: Record<string, string>; readonly responseBody: Bytes }[];
  readonly exported: readonly { readonly body: Bytes; readonly metadata: Record<string, unknown> }[];
}

test("official gzip Storage contract: real SDK uploads, both APIs, ranges, copy and export", async () => {
  const raw = await readFile(new URL("fixture.json", root));
  const fixture = JSON.parse(raw.toString()) as EncodingFixture;
  const sums = await readFile(new URL("SHA256SUMS", root), "utf8");
  assert.equal(sums, `${hash(raw)}  fixture.json\n`);
  assert.equal(fixture.targetVersion, "15.22.0");
  assert.equal(fixture.syntheticOnly, true);
  assert.equal(fixture.credentialsStored, false);
  assert.equal(fixture.objects.length, 5);
  assert.equal(fixture.exported.length, 5);
  assert.deepEqual(gunzipSync(decode(fixture.gzip)), decode(fixture.json));
  for (const object of fixture.objects) {
    assert.equal(object.observations.length, 12);
    for (const observation of object.observations) {
      const body = decode(observation.body);
      assert.equal(observation.status, observation.kind === "gzip-range" ? 206 : 200);
      if (observation.kind === "metadata") {
        const metadata = JSON.parse(body.toString());
        for (const field of ["contentType", "contentEncoding", "contentDisposition", "contentLanguage", "cacheControl"]) {
          assert.equal(metadata[field], fixture.metadata[field]);
        }
      } else if (observation.kind.startsWith("decoded")) {
        assert.deepEqual(body, decode(fixture.json));
        assert.equal(observation.headers["content-encoding"], undefined);
        assert.equal(observation.headers["content-range"], undefined);
        assert.equal(observation.headers["content-length"], undefined);
        assert.equal(observation.headers["transfer-encoding"], "chunked");
      } else {
        assert.equal(observation.headers["content-encoding"], "gzip");
        if (observation.kind === "gzip-range") assert.deepEqual(body, decode(fixture.gzip).subarray(0, 10));
        else assert.deepEqual(JSON.parse(gunzipSync(body).toString()), JSON.parse(decode(fixture.json).toString()));
      }
    }
  }
  for (const entry of fixture.exported) {
    assert.deepEqual(JSON.parse(decode(entry.body).toString()), entry.metadata);
    for (const field of ["contentType", "contentEncoding", "contentDisposition", "contentLanguage", "cacheControl"]) {
      assert.equal(entry.metadata[field], fixture.metadata[field]);
    }
  }
  for (const recording of fixture.recordings) {
    decode(recording.requestBody); decode(recording.responseBody);
  }
  const uploads = fixture.recordings.filter(({ label }) => !label.startsWith("probe:"));
  assert.equal(uploads.length, 7);
  assert.equal(uploads[0]?.requestHeaders["user-agent"], "gcloud-node-storage/7.21.0");
  assert.equal(uploads[3]?.requestHeaders["x-firebase-storage-version"], "webjs/12.18.0");
  assert.equal(uploads[4]?.requestHeaders["x-goog-upload-command"], "start");
  assert.equal(uploads[5]?.requestHeaders["x-goog-upload-command"], "upload, finalize");
});

function hash(body: Buffer): string { return createHash("sha256").update(body).digest("hex"); }
function decode(value: Bytes): Buffer {
  const body = Buffer.from(value.base64, "base64");
  assert.equal(body.length, value.byteLength);
  assert.equal(hash(body), value.sha256);
  return body;
}
