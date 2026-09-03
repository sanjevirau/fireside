import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL(
  "../fixtures/firebase-suite-v1/storage-missing-object/",
  import.meta.url,
);

test("the official missing-object fixture freezes ORB-safe Firebase responses", async () => {
  const fixture = JSON.parse(
    await readFile(new URL("fixture.json", root), "utf8"),
  ) as {
    schemaVersion: number;
    target: string;
    targetVersion: string;
    syntheticOnly: boolean;
    credentialsStored: boolean;
    probes: Array<{
      api: string;
      kind: string;
      status: number;
      headers: Record<string, string>;
      body: { byteLength: number; sha256: string; base64: string };
    }>;
    browser: {
      domEvent: string;
      events: Array<Record<string, unknown>>;
    };
  };
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.target, "official-firebase-tools-storage-emulator");
  assert.equal(fixture.targetVersion, "15.22.0");
  assert.equal(fixture.syntheticOnly, true);
  assert.equal(fixture.credentialsStored, false);
  assert.deepEqual(
    fixture.probes.map(({ api, kind, status, headers, body }) => ({
      api,
      kind,
      status,
      contentType: headers["content-type"],
      body: Buffer.from(body.base64, "base64").toString("utf8"),
    })),
    [
      { api: "firebase", kind: "metadata", status: 404, contentType: "text/plain; charset=utf-8", body: "Not Found" },
      { api: "firebase", kind: "media", status: 404, contentType: "text/plain; charset=utf-8", body: "Not Found" },
      {
        api: "gcs",
        kind: "metadata",
        status: 404,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify({
          error: {
            code: 404,
            message: "No such object: assets-local.twodart.com/users/synthetic/images/missing/high.png",
            errors: [{
              message: "No such object: assets-local.twodart.com/users/synthetic/images/missing/high.png",
              domain: "global",
              reason: "notFound",
            }],
          },
        }),
      },
      {
        api: "gcs",
        kind: "media",
        status: 404,
        contentType: "text/html; charset=utf-8",
        body: "No such object: assets-local.twodart.com/users/synthetic/images/missing/high.png",
      },
    ],
  );
  for (const probe of fixture.probes) {
    const body = Buffer.from(probe.body.base64, "base64");
    assert.equal(body.length, probe.body.byteLength);
    assert.equal(createHash("sha256").update(body).digest("hex"), probe.body.sha256);
  }
  assert.equal(fixture.browser.domEvent, "error");
  assert.deepEqual(fixture.browser.events, [
    { kind: "response", status: 404, statusText: "Not Found" },
  ]);
});

test("the missing-object fixture checksum is valid", async () => {
  const line = (await readFile(new URL("SHA256SUMS", root), "utf8")).trim();
  const match = /^(?<sha>[0-9a-f]{64})  fixture\.json$/u.exec(line);
  assert.ok(match?.groups);
  assert.equal(
    createHash("sha256")
      .update(await readFile(new URL("fixture.json", root)))
      .digest("hex"),
    match.groups.sha,
  );
});
