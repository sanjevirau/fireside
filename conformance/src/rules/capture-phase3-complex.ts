import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { GoogleAuth } from "google-auth-library";

import { emulatorJwtWindow } from "./emulator-jwt.ts";
import { PHASE3_RULES_PROJECT_ID } from "./phase3-oracle-plan.ts";

const HOST = "127.0.0.1";
const PROJECT_ID = "demo-fireside-phase3-complex";
const JAVA_JAR_SHA256 =
  "9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c";
const fixtureRoot = resolve("fixtures/rules-v2");

type Verdict = "ALLOW" | "DENY";

interface ComplexObservation {
  readonly id: string;
  readonly feature: string;
  readonly expected: Verdict;
  readonly method: string;
  readonly url: string;
  readonly status: number;
  readonly body: unknown;
}

const rulesSource = buildComplexRules();
const nonBlankLines = rulesSource
  .split(/\r?\n/u)
  .filter((line) => line.trim().length > 0).length;
if (nonBlankLines < 400) {
  throw new Error(`complex ruleset has only ${String(nonBlankLines)} nonblank lines`);
}

const externalOrigin = argumentValue("--origin");
if (externalOrigin !== undefined) {
  await captureFireside(externalOrigin, requiredArgumentValue("--output"));
} else {
if (process.env.CONFORMANCE_CLOUD_ALLOWLIST !== PHASE3_RULES_PROJECT_ID) {
  throw new Error(
    `complex rules compile capture requires CONFORMANCE_CLOUD_ALLOWLIST=${PHASE3_RULES_PROJECT_ID}`,
  );
}
if (process.env.FIRESTORE_EMULATOR_HOST !== undefined) {
  throw new Error("complex rules oracle refuses FIRESTORE_EMULATOR_HOST");
}

const productionCompile = await compileWithProductionOracle(rulesSource);
const compileIssues = productionCompile.response.issues ?? [];
if (compileIssues.some(({ severity }) => severity === "ERROR")) {
  throw new Error(`production rejected complex rules: ${JSON.stringify(compileIssues)}`);
}

await mkdir(fixtureRoot, { recursive: true });
await writeFile(resolve(fixtureRoot, "complex-firestore.rules"), rulesSource, "utf8");

const javaJar =
  process.env.FIRESTORE_EMULATOR_JAR ??
  join(
    process.env.HOME ?? "",
    ".cache/firebase/emulators/cloud-firestore-emulator-v1.22.0.jar",
  );
const javaJarBytes = await readFile(javaJar);
const javaJarSha256 = sha256(javaJarBytes);
if (javaJarSha256 !== JAVA_JAR_SHA256) {
  throw new Error(`official Java emulator hash mismatch: ${javaJarSha256}`);
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), "phase3-complex-rules-"));
const rulesPath = join(temporaryDirectory, "firestore.rules");
await writeFile(rulesPath, rulesSource, "utf8");
const port = await reserveAvailablePort();
const origin = `http://${HOST}:${String(port)}`;
const javaLogs: string[] = [];
let child: ChildProcess | undefined;

try {
  child = spawn(
    process.env.JAVA ?? "java",
    [
      "-jar",
      javaJar,
      "--host",
      HOST,
      "--port",
      String(port),
      "--project_id",
      PROJECT_ID,
      "--single_project_mode",
      "true",
      "--rules",
      rulesPath,
    ],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout?.on("data", (chunk: Buffer) => javaLogs.push(chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => javaLogs.push(chunk.toString("utf8")));
  await waitForReady(origin, child, javaLogs, 30_000);
  await seed(origin);
  const observations = await runCases(origin);
  const mismatches = observations.filter(
    ({ expected, status }) =>
      (expected === "ALLOW" && (status < 200 || status >= 300)) ||
      (expected === "DENY" && status !== 403),
  );
  if (mismatches.length > 0) {
    throw new Error(`complex Java oracle mismatches: ${JSON.stringify(mismatches, null, 2)}`);
  }
  const allowCases = observations.filter(({ expected }) => expected === "ALLOW").length;
  const denyCases = observations.filter(({ expected }) => expected === "DENY").length;
  if (allowCases < 24 || denyCases < 12) {
    throw new Error(`complex case coverage is ${allowCases} allow / ${denyCases} deny`);
  }

  const fixture = {
    schemaVersion: 1,
    target: "official-java-emulator-and-production-compile",
    javaVersion: "1.22.0",
    javaJarSha256,
    productionTarget: "production-firebase-rules-projects-test",
    productionTargetProject: PHASE3_RULES_PROJECT_ID,
    capturedAt: new Date().toISOString(),
    credentialsStored: false,
    authorizationHeadersStored: false,
    persistentCloudReads: 0,
    persistentCloudWrites: 0,
    rulesSourceSha256: sha256(rulesSource),
    nonBlankLines,
    productionCompile,
    allowCases,
    denyCases,
    observations,
    javaPermissionDeniedLogCount: javaLogs
      .join("")
      .split(/\r?\n/u)
      .filter((line) => line.includes("PERMISSION_DENIED")).length,
  };
  const output = `${JSON.stringify(fixture, null, 2)}\n`;
  await writeFile(resolve(fixtureRoot, "complex-rules-cases.json"), output, "utf8");
  console.log(
    JSON.stringify(
      {
        allowCases,
        denyCases,
        nonBlankLines,
        productionIssueCount: compileIssues.length,
        rulesSha256: sha256(rulesSource),
        fixtureSha256: sha256(output),
      },
      null,
      2,
    ),
  );
} finally {
  await stopProcess(child);
  await rm(temporaryDirectory, { recursive: true, force: true });
}
}

async function captureFireside(originValue: string, outputPath: string): Promise<void> {
  await seed(originValue);
  const observations = await runCases(originValue);
  const mismatches = observations.filter(
    ({ expected, status }) =>
      (expected === "ALLOW" && (status < 200 || status >= 300)) ||
      (expected === "DENY" && status !== 403),
  );
  const allowCases = observations.filter(({ expected }) => expected === "ALLOW").length;
  const denyCases = observations.filter(({ expected }) => expected === "DENY").length;
  const result = {
    allowCases,
    completedAt: new Date().toISOString(),
    denyCases,
    mismatches,
    nonBlankLines,
    observations,
    passed: mismatches.length === 0 && allowCases >= 24 && denyCases >= 12,
    rulesSourceSha256: sha256(rulesSource),
    schemaVersion: 1,
    target: "fireside",
  };
  await mkdir(resolve(outputPath, ".."), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify(
      {
        allowCases,
        denyCases,
        mismatchCount: mismatches.length,
        nonBlankLines,
        passed: result.passed,
        rulesSourceSha256: result.rulesSourceSha256,
      },
      null,
      2,
    ),
  );
  if (!result.passed) {
    throw new Error(`Fireside complex rules mismatches: ${JSON.stringify(mismatches)}`);
  }
}

async function runCases(originValue: string): Promise<readonly ComplexObservation[]> {
  const alice = token("alice", "editor", "tenant-a");
  const bob = token("bob", "reader", "tenant-b");
  const admin = token("admin", "admin", "tenant-a");
  const cases: ComplexObservation[] = [];
  const observe = async (
    id: string,
    feature: string,
    expected: Verdict,
    action: () => Promise<Omit<ComplexObservation, "id" | "feature" | "expected">>,
  ) => {
    cases.push({ id, feature, expected, ...(await action()) });
  };

  await observe("public-get", "public-read", "ALLOW", () =>
    request("GET", documentUrl(originValue, "public/news")),
  );
  await observe("public-list-bounded", "query-limit-validation", "ALLOW", () =>
    runQuery(originValue, "public", 10),
  );
  await observe("public-list-oversized", "query-limit-validation", "DENY", () =>
    runQuery(originValue, "public", 51),
  );
  await observe("tenant-claim-read", "auth-and-custom-claims", "ALLOW", () =>
    request("GET", documentUrl(originValue, "tenants/tenant-a"), alice),
  );
  await observe("tenant-wrong-claim", "auth-and-custom-claims", "DENY", () =>
    request("GET", documentUrl(originValue, "tenants/tenant-a"), bob),
  );
  await observe("tenant-admin-update", "field-change-validation", "ALLOW", () =>
    patch(originValue, "tenants/tenant-a", { name: "Tenant A2", status: "active" }, admin),
  );
  await observe("tenant-editor-update", "field-change-validation", "DENY", () =>
    patch(originValue, "tenants/tenant-a", { name: "Nope", status: "active" }, alice),
  );
  await observe("member-self-read", "nested-and-recursive-matches", "ALLOW", () =>
    request("GET", documentUrl(originValue, "tenants/tenant-a/members/alice"), alice),
  );
  await observe("member-other-read", "nested-and-recursive-matches", "DENY", () =>
    request("GET", documentUrl(originValue, "tenants/tenant-a/members/alice"), bob),
  );
  await observe("project-member-read", "cross-document-access", "ALLOW", () =>
    request("GET", documentUrl(originValue, "tenants/tenant-a/projects/project-1"), alice),
  );
  await observe("project-nonmember-read", "cross-document-access", "DENY", () =>
    request("GET", documentUrl(originValue, "tenants/tenant-a/projects/project-1"), bob),
  );
  await observe("project-owner-update", "create-update-delete-resource-differences", "ALLOW", () =>
    patch(
      originValue,
      "tenants/tenant-a/projects/project-1",
      { ownerId: "alice", title: "Renamed", status: "active", version: 2 },
      alice,
    ),
  );
  await observe("project-owner-forbidden-change", "field-change-validation", "DENY", () =>
    patch(
      originValue,
      "tenants/tenant-a/projects/project-1",
      { ownerId: "bob", title: "Hijack", status: "active", version: 3 },
      alice,
    ),
  );
  await observe("project-admin-delete", "create-update-delete-resource-differences", "ALLOW", () =>
    request("DELETE", documentUrl(originValue, "tenants/tenant-a/projects/delete-admin"), admin),
  );
  await observe("project-member-delete", "create-update-delete-resource-differences", "DENY", () =>
    request("DELETE", documentUrl(originValue, "tenants/tenant-a/projects/delete-member"), alice),
  );
  await observe("task-member-read", "nested-and-recursive-matches", "ALLOW", () =>
    request(
      "GET",
      documentUrl(originValue, "tenants/tenant-a/projects/project-1/tasks/task-1"),
      alice,
    ),
  );
  await observe("task-nonmember-read", "nested-and-recursive-matches", "DENY", () =>
    request(
      "GET",
      documentUrl(originValue, "tenants/tenant-a/projects/project-1/tasks/task-1"),
      bob,
    ),
  );
  await observe("task-self-create", "create-update-delete-resource-differences", "ALLOW", () =>
    patch(
      originValue,
      "tenants/tenant-a/projects/project-1/tasks/task-create-alice",
      { assigneeId: "alice", title: "Mine", status: "open", priority: 1 },
      alice,
    ),
  );
  await observe("task-other-create", "create-update-delete-resource-differences", "DENY", () =>
    patch(
      originValue,
      "tenants/tenant-a/projects/project-1/tasks/task-create-bob",
      { assigneeId: "bob", title: "Other", status: "open", priority: 1 },
      alice,
    ),
  );
  await observe("task-assignee-update", "field-change-validation", "ALLOW", () =>
    patch(
      originValue,
      "tenants/tenant-a/projects/project-1/tasks/task-update-allow",
      { assigneeId: "alice", title: "Task", status: "done", priority: 1 },
      alice,
    ),
  );
  await observe("task-forbidden-update", "field-change-validation", "DENY", () =>
    patch(
      originValue,
      "tenants/tenant-a/projects/project-1/tasks/task-update-deny",
      { assigneeId: "alice", title: "Task", status: "open", priority: 99 },
      alice,
    ),
  );
  await observe("comment-member-read", "nested-and-recursive-matches", "ALLOW", () =>
    request(
      "GET",
      documentUrl(
        originValue,
        "tenants/tenant-a/projects/project-1/tasks/task-1/comments/comment-1",
      ),
      alice,
    ),
  );
  await observe("comment-author-create", "auth-and-custom-claims", "ALLOW", () =>
    patch(
      originValue,
      "tenants/tenant-a/projects/project-1/tasks/task-1/comments/comment-new",
      { authorId: "alice", body: "hello" },
      alice,
    ),
  );
  await observe("comment-impersonation", "auth-and-custom-claims", "DENY", () =>
    patch(
      originValue,
      "tenants/tenant-a/projects/project-1/tasks/task-1/comments/comment-bad",
      { authorId: "bob", body: "hello" },
      alice,
    ),
  );
  await observe("profile-self-read", "auth-and-custom-claims", "ALLOW", () =>
    request("GET", documentUrl(originValue, "profiles/alice"), alice),
  );
  await observe("profile-other-read", "auth-and-custom-claims", "DENY", () =>
    request("GET", documentUrl(originValue, "profiles/alice"), bob),
  );
  await observe("profile-self-update", "field-change-validation", "ALLOW", () =>
    patch(originValue, "profiles/alice", { displayName: "Alice 2", timezone: "UTC" }, alice),
  );
  await observe("profile-role-injection", "field-change-validation", "DENY", () =>
    patch(
      originValue,
      "profiles/alice",
      { displayName: "Alice 3", timezone: "UTC", role: "admin" },
      alice,
    ),
  );
  await observe("audit-admin-create", "timestamps-durations-and-helper-functions", "ALLOW", () =>
    patch(
      originValue,
      "audits/admin-event",
      { actorId: "admin", action: "update", at: "timestamp:2026-09-01T08:00:00Z" },
      admin,
    ),
  );
  await observe("audit-editor-create", "timestamps-durations-and-helper-functions", "DENY", () =>
    patch(
      originValue,
      "audits/editor-event",
      { actorId: "alice", action: "update", at: "timestamp:2026-09-01T08:00:00Z" },
      alice,
    ),
  );
  await observe("recursive-asset-member", "nested-and-recursive-matches", "ALLOW", () =>
    request(
      "GET",
      documentUrl(originValue, "tenants/tenant-a/assets/folder/deep/file"),
      alice,
    ),
  );
  await observe("recursive-asset-nonmember", "nested-and-recursive-matches", "DENY", () =>
    request(
      "GET",
      documentUrl(originValue, "tenants/tenant-a/assets/folder/deep/file"),
      bob,
    ),
  );
  await observe("stats-admin-read", "auth-and-custom-claims", "ALLOW", () =>
    request("GET", documentUrl(originValue, "stats/overview"), admin),
  );
  await observe("stats-editor-read", "auth-and-custom-claims", "DENY", () =>
    request("GET", documentUrl(originValue, "stats/overview"), alice),
  );
  for (let index = 0; index < 8; index += 1) {
    const id = twoDigits(index);
    await observe(`generated-entity-${id}`, "complex-generated-policy", "ALLOW", () =>
      request(
        "GET",
        documentUrl(originValue, `tenants/tenant-a/entity-${id}/document-${id}`),
        alice,
      ),
    );
  }
  await observe("generated-entity-wrong-tenant", "complex-generated-policy", "DENY", () =>
    request(
      "GET",
      documentUrl(originValue, "tenants/tenant-a/entity-00/document-00"),
      bob,
    ),
  );
  await observe("get-after-atomic-allow", "getAfter-batch-invariant", "ALLOW", () =>
    commit(
      originValue,
      [
        writeDocument("invariants/global", { version: 2 }),
        writeDocument("atomic/allow", { expectedVersion: 2 }),
      ],
      alice,
    ),
  );
  await observe("get-after-atomic-deny", "getAfter-batch-invariant", "DENY", () =>
    commit(
      originValue,
      [
        writeDocument("invariants/global", { version: 3 }),
        writeDocument("atomic/deny", { expectedVersion: 2 }),
      ],
      alice,
    ),
  );
  return cases;
}

async function seed(originValue: string): Promise<void> {
  const documents: Array<readonly [string, Readonly<Record<string, unknown>>]> = [
    ["public/news", { title: "News", published: true }],
    ["tenants/tenant-a", { name: "Tenant A", status: "active" }],
    ["tenants/tenant-a/members/alice", { role: "editor", active: true }],
    [
      "tenants/tenant-a/projects/project-1",
      { ownerId: "alice", title: "Project", status: "active", version: 1 },
    ],
    [
      "tenants/tenant-a/projects/delete-admin",
      { ownerId: "alice", title: "Delete", status: "active", version: 1 },
    ],
    [
      "tenants/tenant-a/projects/delete-member",
      { ownerId: "alice", title: "Keep", status: "active", version: 1 },
    ],
    [
      "tenants/tenant-a/projects/project-1/tasks/task-1",
      { assigneeId: "alice", title: "Task", status: "open", priority: 1 },
    ],
    [
      "tenants/tenant-a/projects/project-1/tasks/task-update-allow",
      { assigneeId: "alice", title: "Task", status: "open", priority: 1 },
    ],
    [
      "tenants/tenant-a/projects/project-1/tasks/task-update-deny",
      { assigneeId: "alice", title: "Task", status: "open", priority: 1 },
    ],
    [
      "tenants/tenant-a/projects/project-1/tasks/task-1/comments/comment-1",
      { authorId: "alice", body: "first" },
    ],
    ["profiles/alice", { displayName: "Alice", timezone: "UTC" }],
    ["tenants/tenant-a/assets/folder/deep/file", { kind: "file" }],
    ["stats/overview", { count: 1 }],
    ["invariants/global", { version: 1 }],
  ];
  for (let index = 0; index < 8; index += 1) {
    const id = twoDigits(index);
    documents.push([
      `tenants/tenant-a/entity-${id}/document-${id}`,
      { ownerId: "alice", status: "active", version: 1 },
    ]);
  }
  for (const [path, fields] of documents) {
    const result = await patch(originValue, path, fields, "owner");
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`complex seed ${path} failed: ${JSON.stringify(result)}`);
    }
  }
}

function buildComplexRules(): string {
  const generated = Array.from({ length: 64 }, (_, index) => {
    const id = twoDigits(index);
    return `    match /tenants/{tenant}/entity-${id}/{documentId} {
      allow get: if sameTenant(tenant)
        || activeMember(tenant);
      allow list: if activeMember(tenant)
        && boundedQuery(25);
      allow create: if activeMember(tenant)
        && editorOrAdmin()
        && request.resource.data.ownerId == uid()
        && validEntityShape(request.resource.data);
      allow update: if activeMember(tenant)
        && (isAdmin() || resource.data.ownerId == uid())
        && request.resource.data.diff(resource.data).affectedKeys()
          .hasOnly(['status', 'version'])
        && request.resource.data.version == resource.data.version + 1;
      allow delete: if isAdmin();
    }`;
  }).join("\n");
  return `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function signedIn() {
      return request.auth != null;
    }
    function uid() {
      return request.auth.uid;
    }
    function role() {
      return request.auth.token.role;
    }
    function isAdmin() {
      return signedIn()
        && role() == 'admin';
    }
    function editorOrAdmin() {
      return signedIn()
        && role() in ['editor', 'admin'];
    }
    function sameTenant(tenant) {
      return signedIn()
        && request.auth.token.tenant_id == tenant;
    }
    function memberPath(tenant) {
      return /databases/$(database)/documents/tenants/$(tenant)/members/$(uid());
    }
    function activeMember(tenant) {
      return signedIn()
        && exists(memberPath(tenant))
        && get(memberPath(tenant)).data.active == true;
    }
    function boundedQuery(maximum) {
      return request.query.limit != null
        && request.query.limit <= maximum;
    }
    function validProjectShape(data) {
      return data.keys().hasAll(['ownerId', 'title', 'status', 'version'])
        && data.keys().hasOnly(['ownerId', 'title', 'status', 'version'])
        && data.ownerId is string
        && data.title is string
        && data.status in ['active', 'archived']
        && data.version is int;
    }
    function validTaskShape(data) {
      return data.keys().hasAll(['assigneeId', 'title', 'status', 'priority'])
        && data.keys().hasOnly(['assigneeId', 'title', 'status', 'priority'])
        && data.assigneeId is string
        && data.title is string
        && data.status in ['open', 'doing', 'done']
        && data.priority is int;
    }
    function validEntityShape(data) {
      return data.keys().hasAll(['ownerId', 'status', 'version'])
        && data.keys().hasOnly(['ownerId', 'status', 'version'])
        && data.ownerId is string
        && data.status in ['active', 'archived']
        && data.version is int;
    }
    function recentTimestamp(value) {
      return value is timestamp
        && value <= request.time
        && value >= request.time - duration.value(30, 'd');
    }
    match /public/{documentId} {
      allow get: if true;
      allow list: if boundedQuery(50);
      allow write: if isAdmin();
    }
    match /tenants/{tenant} {
      allow get: if isAdmin()
        || sameTenant(tenant)
        || activeMember(tenant);
      allow update: if isAdmin()
        && request.resource.data.diff(resource.data).affectedKeys()
          .hasOnly(['name', 'status']);
      match /members/{memberId} {
        allow get: if isAdmin()
          || (sameTenant(tenant) && memberId == uid());
        allow list: if isAdmin()
          && boundedQuery(100);
        allow create, delete: if isAdmin();
        allow update: if sameTenant(tenant)
          && memberId == uid()
          && request.resource.data.diff(resource.data).affectedKeys()
            .hasOnly(['displayName', 'timezone']);
      }
      match /projects/{projectId} {
        allow get: if activeMember(tenant);
        allow list: if activeMember(tenant)
          && boundedQuery(50);
        allow create: if activeMember(tenant)
          && editorOrAdmin()
          && request.resource.data.ownerId == uid()
          && validProjectShape(request.resource.data);
        allow update: if activeMember(tenant)
          && (isAdmin() || resource.data.ownerId == uid())
          && request.resource.data.diff(resource.data).affectedKeys()
            .hasOnly(['title', 'status', 'version'])
          && request.resource.data.version == resource.data.version + 1
          && validProjectShape(request.resource.data);
        allow delete: if isAdmin();
        match /tasks/{taskId} {
          allow get: if activeMember(tenant);
          allow list: if activeMember(tenant)
            && boundedQuery(100);
          allow create: if activeMember(tenant)
            && request.resource.data.assigneeId == uid()
            && validTaskShape(request.resource.data);
          allow update: if activeMember(tenant)
            && resource.data.assigneeId == uid()
            && request.resource.data.diff(resource.data).affectedKeys()
              .hasOnly(['title', 'status'])
            && validTaskShape(request.resource.data);
          allow delete: if isAdmin()
            || resource.data.assigneeId == uid();
          match /comments/{commentId} {
            allow get: if activeMember(tenant);
            allow list: if activeMember(tenant)
              && boundedQuery(100);
            allow create: if activeMember(tenant)
              && request.resource.data.keys().hasOnly(['authorId', 'body'])
              && request.resource.data.authorId == uid()
              && request.resource.data.body is string;
            allow update, delete: if isAdmin()
              || (signedIn() && resource.data.authorId == uid());
          }
        }
      }
      match /assets/{assetPath=**} {
        allow get: if activeMember(tenant);
        allow write: if isAdmin();
      }
    }
    match /profiles/{profileId} {
      allow get: if signedIn()
        && profileId == uid();
      allow update: if signedIn()
        && profileId == uid()
        && request.resource.data.diff(resource.data).affectedKeys()
          .hasOnly(['displayName', 'timezone']);
      allow create, delete: if isAdmin();
    }
    match /audits/{auditId} {
      allow create: if isAdmin()
        && request.resource.data.keys().hasOnly(['actorId', 'action', 'at'])
        && request.resource.data.actorId == uid()
        && recentTimestamp(request.resource.data.at);
      allow read: if isAdmin();
      allow update, delete: if false;
    }
    match /stats/{documentId} {
      allow read: if isAdmin();
      allow write: if false;
    }
    match /invariants/global {
      allow update: if signedIn()
        && request.resource.data.version == resource.data.version + 1;
    }
    match /atomic/{documentId} {
      allow create: if signedIn()
        && getAfter(/databases/$(database)/documents/invariants/global).data.version
          == request.resource.data.expectedVersion;
    }
${generated}
    match /{unmatched=**} {
      allow read, write: if false;
    }
  }
}
`;
}

async function compileWithProductionOracle(source: string): Promise<{
  readonly httpStatus: number;
  readonly response: {
    readonly issues?: ReadonlyArray<{
      readonly severity?: string;
      readonly description?: string;
    }>;
  };
}> {
  const client = await new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  }).getClient();
  const response = await client.request({
    url: `https://firebaserules.googleapis.com/v1/projects/${PHASE3_RULES_PROJECT_ID}:test`,
    method: "POST",
    data: { source: { files: [{ name: "firestore.rules", content: source }] } },
  });
  return { httpStatus: response.status, response: response.data as never };
}

async function request(
  method: string,
  url: string,
  authToken?: string,
  body?: unknown,
): Promise<Omit<ComplexObservation, "id" | "feature" | "expected">> {
  const response = await fetch(url, {
    method,
    headers: {
      ...(authToken === undefined ? {} : { authorization: `Bearer ${authToken}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let responseBody: unknown = text;
  if (text.length > 0) {
    try {
      responseBody = JSON.parse(text);
    } catch {
      // Preserve the raw body.
    }
  }
  return {
    method,
    url: url.replace(/http:\/\/127\.0\.0\.1:\d+/u, "http://127.0.0.1:{ephemeral-port}"),
    status: response.status,
    body: responseBody,
  };
}

async function patch(
  originValue: string,
  path: string,
  fields: Readonly<Record<string, unknown>>,
  authToken: string,
): Promise<Omit<ComplexObservation, "id" | "feature" | "expected">> {
  return await request(
    "PATCH",
    documentUrl(originValue, path),
    authToken,
    { fields: encodeFields(fields) },
  );
}

async function runQuery(
  originValue: string,
  collectionId: string,
  limit: number,
): Promise<Omit<ComplexObservation, "id" | "feature" | "expected">> {
  return await request(
    "POST",
    `${originValue}/v1/projects/${PROJECT_ID}/databases/(default)/documents:runQuery`,
    undefined,
    { structuredQuery: { from: [{ collectionId }], limit } },
  );
}

async function commit(
  originValue: string,
  writes: readonly unknown[],
  authToken: string,
): Promise<Omit<ComplexObservation, "id" | "feature" | "expected">> {
  return await request(
    "POST",
    `${originValue}/v1/projects/${PROJECT_ID}/databases/(default)/documents:commit`,
    authToken,
    { writes },
  );
}

function writeDocument(
  path: string,
  fields: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    update: {
      name: `projects/${PROJECT_ID}/databases/(default)/documents/${path}`,
      fields: encodeFields(fields),
    },
  };
}

function encodeFields(
  fields: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => {
      if (typeof value === "boolean") return [key, { booleanValue: value }];
      if (typeof value === "number" && Number.isInteger(value)) {
        return [key, { integerValue: String(value) }];
      }
      if (typeof value === "string" && value.startsWith("timestamp:")) {
        return [key, { timestampValue: value.slice("timestamp:".length) }];
      }
      if (typeof value === "string") return [key, { stringValue: value }];
      throw new Error(`unsupported complex fixture field ${key}`);
    }),
  );
}

function documentUrl(originValue: string, path: string): string {
  return `${originValue}/v1/projects/${PROJECT_ID}/databases/(default)/documents/${path}`;
}

function token(uid: string, role: string, tenantId: string): string {
  const { authTime, expiresAt, issuedAt } = emulatorJwtWindow();
  return `${base64Url({ alg: "none", typ: "JWT" })}.${base64Url({
    aud: PROJECT_ID,
    auth_time: authTime,
    exp: expiresAt,
    firebase: { sign_in_provider: "custom" },
    iat: issuedAt,
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    role,
    sub: uid,
    tenant_id: tenantId,
    user_id: uid,
  })}.`;
}

function base64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function requiredArgumentValue(name: string): string {
  const value = argumentValue(name);
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}

async function reserveAvailablePort(): Promise<number> {
  const server = createServer();
  return await new Promise<number>((resolveValue, reject) => {
    server.once("error", reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("failed to reserve loopback port"));
        return;
      }
      server.close((error) =>
        error === undefined ? resolveValue(address.port) : reject(error),
      );
    });
  });
}

async function waitForReady(
  originValue: string,
  processValue: ChildProcess,
  logs: readonly string[],
  timeoutMilliseconds: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (processValue.exitCode !== null) {
      throw new Error(`Java complex oracle exited: ${logs.join("")}`);
    }
    try {
      await fetch(originValue);
      return;
    } catch {
      await new Promise((resolveValue) => setTimeout(resolveValue, 100));
    }
  }
  throw new Error(`Java complex oracle readiness timeout: ${logs.join("")}`);
}

async function stopProcess(processValue: ChildProcess | undefined): Promise<void> {
  if (processValue === undefined || processValue.exitCode !== null) return;
  processValue.kill("SIGTERM");
  await new Promise<void>((resolveValue) => {
    const timeout = setTimeout(() => {
      if (processValue.exitCode === null) processValue.kill("SIGKILL");
      resolveValue();
    }, 5_000);
    processValue.once("exit", () => {
      clearTimeout(timeout);
      resolveValue();
    });
  });
}
