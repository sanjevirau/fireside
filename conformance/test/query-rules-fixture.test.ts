import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { queryRulesSource } from "../src/rules/query-rules-cases.ts";
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
