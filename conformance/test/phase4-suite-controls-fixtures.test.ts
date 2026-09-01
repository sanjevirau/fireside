import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

interface Observation {
  readonly id: string;
  readonly status: number;
  readonly path: string;
  readonly response: unknown;
}

interface Fixture {
  readonly schemaVersion: number;
  readonly target: string;
  readonly targetVersion: string;
  readonly targetProject: string;
  readonly credentialsStored: boolean;
  readonly accessTokensStored: boolean;
  readonly realUserDataStored: boolean;
  readonly observations?: readonly Observation[];
  readonly invariants: Readonly<Record<string, unknown>>;
  readonly firstStop?: Readonly<Record<string, unknown>>;
  readonly secondStop?: Readonly<Record<string, unknown>>;
  readonly websocketMessages?: readonly unknown[];
  readonly exportInventory?: readonly Readonly<Record<string, unknown>>[];
  readonly inventory?: Readonly<Record<string, unknown>>;
}

const names = [
  "functions-callable-http-and-error-contract",
  "pubsub-schedule-and-function-dispatch",
  "hub-locator-export-and-background-controls",
  "ui-config-logging-and-websocket",
  "suite-startup-readiness-shutdown-and-restart",
  "extensions-stripe-and-algolia-trigger-inventory",
] as const;

test("Functions fixtures freeze HTTP, callable, typed-error, and discovery contracts", async () => {
  const fixture = await load("functions-callable-http-and-error-contract");
  assertMetadata(fixture);
  assert.equal(fixture.target, "official-firebase-tools-functions-emulator");
  assert.deepEqual(statuses(fixture), [
    ["functions-backends", 200],
    ["http-function-get", 200],
    ["http-function-post", 200],
    ["callable-success", 200],
    ["callable-typed-error", 400],
    ["callable-invalid-get", 400],
    ["unknown-function", 404],
  ]);
  assert.deepEqual(fixture.invariants.functionIds, [
    "us-central1-callableEcho",
    "us-central1-httpEcho",
    "us-central1-scheduledTick",
    "us-central1-topicEcho",
  ]);
  assert.deepEqual(
    nestedValue(observation(fixture, "callable-success").response, ["result", "echo"]),
    { unicode: "火🔥", n: 4 },
  );
  assert.deepEqual(
    nestedValue(observation(fixture, "callable-typed-error").response, ["error"]),
    {
      details: { unicode: "火🔥" },
      message: "phase4 invalid",
      status: "INVALID_ARGUMENT",
    },
  );
  assert.equal(
    nestedValue(observation(fixture, "callable-invalid-get").response, ["error", "status"]),
    "INVALID_ARGUMENT",
  );
});

test("Pub/Sub and schedule fixtures freeze dispatch, disable, and re-enable behavior", async () => {
  const fixture = await load("pubsub-schedule-and-function-dispatch");
  assertMetadata(fixture);
  assert.deepEqual(statuses(fixture), [
    ["list-function-topics", 200],
    ["publish-custom-topic", 200],
    ["publish-schedule-topic", 200],
    ["invoke-schedule-cloudevent-directly", 200],
    ["disable-background-triggers", 200],
    ["publish-while-disabled", 200],
    ["enable-background-triggers", 200],
    ["publish-after-reenable", 200],
  ]);
  assert.deepEqual(fixture.invariants.pubsubPublishedEventKinds, ["topic"]);
  assert.equal(fixture.invariants.schedulePubsubDeliverySupported, false);
  assert.equal(fixture.invariants.scheduleDirectInvocationStatus, 200);
  assert.deepEqual(fixture.invariants.initialDeliveredEventKinds, ["schedule", "topic"]);
  assert.equal(fixture.invariants.disabledPublishAddedEvents, 0);
  assert.equal(fixture.invariants.reenabledPublishAddedEvents, 1);
});

test("Hub fixtures freeze locator, protected export, and restart cleanup contracts", async () => {
  const hub = await load("hub-locator-export-and-background-controls");
  assertMetadata(hub);
  assert.deepEqual(statuses(hub), [
    ["hub-locator", 200],
    ["hub-emulator-map", 200],
    ["create-export-user", 200],
    ["hub-auth-export", 200],
    ["hub-export-origin-blocked", 403],
  ]);
  assert.deepEqual(
    (hub.exportInventory ?? []).map((entry) => entry.path),
    [
      "auth_export/accounts.json",
      "auth_export/config.json",
      "firebase-export-metadata.json",
    ],
  );

  const lifecycle = await load("suite-startup-readiness-shutdown-and-restart");
  assertMetadata(lifecycle);
  assert.equal(lifecycle.invariants.originGuardedRunExitedCleanly, false);
  assert.equal(lifecycle.invariants.originGuardFallthroughObservedInOfficialSuite, true);
  assert.deepEqual(lifecycle.firstStop, {
    clean: false,
    exitCode: 2,
    signalCode: null,
    locatorDeleted: true,
    portsClosed: true,
  });
  assert.deepEqual(lifecycle.secondStop, {
    clean: true,
    exitCode: 0,
    signalCode: null,
    locatorDeleted: true,
    portsClosed: true,
  });
  assert.equal(lifecycle.invariants.samePortRestartReady, true);
});

test("UI fixture freezes config discovery, static entry point, and logging replay", async () => {
  const fixture = await load("ui-config-logging-and-websocket");
  assertMetadata(fixture);
  assert.deepEqual(statuses(fixture), [
    ["ui-api-config", 200],
    ["ui-index-html", 200],
  ]);
  assert.equal(
    nestedValue(observation(fixture, "ui-index-html").response, ["containsRootElement"]),
    true,
  );
  assert.match(
    String(nestedValue(observation(fixture, "ui-index-html").response, ["sha256"])),
    /^[0-9a-f]{64}$/u,
  );
  assert.equal(fixture.invariants.loggingWebsocketConnected, true);
  assert.ok(Number(fixture.invariants.replayedLogMessageCount) >= 3);
  assert.equal(fixture.websocketMessages?.length, 3);
});

test("extension fixture inventories the exact Twodart Stripe and Algolia triggers", async () => {
  const fixture = await load("extensions-stripe-and-algolia-trigger-inventory");
  assertMetadata(fixture);
  assert.equal(fixture.invariants.secretFilesRead, false);
  assert.equal(fixture.invariants.envFileContentsRead, false);
  const inventory = fixture.inventory ?? {};
  assert.deepEqual(inventory.instances, [
    {
      instanceId: "firestore-stripe-payments",
      ref: "invertase/firestore-stripe-payments@0.3.12",
    },
    {
      instanceId: "firestore-algolia-search",
      ref: "algolia/firestore-algolia-search@1.2.10",
    },
    {
      instanceId: "firestore-algolia-userimages",
      ref: "algolia/firestore-algolia-search@1.2.10",
    },
  ]);
  const definitions = asRecord(inventory.definitions);
  const stripe = asRecord(definitions["invertase/firestore-stripe-payments@0.3.12"]);
  const algolia = asRecord(definitions["algolia/firestore-algolia-search@1.2.10"]);
  assert.equal(
    stripe.yamlSha256,
    "d7b2e7d51bbb7269b76bde899347333da90b5113de01cd69a1a8705ea8e310c8",
  );
  assert.equal(
    algolia.yamlSha256,
    "b2f879ca0a6f6bad2b8b0386c34988788df3e2b16b73a02cf52033122b97c77b",
  );
  assert.deepEqual(resourceNames(stripe), [
    "createCheckoutSession",
    "createCustomer",
    "createPortalLink",
    "handleWebhookEvents",
    "onCustomerDataDeleted",
    "onUserDeleted",
  ]);
  assert.deepEqual(resourceNames(algolia), [
    "executeFullIndexOperation",
    "executeIndexOperation",
  ]);
});

test("every suite-control fixture is checksummed and free of ephemeral host data", async () => {
  for (const name of names) {
    const root = fixtureRoot(name);
    const sums = await readFile(new URL("SHA256SUMS", root), "utf8");
    assert.equal(sums.trimEnd().split("\n").length, 2, name);
    for (const line of sums.trimEnd().split("\n")) {
      const match = /^(?<sha>[0-9a-f]{64})  (?<file>.+)$/u.exec(line);
      assert.ok(match?.groups !== undefined, line);
      assert.equal(
        sha256(await readFile(new URL(match.groups.file!, root))),
        match.groups.sha,
        `${name}/${match.groups.file!}`,
      );
    }
    const fixtureText = await readFile(new URL("fixture.json", root), "utf8");
    assert.doesNotMatch(fixtureText, /\/var\/folders|\/tmp\/fsp4-/u, name);
    assert.doesNotMatch(fixtureText, /127\.0\.0\.1:\d{4,5}/u, name);
    assert.doesNotMatch(fixtureText, /ya29\.|AIza|sk_(?:live|test)/u, name);
  }
});

async function load(name: typeof names[number]): Promise<Fixture> {
  return JSON.parse(
    await readFile(new URL("fixture.json", fixtureRoot(name)), "utf8"),
  ) as Fixture;
}

function fixtureRoot(name: typeof names[number]): URL {
  return new URL(`../fixtures/firebase-suite-v1/${name}/`, import.meta.url);
}

function assertMetadata(fixture: Fixture): void {
  assert.equal(fixture.schemaVersion, 1);
  assert.match(fixture.targetVersion, /15\.22\.0|pubsub-0\.8\.33/u);
  assert.match(fixture.targetProject, /^demo-/u);
  assert.equal(fixture.credentialsStored, false);
  assert.equal(fixture.accessTokensStored, false);
  assert.equal(fixture.realUserDataStored, false);
}

function statuses(fixture: Fixture): readonly (readonly [string, number])[] {
  return (fixture.observations ?? []).map(({ id, status }) => [id, status] as const);
}

function observation(fixture: Fixture, id: string): Observation {
  const match = fixture.observations?.find((candidate) => candidate.id === id);
  assert.ok(match, id);
  return match;
}

function nestedValue(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) current = asRecord(current)[key];
  return current;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Readonly<Record<string, unknown>>;
}

function resourceNames(definition: Readonly<Record<string, unknown>>): readonly string[] {
  const resources = definition.resources;
  assert.ok(Array.isArray(resources));
  return resources.map((resource) => String(asRecord(resource).name)).sort();
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
