import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { pinGeneratedMetadata } from "../src/webchannel/firebase-js-sdk-metadata.ts";

const testDirectory = dirname(fileURLToPath(import.meta.url));

test("generated metadata write-race fixture freezes the observed CI contract", async () => {
  const fixture = JSON.parse(
    await readFile(
      join(
        testDirectory,
        "../fixtures/webchannel-v8/firebase-js-sdk-generated-metadata-write-race.json",
      ),
      "utf8",
    ),
  ) as {
    contract: { pin: string; reader: string; restore: string };
    observation: { error: string; path: string; reader: string };
    schemaVersion: number;
    source: { ciRun: number; jobs: number[] };
  };

  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.source.ciRun, 33565984398);
  assert.deepEqual(fixture.source.jobs, [100049320824, 100049320907]);
  assert.deepEqual(fixture.observation, {
    error: "Unexpected end of JSON input",
    path: "packages/firestore/package.json",
    reader: "Yarn 1.22.22 workspace discovery",
  });
  assert.deepEqual(fixture.contract, {
    pin: "replace generated metadata atomically",
    reader: "every observable file version is complete JSON",
    restore: "replace original metadata atomically",
  });
});

test("SDK generated metadata is pinned for a gate cell and restored exactly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fireside-sdk-metadata-"));
  const appPath = join(directory, "app.json");
  const firestorePath = join(directory, "firestore.json");
  const dirtyApp = '{"typings":"./dist/app-public.d.ts"}\n';
  const dirtyFirestore = '{"typings":"./dist/index.d.ts"}\n';
  const pinnedApp = '{"typings":"./dist/app/src/index.d.ts"}\n';
  const pinnedFirestore = '{"typings":"dist/firestore/src/index.d.ts"}\n';

  try {
    await Promise.all([
      writeFile(appPath, dirtyApp, "utf8"),
      writeFile(firestorePath, dirtyFirestore, "utf8"),
    ]);

    const restore = await pinGeneratedMetadata([
      { path: appPath, pinnedContents: pinnedApp },
      { path: firestorePath, pinnedContents: pinnedFirestore },
    ]);

    assert.equal(await readFile(appPath, "utf8"), pinnedApp);
    assert.equal(await readFile(firestorePath, "utf8"), pinnedFirestore);

    await restore();
    await restore();

    assert.equal(await readFile(appPath, "utf8"), dirtyApp);
    assert.equal(await readFile(firestorePath, "utf8"), dirtyFirestore);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
