import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { captureRefreshContract, refreshProject, semanticRefresh, type RefreshObservation } from "../src/suite/auth-refresh-contract.ts";
import { captureRefreshBrowser } from "../src/suite/auth-refresh-browser.ts";

export const refreshFixtureRoot = new URL("../fixtures/firebase-suite-v1/auth-refresh-reuse/", import.meta.url);
export interface RefreshFixture {
  targetVersion: string;
  credentialsStored: boolean;
  accessTokensStored: boolean;
  browserSdkVersion: string;
  sourceHashes: Record<string, string>;
  observations: RefreshObservation[];
  browser: { observations: RefreshObservation[]; stages: string[]; pageErrors: string[] };
}

test("official Auth refresh grants survive repetition, concurrency, disable/enable, and browser reload", async () => {
  const raw = await readFile(new URL("fixture.json", refreshFixtureRoot));
  assert.equal(await readFile(new URL("SHA256SUMS", refreshFixtureRoot), "utf8"), `${createHash("sha256").update(raw).digest("hex")}  fixture.json\n`);
  const fixture = JSON.parse(raw.toString()) as RefreshFixture;
  assert.equal(fixture.targetVersion, "15.22.0");
  assert.equal(fixture.browserSdkVersion, "12.18.0");
  assert.equal(fixture.credentialsStored, false);
  assert.equal(fixture.accessTokensStored, false);
  assert.equal(Object.keys(fixture.sourceHashes).length, 2);
  assert.equal(fixture.observations.length, 28);
  assert.equal(fixture.browser.observations.length, 4);
  assert.deepEqual(fixture.browser.pageErrors, []);
  assert.deepEqual(fixture.browser.stages, ["custom-token-sign-in", "forced-refresh", "second-tab-restored-user", "concurrent-two-tab-refresh", "reload-restored-user-and-refresh"]);
  for (const observation of [...fixture.observations, ...fixture.browser.observations]) {
    if (observation.id.endsWith("-disabled")) {
      assert.equal(observation.status, 400);
      assert.equal(observation.error, "USER_DISABLED");
    } else if (observation.id.endsWith("-deleted") || observation.id === "unknown-token") {
      assert.equal(observation.status, 400);
      assert.equal(observation.error, "INVALID_REFRESH_TOKEN");
    } else {
      assert.equal(observation.status, 200, observation.id);
      assert.equal(observation.sameRefreshToken, true, observation.id);
      assert.equal(observation.accessTokenEqualsIdToken, true);
      assert.equal(observation.userMatches, true);
      assert.equal(observation.expiresIn, "3600");
      assert.equal(observation.claims?.aud, refreshProject);
      assert.equal(observation.claims?.lifetimeSeconds, 3600);
    }
  }
});

test("Fireside matches password/custom refresh fixtures and real two-tab/reload SDK behavior", { timeout: 600_000 }, async () => {
  const repository = fileURLToPath(new URL("../../", import.meta.url));
  const execute = promisify(execFile);
  await execute("cargo", ["build", "--locked", "-p", "fireside-auth-front", "--example", "refresh_fixture_server"], { cwd: repository });
  const metadata = JSON.parse((await execute("cargo", ["metadata", "--no-deps", "--format-version", "1"], { cwd: repository })).stdout) as { target_directory: string };
  const peer = spawn(`${metadata.target_directory}/debug/examples/refresh_fixture_server`, [], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(peer, "exit");
  try {
    const origin = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Auth fixture peer readiness timeout")), 30_000);
      peer.stdout.once("data", (chunk: Buffer) => { clearTimeout(timer); resolve(chunk.toString().trim()); });
      peer.once("error", reject);
      peer.once("exit", () => { clearTimeout(timer); reject(new Error("Auth fixture peer exited before readiness")); });
    });
    const fixture = JSON.parse(await readFile(new URL("fixture.json", refreshFixtureRoot), "utf8")) as RefreshFixture;
    // Anonymous sign-up is not implemented in the accepted Phase 4 surface.
    // Preserve that oracle evidence, but do not claim to implement a new login
    // method as part of this repair to existing password/custom refresh grants.
    assert.deepEqual(semanticRefresh(await captureRefreshContract(origin, ["password", "custom"])), semanticRefresh(fixture.observations.filter(({ id }) => !id.startsWith("anonymous-"))));
    const browser = await captureRefreshBrowser(origin);
    assert.deepEqual(semanticRefresh(browser.observations), semanticRefresh(fixture.browser.observations));
    assert.deepEqual(browser.stages, fixture.browser.stages);
    assert.deepEqual(browser.pageErrors, []);
  } finally {
    peer.kill("SIGTERM");
    await exited;
  }
});
