import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";

interface Fixture {
  readonly schemaVersion: number;
  readonly target: string;
  readonly targetVersion: string;
  readonly targetProject: string;
  readonly credentialsStored: boolean;
  readonly authorizationHeadersStored: boolean;
  readonly javaJarSha256: string;
  readonly registrations: readonly {
    readonly id: string;
    readonly method: string;
    readonly path: string;
    readonly status: number;
    readonly response: unknown;
  }[];
  readonly dispatches: readonly {
    readonly method: string;
    readonly path: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: unknown;
  }[];
}

const fixtureRoot = new URL(
  "../fixtures/firebase-suite-v1/firestore-trigger-registration-and-v1-v2-dispatch/",
  import.meta.url,
);

test("the official Java fixture pins v1 JSON and v2 protobuf Firestore dispatch", async () => {
  const fixture = JSON.parse(
    await readFile(new URL("fixture.json", fixtureRoot), "utf8"),
  ) as Fixture;
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.target, "official-java-emulator");
  assert.equal(fixture.targetVersion, "1.22.0");
  assert.match(fixture.targetProject, /^demo-/u);
  assert.equal(fixture.credentialsStored, false);
  assert.equal(fixture.authorizationHeadersStored, false);
  assert.equal(
    fixture.javaJarSha256,
    "9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c",
  );

  assert.deepEqual(
    fixture.registrations.map(({ id, method, status }) => ({ id, method, status })),
    [
      { id: "v1-document-create", method: "PUT", status: 200 },
      { id: "v2-document-created", method: "POST", status: 200 },
    ],
  );
  assert.deepEqual(fixture.registrations[0]?.response, {});
  assert.deepEqual(fixture.registrations[1]?.response, {
    eventType: "google.cloud.firestore.document.v1.created",
    database: "(default)",
    namespace: "(default)",
    document: {
      value: "phase4Triggers/{documentId}",
      matchType: "PATH_PATTERN",
    },
  });

  assert.equal(fixture.dispatches.length, 2);
  const [v1, v2] = fixture.dispatches;
  assert.equal(v1?.method, "POST");
  assert.match(v1?.path ?? "", /\/triggers\/us-central1-v1Created$/u);
  assert.equal(v1?.headers["content-type"], "application/json");
  assert.equal(
    nestedString(v1?.body, ["body", "data", "value", "fields", "unicode", "stringValue"]),
    "火🔥",
  );
  assert.equal(
    nestedString(v1?.body, ["body", "context", "eventType"]),
    "providers/cloud.firestore/eventTypes/document.create",
  );

  assert.equal(v2?.method, "POST");
  assert.match(v2?.path ?? "", /\/triggers\/us-central1-v2Created$/u);
  assert.equal(v2?.headers["content-type"], "application/protobuf");
  assert.equal(v2?.headers["ce-datacontenttype"], "application/protobuf");
  assert.equal(v2?.headers["ce-specversion"], "1.0");
  assert.equal(
    v2?.headers["ce-type"],
    "google.cloud.firestore.document.v1.created",
  );
  assert.equal(v2?.headers["ce-subject"], "documents/phase4Triggers/oracle");
  assert.equal(
    v2?.headers["ce-source"],
    "//firestore.googleapis.com/projects/projects/demo-fireside-phase4-trigger-oracle/databases/(default)",
  );
  assert.equal(
    v2?.headers["ce-dataschema"],
    "https://github.com/googleapis/google-cloudevents/blob/main/proto/google/events/cloud/firestore/v1/data.proto",
  );
  assert.equal(v2?.headers["ce-location"], "us-central1");
  assert.equal(v2?.headers["ce-project"], fixture.targetProject);
  assert.equal(v2?.headers["ce-database"], "(default)");
  assert.equal(v2?.headers["ce-namespace"], "(default)");
  assert.equal(v2?.headers["ce-document"], "phase4Triggers/oracle");
  assert.equal(typeof v2?.body, "string");
  const protobuf = Buffer.from(v2?.body as string, "base64");
  assert.ok(protobuf.length > 100);
  assert.equal(protobuf.toString("base64"), v2?.body);
});

test("the Firestore trigger fixture checksum file covers every permanent artifact", async () => {
  const sums = await readFile(new URL("SHA256SUMS", fixtureRoot), "utf8");
  assert.equal(sums.trimEnd().split("\n").length, 2);
  for (const line of sums.trimEnd().split("\n")) {
    const match = /^(?<sha>[0-9a-f]{64})  (?<name>.+)$/u.exec(line);
    assert.ok(match?.groups !== undefined, line);
    assert.equal(
      sha256(await readFile(new URL(match.groups.name!, fixtureRoot))),
      match.groups.sha,
      match.groups.name!,
    );
  }
});

function nestedString(value: unknown, path: readonly string[]): string | undefined {
  let current = value;
  for (const key of path.slice(1)) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" ? current : undefined;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
