import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

test('compiler binding capture preserves package and ordinary-name distinctions',async()=>{
  const root=new URL('../fixtures/rule-bindings-v1/',import.meta.url);
  const bytes=await readFile(new URL('fixture.json',root));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),(await readFile(new URL('SHA256SUMS',root),'utf8')).split(' ')[0]);
  const fixture=JSON.parse(bytes);
  assert.equal(fixture.syntheticOnly,true);assert.equal(fixture.passed,true);
  assert.equal(fixture.oracle.firestore,'1.22.0');assert.equal(fixture.profiles.length,40);
  for(const row of fixture.profiles){
    const rejected=['duration','hashing','latlng','math','timestamp'].includes(row.name)&&['parameter','binding','wildcard'].includes(row.kind);
    assert.equal(row.status,rejected?400:200,`${row.name}/${row.kind}`);
    if(rejected)assert.match(row.response.error.message,/is a package and cannot be used as variable name/);
  }
});
