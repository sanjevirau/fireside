import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { refreshProject, type RefreshObservation } from "../src/suite/auth-refresh-contract.ts";

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
