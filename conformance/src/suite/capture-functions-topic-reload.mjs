// Actual official Functions watcher + Pub/Sub delivery; only synthetic events.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdir,readFile,writeFile,symlink} from 'node:fs/promises';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {dirname,join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

assert.equal(process.argv.length,5);assert.equal(process.version,'v24.20.0');
const [tools,sdk,output]=process.argv.slice(2).map(value=>resolve(value));
const require=createRequire(join(tools,'package.json'));
assert.equal(require(join(tools,'package.json')).version,'15.22.0');assert.equal(require(join(sdk,'package.json')).version,'7.2.5');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
await mkdir(output,{mode:0o700});await mkdir(join(output,'gcloud'));
await writeFile(join(output,'adc.json'),JSON.stringify({type:'authorized_user',client_id:'demo',client_secret:'demo',refresh_token:'demo'}));
for(const key of ['FIREBASE_TOKEN','CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE','NODE_OPTIONS'])delete process.env[key];
const projectId='demo-fireside-topic-reload';
Object.assign(process.env,{PATH:dirname(process.execPath)+':'+process.env.PATH,GOOGLE_APPLICATION_CREDENTIALS:join(output,'adc.json'),CLOUDSDK_CONFIG:join(output,'gcloud'),GCLOUD_PROJECT:projectId,GOOGLE_CLOUD_PROJECT:projectId});
const ports=[],reservations=[];
for(let i=0;i<2;i++){const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');ports.push(socket.address().port);reservations.push(socket);}
await Promise.all(reservations.map(socket=>new Promise(resolve=>socket.close(resolve))));
const {FunctionsEmulator}=require(join(tools,'lib/emulator/functionsEmulator.js'));
const {PubsubEmulator}=require(join(tools,'lib/emulator/pubsubEmulator.js'));
const downloadable=require(join(tools,'lib/emulator/downloadableEmulators.js'));
const {EmulatorRegistry}=require(join(tools,'lib/emulator/registry.js'));
const {Emulators}=require(join(tools,'lib/emulator/types.js'));
const functionsDir=join(output,'functions');await mkdir(join(functionsDir,'node_modules'),{recursive:true});
await symlink(sdk,join(functionsDir,'node_modules/firebase-functions'),'dir');
await writeFile(join(functionsDir,'package.json'),JSON.stringify({name:'synthetic-topic-reload',main:'index.js',engines:{node:'24'}}));
const source=version=>`const {onMessagePublished}=require('firebase-functions/v2/pubsub');\nconst fs=require('node:fs');\nexports.alpha=onMessagePublished('alpha-topic',event=>fs.appendFileSync(${JSON.stringify(join(output,'events.jsonl'))},JSON.stringify({handler:'alpha',version:${version},id:event.id,data:event.data.message.json})+'\\n'));\n${version===2?`exports.beta=onMessagePublished('beta-topic',event=>fs.appendFileSync(${JSON.stringify(join(output,'events.jsonl'))},JSON.stringify({handler:'beta',version:2,id:event.id,data:event.data.message.json})+'\\n'));\n`:''}`;
await writeFile(join(functionsDir,'index.js'),source(1));
const backend={functionsDir,codebase:'synthetic',runtime:'nodejs24',env:{},secretEnv:[],ignore:[]};
const pubsub=new PubsubEmulator({projectId,host:'127.0.0.1',port:ports[1]});
const functions=new FunctionsEmulator({projectId,projectDir:output,emulatableBackends:[backend],account:undefined,host:'127.0.0.1',port:ports[0],adminSdkConfig:{projectId}});
const record={schemaVersion:1,syntheticOnly:true,target:'official-functions-and-pubsub',firebaseTools:'15.22.0',firebaseFunctions:'7.2.5',node:process.version,projectId,capturedAt:new Date().toISOString(),captureSha256:hash(await readFile(new URL(import.meta.url))),functionsSourceSha256:hash(await readFile(join(tools,'lib/emulator/functionsEmulator.js'))),pubsubSourceSha256:hash(await readFile(join(tools,'lib/emulator/pubsubEmulator.js'))),observations:[],passed:false};
const events=async()=>{try{return(await readFile(join(output,'events.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(error){if(error.code==='ENOENT')return[];throw error;}};
async function publish(stage,topic,expected){
  const data={synthetic:true,stage,unicode:'火🔥'};
  const messageId=await pubsub.pubsub.topic(topic).publishMessage({json:data});
  const deadline=Date.now()+20000;let delivered;
  while(!(delivered=(await events()).find(event=>event.data?.stage===stage))){assert(Date.now()<deadline,`delivery timeout: ${stage}`);await delay(100);}
  assert.deepEqual(delivered.data,data);assert.equal(delivered.handler,expected.handler);assert.equal(delivered.version,expected.version);
  record.observations.push({stage,topic,messageId,delivered,registeredIds:functions.getTriggerDefinitions().map(def=>def.id).sort(),registeredTopics:[...pubsub.triggersForTopic.keys()].sort()});
}
try{
  await EmulatorRegistry.start(pubsub);await EmulatorRegistry.start(functions);await functions.connect();
  await publish('initial','alpha-topic',{handler:'alpha',version:1});
  await delay(1200);await writeFile(join(functionsDir,'index.js'),source(2));
  const deadline=Date.now()+30000;while(!functions.getTriggerDefinitions().some(def=>def.id==='us-central1-beta')){assert(Date.now()<deadline,'source watcher timeout');await delay(100);}
  await publish('added-handler','beta-topic',{handler:'beta',version:2});
  await publish('updated-handler','alpha-topic',{handler:'alpha',version:2});
  record.passed=true;
}catch(error){record.failure={message:error.message};throw error;}
finally{
  await functions.stop();EmulatorRegistry.clear(Emulators.FUNCTIONS);
  for(const sub of pubsub.subscriptionForTopic.values())await sub.close();
  await pubsub.pubsub.close();
  // Use the owned downloadable process stop directly. Do not invoke the
  // wrapper's broad process-name kill fallback on a developer's machine.
  await downloadable.stop(Emulators.PUBSUB);EmulatorRegistry.clear(Emulators.PUBSUB);
  await writeFile(join(output,'fixture.json'),JSON.stringify(record,null,2)+'\n');
}
console.log(JSON.stringify(record));
