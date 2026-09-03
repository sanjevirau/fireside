/** Tiny isolated oracle for missing Storage object responses and browser loading. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const packageRoot = process.env.FIREBASE_TOOLS_15_22_ROOT;
if (!packageRoot) throw new Error("FIREBASE_TOOLS_15_22_ROOT is required");
const oracleRequire = createRequire(join(packageRoot, "package.json"));
assert.equal(oracleRequire("./package.json").version, "15.22.0");

const scratch = await mkdtemp("/tmp/fireside-storage-missing-object-oracle-");
process.env.TMPDIR = scratch;
const { StorageEmulator } = oracleRequire("./lib/emulator/storage/index.js");
const { EmulatorRegistry } = oracleRequire("./lib/emulator/registry.js");
const projectId = "demo-fireside-storage-missing-object";
const bucket = "assets-local.twodart.com";
const object = "users/synthetic/images/missing/high.png";

const reservation = createServer();
await new Promise<void>((done) => reservation.listen(0, "127.0.0.1", done));
const address = reservation.address();
assert.ok(address && typeof address !== "string");
const storagePort = address.port;
await new Promise<void>((done) => reservation.close(() => done()));
const storageOrigin = `http://127.0.0.1:${String(storagePort)}`;
const emulator = new StorageEmulator({
  host: "127.0.0.1",
  port: storagePort,
  projectId,
  auto_download: false,
  rules: [{
    resource: bucket,
    rules: {
      name: "synthetic.rules",
      content: "rules_version = '2'; service firebase.storage { match /b/{bucket}/o { match /{allPaths=**} { allow read, write: if true; } } }",
    },
  }],
});
EmulatorRegistry.set("storage", emulator);

const pageServer = createServer((_incoming, outgoing) => {
  outgoing.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  outgoing.end("<!doctype html><title>storage missing object oracle</title><div id=result>ready</div>");
});
await new Promise<void>((done) => pageServer.listen(0, "127.0.0.1", done));
const pageAddress = pageServer.address();
assert.ok(pageAddress && typeof pageAddress !== "string");
const pageOrigin = `http://127.0.0.1:${String(pageAddress.port)}`;

try {
  await emulator.start();
  const encoded = encodeURIComponent(object);
  const probes = [];
  for (const probe of [
    { api: "firebase", kind: "metadata", path: `/v0/b/${bucket}/o/${encoded}` },
    { api: "firebase", kind: "media", path: `/v0/b/${bucket}/o/${encoded}?alt=media` },
    { api: "gcs", kind: "metadata", path: `/storage/v1/b/${bucket}/o/${encoded}` },
    { api: "gcs", kind: "media", path: `/download/storage/v1/b/${bucket}/o/${encoded}?alt=media` },
  ]) {
    const response = await raw(storageOrigin + probe.path, "GET", {
      authorization: "Bearer owner",
      origin: pageOrigin,
      accept: probe.kind === "media" ? "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8" : "application/json",
    });
    probes.push({ ...probe, status: response.status, headers: response.headers, body: bytes(response.body) });
    assert.equal(response.status, 404);
  }

  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_BIN ?? (process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : "/usr/bin/google-chrome"),
  });
  let browserVersion = "unknown";
  let browserObservation: unknown;
  try {
    browserVersion = browser.version();
    const page = await browser.newPage();
    await page.goto(pageOrigin);
    const mediaUrl = `${storageOrigin}/v0/b/${bucket}/o/${encoded}?alt=media`;
    const events: unknown[] = [];
    page.on("response", (response) => {
      if (response.url() === mediaUrl) events.push({ kind: "response", status: response.status(), statusText: response.statusText() });
    });
    page.on("requestfailed", (incoming) => {
      if (incoming.url() === mediaUrl) events.push({ kind: "request-failed", errorText: incoming.failure()?.errorText ?? null });
    });
    const domEvent = await page.evaluate(async (src) => await new Promise<string>((done) => {
      const image = document.createElement("img");
      image.onload = () => done("load");
      image.onerror = () => done("error");
      image.src = src;
      document.body.append(image);
    }), mediaUrl);
    await page.waitForTimeout(100);
    browserObservation = { mediaUrl, domEvent, events };
    assert.equal(domEvent, "error");
    assert.deepEqual(events, [{ kind: "response", status: 404, statusText: "Not Found" }]);
  } finally {
    await browser.close();
  }

  const sourceHashes: Record<string, string> = {};
  for (const name of ["files.js", "errors.js", "apis/firebase.js", "apis/gcloud.js"]) {
    sourceHashes[name] = sha(await readFile(join(packageRoot, "lib/emulator/storage", name)));
  }
  const fixture = {
    schemaVersion: 1,
    target: "official-firebase-tools-storage-emulator",
    targetVersion: "15.22.0",
    capturedAt: new Date().toISOString(),
    projectId,
    bucket,
    object,
    sourceHashes,
    browserVersion,
    syntheticOnly: true,
    credentialsStored: false,
    probes,
    browser: browserObservation,
  };
  const output = resolve(process.env.STORAGE_MISSING_OBJECT_FIXTURE_OUTPUT ?? "fixtures/firebase-suite-v1/storage-missing-object");
  await mkdir(output, { recursive: true });
  const fixtureBytes = `${JSON.stringify(fixture, null, 2)}\n`;
  await writeFile(join(output, "fixture.json"), fixtureBytes, { flag: "wx" });
  await writeFile(join(output, "SHA256SUMS"), `${sha(Buffer.from(fixtureBytes))}  fixture.json\n`, { flag: "wx" });
  console.log(JSON.stringify({ output, scratch, probes: probes.length, browserVersion }));
} finally {
  await emulator.stop();
  EmulatorRegistry.clear("storage");
  pageServer.closeAllConnections();
  await new Promise<void>((done) => pageServer.close(() => done()));
}

function sha(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

function bytes(body: Buffer) {
  return { byteLength: body.length, sha256: sha(body), base64: body.toString("base64") };
}

async function raw(url: string, method: string, headers: IncomingHttpHeaders = {}) {
  return await new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>((resolvePromise, reject) => {
    const outgoing = request(url, { method, headers: { ...headers, host: new URL(url).host }, timeout: 30_000 }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => resolvePromise({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    outgoing.on("timeout", () => outgoing.destroy(new Error(`timeout ${method} ${url}`)));
    outgoing.on("error", reject);
    outgoing.end();
  });
}
