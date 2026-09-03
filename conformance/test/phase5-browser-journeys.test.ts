import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import "./phase5-listen-diagnostics.test.ts";
import "./phase5-document-diagnostics.test.ts";
import {
  PHASE5_STORAGE_ATTRIBUTION_PROBE_BUDGET_MS,
  PHASE5_STORAGE_PENDING_PROBE_DELAY_MS,
  phase5BenignDiagnostic,
  phase5PendingRequestEvidence,
  phase5StorageImageProbeTargets,
  phase5TemplateWarmupLines,
  readPhase5DiagnosticIdentities,
  redactPhase5Identifiers,
} from "../src/suite/phase5-browser-diagnostics.ts";

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
  assert.equal(phase5BenignDiagnostic({ kind: "page-error", text: "ReferenceError: target is not defined at useGoogleOneTap", syntheticGoogleClientId: true }), null);
  assert.equal(phase5BenignDiagnostic({ kind: "page-error", text: "ReferenceError: __name is not defined" }), null);
  assert.equal(phase5BenignDiagnostic({ kind: "page-error", text: "ReferenceError: target is not defined at useGoogleOneTap", syntheticGoogleClientId: false }), null);
  assert.equal(phase5BenignDiagnostic({ kind: "page-error", text: "TypeError: broken at handleStaticIndicator (_next/static/dev.js)" }), "next-dev-hmr-handleStaticIndicator-type-error");
  const url = "http://127.0.0.1:23000/google.firestore.v1.Firestore/Listen/channel?RID=rpc";
  assert.equal(phase5BenignDiagnostic({ kind: "request-failed", text: "net::ERR_ABORTED", url }), "firestore-long-poll-net-ERR_ABORTED");
  assert.equal(phase5BenignDiagnostic({ kind: "request-failed", text: "net::ERR_CONNECTION_RESET", url }), null);
  assert.equal(phase5BenignDiagnostic({ kind: "request-failed", text: "net::ERR_ABORTED", url: "https://templates.twodart.localhost/login/overview" }), "harness-navigation-net-ERR_ABORTED");
  assert.equal(phase5BenignDiagnostic({ kind: "request-failed", text: "net::ERR_ABORTED", url: "https://example.invalid/resource" }), null);
  assert.equal(phase5BenignDiagnostic({ kind: "page-error", text: "TypeError: missing data" }), null);
});

test("diagnostics preserve failure details while hashing identifiers and OTPs", () => {
  const result = redactPhase5Identifiers("HTTP 500 /users/test-user/export?alt=media OTP: 123456", new Set(["test-user"]));
  assert.match(result, /HTTP 500 \/users\/\[identity-sha256:/u);
  assert.match(result, /export\?alt=media OTP: \[otp-sha256:/u);
  assert.doesNotMatch(result, /test-user|123456/u);
});

test("failure diagnostics retain every response-less request with a stable age", () => {
  assert.deepEqual(phase5PendingRequestEvidence([
    { method: "GET", resourceType: "image", startedAt: 1_000, url: "https://storage.twodart.localhost/v0/b/b/o/a?alt=media" },
    { method: "POST", resourceType: "fetch", startedAt: 2_000, url: "https://templates.twodart.localhost/api/example" },
  ], 32_500), [
    { ageMs: 31_500, method: "GET", resourceType: "image", url: "https://storage.twodart.localhost/v0/b/b/o/a?alt=media" },
    { ageMs: 30_500, method: "POST", resourceType: "fetch", url: "https://templates.twodart.localhost/api/example" },
  ]);
});

test("stalled Storage alias images map to raw and alias attribution probes", () => {
  assert.equal(PHASE5_STORAGE_PENDING_PROBE_DELAY_MS, 30_000);
  assert.equal(PHASE5_STORAGE_ATTRIBUTION_PROBE_BUDGET_MS, 10_000);
  assert.deepEqual(phase5StorageImageProbeTargets(
    "https://phase5-fireside.storage.twodart.localhost/v0/b/assets-local.twodart.com/o/users%2Fu%2Fhigh.webp?alt=media",
    "image",
    "https://phase5-fireside.templates.twodart.localhost",
    24420,
  ), {
    alias: "https://phase5-fireside.storage.twodart.localhost/v0/b/assets-local.twodart.com/o/users%2Fu%2Fhigh.webp?alt=media",
    raw: "http://127.0.0.1:24420/v0/b/assets-local.twodart.com/o/users%2Fu%2Fhigh.webp?alt=media",
  });
  assert.equal(phase5StorageImageProbeTargets(
    "https://storage.twodart.localhost/v0/b/assets-local.twodart.com/o/cache.json?alt=media",
    "fetch",
    "https://templates.twodart.localhost",
    24020,
  ), null);
});

test("official templates evidence preserves the upload and warm-up sequence", () => {
  const lines = phase5TemplateWarmupLines([
    "unrelated startup line",
    "[UserImage] Variants uploaded successfully (Original + High + Regular)",
    "[API Upload Order] Document created in Firestore: image-id",
    "[CDN Warming] Starting parallel cache warming for 5 URLs...",
    " POST /api/user/uploadUserImage 200 in 494ms",
    "  ✓ Warmed: users%2Fu%2Fhigh.webp?alt=media",
    "[WARN] Error warming users%2Fu%2Fregular.webp?alt=media: The operation was aborted due to timeout",
    "[CDN Warming] Completed in 15006ms",
  ].join("\n"));
  assert.equal(lines.length, 7);
  assert.match(lines[0] ?? "", /Variants uploaded successfully/u);
  assert.match(lines.at(-1) ?? "", /Completed in 15006ms/u);
});

test("observer records pending requests, raw-versus-alias probes, and official warm-up lines", async () => {
  const source = await readFile(new URL("../src/suite/phase5-browser-diagnostics.ts", import.meta.url), "utf8");
  assert.match(source, /pending-requests-at-journey-failure/u);
  assert.match(source, /storage-image-pending-probes/u);
  assert.match(source, /official-templates-warmup/u);
  assert.match(source, /additionalStorageRequests/u);
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

test("every journey requires positive assertions and export can no longer skip", async () => {
  const source = await readFile(runnerUrl, "utf8");
  const assertions = [...source.matchAll(/return \{ backend: (?<backend>\d+), network: (?<network>\d+), rendered: (?<rendered>\d+) \};/gu)];
  assert.equal(assertions.length, 8);
  assert.match(source, /backend: 2,\s+network: adminPageIds\.length,\s+rendered: adminPageIds\.length,/u);
  for (const match of assertions) {
    assert.ok(Number(match.groups?.backend) > 0);
    assert.ok(Number(match.groups?.network) > 0);
    assert.ok(Number(match.groups?.rendered) > 0);
  }
  assert.doesNotMatch(source, /skippedJourneys\.push/u);
  assert.match(source, /body\.status === "failed"/u);
  assert.match(source, /throw new Error\(`\.NET export job reported failure:/u);
  assert.match(source, /throw new Error\("No browser download artifact within 120s/u);
  assert.match(source, /exportedBytes\.subarray\(0, 2\)\.toString\("latin1"\) !== "PK"/u);
});

test("the supplied cumulative runner remains byte-for-byte unchanged", async () => {
  const source = await readFile(runnerUrl);
  assert.equal(createHash("sha256").update(source).digest("hex"),
    "ad61e2e6720abe5e53c745ec264c94166ccd3ff9662c84c1655062c9dd0258cc");
  const text = source.toString();
  assert.ok(text.indexOf("const adminPageIds") < text.indexOf('await journey("'));
  assert.ok(text.indexOf("const skippedJourneys") < text.indexOf('await journey("'));
});

test("the literal navigation trace executes without module helpers", async () => {
  const source = await readFile(runnerUrl, "utf8");
  const trace = source.slice(source.indexOf("async function installSafeClientNavigationTrace"));
  const content = /const source = `([\s\S]*?)`;/u.exec(trace)?.[1];
  assert.ok(content);
  assert.doesNotMatch(content, /__name|\$\{/u);
  const calls: unknown[][] = [];
  const window = {
    location: { href: "https://templates.twodart.localhost/home/recent" },
    history: {
      pushState(...args: unknown[]) { calls.push(args); return "push-result"; },
      replaceState(...args: unknown[]) { calls.push(args); return "replace-result"; },
    },
    open(...args: unknown[]) { calls.push(args); return "open-result"; },
    __phase5NavigationTrace: [] as unknown[],
  };
  vm.runInNewContext(content, { window, URL });
  assert.equal(window.history.pushState(null, "", "/admin/tag?probe=hidden"), "push-result");
  assert.equal(window.history.replaceState(null, "", "/home/recent"), "replace-result");
  assert.equal(window.open("/slide-library", "_blank"), "open-result");
  assert.equal(calls.length, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(window.__phase5NavigationTrace)), [
    { kind: "history.pushState", path: "/admin/tag", queryKeys: ["probe"] },
    { kind: "history.replaceState", path: "/home/recent", queryKeys: [] },
    { kind: "window.open", path: "/slide-library", queryKeys: [] },
  ]);
  assert.doesNotMatch(JSON.stringify(window.__phase5NavigationTrace), /hidden/u);
});

test("the export palette spans all eleven fixed .NET indices and aborts retain reasons", async () => {
  const source = await readFile(runnerUrl, "utf8");
  const palette = /brandColor: \[([\s\S]*?)\],/u.exec(source)?.[1];
  assert.ok(palette);
  assert.equal([...palette.matchAll(/"#[0-9a-f]{6}"/giu)].length, 11);
  assert.match(source, /request\.failure\(\)\?\.errorText/u);
  assert.match(source, /classifyUrl\(request\.url\(\)\)\}:\$\{errorText\}/u);
  assert.match(source, /if \(errorText === "net::ERR_ABORTED"\) return;\s+recordFailure\(requestFailures/u);
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
