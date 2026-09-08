import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const script=fileURLToPath(new URL('./smoke-local-consumer.mjs',import.meta.url));
test('local consumer rejects mutable or executable baseline specifications before I/O',()=>{
  for(const baseline of ['latest','next','^0.1.0','file:/tmp/candidate','https://example.test/package.tgz','0.1.0;echo nope']) {
    const result=spawnSync(process.execPath,[script,'/not-a-candidate',baseline],{encoding:'utf8'});
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/registry baseline must be an exact version/);
    assert.doesNotMatch(result.stderr,/ENOENT/);
  }
});
test('local consumer requires an artifact directory and rejects extra arguments',()=>{
  for(const args of [[],['/not-a-candidate','0.1.0','extra']]) {
    const result=spawnSync(process.execPath,[script,...args],{encoding:'utf8'});
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/Usage: smoke-local-consumer/);
  }
});
