import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const fixtureUrl = new URL(
  "../fixtures/phase5/firebase-tools-import-root-contract.json",
  import.meta.url,
);

test("firebase-tools import-root oracle rejects a directory symlink", async () => {
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8")) as {
    readonly contract: {
      readonly directDirectoryAccepted: boolean;
      readonly directorySymlinkAccepted: boolean;
      readonly filesystemProbe: string;
      readonly metadataFile: string;
    };
    readonly oracle: { readonly version: string };
    readonly schemaVersion: number;
  };
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.oracle.version, "15.22.0");
  assert.deepEqual(fixture.contract, {
    directDirectoryAccepted: true,
    directorySymlinkAccepted: false,
    filesystemProbe: "lstat",
    metadataFile: "firebase-export-metadata.json",
  });

  const root = await mkdtemp(path.join(tmpdir(), "phase5-import-root-"));
  try {
    const direct = path.join(root, "direct");
    const linked = path.join(root, "linked");
    await mkdir(direct);
    await writeFile(path.join(direct, fixture.contract.metadataFile), "{}\n");
    await symlink(direct, linked, "dir");

    assert.equal((await lstat(direct)).isDirectory(), true);
    assert.equal((await lstat(linked)).isDirectory(), false);
    assert.equal((await stat(linked)).isDirectory(), true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
