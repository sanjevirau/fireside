import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOST = "127.0.0.1";
const PROJECT_ID = "demo-fireside-phase4-trigger-oracle";
const JAVA_VERSION = "1.22.0";
const JAVA_JAR_SHA256 =
  "9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c";
const V1_TRIGGER = "us-central1-v1Created";
const V2_TRIGGER = "us-central1-v2Created";
const fixtureRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../fixtures/firebase-suite-v1/firestore-trigger-registration-and-v1-v2-dispatch",
);

interface DispatchObservation {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

interface RegistrationObservation {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly request: unknown;
  readonly status: number;
  readonly response: unknown;
}

const javaJar =
  process.env.FIRESTORE_EMULATOR_JAR ??
  join(
    process.env.HOME ?? "",
    ".cache/firebase/emulators/cloud-firestore-emulator-v1.22.0.jar",
  );
const jarSha256 = sha256(await readFile(javaJar));
if (jarSha256 !== JAVA_JAR_SHA256) {
  throw new Error(
    `official Java emulator hash mismatch: expected ${JAVA_JAR_SHA256}, found ${jarSha256}`,
  );
}

const functionsPort = await reserveAvailablePort();
const firestorePort = await reserveAvailablePort();
const dispatches: DispatchObservation[] = [];
const dispatchWaiters: Array<() => void> = [];
const functionsServer = createServer(handleFunctionDispatch);
const temporaryDirectory = await mkdtemp(
  join(tmpdir(), "fireside-phase4-firestore-trigger-oracle-"),
);
const javaLogs: string[] = [];
let javaProcess: ChildProcess | undefined;

try {
  await listen(functionsServer, functionsPort);
  javaProcess = spawn(
    process.env.JAVA ?? "java",
    [
      "-jar",
      javaJar,
      "--host",
      HOST,
      "--port",
      String(firestorePort),
      "--project_id",
      PROJECT_ID,
      "--single_project_mode",
      "true",
      "--database-edition",
      "standard",
      "--functions_emulator",
      `${HOST}:${String(functionsPort)}`,
    ],
    {
      cwd: temporaryDirectory,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  javaProcess.stdout?.on("data", (chunk: Buffer) =>
    javaLogs.push(chunk.toString("utf8")),
  );
  javaProcess.stderr?.on("data", (chunk: Buffer) =>
    javaLogs.push(chunk.toString("utf8")),
  );
  await waitForReady(firestorePort, javaProcess, 30_000);

  const origin = `http://${HOST}:${String(firestorePort)}`;
  const registrations = await registerTriggers(origin);
  const dispatchPromise = waitForDispatches(2, 15_000);
  const write = await requestJson(
    `${origin}/v1/projects/${PROJECT_ID}/databases/(default)/documents/phase4Triggers/oracle?currentDocument.exists=false`,
    "PATCH",
    {
      fields: {
        ascii: { stringValue: "oracle" },
        unicode: { stringValue: "火🔥" },
        ordinal: { integerValue: "1" },
      },
    },
    { authorization: "Bearer owner" },
  );
  if (write.status !== 200) {
    throw new Error(`oracle write failed: ${write.status} ${JSON.stringify(write.body)}`);
  }
  await dispatchPromise;

  const normalizedDispatches = dispatches
    .map(normalizeDispatch)
    .sort((left, right) => left.path.localeCompare(right.path));
  const fixture = {
    schemaVersion: 1,
    target: "official-java-emulator",
    targetVersion: JAVA_VERSION,
    targetProject: PROJECT_ID,
    capturedAt: new Date().toISOString(),
    hypothesis:
      "v1 and v2 Firestore create triggers use distinct registration bodies and dispatch exact legacy-event and CloudEvent envelopes to the Functions emulator",
    credentialsStored: false,
    authorizationHeadersStored: false,
    javaJarSha256: jarSha256,
    registrations,
    write: {
      method: "PATCH",
      path: `/v1/projects/${PROJECT_ID}/databases/(default)/documents/phase4Triggers/oracle?currentDocument.exists=false`,
      status: write.status,
      responseShape: summarizeDocumentResponse(write.body),
    },
    dispatches: normalizedDispatches,
    relevantLogLines: relevantLogs(javaLogs.join("")),
  };

  await mkdir(fixtureRoot, { recursive: true });
  const fixtureText = `${JSON.stringify(fixture, null, 2)}\n`;
  await writeFile(join(fixtureRoot, "fixture.json"), fixtureText, "utf8");
  const contract = decodeContract(registrations, normalizedDispatches);
  const contractText = `${JSON.stringify(contract, null, 2)}\n`;
  await writeFile(join(fixtureRoot, "decoded-contract.json"), contractText, "utf8");
  await writeFile(
    join(fixtureRoot, "SHA256SUMS"),
    `${sha256(fixtureText)}  fixture.json\n${sha256(contractText)}  decoded-contract.json\n`,
    "utf8",
  );
} finally {
  await stopProcess(javaProcess);
  await close(functionsServer);
  await rm(temporaryDirectory, { recursive: true, force: true });
}

function handleFunctionDispatch(
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    const bodyText = Buffer.concat(chunks).toString("utf8");
    let body: unknown = null;
    if (bodyText.length > 0) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        body = bodyText;
      }
    }
    dispatches.push({
      method: request.method ?? "",
      path: request.url ?? "",
      headers: captureHeaders(request),
      body,
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"status":"ok"}');
    while (dispatchWaiters.length > 0) {
      dispatchWaiters.shift()?.();
    }
  });
}

async function registerTriggers(
  origin: string,
): Promise<readonly RegistrationObservation[]> {
  const v1Request = {
    eventTrigger: {
      eventType: "providers/cloud.firestore/eventTypes/document.create",
      resource: `projects/${PROJECT_ID}/databases/(default)/documents/phase4Triggers/{documentId}`,
      service: "firestore.googleapis.com",
    },
  };
  const v2Request = {
    eventType: "google.cloud.firestore.document.v1.created",
    database: "(default)",
    namespace: "(default)",
    document: {
      value: "phase4Triggers/{documentId}",
      matchType: "PATH_PATTERN",
    },
  };
  const requests = [
    {
      id: "v1-document-create",
      method: "PUT",
      path: `/emulator/v1/projects/${PROJECT_ID}/triggers/${V1_TRIGGER}`,
      body: v1Request,
    },
    {
      id: "v2-document-created",
      method: "POST",
      path: `/emulator/v1/projects/${PROJECT_ID}/eventarcTrigger?eventarcTriggerId=${V2_TRIGGER}`,
      body: v2Request,
    },
  ] as const;
  const observations: RegistrationObservation[] = [];
  for (const request of requests) {
    const result = await requestJson(
      `${origin}${request.path}`,
      request.method,
      request.body,
    );
    observations.push({
      id: request.id,
      method: request.method,
      path: request.path,
      request: request.body,
      status: result.status,
      response: result.body,
    });
    if (result.status !== 200) {
      throw new Error(
        `${request.id} registration failed: ${result.status} ${JSON.stringify(result.body)}`,
      );
    }
  }
  return observations;
}

function normalizeDispatch(observation: DispatchObservation): DispatchObservation {
  return {
    ...observation,
    headers: Object.fromEntries(
      Object.entries(observation.headers).filter(([name]) =>
        ["ce-datacontenttype", "ce-id", "ce-source", "ce-specversion", "ce-subject", "ce-time", "ce-type", "content-type"].includes(name),
      ),
    ),
    body: normalizeVolatile(observation.body),
  };
}

function normalizeVolatile(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeVolatile(item));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
        childKey,
        normalizeVolatile(child, childKey),
      ]),
    );
  }
  if (typeof value === "string") {
    if (["eventId", "id"].includes(key)) {
      return "<event-id>";
    }
    if (["timestamp", "time", "createTime", "updateTime"].includes(key)) {
      return "<timestamp>";
    }
  }
  return value;
}

function decodeContract(
  registrations: readonly RegistrationObservation[],
  normalizedDispatches: readonly DispatchObservation[],
): unknown {
  return {
    schemaVersion: 1,
    registration: registrations.map((registration) => ({
      id: registration.id,
      method: registration.method,
      path: registration.path,
      status: registration.status,
      request: registration.request,
    })),
    dispatch: normalizedDispatches.map((dispatch) => ({
      path: dispatch.path,
      contentType: dispatch.headers["content-type"],
      cloudEventType:
        dispatch.headers["ce-type"] ??
        objectString(dispatch.body, "eventType") ??
        objectString(dispatch.body, "type"),
      body: dispatch.body,
    })),
    invariants: {
      functionsPathTemplate: "/functions/projects/{project}/triggers/{trigger-key}",
      v1UsesLegacyEventEnvelope: true,
      v2UsesCloudEventEnvelope: true,
      functionsHostAcknowledgementStatus: 200,
      unicodeDocumentFieldsPreserved: true,
    },
  };
}

function objectString(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function summarizeDocumentResponse(body: unknown): unknown {
  if (body === null || typeof body !== "object") {
    return body;
  }
  const object = body as Record<string, unknown>;
  return {
    name: object.name,
    fields: object.fields,
    createTime: typeof object.createTime === "string" ? "<timestamp>" : object.createTime,
    updateTime: typeof object.updateTime === "string" ? "<timestamp>" : object.updateTime,
  };
}

function captureHeaders(request: IncomingMessage): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined) {
      result[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
    }
  }
  return result;
}

async function requestJson(
  url: string,
  method: string,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await fetch(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let responseBody: unknown = null;
  if (text.length > 0) {
    try {
      responseBody = JSON.parse(text);
    } catch {
      responseBody = text;
    }
  }
  return { status: response.status, body: responseBody };
}

function relevantLogs(logs: string): readonly string[] {
  return logs
    .split(/\r?\n/u)
    .filter((line) => /trigger|function|eventarc/iu.test(line))
    .map((line) => line.replaceAll(PROJECT_ID, "<project>"))
    .slice(-100);
}

async function waitForDispatches(
  count: number,
  timeoutMilliseconds: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (dispatches.length < count) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        `timed out waiting for ${String(count)} trigger dispatches; observed ${String(dispatches.length)}`,
      );
    }
    await new Promise<void>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        const index = dispatchWaiters.indexOf(resolvePromise);
        if (index >= 0) {
          dispatchWaiters.splice(index, 1);
        }
        reject(new Error("dispatch observation timed out"));
      }, remaining);
      dispatchWaiters.push(() => {
        clearTimeout(timer);
        resolvePromise();
      });
    });
  }
}

async function waitForReady(
  port: number,
  child: ChildProcess,
  timeoutMilliseconds: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `official emulator exited before readiness: code=${String(child.exitCode)} signal=${String(child.signalCode)}`,
      );
    }
    try {
      await fetch(`http://${HOST}:${String(port)}/`, { signal: AbortSignal.timeout(500) });
      return;
    } catch {
      await delay(100);
    }
  }
  throw new Error("official emulator did not become ready");
}

async function reserveAvailablePort(): Promise<number> {
  const server = createTcpServer();
  return await new Promise<number>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("failed to reserve a loopback port"));
        return;
      }
      server.close((error) => {
        if (error === undefined) {
          resolvePromise(address.port);
        } else {
          reject(error);
        }
      });
    });
  });
}

async function listen(server: ReturnType<typeof createServer>, port: number): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, resolvePromise);
  });
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolvePromise();
      } else {
        reject(error);
      }
    });
  });
}

async function stopProcess(child: ChildProcess | undefined): Promise<void> {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise())),
    delay(5_000).then(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }),
  ]);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
