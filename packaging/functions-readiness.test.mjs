import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {runInNewContext} from 'node:vm';

const source=await readFile(new URL('../support/functions-host.cjs',import.meta.url),'utf8');
const declaration=source.match(/^async function startFunctionsOnce\([^]*?^\}/m)?.[0];
assert(declaration,'actual workload-host discovery adapter');
const start=runInNewContext('('+declaration+')');
const fixture=JSON.parse(await readFile(new URL('../conformance/fixtures/functions-readiness-v1/fixture.json',import.meta.url)));

// A unit replay of captured discovery/registration states, not a live SDK run.
function replay(mode,omitId){
  const observation=fixture.observations.find(row=>row.mode===mode);
  const backends=observation.calls.map(call=>({codebase:call.codebase,functionsDir:'synthetic/'+call.codebase}));
  const definitions=observation.inventory.backends.flatMap(row=>row.functionTriggers);
  const records=observation.triggerRecords.filter(row=>row.id!==omitId).map(row=>({...row,def:definitions.find(def=>def.id===row.id)}));
  const calls=[];
  const emulator={
    async discoverTriggers(backend){
      calls.push(backend.codebase);
      const call=observation.calls.find(row=>row.codebase===backend.codebase);
      if(call.error)throw new Error(call.error);
      return definitions.filter(def=>call.ids.includes(def.id));
    },
    async connect(){for(const backend of backends){try{await this.discoverTriggers(backend);}catch{ /* upstream swallows discovery errors */ }}},
    getTriggerDefinitions:()=>records.map(row=>row.def),
    getTriggerKey:def=>def.id,
    getTriggerRecordByKey:key=>records.find(row=>row.id===key),
  };
  return {run:()=>start(emulator,{start:async()=>{}},backends),calls};
}
test('complete healthy discovery is admitted exactly once per backend',async()=>{
  const host=replay('healthy');assert.equal(await host.run(),4);assert.deepEqual(host.calls,['http','auxiliary']);
});
test('an ignored function must not produce ready even when upstream inventory lists it',async()=>{
  await assert.rejects(replay('missing-auxiliary').run(),/ignored|not registered|not admitted/i);
});
test('a missing registered definition must not be hidden behind a successful discovery count',async()=>{
  await assert.rejects(replay('healthy','us-central1-echo').run(),/missing|not registered|not admitted/i);
});
test('a broken configured codebase cannot borrow healthy functions from another backend',async()=>{
  await assert.rejects(replay('failed-codebase').run(),/discovery did not complete/);
});
