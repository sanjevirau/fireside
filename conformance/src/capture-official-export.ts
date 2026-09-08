import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_ID = "demo-fireside-export-oracle";

const temporaryDirectory = await mkdtemp(
  join(tmpdir(), "fireside-export-oracle-"),
);
const exportDirectory = join(temporaryDirectory, "export");
const configPath = join(temporaryDirectory, "firebase.json");
const port = await reserveAvailablePort();
await mkdir(exportDirectory);
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
await run(firebaseExecutable, [
  "emulators:exec",
  "--non-interactive",
  "--only",
  "firestore",
  "--project",
  PROJECT_ID,
  "--config",
  configPath,
  `--export-on-exit=${exportDirectory}`,
  "node --import tsx src/seed-export.ts",
], {
  ...process.env,
  CONFORMANCE_TARGET: "java",
  GCLOUD_PROJECT: PROJECT_ID,
});

process.stdout.write(`${exportDirectory}\n`);

async function reserveAvailablePort(): Promise<number> {
  const server = createServer();
  return await new Promise<number>((resolve, reject) => {
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
        resolve(address.port);
      });
    });
  });
}

async function run(
  executable: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      cwd: process.cwd(),
      env: environment,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
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
