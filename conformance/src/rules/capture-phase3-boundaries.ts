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

const outputRoot = resolve("fixtures/rules-v2");
const auth = new GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
});
const client = await auth.getClient();
const endpoint = `https://firebaserules.googleapis.com/v1/projects/${PHASE3_RULES_PROJECT_ID}:test`;

interface Observation {
  readonly id: string;
  readonly sourceSha256: string;
  readonly sourceBytes: number;
  readonly source: string;
  readonly httpStatus: number;
  readonly response: unknown;
}

const parseCases = [
  {
    id: "unexpected-token",
    source: wrap("allow get: if ;"),
  },
  {
    id: "unclosed-block",
    source:
      "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n",
  },
  {
    id: "duplicate-let",
    source: wrap(
      "function duplicate() { let value = 1; let value = 2; return value == 2; }\n      allow get: if duplicate();",
    ),
  },
  {
    id: "undefined-name",
    source: wrap("allow get: if missingName == 1;"),
  },
  {
    id: "invalid-function-arity",
    source: wrap("allow get: if math.abs() == 1;"),
  },
  {
    id: "recursive-function",
    source: wrap(
      "function recurse() { return recurse(); }\n      allow get: if recurse();",
    ),
  },
  {
    id: "invalid-recursive-wildcard",
    source: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{first=**}/{second=**} {
      allow get: if true;
    }
  }
}
`,
  },
] as const;

const parseObservations: Observation[] = [];
for (const testCase of parseCases) {
  parseObservations.push(await observe(testCase.id, testCase.source, false));
  console.log(`captured parse boundary ${testCase.id}`);
}

for (const sourceBytes of [255_999, 256_000, 256_001, 262_143, 262_144, 262_145]) {
  const source = sourceWithExactBytes(sourceBytes);
  parseObservations.push(
    await observe(`source-bytes-${sourceBytes}`, source, false),
  );
  console.log(`captured source boundary ${sourceBytes}`);
}

const limitObservations: Observation[] = [];
for (const depth of [15, 16, 17, 18, 19, 20, 21, 22, 23]) {
  limitObservations.push(
    await observe(`function-depth-${depth}`, functionDepthSource(depth), true),
  );
  console.log(`captured function depth ${depth}`);
}

for (const terms of [20, 30, 40, 50, 60, 70, 80, 90, 100]) {
  limitObservations.push(
    await observe(
      `linear-expression-terms-${terms}`,
      linearExpressionCountSource(terms),
      true,
    ),
  );
  console.log(`captured linear expression terms ${terms}`);
}

for (const terms of [100, 125, 150, 175, 200, 225, 250, 300]) {
  limitObservations.push(
    await observe(
      `balanced-expression-terms-${terms}`,
      balancedExpressionCountSource(terms),
      true,
    ),
  );
  console.log(`captured balanced expression terms ${terms}`);
}

await mkdir(outputRoot, { recursive: true });
await writeFixture("production-parse-errors.json", {
  schemaVersion: 1,
  target: "production-firebase-rules-projects-test",
  targetProject: PHASE3_RULES_PROJECT_ID,
  capturedAt: new Date().toISOString(),
  credentialsStored: false,
  authorizationHeadersStored: false,
  observations: parseObservations,
});
await writeFixture("production-limit-probes.json", {
  schemaVersion: 1,
  target: "production-firebase-rules-projects-test",
  targetProject: PHASE3_RULES_PROJECT_ID,
  capturedAt: new Date().toISOString(),
  credentialsStored: false,
  authorizationHeadersStored: false,
  observations: limitObservations,
});

async function observe(
  id: string,
  source: string,
  includeTestCase: boolean,
): Promise<Observation> {
  const data: Record<string, unknown> = {
    source: { files: [{ name: "firestore.rules", content: source }] },
  };
  if (includeTestCase) {
    data.testSuite = {
      testCases: [
        {
          expectation: "ALLOW",
          request: {
            auth: { uid: "limit-probe", token: { n: 10_000 } },
            method: "get",
            path: "/databases/(default)/documents/phase3/limit-probe",
            time: "2026-01-01T00:00:00Z",
          },
          pathEncoding: "PLAIN",
          expressionReportLevel: "FULL",
        },
      ],
    };
  }
  let httpStatus = 200;
  let response: unknown;
  try {
    const result = await client.request({ url: endpoint, method: "POST", data });
    httpStatus = result.status;
    response = result.data;
  } catch (error) {
    const failure = error as {
      response?: { status?: number; data?: unknown };
      message?: string;
    };
    httpStatus = failure.response?.status ?? 0;
    response = failure.response?.data ?? { message: failure.message ?? "unknown error" };
  }
  return {
    id,
    sourceSha256: sha256(source),
    sourceBytes: Buffer.byteLength(source),
    source,
    httpStatus,
    response,
  };
}

function wrap(body: string): string {
  return `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /phase3/{document} {
      ${body}
    }
  }
}
`;
}

function sourceWithExactBytes(targetBytes: number): string {
  const base = wrap("allow get: if true;");
  const paddingLength = targetBytes - Buffer.byteLength(base);
  if (paddingLength < 0) {
    throw new Error(`target source size ${targetBytes} is too small`);
  }
  let remaining = paddingLength;
  let padding = "";
  while (remaining >= 3) {
    const lineLength = Math.min(remaining, 80);
    padding += `//${"x".repeat(lineLength - 3)}\n`;
    remaining -= lineLength;
  }
  padding += " ".repeat(remaining);
  const source = `${base}${padding}`;
  if (Buffer.byteLength(source) !== targetBytes) {
    throw new Error(`failed to produce ${targetBytes} source bytes`);
  }
  return source;
}

function functionDepthSource(depth: number): string {
  const functions = Array.from({ length: depth }, (_, index) => {
    const body = index + 1 === depth ? "true" : `f${index + 1}()`;
    return `  function f${index}() { return ${body}; }`;
  }).join("\n");
  return `rules_version = '2';
service cloud.firestore {
${functions}
  match /databases/{database}/documents/phase3/limit-probe {
    allow get: if f0();
  }
}
`;
}

function linearExpressionCountSource(terms: number): string {
  const expression = Array.from(
    { length: terms },
    (_, index) => `request.auth.token.n >= ${index}`,
  ).join(" && ");
  return wrap(`allow get: if ${expression};`);
}

function balancedExpressionCountSource(terms: number): string {
  const leafSize = 10;
  const leaves = Array.from(
    { length: Math.ceil(terms / leafSize) },
    (_, leafIndex) => {
      const start = leafIndex * leafSize;
      const end = Math.min(start + leafSize, terms);
      const expression = Array.from(
        { length: end - start },
        (_, offset) => `request.auth.token.n >= ${start + offset}`,
      ).join(" && ");
      return {
        name: `leaf${leafIndex}`,
        declaration: `  function leaf${leafIndex}() { return ${expression}; }`,
      };
    },
  );
  const declarations = leaves.map(({ declaration }) => declaration);
  let level = leaves.map(({ name }) => name);
  let levelIndex = 0;
  while (level.length > 1) {
    const next: string[] = [];
    for (let index = 0; index < level.length; index += 2) {
      if (index + 1 >= level.length) {
        next.push(level[index] as string);
        continue;
      }
      const name = `branch${levelIndex}_${index / 2}`;
      declarations.push(
        `  function ${name}() { return ${level[index]}() && ${level[index + 1]}(); }`,
      );
      next.push(name);
    }
    level = next;
    levelIndex += 1;
  }
  return `rules_version = '2';
service cloud.firestore {
${declarations.join("\n")}
  match /databases/{database}/documents/phase3/limit-probe {
    allow get: if ${level[0]}();
  }
}
`;
}

async function writeFixture(name: string, fixture: unknown): Promise<void> {
  const path = resolve(outputRoot, name);
  await writeFile(path, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
  console.log(`wrote ${path}`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
