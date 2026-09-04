import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PHASE5_FUNCTIONS_SOCKET_SUFFIX,
  PHASE5_MAX_UNIX_SOCKET_PATH_BYTES,
  phase5RuntimeDirectory,
  preparePhase5RuntimeRoot,
} from "../src/suite/phase5-runtime-directory.ts";

test("Phase 5 runtime directories stay on the explicit capacity root with socket headroom", () => {
  const directory = phase5RuntimeDirectory(
    "/srv/dev-fast/p5-runtime",
    "/srv/dev-fast/runtime-data/phase5/full-gates/a-very-deep/evidence",
    "official-initial",
  );
  assert.match(directory, /^\/srv\/dev-fast\/p5-runtime\/p5-[0-9a-f]{16}\/official-initial$/u);
  assert.ok(
    Buffer.byteLength(`${directory}${PHASE5_FUNCTIONS_SOCKET_SUFFIX}`) <=
      PHASE5_MAX_UNIX_SOCKET_PATH_BYTES,
  );
  assert.equal(
    phase5RuntimeDirectory(
      "/srv/dev-fast/p5-runtime",
      "/srv/dev-fast/runtime-data/phase5/full-gates/a-very-deep/evidence",
      "official-initial",
    ),
    directory,
  );
});

test("Phase 5 rejects relative, unsafe, and socket-overflowing runtime paths", () => {
  assert.throws(
    () => phase5RuntimeDirectory("relative", "/gate/evidence", "official-initial"),
    /must be absolute/u,
  );
  assert.throws(
    () => phase5RuntimeDirectory("/srv/dev-fast/p5-runtime", "/gate/evidence", "../escape"),
    /Invalid Phase 5 runtime label/u,
  );
  assert.throws(
    () => phase5RuntimeDirectory(`/${"a".repeat(90)}`, "/gate/evidence", "official-initial"),
    /insufficient Functions socket headroom/u,
  );
});

test("Phase 5 records and enforces runtime filesystem capacity", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "phase5-runtime-test-"));
  try {
    const evidence = await preparePhase5RuntimeRoot(root, 1);
    assert.equal(evidence.root, root);
    assert.equal(evidence.passed, true);
    assert.ok(evidence.availableBytes >= evidence.minimumAvailableBytes);
    assert.ok(evidence.totalBytes >= evidence.availableBytes);
    assert.equal(
      evidence.socketSuffixBytes,
      Buffer.byteLength(PHASE5_FUNCTIONS_SOCKET_SUFFIX),
    );
    await assert.rejects(
      preparePhase5RuntimeRoot(root, Number.MAX_SAFE_INTEGER),
      /available bytes/u,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
