import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { queryRulesSource } from "../src/rules/query-rules-cases.ts";
import { queryPathCases, queryPathRulesSource } from "../src/rules/query-path-cases.ts";
import { compareNativeCapture, verifyBrowserCapture, verifyNativeCapture, type BrowserCapture, type NativeCapture } from "../src/rules/query-rules-verification.ts";

const root = new URL("../fixtures/rules-v2/query-authorization/", import.meta.url);
const jars = {
  "1.21.0": "c3d3680a89d946a90a027365ea14c26c6472a162bcf37f099bbb1ebd66d25e8e",
  "1.22.0": "9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c",
};
const checksumManifests: Record<string, string> = {
  "1.21.0": "5aea8ced2403cbe3ed1e6dd34fb05501c7a9ad2e9c116785587321e7c67ec3cc",
  "1.22.0": "21765b616286a57c8020f850d9dd0d9edb37cde7f8089188aac78d9ddb8cddcd",
};
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const json = async <T>(directory: URL, name: string): Promise<T> => JSON.parse(await readFile(new URL(name, directory), "utf8")) as T;
interface Wire {
  metadata: { targetVersion: string; transport: string };
  exchanges: { request: { uri: string; headers: { name: string; value: string }[]; bodyBase64?: string }; response: { status: number; bodyBase64?: string } }[];
}

for (const [version, jarHash] of Object.entries(jars)) {
  const directory = new URL(`java-${version}/`, root);
  test(`official Java ${version} query oracle: checksums, all potential-result cases, real browser transports`, async () => {
    const manifest = await readFile(new URL("SHA256SUMS", directory), "utf8");
    assert.equal(sha(manifest), checksumManifests[version], "frozen checksum manifest");
    const checksums = manifest.trim().split("\n");
    assert.equal(checksums.length, 10);
    const files: string[] = [];
    for (const line of checksums) {
      const match = /^([0-9a-f]{64})  ([a-zA-Z0-9.-]+)$/.exec(line);
      assert.ok(match, line);
      files.push(match[2]!);
      assert.equal(sha(await readFile(new URL(match[2]!, directory))), match[1], match[2]!);
    }
    assert.deepEqual((await readdir(directory)).sort(), [...files, "SHA256SUMS"].sort());
    const metadata = await json<Record<string, unknown>>(directory, "metadata.json");
    assert.equal(metadata.version, version);
    assert.equal(metadata.javaJarSha256, jarHash);
    assert.equal(metadata.authorizationHeadersStored, false);
    assert.equal(metadata.syntheticOnly, true);
    assert.equal(metadata.separateListenAndAggregationProxyPools, true);
    assert.equal(metadata.rulesSourceSha256, sha(queryRulesSource));
    assert.equal(await readFile(new URL("firestore.rules", directory), "utf8"), queryRulesSource);
    const native = await json<NativeCapture>(directory, "grpc.json");
    verifyNativeCapture(native);
    for (const variant of ["long-poll", "streaming"]) {
      verifyBrowserCapture(await json<BrowserCapture>(directory, `${variant}-browser.json`), native);
      const listen = await json<Wire>(directory, `${variant}-wire.json`);
      assert.equal(listen.metadata.targetVersion, version);
      assert.equal(listen.metadata.transport, "web-channel");
      const ci = variant === "long-poll" ? "1" : "0";
      assert.ok(listen.exchanges.some(({ request }) => new URL(request.uri, "http://localhost").searchParams.get("CI") === ci));
      const count = await json<Wire>(directory, `${variant}-aggregation-wire.json`);
      assert.equal(count.metadata.transport, "http1");
      assert.equal(count.exchanges.filter(({ request }) => request.uri.includes(":runAggregationQuery") && request.bodyBase64).length, 54);
      for (const wire of [listen, count]) {
        for (const { request, response } of wire.exchanges) {
          for (const header of request.headers) if (["authorization", "x-goog-api-key", "cookie"].includes(header.name.toLowerCase())) assert.equal(header.value, "[REDACTED]");
          const body = Buffer.from(request.bodyBase64 ?? "", "base64").toString();
          const embeddedHeaders = new URLSearchParams(body).get("headers");
          if (embeddedHeaders) assert.match(embeddedHeaders, /Authorization:\[REDACTED\]/i);
          assert.doesNotMatch(body, /eyJhbGciOiJub25lI/);
          assert.ok([200, 204, 400, 403].includes(response.status), `unexpected wire status ${response.status}`);
        }
      }
    }
  });
}

test("the Phase 5 Java pin and prior conformance pin agree on every native query verdict", async () => {
  compareNativeCapture(await json<NativeCapture>(new URL("java-1.21.0/", root), "grpc.json"), await json<NativeCapture>(new URL("java-1.22.0/", root), "grpc.json"));
});

test("a transport failure cannot masquerade as an oracle denial", async () => {
  const directory = new URL("java-1.21.0/", root);
  const native = await json<NativeCapture>(directory, "grpc.json");
  const browser = await json<BrowserCapture>(directory, "long-poll-browser.json");
  browser.observations.find((value) => value.id === "owner-absent")!.result.code = "unavailable";
  assert.throws(() => verifyBrowserCapture(browser, native));
  native.observations.find((value) => value.id === "owner-absent")!.code = -1;
  assert.throws(() => verifyNativeCapture(native));
});

for (const [version, jarHash] of Object.entries(jars)) {
  test(`official Java ${version} query-path oracle freezes wildcard and boolean-error semantics`, async () => {
    const directory = new URL(`../fixtures/rules-v2/query-paths/java-${version}/`, import.meta.url);
    const manifest = await readFile(new URL("SHA256SUMS", directory), "utf8");
    assert.equal(sha(manifest), version === "1.21.0"
      ? "53d5094de52b94d3278ecd02fb36292d018aae1fc454906d32879399383d005d"
      : "afd05d0968064240fc7e06e4830dcd7bb2385c0f67cf28db2e5493a769cad215");
    const entries = manifest.trim().split("\n");
    assert.equal(entries.length, 10);
    const files: string[] = [];
    for (const line of entries) {
      const match = /^([0-9a-f]{64})  ([a-zA-Z0-9.-]+)$/.exec(line);
      assert.ok(match, line);
      files.push(match[2]!);
      assert.equal(sha(await readFile(new URL(match[2]!, directory))), match[1], match[2]!);
    }
    assert.deepEqual((await readdir(directory)).sort(), [...files, "SHA256SUMS"].sort());
    const metadata = await json<Record<string, unknown>>(directory, "metadata.json");
    assert.equal(metadata.caseSet, "paths");
    assert.equal(metadata.version, version);
    assert.equal(metadata.javaJarSha256, jarHash);
    assert.equal(metadata.authorizationHeadersStored, false);
    assert.equal(metadata.syntheticOnly, true);
    assert.equal(metadata.rulesSourceSha256, sha(queryPathRulesSource));
    assert.equal(await readFile(new URL("firestore.rules", directory), "utf8"), queryPathRulesSource);
    const native = await json<NativeCapture>(directory, "grpc.json");
    assert.deepEqual(native.cases, queryPathCases);
    assert.equal(native.observations.length, queryPathCases.length * 3 + 8);
    const unconditional = /path-(?:negatedAnd|literalOr|concreteErrorOr|concreteErrorAnd|budgetErrorOr)-/;
    const granted = /^path-(?:members|getMembers|functionMembers|reversedMembers)-granted$/;
    const baseline = new Set(["owner-equality", "get-fixed-path", "limit-allowed"]);
    for (const testCase of queryPathCases) {
      const expected = baseline.has(testCase.id) || granted.test(testCase.id) || unconditional.test(testCase.id) || testCase.id === "path-members-empty-granted" ? 0 : 7;
      const values = native.observations.filter(value => value.id === testCase.id && ["RunQuery", "RunAggregationQuery", "Listen"].includes(value.operation));
      assert.deepEqual(values.map(value => value.operation), ["RunQuery", "RunAggregationQuery", "Listen"]);
      for (const value of values) assert.equal(value.code, expected, `${testCase.id} ${value.operation}`);
      if (expected === 0) {
        assert.deepEqual([...new Set(values[0]!.documents)].sort(), [...new Set(values[2]!.documents)].sort());
        assert.equal(values[1]!.count, String(new Set(values[0]!.documents).size));
      }
    }
    assert.deepEqual(native.observations.filter(value => value.operation === "ListDocuments").map(({ id, code }) => [id, code]), [
      ["owner-absent", 7], ["owner-empty-unconstrained", 7], ["get-fixed-path", 0], ["limit-allowed", 0],
      ["path-members-granted", 0], ["path-members-denied", 7], ["path-members-empty-granted", 0],
    ]);
    for (const variant of ["long-poll", "streaming"]) {
      verifyBrowserCapture(await json<BrowserCapture>(directory, `${variant}-browser.json`), native);
      const wire = await json<Wire>(directory, `${variant}-wire.json`);
      assert.ok(wire.exchanges.some(({ request }) => new URL(request.uri, "http://localhost").searchParams.get("CI") === (variant === "long-poll" ? "1" : "0")));
      const aggregation = await json<Wire>(directory, `${variant}-aggregation-wire.json`);
      assert.equal(aggregation.exchanges.filter(({ request }) => request.uri.includes(":runAggregationQuery") && request.bodyBase64).length, queryPathCases.length);
      for (const capture of [wire, aggregation]) for (const { request, response } of capture.exchanges) {
        for (const header of request.headers) if (["authorization", "x-goog-api-key", "cookie"].includes(header.name.toLowerCase())) assert.equal(header.value, "[REDACTED]");
        const body = Buffer.from(request.bodyBase64 ?? "", "base64").toString();
        assert.doesNotMatch(body, /eyJhbGciOiJub25lI/);
        const embeddedHeaders = new URLSearchParams(body).get("headers");
        if (embeddedHeaders) assert.match(embeddedHeaders, /Authorization:\[REDACTED\]/i);
        assert.ok([200, 204, 400, 403].includes(response.status));
      }
    }
  });
}

test("both pinned official JARs agree on every query-path observation", async () => {
  const root = new URL("../fixtures/rules-v2/query-paths/", import.meta.url);
  compareNativeCapture(await json<NativeCapture>(new URL("java-1.21.0/", root), "grpc.json"), await json<NativeCapture>(new URL("java-1.22.0/", root), "grpc.json"));
});
