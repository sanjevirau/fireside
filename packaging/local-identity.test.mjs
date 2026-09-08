import assert from 'node:assert/strict';
import test from 'node:test';
import { manifest, release } from '../packages/cli/src/binary.mjs';
import { localIdentity } from './local-identity.mjs';
test('local packages have distinct private identities and do not inherit release acceptance',()=>{
  const originalManifest = JSON.stringify(manifest);
  const revision='1'.repeat(40);
  const result=localIdentity(manifest,release,revision,'darwin-arm64');
  assert.equal(result.manifest.version,'0.1.0-local.g111111111111');
  assert.equal(result.manifest.private,true);
  assert.deepEqual(result.manifest.optionalDependencies,{'@fireside-dev/darwin-arm64':result.manifest.version});
  assert.equal(result.release.engineRevision,revision);
  assert.equal(result.release.acceptanceReport,undefined);
  assert.equal(result.release.localDevelopment,true);
  assert.equal(JSON.stringify(manifest),originalManifest);
  assert.equal(manifest.private,undefined);
  assert.throws(()=>localIdentity(manifest,release,'dirty','darwin-arm64'));
  assert.throws(()=>localIdentity(manifest,release,revision,'unsupported'));
});
