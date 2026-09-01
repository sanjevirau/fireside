import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { GoogleAuth } from "google-auth-library";

import { PHASE3_RULES_PROJECT_ID } from "./phase3-oracle-plan.ts";

const allowlist = process.env.CONFORMANCE_CLOUD_ALLOWLIST;
if (allowlist !== PHASE3_RULES_PROJECT_ID) {
  throw new Error(
    `rules oracle requires CONFORMANCE_CLOUD_ALLOWLIST=${PHASE3_RULES_PROJECT_ID}`,
  );
}
if (process.env.FIRESTORE_EMULATOR_HOST !== undefined) {
  throw new Error("rules oracle refuses FIRESTORE_EMULATOR_HOST");
}

type Method = "get" | "list" | "update";

interface LanguageCase {
  readonly id: string;
  readonly category: string;
  readonly expression: string;
  readonly method?: Method;
  readonly path?: string;
  readonly requestExtra?: Readonly<Record<string, unknown>>;
  readonly resource?: Readonly<Record<string, unknown>>;
  readonly customMatch?: string;
}

const cases: readonly LanguageCase[] = [
  expression("string-trim", "string", "'  Fireside  '.trim() == 'Fireside'"),
  expression("string-case", "string", "'FiRe'.lower() == 'fire' && 'FiRe'.upper() == 'FIRE'"),
  expression("string-replace", "string", "'abcabc'.replace('a', 'x') == 'xbcxbc'"),
  expression("string-split", "string", "'a,b,c'.split(',') == ['a', 'b', 'c']"),
  expression("string-match", "string", "'phase3'.matches('^phase[0-9]$')"),
  expression("string-coercion", "string", "string(123) == '123' && string(true) == 'true'"),
  expression("list-concat", "list", "[1, 2].concat([3]) == [1, 2, 3]"),
  expression("list-membership", "list", "[1, 2, 3].hasAll([1, 3]) && [1, 2, 3].hasAny([9, 2])"),
  expression("list-has-only", "list", "[1, 2, 2].hasOnly([2, 1])"),
  expression("list-join", "list", "['a', 'b', 'c'].join('-') == 'a-b-c'"),
  expression("list-remove-all", "list", "[1, 2, 3, 2].removeAll([2]) == [1, 3]"),
  expression("list-index-range", "list", "[10, 20, 30][1] == 20 && [10, 20, 30][0:2] == [10, 20]"),
  expression("map-get", "map", "{'a': 1}.get('missing', 7) == 7 && {'a': 1}.get('a', 7) == 1"),
  expression("map-keys-values", "map", "{'a': 1, 'b': 2}.keys().hasOnly(['a', 'b']) && {'a': 1, 'b': 2}.values().hasAll([1, 2])"),
  expression("map-size-membership", "map", "{'a': 1, 'b': 2}.size() == 2 && 'a' in {'a': 1}"),
  expression("map-diff", "map-diff", "{'a': 1, 'b': 2}.diff({'a': 1, 'b': 3, 'c': 4}).affectedKeys().hasOnly(['b', 'c'])"),
  expression("map-diff-sets", "map-diff", "{'a': 1, 'b': 2}.diff({'a': 1, 'b': 3, 'c': 4}).changedKeys().hasOnly(['b']) && {'a': 1, 'b': 2}.diff({'a': 1, 'b': 3, 'c': 4}).addedKeys().hasOnly(['c'])"),
  expression("set-union", "set", "['a', 'b'].toSet().union(['b', 'c'].toSet()).hasOnly(['a', 'b', 'c'])"),
  expression("set-intersection", "set", "['a', 'b'].toSet().intersection(['b', 'c'].toSet()).hasOnly(['b'])"),
  expression("set-difference", "set", "['a', 'b'].toSet().difference(['b'].toSet()).hasOnly(['a'])"),
  expression("bytes-size-hex", "bytes", "'abc'.toUtf8().size() == 3 && 'abc'.toUtf8().toHexString() == '616263'"),
  expression("bytes-base64-unicode", "bytes", "'é'.toUtf8().size() == 2 && 'abc'.toUtf8().toBase64() == 'YWJj'"),
  expression("duration-seconds", "duration", "duration.value(90, 's').seconds() == 90"),
  expression("duration-nanos", "duration", "duration.value(123, 'ns').nanos() == 123"),
  expression("timestamp-date", "timestamp", "timestamp.date(2024, 2, 29).year() == 2024 && timestamp.date(2024, 2, 29).month() == 2"),
  expression("timestamp-components", "timestamp", "timestamp.date(2024, 2, 29).day() == 29 && timestamp.date(2024, 2, 29).dayOfWeek() == 4"),
  expression("timestamp-arithmetic", "timestamp", "timestamp.date(2024, 2, 29) + duration.value(1, 'd') == timestamp.date(2024, 3, 1)"),
  expression("latlng-components", "latlng", "latlng.value(1.25, 2.5).latitude() == 1.25 && latlng.value(1.25, 2.5).longitude() == 2.5"),
  expression("latlng-distance", "latlng", "latlng.value(1, 2).distance(latlng.value(1, 2)) == 0.0"),
  expression("math-basic", "math", "math.abs(-2) == 2 && math.ceil(1.2) == 2 && math.floor(1.8) == 1"),
  expression("math-round-sqrt", "math", "math.round(1.6) == 2 && math.sqrt(81) == 9"),
  expression("math-pow", "math", "math.pow(2, 3) == 8"),
  expression("hashing-md5", "hashing", "hashing.md5('abc'.toUtf8()).toHexString() == '900150983CD24FB0D6963F7D28E17F72'"),
  expression("hashing-sha256", "hashing", "hashing.sha256('abc'.toUtf8()).toHexString() == 'BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD'"),
  expression("debug-return", "debug", "debug(request.auth.uid) == 'phase3-user'"),
  expression("request-auth", "request", "request.auth.uid == 'phase3-user' && request.auth.token.role == 'editor'"),
  expression("request-method-time", "request", "request.method == 'get' && request.time.year() == 2026"),
  expression("path-value", "path", "resource.__name__ == /databases/$(database)/documents/phase3-language/path-value", {
    resource: document("path-value", { marker: true }),
  }),
  expression("function-let", "function", "usesLet(3)", {
    customMatch: `    function usesLet(input) {
      let doubled = input * 2;
      let shifted = doubled + 1;
      return shifted == 7;
    }
    match /phase3-language/function-let {
      allow get: if usesLet(3);
    }`,
  }),
  expression("resource-update-diff", "resource", "resource.data.name == 'before' && request.resource.data.name == 'after' && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['name'])", {
    method: "update",
    resource: document("resource-update-diff", { name: "before", count: 1 }),
    requestExtra: {
      resource: document("resource-update-diff", { name: "after", count: 1 }),
    },
  }),
  expression("query-limit", "query", "request.query.limit == 10", {
    method: "list",
    requestExtra: { query: { limit: 10 } },
  }),
  expression("nested-match", "match", "true", {
    path: documentPath("nested-match/child/doc"),
    customMatch: `    match /phase3-language/nested-match {
      match /child/{childId} {
        allow get: if childId == 'doc';
      }
    }`,
  }),
  expression("recursive-match", "match", "true", {
    path: documentPath("recursive-match/a/b/c"),
    customMatch: `    match /phase3-language/recursive-match/{tail=**} {
      allow get: if tail == /a/b/c;
    }`,
  }),
  expression("overlapping-allow", "match", "true", {
    customMatch: `    match /phase3-language/overlapping-allow {
      allow get: if false;
      allow read: if true;
    }`,
  }),
] as const;

const source = buildSource(cases);
const testCases = cases.map((testCase) => ({
  expectation: "ALLOW",
  request: {
    auth: {
      uid: "phase3-user",
      token: { role: "editor", score: 7, cohort: "language" },
    },
    method: testCase.method ?? "get",
    path: testCase.path ?? documentPath(testCase.id),
    time: "2026-01-15T12:34:56.123456789Z",
    ...testCase.requestExtra,
  },
  ...(testCase.resource === undefined ? {} : { resource: testCase.resource }),
  pathEncoding: "PLAIN",
  expressionReportLevel: "FULL",
}));

const client = await new GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
}).getClient();
const response = await client.request({
  url: `https://firebaserules.googleapis.com/v1/projects/${PHASE3_RULES_PROJECT_ID}:test`,
  method: "POST",
  data: {
    source: { files: [{ name: "firestore.rules", content: source }] },
    testSuite: { testCases },
  },
});
const responseData = response.data as {
  readonly issues?: ReadonlyArray<{ readonly severity?: string; readonly description?: string }>;
  readonly testResults?: ReadonlyArray<{ readonly state?: string }>;
};
const errors = (responseData.issues ?? []).filter(
  ({ severity }) => severity === "ERROR",
);
if (errors.length > 0) {
  throw new Error(`language oracle source rejected: ${JSON.stringify(errors)}`);
}
if (responseData.testResults?.length !== cases.length) {
  throw new Error(
    `language oracle returned ${responseData.testResults?.length ?? 0}/${cases.length} results`,
  );
}

const outputRoot = resolve("fixtures/rules-v2");
await mkdir(outputRoot, { recursive: true });
const fixture = {
  schemaVersion: 1,
  target: "production-firebase-rules-projects-test",
  targetProject: PHASE3_RULES_PROJECT_ID,
  capturedAt: new Date().toISOString(),
  credentialsStored: false,
  authorizationHeadersStored: false,
  persistentCloudReads: 0,
  persistentCloudWrites: 0,
  source,
  sourceSha256: sha256(source),
  cases,
  testCases,
  response: responseData,
};
const output = `${JSON.stringify(fixture, null, 2)}\n`;
await writeFile(resolve(outputRoot, "production-language-contract.json"), output);
console.log(
  JSON.stringify(
    {
      caseCount: cases.length,
      success: responseData.testResults.filter(({ state }) => state === "SUCCESS").length,
      failure: responseData.testResults.filter(({ state }) => state === "FAILURE").length,
      warningCount: (responseData.issues ?? []).filter(
        ({ severity }) => severity === "WARNING",
      ).length,
      sha256: sha256(output),
    },
    null,
    2,
  ),
);

function expression(
  id: string,
  category: string,
  expressionValue: string,
  options: Omit<LanguageCase, "id" | "category" | "expression"> = {},
): LanguageCase {
  return { id, category, expression: expressionValue, ...options };
}

function buildSource(languageCases: readonly LanguageCase[]): string {
  const matches = languageCases
    .map(
      (testCase) =>
        testCase.customMatch ??
        `    match /phase3-language/${testCase.id} {
      allow ${testCase.method ?? "get"}: if ${testCase.expression};
    }`,
    )
    .join("\n");
  return `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
${matches}
  }
}
`;
}

function documentPath(relativePath: string): string {
  return `/databases/(default)/documents/phase3-language/${relativePath}`;
}

function document(
  relativePath: string,
  data: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return { __name__: documentPath(relativePath), data };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
