import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { resolve } from "node:path";

import { repositoryRoot } from "./manifest.ts";

const HOST = "127.0.0.1";

export type ServerKind = "fireside-memory" | "fireside-disk" | "java";

export interface StartServerOptions {
  readonly kind: ServerKind;
  readonly projectId: string;
  readonly outputDirectory: string;
  readonly dataDirectory?: string;
  readonly importMetadata?: string;
  readonly javaToolOptions?: string;
  readonly onSpawn?: (pid: number, child: ChildProcess) => void;
}

export interface ServerHandle {
  readonly child: ChildProcess;
  readonly host: string;
  readonly port: number;
  readonly pid: number;
  readonly startupMilliseconds: number;
  stop(signal?: NodeJS.Signals): Promise<void>;
}

export async function startServer(options: StartServerOptions): Promise<ServerHandle> {
  const port = await reservePort();
  const logPath = resolve(options.outputDirectory, "server.log");
  mkdirSync(options.outputDirectory, { recursive: true });
  const descriptor = openSync(logPath, "a", 0o644);
  const startedAt = performance.now();
  const command = serverCommand(options, port);
  const child = spawn(command.executable, command.arguments, {
    cwd: repositoryRoot,
    env: command.environment,
    stdio: ["ignore", descriptor, descriptor],
  });
  closeSync(descriptor);
  child.once("error", () => undefined);
  const pid = child.pid;
  if (pid === undefined) {
    throw new Error(`failed to start ${options.kind}`);
  }
  options.onSpawn?.(pid, child);
  await waitUntilListening(child, port, options.importMetadata === undefined ? 60_000 : 7_200_000);
  const startupMilliseconds = performance.now() - startedAt;
  return {
    child,
    host: HOST,
    port,
    pid,
    startupMilliseconds,
    async stop(signal = "SIGTERM"): Promise<void> {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      child.kill(signal);
      await waitForExit(child);
    },
  };
}

function serverCommand(
  options: StartServerOptions,
  port: number,
): { executable: string; arguments: string[]; environment: NodeJS.ProcessEnv } {
  if (options.kind === "java") {
    const jar = process.env.FIRESTORE_EMULATOR_JAR;
    if (jar === undefined || jar.length === 0) {
      throw new Error("FIRESTORE_EMULATOR_JAR is required for the Java comparison");
    }
    const arguments_ = [
      "-jar",
      jar,
      "--host",
      HOST,
      "--port",
      String(port),
      "--project_id",
      options.projectId,
      "--single_project_mode",
      "true",
      "--database-edition",
      "standard",
    ];
    if (options.importMetadata !== undefined) {
      arguments_.push("--seed_from_export", options.importMetadata);
    }
    return {
      executable: "java",
      arguments: arguments_,
      environment: {
        ...process.env,
        ...(options.javaToolOptions === undefined
          ? {}
          : { JAVA_TOOL_OPTIONS: options.javaToolOptions }),
      },
    };
  }

  const arguments_ = [
    "firestore",
    "--host",
    HOST,
    "--port",
    String(port),
    "--project_id",
    options.projectId,
  ];
  if (options.kind === "fireside-disk") {
    if (options.dataDirectory === undefined) {
      throw new Error("fireside disk mode requires a data directory");
    }
    arguments_.push("--data-dir", options.dataDirectory);
  }
  if (options.importMetadata !== undefined) {
    arguments_.push("--seed_from_export", options.importMetadata);
  }
  return {
    executable: resolve(repositoryRoot, "target/release/fireside"),
    arguments: arguments_,
    environment: process.env,
  };
}

async function reservePort(): Promise<number> {
  const server = createServer();
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

async function waitUntilListening(
  child: ChildProcess,
  port: number,
  timeoutMilliseconds: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `server exited before readiness: code=${String(child.exitCode)} signal=${String(child.signalCode)}`,
      );
    }
    if (await canConnect(port)) {
      return;
    }
    await delay(100);
  }
  throw new Error(`server did not listen within ${String(timeoutMilliseconds)}ms`);
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
  await new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
