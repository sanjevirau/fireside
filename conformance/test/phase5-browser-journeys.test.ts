import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runnerUrl = new URL(
  "../src/suite/run-phase5-browser-journeys.ts",
  import.meta.url,
);
const fixtureUrl = new URL(
  "../fixtures/phase5/twodart-source-contract/fixture.json",
  import.meta.url,
);

test("the Phase 5 browser runner implements the frozen ordered journeys", async () => {
  const source = await readFile(runnerUrl, "utf8");
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8")) as {
    readonly journeyIds: readonly string[];
  };
  let previous = -1;
  for (const journeyId of fixture.journeyIds) {
    const position = source.indexOf(`journey("${journeyId}"`);
    assert.ok(position > previous, `${journeyId} is missing or out of order`);
    previous = position;
  }
});

test("every journey exercises rendered, network, and backend assertions", async () => {
  const source = await readFile(runnerUrl, "utf8");
  const assertions = [...source.matchAll(/return \{ backend: (?<backend>\d+), network: (?<network>\d+), rendered: (?<rendered>\d+) \};/gu)];
  assert.equal(assertions.length, 8);
  assert.match(source, /backend: 2,\s+network: adminPageIds\.length,\s+rendered: adminPageIds\.length,/u);
  for (const match of assertions) {
    assert.ok(Number(match.groups?.backend) > 0);
    assert.ok(Number(match.groups?.network) > 0);
    assert.ok(Number(match.groups?.rendered) > 0);
  }
});

test("durable browser evidence explicitly excludes private identities and content", async () => {
  const source = await readFile(runnerUrl, "utf8");
  for (const boundary of [
    "credentialsStored: false",
    "datasetIdentityStored: false",
    "deckContentStored: false",
    "otpStored: false",
    "userIdentityStored: false",
    "candidateIdentityStored: false",
  ]) {
    assert.match(source, new RegExp(boundary.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
  assert.doesNotMatch(source, /writeEvidence\([^)]*(?:user\.email|selectedDeckId|originalDeckData|otp\b)/u);
});

test("the browser runner covers both lifecycle iterations and all admin routes", async () => {
  const source = await readFile(runnerUrl, "utf8");
  assert.match(source, /"initial" \| "restart"/u);
  assert.match(source, /iteration !== "initial" && iteration !== "restart"/u);
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8")) as {
    readonly adminNavigationPageIds: readonly string[];
  };
  for (const pageId of fixture.adminNavigationPageIds) {
    assert.match(source, new RegExp(`"${pageId}"`, "u"));
  }
});

test("login readiness records status before waiting for rendered controls", async () => {
  const source = await readFile(runnerUrl, "utf8");
  const loginStart = source.indexOf("async function loginThroughRenderedUi");
  const loginEnd = source.indexOf("async function waitForOtp", loginStart);
  const loginSource = source.slice(loginStart, loginEnd);
  const navigationAssertion = loginSource.indexOf(
    'assertSuccessfulNavigation(response, "login")',
  );
  const selectorWait = loginSource.indexOf("await emailInput.waitFor");
  assert.ok(navigationAssertion >= 0, "login navigation status must be asserted");
  assert.ok(selectorWait > navigationAssertion, "status assertion must precede selector wait");
  assert.match(loginSource, /timeout: 180_000/u);
  assert.match(source, /navigations\.push\(\{ label, status: response\?\.status\(\) \?\? null \}\)/u);
  assert.match(source, /navigations,/u);
});
