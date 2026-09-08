import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { GoogleAuth } from "google-auth-library";

import {
  PHASE3_RULES_CASE_COUNT,
  PHASE3_RULES_ORACLE_SEED,
  PHASE3_RULES_PROJECT_ID,
  buildPhase3ExpressionOracleBatches,
} from "./phase3-oracle-plan.ts";

const allowlist = process.env.CONFORMANCE_CLOUD_ALLOWLIST;
if (allowlist !== PHASE3_RULES_PROJECT_ID) {
  throw new Error(
    `rules oracle requires CONFORMANCE_CLOUD_ALLOWLIST=${PHASE3_RULES_PROJECT_ID}`,
  );
}
if (process.env.FIRESTORE_EMULATOR_HOST !== undefined) {
  throw new Error("rules oracle refuses FIRESTORE_EMULATOR_HOST");
}

const outputRoot = resolve("fixtures/rules-v2");
const outputPath = resolve(outputRoot, "production-expression-corpus.json");
const batches = buildPhase3ExpressionOracleBatches();
const auth = new GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
});
const client = await auth.getClient();
const captured = [];

for (const [index, batch] of batches.entries()) {
  const response = await client.request({
    url: `https://firebaserules.googleapis.com/v1/projects/${PHASE3_RULES_PROJECT_ID}:test`,
    method: "POST",
    data: {
      source: {
        files: [{ name: "firestore.rules", content: batch.source }],
      },
      testSuite: {
        testCases: batch.cases.map((testCase) => ({
          expectation: testCase.expectation,
          request: testCase.request,
          pathEncoding: testCase.pathEncoding,
          expressionReportLevel: testCase.expressionReportLevel,
        })),
      },
    },
  });
  const body = response.data as {
    issues?: Array<{ severity?: string }>;
    testResults?: unknown[];
  };
  const compilerErrors =
    body.issues?.filter(({ severity }) => severity === "ERROR") ?? [];
  if (compilerErrors.length !== 0) {
    throw new Error(
      `${batch.id} returned compiler errors: ${JSON.stringify(compilerErrors)}`,
    );
  }
  if ((body.testResults?.length ?? 0) !== batch.cases.length) {
    throw new Error(
      `${batch.id} returned ${body.testResults?.length ?? 0} results for ${batch.cases.length} cases`,
    );
  }
  captured.push({
    id: batch.id,
    sourceSha256: sha256(batch.source),
    source: batch.source,
    cases: batch.cases,
    response: body,
  });
  console.log(`captured ${index + 1}/${batches.length} ${batch.id}`);
}

const fixture = {
  schemaVersion: 1,
  target: "production-firebase-rules-projects-test",
  targetProject: PHASE3_RULES_PROJECT_ID,
  endpoint: `https://firebaserules.googleapis.com/v1/projects/${PHASE3_RULES_PROJECT_ID}:test`,
  generatorSeed: PHASE3_RULES_ORACLE_SEED,
  capturedAt: new Date().toISOString(),
  pathEncoding: "PLAIN",
  expressionReportLevel: "FULL",
  expectationProbe: "ALLOW",
  credentialsStored: false,
  authorizationHeadersStored: false,
  persistentCloudReads: 0,
  persistentCloudWrites: 0,
  caseCount: PHASE3_RULES_CASE_COUNT,
  batchCount: captured.length,
  batches: captured,
};
await mkdir(outputRoot, { recursive: true });
await writeFile(outputPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
console.log(`wrote ${outputPath}`);
console.log(`fixture sha256 ${sha256(JSON.stringify(fixture))}`);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
