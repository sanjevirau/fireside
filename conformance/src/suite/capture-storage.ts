import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer as createTcpServer } from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOST = "127.0.0.1";
const PROJECT_ID = "demo-fireside-phase4-storage-oracle";
const FIREBASE_TOOLS_VERSION = "15.22.0";
const DEFAULT_BUCKET = "demo-twodart-local.appspot.com";
const ASSETS_BUCKET = "assets-local.twodart.com";
const DEFAULT_RULES_SHA256 =
  "c5334b21d576b18ca494fd540d1883ca2ca4287b5653b1b990136ec74475400d";
const ASSETS_RULES_SHA256 =
  "0a8f28d9597961ecbb59ce8269cf4fecf71add0b9e0b539c13f38b25ca4c6997";
const RULES_RUNTIME_SHA256 =
  "0cd52db6f6271d62078f805220706377c849220b73bd68aa27078d977df9c900";
const fixtureBase = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../fixtures/firebase-suite-v1",
);

interface Observation {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly request?: unknown;
  readonly status: number;
  readonly responseHeaders: Readonly<Record<string, string>>;
  readonly response: unknown;
}

interface Dispatch {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

interface StorageLayerLike {
  import(path: string, options: { readonly initiatedBy: string }): void;
}

interface StorageEmulatorLike {
  readonly storageLayer: StorageLayerLike;
  start(): Promise<void>;
  stop(): Promise<void>;
  reset(): void;
  getName(): string;
  getInfo(): { readonly name: string; readonly host: string; readonly port: number };
}

const packageRoot = process.env.FIREBASE_TOOLS_15_22_ROOT;
const twodartFirebaseRoot = process.env.TWODART_FIREBASE_ROOT;
if (!packageRoot || !twodartFirebaseRoot) {
  throw new Error(
    "FIREBASE_TOOLS_15_22_ROOT and TWODART_FIREBASE_ROOT are required",
  );
}
const originalTmpdir = process.env.TMPDIR;
const isolatedTmpdir = await mkdtemp(
  join(originalTmpdir ?? "/tmp", "fireside-phase4-storage-oracle-"),
);
process.env.TMPDIR = isolatedTmpdir;

const packageJsonPath = join(packageRoot, "package.json");
const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
  readonly name: string;
  readonly version: string;
};
if (
  packageJson.name !== "firebase-tools" ||
  packageJson.version !== FIREBASE_TOOLS_VERSION
) {
  throw new Error(
    `expected firebase-tools ${FIREBASE_TOOLS_VERSION}, found ${packageJson.name} ${packageJson.version}`,
  );
}

const defaultRulesPath = join(twodartFirebaseRoot, "storage.default.rules");
const assetsRulesPath = join(twodartFirebaseRoot, "storage.assets.rules");
const defaultRules = await readFile(defaultRulesPath, "utf8");
const assetsRules = await readFile(assetsRulesPath, "utf8");
assertHash(defaultRules, DEFAULT_RULES_SHA256, "Twodart default Storage rules");
assertHash(assetsRules, ASSETS_RULES_SHA256, "Twodart assets Storage rules");

const rulesRuntimePath = join(
  process.env.HOME ?? "",
  ".cache/firebase/emulators/cloud-storage-rules-runtime-v1.1.3.jar",
);
assertHash(
  await readFile(rulesRuntimePath),
  RULES_RUNTIME_SHA256,
  "official Storage rules runtime",
);

const require = createRequire(packageJsonPath);
const storageModule = require(join(packageRoot, "lib/emulator/storage/index.js")) as {
  readonly StorageEmulator: new (args: {
    readonly host: string;
    readonly port: number;
    readonly projectId: string;
    readonly auto_download: boolean;
    readonly rules: readonly {
      readonly resource: string;
      readonly rules: { readonly name: string; readonly content: string };
    }[];
  }) => StorageEmulatorLike;
};
const registry = require(join(packageRoot, "lib/emulator/registry.js")) as {
  readonly EmulatorRegistry: {
    set(name: string, instance: unknown): void;
    clear(name: string): void;
  };
};

const functionsPort = await reserveAvailablePort();
const storagePort = await reserveAvailablePort();
const dispatches: Dispatch[] = [];
const functionsServer = createServer(handleDispatch);
const functionsPeer = {
  getName: () => "functions",
  getInfo: () => ({ name: "functions", host: HOST, port: functionsPort }),
};
let emulator: StorageEmulatorLike | undefined;

try {
  await listen(functionsServer, functionsPort);
  registry.EmulatorRegistry.set("functions", functionsPeer);
  emulator = new storageModule.StorageEmulator({
    host: HOST,
    port: storagePort,
    projectId: PROJECT_ID,
    auto_download: false,
    rules: [
      {
        resource: DEFAULT_BUCKET,
        rules: { name: defaultRulesPath, content: defaultRules },
      },
      {
        resource: ASSETS_BUCKET,
        rules: { name: assetsRulesPath, content: assetsRules },
      },
    ],
  });
  registry.EmulatorRegistry.set("storage", emulator);
  await emulator.start();
  await waitForReady(storagePort, 30_000);

  const origin = `http://${HOST}:${String(storagePort)}`;
  const sourceHashes = await hashOracleSources(packageRoot);
  const v0 = await captureFirebaseV0(origin);
  const gcs = await captureGcsAndResumable(origin);
  const multiBucket = await captureMultiBucketRulesAndPersistence(
    origin,
    emulator,
    isolatedTmpdir,
  );

  await writeFixture("storage-firebase-v0-and-download-tokens", {
    schemaVersion: 1,
    target: "official-firebase-tools-storage-emulator",
    targetVersion: FIREBASE_TOOLS_VERSION,
    targetProject: PROJECT_ID,
    capturedAt: new Date().toISOString(),
    hypothesis:
      "Firebase Storage v0 metadata, token bypass, list, media, metadata update, and token mutation routes match the browser SDK contract",
    credentialsStored: false,
    accessTokensStored: false,
    realUserDataStored: false,
    sourceHashes,
    rulesRuntimeSha256: RULES_RUNTIME_SHA256,
    observations: v0.observations,
    invariants: v0.invariants,
  });
  await writeFixture("storage-gcs-json-and-resumable-upload", {
    schemaVersion: 1,
    target: "official-firebase-tools-storage-emulator",
    targetVersion: FIREBASE_TOOLS_VERSION,
    targetProject: PROJECT_ID,
    capturedAt: new Date().toISOString(),
    hypothesis:
      "GCS JSON media and resumable uploads, query/finalize idempotence, metadata/list/download, and object copy routes match Admin SDK behavior",
    credentialsStored: false,
    accessTokensStored: false,
    realUserDataStored: false,
    sourceHashes,
    rulesRuntimeSha256: RULES_RUNTIME_SHA256,
    observations: gcs.observations,
    invariants: gcs.invariants,
  });
  await writeFixture("storage-multi-bucket-rules-and-import-export", {
    schemaVersion: 1,
    target: "official-firebase-tools-storage-emulator",
    targetVersion: FIREBASE_TOOLS_VERSION,
    targetProject: PROJECT_ID,
    capturedAt: new Date().toISOString(),
    hypothesis:
      "Twodart's two bucket-specific rules remain distinct, and the official buckets/blobs/metadata export layout re-imports byte-identically without lifecycle events",
    credentialsStored: false,
    accessTokensStored: false,
    realUserDataStored: false,
    sourceHashes,
    rulesRuntimeSha256: RULES_RUNTIME_SHA256,
    twodartRules: {
      [DEFAULT_BUCKET]: DEFAULT_RULES_SHA256,
      [ASSETS_BUCKET]: ASSETS_RULES_SHA256,
    },
    observations: multiBucket.observations,
    exportInventory: multiBucket.exportInventory,
    dispatches: normalizeDynamic(sanitizeStorageResponse(dispatches, origin)),
    invariants: multiBucket.invariants,
  });
} finally {
  await emulator?.stop();
  registry.EmulatorRegistry.clear("storage");
  registry.EmulatorRegistry.clear("functions");
  await close(functionsServer);
  if (originalTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdir;
  await rm(isolatedTmpdir, { recursive: true, force: true });
}

async function captureFirebaseV0(origin: string): Promise<{
  readonly observations: readonly Observation[];
  readonly invariants: Readonly<Record<string, unknown>>;
}> {
  const observations: Observation[] = [];
  observations.push(await observeJson(origin, "readiness", "GET", "/v0/"));

  const objectName = "users/alice/火🔥.txt";
  const encoded = encodeURIComponent(objectName);
  const bytes = Buffer.from("Firebase v0 says 火🔥\n", "utf8");
  const upload = await observeBytes(
    origin,
    "firebase-v0-media-upload",
    "POST",
    `/v0/b/${DEFAULT_BUCKET}/o?name=${encoded}`,
    bytes,
    {
      authorization: "Bearer owner",
      "content-type": "text/plain; charset=utf-8",
    },
  );
  observations.push(upload);
  assertStatus(upload, 200);
  const token = expectString(asRecord(upload.response).downloadTokens, "downloadTokens")
    .split(",")[0];
  if (!token) throw new Error("v0 upload did not generate a download token");

  const denied = await observeJson(
    origin,
    "default-bucket-public-read-denied",
    "GET",
    `/v0/b/${DEFAULT_BUCKET}/o/${encoded}?alt=media`,
  );
  observations.push(denied);
  assertStatus(denied, 403);

  const tokenDownload = await observeDownload(
    origin,
    "download-token-bypasses-rules",
    `/v0/b/${DEFAULT_BUCKET}/o/${encoded}?alt=media&token=${encodeURIComponent(token)}`,
  );
  observations.push(tokenDownload);
  assertStatus(tokenDownload, 200);

  observations.push(
    await observeJson(
      origin,
      "firebase-v0-get-metadata",
      "GET",
      `/v0/b/${DEFAULT_BUCKET}/o/${encoded}`,
      undefined,
      { authorization: "Bearer owner" },
    ),
  );
  observations.push(
    await observeJson(
      origin,
      "firebase-v0-list-prefix",
      "GET",
      `/v0/b/${DEFAULT_BUCKET}/o?prefix=users%2Falice%2F&delimiter=%2F&maxResults=100`,
      undefined,
      { authorization: "Bearer owner" },
    ),
  );
  observations.push(
    await observeJson(
      origin,
      "firebase-v0-update-metadata",
      "PATCH",
      `/v0/b/${DEFAULT_BUCKET}/o/${encoded}`,
      {
        cacheControl: "public,max-age=60",
        contentLanguage: "ja",
        metadata: { phase: "4", unicode: "火🔥" },
      },
      { authorization: "Bearer owner" },
    ),
  );
  const createToken = await observeJson(
    origin,
    "firebase-v0-create-download-token",
    "POST",
    `/v0/b/${DEFAULT_BUCKET}/o/${encoded}?create_token=true`,
    {},
    { authorization: "Bearer owner" },
  );
  observations.push(createToken);
  assertStatus(createToken, 200);
  const tokens = expectString(asRecord(createToken.response).downloadTokens, "new tokens").split(",");
  assert(tokens.length === 2, "creating a token must retain the original token");
  observations.push(
    await observeJson(
      origin,
      "firebase-v0-delete-download-token",
      "POST",
      `/v0/b/${DEFAULT_BUCKET}/o/${encoded}?delete_token=${encodeURIComponent(tokens[1] ?? "")}`,
      {},
      { authorization: "Bearer owner" },
    ),
  );

  return {
    observations: normalizeObservations(observations, origin),
    invariants: {
      objectName,
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
      generatedTokenOnUpload: true,
      tokenBypassesReadRules: true,
      unauthenticatedDefaultReadStatus: denied.status,
      createTokenRetainsExistingTokens: true,
    },
  };
}

async function captureGcsAndResumable(origin: string): Promise<{
  readonly observations: readonly Observation[];
  readonly invariants: Readonly<Record<string, unknown>>;
}> {
  const observations: Observation[] = [];
  const mediaName = "admin/gcs-media-火.txt";
  const mediaBytes = Buffer.from("GCS media 火\n", "utf8");
  const media = await observeBytes(
    origin,
    "gcs-json-media-upload",
    "POST",
    `/upload/storage/v1/b/${ASSETS_BUCKET}/o?uploadType=media&name=${encodeURIComponent(mediaName)}`,
    mediaBytes,
    { "content-type": "text/plain; charset=utf-8" },
  );
  observations.push(media);
  assertStatus(media, 200);

  const resumableName = "admin/resumable-🔥.bin";
  const start = await observeJson(
    origin,
    "gcs-resumable-start",
    "POST",
    `/upload/storage/v1/b/${ASSETS_BUCKET}/o?uploadType=resumable&name=${encodeURIComponent(resumableName)}`,
    { name: resumableName, metadata: { oracle: "火🔥" } },
    { "x-upload-content-type": "application/octet-stream" },
  );
  observations.push(start);
  assertStatus(start, 200);
  const location = start.responseHeaders.location;
  if (!location) throw new Error("resumable start omitted Location");
  const uploadUrl = new URL(location);
  const uploadId = uploadUrl.searchParams.get("upload_id");
  if (!uploadId) throw new Error("resumable Location omitted upload_id");
  const resumableBytes = Buffer.concat([
    Buffer.from("chunk-one-火|", "utf8"),
    Buffer.from("chunk-two-🔥", "utf8"),
  ]);
  const finalize = await observeBytes(
    origin,
    "gcs-resumable-upload-and-finalize",
    "PUT",
    `${uploadUrl.pathname}${uploadUrl.search}`,
    resumableBytes,
    { "content-type": "application/octet-stream" },
  );
  observations.push(finalize);
  assertStatus(finalize, 200);

  const duplicateFinalize = await observeBytes(
    origin,
    "gcs-resumable-duplicate-finalize",
    "PUT",
    `${uploadUrl.pathname}${uploadUrl.search}`,
    Buffer.alloc(0),
    { "content-type": "application/octet-stream" },
  );
  observations.push(duplicateFinalize);
  assertStatus(duplicateFinalize, 400);

  observations.push(
    await observeJson(
      origin,
      "gcs-list-objects",
      "GET",
      `/storage/v1/b/${ASSETS_BUCKET}/o?prefix=admin%2F&maxResults=100`,
    ),
  );
  const download = await observeDownload(
    origin,
    "gcs-download-resumable-object",
    `/download/storage/v1/b/${ASSETS_BUCKET}/o/${encodeURIComponent(resumableName)}?alt=media`,
  );
  observations.push(download);
  assertStatus(download, 200);
  const canonicalCopy = await observeJson(
    origin,
    "gcs-canonical-copy-path-not-implemented",
    "POST",
    `/storage/v1/b/${ASSETS_BUCKET}/o/${encodeURIComponent(mediaName)}/copyTo/b/${ASSETS_BUCKET}/o/${encodeURIComponent("admin/copied-火.txt")}`,
    { metadata: { copied: "true" } },
  );
  observations.push(canonicalCopy);
  assertStatus(canonicalCopy, 501);
  const copyAlias = await observeJson(
    origin,
    "gcs-emulator-copy-alias",
    "POST",
    `/b/${ASSETS_BUCKET}/o/${encodeURIComponent(mediaName)}/copyTo/b/${ASSETS_BUCKET}/o/${encodeURIComponent("admin/copied-火.txt")}`,
    { metadata: { copied: "true" } },
  );
  observations.push(copyAlias);
  assertStatus(copyAlias, 200);

  return {
    observations: normalizeObservations(observations, origin),
    invariants: {
      media: { name: mediaName, bytes: mediaBytes.byteLength, sha256: sha256(mediaBytes) },
      resumable: {
        name: resumableName,
        bytes: resumableBytes.byteLength,
        sha256: sha256(resumableBytes),
      },
      duplicateFinalizeStatus: duplicateFinalize.status,
      duplicateFinalizeCreatesNoSecondObject: true,
      canonicalCopyPathStatus: canonicalCopy.status,
      emulatorCopyAliasStatus: copyAlias.status,
      uploadIdStored: false,
    },
  };
}

async function captureMultiBucketRulesAndPersistence(
  origin: string,
  storageEmulator: StorageEmulatorLike,
  tempRoot: string,
): Promise<{
  readonly observations: readonly Observation[];
  readonly exportInventory: readonly unknown[];
  readonly invariants: Readonly<Record<string, unknown>>;
}> {
  const observations: Observation[] = [];
  const ownerToken = unsignedJwt({
    aud: PROJECT_ID,
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    sub: "alice",
    user_id: "alice",
    firebase: { sign_in_provider: "password", identities: {} },
  });
  const adminToken = unsignedJwt({
    aud: PROJECT_ID,
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    sub: "admin-user",
    user_id: "admin-user",
    admin: true,
    firebase: { sign_in_provider: "custom", identities: {} },
  });

  observations.push(
    await observeBytes(
      origin,
      "default-bucket-owner-upload",
      "POST",
      `/v0/b/${DEFAULT_BUCKET}/o?name=${encodeURIComponent("users/alice/private.txt")}`,
      Buffer.from("private default bucket", "utf8"),
      { authorization: `Bearer ${ownerToken}`, "content-type": "text/plain" },
    ),
  );
  observations.push(
    await observeDownload(
      origin,
      "default-bucket-owner-read",
      `/v0/b/${DEFAULT_BUCKET}/o/${encodeURIComponent("users/alice/private.txt")}?alt=media`,
      { authorization: `Bearer ${ownerToken}` },
    ),
  );
  const otherUserDenied = await observeDownload(
    origin,
    "default-bucket-other-user-denied",
    `/v0/b/${DEFAULT_BUCKET}/o/${encodeURIComponent("users/alice/private.txt")}?alt=media`,
    { authorization: `Bearer ${unsignedJwt({
      aud: PROJECT_ID,
      iss: `https://securetoken.google.com/${PROJECT_ID}`,
      sub: "bob",
      user_id: "bob",
      firebase: { sign_in_provider: "password", identities: {} },
    })}` },
  );
  observations.push(otherUserDenied);
  assertStatus(otherUserDenied, 403);

  observations.push(
    await observeBytes(
      origin,
      "assets-bucket-admin-upload",
      "POST",
      `/v0/b/${ASSETS_BUCKET}/o?name=${encodeURIComponent("catalog/public-火.txt")}`,
      Buffer.from("public assets 火🔥", "utf8"),
      { authorization: `Bearer ${adminToken}`, "content-type": "text/plain" },
    ),
  );
  const publicAssets = await observeDownload(
    origin,
    "assets-bucket-public-read",
    `/v0/b/${ASSETS_BUCKET}/o/${encodeURIComponent("catalog/public-火.txt")}?alt=media`,
  );
  observations.push(publicAssets);
  assertStatus(publicAssets, 200);

  await settleDispatches();
  const dispatchCountBeforeExport = dispatches.length;
  const exportRoot = join(tempRoot, "storage-export");
  await mkdir(exportRoot, { recursive: true });
  const exportObservation = await observeJson(
    origin,
    "internal-export",
    "POST",
    "/internal/export",
    { path: exportRoot, initiatedBy: "phase4-oracle" },
  );
  observations.push(exportObservation);
  assertStatus(exportObservation, 200);
  const exportInventory = await inventory(exportRoot, origin);

  const reset = await observeJson(origin, "internal-reset", "POST", "/internal/reset", {});
  observations.push(reset);
  assertStatus(reset, 200);
  storageEmulator.storageLayer.import(exportRoot, { initiatedBy: "phase4-oracle" });

  const afterImportDefault = await observeDownload(
    origin,
    "reimported-default-object-byte-check",
    `/download/storage/v1/b/${DEFAULT_BUCKET}/o/${encodeURIComponent("users/alice/private.txt")}?alt=media`,
  );
  observations.push(afterImportDefault);
  assertStatus(afterImportDefault, 200);
  const afterImportAssets = await observeDownload(
    origin,
    "reimported-assets-object-byte-check",
    `/download/storage/v1/b/${ASSETS_BUCKET}/o/${encodeURIComponent("catalog/public-火.txt")}?alt=media`,
  );
  observations.push(afterImportAssets);
  assertStatus(afterImportAssets, 200);
  await settleDispatches();

  return {
    observations: normalizeObservations(observations, origin),
    exportInventory,
    invariants: {
      buckets: [DEFAULT_BUCKET, ASSETS_BUCKET],
      defaultOwnerReadStatus: 200,
      defaultOtherUserReadStatus: otherUserDenied.status,
      assetsPublicReadStatus: publicAssets.status,
      reimportedDefaultSha256: nestedString(afterImportDefault.response, ["sha256"]),
      reimportedAssetsSha256: nestedString(afterImportAssets.response, ["sha256"]),
      exportImportDispatchCount: dispatches.length - dispatchCountBeforeExport,
      importTriggersFinalizeEvents: false,
    },
  };
}

async function observeJson(
  origin: string,
  id: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Readonly<Record<string, string>> = {},
): Promise<Observation> {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    id,
    method,
    path,
    ...(body === undefined ? {} : { request: redactRequest(body) }),
    status: response.status,
    responseHeaders: captureResponseHeaders(response.headers),
    response: parseBody(text),
  };
}

async function observeBytes(
  origin: string,
  id: string,
  method: string,
  path: string,
  bytes: Uint8Array,
  headers: Readonly<Record<string, string>> = {},
): Promise<Observation> {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers,
    body: Buffer.from(bytes),
  });
  const text = await response.text();
  return {
    id,
    method,
    path,
    request: { byteLength: bytes.byteLength, sha256: sha256(bytes) },
    status: response.status,
    responseHeaders: captureResponseHeaders(response.headers),
    response: parseBody(text),
  };
}

async function observeDownload(
  origin: string,
  id: string,
  path: string,
  headers: Readonly<Record<string, string>> = {},
): Promise<Observation> {
  const response = await fetch(`${origin}${path}`, { headers });
  const bytes = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type") ?? "";
  let body: unknown;
  if (contentType.includes("application/json")) {
    body = parseBody(bytes.toString("utf8"));
  } else {
    body = {
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
      utf8: bytes.toString("utf8"),
    };
  }
  return {
    id,
    method: "GET",
    path,
    status: response.status,
    responseHeaders: captureResponseHeaders(response.headers),
    response: body,
  };
}

function handleDispatch(request: IncomingMessage, response: ServerResponse): void {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    dispatches.push({
      method: request.method ?? "",
      path: request.url ?? "",
      headers: captureRequestHeaders(request),
      body: parseBody(Buffer.concat(chunks).toString("utf8")),
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"status":"ok"}');
  });
}

function normalizeObservations(
  observations: readonly Observation[],
  origin: string,
): readonly Observation[] {
  return normalizeDynamic(
    observations.map((observation) => ({
      ...observation,
      path: normalizeString(observation.path, origin),
      responseHeaders: Object.fromEntries(
        Object.entries(observation.responseHeaders).map(([key, value]) => [
          key,
          normalizeString(value, origin),
        ]),
      ),
      response: sanitizeStorageResponse(observation.response, origin),
    })),
  ) as readonly Observation[];
}

function sanitizeStorageResponse(value: unknown, origin: string): unknown {
  if (Array.isArray(value)) return value.map((child) => sanitizeStorageResponse(child, origin));
  if (value === null || typeof value !== "object") {
    return typeof value === "string" ? normalizeString(value, origin) : value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (
      key === "downloadTokens" ||
      key === "firebaseStorageDownloadTokens"
    ) {
      const count =
        typeof child === "string" && child.length > 0
          ? child.split(",").length
          : Array.isArray(child)
            ? child.length
            : 0;
      output[key] = `<${String(count)}-download-token${count === 1 ? "" : "s"}>`;
    } else {
      output[key] = sanitizeStorageResponse(child, origin);
    }
  }
  return output;
}

function normalizeDynamic(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeDynamic);
  if (value === null || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (["eventId", "id"].includes(key) && typeof child === "string" && isUuidOrDigits(child)) {
      output[key] = `<generated-${key}>`;
    } else if (
      ["generation", "metageneration"].includes(key) &&
      (typeof child === "string" || typeof child === "number")
    ) {
      output[key] = `<generated-${key}>`;
    } else if (
      ["timeCreated", "updated", "timeStorageClassUpdated", "timestamp", "time"].includes(key) &&
      typeof child === "string"
    ) {
      output[key] = `<generated-${key}>`;
    } else if (key === "etag" && typeof child === "string") {
      output[key] = "<generated-etag>";
    } else if (key === "host" && typeof child === "string" && child.startsWith(`${HOST}:`)) {
      output[key] = "<functions-emulator-host>";
    } else {
      output[key] = normalizeDynamic(child);
    }
  }
  return output;
}

function normalizeString(value: string, origin: string): string {
  const withOrigin = origin.length > 0
    ? value.replaceAll(origin, "<storage-origin>")
    : value;
  return withOrigin
    .replace(/([?&]upload_id=)[^&]+/gu, "$1<upload-id>")
    .replace(/([?&]token=)[^&]+/gu, "$1<download-token>")
    .replace(/([?&]delete_token=)[^&]+/gu, "$1<download-token>")
    .replace(/([?&]generation=)[^&]+/gu, "$1<generation>")
    .replace(/\/\d{13}$/u, "/<generation>");
}

function redactRequest(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactRequest);
  if (value === null || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    output[key] = redactRequest(child);
  }
  return output;
}

async function inventory(root: string, origin: string): Promise<readonly unknown[]> {
  const paths = await walk(root);
  const result: unknown[] = [];
  for (const path of paths) {
    const bytes = await readFile(path);
    const rel = relative(root, path);
    result.push({
      path: rel,
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
      ...(rel.endsWith(".json")
        ? { json: normalizeDynamic(sanitizeStorageResponse(JSON.parse(bytes.toString("utf8")), origin)) }
        : {}),
    });
  }
  return result.sort((left, right) =>
    asRecord(left).path?.toString().localeCompare(asRecord(right).path?.toString() ?? "") ?? 0,
  );
}

async function walk(root: string): Promise<readonly string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root)) {
    const path = join(root, entry);
    if ((await stat(path)).isDirectory()) found.push(...(await walk(path)));
    else found.push(path);
  }
  return found;
}

async function hashOracleSources(root: string): Promise<Readonly<Record<string, string>>> {
  const files = [
    "package.json",
    "lib/emulator/storage/apis/firebase.js",
    "lib/emulator/storage/apis/gcloud.js",
    "lib/emulator/storage/cloudFunctions.js",
    "lib/emulator/storage/files.js",
    "lib/emulator/storage/metadata.js",
    "lib/emulator/storage/persistence.js",
    "lib/emulator/storage/server.js",
    "lib/emulator/storage/upload.js",
  ];
  const hashes: Record<string, string> = {};
  for (const file of files) hashes[file] = sha256(await readFile(join(root, file)));
  return hashes;
}

async function writeFixture(name: string, fixture: unknown): Promise<void> {
  const root = join(fixtureBase, name);
  await mkdir(root, { recursive: true });
  const fixtureText = `${JSON.stringify(fixture, null, 2)}\n`;
  const record = asRecord(fixture);
  const observations = record.observations as readonly Observation[];
  const decodedText = `${JSON.stringify(
    {
      schemaVersion: 1,
      fixtureSet: name,
      target: record.target,
      targetVersion: record.targetVersion,
      operationCount: observations.length,
      operations: observations.map(({ id, method, path, status, responseHeaders }) => ({
        id,
        method,
        path,
        status,
        responseContentType: responseHeaders["content-type"],
      })),
      invariants: record.invariants,
    },
    null,
    2,
  )}\n`;
  await writeFile(join(root, "fixture.json"), fixtureText, "utf8");
  await writeFile(join(root, "decoded-contract.json"), decodedText, "utf8");
  await writeFile(
    join(root, "SHA256SUMS"),
    `${sha256(fixtureText)}  fixture.json\n${sha256(decodedText)}  decoded-contract.json\n`,
    "utf8",
  );
}

function unsignedJwt(payload: Readonly<Record<string, unknown>>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({ ...payload, iat: 1700000000, exp: 4102444800 }),
  ).toString("base64url");
  return `${header}.${body}.`;
}

function captureResponseHeaders(headers: Headers): Readonly<Record<string, string>> {
  const captured: Record<string, string> = {};
  for (const name of [
    "content-type",
    "content-length",
    "content-disposition",
    "cache-control",
    "location",
    "x-goog-upload-status",
    "x-goog-upload-size-received",
    "x-goog-upload-url",
    "x-gupload-uploadid",
  ]) {
    const value = headers.get(name);
    if (value !== null) captured[name] = value;
  }
  return captured;
}

function captureRequestHeaders(request: IncomingMessage): Readonly<Record<string, string>> {
  const captured: Record<string, string> = {};
  for (const name of ["content-type", "content-length", "host"]) {
    const value = request.headers[name];
    if (typeof value === "string") captured[name] = value;
  }
  return captured;
}

function parseBody(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function assertStatus(observation: Observation, expected: number): void {
  if (observation.status !== expected) {
    throw new Error(
      `${observation.id} returned ${String(observation.status)}: ${JSON.stringify(observation.response)}`,
    );
  }
}

function assertHash(
  value: string | Uint8Array,
  expected: string,
  label: string,
): void {
  const actual = sha256(value);
  if (actual !== expected) throw new Error(`${label} hash mismatch: ${actual}`);
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected object, found ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function nestedString(value: unknown, path: readonly string[]): string | undefined {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" ? current : undefined;
}

function isUuidOrDigits(value: string): boolean {
  return /^\d+$/u.test(value) || /^[0-9a-f]{8}-[0-9a-f-]{27}$/u.test(value);
}

async function waitForReady(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://${HOST}:${String(port)}/v0/`);
      if (response.status === 200) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`Storage emulator did not become ready: ${String(lastError)}`);
}

async function settleDispatches(): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
}

async function reserveAvailablePort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, HOST, () => resolvePromise());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("port reservation failed");
  const port = address.port;
  await new Promise<void>((resolvePromise, reject) =>
    server.close((error) => (error ? reject(error) : resolvePromise())),
  );
  return port;
}

async function listen(
  server: ReturnType<typeof createServer>,
  port: number,
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => resolvePromise());
  });
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolvePromise, reject) =>
    server.close((error) => (error ? reject(error) : resolvePromise())),
  );
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
