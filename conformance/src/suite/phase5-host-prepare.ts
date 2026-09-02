import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TWODART_CANDIDATE = "daa55b893ab0564f558b3f4116c102762e964aeb";

export type Phase5StackName = "official" | "fireside";

export interface Phase5StackPorts {
  readonly auth: number;
  readonly cacheWebsocket: number;
  readonly eventarc: number;
  readonly firestore: number;
  readonly firestoreWebsocket: number;
  readonly functions: number;
  readonly hub: number;
  readonly logging: number;
  readonly mprocsControl: number;
  readonly pubsub: number;
  readonly storage: number;
  readonly tasks: number;
  readonly ui: number;
}

export const PHASE5_STACK_PORTS: Readonly<
  Record<Phase5StackName, Phase5StackPorts>
> = {
  official: {
    firestore: 23_000,
    auth: 23_001,
    storage: 23_002,
    functions: 23_003,
    pubsub: 23_004,
    hub: 23_005,
    ui: 23_006,
    firestoreWebsocket: 23_007,
    logging: 23_008,
    eventarc: 23_009,
    tasks: 23_010,
    mprocsControl: 23_011,
    cacheWebsocket: 23_012,
  },
  fireside: {
    firestore: 23_100,
    auth: 23_101,
    storage: 23_102,
    functions: 23_103,
    pubsub: 23_104,
    hub: 23_105,
    ui: 23_106,
    firestoreWebsocket: 23_107,
    logging: 23_108,
    eventarc: 23_109,
    tasks: 23_110,
    mprocsControl: 23_111,
    cacheWebsocket: 23_112,
  },
};

export const PHASE5_APPLICATION_URL_KEYS = [
  "CF_WORKER_URL",
  "FE_URL",
  "FIREBASE_STORAGE_EMULATOR_URL",
  "PAPI_URL",
  "TWODART_IMAGES_API",
  "TWODARTNET_API_URL",
] as const;

export function assertDistinctPhase5ApplicationUrls(
  official: Readonly<Record<string, string>>,
  fireside: Readonly<Record<string, string>>,
): void {
  for (const key of PHASE5_APPLICATION_URL_KEYS) {
    const officialValue = official[key];
    const firesideValue = fireside[key];
    if (officialValue === undefined || firesideValue === undefined) {
      throw new Error(`Phase 5 application URL is missing: ${key}`);
    }
    const officialHost = new URL(officialValue).host;
    const firesideHost = new URL(firesideValue).host;
    if (officialHost === firesideHost) {
      throw new Error(
        `Phase 5 application URL namespace collides for ${key}: ${officialHost}`,
      );
    }
  }
}

export function phase5DatasetPaths(
  gateRoot: string,
  stack: Phase5StackName,
): { readonly exportPath: string; readonly importPath: string } {
  return {
    importPath: path.resolve(gateRoot, "inputs/full-data"),
    exportPath: path.resolve(gateRoot, "exports", stack, "full-data"),
  };
}

export function renderSafeTwodartEnvironment(): string {
  const values: Readonly<Record<string, string>> = {
    AI_GATEWAY_API_KEY: "disabled-local",
    ALGOLIA_APPLICATION_ID: "disabled-local",
    ALGOLIA_PRESENTATION_INDEX_NAME: "disabled-local-presentations",
    ALGOLIA_SEARCH_API_KEY: "disabled-local",
    ALGOLIA_USERIMAGE_INDEX_NAME: "disabled-local-user-images",
    ALGOLIA_WRITE_API_KEY: "disabled-local",
    BRAND_FETCH_API_KEY: "disabled-local",
    CRON_SECRET: "phase5-local-cron-secret",
    DOTNET_SHARED_SECRET: "phase5-local-dotnet-shared-secret-32-bytes-minimum",
    ENV: "local",
    FACEBOOK_PIXEL_ID: "disabled-local",
    FE_URL: "https://templates.twodart.localhost",
    FIREBASE_FE_API_KEY: "demo-api-key",
    FIREBASE_FE_APP_ID: "demo-app-id",
    FIREBASE_FE_AUTH_DOMAIN: "demo-twodart-local.firebaseapp.com",
    FIREBASE_FE_MESSAGING_SENDER_ID: "000000000000",
    FIREBASE_FE_PROJECT_ID: "demo-twodart-local",
    FIREBASE_FE_STORAGE_BUCKET: "demo-twodart-local.appspot.com",
    FIREBASE_PROJECT_ID: "demo-twodart-local",
    FIREBASE_PUBLIC_STORAGE_BUCKET: "assets-local.twodart.com",
    GAPI_CLIENT_ID: "disabled-local.apps.googleusercontent.com",
    GAPI_CLIENT_SECRET: "disabled-local",
    GAPI_REDIRECT_URL: "http://localhost:4200",
    GOOGLE_FONTS_API_KEY: "disabled-local",
    KLAVIYO_PRIVATE_KEY: "disabled-local",
    MAINTENANCE_MODE: "false",
    NEXT_PUBLIC_ENABLE_POSTHOG: "false",
    NEXT_PUBLIC_FIREBASE_AUTH_GOAUTH: "false",
    NEXT_PUBLIC_POSTHOG_HOST: "http://127.0.0.1:9",
    NEXT_PUBLIC_POSTHOG_KEY: "disabled-local",
    PAPI_URL: "https://papi.twodart.localhost",
    POSTMARK_SERVER_API: "disabled-local",
    STRIPE_EXTENSION_WEBHOOK_SECRET: "disabled-local",
    STRIPE_PUBLISHABLE_API_KEY: "disabled-local",
    STRIPE_SECRET_API_KEY: "disabled-local",
    STRIPE_WEBHOOK_SECRET: "disabled-local",
    TWODARTNET_API_URL: "https://twodartnet.twodart.localhost",
    TWODART_DISABLE_EXTERNALS: "1",
    TWODART_IMAGES_API: "https://images.twodart.localhost",
    VERCEL_API_TOKEN: "disabled-local",
    VERCEL_OIDC_TOKEN: "disabled-local",
    VERCEL_WEBHOOK_SECRET_CLEANUP: "disabled-local",
    WIDGET_FTP_IP: "127.0.0.1",
    WIDGET_FTP_PASSWORD: "disabled-local",
    WIDGET_FTP_PORT: "21",
    WIDGET_FTP_USERNAME: "disabled-local",
    WP_API_PASSWORD: "disabled-local",
    WP_API_USERNAME: "disabled-local",
    WP_URL: "http://127.0.0.1:9",
  };
  return `${Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join("\n")}\n`;
}

export function applyPhase5Ports(
  configText: string,
  ports: Phase5StackPorts,
): string {
  const config = JSON.parse(configText) as {
    emulators?: Record<string, unknown>;
  };
  const emulators = config.emulators ?? {};
  config.emulators = emulators;
  emulators.firestore = {
    host: "127.0.0.1",
    port: ports.firestore,
    websocketPort: ports.firestoreWebsocket,
  };
  emulators.auth = { host: "127.0.0.1", port: ports.auth };
  emulators.storage = { host: "127.0.0.1", port: ports.storage };
  emulators.functions = { host: "127.0.0.1", port: ports.functions };
  emulators.pubsub = { host: "127.0.0.1", port: ports.pubsub };
  emulators.hub = { host: "127.0.0.1", port: ports.hub };
  emulators.ui = { enabled: true, host: "127.0.0.1", port: ports.ui };
  emulators.logging = { host: "127.0.0.1", port: ports.logging };
  emulators.eventarc = { host: "127.0.0.1", port: ports.eventarc };
  emulators.tasks = { host: "127.0.0.1", port: ports.tasks };
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function phase5PortEnvironment(
  ports: Phase5StackPorts,
): Readonly<Record<string, string>> {
  return {
    FIREBASE_EMULATOR_AUTH_PORT: String(ports.auth),
    FIREBASE_CACHE_WEBSOCKET_PORT: String(ports.cacheWebsocket),
    FIREBASE_EMULATOR_FIRESTORE_PORT: String(ports.firestore),
    FIREBASE_EMULATOR_FUNCTIONS_PORT: String(ports.functions),
    FIREBASE_EMULATOR_HUB_PORT: String(ports.hub),
    FIREBASE_EMULATOR_PUBSUB_PORT: String(ports.pubsub),
    FIREBASE_EMULATOR_STORAGE_PORT: String(ports.storage),
    FIREBASE_EMULATOR_UI_PORT: String(ports.ui),
    MPROCS_CONTROL_PORT: String(ports.mprocsControl),
    TWODART_FIREBASE_EVENTARC_PORT: String(ports.eventarc),
    TWODART_FIREBASE_LOGGING_PORT: String(ports.logging),
    TWODART_FIREBASE_TASKS_PORT: String(ports.tasks),
    TWODART_FIREBASE_WEBSOCKET_PORT: String(ports.firestoreWebsocket),
  };
}

interface Arguments {
  readonly gateRoot: string;
  readonly reuseDependenciesFrom?: string;
  readonly stack: Phase5StackName;
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const stackRoot = path.join(args.gateRoot, `stack-${args.stack}`);
  const inputRoot = path.join(args.gateRoot, "inputs");
  const ports = PHASE5_STACK_PORTS[args.stack];
  const datasetPaths = phase5DatasetPaths(args.gateRoot, args.stack);

  await assertDirectory(stackRoot);
  await assertDirectory(path.join(inputRoot, "full-data"));
  await assertDirectory(path.join(inputRoot, "Assets"));
  const revision = (await capture("git", ["-C", stackRoot, "rev-parse", "HEAD"])).trim();
  if (revision !== TWODART_CANDIDATE) {
    throw new Error(`Twodart candidate mismatch: ${revision}`);
  }

  await writeFile(path.join(stackRoot, ".env.local"), renderSafeTwodartEnvironment(), {
    mode: 0o600,
  });
  // firebase-tools 15.22.0 probes the import root with lstat(), so a directory
  // symlink is rejected before it looks for firebase-export-metadata.json.
  // Hardlink the files into a real directory while keeping one immutable byte
  // corpus on disk for the differential stacks.
  await stageHardlinkedDirectoryTree(
    datasetPaths.importPath,
    path.join(
      stackRoot,
      "apps/templates-firebase/loadData/datasets/full-data",
    ),
  );
  for (const name of ["globalFonts", "masterSlidesBase", "slides"] as const) {
    await stageDirectoryLink(
      path.join(inputRoot, "Assets", name),
      path.join(stackRoot, "engines/twodartnet/TwodartNet/Assets", name),
    );
  }

  const setupEnvironment = {
    ...process.env,
    ...phase5PortEnvironment(ports),
    TWODART_DISABLE_EXTERNALS: "1",
    TWODART_SETUP_SKIP_WORKTREE_BOOTSTRAP: "1",
  };
  if (args.reuseDependenciesFrom === undefined) {
    await run("bun", ["setup"], stackRoot, setupEnvironment);
  } else {
    if (args.stack !== "fireside") {
      throw new Error("Only the Fireside parity stack may reuse official dependencies");
    }
    const dependencyRoot = path.resolve(args.reuseDependenciesFrom);
    const dependencyRevision = (
      await capture("git", ["-C", dependencyRoot, "rev-parse", "HEAD"])
    ).trim();
    if (dependencyRevision !== revision) {
      throw new Error("Dependency source does not use the measured Twodart revision");
    }
    await stageHardlinkedDirectoryTree(
      path.join(dependencyRoot, "node_modules"),
      path.join(stackRoot, "node_modules"),
    );
    await stageDirectoryLink(
      path.join(dependencyRoot, "apps/papi/.venv"),
      path.join(stackRoot, "apps/papi/.venv"),
    );
    await run(
      "bash",
      ["scripts/setup/check-prereqs.sh"],
      stackRoot,
      setupEnvironment,
    );
    await run(
      "bun",
      ["scripts/env.ts", "sync", "local"],
      stackRoot,
      setupEnvironment,
    );
    await run(
      "bun",
      ["--filter", "@twodart/templates-firebase", "build"],
      stackRoot,
      setupEnvironment,
    );
  }

  const configPath = path.join(stackRoot, "apps/templates-firebase/firebase.json");
  await writeFile(
    configPath,
    applyPhase5Ports(await readFile(configPath, "utf8"), ports),
  );
  await mkdir(datasetPaths.exportPath, { recursive: true });

  const portsPath = path.join(stackRoot, ".env.ports");
  const portEnvironment = await readFile(portsPath, "utf8");
  for (const [key, value] of Object.entries(phase5PortEnvironment(ports))) {
    if (!portEnvironment.includes(`${key}="${value}"`)) {
      throw new Error(`${key} was not frozen for ${args.stack}`);
    }
  }
  const status = await capture("git", ["-C", stackRoot, "status", "--porcelain"]);
  const trackedChanges = status
    .split("\n")
    .filter((line) => line.length > 0 && !line.startsWith("??"));
  if (trackedChanges.length > 0) {
    throw new Error(`Setup modified tracked files:\n${trackedChanges.join("\n")}`);
  }
  process.stdout.write(
    `${JSON.stringify({
      candidateRevision: revision,
      exportPath: datasetPaths.exportPath,
      importPath: datasetPaths.importPath,
      stack: args.stack,
      status: "prepared",
    })}\n`,
  );
}

function parseArguments(raw: readonly string[]): Arguments {
  let gateRoot = "";
  let reuseDependenciesFrom = "";
  let stack: Phase5StackName | "" = "";
  for (let index = 0; index < raw.length; index += 1) {
    const value = raw[index];
    if (value === "--gate-root") {
      gateRoot = raw[index + 1] ?? "";
      index += 1;
    } else if (value === "--stack") {
      const candidate = raw[index + 1] ?? "";
      if (candidate !== "official" && candidate !== "fireside") {
        throw new Error(`Unknown Phase 5 stack: ${candidate}`);
      }
      stack = candidate;
      index += 1;
    } else if (value === "--reuse-dependencies-from") {
      reuseDependenciesFrom = raw[index + 1] ?? "";
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${value ?? ""}`);
    }
  }
  if (
    gateRoot.length === 0 ||
    (stack !== "official" && stack !== "fireside")
  ) {
    throw new Error("Usage: phase5-host-prepare.ts --gate-root PATH --stack official|fireside");
  }
  return reuseDependenciesFrom.length === 0
    ? { gateRoot: path.resolve(gateRoot), stack }
    : {
        gateRoot: path.resolve(gateRoot),
        reuseDependenciesFrom: path.resolve(reuseDependenciesFrom),
        stack,
      };
}

async function assertDirectory(directory: string): Promise<void> {
  if (!(await stat(directory)).isDirectory()) {
    throw new Error(`Expected directory: ${directory}`);
  }
}

async function stageDirectoryLink(
  source: string,
  destination: string,
): Promise<void> {
  await assertDirectory(source);
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    const existing = await lstat(destination);
    if (!existing.isSymbolicLink()) {
      throw new Error(`Refusing to replace non-symlink staging path: ${destination}`);
    }
    const target = await readlink(destination);
    if (path.resolve(path.dirname(destination), target) !== path.resolve(source)) {
      throw new Error(`Staging symlink points at the wrong input: ${destination}`);
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await symlink(source, destination, "dir");
  }
}

export async function stageHardlinkedDirectoryTree(
  source: string,
  destination: string,
): Promise<void> {
  await assertDirectory(source);
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await lstat(destination);
    throw new Error(`Refusing to replace hardlinked staging path: ${destination}`);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await mkdir(destination);
  try {
    await run(
      "cp",
      ["-a", "-l", `${source}${path.sep}.`, destination],
      process.cwd(),
      process.env,
    );
  } catch (error: unknown) {
    await rm(destination, { force: true, recursive: true });
    throw error;
  }
}

async function capture(command: string, args: readonly string[]): Promise<string> {
  let output = "";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "inherit"] });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${String(code)} (${String(signal)})`));
    });
  });
  return output;
}

async function run(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${String(code)} (${String(signal)})`));
    });
  });
}

const isEntryPoint = process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
