// Short live verification of the shipped adapter against the pinned SDK.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdir,readFile,writeFile,symlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {runInNewContext} from 'node:vm';

assert.equal(process.argv.length,6,'toolsRoot sdkRoot output adapter');
const [toolsRoot,sdkRoot,output,adapter]=process.argv.slice(2).map(value=>resolve(value));
assert.equal(process.version,'v24.20.0');
// The SDK launches its discovery script via /usr/bin/env node, independently
// of the absolute Node executable used to launch this diagnostic.
process.env.PATH=resolve(process.execPath,'..')+':'+(process.env.PATH??'/usr/bin:/bin');
const require=createRequire(toolsRoot+'/package.json');
assert.equal(require(toolsRoot+'/package.json').version,'15.22.0');
assert.equal(require(sdkRoot+'/package.json').version,'7.2.5');
const source=await readFile(adapter,'utf8');
const declaration=source.match(/^async function startFunctionsOnce\([^]*?^\}/m)?.[0];
assert(declaration);
const start=runInNewContext('('+declaration+')');
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
await mkdir(output,{mode:0o700});
await mkdir(output+'/gcloud');
await writeFile(output+'/demo-adc.json',JSON.stringify({type:'authorized_user',client_id:'demo',client_secret:'demo',refresh_token:'demo'}));
for(const key of ['FIREBASE_TOKEN','CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE','NODE_OPTIONS'])delete process.env[key];
const projectId='demo-fireside-discovery-oracle',port=24232;
Object.assign(process.env,{GOOGLE_APPLICATION_CREDENTIALS:output+'/demo-adc.json',CLOUDSDK_CONFIG:output+'/gcloud',GCLOUD_PROJECT:projectId,GOOGLE_CLOUD_PROJECT:projectId});
const functionsDir=output+'/functions';
await mkdir(functionsDir);await mkdir(functionsDir+'/node_modules');
await symlink(sdkRoot,functionsDir+'/node_modules/firebase-functions','dir');
await writeFile(functionsDir+'/package.json',JSON.stringify({name:'discovery-verification',version:'1.0.0',main:'index.js',engines:{node:'24'},dependencies:{'firebase-functions':'7.2.5'}}));
const code=version=>`const {onRequest}=require('firebase-functions/v2/https');\nexports.alpha=onRequest((req,res)=>res.json({version:${version},unicode:'火🔥'}));\n${version===2?"exports.beta=onRequest((req,res)=>res.json({added:true}));":''}\n`;
await writeFile(functionsDir+'/index.js',code(1));
const {FunctionsEmulator}=require(toolsRoot+'/lib/emulator/functionsEmulator.js');
const {EmulatorRegistry}=require(toolsRoot+'/lib/emulator/registry.js');
const {Emulators}=require(toolsRoot+'/lib/emulator/types.js');
const backend={functionsDir,runtime:'nodejs24',codebase:'oracle',env:{},secretEnv:[],ignore:[]};
const emulator=new FunctionsEmulator({projectId,projectDir:output,emulatableBackends:[backend],account:undefined,host:'127.0.0.1',port,adminSdkConfig:{projectId,storageBucket:projectId+'.appspot.com'}});
const original=emulator.discoverTriggers,calls=[];
const spy=async function(value){const definitions=await original.call(this,value);calls.push(definitions.map(d=>d.id).sort());return definitions;};
emulator.discoverTriggers=spy;
const invoke=async name=>{
  const response=await fetch(`http://127.0.0.1:${port}/${projectId}/us-central1/${name}`,{signal:AbortSignal.timeout(15000)});
  assert.equal(response.status,200);return response.json();
};
try{
  const started=performance.now();
  assert.equal(await start(emulator,EmulatorRegistry,[backend]),1);
  const startupMilliseconds=performance.now()-started;
  assert.equal(calls.length,1);assert.equal(emulator.discoverTriggers,spy);
  assert.deepEqual(await invoke('alpha'),{version:1,unicode:'火🔥'});
  await delay(1200);await writeFile(functionsDir+'/index.js',code(2));
  const deadline=performance.now()+30000;
  while(!emulator.getTriggerDefinitions().some(d=>d.id==='us-central1-beta')&&performance.now()<deadline)await delay(100);
  assert(emulator.getTriggerDefinitions().some(d=>d.id==='us-central1-beta'));
  assert.deepEqual(await invoke('beta'),{added:true});
  assert(calls.length>1);assert.equal(emulator.discoverTriggers,spy);
  const result={passed:true,acceptance:false,node:process.version,firebaseTools:'15.22.0',firebaseFunctions:'7.2.5',adapterSha256:sha256(source),driverSha256:sha256(await readFile(new URL(import.meta.url))),startupMilliseconds,startupCalls:1,hotReload:true,calls,credentialsStored:false};
  await writeFile(output+'/result.json',JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result));
}finally{await emulator.stop();EmulatorRegistry.clear(Emulators.FUNCTIONS);}
