import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import {createHash} from 'node:crypto';

const source=await readFile(new URL('../support/functions-host.cjs',import.meta.url),'utf8');
const declaration=source.match(/^async function startFunctionsOnce\([^]*?^\}/m)?.[0];
assert(declaration,'actual workload-host discovery adapter');
const classifier=source.match(/^function upstreamIgnoreReason\([^]*?^\}/m)?.[0];
assert(classifier,'actual ignored-record classifier');
// Pinned firebase-tools 15.22.0 getFunctionService, reduced to the captured
// definition shapes; the conformance capture verifies the adapter with the real one.
function getFunctionService(def){
  if(def.eventTrigger){
    if(def.eventTrigger.channel)return 'eventarc.googleapis.com';
    if(def.eventTrigger.service)return def.eventTrigger.service;
    const type=def.eventTrigger.eventType;
    if(type.includes('firestore'))return 'firestore.googleapis.com';
    if(type.includes('database'))return 'firebaseio.com';
    if(type.includes('pubsub'))return 'pubsub.googleapis.com';
    return '';
  }
  if(def.blockingTrigger)return def.blockingTrigger.eventType;
  if(def.httpsTrigger)return 'https';
  return 'unknown';
}
const start=runInNewContext(classifier+';('+declaration+')',{getFunctionService});
const fixture=JSON.parse(await readFile(new URL('../conformance/fixtures/functions-readiness-v1/fixture.json',import.meta.url)));

test('reload notifications follow completed registration without rediscovery',async()=>{
  const declaration=source.match(/^function watchFunctionInventory\([^]*?^\}/m)?.[0];
  assert(declaration);
  const install=runInNewContext('('+declaration+')');
  const calls=[],definitions=[{id:'synthetic'}];
  let complete;const registered=new Promise(resolve=>complete=resolve);
  const emulator={
    async loadTriggers(...args){assert.equal(this,emulator);calls.push(args);await registered;return 'registered';},
    getTriggerDefinitions:()=>definitions,
  };
  const updates=[];install(emulator,value=>updates.push(value));
  const loading=emulator.loadTriggers('backend',true);
  assert.equal(updates.length,0);complete();assert.equal(await loading,'registered');
  assert.deepEqual(calls,[['backend',true]]);assert.deepEqual(updates,[definitions]);
  const failed={loadTriggers:async()=>{throw new Error('failed');},getTriggerDefinitions:()=>assert.fail('no receipt after rejected load')};
  install(failed,()=>assert.fail('no update'));await assert.rejects(failed.loadTriggers(),/failed/);
});

// A unit replay of captured discovery/registration states, not a live SDK run.
function replay(mode,omitId){
  const observation=fixture.observations.find(row=>row.mode===mode);
  const backends=observation.calls.map(call=>({codebase:call.codebase,functionsDir:'synthetic/'+call.codebase}));
  const definitions=observation.calls.flatMap(row=>row.definitions??[]);
  const records=observation.triggerRecords.filter(row=>row.id!==omitId).map(row=>({...row,
    backend:backends.find(backend=>backend.codebase===row.recordBackend),
    def:observation.calls.find(call=>call.codebase===row.recordBackend).definitions.find(def=>def.id===row.id)}));
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
const plain=value=>JSON.parse(JSON.stringify(value));
test('complete healthy discovery is admitted exactly once per backend',async()=>{
  const host=replay('healthy');assert.deepEqual(plain(await host.run()),{customFunctionCount:4,ignored:[]});assert.deepEqual(host.calls,['http','auxiliary']);
});
test('a function ignored after a failed registration with this suite must not produce ready',async()=>{
  await assert.rejects(replay('missing-auxiliary').run(),/us-central1-task was discovered but not admitted \(registration with this suite failed\)/);
});
test('a function upstream itself cannot type is reported as ignored and does not block ready',async()=>{
  const host=replay('unsupported-predefined');
  assert.deepEqual(plain(await host.run()),{customFunctionCount:2,ignored:[{id:'us-central1-full',reason:'upstream found no httpsTrigger, eventTrigger or blockingTrigger'}]});
  assert.match(source,/ignoredCount: ignored\.length/);
  assert.match(source,/discovered but ignored by firebase-tools: \$\{handler\.reason\}/);
});
test('an ignored event trigger outside the suite service profile is reported, inside it is fatal',async()=>{
  const outside={id:'us-central1-rtdb',eventTrigger:{eventType:'providers/google.firebase.database/eventTypes/ref.write',resource:'projects/_/instances/x/refs/y'}};
  const inside={id:'us-central1-doc',eventTrigger:{eventType:'providers/cloud.firestore/eventTypes/document.write',resource:'projects/p/databases/(default)/documents/x/{id}'}};
  const disabled={id:'us-central1-off',httpsTrigger:{}};
  const backend={codebase:'synthetic',functionsDir:'synthetic'};
  const emulator=definitions=>({
    async discoverTriggers(){return definitions;},
    async connect(){await this.discoverTriggers(backend);},
    getTriggerKey:def=>def.id,
    getTriggerRecordByKey:key=>({def:definitions.find(def=>def.id===key),backend,enabled:key!=='us-central1-off',ignored:key!=='us-central1-off'}),
  });
  const registry={start:async()=>{}};
  assert.deepEqual(plain(await start(emulator([outside]),registry,[backend])),{customFunctionCount:1,ignored:[{id:'us-central1-rtdb',reason:"firebaseio.com event triggers are outside this suite's service profile"}]});
  await assert.rejects(start(emulator([inside]),registry,[backend]),/us-central1-doc was discovered but not admitted \(registration with this suite failed\)/);
  await assert.rejects(start(emulator([disabled]),registry,[backend]),/us-central1-off was discovered but not admitted \(disabled\)/);
});
test('a missing registered definition must not be hidden behind a successful discovery count',async()=>{
  await assert.rejects(replay('healthy','us-central1-echo').run(),/missing|not registered|not admitted/i);
});
test('a broken configured codebase cannot borrow healthy functions from another backend',async()=>{
  await assert.rejects(replay('failed-codebase').run(),/discovery did not complete/);
});
test('predefined backends use the admitted regional definition',async()=>{
  assert.equal((await replay('predefined-backend').run()).customFunctionCount,1);
});
test('colliding codebases cannot borrow another backends registered function identity',async()=>{
  await assert.rejects(replay('colliding-backends').run(),/another backend|not registered/);
});
test('main validates every configured backend, including predefined extensions',()=>{
  assert.match(source,/startFunctionsOnce\(functionsEmulator, EmulatorRegistry, emulatableBackends, custom\)/);
});
test('compact identity receipt matches the captured inventory and retains duplicates',()=>{
  const declaration=source.match(/^function inventoryFingerprint\([^]*?^\}/m)?.[0];
  assert(declaration,'actual identity receipt producer');
  const fingerprint=runInNewContext('('+declaration+')',{createHash,Buffer});
  const healthy=fixture.observations.find(row=>row.mode==='healthy').calls.flatMap(row=>row.definitions);
  const expected={count:4,sha256:'8532cd316320668eb493034eeedce3ae2694a8d31e4c1a2090ffae8083fb95d6'};
  assert.deepEqual(JSON.parse(JSON.stringify(fingerprint(healthy))),expected);
  assert.deepEqual(JSON.parse(JSON.stringify(fingerprint([...healthy].reverse()))),expected);
  assert.notEqual(fingerprint([...healthy,healthy[0]]).sha256,expected.sha256);
  const predefined=fixture.observations.find(row=>row.mode==='predefined-backend').inventory.backends[0].functionTriggers;
  assert.equal(fingerprint(predefined).sha256,'8aec3fff76586e3233f5ef55609ca4166373b28540ce65eda85a307b72eb4f7a');
});
