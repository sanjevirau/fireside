import { createServer } from "node:http";
import { createRequire } from "node:module";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { chromium } from "playwright";

interface Arguments {
  readonly authPort: number;
  readonly firestorePort: number;
  readonly functionsPort: number;
  readonly host: string;
  readonly output: string;
  readonly projectId: string;
  readonly storagePort: number;
  readonly twodartDirectory: string;
}

const arguments_ = parseArguments(process.argv.slice(2));
const runId = `phase4-browser-${Date.now()}-${crypto.randomUUID()}`;
const uid = `${runId}-user`;
const email = `${uid}@example.test`;
const password = `Phase4-${crypto.randomUUID()}!`;
const defaultBucket = `${arguments_.projectId}.appspot.com`;
const assetsBucket = "assets-local.twodart.com";
const temporaryDirectory = await mkdtemp(join(tmpdir(), "fireside-phase4-browser-"));
const requireFromTwodart = createRequire(
  join(resolve(arguments_.twodartDirectory), "package.json"),
);
const firebaseJsSdkVersion = await packageVersion(
  arguments_.twodartDirectory,
  "firebase",
);
const app = prepareAdminApp();
const { getAuth } = requireFromTwodart("firebase-admin/auth") as {
  readonly getAuth: (value: unknown) => {
    createUser(input: unknown): Promise<unknown>;
    deleteUser(value: string): Promise<unknown>;
  };
};
const { getStorage } = requireFromTwodart("firebase-admin/storage") as {
  readonly getStorage: (value: unknown) => {
    bucket(name: string): {
      file(path: string): {
        delete(options?: unknown): Promise<unknown>;
        save(bytes: string, options?: unknown): Promise<unknown>;
      };
    };
  };
};
const { deleteApp } = requireFromTwodart("firebase-admin/app") as {
  readonly deleteApp: (value: unknown) => Promise<void>;
};
const assetPath = `_firesidePhase4/${runId}/public-火🔥.txt`;
const asset = getStorage(app).bucket(assetsBucket).file(assetPath);

try {
  await getAuth(app).createUser({
    email,
    emailVerified: true,
    password,
    uid,
  });
  await asset.save(`public asset ${runId} 火🔥`, {
    metadata: { contentType: "text/plain; charset=utf-8" },
  });
  const entry = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "phase4-browser-entry.ts",
  );
  await build({
    alias: {
      firebase: join(resolve(arguments_.twodartDirectory), "node_modules", "firebase"),
    },
    bundle: true,
    entryPoints: [entry],
    format: "esm",
    logLevel: "warning",
    outfile: join(temporaryDirectory, "bundle.js"),
    platform: "browser",
    sourcemap: true,
    target: ["es2022"],
  });
  const config = {
    assetsBucket,
    authPort: arguments_.authPort,
    defaultBucket,
    email,
    firestorePort: arguments_.firestorePort,
    functionsPort: arguments_.functionsPort,
    host: arguments_.host,
    password,
    projectId: arguments_.projectId,
    runId,
    storagePort: arguments_.storagePort,
    uid,
  };
  await writeFile(
    join(temporaryDirectory, "index.html"),
    `<!doctype html><meta charset="utf-8"><title>Fireside Phase 4</title><script>window.__PHASE4_CONFIG__=${JSON.stringify(config)}</script><script type="module" src="/bundle.js"></script>`,
  );
  const server = createServer(async (request, response) => {
    const path = request.url === "/bundle.js" ? "bundle.js" : "index.html";
    try {
      const bytes = await readFile(join(temporaryDirectory, path));
      response.writeHead(200, {
        "content-type": path.endsWith(".js")
          ? "text/javascript; charset=utf-8"
          : "text/html; charset=utf-8",
      });
      response.end(bytes);
    } catch {
      response.writeHead(404).end();
    }
  });
  const port = await listen(server);
  const executablePath = await localBrowserExecutable();
  const browser = await chromium.launch(
    executablePath === undefined ? { headless: true } : { executablePath, headless: true },
  );
  try {
    const page = await browser.newPage();
    const browserErrors: string[] = [];
    const networkErrors: string[] = [];
    const consoleErrors: string[] = [];
    page.on("pageerror", (error) => browserErrors.push(error.stack ?? error.message));
    page.on("requestfailed", (request) => {
      networkErrors.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "failed"}`);
    });
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    await page.goto(`http://127.0.0.1:${String(port)}/`, { waitUntil: "load" });
    try {
      await page.waitForFunction(() => window.__PHASE4_RESULT__ !== undefined, undefined, {
        timeout: 60_000,
      });
    } catch (error) {
      const stage = await page.evaluate(() => window.__PHASE4_STAGE__);
      throw new Error(
        `Phase 4 browser timed out at ${stage ?? "unknown"}: ${error instanceof Error ? error.message : String(error)}; console=${JSON.stringify(consoleErrors)} network=${JSON.stringify(networkErrors)}`,
      );
    }
    const result = await page.evaluate(() => window.__PHASE4_RESULT__);
    const unexpectedNetworkErrors = networkErrors.filter(
      (message) => !message.endsWith("net::ERR_ABORTED"),
    );
    const evidence = {
      browserErrors,
      consoleErrors,
      firebaseJsSdk: firebaseJsSdkVersion,
      networkErrors,
      result,
      schemaVersion: 1,
    };
    await mkdir(dirname(resolve(arguments_.output)), { recursive: true });
    await writeFile(resolve(arguments_.output), `${JSON.stringify(evidence, null, 2)}\n`);
    if (
      browserErrors.length !== 0 ||
      unexpectedNetworkErrors.length !== 0 ||
      result === null ||
      typeof result !== "object" ||
      (result as Record<string, unknown>).passed !== true
    ) {
      throw new Error(`Phase 4 browser SDK failed: ${JSON.stringify(evidence)}`);
    }
  } finally {
    await browser.close();
    await close(server);
  }
} finally {
  await Promise.allSettled([
    getAuth(app).deleteUser(uid),
    asset.delete({ ignoreNotFound: true }),
  ]);
  await deleteApp(app);
  await rm(temporaryDirectory, { force: true, recursive: true });
}

async function localBrowserExecutable(): Promise<string | undefined> {
  const configured = process.env.PHASE4_BROWSER_EXECUTABLE;
  const candidates = [
    configured,
    process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : undefined,
    process.platform === "linux" ? "/usr/bin/google-chrome" : undefined,
    process.platform === "linux" ? "/usr/bin/chromium" : undefined,
  ];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next host browser, then fall back to Playwright's managed build.
    }
  }
  return undefined;
}

async function packageVersion(root: string, name: string): Promise<string> {
  const body = JSON.parse(
    await readFile(join(resolve(root), "node_modules", name, "package.json"), "utf8"),
  ) as { readonly version?: unknown };
  if (typeof body.version !== "string") throw new Error(`${name} has no package version`);
  return body.version;
}

function prepareAdminApp(): unknown {
  process.env.GCLOUD_PROJECT = arguments_.projectId;
  process.env.GOOGLE_CLOUD_PROJECT = arguments_.projectId;
  process.env.FIREBASE_AUTH_EMULATOR_HOST = `${arguments_.host}:${String(arguments_.authPort)}`;
  process.env.FIRESTORE_EMULATOR_HOST = `${arguments_.host}:${String(arguments_.firestorePort)}`;
  process.env.STORAGE_EMULATOR_HOST = `http://${arguments_.host}:${String(arguments_.storagePort)}`;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const { initializeApp } = requireFromTwodart("firebase-admin/app") as {
    readonly initializeApp: (options: unknown, name?: string) => unknown;
  };
  return initializeApp(
    { projectId: arguments_.projectId, storageBucket: defaultBucket },
    runId,
  );
}

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return await new Promise<number>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("browser fixture server did not bind TCP"));
      } else {
        resolvePromise(address.port);
      }
    });
  });
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => (error === undefined ? resolvePromise() : reject(error)));
  });
}

function parseArguments(values: readonly string[]): Arguments {
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (key === undefined || value === undefined || !key.startsWith("--")) {
      throw new Error("Phase 4 browser arguments must be --key value pairs");
    }
    parsed.set(key.slice(2), value);
  }
  const required = (key: string): string => {
    const value = parsed.get(key);
    if (value === undefined || value.length === 0) throw new Error(`--${key} is required`);
    return value;
  };
  const port = (key: string): number => {
    const value = Number(required(key));
    if (!Number.isInteger(value) || value < 1 || value > 65_535) {
      throw new Error(`--${key} must be a TCP port`);
    }
    return value;
  };
  return {
    authPort: port("auth-port"),
    firestorePort: port("firestore-port"),
    functionsPort: port("functions-port"),
    host: required("host"),
    output: required("output"),
    projectId: required("project-id"),
    storagePort: port("storage-port"),
    twodartDirectory: required("twodart-dir"),
  };
}
