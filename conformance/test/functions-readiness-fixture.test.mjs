import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

test('Functions readiness capture preserves partial discovery and real auxiliary requests',async()=>{
  const root=new URL('../fixtures/functions-readiness-v1/',import.meta.url);
  const bytes=await readFile(new URL('fixture.json',root));
  const checksum=(await readFile(new URL('SHA256SUMS',root),'utf8')).split(' ')[0];
  assert.equal(createHash('sha256').update(bytes).digest('hex'),checksum);
  const fixture=JSON.parse(bytes);
  assert.equal(fixture.syntheticOnly,true);assert.equal(fixture.passed,true);
  assert.equal(fixture.targetVersion,'15.22.0');assert.equal(fixture.sdkVersion,'7.2.5');
  const healthy=fixture.observations.find(row=>row.mode==='healthy');
  const failed=fixture.observations.find(row=>row.mode==='failed-codebase');
  assert.equal(healthy.inventory.backends.flatMap(row=>row.functionTriggers).length,4);
  assert.equal(failed.status,200);assert.equal(failed.connectError,null);
  assert(failed.calls.find(row=>row.codebase==='broken').error.includes('could not be analyzed'));
  assert.deepEqual(failed.inventory.backends.find(row=>row.directory.endsWith('/broken')).functionTriggers,[]);
  const missing=fixture.observations.find(row=>row.mode==='missing-auxiliary');
  assert.equal(missing.connectError,null);assert.equal(missing.status,200);
  assert.equal(missing.inventory.backends.flatMap(row=>row.functionTriggers).length,4);
  assert.deepEqual(missing.triggerRecords.filter(row=>row.ignored).map(row=>row.id),['us-central1-task','us-central1-event']);
  assert(healthy.triggerRecords.every(row=>row.enabled&&!row.ignored));
  const predefined=fixture.observations.find(row=>row.mode==='predefined-backend');
  assert.equal(predefined.status,200);assert.equal(predefined.connectError,null);
  assert.deepEqual(predefined.calls[0].ids,['us-central1-alpha']);
  assert.equal(predefined.inventory.backends[0].functionTriggers[0].id,undefined);
  assert.deepEqual(predefined.inventory.backends[0].functionTriggers[0].regions,['us-central1']);
  assert.equal(predefined.calls[0].definitions[0].region,'us-central1');
  const collision=fixture.observations.find(row=>row.mode==='colliding-backends');
  assert.equal(collision.connectError,null);assert.equal(collision.status,200);
  assert.deepEqual(collision.calls.map(row=>row.ids),[collision.calls[0].ids,collision.calls[0].ids]);
  assert.deepEqual(collision.inventory.backends.map(row=>row.functionTriggers.length),[0,2]);
  assert(collision.triggerRecords.every(row=>row.recordBackend==='collision'));
  // Upstream's own extension.yaml normalizer drops taskQueueTrigger: the
  // official host discovers, lists and ignores a trigger-less handler, and starts.
  const unsupported=fixture.observations.find(row=>row.mode==='unsupported-predefined');
  assert.equal(unsupported.connectError,null);assert.equal(unsupported.status,200);
  assert.deepEqual(unsupported.calls[0].ids,['us-central1-alpha','us-central1-full']);
  const full=unsupported.calls[0].definitions.find(def=>def.id==='us-central1-full');
  assert.deepEqual(Object.keys(full).filter(key=>key.endsWith('Trigger')),[]);
  assert.deepEqual(unsupported.inventory.backends[0].functionTriggers.map(row=>row.name),['alpha','full']);
  assert.deepEqual(unsupported.triggerRecords.map(row=>[row.id,row.ignored,row.enabled]),[['us-central1-alpha',false,true],['us-central1-full',true,true]]);
  for(const auxiliary of fixture.auxiliary){
    assert.equal(auxiliary.fixture.exchanges.length,1);
    const exchange=auxiliary.fixture.exchanges[0];
    assert.equal(exchange.request.method,'POST');assert.equal(exchange.response.status,200);
    const body=JSON.parse(Buffer.from(exchange.request.bodyBase64,'base64'));
    const response=JSON.parse(Buffer.from(exchange.response.bodyBase64,'base64'));
    if(auxiliary.name==='eventarc'){
      assert.equal(body.eventTrigger.service,'eventarc.googleapis.com');assert.deepEqual(response,{res:'OK'});
      assert(exchange.request.uri.startsWith('/emulator/v1/projects/'+fixture.projectId+'/triggers/'));
    }else{
      assert.equal(auxiliary.name,'tasks');assert.equal(response.taskQueueConfig.retryConfig.maxAttempts,3);
      assert.equal(response.taskQueueConfig.defaultUri,body.defaultUri);
      assert(exchange.request.uri.endsWith('/queues/task'));
    }
  }
});
