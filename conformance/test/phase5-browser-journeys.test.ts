import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { phase5BenignDiagnostic, readPhase5DiagnosticIdentities, redactPhase5Identifiers } from "../src/suite/phase5-browser-diagnostics.ts";

test("diagnostic redaction uses the exact working Auth query and response field", async () => {
  const users = await readPhase5DiagnosticIdentities("http://127.0.0.1/accounts:query", async (url, options) => {
    assert.equal(url, "http://127.0.0.1/accounts:query");
    assert.equal(options?.method, "POST");
    assert.deepEqual(JSON.parse(String(options?.body)), { order: "ASC", returnUserInfo: true, sortBy: "USER_ID" });
    return Response.json({ userInfo: [{ localId: "test-user", email: "test@example.invalid", displayName: "Test User" }] });
  });
  assert.deepEqual([...users], ["test-user", "test@example.invalid", "Test User"]);
  await assert.rejects(readPhase5DiagnosticIdentities("http://127.0.0.1/accounts:query", async () =>
    new Response("limit is not implemented.", { status: 501 })), /501: limit is not implemented\./u);
  await assert.rejects(readPhase5DiagnosticIdentities("http://127.0.0.1/accounts:query", async () =>
    Response.json({ users: [{ localId: "test-user" }] })), /single seeded Auth account/u);
});

test("synthetic diagnostic allowlist excludes unrelated errors", () => {
  assert.equal(phase5BenignDiagnostic({ kind: "page-error", text: "ReferenceError: target is not defined at useGoogleOneTap", syntheticGoogleClientId: true }), "synthetic-google-one-tap-reference-error");
  assert.equal(phase5BenignDiagnostic({ kind: "page-error", text: "ReferenceError: target is not defined at useGoogleOneTap", syntheticGoogleClientId: false }), null);
  assert.equal(phase5BenignDiagnostic({ kind: "page-error", text: "TypeError: broken at handleStaticIndicator (_next/static/dev.js)" }), "next-dev-hmr-handleStaticIndicator-type-error");
  const url = "http://127.0.0.1:23000/google.firestore.v1.Firestore/Listen/channel?RID=rpc";
  assert.equal(phase5BenignDiagnostic({ kind: "request-failed", text: "net::ERR_ABORTED", url }), "firestore-long-poll-net-ERR_ABORTED");
  assert.equal(phase5BenignDiagnostic({ kind: "request-failed", text: "net::ERR_CONNECTION_RESET", url }), null);
  assert.equal(phase5BenignDiagnostic({ kind: "request-failed", text: "net::ERR_ABORTED", url: "http://127.0.0.1:23002/v0/b/assets/o/cache.json" }), null);
  assert.equal(phase5BenignDiagnostic({ kind: "page-error", text: "TypeError: missing data" }), null);
});

test("diagnostics preserve failure details while hashing identifiers and OTPs", () => {
  const result = redactPhase5Identifiers("HTTP 500 /users/test-user/export?alt=media OTP: 123456", new Set(["test-user"]));
  assert.match(result, /HTTP 500 \/users\/\[identity-sha256:/u);
  assert.match(result, /export\?alt=media OTP: \[otp-sha256:/u);
  assert.doesNotMatch(result, /test-user|123456/u);
});

test("skipped export cannot satisfy the Phase 5 gate", async () => {
  const source = await readFile(new URL("../src/suite/run-phase5-gate.ts", import.meta.url), "utf8");
  assert.match(source, /skippedJourneys\?\.length/u);
  assert.match(source, /skipped journeys do not pass the Phase 5 gate/u);
  assert.match(source, /phase5-browser-diagnostics\.ts/u);
});

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

test("every passing journey has assertions and the export diagnostic skip is explicit", async () => {
  const source = await readFile(runnerUrl, "utf8");
  const assertions = [...source.matchAll(/return \{ backend: (?<backend>\d+), network: (?<network>\d+), rendered: (?<rendered>\d+) \};/gu)];
  assert.equal(assertions.length, 9);
  assert.match(source, /backend: 2,\s+network: adminPageIds\.length,\s+rendered: adminPageIds\.length,/u);
  for (const match of assertions) {
    if (Number(match.groups?.backend) === 0) {
      assert.equal(Number(match.groups?.network), 0);
      assert.equal(Number(match.groups?.rendered), 0);
      continue;
    }
    assert.ok(Number(match.groups?.backend) > 0);
    assert.ok(Number(match.groups?.network) > 0);
    assert.ok(Number(match.groups?.rendered) > 0);
  }
  assert.equal(assertions.filter((match) => Number(match.groups?.backend) === 0).length, 1);
  assert.match(source, /skippedJourneys\.push\(\{\s+id: "dotnet-deck-export"/u);
});

test("the supplied cumulative runner remains byte-for-byte unchanged", async () => {
  const source = await readFile(runnerUrl);
  assert.equal(createHash("sha256").update(source).digest("hex"),
    "5996794c87061ddec51564b81e1d916b95dea77a5190ee74f644d0ba7aff3c62");
  const text = source.toString();
  assert.ok(text.indexOf("const adminPageIds") < text.indexOf('await journey("'));
  assert.ok(text.indexOf("const skippedJourneys") < text.indexOf('await journey("'));
});

test("durable browser evidence explicitly excludes private identities and content", async () => {
  const source = await readFile(runnerUrl, "utf8");
  for (const boundary of [
    "credentialsStored: false",
    "datasetIdentityStored: false",
    "deckContentStored: false",
    "otpStored: false",
    "queryValuesStored: false",
    "requestInitiatorPayloadStored: false",
    "userIdentityStored: false",
    "candidateIdentityStored: false",
  ]) {
    assert.match(source, new RegExp(boundary.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
  assert.doesNotMatch(source, /writeEvidence\([^)]*(?:user\.email|selectedDeckId|originalDeckData|otp\b)/u);
});

test("login diagnostics classify the undefined route without storing query values", async () => {
  const source = await readFile(runnerUrl, "utf8");
  assert.match(source, /url\.pathname === "\/login\/undefined"/u);
  assert.match(source, /request\.isNavigationRequest\(\)/u);
  assert.match(source, /Network\.requestWillBeSent/u);
  assert.match(source, /initiatorCallsiteClasses/u);
  assert.match(source, /initiatorCallsiteHashes/u);
  assert.match(source, /finalDocumentPath/u);
  assert.match(source, /finalDocumentQueryKeys/u);
  assert.match(source, /emailInputCount: document\.querySelectorAll\("#workEmail"\)\.length/u);
  assert.match(source, /loadingSpinnerCount: document\.querySelectorAll\("svg\.animate-spin"\)\.length/u);
  assert.match(source, /nextErrorOverlayCount: document\.querySelectorAll\("nextjs-portal"\)\.length/u);
  assert.match(source, /pageErrorCallsiteClasses/u);
  assert.match(source, /pageErrorNames/u);
  assert.match(source, /consoleErrorOrigins/u);
  assert.match(source, /requestFailureClasses/u);
  assert.match(source, /Object\.keys\(router\.query \?\? \{\}\)\.sort\(\)/u);
  assert.doesNotMatch(source, /finalDocumentQueryValues/u);
  assert.doesNotMatch(source, /initiatorPayload/u);
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
  assert.match(loginSource, /new URL\(PHASE5_LOGIN_ROUTE, args\.baseUrl\)/u);
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
