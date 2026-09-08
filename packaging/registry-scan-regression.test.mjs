import test from 'node:test';
import assert from 'node:assert/strict';
import { publishVerifiedRelease, waitForRegistry } from './registry-readiness.mjs';

// Deterministic three-minute delay model, not a historical publication receipt.
const metadataVisibleAfterMs = 180_000;

test('acknowledged npm uploads may hide BOTH metadata endpoints beyond two minutes', async () => {
  const names = ['darwin-arm64', 'linux-x64', 'cli'];
  const records = names.map(name => ({name:`@fireside-dev/${name}`,version:'0.1.0-next.1',integrity:'sha512-fixture'}));
  const accepted = new Map();
  let elapsed = 0;
  const probe = async (record, kind) => {
    if (!accepted.has(record.name) || elapsed - accepted.get(record.name) < metadataVisibleAfterMs) return null;
    const version = {name:record.name,version:record.version,dist:{integrity:record.integrity}};
    return kind === 'version' ? version : {versions:{[record.version]:version},'dist-tags':{next:record.version}};
  };
  const result = await publishVerifiedRelease(records, {
    probe,
    publish: async record => {
      assert.equal(accepted.has(record.name), false, 'never upload accepted bytes again');
      if (record.name.endsWith('/cli')) {
        for (const native of records.slice(0, -1)) assert.ok(await probe(native, 'index'), 'CLI must wait for installable natives');
      }
      accepted.set(record.name, elapsed);
    },
    wait: (pending, kind, options) => waitForRegistry(pending, kind, {
      ...options, now:()=>elapsed, sleep:async ms=>{elapsed+=ms;}, report:()=>{},
    }),
  });
  assert.equal(result.size, 3);
  assert.equal(accepted.size, 3);
  assert.ok(elapsed >= metadataVisibleAfterMs * 2);
});
