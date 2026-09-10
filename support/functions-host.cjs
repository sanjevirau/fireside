#!/usr/bin/env node
"use strict";

// Isolated firebase-tools workload host. This process loads and executes Node
// Functions and Extensions only. Every emulator endpoint in EmulatorRegistry
// is a remote Fireside service; this process never creates a Hub or data
// emulator.

const fs = require("node:fs");
const path = require("node:path");

function fail(message) {
  process.stderr.write(`fireside functions host: ${message}\n`);
  process.exit(1);
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      fail(`invalid argument sequence near ${String(key)}`);
    }
    values[key.slice(2)] = value;
  }
  return values;
}

function required(values, key) {
  const value = values[key];
  if (!value) fail(`--${key} is required`);
  return value;
}

function parsePort(values, key) {
  const value = Number.parseInt(required(values, key), 10);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    fail(`--${key} must be a TCP port`);
  }
  return value;
}

const args = parseArguments(process.argv.slice(2));
const toolsRoot = path.resolve(required(args, "firebase-tools-root"));
const projectDir = path.resolve(required(args, "project-dir"));
const configPath = path.resolve(required(args, "config"));
const projectId = required(args, "project-id");
if (!projectId.startsWith("demo-")) {
  fail("the workload host requires a demo-* project ID");
}

const packageJson = JSON.parse(
  fs.readFileSync(path.join(toolsRoot, "package.json"), "utf8"),
);
if (packageJson.name !== "firebase-tools" || packageJson.version !== "15.22.0") {
  fail(
    `expected firebase-tools 15.22.0, found ${String(packageJson.name)} ${String(packageJson.version)}`,
  );
}

function fromTools(modulePath) {
  return require(path.join(toolsRoot, "lib", modulePath));
}

const { Config } = fromTools("config.js");
const { getProjectDefaultAccount, setActiveAccount } = fromTools("auth.js");
const { Constants } = fromTools("emulator/constants.js");
const { ExtensionsEmulator } = fromTools("emulator/extensionsEmulator.js");
const { FunctionsEmulator } = fromTools("emulator/functionsEmulator.js");
const { EmulatorRegistry } = fromTools("emulator/registry.js");
const { Emulators } = fromTools("emulator/types.js");
const { requireAuth } = fromTools("requireAuth.js");

class RemoteEmulator {
  constructor(name, host, port) {
    this.name = name;
    this.host = host;
    this.port = port;
  }

  getName() {
    return this.name;
  }

  getInfo() {
    return { name: this.name, host: this.host, port: this.port };
  }

  async addTrigger() {
    // Fireside discovers Pub/Sub and schedule targets from /backends and owns
    // delivery. firebase-tools needs only a successful registration response.
  }

  async start() {}
  async connect() {}
  async stop() {}
}

const host = required(args, "host");
const functionsPort = parsePort(args, "functions-port");
const remotePorts = {
  [Emulators.FIRESTORE]: parsePort(args, "firestore-port"),
  [Emulators.AUTH]: parsePort(args, "auth-port"),
  [Emulators.STORAGE]: parsePort(args, "storage-port"),
  [Emulators.PUBSUB]: parsePort(args, "pubsub-port"),
  [Emulators.HUB]: parsePort(args, "hub-port"),
  [Emulators.UI]: parsePort(args, "ui-port"),
  [Emulators.EVENTARC]: parsePort(args, "eventarc-port"),
  [Emulators.TASKS]: parsePort(args, "tasks-port"),
};
for (const [name, port] of Object.entries(remotePorts)) {
  EmulatorRegistry.set(name, new RemoteEmulator(name, host, port));
}

const source = JSON.parse(fs.readFileSync(configPath, "utf8"));
const config = new Config(source, { projectDir, configPath, nonInteractive: true });
const options = {
  config,
  project: projectId,
  projectId,
  projectDir,
  projectRoot: projectDir,
  nonInteractive: true,
  force: true,
  only: "firestore,auth,storage,functions,pubsub,extensions,eventarc,tasks",
  targets: [
    "firestore",
    "auth",
    "storage",
    "functions",
    "pubsub",
    "extensions",
    "eventarc",
    "tasks",
  ],
};

function customBackends() {
  const configured = config.get("functions") ?? [];
  const entries = Array.isArray(configured) ? configured : [configured];
  return entries.map((entry, index) => {
    const sourceDir = entry.source ?? "functions";
    return {
      functionsDir: path.resolve(projectDir, sourceDir),
      runtime: entry.runtime,
      codebase: entry.codebase ?? `default-${index}`,
      ...(entry.configDir
        ? { configDir: path.resolve(projectDir, entry.configDir) }
        : {}),
      env: {},
      secretEnv: [],
      ignore: entry.ignore ?? [],
    };
  });
}

let functionsEmulator;
let extensionEmulator;
let stopping = false;

async function stop(signal) {
  if (stopping) return;
  stopping = true;
  process.stderr.write(`fireside functions host: stopping after ${signal}\n`);
  try {
    if (functionsEmulator) await functionsEmulator.stop();
    EmulatorRegistry.clear(Emulators.FUNCTIONS);
    EmulatorRegistry.clear(Emulators.EXTENSIONS);
    // The upstream runtime leaves its 30-second socket-discovery timer alive
    // even after a successful invocation. Like the official CLI, terminate this
    // owned host only after its work queue, workers and HTTP server have stopped.
    process.exit(0);
  } catch (error) {
    process.stderr.write(`fireside functions host shutdown failed: ${String(error)}\n`);
    process.exit(1);
  }
}

process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));

// Windows has no Unix kill utility or portable graceful child signal. Only
// the owning Rust parent can write this private pipe; no HTTP surface is added.
if (process.platform === "win32") {
  let control = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    control += chunk;
    if (control === "FIRESIDE_SHUTDOWN\n" || control === "FIRESIDE_SHUTDOWN\r\n") {
      process.stdin.destroy();
      void stop("launcher pipe");
    } else if (control.length > 64 || control.includes("\n")) {
      process.stdin.destroy();
      void stop("invalid launcher pipe");
    }
  });
  process.stdin.once("end", () => void stop("launcher disconnected"));
}

async function startFunctionsOnce(emulator, registry, customBackends) {
  const discovered = new Map(customBackends.map((backend) => [backend, undefined]));
  const discover = emulator.discoverTriggers;
  // connect() owns discovery and source watching. Observe its initial results
  // instead of executing the backend a second time before it starts.
  emulator.discoverTriggers = async function (...args) {
    const definitions = await discover.apply(this, args);
    if (discovered.has(args[0])) discovered.set(args[0], definitions);
    return definitions;
  };
  try {
    await registry.start(emulator);
    await emulator.connect();
  } finally {
    emulator.discoverTriggers = discover;
  }
  let total = 0;
  for (const [backend, definitions] of discovered) {
    // firebase-tools can log discovery failures without rejecting connect().
    // Missing results must not produce a false READY signal.
    if (definitions === undefined) {
      throw new Error(`Functions source ${backend.functionsDir} discovery did not complete`);
    }
    if (definitions.length === 0) {
      throw new Error(`Functions source ${backend.functionsDir} exported no functions`);
    }
    for (const definition of definitions) {
      // Discovery is not admission: upstream retains ignored definitions when
      // their required emulator could not register the trigger. Its public
      // inventory and getTriggerDefinitions() include those records as well.
      let record;
      try {
        record = emulator.getTriggerRecordByKey(emulator.getTriggerKey(definition));
      } catch {
        throw new Error(`Function ${definition.id} was discovered but not registered`);
      }
      if (!record || record.def.id !== definition.id) {
        throw new Error(`Function ${definition.id} was discovered but not registered`);
      }
      if (!record.enabled || record.ignored) {
        throw new Error(`Function ${definition.id} was discovered but not admitted (disabled or ignored)`);
      }
    }
    total += definitions.length;
  }
  return total;
}

async function main() {
  const extensions = config.get("extensions");
  let extensionBackends = [];
  if (extensions && Object.keys(extensions).length > 0) {
    // Explicit version references still require one public Extensions Hub API
    // lookup in firebase-tools 15.22.0. Authenticate that parent-process lookup
    // with the same local CLI account firebase-tools normally selects. The
    // FunctionsEmulator below deliberately receives `account: undefined`, so
    // these credentials are never serialized into a worker environment.
    const account = getProjectDefaultAccount(projectDir);
    if (account) setActiveAccount(options, account);
    await requireAuth(options);
    extensionEmulator = new ExtensionsEmulator({
      options,
      projectId,
      projectDir,
      projectNumber: Constants.FAKE_PROJECT_NUMBER,
      aliases: [],
      extensions,
    });
    EmulatorRegistry.set(Emulators.EXTENSIONS, extensionEmulator);
    extensionBackends = await extensionEmulator.getExtensionBackends();
  }

  const custom = customBackends();
  const emulatableBackends = [...custom, ...extensionBackends];
  if (emulatableBackends.length === 0) {
    fail("firebase.json contains no Functions or Extensions backends");
  }
  functionsEmulator = new FunctionsEmulator({
    projectId,
    projectDir,
    emulatableBackends,
    account: undefined,
    host,
    port: functionsPort,
    projectAlias: undefined,
    extensionsEmulator: extensionEmulator,
    adminSdkConfig: {
      projectId,
      storageBucket: required(args, "default-bucket"),
    },
  });
  const customFunctionCount = await startFunctionsOnce(functionsEmulator, EmulatorRegistry, custom);
  process.stdout.write(
    `FIRESIDE_FUNCTIONS_HOST_READY ${JSON.stringify({
      firebaseToolsVersion: packageJson.version,
      backendCount: emulatableBackends.length,
      customFunctionCount,
      functionsPort,
    })}\n`,
  );
}

main().catch((error) => fail(String(error?.stack ?? error)));
