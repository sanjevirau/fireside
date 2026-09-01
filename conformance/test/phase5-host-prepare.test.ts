import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPhase5Ports,
  PHASE5_STACK_PORTS,
  renderSafeTwodartEnvironment,
} from "../src/suite/phase5-host-prepare.ts";

test("Phase 5 host preparation uses only synthetic local provider values", () => {
  const environment = renderSafeTwodartEnvironment();
  assert.match(environment, /^ENV="local"$/mu);
  assert.match(environment, /^TWODART_DISABLE_EXTERNALS="1"$/mu);
  assert.match(environment, /^NEXT_PUBLIC_ENABLE_POSTHOG="false"$/mu);
  assert.match(environment, /^FIREBASE_FE_PROJECT_ID="demo-twodart-local"$/mu);
  assert.doesNotMatch(environment, /(?:AIza|ya29\.|sk_(?:live|test)|@gmail\.)/u);
  assert.doesNotMatch(environment, /fireside-conformance/u);
});

test("Phase 5 host preparation freezes every official and Fireside port", () => {
  for (const name of ["official", "fireside"] as const) {
    const ports = PHASE5_STACK_PORTS[name];
    const rendered = JSON.parse(
      applyPhase5Ports('{"emulators":{}}', ports),
    ) as {
      readonly emulators: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    };
    assert.deepEqual(rendered.emulators.firestore, {
      host: "127.0.0.1",
      port: ports.firestore,
      websocketPort: ports.firestoreWebsocket,
    });
    assert.equal(rendered.emulators.auth?.port, ports.auth);
    assert.equal(rendered.emulators.storage?.port, ports.storage);
    assert.equal(rendered.emulators.functions?.port, ports.functions);
    assert.equal(rendered.emulators.pubsub?.port, ports.pubsub);
    assert.equal(rendered.emulators.hub?.port, ports.hub);
    assert.equal(rendered.emulators.ui?.port, ports.ui);
    assert.equal(rendered.emulators.logging?.port, ports.logging);
    assert.equal(rendered.emulators.eventarc?.port, ports.eventarc);
    assert.equal(rendered.emulators.tasks?.port, ports.tasks);
  }
  const allPorts = Object.values(PHASE5_STACK_PORTS).flatMap((ports) =>
    Object.values(ports)
  );
  assert.equal(new Set(allPorts).size, allPorts.length);
});
