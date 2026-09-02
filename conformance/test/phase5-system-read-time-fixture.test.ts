import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const fixtureUrl = new URL(
  "../fixtures/phase5/system-read-time-microsecond-precision.json",
  import.meta.url,
);

test("system read times remain reusable by clients that enforce microsecond precision", async () => {
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8")) as {
    readonly contract: {
      readonly appliesTo: readonly string[];
      readonly incomingUnaryReadTimePrecisionRuleMayChange: boolean;
      readonly phase5ThresholdsMayChange: boolean;
      readonly systemReadTimeMaximumPrecision: string;
      readonly systemReadTimeNanosecondsDivisor: number;
      readonly systemReadTimeNanosecondsRemainder: number;
      readonly userTimestampFieldPrecision: string;
    };
    readonly observation: {
      readonly datasetDocuments: number;
      readonly failedSystemdUnits: number;
      readonly failureMechanism: string;
      readonly firesideImportCompleted: boolean;
      readonly grpcCode: number;
      readonly grpcDetails: string;
      readonly grpcStatus: string;
      readonly kernelOomEvidence: number;
      readonly officialCacheBuildMilliseconds: number;
      readonly officialJavaToolOptions: string;
    };
    readonly oracle: {
      readonly outcome: string;
    };
    readonly schemaVersion: number;
  };

  assert.equal(fixture.schemaVersion, 1);
  assert.match(fixture.oracle.outcome, /identical .* query .* completed/u);
  assert.equal(fixture.observation.datasetDocuments, 211_202);
  assert.equal(fixture.observation.officialCacheBuildMilliseconds, 24_763);
  assert.equal(fixture.observation.officialJavaToolOptions, "-Xmx8g");
  assert.equal(fixture.observation.firesideImportCompleted, true);
  assert.equal(fixture.observation.grpcCode, 3);
  assert.equal(fixture.observation.grpcStatus, "INVALID_ARGUMENT");
  assert.equal(
    fixture.observation.grpcDetails,
    "read_time cannot have more than microseconds precision",
  );
  assert.match(fixture.observation.failureMechanism, /reused Fireside's .* read_time/u);
  assert.equal(fixture.observation.kernelOomEvidence, 0);
  assert.equal(fixture.observation.failedSystemdUnits, 0);
  assert.deepEqual(fixture.contract, {
    appliesTo: [
      "BatchGetDocumentsResponse.read_time",
      "RunQueryResponse.read_time",
      "RunAggregationQueryResponse.read_time",
    ],
    incomingUnaryReadTimePrecisionRuleMayChange: false,
    phase5ThresholdsMayChange: false,
    systemReadTimeMaximumPrecision: "microseconds",
    systemReadTimeNanosecondsDivisor: 1_000,
    systemReadTimeNanosecondsRemainder: 0,
    userTimestampFieldPrecision: "nanoseconds remain supported",
  });
});
