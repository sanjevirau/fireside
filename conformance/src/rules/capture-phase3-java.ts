import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const HOST = "127.0.0.1";
const PROJECT_ID = "demo-fireside-phase3-rules";
const JAVA_VERSION = "1.22.0";
const JAVA_JAR_SHA256 =
  "9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c";
const outputRoot = resolve("fixtures/rules-v2");

interface HttpObservation {
  readonly id: string;
  readonly method: string;
  readonly url: string;
  readonly status: number;
  readonly body: unknown;
}

const javaJar =
  process.env.FIRESTORE_EMULATOR_JAR ??
  join(
    process.env.HOME ?? "",
    ".cache/firebase/emulators/cloud-firestore-emulator-v1.22.0.jar",
  );
const jarBytes = await readFile(javaJar);
const jarSha256 = sha256(jarBytes);
if (jarSha256 !== JAVA_JAR_SHA256) {
  throw new Error(
    `official Java emulator hash mismatch: expected ${JAVA_JAR_SHA256}, found ${jarSha256}`,
  );
}

const temporaryDirectory = await mkdtemp(
  join(tmpdir(), "fireside-phase3-rules-java-"),
);
const rulesPath = join(temporaryDirectory, "firestore.rules");
const rulesSource = buildRulesSource();
await writeFile(rulesPath, rulesSource, "utf8");

const port = await reserveAvailablePort();
const origin = `http://${HOST}:${String(port)}`;
const logs: string[] = [];
let javaProcess: ChildProcess | undefined;

try {
  javaProcess = spawn(
    process.env.JAVA ?? "java",
    [
      "-jar",
      javaJar,
      "--host",
      HOST,
      "--port",
      String(port),
      "--project_id",
      PROJECT_ID,
      "--single_project_mode",
      "true",
      "--rules",
      rulesPath,
    ],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );
  javaProcess.stdout?.on("data", (chunk: Buffer) => logs.push(chunk.toString("utf8")));
  javaProcess.stderr?.on("data", (chunk: Buffer) => logs.push(chunk.toString("utf8")));
  await waitForReady(origin, javaProcess, 30_000);

  await seedDocuments(origin);
  const accessAccounting = await captureAccessAccounting(origin);
  const getAfter = await captureGetAfter(origin);
  const runtimeErrors = await captureRuntimeErrors(origin);

  await mkdir(outputRoot, { recursive: true });
  const common = {
    schemaVersion: 1,
    target: "official-java-emulator",
    targetVersion: JAVA_VERSION,
    targetProject: PROJECT_ID,
    capturedAt: new Date().toISOString(),
    credentialsStored: false,
    authorizationHeadersStored: false,
    javaJarSha256: jarSha256,
    rulesSource,
    rulesSourceSha256: sha256(rulesSource),
  };
  await writeFixture("java-access-accounting.json", {
    ...common,
    observations: accessAccounting,
    relevantLogLines: relevantLogs(logs.join(""), [
      "evaluation error",
      "access call",
      "permission_denied",
    ]),
  });
  await writeFixture("java-get-after.json", {
    ...common,
    observations: getAfter,
    relevantLogLines: relevantLogs(logs.join(""), ["getafter", "permission_denied"]),
  });
  await writeFixture("java-runtime-errors.json", {
    ...common,
    observations: runtimeErrors,
    relevantLogLines: relevantLogs(logs.join(""), [
      "evaluation error",
      "property",
      "division",
      "index",
      "permission_denied",
    ]),
  });
} finally {
  await stopProcess(javaProcess);
  await rm(temporaryDirectory, { recursive: true, force: true });
}

async function captureAccessAccounting(
  originValue: string,
): Promise<readonly HttpObservation[]> {
  const observations: HttpObservation[] = [];
  for (const id of ["access-10", "access-11", "cached-11", "exists-10", "exists-11"]) {
    observations.push(await getDocument(originValue, `probe/${id}`, userToken()));
  }
  observations.push(
    await commit(
      originValue,
      "batch-20-distinct-access-calls",
      Array.from({ length: 20 }, (_, index) =>
        writeDocument(`batch/b20-${twoDigits(index)}`, { ordinal: index }),
      ),
      userToken(),
    ),
  );
  observations.push(
    await commit(
      originValue,
      "batch-21-distinct-access-calls",
      Array.from({ length: 21 }, (_, index) =>
        writeDocument(`batch/b21-${twoDigits(index)}`, { ordinal: index }),
      ),
      userToken(),
    ),
  );
  return observations;
}

async function captureGetAfter(
  originValue: string,
): Promise<readonly HttpObservation[]> {
  return [
    await commit(
      originValue,
      "get-after-sees-pending-write",
      [
        writeDocument("state/counter", { version: 2 }),
        writeDocument("atomic/allowed", { expectedVersion: 2 }),
      ],
      userToken(),
    ),
    await commit(
      originValue,
      "get-after-denies-stale-invariant",
      [
        writeDocument("state/counter", { version: 3 }),
        writeDocument("atomic/denied", { expectedVersion: 2 }),
      ],
      userToken(),
    ),
  ];
}

async function captureRuntimeErrors(
  originValue: string,
): Promise<readonly HttpObservation[]> {
  const observations: HttpObservation[] = [];
  for (const id of [
    "missing-field",
    "division-zero",
    "list-out-of-bounds",
    "wrong-type-method",
    "missing-get-resource",
  ]) {
    observations.push(await getDocument(originValue, `runtime/${id}`, userToken()));
  }
  return observations;
}

async function seedDocuments(originValue: string): Promise<void> {
  const documents: Array<readonly [string, Readonly<Record<string, unknown>>]> = [];
  for (let index = 0; index < 11; index += 1) {
    documents.push([`access/a${String(index)}`, { allowed: true }]);
    documents.push([`access/e${String(index)}`, { allowed: true }]);
  }
  for (const prefix of ["b20", "b21"]) {
    const count = prefix === "b20" ? 20 : 21;
    for (let index = 0; index < count; index += 1) {
      documents.push([`access/${prefix}-${twoDigits(index)}`, { allowed: true }]);
    }
  }
  for (const id of ["access-10", "access-11", "cached-11", "exists-10", "exists-11"]) {
    documents.push([`probe/${id}`, { marker: id }]);
  }
  for (const id of [
    "missing-field",
    "division-zero",
    "list-out-of-bounds",
    "wrong-type-method",
    "missing-get-resource",
  ]) {
    documents.push([
      `runtime/${id}`,
      id === "wrong-type-method" ? { marker: id, ordinal: 1 } : { marker: id },
    ]);
  }
  documents.push(["state/counter", { version: 1 }]);

  for (const [path, fields] of documents) {
    const observation = await patchDocument(originValue, path, fields, "owner");
    if (observation.status < 200 || observation.status >= 300) {
      throw new Error(`seed ${path} failed: ${JSON.stringify(observation)}`);
    }
  }
}

async function getDocument(
  originValue: string,
  path: string,
  token: string,
): Promise<HttpObservation> {
  return await request(
    path,
    "GET",
    documentUrl(originValue, path),
    token,
  );
}

async function patchDocument(
  originValue: string,
  path: string,
  fields: Readonly<Record<string, unknown>>,
  token: string,
): Promise<HttpObservation> {
  return await request(
    `seed-${path}`,
    "PATCH",
    documentUrl(originValue, path),
    token,
    { fields: encodeFields(fields) },
  );
}

async function commit(
  originValue: string,
  id: string,
  writes: readonly unknown[],
  token: string,
): Promise<HttpObservation> {
  const url = `${originValue}/v1/projects/${PROJECT_ID}/databases/(default)/documents:commit`;
  return await request(id, "POST", url, token, { writes });
}

async function request(
  id: string,
  method: string,
  url: string,
  token: string,
  body?: unknown,
): Promise<HttpObservation> {
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const bodyText = await response.text();
  let parsedBody: unknown = bodyText;
  if (bodyText.length > 0) {
    try {
      parsedBody = JSON.parse(bodyText);
    } catch {
      // Preserve a non-JSON emulator response verbatim.
    }
  }
  return {
    id,
    method,
    url: redactOrigin(url),
    status: response.status,
    body: parsedBody,
  };
}

function writeDocument(
  path: string,
  fields: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    update: {
      name: `projects/${PROJECT_ID}/databases/(default)/documents/${path}`,
      fields: encodeFields(fields),
    },
  };
}

function encodeFields(
  fields: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => {
      if (typeof value === "boolean") return [key, { booleanValue: value }];
      if (typeof value === "number" && Number.isInteger(value)) {
        return [key, { integerValue: String(value) }];
      }
      if (typeof value === "string") return [key, { stringValue: value }];
      throw new Error(`unsupported fixture field ${key}`);
    }),
  );
}

function documentUrl(originValue: string, path: string): string {
  return `${originValue}/v1/projects/${PROJECT_ID}/databases/(default)/documents/${path}`;
}

function userToken(): string {
  const issuedAt = 1_788_200_000;
  const header = base64Url({ alg: "none", typ: "JWT" });
  const payload = base64Url({
    aud: PROJECT_ID,
    auth_time: issuedAt,
    exp: issuedAt + 86_400,
    firebase: { sign_in_provider: "custom" },
    iat: issuedAt,
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    sub: "phase3-user",
    user_id: "phase3-user",
    role: "editor",
  });
  return `${header}.${payload}.`;
}

function base64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function buildRulesSource(): string {
  const access = (prefix: string, count: number, functionName: "get" | "exists") =>
    Array.from({ length: count }, (_, index) => {
      const path = `/databases/$(database)/documents/access/${prefix}${String(index)}`;
      return functionName === "get"
        ? `get(${path}).data.allowed == true`
        : `exists(${path})`;
    }).join(" &&\n        ");
  const cached = Array.from(
    { length: 11 },
    () => "get(/databases/$(database)/documents/access/a0).data.allowed == true",
  ).join(" &&\n        ");
  return `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /probe/access-10 {
      allow get: if ${access("a", 10, "get")};
    }
    match /probe/access-11 {
      allow get: if ${access("a", 11, "get")};
    }
    match /probe/cached-11 {
      allow get: if ${cached};
    }
    match /probe/exists-10 {
      allow get: if ${access("e", 10, "exists")};
    }
    match /probe/exists-11 {
      allow get: if ${access("e", 11, "exists")};
    }
    match /batch/{id} {
      allow create, update: if exists(/databases/$(database)/documents/access/$(id));
    }
    match /state/counter {
      allow update: if request.resource.data.version == resource.data.version + 1;
    }
    match /atomic/{id} {
      allow create: if getAfter(/databases/$(database)/documents/state/counter).data.version == request.resource.data.expectedVersion;
    }
    match /runtime/missing-field {
      allow get: if resource.data.missing == true;
    }
    match /runtime/division-zero {
      allow get: if 1 / 0 == 0;
    }
    match /runtime/list-out-of-bounds {
      allow get: if [1][2] == 1;
    }
    match /runtime/wrong-type-method {
      allow get: if resource.data.ordinal.size() == 1;
    }
    match /runtime/missing-get-resource {
      allow get: if get(/databases/$(database)/documents/missing/document).data.allowed == true;
    }
  }
}
`;
}

async function writeFixture(name: string, value: unknown): Promise<void> {
  const output = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(resolve(outputRoot, name), output, "utf8");
  console.log(`${sha256(output)}  ${name}`);
}

function relevantLogs(logText: string, needles: readonly string[]): readonly string[] {
  return logText
    .split(/\r?\n/u)
    .filter((line) =>
      needles.some((needle) => line.toLowerCase().includes(needle.toLowerCase())),
    );
}

function redactOrigin(url: string): string {
  return url.replace(origin, "http://127.0.0.1:{ephemeral-port}");
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

async function reserveAvailablePort(): Promise<number> {
  const server = createServer();
  return await new Promise<number>((resolveValue, reject) => {
    server.once("error", reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("failed to reserve loopback port"));
        return;
      }
      server.close((error) => {
        if (error === undefined) resolveValue(address.port);
        else reject(error);
      });
    });
  });
}

async function waitForReady(
  originValue: string,
  child: ChildProcess,
  timeoutMilliseconds: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Java emulator exited before readiness: ${logs.join("")}`);
    }
    try {
      await fetch(originValue);
      return;
    } catch {
      await new Promise((resolveValue) => setTimeout(resolveValue, 100));
    }
  }
  throw new Error(`Java emulator readiness timeout: ${logs.join("")}`);
}

async function stopProcess(child: ChildProcess | undefined): Promise<void> {
  if (child === undefined || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolveValue) => {
    const timeout = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      resolveValue();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolveValue();
    });
  });
}
