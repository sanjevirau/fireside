import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveTarget } from "../src/target.ts";

test("emulator control APIs register triggers and clear data", async (context) => {
  const configuration = resolveTarget(process.env);
  if (configuration.name === "cloud") {
    context.skip("emulator control APIs do not exist in production");
    return;
  }
  assert.ok(configuration.host);
  const baseUrl = `http://${configuration.host}`;
  const project = configuration.projectId;
  const triggerId = randomUUID();
  const headers = {
    authorization: "Bearer owner",
    "content-type": "application/json",
  };

  const registered = await fetch(
    `${baseUrl}/emulator/v1/projects/${project}/triggers/${triggerId}`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify({
        eventTrigger: {
          eventType: "providers/cloud.firestore/eventTypes/document.write",
          resource: `projects/${project}/databases/(default)/documents/items/{id}`,
          service: "firestore.googleapis.com",
        },
      }),
    },
  );
  assert.equal(registered.status, 200);

  const eventarcId = randomUUID();
  const eventarc = await fetch(
    `${baseUrl}/emulator/v1/projects/${project}/eventarcTrigger?eventarcTriggerId=${eventarcId}`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        eventType: "google.cloud.firestore.document.v1.written",
        database: "(default)",
        namespace: "",
        document: {
          value: "items/{id}",
          matchType: "PATH_PATTERN",
        },
      }),
    },
  );
  assert.equal(eventarc.status, 200);

  const removed = await fetch(
    `${baseUrl}/emulator/v1/projects/${project}/triggers/${triggerId}`,
    { method: "DELETE", headers },
  );
  assert.equal(removed.status, configuration.name === "java" ? 404 : 200);

  const document = `${baseUrl}/v1/projects/${project}/databases/(default)/documents/items/control-test`;
  const seeded = await fetch(document, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      fields: { source: { stringValue: "control-api" } },
    }),
  });
  assert.equal(seeded.status, 200);

  const cleared = await fetch(
    `${baseUrl}/emulator/v1/projects/${project}/databases/(default)/documents`,
    { method: "DELETE", headers },
  );
  assert.equal(cleared.status, 200);
  assert.equal((await fetch(document, { headers })).status, 404);
});

test("emulator export writes the named official-format directory", async (context) => {
  const configuration = resolveTarget(process.env);
  if (configuration.name === "cloud") {
    context.skip("emulator export control API does not exist in production");
    return;
  }
  assert.ok(configuration.host);
  const baseUrl = `http://${configuration.host}`;
  const project = configuration.projectId;
  const headers = {
    authorization: "Bearer owner",
    "content-type": "application/json",
  };
  const exportDirectory = await mkdtemp(join(tmpdir(), "fireside-control-export-"));
  const exportName = `export-${randomUUID()}`;

  try {
    const invalid = await fetch(
      `${baseUrl}/emulator/v1/projects/${project}:export`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          database: "(default)",
          export_directory: exportDirectory,
          export_name: exportName,
        }),
      },
    );
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.status, "INVALID_ARGUMENT");

    const document = `${baseUrl}/v1/projects/${project}/databases/(default)/documents/export-control/document`;
    const seeded = await fetch(document, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        fields: { source: { stringValue: "control-export" } },
      }),
    });
    assert.equal(seeded.status, 200);

    const exported = await fetch(
      `${baseUrl}/emulator/v1/projects/${project}:export`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          database: `projects/${project}/databases/(default)`,
          export_directory: exportDirectory,
          export_name: exportName,
        }),
      },
    );
    assert.equal(exported.status, 200);
    assert.deepEqual(await exported.json(), {});
    await Promise.all([
      access(
        join(
          exportDirectory,
          exportName,
          `${exportName}.overall_export_metadata`,
        ),
      ),
      access(
        join(
          exportDirectory,
          exportName,
          "all_namespaces",
          "all_kinds",
          "all_namespaces_all_kinds.export_metadata",
        ),
      ),
      access(
        join(
          exportDirectory,
          exportName,
          "all_namespaces",
          "all_kinds",
          "output-0",
        ),
      ),
    ]);
  } finally {
    await rm(exportDirectory, { force: true, recursive: true });
  }
});
