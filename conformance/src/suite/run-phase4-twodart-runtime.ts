import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PHASE4_PROJECT_ID } from "./phase4-gate-plan.ts";

interface Arguments {
  readonly authPort: number;
  readonly cacheWebsocketPort: number;
  readonly firestorePort: number;
  readonly functionsPort: number;
  readonly host: string;
  readonly hubPort: number;
  readonly outputDirectory: string;
  readonly projectId: string;
  readonly pubsubPort: number;
  readonly python: string;
  readonly storagePort: number;
  readonly twodartDirectory: string;
  readonly uiPort: number;
}

interface FunctionTrigger {
  readonly codebase?: string;
  readonly entryPoint?: string;
  readonly eventTrigger?: {
    readonly eventFilterPathPatterns?: { readonly document?: string };
    readonly eventType?: string;
    readonly resource?: string;
    readonly service?: string;
  };
  readonly httpsTrigger?: unknown;
  readonly labels?: Readonly<Record<string, string>>;
  readonly platform?: string;
}

interface Backend {
  readonly functionTriggers?: readonly FunctionTrigger[];
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const conformanceDirectory = resolve(scriptDirectory, "../..");
const arguments_ = parseArguments(process.argv.slice(2));

await mkdir(join(arguments_.outputDirectory, "logs"), { recursive: true });

const functions = await requestJson<{ readonly backends?: readonly Backend[] }>(
  `http://${arguments_.host}:${String(arguments_.functionsPort)}/backends`,
);
const triggers = (functions.backends ?? []).flatMap(
  (backend) => backend.functionTriggers ?? [],
);
const custom = triggers.filter(
  (trigger) => trigger.codebase === "templates-firebase-function",
);
const extensions = triggers.filter(
  (trigger) => trigger.codebase !== "templates-firebase-function",
);
assertFunctionInventory(triggers, custom, extensions);

const hub = await requestJson<Record<string, unknown>>(
  `http://${arguments_.host}:${String(arguments_.hubPort)}/emulators`,
);
for (const service of [
  "auth",
  "firestore",
  "functions",
  "hub",
  "pubsub",
  "storage",
  "ui",
]) {
  if (!(service in hub)) throw new Error(`Hub omitted ${service}`);
}
const ui = await requestJson<Record<string, unknown>>(
  `http://${arguments_.host}:${String(arguments_.uiPort)}/api/config`,
);
if (ui.projectId !== arguments_.projectId) {
  throw new Error(`UI project mismatch: ${String(ui.projectId)}`);
}
const authConfig = await requestJson<Record<string, unknown>>(
  `http://${arguments_.host}:${String(arguments_.authPort)}/emulator/v1/projects/${arguments_.projectId}/config`,
);
const topics = await requestJson<{ readonly topics?: readonly { readonly name?: string }[] }>(
  `http://${arguments_.host}:${String(arguments_.pubsubPort)}/v1/projects/${arguments_.projectId}/topics`,
);
const topicNames = (topics.topics ?? []).map((topic) => topic.name).sort();
const expectedTopics = [
  `projects/${arguments_.projectId}/topics/firebase-schedule-onRunCronBackupAuth`,
  `projects/${arguments_.projectId}/topics/firebase-schedule-onRunCronResetCredits`,
];
if (JSON.stringify(topicNames) !== JSON.stringify(expectedTopics)) {
  throw new Error(`schedule topic inventory diverged: ${JSON.stringify(topicNames)}`);
}

const commonSdkArguments = [
  "--auth-host",
  `${arguments_.host}:${String(arguments_.authPort)}`,
  "--firestore-host",
  `${arguments_.host}:${String(arguments_.firestorePort)}`,
  "--storage-host",
  `${arguments_.host}:${String(arguments_.storagePort)}`,
  "--project-id",
  arguments_.projectId,
];
const commands = [];
commands.push(
  await runCommand(
    "node-admin",
    process.execPath,
    [
      "--import",
      "tsx",
      join(scriptDirectory, "run-phase4-node-admin.ts"),
      ...commonSdkArguments,
      "--twodart-dir",
      arguments_.twodartDirectory,
      "--output",
      join(arguments_.outputDirectory, "node-admin.json"),
    ],
  ),
);
commands.push(
  await runCommand(
    "browser",
    process.execPath,
    [
      "--import",
      "tsx",
      join(scriptDirectory, "run-phase4-browser.ts"),
      "--auth-port",
      String(arguments_.authPort),
      "--firestore-port",
      String(arguments_.firestorePort),
      "--functions-port",
      String(arguments_.functionsPort),
      "--host",
      arguments_.host,
      "--output",
      join(arguments_.outputDirectory, "browser.json"),
      "--project-id",
      arguments_.projectId,
      "--storage-port",
      String(arguments_.storagePort),
      "--twodart-dir",
      arguments_.twodartDirectory,
    ],
  ),
);
commands.push(
  await runCommand(
    "python-admin",
    arguments_.python,
    [
      join(scriptDirectory, "run_phase4_python_admin.py"),
      ...commonSdkArguments,
      "--output",
      join(arguments_.outputDirectory, "python-admin.json"),
    ],
  ),
);
commands.push(
  await runCommand(
    "dotnet-admin",
    "dotnet",
    [
      "run",
      "--project",
      join(conformanceDirectory, "support", "phase4-dotnet", "Phase4DotnetGate.csproj"),
      "--",
      ...commonSdkArguments,
      "--output",
      join(arguments_.outputDirectory, "dotnet-admin.json"),
    ],
  ),
);
for (const command of commands) {
  if (command.exitCode !== 0) throw new Error(`${command.name} failed; see ${command.log}`);
}

const cacheWatcher = await runCacheWatcher(arguments_);
await exerciseCustomTriggers(arguments_);
const schedules = [];
for (const topic of expectedTopics) {
  const name = topic.slice(topic.lastIndexOf("/") + 1);
  const started = performance.now();
  const response = await fetch(
    `http://${arguments_.host}:${String(arguments_.pubsubPort)}/v1/projects/${arguments_.projectId}/topics/${name}:publish`,
    {
      body: JSON.stringify({ messages: [{ data: Buffer.from("{}").toString("base64") }] }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  if (!response.ok) throw new Error(`schedule publish ${name} returned ${String(response.status)}`);
  schedules.push({ latencyMilliseconds: performance.now() - started, topic });
}

await assertSdkThresholds(arguments_.outputDirectory);
const evidence = {
  authConfigPresent: Object.keys(authConfig).length > 0,
  cacheWatcher,
  commands,
  functions: {
    custom: custom.map(summary),
    extensions: extensions.map(summary),
    total: triggers.length,
  },
  hubServices: Object.keys(hub).sort(),
  passed: true,
  projectId: arguments_.projectId,
  schedules,
  schemaVersion: 1,
  topics: topicNames,
  uiProjectId: ui.projectId,
};
await writeFile(
  join(arguments_.outputDirectory, "runtime.json"),
  `${JSON.stringify(evidence, null, 2)}\n`,
);

function assertFunctionInventory(
  triggers: readonly FunctionTrigger[],
  custom: readonly FunctionTrigger[],
  extensions: readonly FunctionTrigger[],
): void {
  if (triggers.length !== 21 || custom.length !== 11 || extensions.length !== 10) {
    throw new Error(
      `function inventory mismatch: ${String(triggers.length)}/${String(custom.length)}/${String(extensions.length)}`,
    );
  }
  const customNames = custom.map((trigger) => trigger.entryPoint).sort();
  const expectedCustom = [
    "onDeleteUserFontDoc",
    "onGetProratedInvoice",
    "onReceiveStripeWebhook",
    "onRunCronBackupAuth",
    "onRunCronResetCredits",
    "onUpdateInvitedLicenseUserDoc",
    "onUpdateStripeSubscription",
    "onUpdateUserDoc",
    "onWriteInitiateCheckoutSession",
    "onWriteLicenseDoc",
    "onWriteSubscriptionDoc",
  ];
  if (JSON.stringify(customNames) !== JSON.stringify(expectedCustom)) {
    throw new Error(`custom function inventory diverged: ${JSON.stringify(customNames)}`);
  }
  const firestore = custom.filter((trigger) =>
    trigger.eventTrigger?.eventType?.includes("firestore.document"),
  );
  const schedules = custom.filter((trigger) => trigger.eventTrigger?.eventType === "pubsub");
  const callables = custom.filter(
    (trigger) => trigger.httpsTrigger !== undefined && trigger.labels?.["deployment-callable"] === "true",
  );
  const http = custom.filter(
    (trigger) => trigger.httpsTrigger !== undefined && trigger.labels?.["deployment-callable"] !== "true",
  );
  if (firestore.length !== 6 || schedules.length !== 2 || callables.length !== 2 || http.length !== 1) {
    throw new Error("custom function category counts diverged");
  }
  const extensionNames = extensions.map((trigger) => trigger.entryPoint);
  const counts = new Map<string, number>();
  for (const name of extensionNames) counts.set(name ?? "", (counts.get(name ?? "") ?? 0) + 1);
  if (
    extensions.filter((trigger) => ["createCustomer", "createCheckoutSession", "createPortalLink", "handleWebhookEvents", "onUserDeleted", "onCustomerDataDeleted"].includes(trigger.entryPoint ?? "")).length !== 6 ||
    counts.get("executeIndexOperation") !== 2 ||
    counts.get("executeFullIndexOperation") !== 2
  ) {
    throw new Error(`extension inventory diverged: ${JSON.stringify(extensionNames)}`);
  }
}

async function runCacheWatcher(arguments_: Arguments): Promise<Record<string, unknown>> {
  const log = join(arguments_.outputDirectory, "logs", "cache-watcher.log");
  const stream = createWriteStream(log, { flags: "wx" });
  const env = {
    ...process.env,
    FIREBASE_AUTH_EMULATOR_HOST: `${arguments_.host}:${String(arguments_.authPort)}`,
    FIREBASE_EMULATOR_AUTH_HOST: arguments_.host,
    FIREBASE_EMULATOR_AUTH_PORT: String(arguments_.authPort),
    FIREBASE_EMULATOR_FIRESTORE_HOST: arguments_.host,
    FIREBASE_EMULATOR_FIRESTORE_PORT: String(arguments_.firestorePort),
    FIREBASE_EMULATOR_STORAGE_HOST: arguments_.host,
    FIREBASE_EMULATOR_STORAGE_PORT: String(arguments_.storagePort),
    FIRESTORE_EMULATOR_HOST: `${arguments_.host}:${String(arguments_.firestorePort)}`,
    STORAGE_EMULATOR_HOST: `http://${arguments_.host}:${String(arguments_.storagePort)}`,
    WEBSOCKET_PORT: String(arguments_.cacheWebsocketPort),
  };
  const child = spawn(
    "bunx",
    ["tsx", "apps/templates/scripts/watch-firestore-cache.ts"],
    { cwd: arguments_.twodartDirectory, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    stream.write(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    stream.write(chunk);
  });
  try {
    await waitFor(() => output.includes("Smart watcher started successfully"), child, 60_000);
  } finally {
    child.kill("SIGTERM");
  }
  const result = await waitForExit(child, 15_000);
  stream.end();
  if (result.exitCode !== 0) throw new Error(`cache watcher did not stop cleanly; see ${log}`);
  return { exitCode: result.exitCode, log, ready: true };
}

async function exerciseCustomTriggers(arguments_: Arguments): Promise<void> {
  const base = `http://${arguments_.host}:${String(arguments_.firestorePort)}/v1/projects/${arguments_.projectId}/databases/(default)/documents`;
  const id = `phase4-runtime-${Date.now()}`;
  await authCreate(arguments_, id);
  const writes: readonly [string, Record<string, unknown>][] = [
    [`users/${id}`, { gate: 4 }],
    [`licenses/${id}`, { gate: 4 }],
    [`licenses/${id}/invitedUsers/invite`, { gate: 4 }],
    [`licenses/${id}/checkout_sessions/session`, { gate: 4 }],
    [`licenses/${id}/subscriptions/subscription`, { gate: 4 }],
    [`userFonts/${id}`, { fullName: "Phase 4 火🔥", id }],
  ];
  for (const [path, fields] of writes) {
    const response = await fetch(`${base}/${path}`, {
      body: JSON.stringify({ fields: encodeFields(fields) }),
      headers: { Authorization: "Bearer owner", "content-type": "application/json" },
      method: "PATCH",
    });
    if (!response.ok) throw new Error(`trigger write ${path} returned ${String(response.status)}`);
  }
  const deletion = await fetch(`${base}/userFonts/${id}`, {
    headers: { Authorization: "Bearer owner" },
    method: "DELETE",
  });
  if (!deletion.ok) throw new Error(`font trigger deletion returned ${String(deletion.status)}`);
}

async function authCreate(arguments_: Arguments, uid: string): Promise<void> {
  const response = await fetch(
    `http://${arguments_.host}:${String(arguments_.authPort)}/identitytoolkit.googleapis.com/v1/projects/${arguments_.projectId}/accounts`,
    {
      body: JSON.stringify({ email: `${uid}@example.test`, localId: uid }),
      headers: { Authorization: "Bearer owner", "content-type": "application/json" },
      method: "POST",
    },
  );
  if (!response.ok) throw new Error(`trigger Auth seed returned ${String(response.status)}`);
}

function encodeFields(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      typeof value === "number" ? { integerValue: String(value) } : { stringValue: String(value) },
    ]),
  );
}

async function assertSdkThresholds(outputDirectory: string): Promise<void> {
  for (const name of ["node-admin", "python-admin", "dotnet-admin"]) {
    const evidence = JSON.parse(await readFile(join(outputDirectory, `${name}.json`), "utf8")) as {
      readonly auth?: { readonly p99Milliseconds?: number };
      readonly passed?: boolean;
      readonly storage?: { readonly operations?: { readonly p99Milliseconds?: number } };
    };
    if (evidence.passed !== true || (evidence.auth?.p99Milliseconds ?? Infinity) >= 500) {
      throw new Error(`${name} Auth p99 failed the frozen threshold`);
    }
    if ((evidence.storage?.operations?.p99Milliseconds ?? 0) >= 1_000) {
      throw new Error(`${name} Storage p99 failed the frozen threshold`);
    }
  }
}

async function requestJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${String(response.status)}`);
  return (await response.json()) as T;
}

async function runCommand(name: string, command: string, values: readonly string[]) {
  const log = join(arguments_.outputDirectory, "logs", `${name}.log`);
  const stream = createWriteStream(log, { flags: "wx" });
  const started = performance.now();
  const child = spawn(command, values, {
    cwd: conformanceDirectory,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.pipe(stream, { end: false });
  child.stderr?.pipe(stream, { end: false });
  const result = await waitForExit(child, 180_000);
  stream.end();
  return {
    durationMilliseconds: performance.now() - started,
    exitCode: result.exitCode,
    log,
    name,
    signal: result.signal,
  };
}

async function waitFor(
  predicate: () => boolean,
  child: ReturnType<typeof spawn>,
  timeoutMilliseconds: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!predicate()) {
    if (child.exitCode !== null) throw new Error(`process exited before readiness: ${String(child.exitCode)}`);
    if (Date.now() >= deadline) throw new Error("process readiness timed out");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
}

async function waitForExit(child: ReturnType<typeof spawn>, timeoutMilliseconds: number) {
  return await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("process exit timed out"));
    }, timeoutMilliseconds);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (exitCode, signal) => {
      clearTimeout(timer);
      resolvePromise({ exitCode, signal });
    });
  });
}

function summary(trigger: FunctionTrigger): Record<string, unknown> {
  return {
    codebase: trigger.codebase ?? null,
    entryPoint: trigger.entryPoint ?? null,
    eventType: trigger.eventTrigger?.eventType ?? null,
    path: trigger.eventTrigger?.eventFilterPathPatterns?.document ?? trigger.eventTrigger?.resource ?? null,
    platform: trigger.platform ?? null,
  };
}

function parseArguments(values: readonly string[]): Arguments {
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (key === undefined || value === undefined || !key.startsWith("--")) {
      throw new Error("Phase 4 runtime arguments must be --key value pairs");
    }
    parsed.set(key.slice(2), value);
  }
  const required = (key: string): string => {
    const value = parsed.get(key);
    if (value === undefined || value.length === 0) throw new Error(`--${key} is required`);
    return value;
  };
  const port = (key: string): number => {
    const value = Number(required(key));
    if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error(`--${key} must be a TCP port`);
    return value;
  };
  const projectId = required("project-id");
  if (projectId !== PHASE4_PROJECT_ID) throw new Error(`Phase 4 project must be ${PHASE4_PROJECT_ID}`);
  return {
    authPort: port("auth-port"),
    cacheWebsocketPort: port("cache-websocket-port"),
    firestorePort: port("firestore-port"),
    functionsPort: port("functions-port"),
    host: required("host"),
    hubPort: port("hub-port"),
    outputDirectory: resolve(required("output-dir")),
    projectId,
    pubsubPort: port("pubsub-port"),
    python: resolve(required("python")),
    storagePort: port("storage-port"),
    twodartDirectory: resolve(required("twodart-dir")),
    uiPort: port("ui-port"),
  };
}
