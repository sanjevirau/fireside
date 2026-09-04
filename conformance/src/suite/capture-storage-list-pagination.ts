/**
 * Synthetic oracle capture for the official Firebase Storage emulator's
 * object-list pagination contract. The 1,002-object corpus deliberately
 * crosses the emulator's default 1,000-object page boundary used by
 * @google-cloud/storage bucket.getFiles().
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const packageRoot = process.env.FIREBASE_TOOLS_15_22_ROOT;
if (!packageRoot) throw new Error("FIREBASE_TOOLS_15_22_ROOT is required");
const oracleRequire = createRequire(join(packageRoot, "package.json"));
assert.equal(oracleRequire("./package.json").version, "15.22.0");

const scratch = await mkdtemp("/tmp/fireside-storage-list-pagination-oracle-");
process.env.TMPDIR = scratch;
const { StorageEmulator } = oracleRequire("./lib/emulator/storage/index.js");
const { EmulatorRegistry } = oracleRequire("./lib/emulator/registry.js");
const { Storage } = oracleRequire("@google-cloud/storage");
const projectId = "demo-fireside-storage-list-pagination";
const bucket = "assets-local.twodart.com";
const objectCount = 1_002;
const names = Array.from(
  { length: objectCount },
  (_, index) => `objects/${String(index).padStart(4, "0")}.json`,
);

const reservation = createServer();
await new Promise<void>((done) => reservation.listen(0, "127.0.0.1", done));
const address = reservation.address();
assert.ok(address && typeof address !== "string");
const storagePort = address.port;
await new Promise<void>((done) => reservation.close(() => done()));
const origin = `http://127.0.0.1:${String(storagePort)}`;
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

try {
  await emulator.start();
  const storage = new Storage({ projectId, apiEndpoint: origin });
  process.env.STORAGE_EMULATOR_HOST = origin;
  for (let offset = 0; offset < names.length; offset += 50) {
    await Promise.all(names.slice(offset, offset + 50).map(async (name) => {
      await storage.bucket(bucket).file(name).save(Buffer.from(`{"name":"${name}"}\n`), {
        resumable: false,
        metadata: { contentType: "application/json", metadata: { synthetic: "true" } },
      });
    }));
  }

  const gcsDefaultFirst = await list(
    `/storage/v1/b/${bucket}/o?prefix=objects%2F`,
    "gcs-default-first",
  );
  const gcsDefaultSecond = await list(
    `/storage/v1/b/${bucket}/o?prefix=objects%2F&pageToken=${encodeURIComponent(gcsDefaultFirst.nextPageToken ?? "")}`,
    "gcs-default-second",
  );
  const firebaseDefaultFirst = await list(
    `/v0/b/${bucket}/o?prefix=objects%2F`,
    "firebase-default-first",
  );
  const firebaseDefaultSecond = await list(
    `/v0/b/${bucket}/o?prefix=objects%2F&pageToken=${encodeURIComponent(firebaseDefaultFirst.nextPageToken ?? "")}`,
    "firebase-default-second",
  );
  const gcsSmallFirst = await list(
    `/storage/v1/b/${bucket}/o?prefix=objects%2F&maxResults=2`,
    "gcs-small-first",
  );
  const gcsSmallSecond = await list(
    `/storage/v1/b/${bucket}/o?prefix=objects%2F&maxResults=2&pageToken=${encodeURIComponent(gcsSmallFirst.nextPageToken ?? "")}`,
    "gcs-small-second",
  );
  const firebaseSmallFirst = await list(
    `/v0/b/${bucket}/o?prefix=objects%2F&maxResults=2`,
    "firebase-small-first",
  );
  const firebaseSmallSecond = await list(
    `/v0/b/${bucket}/o?prefix=objects%2F&maxResults=2&pageToken=${encodeURIComponent(firebaseSmallFirst.nextPageToken ?? "")}`,
    "firebase-small-second",
  );
  const unknownToken = await list(
    `/storage/v1/b/${bucket}/o?prefix=objects%2F&maxResults=2&pageToken=objects%2Fnot-present.json`,
    "gcs-unknown-token",
  );
  const delimiter = await list(
    `/storage/v1/b/${bucket}/o?prefix=objects%2F&delimiter=%2F&maxResults=2`,
    "gcs-delimiter",
  );

  const [sdkFiles] = await storage.bucket(bucket).getFiles({ prefix: "objects/" });
  const sdkNames = sdkFiles.map((file: { readonly name: string }) => file.name);
  assert.deepEqual(sdkNames, names);

  assertPage(gcsDefaultFirst, 1_000, names[0]!, names[999]!, names[1_000]);
  assertPage(gcsDefaultSecond, 2, names[1_000]!, names[1_001]!, undefined);
  assertPage(firebaseDefaultFirst, 1_000, names[0]!, names[999]!, names[1_000]);
  assertPage(firebaseDefaultSecond, 2, names[1_000]!, names[1_001]!, undefined);
  assertPage(gcsSmallFirst, 2, names[0]!, names[1]!, names[2]);
  assertPage(gcsSmallSecond, 2, names[2]!, names[3]!, names[4]);
  assertPage(firebaseSmallFirst, 2, names[0]!, names[1]!, names[2]);
  assertPage(firebaseSmallSecond, 2, names[2]!, names[3]!, names[4]);
  assertPage(unknownToken, 2, names[0]!, names[1]!, names[2]);
  assert.equal(delimiter.itemNames.length, 2);
  assert.deepEqual(delimiter.prefixes, []);

  const sourceHashes: Record<string, string> = {};
  for (const name of ["files.js", "apis/firebase.js", "apis/gcloud.js"]) {
    sourceHashes[name] = sha(await readFile(join(packageRoot, "lib/emulator/storage", name)));
  }
  const fixture = {
    schemaVersion: 1,
    target: "official-firebase-tools-storage-emulator",
    targetVersion: "15.22.0",
    capturedAt: new Date().toISOString(),
    projectId,
    bucket,
    syntheticOnly: true,
    credentialsStored: false,
    sourceHashes,
    objectCorpus: {
      count: objectCount,
      first: names[0],
      boundaryBefore: names[999],
      boundaryToken: names[1_000],
      last: names[1_001],
    },
    observations: [
      gcsDefaultFirst,
      gcsDefaultSecond,
      firebaseDefaultFirst,
      firebaseDefaultSecond,
      gcsSmallFirst,
      gcsSmallSecond,
      firebaseSmallFirst,
      firebaseSmallSecond,
      unknownToken,
      delimiter,
    ],
    sdkAutopagination: {
      packageVersion: JSON.parse(await readFile(
        join(packageRoot, "../@google-cloud/storage/package.json"),
        "utf8",
      )).version,
      count: sdkNames.length,
      first: sdkNames[0],
      boundaryBefore: sdkNames[999],
      boundaryAfter: sdkNames[1_000],
      last: sdkNames.at(-1),
    },
    invariants: {
      defaultPageSize: 1_000,
      pageTokenIsNextObjectName: true,
      pageTokenIsInclusiveOnResume: true,
      unknownPageTokenRestartsAtFirstItem: true,
      gcsAndFirebaseRoutesSharePagination: true,
      sdkAutopaginationReturnsAllObjects: true,
      ordering: "lexicographic-object-name",
    },
  };
  const output = resolve(
    process.env.STORAGE_PAGINATION_FIXTURE_OUTPUT
      ?? "fixtures/firebase-suite-v1/storage-list-pagination",
  );
  await mkdir(output, { recursive: true });
  const fixtureBytes = `${JSON.stringify(fixture, null, 2)}\n`;
  await writeFile(join(output, "fixture.json"), fixtureBytes, { flag: "wx" });
  await writeFile(
    join(output, "SHA256SUMS"),
    `${sha(Buffer.from(fixtureBytes))}  fixture.json\n`,
    { flag: "wx" },
  );
  console.log(JSON.stringify({ output, scratch, observations: fixture.observations.length }));
} finally {
  await emulator.stop();
  EmulatorRegistry.clear("storage");
}

interface ListObservation {
  readonly id: string;
  readonly status: number;
  readonly itemCount: number;
  readonly itemNames: readonly string[];
  readonly first: string | null;
  readonly last: string | null;
  readonly nextPageToken?: string;
  readonly prefixes: readonly string[];
  readonly responseSha256: string;
}

async function list(path: string, id: string): Promise<ListObservation> {
  const response = await raw(origin + path, "GET", { authorization: "Bearer owner" });
  assert.equal(response.status, 200);
  const body = JSON.parse(response.body.toString()) as {
    readonly items?: readonly { readonly name?: string }[];
    readonly nextPageToken?: string;
    readonly prefixes?: readonly string[];
  };
  const itemNames = (body.items ?? []).map((item) => item.name ?? "");
  return {
    id,
    status: response.status,
    itemCount: itemNames.length,
    itemNames,
    first: itemNames[0] ?? null,
    last: itemNames.at(-1) ?? null,
    ...(body.nextPageToken ? { nextPageToken: body.nextPageToken } : {}),
    prefixes: body.prefixes ?? [],
    responseSha256: sha(response.body),
  };
}

function assertPage(
  page: ListObservation,
  count: number,
  first: string,
  last: string,
  nextPageToken: string | undefined,
): void {
  assert.equal(page.itemCount, count);
  assert.equal(page.first, first);
  assert.equal(page.last, last);
  assert.equal(page.nextPageToken, nextPageToken);
}

function sha(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

async function raw(
  url: string,
  method: string,
  headers: IncomingHttpHeaders = {},
  body = Buffer.alloc(0),
): Promise<{ readonly status: number; readonly headers: IncomingHttpHeaders; readonly body: Buffer }> {
  return await new Promise((resolvePromise, reject) => {
    const outgoing = request(url, {
      method,
      headers: { ...headers, host: new URL(url).host },
      timeout: 30_000,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => resolvePromise({
        status: response.statusCode!,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    outgoing.on("timeout", () => outgoing.destroy(new Error(`timeout ${method} ${url}`)));
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}
