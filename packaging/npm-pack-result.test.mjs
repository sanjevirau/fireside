import test from 'node:test';
import assert from 'node:assert/strict';
import { packResult, registryIntegrity } from './npm-pack-result.mjs';

const result = {name:'@fireside-dev/cli', filename:'fireside-dev-cli-0.1.0-next.0.tgz'};
test('npm 12 keyed object and earlier array pack results preserve identity', () => {
  for (const value of [{[result.name]:result}, [result]]) {
    assert.deepEqual(packResult(JSON.stringify(value), result.name), result);
  }
});
test('pack results reject wrong identity, multiple packages and escaping paths', () => {
  for (const value of [[], [result, result], [{...result,name:'other'}], [{...result,filename:'../escape.tgz'}]]) {
    assert.throws(() => packResult(JSON.stringify(value), result.name));
  }
});

test('registry integrity accepts npm 12 singleton arrays and older scalar output', () => {
  for (const value of ['sha512-YWpL6q==', ['sha512-YWpL6q==']]) {
    assert.equal(registryIntegrity(JSON.stringify(value)), 'sha512-YWpL6q==');
  }
  for (const value of [[], ['sha512-a', 'sha512-b'], {}, null, 'unverified']) {
    assert.throws(() => registryIntegrity(JSON.stringify(value)));
  }
});
