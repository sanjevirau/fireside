import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { pinGeneratedMetadata } from "../src/webchannel/firebase-js-sdk-metadata.ts";

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
