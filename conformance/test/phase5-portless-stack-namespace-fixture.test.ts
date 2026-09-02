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
      readonly linkedWorktreePrefix: string;
      readonly rootClonePrefix: null;
    };
    readonly observation: { readonly collidingHostname: string };
    readonly oracle: { readonly revision: string; readonly version: string };
    readonly schemaVersion: number;
  };

  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.oracle.version, "0.11.1");
  assert.equal(fixture.oracle.revision, "a9385b83250c78855fb51dc1742671c45fbf07ed");
  assert.equal(fixture.contract.rootClonePrefix, null);
  assert.equal(fixture.contract.duplicateLiveHostnameRejected, true);
  assert.equal(fixture.contract.forceWouldReplaceExistingRoute, true);
  assert.equal(
    fixture.contract.linkedWorktreePrefix,
    "last sanitized non-default branch segment",
  );
  assert.equal(fixture.observation.collidingHostname, "templates.twodart.localhost");
});
