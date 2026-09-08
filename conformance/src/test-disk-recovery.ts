import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomInt } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const HOST = "127.0.0.1";
const PROJECT_ID = "demo-fireside-disk-recovery";
const DATABASE_ROOT = `projects/${PROJECT_ID}/databases/(default)`;
const COLLECTION = "kill_batches";
const ROUNDS = 6;
const MAX_BATCHES_PER_ROUND = 256;
const repositoryRoot = resolve(process.cwd(), "..");
const executableName = process.platform === "win32" ? "fireside.exe" : "fireside";
const executable = join(repositoryRoot, "target", "debug", executableName);
const dataDirectory = await mkdtemp(join(tmpdir(), "fireside-disk-recovery-"));
const attempted = new Set<string>();
const acknowledged = new Set<string>();
let server: ChildProcess | undefined;

if (process.platform === "win32") {
  throw new Error("the crash-recovery gate requires POSIX SIGKILL semantics");
}

try {
  await buildFireside();

  for (let round = 0; round < ROUNDS; round += 1) {
    const running = await startServer();
    server = running.child;
    await verifyRecoveredBatches(running.baseUrl, attempted, acknowledged);

    const seedId = `round-${String(round)}-seed`;
    attempted.add(seedId);
    await commitBatch(running.baseUrl, seedId, round);
    acknowledged.add(seedId);

    const writer = writeUntilInterrupted(running.baseUrl, round);
    await delay(randomInt(2, 25));
    assert.equal(server.kill("SIGKILL"), true, "SIGKILL should be delivered");
    await waitForExit(server);
    server = undefined;
    await writer;
  }

  const finalServer = await startServer();
  server = finalServer.child;
  await verifyRecoveredBatches(finalServer.baseUrl, attempted, acknowledged);
  console.log(
    `disk recovery gate passed: ${String(ROUNDS)} SIGKILL rounds, `
      + `${String(acknowledged.size)} acknowledged atomic batches recovered, `
      + `${String(attempted.size)} attempted batches checked for partial visibility`,
  );
} finally {
  if (server !== undefined) {
    await stop(server);
  }
  await rm(dataDirectory, { recursive: true, force: true });
}

async function writeUntilInterrupted(baseUrl: string, round: number): Promise<void> {
  for (let batch = 0; batch < MAX_BATCHES_PER_ROUND; batch += 1) {
    const id = `round-${String(round)}-live-${String(batch)}`;
    attempted.add(id);
    try {
      await commitBatch(baseUrl, id, batch);
      acknowledged.add(id);
    } catch (error) {
      if (isConnectionInterruption(error)) {
        return;
      }
      throw error;
    }
  }
}

async function commitBatch(baseUrl: string, id: string, value: number): Promise<void> {
  const response = await fetch(`${baseUrl}/v1/${DATABASE_ROOT}/documents:commit`, {
    method: "POST",
    headers: {
      authorization: "Bearer owner",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      writes: [
        updateWrite(id, "left", value),
        updateWrite(id, "right", value),
      ],
    }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`commit ${id} failed with HTTP ${String(response.status)}`);
  }
}

function updateWrite(id: string, side: "left" | "right", value: number): object {
  return {
    update: {
      name: documentName(id, side),
      fields: {
        batch: { stringValue: id },
        side: { stringValue: side },
        value: { integerValue: String(value) },
      },
    },
  };
}

async function verifyRecoveredBatches(
  baseUrl: string,
  expectedAttempts: ReadonlySet<string>,
  expectedAcknowledgements: ReadonlySet<string>,
): Promise<void> {
  const response = await fetch(`${baseUrl}/v1/${DATABASE_ROOT}/documents:runQuery`, {
    method: "POST",
    headers: {
      authorization: "Bearer owner",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      structuredQuery: { from: [{ collectionId: COLLECTION }] },
    }),
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, 200, "recovery query should succeed");
  const names = responseDocumentNames(await response.json());

  for (const id of expectedAttempts) {
    const left = names.has(documentName(id, "left"));
    const right = names.has(documentName(id, "right"));
    assert.equal(left, right, `batch ${id} must not be partially visible`);
  }
  for (const id of expectedAcknowledgements) {
    assert.equal(
      names.has(documentName(id, "left")),
      true,
      `acknowledged batch ${id} must survive SIGKILL`,
    );
    assert.equal(names.has(documentName(id, "right")), true);
  }
}

function responseDocumentNames(body: unknown): Set<string> {
  if (!Array.isArray(body)) {
    throw new Error("runQuery response must be an array");
  }
  const names = new Set<string>();
  for (const entry of body) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const document = Reflect.get(entry, "document");
    if (typeof document !== "object" || document === null) {
      continue;
    }
    const name = Reflect.get(document, "name");
    if (typeof name === "string") {
      names.add(name);
    }
  }
  return names;
}

function documentName(id: string, side: "left" | "right"): string {
  return `${DATABASE_ROOT}/documents/${COLLECTION}/${id}-${side}`;
}

async function startServer(): Promise<{ child: ChildProcess; baseUrl: string }> {
  const port = await reserveAvailablePort();
  const child = spawn(
    executable,
    [
      "firestore",
      "--host",
      HOST,
      "--port",
      String(port),
      "--project_id",
      PROJECT_ID,
      "--data-dir",
      dataDirectory,
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  await waitUntilListening(child, port);
  return { child, baseUrl: `http://${HOST}:${String(port)}` };
}

async function buildFireside(): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("cargo", ["build", "--quiet", "--locked", "-p", "fireside"], {
      cwd: repositoryRoot,
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`cargo build exited with code ${String(code)} and signal ${String(signal)}`));
    });
  });
}

async function reserveAvailablePort(): Promise<number> {
  const listener = createServer();
  return await new Promise<number>((resolvePromise, reject) => {
    listener.once("error", reject);
    listener.listen(0, HOST, () => {
      const address = listener.address();
      if (address === null || typeof address === "string") {
        listener.close();
        reject(new Error("failed to reserve a loopback TCP port"));
        return;
      }
      listener.close((error) => {
        if (error === undefined) {
          resolvePromise(address.port);
        } else {
          reject(error);
        }
      });
    });
  });
}

async function waitUntilListening(child: ChildProcess, port: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("fireside exited before its port became available");
    }
    if (await canConnect(port)) {
      return;
    }
    await delay(25);
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

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolvePromise());
  });
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await waitForExit(child);
}

function isConnectionInterruption(error: unknown): boolean {
  return error instanceof TypeError
    || (error instanceof DOMException && error.name === "TimeoutError");
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
