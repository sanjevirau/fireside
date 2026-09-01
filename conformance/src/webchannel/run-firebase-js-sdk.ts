import { spawn, type ChildProcess } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  isAcceptedKarmaProcess,
  parseKarmaEvidence,
} from "./firebase-js-sdk-karma-evidence.ts";
import { pinGeneratedMetadata } from "./firebase-js-sdk-metadata.ts";

const FIREBASE_JS_SDK_REVISION = "6cde0c0230b4c1da01d4a058333daa7663322fd1";
const HOST = "127.0.0.1";
const PORT = 8080;
const PROJECT_ID = "test-emulator";

interface Arguments {
  readonly clientPersistence: "memory" | "persistence";
  readonly diskMode: boolean;
  readonly grep?: string;
  readonly outputPath?: string;
  readonly sdkDirectory: string;
}

interface SdkGateFixture {
  readonly firebaseJsSdkRevision: string;
}

interface BrowserProcessPartition {
  readonly coverageFilter: string;
  readonly partitionName: string;
}

interface BrowserProcessPlans {
  readonly plans: Readonly<
    Record<
      "memory" | "persistence",
      {
        readonly partitionPlanSha256: string;
        readonly partitions: readonly BrowserProcessPartition[];
      }
    >
  >;
}

async function main(): Promise<void> {
  const arguments_ = parseArguments(process.argv.slice(2));
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const repositoryRoot = resolve(scriptDirectory, "../../..");
  const sdkDirectory = isAbsolute(arguments_.sdkDirectory)
    ? arguments_.sdkDirectory
    : resolve(process.cwd(), arguments_.sdkDirectory);
  const integrationDirectory = join(sdkDirectory, "integration", "firestore");
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
  const gateFixturePath = join(
    repositoryRoot,
    "conformance",
    "fixtures",
    "webchannel-v8",
    "firebase-js-sdk-integration-gate.json",
  );
  const gateFixture = JSON.parse(
    await readFile(gateFixturePath, "utf8"),
  ) as SdkGateFixture;
  if (gateFixture.firebaseJsSdkRevision !== FIREBASE_JS_SDK_REVISION) {
    throw new Error("firebase-js-sdk gate fixture revision is not pinned");
  }
  const browserProcessPlans = JSON.parse(
    await capturedCommand(
      "node",
      [
        join(scriptDirectory, "build-firebase-js-sdk-partitions.cjs"),
        sdkDirectory,
        gateFixturePath,
      ],
      repositoryRoot,
    ),
  ) as BrowserProcessPlans;
  const browserProcessPlan =
    browserProcessPlans.plans[arguments_.clientPersistence];

  const generatedMetadataFiles = [
    {
      path: join(sdkDirectory, "packages", "app", "package.json"),
      revisionPath: "packages/app/package.json",
    },
    {
      path: join(sdkDirectory, "packages", "firestore", "package.json"),
      revisionPath: "packages/firestore/package.json",
    },
  ];
  const pinnedGeneratedMetadata = await Promise.all(
    generatedMetadataFiles.map(
      async ({ revisionPath }) =>
        `${await capturedCommand(
          "git",
          ["-C", sdkDirectory, "show", `${sdkRevision}:${revisionPath}`],
          repositoryRoot,
        )}\n`,
    ),
  );
  const restoreGeneratedMetadata = await pinGeneratedMetadata(
    generatedMetadataFiles.map(({ path }, index) => ({
      path,
      pinnedContents: pinnedGeneratedMetadata[index]!,
    })),
  );

  try {
    await copyFile(
      join(sdkDirectory, "config", "ci.config.json"),
      join(sdkDirectory, "config", "project.json"),
    );

    await runCommand(
      "yarn",
      ["--cwd", join(sdkDirectory, "packages", "firestore"), "build:deps"],
      sdkDirectory,
    );
    await runCommand(
      "yarn",
      ["--cwd", integrationDirectory, `build:${arguments_.clientPersistence}`],
      sdkDirectory,
    );

    await runCommand(
      "cargo",
      ["build", "--locked", "-p", "fireside"],
      repositoryRoot,
    );

    if (await canConnect(PORT)) {
      throw new Error(
        `port ${String(PORT)} is already in use; the upstream browser harness requires its default emulator port`,
      );
    }
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "fireside-firebase-js-sdk-"),
    );
    const executable =
      process.platform === "win32" ? "fireside.exe" : "fireside";
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
      const processPartitions = [];
      for (const partition of browserProcessPlan.partitions) {
        const karmaArguments = [
          "--cwd",
          integrationDirectory,
          "karma",
          "start",
          join(scriptDirectory, "firebase-js-sdk-karma.conf.cjs"),
          "--single-run",
        ];
        const effectiveFilter = combineFilters(
          partition.coverageFilter,
          arguments_.grep,
        );
        karmaArguments.push("--grep", effectiveFilter);
        const karmaProcess = await runObservedCommand(
          "yarn",
          karmaArguments,
          sdkDirectory,
          {
            ...process.env,
            FIREBASE_JS_SDK_DIR: sdkDirectory,
            FIRESTORE_EMULATOR_PORT: String(PORT),
            FIRESTORE_EMULATOR_PROJECT_ID: PROJECT_ID,
          },
        );
        const karmaEvidence = parseKarmaEvidence(karmaProcess.output);
        if (!isAcceptedKarmaProcess(karmaProcess, karmaEvidence)) {
          throw new Error(
            `upstream Karma partition ${partition.partitionName} exited with code ${String(karmaProcess.exitCode)} and signal ${String(karmaProcess.signal)}`,
          );
        }
        processPartitions.push({
          coverageFilter: partition.coverageFilter,
          effectiveFilter,
          exitCode: karmaProcess.exitCode,
          nativeSkipOnly: karmaProcess.exitCode !== 0,
          partitionName: partition.partitionName,
          signal: karmaProcess.signal,
          ...karmaEvidence,
        });
      }
      const summary = {
        command:
          "yarn --cwd integration/firestore karma start <fireside emulator-target config> --single-run",
        clientPersistence: arguments_.clientPersistence,
        completedTests: processPartitions.reduce(
          (total, partition) => total + partition.completedTests,
          0,
        ),
        completedAt: new Date().toISOString(),
        firebaseJsSdkRevision: sdkRevision,
        filter: arguments_.grep ?? null,
        mode: arguments_.diskMode ? "disk-wal" : "memory",
        nativeSkipNames: [
          ...new Set(
            processPartitions.flatMap((partition) => partition.nativeSkipNames),
          ),
        ].sort(),
        nativeSkips: processPartitions.reduce(
          (total, partition) => total + partition.nativeSkips,
          0,
        ),
        passed: true,
        partitionPlanSha256: browserProcessPlan.partitionPlanSha256,
        processPartitions,
        projectId: PROJECT_ID,
        schemaVersion: 1,
        sdkBuildCommand: `yarn --cwd packages/firestore build:deps && yarn --cwd integration/firestore build:${arguments_.clientPersistence}`,
        sdkConfigCommand: "cp config/ci.config.json config/project.json",
        sourcePackage: "integration/firestore",
      };
      const summaryText = `${JSON.stringify(summary, null, 2)}\n`;
      if (arguments_.outputPath !== undefined) {
        const outputPath = isAbsolute(arguments_.outputPath)
          ? arguments_.outputPath
          : resolve(process.cwd(), arguments_.outputPath);
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, summaryText, "utf8");
      }
      process.stdout.write(summaryText);
    } finally {
      await stop(server);
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  } finally {
    await restoreGeneratedMetadata();
  }
}

function combineFilters(
  coverageFilter: string,
  userFilter: string | undefined,
): string {
  if (userFilter === undefined) {
    return coverageFilter;
  }
  return `(?=${coverageFilter})(?=.*(?:${userFilter}))`;
}

function parseArguments(arguments_: readonly string[]): Arguments {
  let clientPersistence: "memory" | "persistence" | undefined;
  let diskMode = false;
  let grep: string | undefined;
  let outputPath: string | undefined;
  let sdkDirectory: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--disk") {
      diskMode = true;
      continue;
    }
    if (
      argument === "--client-persistence" ||
      argument === "--grep" ||
      argument === "--output" ||
      argument === "--sdk-dir"
    ) {
      const value = arguments_[index + 1];
      if (value === undefined || value.length === 0) {
        throw new Error(`${argument} requires a value`);
      }
      if (argument === "--client-persistence") {
        if (value !== "memory" && value !== "persistence") {
          throw new Error("--client-persistence must be memory or persistence");
        }
        clientPersistence = value;
      } else if (argument === "--grep") {
        grep = value;
      } else if (argument === "--output") {
        outputPath = value;
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
  if (clientPersistence === undefined) {
    throw new Error("--client-persistence is required");
  }
  return {
    clientPersistence,
    diskMode,
    ...(grep === undefined ? {} : { grep }),
    ...(outputPath === undefined ? {} : { outputPath }),
    sdkDirectory,
  };
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

async function runObservedCommand(
  command: string,
  arguments_: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Promise<{
  readonly exitCode: number | null;
  readonly output: string;
  readonly signal: NodeJS.Signals | null;
}> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, {
      cwd,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      process.stderr.write(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolvePromise({
        exitCode: code,
        output: Buffer.concat(chunks).toString("utf8"),
        signal,
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
  await new Promise<void>((resolvePromise) =>
    server.once("exit", () => resolvePromise()),
  );
}

await main();
