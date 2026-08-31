import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FIREBASE_JS_SDK_REVISION =
  "6cde0c0230b4c1da01d4a058333daa7663322fd1";
const HOST = "127.0.0.1";
const PORT = 8080;
const PROJECT_ID = "test-emulator";

interface Arguments {
  readonly diskMode: boolean;
  readonly grep?: string;
  readonly sdkDirectory: string;
}

async function main(): Promise<void> {
  const arguments_ = parseArguments(process.argv.slice(2));
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const repositoryRoot = resolve(scriptDirectory, "../../..");
  const sdkDirectory = isAbsolute(arguments_.sdkDirectory)
    ? arguments_.sdkDirectory
    : resolve(process.cwd(), arguments_.sdkDirectory);
  const firestoreDirectory = join(sdkDirectory, "packages", "firestore");
  const sdkRevision = await capturedCommand(
    "git",
    ["-C", sdkDirectory, "rev-parse", "HEAD"],
    repositoryRoot,
  );
  if (sdkRevision !== FIREBASE_JS_SDK_REVISION) {
    throw new Error(
      `firebase-js-sdk revision ${sdkRevision} does not match ${FIREBASE_JS_SDK_REVISION}`,
    );
  }

  await runCommand(
    "yarn",
    ["--cwd", firestoreDirectory, "build:deps"],
    sdkDirectory,
  );

  await runCommand(
    "cargo",
    ["build", "--locked", "-p", "fireside"],
    repositoryRoot,
  );

  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "fireside-firebase-js-sdk-"),
  );
  if (await canConnect(PORT)) {
    throw new Error(
      `port ${String(PORT)} is already in use; the upstream browser harness requires its default emulator port`,
    );
  }
  const executable = process.platform === "win32" ? "fireside.exe" : "fireside";
  const serverArguments = [
    "firestore",
    "--host",
    HOST,
    "--port",
    String(PORT),
    "--project_id",
    PROJECT_ID,
    "--single_project_mode",
    "true",
  ];
  if (arguments_.diskMode) {
    serverArguments.push("--data-dir", join(temporaryDirectory, "data"));
  }
  const server = spawn(
    join(repositoryRoot, "target", "debug", executable),
    serverArguments,
    {
      cwd: repositoryRoot,
      env: process.env,
      stdio: ["ignore", "inherit", "inherit"],
    },
  );

  try {
    await waitUntilListening(server, PORT);
    const karmaArguments = [
      "--cwd",
      firestoreDirectory,
      "karma",
      "start",
      "--integration",
      "--targetBackend=emulator",
      "--single-run",
    ];
    if (arguments_.grep !== undefined) {
      karmaArguments.push("--grep", arguments_.grep);
    }
    await runCommand("yarn", karmaArguments, sdkDirectory, {
      ...process.env,
      FIRESTORE_EMULATOR_PORT: String(PORT),
      FIRESTORE_EMULATOR_PROJECT_ID: PROJECT_ID,
    });
    process.stdout.write(
      `${JSON.stringify(
        {
          command:
            "yarn --cwd packages/firestore karma start --integration --targetBackend=emulator --single-run",
          firebaseJsSdkRevision: sdkRevision,
          filter: arguments_.grep ?? null,
          mode: arguments_.diskMode ? "disk-wal" : "memory",
          projectId: PROJECT_ID,
          schemaVersion: 1,
          sdkBuildCommand:
            "yarn --cwd packages/firestore build:deps",
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await stop(server);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function parseArguments(arguments_: readonly string[]): Arguments {
  let diskMode = false;
  let grep: string | undefined;
  let sdkDirectory: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--disk") {
      diskMode = true;
      continue;
    }
    if (argument === "--grep" || argument === "--sdk-dir") {
      const value = arguments_[index + 1];
      if (value === undefined || value.length === 0) {
        throw new Error(`${argument} requires a value`);
      }
      if (argument === "--grep") {
        grep = value;
      } else {
        sdkDirectory = value;
      }
      index += 1;
      continue;
    }
    throw new Error(`unsupported argument: ${argument}`);
  }
  if (sdkDirectory === undefined) {
    throw new Error("--sdk-dir is required");
  }
  return grep === undefined
    ? { diskMode, sdkDirectory }
    : { diskMode, grep, sdkDirectory };
}

async function capturedCommand(
  command: string,
  arguments_: readonly string[],
  cwd: string,
): Promise<string> {
  return await new Promise<string>((resolvePromise, reject) => {
    const child = spawn(command, arguments_, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "inherit"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise(Buffer.concat(chunks).toString("utf8").trim());
        return;
      }
      reject(
        new Error(
          `${command} exited with code ${String(code)} and signal ${String(signal)}`,
        ),
      );
    });
  });
}

async function runCommand(
  command: string,
  arguments_: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, arguments_, {
      cwd,
      env: environment,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(
        new Error(
          `${command} exited with code ${String(code)} and signal ${String(signal)}`,
        ),
      );
    });
  });
}

async function waitUntilListening(
  server: ChildProcess,
  port: number,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error("fireside exited before its port became available");
    }
    if (await canConnect(port)) {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error("timed out waiting for fireside to listen");
}

async function canConnect(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolvePromise) => {
    const socket = createConnection({ host: HOST, port });
    socket.once("connect", () => {
      socket.destroy();
      resolvePromise(true);
    });
    socket.once("error", () => resolvePromise(false));
  });
}

async function stop(server: ChildProcess): Promise<void> {
  if (server.exitCode !== null || server.signalCode !== null) {
    return;
  }
  server.kill("SIGTERM");
  await new Promise<void>((resolvePromise) =>
    server.once("exit", () => resolvePromise()),
  );
}

await main();
