// Capture actual pinned Functions discovery and auxiliary startup HTTP traffic.
// No consumer code or task/event delivery; the latter remains outside this release.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {mkdir,readFile,writeFile,symlink} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createServer} from 'node:net';
import {dirname,join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

assert.equal(process.argv.length,6,'binary toolsRoot sdkRoot fresh-output');
assert.equal(process.version,'v24.20.0');
const [binary,tools,sdk,output]=process.argv.slice(2).map(value=>resolve(value));
const require=createRequire(join(tools,'package.json'));
assert.equal(require(join(tools,'package.json')).version,'15.22.0');
assert.equal(require(join(sdk,'package.json')).version,'7.2.5');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const projectId='demo-fireside-readiness-oracle';
await mkdir(output,{mode:0o700});await mkdir(join(output,'gcloud'));
await writeFile(join(output,'adc.json'),JSON.stringify({type:'authorized_user',client_id:'demo',client_secret:'demo',refresh_token:'demo'}));
for(const key of ['FIREBASE_TOKEN','CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE','NODE_OPTIONS'])delete process.env[key];
Object.assign(process.env,{PATH:dirname(process.execPath)+':'+process.env.PATH,
  GOOGLE_APPLICATION_CREDENTIALS:join(output,'adc.json'),CLOUDSDK_CONFIG:join(output,'gcloud'),GCLOUD_PROJECT:projectId,GOOGLE_CLOUD_PROJECT:projectId});
const {FunctionsEmulator}=require(join(tools,'lib/emulator/functionsEmulator.js'));
const {EventarcEmulator}=require(join(tools,'lib/emulator/eventarcEmulator.js'));
const {TasksEmulator}=require(join(tools,'lib/emulator/tasksEmulator.js'));
const {EmulatorRegistry}=require(join(tools,'lib/emulator/registry.js'));
const {Emulators}=require(join(tools,'lib/emulator/types.js'));
const peers=[],proxies=[],reservations=[],ports=[];
for(let i=0;i<5;i++){
  const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  ports.push(server.address().port);reservations.push(server);
}
await Promise.all(reservations.map(server=>new Promise(resolve=>server.close(resolve))));
const sources={
  http:"const {onRequest,onCall}=require('firebase-functions/v2/https');exports.alpha=onRequest((req,res)=>res.json({synthetic:true}));exports.echo=onCall(req=>({echo:req.data}));\n",
  auxiliary:"const {onTaskDispatched}=require('firebase-functions/v2/tasks');const {onCustomEventPublished}=require('firebase-functions/v2/eventarc');exports.task=onTaskDispatched(()=>{});exports.event=onCustomEventPublished('dev.fireside.synthetic',()=>{});\n",
  broken:"throw new Error('synthetic discovery failure');\n",
};
const record={schemaVersion:1,syntheticOnly:true,target:'official-firebase-tools',targetVersion:'15.22.0',sdkVersion:'7.2.5',node:process.version,
  capturedAt:new Date().toISOString(),projectId,sources,captureSha256:hash(await readFile(new URL(import.meta.url))),
  sourceSha256:hash(await readFile(join(tools,'lib/emulator/functionsEmulator.js'))),observations:[],auxiliary:[],passed:false};
const normalize=value=>JSON.parse(JSON.stringify(value).replaceAll(output,'<workspace>'));
async function backend(name){
  const functionsDir=join(output,name);await mkdir(join(functionsDir,'node_modules'),{recursive:true});
  await symlink(sdk,join(functionsDir,'node_modules/firebase-functions'),'dir');
  await writeFile(join(functionsDir,'package.json'),JSON.stringify({name:'synthetic-'+name,main:'index.js',engines:{node:'24'}}));
  await writeFile(join(functionsDir,'index.js'),sources[name]);
  return {functionsDir,codebase:name,runtime:'nodejs24',env:{},secretEnv:[],ignore:[]};
}
async function proxy(name,upstream,port){
  const child=spawn(binary,['capture-proxy','--host','127.0.0.1','--port',String(port),'--upstream',`http://127.0.0.1:${upstream}`,
    '--hypothesis','functions-auxiliary-startup-'+name,'--target','official','--target-version','15.22.0','--sdk','firebase-functions/7.2.5',
    '--recorded-at',record.capturedAt,'--transport','http1'],{stdio:['ignore','pipe','pipe']});
  const row={name,child,exited:once(child,'exit'),port,log:''};proxies.push(row);
  child.stdout.on('data',bytes=>row.log+=bytes);child.stderr.on('data',bytes=>row.log+=bytes);
  const deadline=Date.now()+10000;
  while(true){
    assert.equal(child.exitCode,null,row.log);
    try{const response=await fetch(`http://127.0.0.1:${port}/__fireside_capture/fixture`,{signal:AbortSignal.timeout(200)});if(response.ok){await response.arrayBuffer();break;}}catch{}
    assert(Date.now()<deadline,'capture proxy readiness');await delay(25);
  }
  EmulatorRegistry.set(name,{getName:()=>name,getInfo:()=>({name,host:'127.0.0.1',port}),start:async()=>{},connect:async()=>{},stop:async()=>{}});
}
try{
  for(const [name,Constructor,upstream,port] of [[Emulators.EVENTARC,EventarcEmulator,ports[1],ports[3]],[Emulators.TASKS,TasksEmulator,ports[2],ports[4]]]){
    const peer=new Constructor({host:'127.0.0.1',port:upstream});peers.push({name,peer});await peer.start();await proxy(name,upstream,port);
  }
  const http=await backend('http'),auxiliary=await backend('auxiliary'),broken=await backend('broken');
  // A local, predefined Extension-shaped backend exercises the pinned host's
  // normalizer without downloading an extension or contacting its registry.
  const predefined={...http,codebase:'extension',extensionInstanceId:'synthetic-extension',
    predefinedTriggers:[{name:'alpha',entryPoint:'alpha',platform:'gcfv1',regions:['us-central1'],httpsTrigger:{}}]};
  for(const [mode,backends] of [['healthy',[http,auxiliary]],['failed-codebase',[http,broken]],['missing-auxiliary',[http,auxiliary]],['predefined-backend',[predefined]]]){
    if(mode==='missing-auxiliary'){
      EmulatorRegistry.clear(Emulators.EVENTARC);EmulatorRegistry.clear(Emulators.TASKS);
    }
    const emulator=new FunctionsEmulator({projectId,projectDir:output,emulatableBackends:backends,account:undefined,
      host:'127.0.0.1',port:ports[0],adminSdkConfig:{projectId,storageBucket:projectId+'.appspot.com'}});
    const calls=[],original=emulator.discoverTriggers;
    emulator.discoverTriggers=async function(value){
      const call={codebase:value.codebase};calls.push(call);
      try{const definitions=await original.call(this,value);call.ids=definitions.map(definition=>definition.id);call.definitions=definitions;return definitions;}
      catch(error){call.error=String(error);throw error;}
    };
    try{
      await EmulatorRegistry.start(emulator);let connectError;
      try{await emulator.connect();}catch(error){connectError=String(error);}
      const response=await fetch(`http://127.0.0.1:${ports[0]}/backends`,{signal:AbortSignal.timeout(5000)});
      const inventory=await response.json();assert.equal(response.status,200);
      const triggerRecords=Object.values(emulator.triggers).map(({def,ignored,enabled})=>({id:def.id,codebase:def.codebase,ignored,enabled}));
      record.observations.push(normalize({mode,calls,connectError:connectError??null,status:response.status,inventory,triggerRecords}));
      if(mode==='failed-codebase')assert(calls.some(call=>call.codebase==='broken'&&call.error),'preserve swallowed discovery failure');
      else {
        assert.equal(emulator.getTriggerDefinitions().length,mode==='predefined-backend'?1:4);
        assert.equal(triggerRecords.filter(row=>row.ignored).length,mode==='missing-auxiliary'?2:0);
      }
    }finally{await emulator.stop();EmulatorRegistry.clear(Emulators.FUNCTIONS);}
  }
  for(const row of proxies){
    const response=await fetch(`http://127.0.0.1:${row.port}/__fireside_capture/fixture`,{signal:AbortSignal.timeout(5000)});
    assert.equal(response.status,200);record.auxiliary.push({name:row.name,fixture:await response.json()});
  }
  record.passed=true;
}catch(error){record.failure=String(error);throw error;}
finally{
  for(const row of proxies){
    if(row.child.exitCode===null&&row.child.signalCode===null)row.child.kill('SIGTERM');
    assert(await Promise.race([row.exited,delay(5000,null,{ref:false})]),'owned capture proxy exit');
    await writeFile(join(output,row.name+'-proxy.log'),row.log);
  }
  for(const {name,peer} of peers.reverse()){await peer.stop();EmulatorRegistry.clear(name);}
  await writeFile(join(output,'fixture.json'),JSON.stringify(record,null,2)+'\n');
}
console.log(JSON.stringify({passed:record.passed,output,modes:record.observations.map(row=>({mode:row.mode,calls:row.calls}))}));
