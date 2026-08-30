import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type {
  CaptureFixture,
  DecodedCaptureContract,
} from "../src/webchannel/capture-contract.ts";

const CASES = [
  "listen-long-poll",
  "listen-streaming",
  "write-long-poll",
  "write-streaming",
  "backchannel-reconnect-replay",
  "unicode-framing",
  "unknown-sid",
] as const;
const TARGETS = [
  {
    apiKey: "fireside-synthetic-emulator-key",
    directory: "java-v1.22.0",
    name: "Java",
    targetVersion: "1.22.0",
  },
  {
    apiKey: "fireside-synthetic-cloud-key",
    directory: "production-cloud-firestore",
    name: "production cloud",
    targetVersion: "production-2026-08-31",
  },
] as const;
const fixtureRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/webchannel-v8",
);

for (const target of TARGETS) {
  for (const captureCase of CASES) {
    test(`${target.name} WebChannel fixture is safe and internally exact: ${captureCase}`, async () => {
      const directory = join(fixtureRoot, target.directory, captureCase);
      const fixtureText = await readFile(join(directory, "fixture.json"), "utf8");
      const contractText = await readFile(
        join(directory, "decoded-contract.json"),
        "utf8",
      );
      const sums = await readFile(join(directory, "SHA256SUMS"), "utf8");
      const fixture = JSON.parse(fixtureText) as CaptureFixture;
      const contract = JSON.parse(contractText) as DecodedCaptureContract;

      assert.equal(fixture.schemaVersion, 1);
      assert.equal(fixture.metadata.target, target.directory);
      assert.equal(fixture.metadata.targetVersion, target.targetVersion);
      assert.equal(fixture.metadata.sdk, "firebase@12.18.0");
      assert.ok(fixture.exchanges.length > 0);
      assert.equal(contract.exchanges.length, fixture.exchanges.length);
      assert.ok(!fixtureText.includes(target.apiKey));
      assert.ok(!/Bearer\s+(?!\[REDACTED\])/iu.test(fixtureText));
      assert.equal(
        sums,
        `${sha256(fixtureText)}  fixture.json\n${sha256(contractText)}  decoded-contract.json\n`,
      );

      for (const exchange of fixture.exchanges) {
        assert.notEqual(exchange.response.status, 0);
        const chunks = exchange.response.bodyChunksBase64 ?? [];
        if (chunks.length > 0) {
          assert.equal(
            Buffer.concat(chunks.map((chunk) => Buffer.from(chunk, "base64"))).toString("base64"),
            exchange.response.bodyBase64,
          );
        }
      }
      for (const exchange of contract.exchanges) {
        for (const frame of exchange.response.frames) {
          assert.equal(
            frame.declaredUtf16CodeUnits,
            frame.observedUtf16CodeUnits,
          );
        }
      }
    });
  }
}

for (const target of TARGETS) {
  test(`${target.name} fixtures distinguish long polling, streaming, retry, and UTF-16 framing`, async () => {
    const longPoll = await readContract(target.directory, "listen-long-poll");
    const streaming = await readContract(target.directory, "listen-streaming");
    const reconnect = await readContract(
      target.directory,
      "backchannel-reconnect-replay",
    );
    const unicode = await readContract(target.directory, "unicode-framing");

    assert.ok(hasQueryValue(longPoll, "CI", "1"));
    assert.ok(hasQueryValue(streaming, "CI", "0"));
    assert.ok(hasQueryValue(reconnect, "t", "2"));
    assert.ok(hasQueryValue(unicode, "CI", "0"));
    assert.ok(hasQueryValue(unicode, "CI", "1"));
    assert.ok(
      unicode.exchanges.some((exchange) =>
        exchange.response.frames.some((frame) =>
          frame.utf8Bytes > frame.observedUtf16CodeUnits &&
          frame.text.includes("東京")
        )
      ),
    );

    const replayIds = reconnect.exchanges.flatMap((exchange) =>
      exchange.response.frames.flatMap(arrayIds)
    );
    assert.ok(replayIds.length >= 5);
    assert.deepEqual(
      replayIds,
      Array.from({ length: replayIds.length }, (_, index) => index),
    );
  });
}

test("Java and cloud fixtures pin their handshake and unknown-SID deviations", async () => {
  const java = await readContract("java-v1.22.0", "listen-streaming");
  const cloud = await readContract(
    "production-cloud-firestore",
    "listen-streaming",
  );
  const javaHandshake = findHandshake(java);
  const cloudHandshake = findHandshake(cloud);

  assertHandshakeRequest(javaHandshake);
  assertHandshakeRequest(cloudHandshake);
  assert.equal(responseHeader(javaHandshake, "x-client-wire-protocol"), undefined);
  assert.equal(responseHeader(javaHandshake, "x-http-session-id"), undefined);
  assert.equal(responseHeader(cloudHandshake, "x-client-wire-protocol"), "h2");
  const cloudGsessionId = responseHeader(cloudHandshake, "x-http-session-id");
  assert.ok(cloudGsessionId !== undefined && cloudGsessionId.length > 0);
  assert.ok(hasQueryValue(cloud, "gsessionid", cloudGsessionId));

  const javaUnknown = await readContract("java-v1.22.0", "unknown-sid");
  const cloudUnknown = await readContract(
    "production-cloud-firestore",
    "unknown-sid",
  );
  assert.equal(javaUnknown.exchanges[0]?.response.status, 400);
  assert.equal(javaUnknown.exchanges[0]?.response.bodyText, undefined);
  assert.equal(cloudUnknown.exchanges[0]?.response.status, 400);
  assert.match(cloudUnknown.exchanges[0]?.response.bodyText ?? "", /Unknown SID/u);
});

test("cloud folded authorization is redacted and termination keeps its empty-body length", async () => {
  const fixtureText = await readFile(
    join(
      fixtureRoot,
      "production-cloud-firestore",
      "write-streaming",
      "fixture.json",
    ),
    "utf8",
  );
  const contract = await readContract(
    "production-cloud-firestore",
    "write-streaming",
  );
  const handshake = findHandshake(contract);
  const foldedHeaders = handshake.request.form?.find(([name]) => name === "headers")?.[1];
  assert.match(foldedHeaders ?? "", /authorization:\[REDACTED\]/iu);
  assert.match(foldedHeaders ?? "", /x-goog-api-key:\[REDACTED\]/iu);
  assert.ok(!/Bearer\s+(?!\[REDACTED\])/iu.test(fixtureText));

  const terminate = contract.exchanges.find((exchange) =>
    exchange.request.query.some(([name, value]) =>
      name === "TYPE" && value === "terminate"
    )
  );
  assert.ok(terminate !== undefined);
  assert.equal(terminate.response.status, 200);
});

test("Java and cloud forward acknowledgements pin open and active backchannels", async () => {
  for (const target of TARGETS) {
    const longPoll = await readContract(target.directory, "write-long-poll");
    const streaming = await readContract(target.directory, "write-streaming");
    assert.ok(hasFrameJson(longPoll, [0, 1, 7]));
    assert.ok(
      streaming.exchanges.some((exchange) =>
        exchange.response.frames.some((frame) => {
          const value = frame.json;
          return Array.isArray(value) &&
            value.length === 3 &&
            value[0] === 1 &&
            typeof value[1] === "number" &&
            value[2] === 7;
        })
      ),
    );
  }
});

function assertHandshakeRequest(
  handshake: DecodedCaptureContract["exchanges"][number],
): void {
  assert.deepEqual(
    handshake.request.query.filter(([name]) =>
      name === "VER" || name === "CVER" || name === "X-HTTP-Session-Id"
    ),
    [
      ["VER", "8"],
      ["CVER", "22"],
      ["X-HTTP-Session-Id", "gsessionid"],
    ],
  );
  const foldedHeaders = handshake.request.form?.find(([name]) => name === "headers")?.[1];
  assert.match(foldedHeaders ?? "", /x-goog-api-key:\[REDACTED\]/iu);
  assert.equal(handshake.request.form?.find(([name]) => name === "count")?.[1], "1");
  assert.equal(handshake.request.form?.find(([name]) => name === "ofs")?.[1], "0");
}

function findHandshake(
  contract: DecodedCaptureContract,
): DecodedCaptureContract["exchanges"][number] {
  const handshake = contract.exchanges.find((exchange) =>
    exchange.request.method === "POST" &&
    exchange.request.query.some(([name]) => name === "CVER")
  );
  assert.ok(handshake !== undefined);
  return handshake;
}

function responseHeader(
  exchange: DecodedCaptureContract["exchanges"][number],
  name: string,
): string | undefined {
  return exchange.response.headers.find((header) =>
    header.name.toLowerCase() === name.toLowerCase()
  )?.value;
}

function arrayIds(
  frame: DecodedCaptureContract["exchanges"][number]["response"]["frames"][number],
): number[] {
  return Array.isArray(frame.json)
    ? frame.json.flatMap((value) =>
      Array.isArray(value) && typeof value[0] === "number" ? [value[0]] : []
    )
    : [];
}

async function readContract(
  target: (typeof TARGETS)[number]["directory"],
  captureCase: (typeof CASES)[number],
): Promise<DecodedCaptureContract> {
  return JSON.parse(
    await readFile(
      join(fixtureRoot, target, captureCase, "decoded-contract.json"),
      "utf8",
    ),
  ) as DecodedCaptureContract;
}

function hasQueryValue(
  contract: DecodedCaptureContract,
  name: string,
  value: string,
): boolean {
  return contract.exchanges.some((exchange) =>
    exchange.request.query.some(([candidateName, candidateValue]) =>
      candidateName === name && candidateValue === value
    )
  );
}

function hasFrameJson(
  contract: DecodedCaptureContract,
  expected: unknown,
): boolean {
  return contract.exchanges.some((exchange) =>
    exchange.response.frames.some((frame) =>
      JSON.stringify(frame.json) === JSON.stringify(expected)
    )
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
