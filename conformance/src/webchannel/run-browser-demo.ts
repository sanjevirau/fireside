import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";

const HOST = "127.0.0.1";
const PROJECT_ID = "demo-fireside-phase2-browser";
const JAVA_JAR_SHA256 =
  "9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c";
const VARIANTS = [
  "long-polling",
  "streaming",
  "buffering-proxy-auto-detection",
] as const;
const diskMode = process.argv.includes("--disk");
const outputPath = argumentValue("--output");
const releaseMode = process.argv.includes("--release");
const skipBuild = process.argv.includes("--skip-build");
const target = demoTarget(argumentValue("--target") ?? "fireside");
const repetitions = positiveIntegerArgument("--repetitions", 1);
const warmupRepetitions = positiveIntegerArgument("--warmup-repetitions", 0, true);

type DemoTarget = "fireside" | "java";

interface NetworkObservations {
  droppedBackchannels: number;
  droppedBackchannelAtMilliseconds?: number;
  delayedBackchannels: number;
  listenTargetIds: Set<number>;
  listenTraffic: number;
  reconnectedBackchannelAtMilliseconds?: number;
  terminateRequests: number;
  variants: Set<string>;
  writeTraffic: number;
}

interface BrowserDemoResult {
  readonly listenerDeliveryMilliseconds: readonly number[];
  readonly variant: (typeof VARIANTS)[number];
}

interface ResourceObservation {
  readonly peakRssBytes?: number;
  readonly peakVmHwmBytes?: number;
  readonly sampleCount: number;
  readonly supported: boolean;
}

const LISTENER_DELIVERY_SAMPLES = 100;
const MAXIMUM_RECONNECT_MILLISECONDS = 5_000;
const MAXIMUM_P99_MILLISECONDS: Record<(typeof VARIANTS)[number], number> = {
  "buffering-proxy-auto-detection": 2_000,
  "long-polling": 1_500,
  streaming: 1_000,
};

async function main(): Promise<void> {
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const repositoryRoot = resolve(scriptDirectory, "../../..");
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "fireside-browser-demo-"));
  const dataDirectory = diskMode ? join(temporaryDirectory, "data") : undefined;
  let browser: Browser | undefined;
  let staticServer: Server | undefined;
  let targetProcess: ChildProcess | undefined;
  let resourceMonitor: ResourceMonitor | undefined;

  try {
    if (diskMode && target !== "fireside") {
      throw new Error("--disk is only valid for the Fireside target");
    }
    if (!skipBuild && target === "fireside") {
      await runCommand(
        "cargo",
        ["build", "--locked", "-p", "fireside", ...(releaseMode ? ["--release"] : [])],
        repositoryRoot,
      );
    }
    const bundlePath = join(temporaryDirectory, "browser-demo.js");
    await build({
      bundle: true,
      entryPoints: [join(scriptDirectory, "browser-demo-entry.ts")],
      format: "iife",
      logLevel: "warning",
      outfile: bundlePath,
      platform: "browser",
      target: ["chrome120"],
    });
    const staticRuntime = await startStaticServer(await readFile(bundlePath));
    staticServer = staticRuntime.server;
    const port = await reserveAvailablePort();
    if (target === "fireside") {
      const serverArguments = [
        "--host",
        HOST,
        "--port",
        String(port),
        "--project_id",
        PROJECT_ID,
        "--single_project_mode",
        "true",
      ];
      if (dataDirectory !== undefined) {
        serverArguments.push("--data-dir", dataDirectory);
      }
      targetProcess = startProcess(
        join(
          repositoryRoot,
          "target",
          releaseMode ? "release" : "debug",
          process.platform === "win32" ? "fireside.exe" : "fireside",
        ),
        serverArguments,
        repositoryRoot,
      );
      resourceMonitor = startResourceMonitor(targetProcess);
      await waitForHttp(
        `http://${HOST}:${String(port)}/emulator/v1/debug/memory`,
        30_000,
      );
    } else {
      const javaJar = process.env.FIRESTORE_EMULATOR_JAR ??
        join(
          process.env.HOME ?? "",
          ".cache/firebase/emulators/cloud-firestore-emulator-v1.22.0.jar",
        );
      const jarHash = createHash("sha256").update(await readFile(javaJar)).digest("hex");
      if (jarHash !== JAVA_JAR_SHA256) {
        throw new Error(
          `official Java emulator hash mismatch: expected ${JAVA_JAR_SHA256}, found ${jarHash}`,
        );
      }
      targetProcess = startProcess(
        process.env.JAVA ?? "java",
        [
          "-jar",
          javaJar,
          "--host",
          HOST,
          "--port",
          String(port),
          "--project_id",
          PROJECT_ID,
          "--single_project_mode",
          "true",
        ],
        repositoryRoot,
      );
      resourceMonitor = startResourceMonitor(targetProcess);
      await waitForHttp(`http://${HOST}:${String(port)}`, 30_000);
    }
    browser = await chromium.launch({
      executablePath: await resolveChromiumExecutable(),
      headless: true,
    });

    const results: unknown[] = [];
    const totalRepetitions = warmupRepetitions + repetitions;
    for (let repetition = 0; repetition < totalRepetitions; repetition += 1) {
      const measured = repetition >= warmupRepetitions;
      for (const variant of VARIANTS) {
        const page = await browser.newPage();
        try {
          const observations = await observeWebChannel(page, variant);
          await page.goto(staticRuntime.origin, { waitUntil: "domcontentloaded" });
          const runId = [
            variant,
            target,
            diskMode ? "disk" : "memory",
            measured ? `measured-${String(repetition - warmupRepetitions + 1)}` : `warmup-${String(repetition + 1)}`,
            Date.now().toString(36),
          ].join("-");
          const result = await page.evaluate(
          async ({ host, projectId, runId, variant }) => {
            const demoWindow = window as Window & {
              firesideRunWebChannelDemo(configuration: {
                readonly host: string;
                readonly projectId: string;
                readonly runId: string;
                readonly variant:
                  | "buffering-proxy-auto-detection"
                  | "long-polling"
                  | "streaming";
              }): Promise<unknown>;
            };
            return await demoWindow.firesideRunWebChannelDemo({
              host,
              projectId,
              runId,
              variant,
            });
          },
          {
            host: `${HOST}:${String(port)}`,
            projectId: PROJECT_ID,
            runId,
            variant,
          },
        );
          assertNetworkContract(variant, observations);
          const benchmark = assertListenerDeliveryContract(variant, result);
          if (measured) {
            results.push({
              benchmark,
              network: serializeObservations(observations),
              repetition: repetition - warmupRepetitions + 1,
              result,
            });
          }
        } finally {
          await page.close();
        }
      }
    }

    const resources = await resourceMonitor.stop();
    resourceMonitor = undefined;

    const summary = {
      browserVersion: await browser.version(),
      completedAt: new Date().toISOString(),
      mode: diskMode ? "disk-wal" : "memory",
      passed: true,
      projectId: PROJECT_ID,
      repetitions,
      resources,
      results,
      schemaVersion: 1,
      target,
      targetVersion: target === "java" ? "1.22.0" : "repository-revision",
      warmupRepetitions,
    };
    const summaryText = `${JSON.stringify(summary, null, 2)}\n`;
    if (outputPath !== undefined) {
      const resolvedOutputPath = resolve(process.cwd(), outputPath);
      await mkdir(dirname(resolvedOutputPath), { recursive: true });
      await writeFile(resolvedOutputPath, summaryText, "utf8");
    }
    process.stdout.write(summaryText);
  } finally {
    await browser?.close();
    if (staticServer !== undefined) {
      await closeServer(staticServer);
    }
    if (resourceMonitor !== undefined) {
      await resourceMonitor.stop();
    }
    if (targetProcess !== undefined) {
      await stopProcess(targetProcess);
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function demoTarget(value: string): DemoTarget {
  if (value !== "fireside" && value !== "java") {
    throw new Error(`--target must be fireside or java, found ${value}`);
  }
  return value;
}

function positiveIntegerArgument(
  name: string,
  fallback: number,
  allowZero = false,
): number {
  const value = argumentValue(name);
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new Error(`${name} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
  }
  return parsed;
}

async function observeWebChannel(
  page: Page,
  variant: (typeof VARIANTS)[number],
): Promise<NetworkObservations> {
  const observations: NetworkObservations = {
    droppedBackchannels: 0,
    delayedBackchannels: 0,
    listenTargetIds: new Set(),
    listenTraffic: 0,
    terminateRequests: 0,
    variants: new Set(),
    writeTraffic: 0,
  };
  await page.route("**/google.firestore.v1.Firestore/*/channel?**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const isListen = url.pathname.endsWith("/Listen/channel");
    if (isListen) {
      observations.listenTraffic += 1;
      collectTargetIds(request.postData(), observations.listenTargetIds);
    } else if (url.pathname.endsWith("/Write/channel")) {
      observations.writeTraffic += 1;
    }
    const ci = url.searchParams.get("CI");
    if (ci !== null) {
      observations.variants.add(ci);
    }
    if (url.searchParams.get("TYPE") === "terminate") {
      observations.terminateRequests += 1;
    }
    if (
      observations.droppedBackchannels === 0 &&
      isListen &&
      request.method() === "GET" &&
      url.searchParams.get("RID") === "rpc"
    ) {
      observations.droppedBackchannels += 1;
      observations.droppedBackchannelAtMilliseconds = performance.now();
      await route.abort("connectionreset");
      return;
    }
    if (
      observations.reconnectedBackchannelAtMilliseconds === undefined &&
      observations.droppedBackchannelAtMilliseconds !== undefined &&
      isListen &&
      request.method() === "GET" &&
      url.searchParams.get("RID") === "rpc"
    ) {
      observations.reconnectedBackchannelAtMilliseconds = performance.now();
    }
    if (
      variant === "buffering-proxy-auto-detection" &&
      observations.delayedBackchannels === 0 &&
      isListen &&
      request.method() === "GET" &&
      url.searchParams.get("RID") === "rpc"
    ) {
      observations.delayedBackchannels += 1;
      await delay(1_000);
    }
    await route.continue();
  });
  return observations;
}

function collectTargetIds(body: string | null, targetIds: Set<number>): void {
  if (body === null) {
    return;
  }
  const form = new URLSearchParams(body);
  for (const [name, value] of form.entries()) {
    if (!name.endsWith("___data__")) {
      continue;
    }
    try {
      const parsed = JSON.parse(value) as {
        readonly addTarget?: { readonly targetId?: number };
      };
      if (typeof parsed.addTarget?.targetId === "number") {
        targetIds.add(parsed.addTarget.targetId);
      }
    } catch {
      // A malformed request will fail in the browser; keep network observation passive.
    }
  }
}

function assertNetworkContract(
  variant: (typeof VARIANTS)[number],
  observations: NetworkObservations,
): void {
  const expectedCi =
    variant === "long-polling"
      ? ["1"]
      : variant === "buffering-proxy-auto-detection"
        ? ["0", "1"]
        : ["0"];
  for (const ci of expectedCi) {
    if (!observations.variants.has(ci)) {
      throw new Error(`${variant} emitted no CI=${ci} backchannel`);
    }
  }
  if (
    variant === "buffering-proxy-auto-detection" &&
    observations.delayedBackchannels !== 1
  ) {
    throw new Error("buffering-proxy scenario did not delay a backchannel");
  }
  if (observations.listenTraffic === 0 || observations.writeTraffic === 0) {
    throw new Error(`${variant} did not exercise both Listen and Write WebChannels`);
  }
  if (observations.listenTargetIds.size < 2) {
    throw new Error(`${variant} did not multiplex two listener target IDs`);
  }
  if (observations.droppedBackchannels !== 1) {
    throw new Error(`${variant} did not recover from the forced backchannel loss`);
  }
  const reconnectMilliseconds = reconnectDuration(observations);
  if (reconnectMilliseconds === undefined) {
    throw new Error(`${variant} did not reopen its dropped backchannel`);
  }
  if (reconnectMilliseconds > MAXIMUM_RECONNECT_MILLISECONDS) {
    throw new Error(
      `${variant} backchannel reconnect ${reconnectMilliseconds.toFixed(3)} ms exceeds ${String(MAXIMUM_RECONNECT_MILLISECONDS)} ms`,
    );
  }
  if (observations.terminateRequests < 2) {
    throw new Error(`${variant} did not terminate both Listen and Write channels`);
  }
}

function serializeObservations(observations: NetworkObservations): unknown {
  return {
    droppedBackchannels: observations.droppedBackchannels,
    delayedBackchannels: observations.delayedBackchannels,
    listenTargetIds: [...observations.listenTargetIds].sort((left, right) => left - right),
    listenTraffic: observations.listenTraffic,
    reconnectMilliseconds: reconnectDuration(observations),
    terminateRequests: observations.terminateRequests,
    variants: [...observations.variants].sort(),
    writeTraffic: observations.writeTraffic,
  };
}

function assertListenerDeliveryContract(
  variant: (typeof VARIANTS)[number],
  result: unknown,
): {
  readonly maximumMilliseconds: number;
  readonly p99Milliseconds: number;
  readonly sampleCount: number;
  readonly thresholdMilliseconds: number;
} {
  if (typeof result !== "object" || result === null) {
    throw new Error(`${variant} browser demo returned no result`);
  }
  const candidate = result as Partial<BrowserDemoResult>;
  const samples = candidate.listenerDeliveryMilliseconds;
  if (!Array.isArray(samples) || samples.length !== LISTENER_DELIVERY_SAMPLES) {
    throw new Error(
      `${variant} recorded ${String(samples?.length ?? 0)} listener samples; expected ${String(LISTENER_DELIVERY_SAMPLES)}`,
    );
  }
  if (!samples.every((value) => Number.isFinite(value) && value >= 0)) {
    throw new Error(`${variant} recorded an invalid listener-delivery sample`);
  }
  const p99Milliseconds = percentile(samples, 0.99);
  const maximumMilliseconds = Math.max(...samples);
  const thresholdMilliseconds = MAXIMUM_P99_MILLISECONDS[variant];
  if (p99Milliseconds > thresholdMilliseconds) {
    throw new Error(
      `${variant} listener-delivery p99 ${p99Milliseconds.toFixed(3)} ms exceeds ${String(thresholdMilliseconds)} ms`,
    );
  }
  return {
    maximumMilliseconds,
    p99Milliseconds,
    sampleCount: samples.length,
    thresholdMilliseconds,
  };
}

function reconnectDuration(observations: NetworkObservations): number | undefined {
  const droppedAt = observations.droppedBackchannelAtMilliseconds;
  const reconnectedAt = observations.reconnectedBackchannelAtMilliseconds;
  return droppedAt === undefined || reconnectedAt === undefined
    ? undefined
    : reconnectedAt - droppedAt;
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(fraction * sorted.length) - 1),
  );
  return sorted[index] ?? Number.NaN;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve_) => setTimeout(resolve_, milliseconds));
}

interface ResourceMonitor {
  stop(): Promise<ResourceObservation>;
}

function startResourceMonitor(child: ChildProcess): ResourceMonitor {
  const pid = child.pid;
  if (process.platform !== "linux" || pid === undefined) {
    return {
      async stop(): Promise<ResourceObservation> {
        return { sampleCount: 0, supported: false };
      },
    };
  }

  let stopped = false;
  let peakRssBytes = 0;
  let peakVmHwmBytes = 0;
  let sampleCount = 0;
  const finished = (async () => {
    while (!stopped) {
      try {
        const status = await readFile(`/proc/${String(pid)}/status`, "utf8");
        const rssBytes = procStatusKilobytes(status, "VmRSS") * 1024;
        const hwmBytes = procStatusKilobytes(status, "VmHWM") * 1024;
        peakRssBytes = Math.max(peakRssBytes, rssBytes);
        peakVmHwmBytes = Math.max(peakVmHwmBytes, hwmBytes);
        sampleCount += 1;
      } catch {
        if (child.exitCode !== null || child.signalCode !== null) {
          break;
        }
      }
      await delay(100);
    }
  })();

  return {
    async stop(): Promise<ResourceObservation> {
      stopped = true;
      await finished;
      return {
        peakRssBytes,
        peakVmHwmBytes,
        sampleCount,
        supported: true,
      };
    },
  };
}

function procStatusKilobytes(status: string, name: string): number {
  const match = new RegExp(`^${name}:\\s+(\\d+)\\s+kB$`, "m").exec(status);
  if (match?.[1] === undefined) {
    return 0;
  }
  return Number(match[1]);
}

async function startStaticServer(bundle: Buffer): Promise<{
  readonly origin: string;
  readonly server: Server;
}> {
  const server = createServer((request, response) => {
    if (request.url === "/browser-demo.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(bundle);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><meta charset=utf-8><script src=/browser-demo.js></script>");
  });
  await new Promise<void>((resolve_, reject) => {
    server.once("error", reject);
    server.listen(0, HOST, resolve_);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("static browser server did not expose a TCP address");
  }
  return { origin: `http://${HOST}:${String(address.port)}`, server };
}

async function resolveChromiumExecutable(): Promise<string> {
  const candidates = [
    process.env.CHROMIUM_PATH,
    chromium.executablePath(),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/opt/homebrew/bin/chromium",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
  ].filter((candidate): candidate is string => candidate !== undefined);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next explicitly bounded executable candidate.
    }
  }
  throw new Error("no Chromium executable found; set CHROMIUM_PATH");
}

function startProcess(
  executable: string,
  arguments_: readonly string[],
  workingDirectory: string,
): ChildProcess {
  const child = spawn(executable, arguments_, {
    cwd: workingDirectory,
    env: process.env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let standardError = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    standardError = `${standardError}${chunk}`.slice(-65_536);
  });
  child.once("exit", (code, signal) => {
    if (code !== 0 && code !== 143 && signal === null) {
      process.stderr.write(`${executable} exited with ${String(code)}:\n${standardError}\n`);
    }
  });
  return child;
}

async function runCommand(
  executable: string,
  arguments_: readonly string[],
  workingDirectory: string,
): Promise<void> {
  await new Promise<void>((resolve_, reject) => {
    const child = spawn(executable, arguments_, {
      cwd: workingDirectory,
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve_();
      } else {
        reject(new Error(`${executable} exited with ${String(code)} (${String(signal)})`));
      }
    });
  });
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve_) => child.once("exit", () => resolve_())),
    new Promise<void>((resolve_) => setTimeout(resolve_, 5_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}

async function waitForHttp(url: string, timeoutMilliseconds: number): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise<void>((resolve_) => setTimeout(resolve_, 100));
  }
  throw new Error(`timed out waiting for ${url}: ${String(lastError)}`);
}

async function reserveAvailablePort(): Promise<number> {
  const server = createNetServer();
  return await new Promise<number>((resolve_, reject) => {
    server.once("error", reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("failed to reserve a loopback TCP port"));
        return;
      }
      server.close((error) => error === undefined ? resolve_(address.port) : reject(error));
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve_, reject) => {
    server.close((error) => error === undefined ? resolve_() : reject(error));
  });
}

await main();
