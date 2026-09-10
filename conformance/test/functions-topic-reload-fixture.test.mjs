import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

test('real official source watcher admits added topics and updated handler code',async()=>{
  const root=new URL('../fixtures/functions-topic-reload-v1/',import.meta.url);
  const bytes=await readFile(new URL('fixture.json',root));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),(await readFile(new URL('SHA256SUMS',root),'utf8')).split(' ')[0]);
  const fixture=JSON.parse(bytes);
  assert.equal(fixture.passed,true);assert.equal(fixture.syntheticOnly,true);
  assert.equal(fixture.firebaseTools,'15.22.0');assert.equal(fixture.firebaseFunctions,'7.2.5');
  assert.deepEqual(fixture.observations.map(row=>[row.stage,row.topic,row.delivered.handler,row.delivered.version]),[
    ['initial','alpha-topic','alpha',1],['added-handler','beta-topic','beta',2],['updated-handler','alpha-topic','alpha',2],
  ]);
  for(const row of fixture.observations){
    assert.deepEqual(row.delivered.data,{synthetic:true,stage:row.stage,unicode:'火🔥'});
    assert(row.registeredTopics.includes(row.topic));
  }
});
