import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

test('REST read capture preserves projections, snapshots and upstream adapter failures',async()=>{
  const root=new URL('../fixtures/rest-read-options-v1/',import.meta.url);
  const bytes=await readFile(new URL('fixture.json',root));
  const sha=(await readFile(new URL('SHA256SUMS',root),'utf8')).split(' ')[0];
  assert.equal(createHash('sha256').update(bytes).digest('hex'),sha);
  const fixture=JSON.parse(bytes);assert.equal(fixture.syntheticOnly,true);assert.equal(fixture.passed,true);
  assert.equal(fixture.oracle.firestore,'1.22.0');assert.equal(fixture.oracle.node,'v24.20.0');
  const rows=Object.fromEntries(fixture.exchanges.map(row=>[row.id,row]));
  assert.equal(fixture.exchanges.length,22);
  assert.deepEqual(rows['get-mask'].response.fields,{title:{stringValue:'before 火🔥'}});
  assert.deepEqual(rows['get-nested-mask'].response.fields,{nested:{mapValue:{fields:{one:{integerValue:'1'}}}}});
  assert.equal(rows['get-absent-mask'].response.fields,undefined);
  assert.deepEqual(Object.keys(rows['get-repeated-mask'].response.fields).sort(),['title','visible']);
  assert.equal(rows['get-invalid-mask'].status,400);assert.equal(rows['get-anonymous'].status,403);
  assert.equal(rows['get-read-time'].status,400);assert.equal(rows['batch-read-time'].status,200);
  for(const id of ['get-in-read-only','get-read-only-after-mutation','get-selector-conflict','get-invalid-transaction','get-rolled-back']){
    assert.equal(rows[id].status,null);assert.equal(rows[id].error,'TimeoutError');assert.equal(rows[id].deadlineMilliseconds,10000);
  }
  assert.equal(rows['batch-read-only'].response.find(row=>row.found).found.fields.title.stringValue,'before 火🔥');
  assert.equal(rows['batch-mask'].response.find(row=>row.found).found.fields.title.stringValue,'after');
  assert.deepEqual(Object.keys(rows['batch-new-read-only'].response[0]),['transaction']);
  assert.equal(fixture.grpc.find(row=>row.id==='get-read-only-after-mutation').response.fields.title.stringValue,'before 火🔥');
  assert.equal(fixture.grpc.find(row=>row.id==='get-rolled-back').status,10);
});
