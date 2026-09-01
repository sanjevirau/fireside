import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";

interface Observation {
  readonly id: string;
  readonly status: number;
  readonly body: {
    readonly error?: {
      readonly code?: number;
      readonly message?: string;
      readonly status?: string;
    };
    readonly writeResults?: readonly unknown[];
  };
}

interface Fixture {
  readonly schemaVersion: number;
  readonly target: string;
  readonly targetVersion: string;
  readonly credentialsStored: boolean;
  readonly authorizationHeadersStored: boolean;
  readonly javaJarSha256: string;
  readonly rulesSource: string;
  readonly rulesSourceSha256: string;
  readonly observations: readonly Observation[];
}

const root = new URL("../fixtures/rules-v2/", import.meta.url);
const jarSha256 =
  "9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c";

async function fixture(name: string, expectedSha256: string): Promise<Fixture> {
  const bytes = await readFile(new URL(name, root));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), expectedSha256);
  const value = JSON.parse(bytes.toString("utf8")) as Fixture;
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.target, "official-java-emulator");
  assert.equal(value.targetVersion, "1.22.0");
  assert.equal(value.credentialsStored, false);
  assert.equal(value.authorizationHeadersStored, false);
  assert.equal(value.javaJarSha256, jarSha256);
  assert.equal(
    createHash("sha256").update(value.rulesSource).digest("hex"),
    value.rulesSourceSha256,
  );
  const serialized = bytes.toString("utf8").toLowerCase();
  for (const forbidden of [
    "bearer ",
    "access_token",
    "refresh_token",
    "private_key",
    "client_secret",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  return value;
}

function byId(value: Fixture): Map<string, Observation> {
  return new Map(value.observations.map((observation) => [observation.id, observation]));
}

function assertDenied(observation: Observation | undefined, message: RegExp): void {
  assert.equal(observation?.status, 403);
  assert.equal(observation?.body.error?.code, 403);
  assert.equal(observation?.body.error?.status, "PERMISSION_DENIED");
  assert.match(observation?.body.error?.message ?? "", message);
}

test("Java access accounting freezes 10/20 limits and repeated-call caching", async () => {
  const value = await fixture(
    "java-access-accounting.json",
    "8f96b510467ca875cebd48d4af5b8a05ca21aa077fd7f7ab9a95d51ab16612cc",
  );
  const observations = byId(value);
  assert.equal(value.observations.length, 7);
  assert.equal(observations.get("probe/access-10")?.status, 200);
  assertDenied(observations.get("probe/access-11"), /Service call error.*\[get\]/s);
  assert.equal(observations.get("probe/cached-11")?.status, 200);
  assert.equal(observations.get("probe/exists-10")?.status, 200);
  assertDenied(observations.get("probe/exists-11"), /Service call error.*\[exists\]/s);
  assert.equal(observations.get("batch-20-distinct-access-calls")?.status, 200);
  assert.equal(
    observations.get("batch-20-distinct-access-calls")?.body.writeResults?.length,
    20,
  );
  assertDenied(
    observations.get("batch-21-distinct-access-calls"),
    /Service call error.*\[exists\]/s,
  );
});

test("Java getAfter sees the atomic pending write set", async () => {
  const value = await fixture(
    "java-get-after.json",
    "df4fbeb21833622ad3bf0ba2df6467f73f947add319ae2c3bf0b07403b9be0fc",
  );
  const observations = byId(value);
  assert.equal(value.observations.length, 2);
  assert.equal(observations.get("get-after-sees-pending-write")?.status, 200);
  assert.equal(
    observations.get("get-after-sees-pending-write")?.body.writeResults?.length,
    2,
  );
  assertDenied(
    observations.get("get-after-denies-stale-invariant"),
    /false for 'create'/,
  );
});

test("Java runtime errors deny without escaping as transport failures", async () => {
  const value = await fixture(
    "java-runtime-errors.json",
    "a8793d7e86cf0f2396a43dcb26acec7d89c681c1b566a4cc0baaaeb49c45222d",
  );
  const observations = byId(value);
  assert.equal(value.observations.length, 5);
  assertDenied(observations.get("runtime/missing-field"), /Property missing is undefined/);
  assertDenied(observations.get("runtime/division-zero"), /Divide by zero/);
  assertDenied(observations.get("runtime/list-out-of-bounds"), /Index out of bound/);
  assertDenied(observations.get("runtime/wrong-type-method"), /Function not found.*size/s);
  assertDenied(observations.get("runtime/missing-get-resource"), /Null value error/);
});
