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
  "bundle-nanosecond-read-time",
  "write-long-poll",
  "write-streaming",
  "write-cross-client-update",
  "write-missing-update-error",
  "write-overlap",
  "multiple-inequality-query",
  "numeric-resource-id-ordering",
  "reserved-resource-id-error",
  "backchannel-reconnect-replay",
  "unicode-framing",
  "unknown-sid",
] as const;
const SOURCE_PARTITION_NAMES = [
  "aggregation",
  "array-transforms",
  "batch-writes",
  "bundles",
  "composite-index-query",
  "cursors",
  "database",
  "fields",
  "get-options",
  "index-configuration",
  "large-document",
  "numeric-transforms",
  "persistent-cache-index-manager",
  "pipelines",
  "provider",
  "queries",
  "query-to-pipeline",
  "server-timestamps",
  "smoke",
  "transactions",
  "types",
  "validation",
] as const;
const BROWSER_PROCESS_PLAN = {
  strategy: "top-level-suite-with-immediate-child-chunks",
  maximumImmediateChildrenPerProcess: 5,
  chunkedSourcePartitions: ["database", "queries", "query-to-pipeline"],
  isolatedImmediateSuiteSourcePartitions: ["pipelines"],
  outerPersistenceModes: {
    memory: ["memory_lru_gc"],
    persistence: ["memory_lru_gc", "indexeddb"],
  },
  unscopedSuitePolicy: "once-per-client-build",
  expectedProcessPartitions: {
    memory: 66,
    persistence: 131,
  },
  expectedPlanSha256: {
    memory: "dc34ccdf301afa74aa9eb83e2c944dc9b7614cd8d01d494c706601b123ed8c11",
    persistence:
      "80688193a06f9f1dca791ca1e84905a8ba6d1f61ee7d24832eaa14a367ab0a11",
  },
} as const;
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

test("pinned Firebase JS SDK gate mirrors Google's minified integration workflow", async () => {
  const fixture = JSON.parse(
    await readFile(
      join(fixtureRoot, "firebase-js-sdk-integration-gate.json"),
      "utf8",
    ),
  ) as {
    readonly buildCommands: Readonly<Record<string, string>>;
    readonly clientPersistenceMatrix: readonly string[];
    readonly firebaseJsSdkRevision: string;
    readonly packageDirectory: string;
    readonly packageName: string;
    readonly localEmulatorProcessPartition: {
      readonly browserProcessPlan: typeof BROWSER_PROCESS_PLAN;
      readonly excludedSourceFiles: readonly string[];
      readonly nativeSkipOnlyPartition: {
        readonly acceptanceInvariant: string;
        readonly classification: string;
        readonly completedTests: number;
        readonly karmaExitCode: number;
        readonly nativeSkips: number;
        readonly observedCiRun: number;
        readonly suite: string;
      };
      readonly sourcePartitions: readonly {
        readonly name: string;
        readonly sourceFiles: readonly string[];
        readonly suiteTitles: readonly string[];
      }[];
    };
    readonly schemaVersion: number;
    readonly testArtifact: string;
    readonly testCommand: string;
    readonly workflowJob: string;
  };

  assert.equal(fixture.schemaVersion, 1);
  assert.equal(
    fixture.firebaseJsSdkRevision,
    "6cde0c0230b4c1da01d4a058333daa7663322fd1",
  );
  assert.equal(fixture.workflowJob, "test-firestore-integration");
  assert.equal(fixture.packageDirectory, "integration/firestore");
  assert.equal(fixture.packageName, "firebase-firestore-integration-test");
  assert.deepEqual(fixture.clientPersistenceMatrix, ["memory", "persistence"]);
  assert.deepEqual(fixture.buildCommands, {
    memory: "yarn build:memory",
    persistence: "yarn build:persistence",
  });
  assert.equal(fixture.testCommand, "xvfb-run yarn karma:singlerun");
  assert.equal(fixture.testArtifact, "dist/test-harness.js");
  assert.deepEqual(
    fixture.localEmulatorProcessPartition.browserProcessPlan,
    BROWSER_PROCESS_PLAN,
  );
  assert.deepEqual(
    fixture.localEmulatorProcessPartition.sourcePartitions.map(
      ({ name }) => name,
    ),
    SOURCE_PARTITION_NAMES,
  );
  assert.equal(
    fixture.localEmulatorProcessPartition.sourcePartitions.flatMap(
      ({ sourceFiles }) => sourceFiles,
    ).length,
    22,
  );
  assert.equal(
    fixture.localEmulatorProcessPartition.sourcePartitions.flatMap(
      ({ suiteTitles }) => suiteTitles,
    ).length,
    28,
  );
  assert.deepEqual(
    fixture.localEmulatorProcessPartition.excludedSourceFiles,
    [
      "pipeline.listen.test.ts",
      "pipeline.query.test.ts",
      "snapshot_listener_source.test.ts",
    ],
  );
  assert.deepEqual(
    fixture.localEmulatorProcessPartition.nativeSkipOnlyPartition,
    {
      observedCiRun: 33421790001,
      suite: "Large Documents",
      completedTests: 0,
      nativeSkips: 8,
      karmaExitCode: 1,
      classification: "passed-upstream-native-skip-only",
      acceptanceInvariant:
        "Accept a nonzero Karma exit only when the captured output reports TOTAL: 0 SUCCESS, at least one explicitly named native skip, no failed-test total, and no browser disconnect or infrastructure error. Preserve the partition and every native skip in evidence.",
    },
  );

  const manifest = JSON.parse(
    await readFile(join(fixtureRoot, "../../../benchmarks/phase-2-webchannel.json"), "utf8"),
  ) as {
    readonly gates: {
      readonly firebaseJsSdkIntegration: {
        readonly browserProcessPlan: typeof BROWSER_PROCESS_PLAN;
        readonly clientPersistenceModes: readonly string[];
        readonly requiredMatrixCells: number;
        readonly serverModes: readonly string[];
        readonly upstreamBootstrap: string;
        readonly upstreamPackage: string;
        readonly upstreamWorkflowJob: string;
      };
    };
  };
  assert.deepEqual(
    manifest.gates.firebaseJsSdkIntegration.serverModes,
    ["memory", "disk-wal"],
  );
  assert.deepEqual(
    manifest.gates.firebaseJsSdkIntegration.clientPersistenceModes,
    ["memory", "persistence"],
  );
  assert.equal(manifest.gates.firebaseJsSdkIntegration.requiredMatrixCells, 4);
  assert.deepEqual(
    manifest.gates.firebaseJsSdkIntegration.browserProcessPlan,
    BROWSER_PROCESS_PLAN,
  );
  assert.equal(
    manifest.gates.firebaseJsSdkIntegration.upstreamWorkflowJob,
    fixture.workflowJob,
  );
  assert.equal(
    manifest.gates.firebaseJsSdkIntegration.upstreamPackage,
    fixture.packageDirectory,
  );
  assert.equal(
    manifest.gates.firebaseJsSdkIntegration.upstreamBootstrap,
    `${fixture.packageDirectory}/${fixture.testArtifact}`,
  );
});

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
  test(`${target.name} numeric resource ID fixture pins the reserved-namespace exception`, async () => {
    const contract = await readContract(
      target.directory,
      "numeric-resource-id-ordering",
    );
    const encoded = JSON.stringify(contract);

    assert.ok(hasQueryValue(contract, "CI", "0"));
    assert.ok(hasQueryValue(contract, "CI", "1"));
    for (const identifier of [
      "__id-9223372036854775808__",
      "__id-2__",
      "__id7__",
      "__id9223372036854775807__",
    ]) {
      assert.ok(encoded.includes(identifier), `missing ${identifier}`);
    }
    assert.doesNotMatch(encoded, /invalid because it is reserved/u);
  });

  test(`${target.name} reserved resource ID fixture pins the exact browser-visible error`, async () => {
    const contract = await readContract(
      target.directory,
      "reserved-resource-id-error",
    );
    const encoded = JSON.stringify(contract);

    assert.ok(hasQueryValue(contract, "CI", "0"));
    assert.ok(hasQueryValue(contract, "CI", "1"));
    assert.match(encoded, /documents\/a\/__badpath__/u);
    assert.match(encoded, /"code":3/u);
    assert.ok(
      encoded.includes(
        'Resource id \\"__badpath__\\" is invalid because it is reserved.',
      ),
    );
  });

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

test("Java and cloud fixtures pin inequality type ranges and key-order validation", async () => {
  const java = await readContract("java-v1.22.0", "multiple-inequality-query");
  const cloud = await readContract(
    "production-cloud-firestore",
    "multiple-inequality-query",
  );
  for (const contract of [java, cloud]) {
    const serialized = JSON.stringify(contract);
    assert.match(serialized, /\/doc1/u);
    assert.match(serialized, /\/doc5/u);
    assert.match(serialized, /\/doc6/u);
    assert.doesNotMatch(serialized, /\/doc2/u);
    assert.doesNotMatch(serialized, /\/doc3/u);
    assert.doesNotMatch(serialized, /\/doc4/u);
    assert.match(
      serialized,
      /order by clause cannot contain more fields after the key/iu,
    );
    assert.match(
      serialized,
      /Equality on key is not allowed if there are other inequality fields/iu,
    );
  }
  assert.match(JSON.stringify(cloud), /query requires an index/iu);
  assert.doesNotMatch(JSON.stringify(java), /query requires an index/iu);
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

test("Java and cloud accept overlapping writes that reuse the last acknowledged stream token", async () => {
  for (const target of TARGETS) {
    const overlap = await readContract(target.directory, "write-overlap");
    const writeMaps = overlap.exchanges.flatMap((exchange) =>
      (exchange.request.form ?? []).flatMap(([name, value]) =>
        name.endsWith("___data__") && value.includes("\"writes\"")
          ? [JSON.parse(value) as { readonly streamToken?: string }]
          : []
      )
    );
    assert.ok(writeMaps.length >= 4);
    const repeatedTokens = writeMaps.map((value) => value.streamToken ?? "");
    assert.ok(new Set(repeatedTokens).size < repeatedTokens.length);
    assert.ok(
      overlap.exchanges.flatMap((exchange) => exchange.response.frames)
        .flatMap((frame) => Array.isArray(frame.json) ? frame.json : [])
        .filter((value) => Array.isArray(value) && value[1]?.[0]?.writeResults !== undefined)
        .length >= 4,
    );
  }
});

test("Java and cloud accept bundle Listen targets with nanosecond read times", async () => {
  for (const target of TARGETS) {
    const contract = await readContract(
      target.directory,
      "bundle-nanosecond-read-time",
    );
    const targetMaps = contract.exchanges.flatMap((exchange) =>
      (exchange.request.form ?? []).flatMap(([name, value]) =>
        name.endsWith("___data__") && value.includes("\"addTarget\"")
          ? [JSON.parse(value) as {
            readonly addTarget?: { readonly readTime?: string };
          }]
          : []
      )
    );
    assert.equal(targetMaps.length, 2);
    assert.deepEqual(
      targetMaps.map((value) => value.addTarget?.readTime),
      [
        "1970-01-01T00:16:40.000009999Z",
        "1970-01-01T00:16:40.000009999Z",
      ],
    );
    assert.ok(hasQueryValue(contract, "CI", "0"));
    assert.ok(hasQueryValue(contract, "CI", "1"));

    const responses = JSON.stringify(
      contract.exchanges.map((exchange) => exchange.response),
    );
    assert.match(responses, /bundle_capture\/oracle-second/u);
    assert.doesNotMatch(responses, /bundle_capture\/oracle-first/u);
    assert.doesNotMatch(responses, /INVALID_ARGUMENT/u);
    assert.doesNotMatch(responses, /microseconds precision/u);
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
