import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { once } from "node:events";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

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

test("Fireside HTTP replays the official upload bytes and browser-decodes Twodart cache JSON", { timeout: 600_000 }, async () => {
  const repository = fileURLToPath(new URL("../../", import.meta.url));
  await promisify(execFile)("cargo", ["build", "--locked", "-p", "fireside-storage-front", "--example", "encoding_fixture_server"], { cwd: repository });
  const cargoMetadata = await promisify(execFile)("cargo", ["metadata", "--no-deps", "--format-version", "1"], { cwd: repository });
  const targetDirectory = (JSON.parse(cargoMetadata.stdout) as { target_directory: string }).target_directory;
  const scratch = await mkdtemp("/tmp/fireside-storage-http-replay-");
  const child = spawn(`${targetDirectory}/debug/examples/encoding_fixture_server`, [scratch], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit");
  try {
    const origin = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Storage fixture peer readiness timeout")), 30_000);
      child.stdout.once("data", (chunk: Buffer) => { clearTimeout(timer); resolve(chunk.toString().trim()); });
      child.once("error", reject);
      child.once("exit", () => { clearTimeout(timer); reject(new Error("Storage fixture peer exited before readiness")); });
    });
    const fixture = JSON.parse(await readFile(new URL("fixture.json", root), "utf8")) as EncodingFixture;
    const sessions = new Map<string, string>();
    for (const recording of fixture.recordings.filter(({ label }) => !label.startsWith("probe:"))) {
      const path = recording.path.includes("upload_id=") ? sessions.get(recording.label)! : recording.path;
      const headers = Object.fromEntries(Object.entries(recording.requestHeaders).filter(([key]) =>
        !["host", "connection", "content-length", "transfer-encoding"].includes(key)));
      const response = await rawHttp(origin + path, recording.method, headers, decode(recording.requestBody));
      assert.equal(response.status, recording.status, recording.label);
      const location = response.headers.location ?? response.headers["x-goog-upload-url"];
      if (typeof location === "string") {
        const parsed = new URL(location);
        sessions.set(recording.label, parsed.pathname + parsed.search);
      }
    }
    for (const object of fixture.objects) {
      for (const expected of object.observations) {
        const prefix = expected.api === "gcs" ? "storage/v1" : "v0";
        const url = `${origin}/${prefix}/b/${fixture.bucket}/o/${object.name}${expected.kind === "metadata" ? "" : "?alt=media"}`;
        const headers: Record<string, string> = {};
        if (expected.kind.startsWith("gzip") || expected.kind === "browser") headers["accept-encoding"] = "gzip";
        if (expected.kind.endsWith("range")) headers.range = "bytes=0-9";
        if (expected.kind === "browser") {
          // Node's standards Fetch implementation, like the browser, decodes
          // Content-Encoding automatically before JSON parsing.
          const response = await fetch(url, { headers });
          assert.equal(response.status, expected.status);
          assert.equal(response.headers.get("content-encoding"), "gzip");
          assert.deepEqual(await response.json(), JSON.parse(decode(fixture.json).toString()));
          continue;
        }
        const response = await rawHttp(url, "GET", headers);
        assert.equal(response.status, expected.status, `${object.name} ${expected.kind}`);
        if (expected.kind === "metadata") {
          const metadata = JSON.parse(response.body.toString());
          for (const field of ["contentType", "contentEncoding", "contentDisposition", "contentLanguage", "cacheControl"]) {
            assert.equal(metadata[field], fixture.metadata[field]);
          }
        } else {
          assert.deepEqual(response.body, decode(expected.body));
          for (const field of ["content-type", "content-encoding", "content-disposition", "cache-control", "content-language", "content-range", "content-length", "transfer-encoding", "accept-ranges", "x-goog-storage-class", "x-goog-hash"]) {
            assert.equal(response.headers[field], expected.headers[field], `${object.name} ${expected.kind} ${field}`);
          }
        }
      }
    }
  } finally {
    child.kill("SIGTERM");
    await exited;
    await rm(scratch, { recursive: true, force: true });
  }
});

async function rawHttp(url: string, method: string, headers: Record<string, string>, body: Buffer = Buffer.alloc(0)) {
  return await new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const outgoing = request(url, { method, headers, timeout: 10_000 }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    outgoing.on("error", reject);
    outgoing.on("timeout", () => outgoing.destroy(new Error("Storage replay request timeout")));
    outgoing.end(body);
  });
}
