/** Tiny, isolated SDK oracle. Raw HTTP recording deliberately disables decompression. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { initializeApp, deleteApp } from "firebase/app";
import { connectStorageEmulator, getStorage, ref, uploadBytes } from "firebase/storage";

const packageRoot = process.env.FIREBASE_TOOLS_15_22_ROOT;
if (!packageRoot) throw new Error("FIREBASE_TOOLS_15_22_ROOT is required");
const oracleRequire = createRequire(join(packageRoot, "package.json"));
assert.equal(oracleRequire("./package.json").version, "15.22.0");
const scratch = await mkdtemp("/tmp/fireside-storage-encoding-oracle-");
process.env.TMPDIR = scratch;
const { StorageEmulator } = oracleRequire("./lib/emulator/storage/index.js");
const { EmulatorRegistry } = oracleRequire("./lib/emulator/registry.js");
const { Storage } = oracleRequire("@google-cloud/storage");
const projectId = "demo-fireside-storage-encoding";
const bucket = "assets-local.twodart.com";
const metadata = {
  contentType: "application/json", contentEncoding: "gzip",
  cacheControl: "no-cache, no-store, must-revalidate",
  contentDisposition: "inline", contentLanguage: "en",
  metadata: { purpose: "synthetic-gzip-oracle" },
};
const json = Buffer.from(JSON.stringify({ catalogue: ["火", "🔥", "café"], synthetic: true }));
const payload = gzipSync(json);
const recordings: unknown[] = [];
let label = "startup";
const reservation = createServer();
await new Promise<void>((done) => reservation.listen(0, "127.0.0.1", done));
const address = reservation.address();
assert.ok(address && typeof address !== "string");
const storagePort = address.port;
await new Promise<void>((done) => reservation.close(() => done()));
const origin = `http://127.0.0.1:${String(storagePort)}`;
const emulator = new StorageEmulator({ host: "127.0.0.1", port: storagePort, projectId,
  auto_download: false, rules: [{ resource: bucket, rules: { name: "synthetic.rules",
    content: "rules_version = '2'; service firebase.storage { match /b/{bucket}/o { match /{allPaths=**} { allow read, write: if true; } } }" } }] });
EmulatorRegistry.set("storage", emulator);
const proxy = createServer(async (incoming, outgoing) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const response = await raw(origin + incoming.url!, incoming.method!, incoming.headers, body);
    recordings.push({ label, method: incoming.method, path: incoming.url,
      requestHeaders: incoming.headers, requestBody: bytes(body),
      status: response.status, responseHeaders: response.headers, responseBody: bytes(response.body) });
    const headers = { ...response.headers };
    if (typeof headers.location === "string") headers.location = headers.location.replace(origin, proxyOrigin);
    if (typeof headers["x-goog-upload-url"] === "string") headers["x-goog-upload-url"] = headers["x-goog-upload-url"].replace(origin, proxyOrigin);
    outgoing.writeHead(response.status, headers);
    outgoing.end(response.body);
  } catch (error) { outgoing.writeHead(500); outgoing.end(String(error)); }
});
await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
const proxyAddress = proxy.address();
assert.ok(proxyAddress && typeof proxyAddress !== "string");
const proxyOrigin = `http://127.0.0.1:${String(proxyAddress.port)}`;
const app = initializeApp({ projectId, storageBucket: bucket, apiKey: "synthetic-oracle" }, "encoding-oracle");
try {
  await emulator.start();
  process.env.STORAGE_EMULATOR_HOST = proxyOrigin;
  const storage = new Storage({ projectId, apiEndpoint: proxyOrigin });
  for (const resumable of [true, false]) {
    label = resumable ? "gcs-resumable" : "gcs-multipart";
    await storage.bucket(bucket).file(`${label}.json`).save(json, {
      gzip: true, resumable, metadata: { ...metadata, contentEncoding: undefined },
    });
  }
  const webStorage = getStorage(app);
  connectStorageEmulator(webStorage, "127.0.0.1", proxyAddress.port);
  const webMetadata = { ...metadata, customMetadata: metadata.metadata };
  label = "firebase-multipart";
  await uploadBytes(ref(webStorage, `${label}.json`), payload, webMetadata);
  label = "firebase-resumable";
  // uploadBytesResumable chooses multipart for this tiny payload. Exercise its
  // resumable wire protocol explicitly, without inflating the synthetic dataset.
  const start = await raw(`${proxyOrigin}/v0/b/${bucket}/o?name=${label}.json`, "POST", {
    "content-type": "application/json", "x-goog-upload-protocol": "resumable", "x-goog-upload-command": "start",
  }, Buffer.from(JSON.stringify(metadata)));
  assert.equal(start.status, 200);
  const uploadUrl = start.headers["x-goog-upload-url"];
  assert.equal(typeof uploadUrl, "string");
  const finish = await raw(uploadUrl as string, "POST", {
    "x-goog-upload-command": "upload, finalize", "x-goog-upload-offset": "0",
  }, payload);
  assert.equal(finish.status, 200);
  label = "gcs-copy";
  // The pinned official emulator implements this alias, not the canonical SDK copyTo route.
  const copy = await raw(`${proxyOrigin}/b/${bucket}/o/gcs-resumable.json/copyTo/b/${bucket}/o/gcs-copy.json`, "POST",
    { "content-type": "application/json", authorization: "Bearer owner" }, Buffer.from("{}"));
  assert.equal(copy.status, 200);
  const objects = [];
  for (const name of ["gcs-resumable", "gcs-multipart", "firebase-multipart", "firebase-resumable", "gcs-copy"]) {
    label = `probe:${name}`;
    const object = `${name}.json`;
    const observations = [];
    for (const api of ["gcs", "firebase"]) {
      const path = api === "gcs" ? `/storage/v1/b/${bucket}/o/${object}` : `/v0/b/${bucket}/o/${object}`;
      for (const kind of ["metadata", "gzip", "decoded", "gzip-range", "decoded-range", "browser"]) {
        const headers: Record<string, string> = { authorization: "Bearer owner" };
        if (kind.startsWith("gzip") || kind === "browser") headers["accept-encoding"] = "gzip";
        if (kind.endsWith("range")) headers.range = "bytes=0-9";
        const url = proxyOrigin + path + (kind === "metadata" ? "" : "?alt=media");
        const response = await raw(url, "GET", headers);
        const observation = { api, kind, status: response.status, headers: response.headers, body: bytes(response.body) };
        observations.push(observation);
        assert.equal(response.status, kind === "gzip-range" ? 206 : 200);
        if (kind === "metadata") assert.equal(JSON.parse(response.body.toString()).contentEncoding, "gzip");
        if (kind === "decoded" || kind === "decoded-range") assert.deepEqual(response.body, json);
        if (kind === "browser") assert.deepEqual(JSON.parse(gunzipSync(response.body).toString()), JSON.parse(json.toString()));
      }
    }
    objects.push({ name: object, observations });
  }
  label = "export";
  const exportRoot = join(scratch, "export");
  await mkdir(exportRoot);
  assert.equal((await raw(origin + "/internal/export", "POST", { "content-type": "application/json" },
    Buffer.from(JSON.stringify({ path: exportRoot, initiatedBy: "content-encoding-oracle" })))).status, 200);
  const exported = [];
  for (const file of await readdir(join(exportRoot, "metadata"))) {
    const body = await readFile(join(exportRoot, "metadata", file));
    exported.push({ file, body: bytes(body), metadata: JSON.parse(body.toString()) });
  }
  const sourceHashes: Record<string, string> = {};
  for (const name of ["files.js", "upload.js", "metadata.js", "apis/shared.js", "apis/firebase.js", "apis/gcloud.js"]) {
    sourceHashes[name] = sha(await readFile(join(packageRoot, "lib/emulator/storage", name)));
  }
  const fixture = { schemaVersion: 1, target: "official-firebase-tools-storage-emulator", targetVersion: "15.22.0",
    capturedAt: new Date().toISOString(), projectId, bucket, sourceHashes,
    sdkVersions: { firebase: JSON.parse(await readFile(new URL("../../node_modules/firebase/package.json", import.meta.url), "utf8")).version,
      googleCloudStorage: JSON.parse(await readFile(join(packageRoot, "../@google-cloud/storage/package.json"), "utf8")).version },
    syntheticOnly: true, credentialsStored: false, json: bytes(json), gzip: bytes(payload), metadata,
    objects, exported, recordings };
  const output = resolve(process.env.STORAGE_ENCODING_FIXTURE_OUTPUT ?? "fixtures/firebase-suite-v1/storage-content-encoding");
  await mkdir(output, { recursive: true });
  const fixtureBytes = `${JSON.stringify(fixture, null, 2)}\n`;
  await writeFile(join(output, "fixture.json"), fixtureBytes, { flag: "wx" });
  await writeFile(join(output, "SHA256SUMS"), `${sha(Buffer.from(fixtureBytes))}  fixture.json\n`, { flag: "wx" });
  console.log(JSON.stringify({ output, scratch, objects: objects.length, recordings: recordings.length }));
} finally {
  await deleteApp(app);
  await emulator.stop();
  EmulatorRegistry.clear("storage");
  proxy.closeAllConnections();
  await new Promise<void>((done) => proxy.close(() => done()));
}

function sha(body: Uint8Array): string { return createHash("sha256").update(body).digest("hex"); }
function bytes(body: Buffer) { return { byteLength: body.length, sha256: sha(body), base64: body.toString("base64") }; }
async function raw(url: string, method: string, headers: IncomingHttpHeaders = {}, body = Buffer.alloc(0)) {
  return await new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>((resolvePromise, reject) => {
    const outgoing = request(url, { method, headers: { ...headers, host: new URL(url).host }, timeout: 30_000 }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => resolvePromise({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    outgoing.on("timeout", () => outgoing.destroy(new Error(`timeout ${method} ${url}`)));
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}
