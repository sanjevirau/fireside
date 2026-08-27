import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PROJECT_ID = "demo-fireside-fireside";
const HOST = "127.0.0.1";
const BACKEND_TEST_FILES = [
  "test/ancestor-collection-group.test.ts",
  "test/backend-rpcs.test.ts",
  "test/error-code-parity.test.ts",
  "test/firestore-smoke.test.ts",
  "test/historical-reads.test.ts",
  "test/listen.test.ts",
  "test/named-database.test.ts",
  "test/partition-query.test.ts",
  "test/pipeline-edition.test.ts",
  "test/query-explain.test.ts",
  "test/query-features.test.ts",
  "test/query-ordering.test.ts",
  "test/rest.test.ts",
  "test/streaming-write.test.ts",
  "test/vector-query.test.ts",
  "test/write-transforms.test.ts",
] as const;
const strictIndexes = process.argv.includes("--strict-indexes");
const diskMode = process.argv.includes("--disk");
const testFiles: readonly string[] = strictIndexes
  ? ["test/strict-indexes.test.ts"]
  : BACKEND_TEST_FILES;

const repositoryRoot = resolve(process.cwd(), "..");
await buildFireside();
const dataDirectory = diskMode
  ? await mkdtemp(join(tmpdir(), "fireside-conformance-disk-"))
  : undefined;
const port = await reserveAvailablePort();
const executable = process.platform === "win32" ? "fireside.exe" : "fireside";
const serverArguments = [
  "--host",
  HOST,
  "--port",
  String(port),
  "--project_id",
  PROJECT_ID,
  "--single_project_mode",
  "true",
  "--database-edition",
  "standard",
];
if (strictIndexes) {
  serverArguments.push("--strict-indexes");
}
if (dataDirectory !== undefined) {
  serverArguments.push("--data-dir", dataDirectory);
}
const server = spawn(
  join(repositoryRoot, "target", "debug", executable),
  serverArguments,
  {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "inherit", "inherit"],
  },
);

try {
  await waitUntilListening(server, port);
  await runTests(port, testFiles);
  if (!strictIndexes) {
    await runTests(port, ["test/control-api.test.ts"]);
  }
} finally {
  await stop(server);
  if (dataDirectory !== undefined) {
    await rm(dataDirectory, { recursive: true, force: true });
  }
}

async function runTests(port: number, files: readonly string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--test", ...files],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CONFORMANCE_TARGET: "fireside",
          CONFORMANCE_STRICT_INDEXES: strictIndexes ? "1" : "0",
          FIRESTORE_EMULATOR_HOST: `${HOST}:${String(port)}`,
          GCLOUD_PROJECT: PROJECT_ID,
        },
        stdio: "inherit",
      },
    );

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(
        new Error(
          `fireside conformance exited with code ${String(code)} and signal ${String(signal)}`,
        ),
      );
    });
  });
}

async function buildFireside(): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(
      "cargo",
      ["build", "--quiet", "--locked", "-p", "fireside"],
      {
        cwd: repositoryRoot,
        env: process.env,
        stdio: "inherit",
      },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(
        new Error(
          `cargo build exited with code ${String(code)} and signal ${String(signal)}`,
        ),
      );
    });
  });
}

async function reserveAvailablePort(): Promise<number> {
  const server = createServer();
  return await new Promise<number>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("failed to reserve a loopback TCP port"));
        return;
      }
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolvePromise(address.port);
      });
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
  await new Promise<void>((resolvePromise) => server.once("exit", () => resolvePromise()));
}
