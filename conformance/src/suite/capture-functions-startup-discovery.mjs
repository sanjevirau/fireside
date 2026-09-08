// Oracle-only capture of firebase-tools 15.22.0 discovery and hot reload.
// Runs a tiny HTTP-only synthetic Functions project, never the a consumer application app.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdir,readFile,writeFile,symlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
const [toolsRoot,sdkRoot,output]=process.argv.slice(2).map(value=>resolve(value));
assert(toolsRoot&&sdkRoot&&output);assert.equal(process.version,'v24.20.0');
await mkdir(output,{mode:0o700});
const require=createRequire(toolsRoot+'/package.json');
assert.equal(require(toolsRoot+'/package.json').version,'15.22.0');
assert.equal(require(sdkRoot+'/package.json').version,'7.2.5');
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const projectId='demo-fireside-discovery-oracle';
await mkdir(output+'/gcloud');
await writeFile(output+'/demo-adc.json',JSON.stringify({type:'authorized_user',client_id:'demo',client_secret:'demo',refresh_token:'demo'}));
for(const key of ['FIREBASE_TOKEN','CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE','JAVA_TOOL_OPTIONS','NODE_OPTIONS'])delete process.env[key];
Object.assign(process.env,{GOOGLE_APPLICATION_CREDENTIALS:output+'/demo-adc.json',CLOUDSDK_CONFIG:output+'/gcloud',
  GCLOUD_PROJECT:projectId,GOOGLE_CLOUD_PROJECT:projectId});
const {FunctionsEmulator}=require(toolsRoot+'/lib/emulator/functionsEmulator.js');
const {EmulatorRegistry}=require(toolsRoot+'/lib/emulator/registry.js');
const {Emulators}=require(toolsRoot+'/lib/emulator/types.js');
const observations=[];
for(const [index,mode] of ['official-connect','prior-adapter-double-discovery'].entries()){
  const directory=output+'/'+mode,functionsDir=directory+'/functions',port=24230+index;
  await mkdir(functionsDir,{recursive:true});await mkdir(functionsDir+'/node_modules');
  await symlink(sdkRoot,functionsDir+'/node_modules/firebase-functions','dir');
  await writeFile(functionsDir+'/package.json',JSON.stringify({name:'discovery-oracle',version:'1.0.0',main:'index.js',engines:{node:'24'},dependencies:{'firebase-functions':'7.2.5'}}));
  const source=version=>`const {onRequest}=require('firebase-functions/v2/https');\nexports.alpha=onRequest((req,res)=>res.json({version:${version},unicode:'火🔥'}));\n${version===2?"exports.beta=onRequest((req,res)=>res.json({added:true}));\n":''}`;
  await writeFile(functionsDir+'/index.js',source(1));
  const backend={functionsDir,runtime:'nodejs24',codebase:'oracle',env:{},secretEnv:[],ignore:[]};
  const emulator=new FunctionsEmulator({projectId,projectDir:directory,emulatableBackends:[backend],account:undefined,
    host:'127.0.0.1',port,adminSdkConfig:{projectId,storageBucket:projectId+'.appspot.com'}});
  const calls=[],original=emulator.discoverTriggers,started=performance.now();
  emulator.discoverTriggers=async function(value){
    const call={codebase:value.codebase,startedMilliseconds:performance.now()-started};calls.push(call);
    try{const definitions=await original.call(this,value);call.ids=definitions.map(d=>d.id).sort();return definitions;}
    catch(error){call.error=String(error);throw error;}
    finally{call.completedMilliseconds=performance.now()-started;}
  };
  try{
    if(mode==='prior-adapter-double-discovery')await emulator.discoverTriggers(backend);
    await EmulatorRegistry.start(emulator);await emulator.connect();
    const startupCalls=calls.length;
    assert.equal(startupCalls,index+1);assert.deepEqual(emulator.getTriggerDefinitions().map(d=>d.id),['us-central1-alpha']);
    const response=await fetch(`http://127.0.0.1:${port}/${projectId}/us-central1/alpha`,{signal:AbortSignal.timeout(15000)});
    assert.equal(response.status,200);const initial=await response.json();assert.deepEqual(initial,{version:1,unicode:'火🔥'});
    // Exercise the SDK's actual source watcher, not a cached/manual rediscovery.
    await delay(1200);await writeFile(functionsDir+'/index.js',source(2));
    const deadline=performance.now()+30000;
    while(!emulator.getTriggerDefinitions().some(d=>d.id==='us-central1-beta')&&performance.now()<deadline)await delay(100);
    assert(emulator.getTriggerDefinitions().some(d=>d.id==='us-central1-beta'));
    const added=await fetch(`http://127.0.0.1:${port}/${projectId}/us-central1/beta`,{signal:AbortSignal.timeout(15000)});
    assert.equal(added.status,200);assert.deepEqual(await added.json(),{added:true});
    observations.push({mode,startupCalls,initial,afterReloadIds:emulator.getTriggerDefinitions().map(d=>d.id).sort(),calls,
      sourceWatcherRediscovered:calls.length>startupCalls});
  }finally{await emulator.stop();EmulatorRegistry.clear(Emulators.FUNCTIONS);}
}
const fixture={schemaVersion:1,target:'official-firebase-tools-functions-emulator',targetVersion:'15.22.0',sdkVersion:'7.2.5',
  capturedAt:new Date().toISOString(),node:process.version,projectId,credentialsStored:false,realUserDataStored:false,
  sourceSha256:sha256(await readFile(toolsRoot+'/lib/emulator/functionsEmulator.js')),
  captureSha256:sha256(await readFile(new URL(import.meta.url))),observations};
await writeFile(output+'/fixture.json',JSON.stringify(fixture,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(fixture));
