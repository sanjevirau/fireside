import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

interface PageObservation {
  readonly id: string;
  readonly status: number;
  readonly itemCount: number;
  readonly itemNames: readonly string[];
  readonly first: string | null;
  readonly last: string | null;
  readonly nextPageToken?: string;
}

const fixtureUrl = new URL(
  "../fixtures/firebase-suite-v1/storage-list-pagination/fixture.json",
  import.meta.url,
);

test("official Storage pagination crosses the default 1,000-object boundary", async () => {
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8")) as {
    readonly schemaVersion: number;
    readonly targetVersion: string;
    readonly syntheticOnly: boolean;
    readonly objectCorpus: Readonly<Record<string, number | string>>;
    readonly observations: readonly PageObservation[];
    readonly sdkAutopagination: Readonly<Record<string, number | string>>;
    readonly invariants: Readonly<Record<string, boolean | number | string>>;
  };
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.targetVersion, "15.22.0");
  assert.equal(fixture.syntheticOnly, true);
  assert.equal(fixture.objectCorpus.count, 1_002);
  assert.equal(fixture.objectCorpus.boundaryToken, "objects/1000.json");

  for (const prefix of ["gcs", "firebase"]) {
    const first = observation(fixture.observations, `${prefix}-default-first`);
    const second = observation(fixture.observations, `${prefix}-default-second`);
    assert.equal(first.status, 200);
    assert.equal(first.itemCount, 1_000);
    assert.equal(first.first, "objects/0000.json");
    assert.equal(first.last, "objects/0999.json");
    assert.equal(first.nextPageToken, "objects/1000.json");
    assert.equal(second.itemCount, 2);
    assert.deepEqual(second.itemNames, ["objects/1000.json", "objects/1001.json"]);
    assert.equal(second.nextPageToken, undefined);

    const smallFirst = observation(fixture.observations, `${prefix}-small-first`);
    const smallSecond = observation(fixture.observations, `${prefix}-small-second`);
    assert.deepEqual(smallFirst.itemNames, ["objects/0000.json", "objects/0001.json"]);
    assert.equal(smallFirst.nextPageToken, "objects/0002.json");
    assert.deepEqual(smallSecond.itemNames, ["objects/0002.json", "objects/0003.json"]);
    assert.equal(smallSecond.nextPageToken, "objects/0004.json");
  }

  const unknown = observation(fixture.observations, "gcs-unknown-token");
  assert.deepEqual(unknown.itemNames, ["objects/0000.json", "objects/0001.json"]);
  assert.equal(unknown.nextPageToken, "objects/0002.json");
  assert.equal(fixture.sdkAutopagination.count, 1_002);
  assert.equal(fixture.sdkAutopagination.boundaryAfter, "objects/1000.json");
  assert.equal(fixture.invariants.pageTokenIsInclusiveOnResume, true);
  assert.equal(fixture.invariants.gcsAndFirebaseRoutesSharePagination, true);
  assert.equal(fixture.invariants.sdkAutopaginationReturnsAllObjects, true);
});

test("Fireside HTTP replays the oracle's inclusive continuation contract", { timeout: 600_000 }, async () => {
  const repository = fileURLToPath(new URL("../../", import.meta.url));
  await promisify(execFile)(
    "cargo",
    ["build", "--locked", "-p", "fireside-storage-front", "--example", "encoding_fixture_server"],
    { cwd: repository },
  );
  const cargoMetadata = await promisify(execFile)(
    "cargo",
    ["metadata", "--no-deps", "--format-version", "1"],
    { cwd: repository },
  );
  const targetDirectory = (JSON.parse(cargoMetadata.stdout) as { target_directory: string }).target_directory;
  const scratch = await mkdtemp("/tmp/fireside-storage-pagination-replay-");
  const child = spawn(
    `${targetDirectory}/debug/examples/encoding_fixture_server`,
    [scratch],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const exited = once(child, "exit");
  try {
    const origin = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Storage pagination peer readiness timeout")),
        30_000,
      );
      child.stdout.once("data", (chunk: Buffer) => {
        clearTimeout(timer);
        resolve(chunk.toString().trim());
      });
      child.once("error", reject);
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("Storage pagination peer exited before readiness"));
      });
    });
    const names = Array.from(
      { length: 5 },
      (_, index) => `objects/${String(index).padStart(4, "0")}.json`,
    );
    for (const name of names) {
      const response = await fetch(
        `${origin}/upload/storage/v1/b/assets-local.twodart.com/o?uploadType=media&name=${encodeURIComponent(name)}`,
        {
          method: "POST",
          body: JSON.stringify({ name }),
          headers: { "content-type": "application/json" },
        },
      );
      assert.equal(response.status, 200);
    }

    for (const route of ["storage/v1", "v0"]) {
      const first = await listFireside(origin, route, "");
      assert.deepEqual(first.itemNames, names.slice(0, 2));
      assert.equal(first.nextPageToken, names[2]);
      const second = await listFireside(origin, route, first.nextPageToken ?? "");
      assert.deepEqual(second.itemNames, names.slice(2, 4));
      assert.equal(second.nextPageToken, names[4]);
      const third = await listFireside(origin, route, second.nextPageToken ?? "");
      assert.deepEqual(third.itemNames, names.slice(4));
      assert.equal(third.nextPageToken, undefined);
    }
  } finally {
    child.kill("SIGTERM");
    await exited;
    await rm(scratch, { recursive: true, force: true });
  }
});

function observation(
  observations: readonly PageObservation[],
  id: string,
): PageObservation {
  const result = observations.find((candidate) => candidate.id === id);
  assert.ok(result, `missing Storage pagination observation ${id}`);
  return result;
}

async function listFireside(
  origin: string,
  route: string,
  pageToken: string,
): Promise<{ readonly itemNames: readonly string[]; readonly nextPageToken?: string }> {
  const query = new URLSearchParams({ prefix: "objects/", maxResults: "2" });
  if (pageToken.length > 0) query.set("pageToken", pageToken);
  const response = await fetch(
    `${origin}/${route}/b/assets-local.twodart.com/o?${query.toString()}`,
    { headers: { authorization: "Bearer owner" } },
  );
  assert.equal(response.status, 200);
  const body = await response.json() as {
    readonly items?: readonly { readonly name?: string }[];
    readonly nextPageToken?: string;
  };
  return {
    itemNames: (body.items ?? []).map((item) => item.name ?? ""),
    ...(body.nextPageToken ? { nextPageToken: body.nextPageToken } : {}),
  };
}
