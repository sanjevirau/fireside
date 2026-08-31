import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { GoogleAuth } from "google-auth-library";
import { chromium, type Browser, type Page } from "playwright";

import {
  decodeCaptureFixture,
  type CaptureFixture,
} from "./capture-contract.ts";

const JAVA_PROJECT_ID = "demo-fireside-phase2";
const CLOUD_PROJECT_ID = "fireside-conformance";
const COLLECTION = "fireside_webchannel_capture";
const DOCUMENT = "oracle";
const CAPTURE_FIXTURE_PATH = "/__fireside_capture/fixture";
const FIREBASE_SDK = "firebase@12.18.0";
const JAVA_VERSION = "1.22.0";
const JAVA_JAR_SHA256 =
  "9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c";

type CaptureTarget = "cloud" | "java";
type BrowserScenario =
  | "aggregation-count"
  | "listen"
  | "reconnect-replay"
  | "unicode-framing"
  | "unknown-sid"
  | "write"
  | "write-overlap";
type TransportVariant = "long-poll" | "streaming";

interface CaptureCase {
  readonly directory: string;
  readonly fixtureRoot?: "rest-v1" | "webchannel-v8";
  readonly hypothesis: string;
  readonly runs: readonly BrowserRun[];
  readonly transport?: "http1" | "web-channel";
}

interface BrowserRun {
  readonly dropFirstBackchannel?: boolean;
  readonly scenario: BrowserScenario;
  readonly variant: TransportVariant;
}

interface TargetRuntime {
  readonly accessToken?: string;
  readonly apiKey: string;
  readonly outputName: string;
  readonly projectId: string;
  readonly targetVersion: string;
  readonly upstreamOrigin: string;
  readonly javaProcess?: ChildProcess;
}

const CAPTURE_CASES: readonly CaptureCase[] = [
  {
    directory: "aggregation-count",
    fixtureRoot: "rest-v1",
    hypothesis: "Browser RunAggregationQuery count request and response envelope",
    runs: [{ scenario: "aggregation-count", variant: "long-poll" }],
    transport: "http1",
  },
  {
    directory: "listen-long-poll",
    hypothesis: "Listen handshake and backchannel in forced long-polling mode",
    runs: [{ scenario: "listen", variant: "long-poll" }],
  },
  {
    directory: "listen-streaming",
    hypothesis: "Listen handshake and backchannel in streaming mode",
    runs: [{ scenario: "listen", variant: "streaming" }],
  },
  {
    directory: "write-long-poll",
    hypothesis: "Write handshake and acknowledgement in forced long-polling mode",
    runs: [{ scenario: "write", variant: "long-poll" }],
  },
  {
    directory: "write-streaming",
    hypothesis: "Write handshake and acknowledgement in streaming mode",
    runs: [{ scenario: "write", variant: "streaming" }],
  },
  {
    directory: "write-overlap",
    hypothesis: "Two writes may be in flight with the last acknowledged stream token",
    runs: [
      { scenario: "write-overlap", variant: "long-poll" },
      { scenario: "write-overlap", variant: "streaming" },
    ],
  },
  {
    directory: "backchannel-reconnect-replay",
    hypothesis: "A lost streaming Listen backchannel reopens with replay bookkeeping",
    runs: [
      {
        dropFirstBackchannel: true,
        scenario: "reconnect-replay",
        variant: "streaming",
      },
    ],
  },
  {
    directory: "unicode-framing",
    hypothesis: "CJK, emoji, combining, and mixed text use UTF-16 frame lengths",
    runs: [
      { scenario: "unicode-framing", variant: "long-poll" },
      { scenario: "unicode-framing", variant: "streaming" },
    ],
  },
  {
    directory: "unknown-sid",
    hypothesis: "An unknown session returns the exact browser-visible HTTP 400 body",
    runs: [{ scenario: "unknown-sid", variant: "long-poll" }],
  },
];

async function main(): Promise<void> {
  const target = parseTarget(process.argv.slice(2));
  const requestedCase = parseCaptureCase(process.argv.slice(2));
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const repositoryRoot = resolve(scriptDirectory, "../../..");
  const conformanceRoot = join(repositoryRoot, "conformance");
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "fireside-webchannel-capture-"),
  );
  let runtime: TargetRuntime | undefined;
  let staticServer: Server | undefined;
  let browser: Browser | undefined;

  try {
    const bundlePath = join(temporaryDirectory, "browser-capture.js");
    await build({
      bundle: true,
      entryPoints: [join(scriptDirectory, "browser-capture-entry.ts")],
      format: "iife",
      logLevel: "warning",
      outfile: bundlePath,
      platform: "browser",
      target: ["chrome120"],
    });
    const bundle = await readFile(bundlePath);
    const staticRuntime = await startStaticServer(bundle);
    staticServer = staticRuntime.server;
    runtime = target === "java"
      ? await startJavaTarget()
      : await resolveCloudTarget();

    await runCommand("cargo", ["build", "--locked", "-p", "fireside"], repositoryRoot);
    browser = await chromium.launch({
      executablePath: await resolveChromiumExecutable(),
      headless: true,
    });

    for (const captureCase of CAPTURE_CASES.filter((value) =>
      requestedCase === undefined || value.directory === requestedCase
    )) {
      await captureCaseAgainstTarget({
        browser,
        captureCase,
        conformanceRoot,
        repositoryRoot,
        runtime,
        staticOrigin: staticRuntime.origin,
      });
    }
  } finally {
    await browser?.close();
    if (staticServer !== undefined) {
      await closeServer(staticServer);
    }
    if (runtime?.javaProcess !== undefined) {
      await stopProcess(runtime.javaProcess);
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function captureCaseAgainstTarget(options: {
  readonly browser: Browser;
  readonly captureCase: CaptureCase;
  readonly conformanceRoot: string;
  readonly repositoryRoot: string;
  readonly runtime: TargetRuntime;
  readonly staticOrigin: string;
}): Promise<void> {
  const { browser, captureCase, conformanceRoot, repositoryRoot, runtime } = options;
  await prepareSyntheticDocument(runtime, captureCase);
  const proxyPort = await reserveAvailablePort();
  const proxyAddress = `127.0.0.1:${String(proxyPort)}`;
  const recordedAt = new Date().toISOString();
  const proxy = startProcess(
    join(repositoryRoot, "target/debug/fireside"),
    [
      "capture-proxy",
      "--host",
      "127.0.0.1",
      "--port",
      String(proxyPort),
      "--upstream",
      runtime.upstreamOrigin,
      "--hypothesis",
      captureCase.hypothesis,
      "--target",
      runtime.outputName,
      "--target-version",
      runtime.targetVersion,
      "--sdk",
      FIREBASE_SDK,
      "--recorded-at",
      recordedAt,
      "--transport",
      captureCase.transport ?? "web-channel",
    ],
    repositoryRoot,
  );

  try {
    await waitForHttp(`http://${proxyAddress}${CAPTURE_FIXTURE_PATH}`, 10_000);
    for (const run of captureCase.runs) {
      const page = await browser.newPage();
      try {
        if (run.dropFirstBackchannel === true) {
          await abortFirstListenBackchannel(page);
        }
        await page.goto(options.staticOrigin, { waitUntil: "domcontentloaded" });
        const result = await page.evaluate(
          async ({ accessToken, apiKey, host, projectId, scenario, variant }) => {
            const captureWindow = window as Window & {
              firesideRunWebChannelCapture(configuration: {
                readonly accessToken?: string;
                readonly apiKey: string;
                readonly host: string;
                readonly projectId: string;
                readonly scenario: string;
                readonly variant: string;
              }): Promise<unknown>;
            };
            return await captureWindow.firesideRunWebChannelCapture({
              ...(accessToken === undefined ? {} : { accessToken }),
              apiKey,
              host,
              projectId,
              scenario,
              variant,
            });
          },
          {
            ...(runtime.accessToken === undefined
              ? {}
              : { accessToken: runtime.accessToken }),
            apiKey: runtime.apiKey,
            host: proxyAddress,
            projectId: runtime.projectId,
            scenario: run.scenario,
            variant: run.variant,
          },
        );
        process.stdout.write(
          `${runtime.outputName}/${captureCase.directory}: ${JSON.stringify(result)}\n`,
        );
      } finally {
        await page.close();
      }
    }

    const fixtureResponse = await fetch(
      `http://${proxyAddress}${CAPTURE_FIXTURE_PATH}`,
    );
    if (!fixtureResponse.ok) {
      throw new Error(
        `capture snapshot failed with HTTP ${String(fixtureResponse.status)}: ${await fixtureResponse.text()}`,
      );
    }
    const fixture = await fixtureResponse.json() as CaptureFixture;
    assertFixtureIsSafeAndComplete(fixture, runtime.apiKey);
    const contract = decodeCaptureFixture(fixture);
    const outputDirectory = join(
      conformanceRoot,
      `fixtures/${captureCase.fixtureRoot ?? "webchannel-v8"}`,
      runtime.outputName,
      captureCase.directory,
    );
    await mkdir(outputDirectory, { recursive: true });
    const fixtureJson = `${JSON.stringify(fixture, null, 2)}\n`;
    const contractJson = `${JSON.stringify(contract, null, 2)}\n`;
    await writeFile(join(outputDirectory, "fixture.json"), fixtureJson, "utf8");
    await writeFile(
      join(outputDirectory, "decoded-contract.json"),
      contractJson,
      "utf8",
    );
    const sums = [
      `${sha256(fixtureJson)}  fixture.json`,
      `${sha256(contractJson)}  decoded-contract.json`,
    ];
    await writeFile(join(outputDirectory, "SHA256SUMS"), `${sums.join("\n")}\n`, "utf8");
  } finally {
    await stopProcess(proxy);
    await deleteSyntheticDocument(runtime);
  }
}

async function startJavaTarget(): Promise<TargetRuntime> {
  const port = await reserveAvailablePort();
  const javaJar = process.env.FIRESTORE_EMULATOR_JAR ??
    join(
      process.env.HOME ?? "",
      ".cache/firebase/emulators/cloud-firestore-emulator-v1.22.0.jar",
    );
  const jarBytes = await readFile(javaJar);
  const observedHash = createHash("sha256").update(jarBytes).digest("hex");
  if (observedHash !== JAVA_JAR_SHA256) {
    throw new Error(
      `official Java emulator hash mismatch: expected ${JAVA_JAR_SHA256}, found ${observedHash}`,
    );
  }
  const javaProcess = startProcess(
    process.env.JAVA ?? "java",
    [
      "-jar",
      javaJar,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--project_id",
      JAVA_PROJECT_ID,
      "--single_project_mode",
      "true",
    ],
    process.cwd(),
  );
  const upstreamOrigin = `http://127.0.0.1:${String(port)}`;
  await waitForHttp(upstreamOrigin, 20_000);

  return {
    apiKey: "fireside-synthetic-emulator-key",
    javaProcess,
    outputName: "java-v1.22.0",
    projectId: JAVA_PROJECT_ID,
    targetVersion: JAVA_VERSION,
    upstreamOrigin,
  };
}

async function resolveCloudTarget(): Promise<TargetRuntime> {
  if (
    process.env.CONFORMANCE_CLOUD_PROJECT !== CLOUD_PROJECT_ID ||
    process.env.CONFORMANCE_CLOUD_ALLOWLIST !== CLOUD_PROJECT_ID
  ) {
    throw new Error(
      `cloud capture requires CONFORMANCE_CLOUD_PROJECT and CONFORMANCE_CLOUD_ALLOWLIST to equal ${CLOUD_PROJECT_ID}`,
    );
  }
  const apiKey = process.env.FIREBASE_WEB_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error("cloud capture requires FIREBASE_WEB_API_KEY");
  }
  const auth = new GoogleAuth({
    projectId: CLOUD_PROJECT_ID,
    scopes: ["https://www.googleapis.com/auth/datastore"],
  });
  const accessToken = await auth.getAccessToken();
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new Error("Application Default Credentials returned no cloud access token");
  }
  cloudAccessToken = accessToken;

  return {
    accessToken,
    apiKey,
    outputName: "production-cloud-firestore",
    projectId: CLOUD_PROJECT_ID,
    targetVersion: "production-2026-08-31",
    upstreamOrigin: "https://firestore.googleapis.com",
  };
}

let cloudAccessToken: string | undefined;

async function prepareSyntheticDocument(
  runtime: TargetRuntime,
  captureCase: CaptureCase,
): Promise<void> {
  await deleteSyntheticDocument(runtime);
  if (captureCase.runs.some((run) => run.scenario === "aggregation-count")) {
    for (const [document, sequence] of [[DOCUMENT, 1], ["oracle-second", 2]] as const) {
      const response = await firestoreRestRequest(runtime, "PATCH", {
        fields: {
          capture: { stringValue: captureCase.directory },
          sequence: { integerValue: String(sequence) },
          synthetic: { booleanValue: true },
        },
      }, document);
      if (!response.ok) {
        throw new Error(
          `synthetic aggregate seed failed with HTTP ${String(response.status)}: ${await response.text()}`,
        );
      }
    }
    return;
  }
  if (!captureCase.runs.some((run) =>
    run.scenario === "listen" || run.scenario === "reconnect-replay"
  )) {
    return;
  }
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString();
  const response = await firestoreRestRequest(runtime, "PATCH", {
    fields: {
      _fireside_expires_at: { timestampValue: expiresAt },
      capture: { stringValue: captureCase.directory },
      synthetic: { booleanValue: true },
    },
  });
  if (!response.ok) {
    throw new Error(
      `synthetic seed failed with HTTP ${String(response.status)}: ${await response.text()}`,
    );
  }
}

async function deleteSyntheticDocument(runtime: TargetRuntime): Promise<void> {
  for (const document of [DOCUMENT, "oracle-first", "oracle-second"]) {
    const response = await firestoreRestRequest(runtime, "DELETE", undefined, document);
    if (!response.ok && response.status !== 404) {
      throw new Error(
        `synthetic cleanup failed with HTTP ${String(response.status)}: ${await response.text()}`,
      );
    }
  }
}

async function firestoreRestRequest(
  runtime: TargetRuntime,
  method: "DELETE" | "PATCH",
  body?: unknown,
  document = DOCUMENT,
): Promise<Response> {
  const url =
    `${runtime.upstreamOrigin}/v1/projects/${runtime.projectId}/databases/(default)/documents/${COLLECTION}/${document}`;
  const headers = new Headers();
  if (body !== undefined) {
    headers.set("content-type", "application/json");
  }
  if (runtime.outputName === "production-cloud-firestore") {
    if (cloudAccessToken === undefined) {
      throw new Error("cloud access token was not initialized");
    }
    headers.set("authorization", `Bearer ${cloudAccessToken}`);
  }
  return await fetch(url, {
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers,
    method,
  });
}

async function abortFirstListenBackchannel(page: Page): Promise<void> {
  let dropped = false;
  await page.route("**/google.firestore.v1.Firestore/Listen/channel?**", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (
      !dropped &&
      route.request().method() === "GET" &&
      requestUrl.searchParams.get("RID") === "rpc"
    ) {
      dropped = true;
      await route.abort("connectionreset");
      return;
    }
    await route.continue();
  });
}

function assertFixtureIsSafeAndComplete(
  fixture: CaptureFixture,
  apiKey: string,
): void {
  if (fixture.schemaVersion !== 1 || fixture.exchanges.length === 0) {
    throw new Error("capture fixture is empty or uses an unexpected schema");
  }
  const serialized = JSON.stringify(fixture);
  if (serialized.includes(apiKey)) {
    throw new Error("capture fixture contains the browser API key");
  }
  if (/Bearer\s+(?!\[REDACTED\])/iu.test(serialized)) {
    throw new Error("capture fixture contains an unredacted bearer credential");
  }
  if (fixture.exchanges.some((exchange) => exchange.response.status === 0)) {
    throw new Error("capture fixture contains an exchange without response headers");
  }
}

async function startStaticServer(bundle: Buffer): Promise<{
  readonly origin: string;
  readonly server: Server;
}> {
  const server = createServer((request, response) => {
    if (request.url === "/browser-capture.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(bundle);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      "<!doctype html><meta charset=utf-8><script src=/browser-capture.js></script>",
    );
  });
  await new Promise<void>((resolve_, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve_);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("static browser server did not expose a TCP address");
  }
  return { origin: `http://127.0.0.1:${String(address.port)}`, server };
}

async function resolveChromiumExecutable(): Promise<string> {
  const candidates = [
    process.env.CHROMIUM_PATH,
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

function parseTarget(arguments_: readonly string[]): CaptureTarget {
  const targetIndex = arguments_.indexOf("--target");
  const target = targetIndex < 0 ? undefined : arguments_[targetIndex + 1];
  if (target === "cloud" || target === "java") {
    return target;
  }
  throw new Error("capture requires --target java or --target cloud");
}

function parseCaptureCase(arguments_: readonly string[]): string | undefined {
  const caseIndex = arguments_.indexOf("--case");
  if (caseIndex < 0) {
    return undefined;
  }
  const requestedCase = arguments_[caseIndex + 1];
  if (CAPTURE_CASES.some((value) => value.directory === requestedCase)) {
    return requestedCase;
  }
  throw new Error(`unknown capture case: ${String(requestedCase)}`);
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
      process.stderr.write(
        `${executable} exited with ${String(code)}:\n${standardError}\n`,
      );
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
        reject(
          new Error(
            `${executable} exited with ${String(code)} (${String(signal)})`,
          ),
        );
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
      await fetch(url);
      return;
    } catch (error) {
      lastError = error;
      await new Promise<void>((resolve_) => setTimeout(resolve_, 100));
    }
  }
  throw new Error(`timed out waiting for ${url}: ${String(lastError)}`);
}

async function reserveAvailablePort(): Promise<number> {
  const server = createNetServer();
  return await new Promise<number>((resolve_, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("failed to reserve a loopback TCP port"));
        return;
      }
      server.close((error) => {
        if (error === undefined) {
          resolve_(address.port);
        } else {
          reject(error);
        }
      });
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve_, reject) => {
    server.close((error) => error === undefined ? resolve_() : reject(error));
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

await main();
