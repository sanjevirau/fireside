import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer as createTcpServer, Socket } from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOST = "127.0.0.1";
const PROJECT_ID = "demo-fireside-phase4-suite-oracle";
const FIREBASE_TOOLS_VERSION = "15.22.0";
const FIREBASE_FUNCTIONS_VERSION = "7.2.5";
const FIREBASE_ADMIN_VERSION = "13.10.0";
const PUBSUB_BINARY_SHA256 =
  "fbfb3143e5360e744ad2cbd283936be262d27c5dbc26573b0777850c3bc13b57";
const PUBSUB_JAR_SHA256 =
  "4b2892ba1559028a959a8522f114147949b3d6e0cd90dd3c46f40e148410e56d";
const UI_ZIP_SHA256 =
  "97d8c4c574e3f20c4d690a2ce8373eef76ab024da73279a062dba8517f88cf9a";
const ALGOLIA_YAML_SHA256 =
  "b2f879ca0a6f6bad2b8b0386c34988788df3e2b16b73a02cf52033122b97c77b";
const STRIPE_YAML_SHA256 =
  "d7b2e7d51bbb7269b76bde899347333da90b5113de01cd69a1a8705ea8e310c8";
const fixtureBase = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../fixtures/firebase-suite-v1",
);

interface Observation {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly responseHeaders: Readonly<Record<string, string>>;
  readonly response: unknown;
}

interface SuitePorts {
  readonly auth: number;
  readonly eventarc: number;
  readonly functions: number;
  readonly hub: number;
  readonly logging: number;
  readonly pubsub: number;
  readonly tasks: number;
  readonly ui: number;
}

interface SuiteProcess {
  readonly process: ChildProcess;
  readonly logs: string[];
  readonly startedAt: number;
}

const packageRoot = requireEnv("FIREBASE_TOOLS_15_22_ROOT");
const functionsRoot = requireEnv("FIREBASE_FUNCTIONS_7_2_ROOT");
const twodartFirebaseRoot = requireEnv("TWODART_FIREBASE_ROOT");
const node24 = requireEnv("NODE24");
const firebaseCache = join(process.env.HOME ?? "", ".cache/firebase");

const packageJson = JSON.parse(
  await readFile(join(packageRoot, "package.json"), "utf8"),
) as { readonly name: string; readonly version: string };
if (packageJson.name !== "firebase-tools" || packageJson.version !== FIREBASE_TOOLS_VERSION) {
  throw new Error(`expected firebase-tools ${FIREBASE_TOOLS_VERSION}`);
}
const functionsPackage = JSON.parse(
  await readFile(join(functionsRoot, "package.json"), "utf8"),
) as { readonly name: string; readonly version: string };
if (
  functionsPackage.name !== "firebase-functions" ||
  functionsPackage.version !== FIREBASE_FUNCTIONS_VERSION
) {
  throw new Error(`expected firebase-functions ${FIREBASE_FUNCTIONS_VERSION}`);
}

const pubsubBinary = join(
  firebaseCache,
  "emulators/pubsub-emulator-0.8.33/pubsub-emulator/bin/cloud-pubsub-emulator",
);
const pubsubJar = join(
  firebaseCache,
  "emulators/pubsub-emulator-0.8.33/pubsub-emulator/lib/cloud-pubsub-emulator-0.8.33-all.jar",
);
const uiZip = join(firebaseCache, "emulators/ui-v1.15.0.zip");
assertHash(await readFile(pubsubBinary), PUBSUB_BINARY_SHA256, "Pub/Sub launcher");
assertHash(await readFile(pubsubJar), PUBSUB_JAR_SHA256, "Pub/Sub emulator jar");
assertHash(await readFile(uiZip), UI_ZIP_SHA256, "Emulator UI archive");

const originalTmpdir = process.env.TMPDIR;
const suiteRoot = await mkdtemp(
  join(originalTmpdir ?? "/tmp", "fireside-phase4-suite-oracle-"),
);
const shortTmpRoot = await mkdtemp("/tmp/fsp4-");
process.env.TMPDIR = shortTmpRoot;

const ports: SuitePorts = {
  auth: await reserveAvailablePort(),
  eventarc: await reserveAvailablePort(),
  functions: await reserveAvailablePort(),
  hub: await reserveAvailablePort(),
  logging: await reserveAvailablePort(),
  pubsub: await reserveAvailablePort(),
  tasks: await reserveAvailablePort(),
  ui: await reserveAvailablePort(),
};
const eventsPath = join(suiteRoot, "function-events.jsonl");
const firebaseJsonPath = join(suiteRoot, "firebase.json");
const functionsDir = join(suiteRoot, "functions");
const exportPath = join(suiteRoot, "hub-export");
await writeSyntheticProject(functionsDir, firebaseJsonPath, functionsRoot, ports, eventsPath);

const sourceHashes = await hashOracleSources(packageRoot);
let active: SuiteProcess | undefined;

try {
  active = startSuite(suiteRoot, firebaseJsonPath, packageRoot, node24, eventsPath);
  const firstReadiness = await waitForSuite(active, ports, 60_000);
  let functionsCapture: Awaited<ReturnType<typeof captureFunctions>>;
  let pubsubCapture: Awaited<ReturnType<typeof capturePubsubAndSchedules>>;
  let hubCapture: Awaited<ReturnType<typeof captureHub>>;
  let uiCapture: Awaited<ReturnType<typeof captureUiAndLogging>>;
  try {
    functionsCapture = await captureFunctions(ports);
    pubsubCapture = await capturePubsubAndSchedules(ports, eventsPath);
    hubCapture = await captureHub(ports, exportPath);
    uiCapture = await captureUiAndLogging(ports, packageRoot);
  } catch (error) {
    const debugLogs = await readDebugLogs(suiteRoot);
    throw new Error(
      `suite capture failed: ${String(error)}\n${active.logs.join("")}\n${debugLogs}`,
      { cause: error },
    );
  }
  const locatorPath = join(process.env.TMPDIR, `hub-${PROJECT_ID}.json`);
  const locatorBeforeStop = JSON.parse(await readFile(locatorPath, "utf8")) as unknown;

  const firstStop = await stopSuite(active, ports, locatorPath);
  active = undefined;
  const restart = startSuite(suiteRoot, firebaseJsonPath, packageRoot, node24, eventsPath);
  active = restart;
  const restartReadiness = await waitForSuite(restart, ports, 60_000);
  const restartHub = await observeJson(
    `http://${HOST}:${String(ports.hub)}`,
    "restart-hub-readiness",
    "GET",
    "/",
  );
  const secondStop = await stopSuite(restart, ports, locatorPath);
  active = undefined;
  if (
    firstStop.exitCode !== 2 ||
    !firstStop.locatorDeleted ||
    !firstStop.portsClosed ||
    !secondStop.clean ||
    !secondStop.locatorDeleted ||
    !secondStop.portsClosed
  ) {
    throw new Error(
      `unexpected official lifecycle outcome: ${JSON.stringify({ firstStop, secondStop })}`,
    );
  }

  const extensionInventory = await captureExtensionInventory(
    twodartFirebaseRoot,
    firebaseCache,
  );
  const portMap = new Map<number, string>(
    Object.entries(ports).map(([name, port]) => [port, `<${name}-port>`]),
  );

  await writeFixture("functions-callable-http-and-error-contract", {
    schemaVersion: 1,
    target: "official-firebase-tools-functions-emulator",
    targetVersion: FIREBASE_TOOLS_VERSION,
    firebaseFunctionsVersion: FIREBASE_FUNCTIONS_VERSION,
    firebaseAdminVersion: FIREBASE_ADMIN_VERSION,
    targetProject: PROJECT_ID,
    capturedAt: new Date().toISOString(),
    credentialsStored: false,
    accessTokensStored: false,
    realUserDataStored: false,
    sourceHashes,
    observations: normalize(functionsCapture.observations, suiteRoot, portMap),
    backendInventory: normalize(functionsCapture.backends, suiteRoot, portMap),
    invariants: functionsCapture.invariants,
  });
  await writeFixture("pubsub-schedule-and-function-dispatch", {
    schemaVersion: 1,
    target: "official-pubsub-and-functions-emulators",
    targetVersion: "pubsub-0.8.33/functions-15.22.0",
    targetProject: PROJECT_ID,
    capturedAt: new Date().toISOString(),
    credentialsStored: false,
    accessTokensStored: false,
    realUserDataStored: false,
    sourceHashes,
    pubsubBinarySha256: PUBSUB_BINARY_SHA256,
    pubsubJarSha256: PUBSUB_JAR_SHA256,
    observations: normalize(pubsubCapture.observations, suiteRoot, portMap),
    deliveredEvents: normalize(pubsubCapture.deliveredEvents, suiteRoot, portMap),
    invariants: pubsubCapture.invariants,
  });
  await writeFixture("hub-locator-export-and-background-controls", {
    schemaVersion: 1,
    target: "official-firebase-tools-emulator-hub",
    targetVersion: FIREBASE_TOOLS_VERSION,
    targetProject: PROJECT_ID,
    capturedAt: new Date().toISOString(),
    credentialsStored: false,
    accessTokensStored: false,
    realUserDataStored: false,
    sourceHashes,
    locatorBeforeStop: normalize(locatorBeforeStop, suiteRoot, portMap),
    observations: normalize(hubCapture.observations, suiteRoot, portMap),
    exportInventory: normalize(hubCapture.exportInventory, suiteRoot, portMap),
    invariants: hubCapture.invariants,
  });
  await writeFixture("ui-config-logging-and-websocket", {
    schemaVersion: 1,
    target: "official-firebase-tools-emulator-ui-and-logging",
    targetVersion: `${FIREBASE_TOOLS_VERSION}/ui-1.15.0`,
    targetProject: PROJECT_ID,
    capturedAt: new Date().toISOString(),
    credentialsStored: false,
    accessTokensStored: false,
    realUserDataStored: false,
    sourceHashes,
    uiArchiveSha256: UI_ZIP_SHA256,
    observations: normalize(uiCapture.observations, suiteRoot, portMap),
    websocketMessages: normalize(uiCapture.websocketMessages, suiteRoot, portMap),
    invariants: uiCapture.invariants,
  });
  await writeFixture("suite-startup-readiness-shutdown-and-restart", {
    schemaVersion: 1,
    target: "official-firebase-tools-emulator-suite",
    targetVersion: FIREBASE_TOOLS_VERSION,
    targetProject: PROJECT_ID,
    capturedAt: new Date().toISOString(),
    credentialsStored: false,
    accessTokensStored: false,
    realUserDataStored: false,
    sourceHashes,
    firstReadiness: normalize(firstReadiness, suiteRoot, portMap),
    firstStop,
    restartReadiness: normalize(restartReadiness, suiteRoot, portMap),
    restartHub: normalize(restartHub, suiteRoot, portMap),
    secondStop,
    relevantLogLines: normalizeLogLines(
      [...activeLogs(firstReadiness), ...activeLogs(restartReadiness)],
      suiteRoot,
      portMap,
    ),
    invariants: {
      exactFirebaseToolsVersion: FIREBASE_TOOLS_VERSION,
      services: [
        "auth",
        "eventarc",
        "functions",
        "hub",
        "logging",
        "pubsub",
        "tasks",
        "ui",
      ],
      firstStartReady: true,
      originGuardedRunExitedCleanly: firstStop.clean,
      originGuardFallthroughObservedInOfficialSuite: !firstStop.clean,
      locatorDeletedAfterFirstStop: firstStop.locatorDeleted,
      firstStopPortsClosed: firstStop.portsClosed,
      samePortRestartReady: true,
      cleanControlRestartStop: secondStop.clean,
      locatorDeletedAfterSecondStop: secondStop.locatorDeleted,
      secondStopPortsClosed: secondStop.portsClosed,
    },
  });
  await writeFixture("extensions-stripe-and-algolia-trigger-inventory", {
    schemaVersion: 1,
    target: "pinned-official-extension-sources-and-twodart-config",
    targetVersion: FIREBASE_TOOLS_VERSION,
    targetProject: "demo-twodart-local",
    capturedAt: new Date().toISOString(),
    credentialsStored: false,
    accessTokensStored: false,
    realUserDataStored: false,
    sourceHashes,
    inventory: extensionInventory,
    invariants: {
      instanceCount: 3,
      stripeInstanceCount: 1,
      algoliaInstanceCount: 2,
      secretFilesRead: false,
      envFileContentsRead: false,
      triggerInventoryDerivedFromPinnedExtensionYaml: true,
    },
  });
} finally {
  if (active) await forceStop(active.process);
  if (originalTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdir;
  await rm(suiteRoot, { recursive: true, force: true });
  await rm(shortTmpRoot, { recursive: true, force: true });
}

async function writeSyntheticProject(
  outputDir: string,
  firebaseJson: string,
  sdkRoot: string,
  suitePorts: SuitePorts,
  capturePath: string,
): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    join(outputDir, "package.json"),
    `${JSON.stringify(
      {
        name: "fireside-phase4-suite-oracle-functions",
        version: "0.0.0",
        private: true,
        main: "index.js",
        engines: { node: "24" },
        dependencies: {
          "firebase-admin": FIREBASE_ADMIN_VERSION,
          "firebase-functions": FIREBASE_FUNCTIONS_VERSION,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await mkdir(join(outputDir, "node_modules"), { recursive: true });
  await symlink(
    sdkRoot,
    join(outputDir, "node_modules/firebase-functions"),
    "dir",
  );
  await symlink(
    join(dirname(sdkRoot), "firebase-admin"),
    join(outputDir, "node_modules/firebase-admin"),
    "dir",
  );
  const source = `
const fs = require("node:fs");
const { onCall, onRequest, HttpsError } = require(${JSON.stringify(join(sdkRoot, "lib/v2/providers/https.js"))});
const { onSchedule } = require(${JSON.stringify(join(sdkRoot, "lib/v2/providers/scheduler.js"))});
const { onMessagePublished } = require(${JSON.stringify(join(sdkRoot, "lib/v2/providers/pubsub.js"))});
const capturePath = ${JSON.stringify(capturePath)};
function record(value) {
  fs.appendFileSync(capturePath, JSON.stringify(value) + "\\n", "utf8");
}
exports.httpEcho = onRequest((request, response) => {
  response.status(200).json({
    method: request.method,
    query: request.query,
    body: request.body,
    unicode: "火🔥",
  });
});
exports.callableEcho = onCall((request) => {
  if (request.data && request.data.fail === true) {
    throw new HttpsError("invalid-argument", "phase4 invalid", { unicode: "火🔥" });
  }
  return { echo: request.data, authUid: request.auth ? request.auth.uid : null, unicode: "火🔥" };
});
exports.scheduledTick = onSchedule("every 5 minutes", (event) => {
  record({ kind: "schedule", id: event.id, time: event.time, data: event.data || null });
});
exports.topicEcho = onMessagePublished("phase4-topic", (event) => {
  const message = event.data && event.data.message;
  record({
    kind: "topic",
    id: event.id,
    time: event.time,
    data: message && message.data ? Buffer.from(message.data, "base64").toString("utf8") : null,
    attributes: message ? message.attributes || {} : {},
  });
});
`;
  await writeFile(join(outputDir, "index.js"), source.trimStart(), "utf8");
  await writeFile(
    firebaseJson,
    `${JSON.stringify(
      {
        functions: [{ source: "functions", codebase: "phase4-oracle" }],
        emulators: {
          auth: { host: HOST, port: suitePorts.auth },
          eventarc: { host: HOST, port: suitePorts.eventarc },
          functions: { host: HOST, port: suitePorts.functions },
          hub: { host: HOST, port: suitePorts.hub },
          logging: { host: HOST, port: suitePorts.logging },
          pubsub: { host: HOST, port: suitePorts.pubsub },
          tasks: { host: HOST, port: suitePorts.tasks },
          ui: { enabled: true, host: HOST, port: suitePorts.ui },
          singleProjectMode: true,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function startSuite(
  cwd: string,
  config: string,
  toolsRoot: string,
  nodePath: string,
  capturePath: string,
): SuiteProcess {
  const logs: string[] = [];
  const child = spawn(
    nodePath,
    [
      join(toolsRoot, "lib/bin/firebase.js"),
      "emulators:start",
      "--project",
      PROJECT_ID,
      "--config",
      config,
      "--only",
      "auth,functions,pubsub",
      "--non-interactive",
    ],
    {
      cwd,
      env: {
        ...process.env,
        CI: "1",
        FIREBASE_CLI_PREVIEWS: "",
        PHASE4_CAPTURE_EVENTS: capturePath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", (chunk: Buffer) => logs.push(chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => logs.push(chunk.toString("utf8")));
  return { process: child, logs, startedAt: Date.now() };
}

async function waitForSuite(
  suite: SuiteProcess,
  suitePorts: SuitePorts,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (suite.process.exitCode !== null) {
      throw new Error(
        `official suite exited ${String(suite.process.exitCode)}:\n${suite.logs.join("")}`,
      );
    }
    try {
      const [hub, backends, auth, pubsub, ui] = await Promise.all([
        fetch(`http://${HOST}:${String(suitePorts.hub)}/`),
        fetch(`http://${HOST}:${String(suitePorts.functions)}/backends`),
        fetch(`http://${HOST}:${String(suitePorts.auth)}/`),
        fetch(`http://${HOST}:${String(suitePorts.pubsub)}/v1/projects/${PROJECT_ID}/topics`),
        fetch(`http://${HOST}:${String(suitePorts.ui)}/api/config`),
      ]);
      const backendBody = await backends.json() as { readonly backends?: readonly unknown[] };
      const functionTriggerCount = (backendBody.backends ?? []).reduce<number>(
        (count, backend) => {
          const functionTriggers = asRecord(backend).functionTriggers;
          return count + (Array.isArray(functionTriggers) ? functionTriggers.length : 0);
        },
        0,
      );
      if (
        hub.ok &&
        backends.ok &&
        auth.ok &&
        pubsub.ok &&
        ui.ok &&
        functionTriggerCount >= 4
      ) {
        return {
          readyAfterMilliseconds: Date.now() - suite.startedAt,
          statuses: {
            hub: hub.status,
            functions: backends.status,
            auth: auth.status,
            pubsub: pubsub.status,
            ui: ui.status,
          },
          backendCount: backendBody.backends?.length,
          functionTriggerCount,
          logLines: relevantLogs(suite.logs.join("")),
        };
      }
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(
    `official suite not ready: ${String(lastError)}\n${suite.logs.join("")}`,
  );
}

async function captureFunctions(suitePorts: SuitePorts): Promise<{
  readonly observations: readonly Observation[];
  readonly backends: unknown;
  readonly invariants: Readonly<Record<string, unknown>>;
}> {
  const base = `http://${HOST}:${String(suitePorts.functions)}`;
  const observations: Observation[] = [];
  const backendResult = await requestJson(base, "GET", "/backends");
  observations.push(toObservation("functions-backends", "GET", "/backends", backendResult));
  const backends = asRecord(backendResult.body).backends;

  observations.push(
    toObservation(
      "http-function-get",
      "GET",
      `/${PROJECT_ID}/us-central1/httpEcho?mode=get`,
      await requestJson(
        base,
        "GET",
        `/${PROJECT_ID}/us-central1/httpEcho?mode=get`,
      ),
    ),
  );
  observations.push(
    toObservation(
      "http-function-post",
      "POST",
      `/${PROJECT_ID}/us-central1/httpEcho`,
      await requestJson(
        base,
        "POST",
        `/${PROJECT_ID}/us-central1/httpEcho`,
        { unicode: "火🔥", nested: { n: 4 } },
      ),
    ),
  );
  observations.push(
    toObservation(
      "callable-success",
      "POST",
      `/${PROJECT_ID}/us-central1/callableEcho`,
      await requestJson(
        base,
        "POST",
        `/${PROJECT_ID}/us-central1/callableEcho`,
        { data: { unicode: "火🔥", n: 4 } },
      ),
    ),
  );
  observations.push(
    toObservation(
      "callable-typed-error",
      "POST",
      `/${PROJECT_ID}/us-central1/callableEcho`,
      await requestJson(
        base,
        "POST",
        `/${PROJECT_ID}/us-central1/callableEcho`,
        { data: { fail: true } },
      ),
    ),
  );
  observations.push(
    toObservation(
      "callable-invalid-get",
      "GET",
      `/${PROJECT_ID}/us-central1/callableEcho`,
      await requestJson(
        base,
        "GET",
        `/${PROJECT_ID}/us-central1/callableEcho`,
      ),
    ),
  );
  observations.push(
    toObservation(
      "unknown-function",
      "POST",
      `/${PROJECT_ID}/us-central1/missingFunction`,
      await requestJson(
        base,
        "POST",
        `/${PROJECT_ID}/us-central1/missingFunction`,
        { data: {} },
      ),
    ),
  );

  assertObservationStatus(observations, "functions-backends", 200);
  assertObservationStatus(observations, "http-function-get", 200);
  assertObservationStatus(observations, "http-function-post", 200);
  assertObservationStatus(observations, "callable-success", 200);
  assertObservationStatus(observations, "callable-typed-error", 400);
  assertObservationStatus(observations, "callable-invalid-get", 400);
  assertObservationStatus(observations, "unknown-function", 404);

  const functionIds = Array.isArray(backends)
    ? backends
        .flatMap((backend) => {
          const functionTriggers = asRecord(backend).functionTriggers;
          return Array.isArray(functionTriggers) ? functionTriggers : [];
        })
        .map((trigger) => asRecord(trigger).id)
        .filter((id): id is string => typeof id === "string")
        .sort()
    : [];

  return {
    observations,
    backends,
    invariants: {
      discoveredFunctionCount: Array.isArray(backends) ? backends.length : 0,
      functionIds,
      validCallableUsesResultEnvelope: true,
      typedCallableErrorUsesErrorEnvelope: true,
      unknownFunctionStatus: observationStatus(observations, "unknown-function"),
    },
  };
}

async function capturePubsubAndSchedules(
  suitePorts: SuitePorts,
  capturePath: string,
): Promise<{
  readonly observations: readonly Observation[];
  readonly deliveredEvents: readonly unknown[];
  readonly invariants: Readonly<Record<string, unknown>>;
}> {
  const pubsub = `http://${HOST}:${String(suitePorts.pubsub)}`;
  const hub = `http://${HOST}:${String(suitePorts.hub)}`;
  const functions = `http://${HOST}:${String(suitePorts.functions)}`;
  const observations: Observation[] = [];
  const topics = await requestJson(
    pubsub,
    "GET",
    `/v1/projects/${PROJECT_ID}/topics`,
  );
  observations.push(
    toObservation(
      "list-function-topics",
      "GET",
      `/v1/projects/${PROJECT_ID}/topics`,
      topics,
    ),
  );
  const topicNames = extractTopicNames(topics.body);
  const scheduleTopic = topicNames.find((name) => name.includes("firebase-schedule-scheduledTick"));
  const customTopic = topicNames.find((name) => name.endsWith("/topics/phase4-topic"));
  if (!scheduleTopic || !customTopic) {
    throw new Error(`missing expected topics: ${JSON.stringify(topicNames)}`);
  }

  observations.push(
    toObservation(
      "publish-custom-topic",
      "POST",
      `/v1/${customTopic}:publish`,
      await requestJson(pubsub, "POST", `/v1/${customTopic}:publish`, {
        messages: [
          {
            data: Buffer.from("topic 火🔥", "utf8").toString("base64"),
            attributes: { oracle: "phase4" },
          },
        ],
      }),
    ),
  );
  observations.push(
    toObservation(
      "publish-schedule-topic",
      "POST",
      `/v1/${scheduleTopic}:publish`,
      await requestJson(pubsub, "POST", `/v1/${scheduleTopic}:publish`, {
        messages: [{ data: Buffer.from("{}", "utf8").toString("base64") }],
      }),
    ),
  );
  await waitForEventCount(capturePath, 1, 20_000);
  await delay(250);
  const afterTopicPublications = await readEvents(capturePath);

  const directSchedulePath =
    `/functions/projects/${PROJECT_ID}/triggers/us-central1-scheduledTick-0`;
  observations.push(
    toObservation(
      "invoke-schedule-cloudevent-directly",
      "POST",
      directSchedulePath,
      await requestJson(
        functions,
        "POST",
        directSchedulePath,
        {
          specversion: "1.0",
          id: "phase4-schedule-oracle",
          source:
            `//pubsub.googleapis.com/projects/${PROJECT_ID}/topics/firebase-schedule-scheduledTick`,
          type: "google.cloud.pubsub.topic.v1.messagePublished",
          time: "2026-01-02T03:04:05.000Z",
          data: {},
        },
        { "content-type": "application/cloudevents+json; charset=UTF-8" },
      ),
    ),
  );
  await waitForEventCount(capturePath, 2, 20_000);
  const beforeDisable = await readEvents(capturePath);

  const disable = await requestJson(
    hub,
    "PUT",
    "/functions/disableBackgroundTriggers",
    {},
  );
  observations.push(
    toObservation(
      "disable-background-triggers",
      "PUT",
      "/functions/disableBackgroundTriggers",
      disable,
    ),
  );
  observations.push(
    toObservation(
      "publish-while-disabled",
      "POST",
      `/v1/${customTopic}:publish`,
      await requestJson(pubsub, "POST", `/v1/${customTopic}:publish`, {
        messages: [{ data: Buffer.from("disabled", "utf8").toString("base64") }],
      }),
    ),
  );
  await delay(750);
  const afterDisabledPublish = await readEvents(capturePath);

  const enable = await requestJson(
    hub,
    "PUT",
    "/functions/enableBackgroundTriggers",
    {},
  );
  observations.push(
    toObservation(
      "enable-background-triggers",
      "PUT",
      "/functions/enableBackgroundTriggers",
      enable,
    ),
  );
  observations.push(
    toObservation(
      "publish-after-reenable",
      "POST",
      `/v1/${customTopic}:publish`,
      await requestJson(pubsub, "POST", `/v1/${customTopic}:publish`, {
        messages: [{ data: Buffer.from("reenabled 火", "utf8").toString("base64") }],
      }),
    ),
  );
  await waitForEventCount(capturePath, beforeDisable.length + 1, 20_000);
  const deliveredEvents = await readEvents(capturePath);
  for (const id of [
    "list-function-topics",
    "publish-custom-topic",
    "publish-schedule-topic",
    "invoke-schedule-cloudevent-directly",
    "disable-background-triggers",
    "publish-while-disabled",
    "enable-background-triggers",
    "publish-after-reenable",
  ]) {
    assertObservationStatus(observations, id, 200);
  }
  if (
    afterTopicPublications.length !== 1 ||
    asRecord(afterTopicPublications[0]).kind !== "topic" ||
    afterDisabledPublish.length !== beforeDisable.length ||
    deliveredEvents.length !== afterDisabledPublish.length + 1
  ) {
    throw new Error("official Pub/Sub background-control contract changed");
  }

  return {
    observations,
    deliveredEvents,
    invariants: {
      discoveredTopics: topicNames,
      customTopic,
      scheduleTopic,
      pubsubPublishedEventKinds: afterTopicPublications
        .map((event) => asRecord(event).kind)
        .sort(),
      schedulePubsubDeliverySupported: false,
      scheduleDirectInvocationStatus: observationStatus(
        observations,
        "invoke-schedule-cloudevent-directly",
      ),
      initialDeliveredEventKinds: beforeDisable.map((event) => asRecord(event).kind).sort(),
      disabledPublishAddedEvents: afterDisabledPublish.length - beforeDisable.length,
      reenabledPublishAddedEvents: deliveredEvents.length - afterDisabledPublish.length,
      expectedNoDisabledDelivery: true,
    },
  };
}

async function captureHub(
  suitePorts: SuitePorts,
  exportPath: string,
): Promise<{
  readonly observations: readonly Observation[];
  readonly exportInventory: readonly unknown[];
  readonly invariants: Readonly<Record<string, unknown>>;
}> {
  const hub = `http://${HOST}:${String(suitePorts.hub)}`;
  const auth = `http://${HOST}:${String(suitePorts.auth)}`;
  const observations: Observation[] = [];
  for (const [id, path] of [
    ["hub-locator", "/"],
    ["hub-emulator-map", "/emulators"],
  ] as const) {
    observations.push(
      toObservation(id, "GET", path, await requestJson(hub, "GET", path)),
    );
  }

  const createUser = await requestJson(
    auth,
    "POST",
    `/identitytoolkit.googleapis.com/v1/projects/${PROJECT_ID}/accounts`,
    {
      localId: "phase4-hub-export-user",
      email: "phase4-hub-export@example.com",
      displayName: "Hub 火🔥",
      emailVerified: true,
    },
    { authorization: "Bearer owner" },
  );
  observations.push(
    toObservation(
      "create-export-user",
      "POST",
      `/identitytoolkit.googleapis.com/v1/projects/${PROJECT_ID}/accounts`,
      createUser,
    ),
  );
  const exportResult = await requestJson(hub, "POST", "/_admin/export", {
    path: exportPath,
    initiatedBy: "phase4-oracle",
    targets: ["auth"],
  });
  observations.push(
    toObservation("hub-auth-export", "POST", "/_admin/export", exportResult),
  );
  if (exportResult.status !== 200) {
    throw new Error(`hub export failed: ${JSON.stringify(exportResult.body)}`);
  }
  const blockedExternal = await requestJson(
    hub,
    "POST",
    "/_admin/export",
    { path: `${exportPath}-blocked`, targets: ["auth"] },
    { origin: "https://example.invalid" },
  );
  observations.push(
    toObservation(
      "hub-export-origin-blocked",
      "POST",
      "/_admin/export",
      blockedExternal,
    ),
  );
  const exportInventory = await inventory(exportPath);
  for (const id of [
    "hub-locator",
    "hub-emulator-map",
    "create-export-user",
    "hub-auth-export",
  ]) {
    assertObservationStatus(observations, id, 200);
  }
  assertObservationStatus(observations, "hub-export-origin-blocked", 403);
  return {
    observations,
    exportInventory,
    invariants: {
      exportStatus: exportResult.status,
      externalOriginStatus: blockedExternal.status,
      externalOriginRejected: true,
      metadataFile: "firebase-export-metadata.json",
      authFiles: ["auth_export/accounts.json", "auth_export/config.json"],
    },
  };
}

async function captureUiAndLogging(
  suitePorts: SuitePorts,
  toolsRoot: string,
): Promise<{
  readonly observations: readonly Observation[];
  readonly websocketMessages: readonly unknown[];
  readonly invariants: Readonly<Record<string, unknown>>;
}> {
  const ui = `http://${HOST}:${String(suitePorts.ui)}`;
  const observations: Observation[] = [];
  observations.push(
    toObservation(
      "ui-api-config",
      "GET",
      "/api/config",
      await requestJson(ui, "GET", "/api/config"),
    ),
  );
  const root = await fetch(`${ui}/`);
  const html = await root.text();
  observations.push({
    id: "ui-index-html",
    method: "GET",
    path: "/",
    status: root.status,
    responseHeaders: captureHeaders(root.headers),
    response: {
      byteLength: Buffer.byteLength(html),
      sha256: sha256(html),
      containsRootElement: html.includes('id="root"'),
    },
  });

  const require = createRequire(join(toolsRoot, "package.json"));
  const WebSocketClient = require("ws") as new (url: string) => {
    on(event: string, listener: (...args: unknown[]) => void): void;
    once(event: string, listener: (...args: unknown[]) => void): void;
    close(): void;
  };
  const websocketMessages: unknown[] = [];
  const ws = new WebSocketClient(`ws://${HOST}:${String(suitePorts.logging)}`);
  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("logging websocket did not open")), 5_000);
    ws.once("open", () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
  await new Promise<void>((resolvePromise) => {
    const timer = setTimeout(resolvePromise, 500);
    const receive = (data: unknown): void => {
      try {
        const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
        websocketMessages.push(JSON.parse(text));
      } catch {
        // The official logging channel is JSON; retain only valid bundles.
      }
      if (websocketMessages.length >= 3) {
        clearTimeout(timer);
        resolvePromise();
      }
    };
    ws.on("message", receive);
  });
  ws.close();

  assertObservationStatus(observations, "ui-api-config", 200);
  assertObservationStatus(observations, "ui-index-html", 200);
  if (websocketMessages.length < 3) {
    throw new Error("official Logging emulator did not replay three JSON messages");
  }

  return {
    observations,
    websocketMessages: websocketMessages.slice(0, 3),
    invariants: {
      uiConfigStatus: observationStatus(observations, "ui-api-config"),
      indexStatus: observationStatus(observations, "ui-index-html"),
      loggingWebsocketConnected: true,
      replayedLogMessageCount: websocketMessages.length,
    },
  };
}

async function captureExtensionInventory(
  firebaseRoot: string,
  cacheRoot: string,
): Promise<unknown> {
  const firebaseJson = JSON.parse(
    await readFile(join(firebaseRoot, "firebase.json"), "utf8"),
  ) as { readonly extensions?: Readonly<Record<string, string>> };
  const instances = firebaseJson.extensions ?? {};
  const cachePaths: Readonly<Record<string, string>> = {
    "invertase/firestore-stripe-payments@0.3.12": join(
      cacheRoot,
      "extensions/invertase/firestore-stripe-payments@0.3.12/extension.yaml",
    ),
    "algolia/firestore-algolia-search@1.2.10": join(
      cacheRoot,
      "extensions/algolia/firestore-algolia-search@1.2.10/extension.yaml",
    ),
  };
  const yamlRequire = createRequire(join(packageRoot, "package.json"));
  const yaml = yamlRequire("yaml") as { parse(source: string): unknown };
  const definitions: Record<string, unknown> = {};
  for (const ref of [...new Set(Object.values(instances))]) {
    const path = cachePaths[ref];
    if (!path) throw new Error(`unexpected extension reference ${ref}`);
    const source = await readFile(path, "utf8");
    const expected = ref.startsWith("algolia/")
      ? ALGOLIA_YAML_SHA256
      : STRIPE_YAML_SHA256;
    assertHash(source, expected, ref);
    const parsed = asRecord(yaml.parse(source));
    const resources = Array.isArray(parsed.resources) ? parsed.resources : [];
    definitions[ref] = {
      yamlSha256: expected,
      name: parsed.name,
      version: parsed.version,
      resources: resources.map((resource) => {
        const record = asRecord(resource);
        const properties = asRecord(record.properties);
        return {
          name: record.name,
          type: record.type,
          runtime: properties.runtime,
          trigger: triggerSummary(properties),
        };
      }),
    };
  }
  return {
    firebaseJsonSha256: sha256(await readFile(join(firebaseRoot, "firebase.json"))),
    instances: Object.entries(instances).map(([instanceId, ref]) => ({ instanceId, ref })),
    definitions,
  };
}

function triggerSummary(properties: Record<string, unknown>): unknown {
  for (const name of [
    "eventTrigger",
    "httpsTrigger",
    "scheduleTrigger",
    "taskQueueTrigger",
  ]) {
    if (properties[name] !== undefined) return { type: name, value: properties[name] };
  }
  return { type: "unknown" };
}

async function stopSuite(
  suite: SuiteProcess,
  suitePorts: SuitePorts,
  locatorPath: string,
): Promise<{
  readonly clean: boolean;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly locatorDeleted: boolean;
  readonly portsClosed: boolean;
}> {
  suite.process.kill("SIGINT");
  await waitForExit(suite.process, 20_000);
  const locatorDeleted = await waitForMissing(locatorPath, 5_000);
  const portsClosed = await waitForPortsClosed(Object.values(suitePorts), 5_000);
  return {
    clean:
      suite.process.exitCode === 0 ||
      suite.process.exitCode === 130 ||
      suite.process.signalCode === "SIGINT",
    exitCode: suite.process.exitCode,
    signalCode: suite.process.signalCode,
    locatorDeleted,
    portsClosed,
  };
}

async function requestJson(
  base: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Readonly<Record<string, string>> = {},
): Promise<{ readonly status: number; readonly headers: Headers; readonly body: unknown }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: parseBody(text) };
}

async function observeJson(
  base: string,
  id: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Observation> {
  return toObservation(id, method, path, await requestJson(base, method, path, body));
}

function toObservation(
  id: string,
  method: string,
  path: string,
  result: { readonly status: number; readonly headers: Headers; readonly body: unknown },
): Observation {
  return {
    id,
    method,
    path,
    status: result.status,
    responseHeaders: captureHeaders(result.headers),
    response: result.body,
  };
}

function captureHeaders(headers: Headers): Readonly<Record<string, string>> {
  const captured: Record<string, string> = {};
  for (const name of ["content-type", "content-length", "location"]) {
    const value = headers.get(name);
    if (value !== null) captured[name] = value;
  }
  return captured;
}

function extractTopicNames(value: unknown): readonly string[] {
  const topics = asRecord(value).topics;
  if (!Array.isArray(topics)) return [];
  return topics
    .map((topic) => asRecord(topic).name)
    .filter((name): name is string => typeof name === "string")
    .sort();
}

async function readEvents(path: string): Promise<readonly unknown[]> {
  try {
    const text = await readFile(path, "utf8");
    return text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function waitForEventCount(
  path: string,
  expected: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await readEvents(path)).length >= expected) return;
    await delay(50);
  }
  throw new Error(`expected ${String(expected)} function events at ${path}`);
}

async function inventory(root: string): Promise<readonly unknown[]> {
  const files = await walk(root);
  const entries: unknown[] = [];
  for (const path of files) {
    const bytes = await readFile(path);
    const rel = relative(root, path);
    entries.push({
      path: rel,
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
      ...(rel.endsWith(".json") ? { json: normalizeDynamic(JSON.parse(bytes.toString("utf8"))) } : {}),
    });
  }
  return entries.sort((left, right) =>
    String(asRecord(left).path).localeCompare(String(asRecord(right).path)),
  );
}

async function walk(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root)) {
    const path = join(root, entry);
    if ((await stat(path)).isDirectory()) files.push(...(await walk(path)));
    else files.push(path);
  }
  return files;
}

function normalize(
  value: unknown,
  root: string,
  portMap: ReadonlyMap<number, string>,
): unknown {
  if (Array.isArray(value)) return value.map((child) => normalize(child, root, portMap));
  if (value === null || typeof value !== "object") {
    if (typeof value === "number") return portMap.get(value) ?? value;
    if (typeof value !== "string") return value;
    let result = value.replaceAll(root, "<suite-root>");
    for (const [port, label] of portMap) {
      result = result.replaceAll(String(port), label);
    }
    return result;
  }
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "pid" && typeof child === "number") output[key] = "<suite-pid>";
    else if (key === "analytics" && typeof child === "string") output[key] = "<analytics-session>";
    else if (["id", "messageId"].includes(key) && typeof child === "string" && /^\d+$/u.test(child)) {
      output[key] = `<generated-${key}>`;
    } else if (["time", "timestamp"].includes(key) && (typeof child === "number" || typeof child === "string")) {
      output[key] = `<generated-${key}>`;
    } else {
      output[key] = normalize(child, root, portMap);
    }
  }
  return output;
}

function normalizeDynamic(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeDynamic);
  if (value === null || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (
      ["createdAt", "lastLoginAt", "lastRefreshAt", "validSince"].includes(key) &&
      (typeof child === "string" || typeof child === "number")
    ) {
      output[key] = `<generated-${key}>`;
    } else {
      output[key] = normalizeDynamic(child);
    }
  }
  return output;
}

function normalizeLogLines(
  lines: readonly string[],
  root: string,
  portMap: ReadonlyMap<number, string>,
): readonly string[] {
  return lines.map((line) =>
    stripAnsi(String(normalize(line, root, portMap))).replace(/\bpid=\d+\b/gu, "pid=<suite-pid>"),
  );
}

function relevantLogs(text: string): readonly string[] {
  return stripAnsi(text)
    .split("\n")
    .filter((line) =>
      /emulator|function|pubsub|auth|ui|ready|running|shutdown|stopp/iu.test(line),
    )
    .slice(-80);
}

function activeLogs(readiness: Record<string, unknown>): readonly string[] {
  const lines = readiness.logLines;
  return Array.isArray(lines) ? lines.map(String) : [];
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/gu, "");
}

async function hashOracleSources(root: string): Promise<Readonly<Record<string, string>>> {
  const files = [
    "package.json",
    "lib/emulator/controller.js",
    "lib/emulator/functionsEmulator.js",
    "lib/emulator/functionsEmulatorRuntime.js",
    "lib/emulator/hub.js",
    "lib/emulator/hubExport.js",
    "lib/emulator/loggingEmulator.js",
    "lib/emulator/pubsubEmulator.js",
    "lib/emulator/ui.js",
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
  const observations = Array.isArray(record.observations)
    ? record.observations as readonly Observation[]
    : [];
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

function observationStatus(observations: readonly Observation[], id: string): number | undefined {
  return observations.find((observation) => observation.id === id)?.status;
}

async function readDebugLogs(root: string): Promise<string> {
  const names = (await readdir(root)).filter((name) => name.endsWith("-debug.log"));
  const chunks: string[] = [];
  for (const name of names) {
    const value = await readFile(join(root, name), "utf8");
    const relevant = stripAnsi(value)
      .split("\n")
      .filter((line) =>
        /functions|httpecho|socket|runtime|error|exception|stack|unexpected/iu.test(line),
      )
      .slice(-300)
      .join("\n");
    chunks.push(`--- ${name} ---\n${relevant}`);
  }
  return chunks.join("\n");
}

function assertObservationStatus(
  observations: readonly Observation[],
  id: string,
  expected: number,
): void {
  const actual = observationStatus(observations, id);
  if (actual !== expected) {
    throw new Error(`${id} expected status ${String(expected)}, found ${String(actual)}`);
  }
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("suite did not exit in time")), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

async function forceStop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  try {
    await waitForExit(child, 5_000);
  } catch {
    child.kill("SIGKILL");
    await waitForExit(child, 5_000);
  }
}

async function waitForMissing(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
    } catch {
      return true;
    }
    await delay(50);
  }
  return false;
}

async function waitForPortsClosed(ports: readonly number[], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await Promise.all(ports.map(isPortOpen));
    if (open.every((value) => !value)) return true;
    await delay(50);
  }
  return false;
}

async function isPortOpen(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolvePromise) => {
    const socket = new Socket();
    socket.setTimeout(200);
    socket.once("connect", () => {
      socket.destroy();
      resolvePromise(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolvePromise(false);
    });
    socket.once("error", () => resolvePromise(false));
    socket.connect(port, HOST);
  });
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

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assertHash(value: string | Uint8Array, expected: string, label: string): void {
  const actual = sha256(value);
  if (actual !== expected) throw new Error(`${label} hash mismatch: ${actual}`);
}

function parseBody(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected object, found ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
