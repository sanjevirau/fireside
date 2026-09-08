import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join } from "node:path";
import { captureRefreshContract, refreshProject } from "./auth-refresh-contract.ts";
import { captureRefreshBrowser } from "./auth-refresh-browser.ts";

const root = process.env.FIREBASE_TOOLS_15_22_ROOT;
assert.ok(root, "set FIREBASE_TOOLS_15_22_ROOT to the pinned official oracle");
const require = createRequire(join(root, "package.json"));
assert.equal(require(join(root, "package.json")).version, "15.22.0");
const { AuthEmulator, SingleProjectMode } = require(join(root, "lib/emulator/auth/index.js"));
const reservation = createServer();
await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const address = reservation.address();
assert.ok(address && typeof address !== "string");
await new Promise<void>((resolve) => reservation.close(() => resolve()));
const emulator = new AuthEmulator({ host: "127.0.0.1", port: address.port, projectId: refreshProject, singleProjectMode: SingleProjectMode.NO_WARNING });
try {
  await emulator.start();
  const origin = `http://127.0.0.1:${address.port}`;
  const observations = await captureRefreshContract(origin);
  const browser = await captureRefreshBrowser(origin);
  const sourceHashes = Object.fromEntries(await Promise.all(["lib/emulator/auth/state.js", "lib/emulator/auth/operations.js"].map(async (path) => [path, sha(await readFile(join(root, path)))])));
  const sdk = JSON.parse(await readFile(new URL("../../node_modules/firebase/package.json", import.meta.url), "utf8")) as { version: string };
  const directory = new URL("../../fixtures/firebase-suite-v1/auth-refresh-reuse/", import.meta.url);
  await mkdir(directory, { recursive: true });
  const fixture = JSON.stringify({
    schemaVersion: 1, target: "official-firebase-tools-auth-emulator", targetVersion: "15.22.0",
    targetProject: refreshProject, capturedAt: new Date().toISOString(),
    credentialsStored: false, accessTokensStored: false, realUserDataStored: false,
    sourceHashes, browserSdkVersion: sdk.version,
    observations, browser,
  }, null, 2) + "\n";
  await writeFile(new URL("fixture.json", directory), fixture);
  await writeFile(new URL("SHA256SUMS", directory), `${sha(fixture)}  fixture.json\n`);
  console.log(JSON.stringify({ observations: observations.length, browserStages: browser.stages, pageErrors: browser.pageErrors }));
} finally {
  await emulator.stop();
}

function sha(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
