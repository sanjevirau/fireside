import { spawn } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PROJECT_ID = "demo-fireside-export-oracle";
const workspaceRoot = resolve(process.cwd(), "..");
const fixtureRoot = join(
  process.cwd(),
  "fixtures",
  "official-export-v1.22.0",
);
const temporaryDirectory = await mkdtemp(
  join(tmpdir(), "fireside-official-import-"),
);

try {
  const exportDirectory = join(temporaryDirectory, "firestore_export");
  await run(
    "cargo",
    [
      "run",
      "--quiet",
      "-p",
      "fireside-export-format",
      "--example",
      "rewrite_export",
      "--",
      join(
        fixtureRoot,
        "firestore_export",
        "firestore_export.overall_export_metadata",
      ),
      exportDirectory,
    ],
    process.env,
    workspaceRoot,
  );
  await copyFile(
    join(fixtureRoot, "firebase-export-metadata.json"),
    join(temporaryDirectory, "firebase-export-metadata.json"),
  );

  const port = await reserveAvailablePort();
  const configPath = join(temporaryDirectory, "firebase.json");
  await writeFile(
    configPath,
    `${JSON.stringify({
      emulators: {
        firestore: { host: "127.0.0.1", port },
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
    {
      ...process.env,
      CONFORMANCE_TARGET: "java",
      GCLOUD_PROJECT: PROJECT_ID,
    },
    process.cwd(),
  );
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true });
}

async function reserveAvailablePort(): Promise<number> {
  const server = createServer();
  return await new Promise<number>((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
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

async function run(
  executable: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Promise<void> {
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(executable, arguments_, {
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
            `${executable} exited with code ${String(code)} and signal ${String(signal)}`,
          ),
        );
      }
    });
  });
}
