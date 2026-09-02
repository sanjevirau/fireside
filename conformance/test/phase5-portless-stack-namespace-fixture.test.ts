import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const fixtureUrl = new URL(
  "../fixtures/phase5/portless-stack-namespace-contract.json",
  import.meta.url,
);

test("portless oracle requires unique linked-worktree host namespaces", async () => {
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8")) as {
    readonly contract: {
      readonly duplicateLiveHostnameRejected: boolean;
      readonly forceWouldReplaceExistingRoute: boolean;
      readonly listedRouteIsInsufficientWithoutHttpsTraversal: boolean;
      readonly linkedWorktreePrefix: string;
      readonly privilegedHttpsProxyRequiresExplicitSharedStateDirectory: boolean;
      readonly readinessMustTraverseRequiredHttpsRoute: boolean;
      readonly routeRegistrationStateMustMatchActiveProxyState: boolean;
      readonly rootClonePrefix: null;
    };
    readonly observation: {
      readonly namespaceCollision: { readonly collidingHostname: string };
      readonly proxyStateMismatch: {
        readonly activeHttpsProxyOwner: string;
        readonly activeHttpsProxyPort: number;
        readonly directApplicationStatuses: Readonly<Record<string, number>>;
        readonly failedSystemdUnits: number;
        readonly firesideStarted: boolean;
        readonly kernelOomEvidence: number;
        readonly listedRoutes: Readonly<Record<string, number>>;
        readonly officialExportCompleted: boolean;
        readonly requiredHttpsResponseHeader: string;
        readonly requiredHttpsStatuses: Readonly<Record<string, number>>;
        readonly routeRegistrationFile: string;
        readonly routeRegistrationOwner: string;
        readonly routeRegistrationProxyMarkersPresent: boolean;
      };
    };
    readonly oracle: {
      readonly revision: string;
      readonly sourceFiles: readonly string[];
      readonly version: string;
    };
    readonly schemaVersion: number;
  };

  assert.equal(fixture.schemaVersion, 2);
  assert.equal(fixture.oracle.version, "0.11.1");
  assert.equal(fixture.oracle.revision, "a9385b83250c78855fb51dc1742671c45fbf07ed");
  assert.deepEqual(fixture.oracle.sourceFiles, [
    "src/auto.ts",
    "src/cli-utils.ts",
    "src/cli.ts",
    "src/proxy.ts",
    "src/routes.ts",
  ]);
  assert.equal(fixture.contract.rootClonePrefix, null);
  assert.equal(fixture.contract.duplicateLiveHostnameRejected, true);
  assert.equal(fixture.contract.forceWouldReplaceExistingRoute, true);
  assert.equal(fixture.contract.routeRegistrationStateMustMatchActiveProxyState, true);
  assert.equal(fixture.contract.privilegedHttpsProxyRequiresExplicitSharedStateDirectory, true);
  assert.equal(fixture.contract.listedRouteIsInsufficientWithoutHttpsTraversal, true);
  assert.equal(fixture.contract.readinessMustTraverseRequiredHttpsRoute, true);
  assert.equal(
    fixture.contract.linkedWorktreePrefix,
    "last sanitized non-default branch segment",
  );
  assert.equal(
    fixture.observation.namespaceCollision.collidingHostname,
    "templates.twodart.localhost",
  );
  assert.equal(fixture.observation.proxyStateMismatch.activeHttpsProxyOwner, "root");
  assert.equal(fixture.observation.proxyStateMismatch.activeHttpsProxyPort, 443);
  assert.equal(fixture.observation.proxyStateMismatch.routeRegistrationOwner, "sanjevi");
  assert.equal(
    fixture.observation.proxyStateMismatch.routeRegistrationFile,
    "/home/sanjevi/.portless/routes.json",
  );
  assert.equal(
    fixture.observation.proxyStateMismatch.routeRegistrationProxyMarkersPresent,
    false,
  );
  assert.deepEqual(fixture.observation.proxyStateMismatch.listedRoutes, {
    "phase5-official.templates.twodart.localhost": 4135,
    "phase5-official.twodartnet.twodart.localhost": 4743,
  });
  assert.deepEqual(fixture.observation.proxyStateMismatch.directApplicationStatuses, {
    templates: 200,
    twodartnet: 200,
  });
  assert.deepEqual(fixture.observation.proxyStateMismatch.requiredHttpsStatuses, {
    templates: 404,
    twodartnet: 404,
  });
  assert.equal(
    fixture.observation.proxyStateMismatch.requiredHttpsResponseHeader,
    "X-Portless: 1",
  );
  assert.equal(fixture.observation.proxyStateMismatch.officialExportCompleted, true);
  assert.equal(fixture.observation.proxyStateMismatch.firesideStarted, false);
  assert.equal(fixture.observation.proxyStateMismatch.kernelOomEvidence, 0);
  assert.equal(fixture.observation.proxyStateMismatch.failedSystemdUnits, 0);
});
