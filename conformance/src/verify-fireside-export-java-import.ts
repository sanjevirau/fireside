import { spawn, type ChildProcess } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PROJECT_ID = "demo-fireside-export-oracle";
const HOST = "127.0.0.1";
const EXPORT_NAME = "firestore_export";
const repositoryRoot = resolve(process.cwd(), "..");
const executable = process.platform === "win32" ? "fireside.exe" : "fireside";
const temporaryDirectory = await mkdtemp(
  join(tmpdir(), "fireside-public-export-"),
);

try {
  await run("cargo", [
    "build",
    "--quiet",
    "--locked",
    "-p",
    "fireside",
  ], repositoryRoot);
  const firesidePort = await reserveAvailablePort();
  const fireside = spawn(
    join(repositoryRoot, "target", "debug", executable),
    [
      "--host",
      HOST,
      "--port",
      String(firesidePort),
      "--project_id",
      PROJECT_ID,
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "inherit", "inherit"],
    },
  );

  try {
    await waitUntilListening(fireside, firesidePort);
    const firesideEnvironment = {
      ...process.env,
      CONFORMANCE_TARGET: "fireside",
      FIRESTORE_EMULATOR_HOST: `${HOST}:${String(firesidePort)}`,
      GCLOUD_PROJECT: PROJECT_ID,
    };
    await run(
      process.execPath,
      ["--import", "tsx", "src/seed-export.ts"],
      process.cwd(),
      firesideEnvironment,
    );
    const response = await fetch(
      `http://${HOST}:${String(firesidePort)}/emulator/v1/projects/${PROJECT_ID}:export`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer owner",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          database: `projects/${PROJECT_ID}/databases/(default)`,
          export_directory: temporaryDirectory,
          export_name: EXPORT_NAME,
        }),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Fireside export failed with ${String(response.status)}: ${await response.text()}`,
      );
    }
  } finally {
    await stop(fireside);
  }

  await copyFile(
    join(
      process.cwd(),
      "fixtures",
      "official-export-v1.22.0",
      "firebase-export-metadata.json",
    ),
    join(temporaryDirectory, "firebase-export-metadata.json"),
  );
  const javaPort = await reserveAvailablePort();
  const configPath = join(temporaryDirectory, "firebase.json");
  await writeFile(
    configPath,
    `${JSON.stringify({
      emulators: {
        firestore: { host: HOST, port: javaPort },
        singleProjectMode: true,
        ui: { enabled: false },
      },
    }, null, 2)}\n`,
    "utf8",
  );
  const firebaseExecutable = process.platform === "win32"
    ? "firebase.cmd"
    : "firebase";
  await run(
    firebaseExecutable,
    [
      "emulators:exec",
      "--non-interactive",
      "--only",
      "firestore",
      "--project",
      PROJECT_ID,
      "--config",
      configPath,
      `--import=${temporaryDirectory}`,
      "node --import tsx src/assert-export-import.ts",
    ],
    process.cwd(),
    {
      ...process.env,
      CONFORMANCE_TARGET: "java",
      GCLOUD_PROJECT: PROJECT_ID,
    },
  );
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true });
}

async function run(
  command: string,
  arguments_: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(command, arguments_, {
      cwd,
      env: environment,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
      } else {
        reject(
          new Error(
            `${command} exited with code ${String(code)} and signal ${String(signal)}`,
          ),
        );
      }
    });
  });
}

async function reserveAvailablePort(): Promise<number> {
  const server = createServer();
  return await new Promise<number>((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("failed to reserve a loopback port"));
        return;
      }
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolvePort(address.port);
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
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error("timed out waiting for fireside to listen");
}

async function canConnect(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolveConnection) => {
    const socket = createConnection({ host: HOST, port });
    socket.once("connect", () => {
      socket.destroy();
      resolveConnection(true);
    });
    socket.once("error", () => resolveConnection(false));
  });
}

async function stop(server: ChildProcess): Promise<void> {
  if (server.exitCode !== null || server.signalCode !== null) {
    return;
  }
  server.kill("SIGTERM");
  await new Promise<void>((resolveStop) => {
    server.once("exit", () => resolveStop());
  });
}
