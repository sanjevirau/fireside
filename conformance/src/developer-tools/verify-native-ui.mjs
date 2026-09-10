// Short, independent suite/UI verification using the committed official UI observations.
// node verify-native-ui.mjs binary firebase-tools-root firebase-functions-root emulator-cache output
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {mkdir,readFile,writeFile,symlink} from 'node:fs/promises';
import {createServer} from 'node:net';
import {resolve,dirname,join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {observeDeveloperUi} from './observe-ui.mjs';

const topicReload=process.argv[7]==='--topic-reload';
assert(process.argv.length===7||(process.argv.length===8&&topicReload),'binary toolsRoot sdkRoot emulator-cache fresh-output [--topic-reload]');
assert.equal(process.versions.node,'24.20.0');
const [binary,tools,sdk,cache,output]=process.argv.slice(2,7).map(path=>resolve(path));
assert.equal(JSON.parse(await readFile(join(tools,'package.json'))).version,'15.22.0');
assert.equal(JSON.parse(await readFile(join(sdk,'package.json'))).version,'7.2.5');
const fixture=JSON.parse(await readFile(new URL('../../fixtures/developer-tools-v1/fixture.json',import.meta.url)));
const project='demo-fireside-developer-tools';
const rules=fixture.rules;
assert.equal(typeof rules,'string');
await mkdir(output,{mode:0o700});
const json=(name,value)=>writeFile(join(output,name),JSON.stringify(value,null,2)+'\n');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const assets={};
for(const [name,expected] of [
  ['ui-v1.15.0.zip','97d8c4c574e3f20c4d690a2ce8373eef76ab024da73279a062dba8517f88cf9a'],
  ['cloud-storage-rules-runtime-v1.1.3.jar','0cd52db6f6271d62078f805220706377c849220b73bd68aa27078d977df9c900'],
]){assets[name]=hash(await readFile(join(cache,name)));assert.equal(assets[name],expected);}
await mkdir(join(output,'functions/node_modules'),{recursive:true});
await symlink(sdk,join(output,'functions/node_modules/firebase-functions'),'dir');
await json('functions/package.json',{name:'developer-tools-fixture',version:'1.0.0',main:'index.js',engines:{node:'24'}});
const pingSource="const {onRequest}=require('firebase-functions/v2/https');exports.ping=onRequest((req,res)=>res.json({synthetic:true}));\n";
const topicSource=version=>pingSource+`const {onMessagePublished}=require('firebase-functions/v2/pubsub');const fs=require('node:fs');\nexports.alpha=onMessagePublished('alpha-topic',event=>fs.appendFileSync(${JSON.stringify(join(output,'events.jsonl'))},JSON.stringify({handler:'alpha',version:${version},data:event.data.message.json})+'\\n'));\n${version===2?`exports.beta=onMessagePublished('beta-topic',event=>fs.appendFileSync(${JSON.stringify(join(output,'events.jsonl'))},JSON.stringify({handler:'beta',version:2,data:event.data.message.json})+'\\n'));\n`:''}`;
await writeFile(join(output,'functions/index.js'),topicReload?topicSource(1):pingSource);
await writeFile(join(output,'firestore.rules'),rules);
await writeFile(join(output,'storage.rules'),"rules_version = '2'; service firebase.storage { match /b/{bucket}/o { match /{object=**} { allow read, write: if true; } } }\n");
await json('firebase.json',{firestore:{rules:'firestore.rules'},storage:[{target:'default',rules:'storage.rules'}],functions:[{source:'functions',codebase:'synthetic'}]});
await json('.firebaserc',{projects:{default:project},targets:{}});
await mkdir(join(output,'gcloud'));
await json('demo-adc.json',{type:'authorized_user',client_id:'demo',client_secret:'demo',refresh_token:'demo'});
const reservations=[],ports={};
for(const service of ['firestore','auth','storage','functions','pubsub','hub','ui','firestore-websocket','logging','eventarc','tasks']){
  const listener=createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');
  ports[service]=listener.address().port;reservations.push(listener);
}
const env=Object.fromEntries(['HOME','USER','LOGNAME','LANG','TZ','PATH','JAVA_HOME'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
Object.assign(env,{PATH:dirname(process.execPath)+':'+env.PATH,GOOGLE_APPLICATION_CREDENTIALS:join(output,'demo-adc.json'),CLOUDSDK_CONFIG:join(output,'gcloud'),GCLOUD_PROJECT:project,GOOGLE_CLOUD_PROJECT:project,FIRESIDE_CONTROL_STDIN:'1'});
const args=['suite','--host','127.0.0.1','--project-id',project,'--project-dir',output,'--state-dir',join(output,'state'),
  '--storage-bucket','default='+project+'.appspot.com','--firebase-tools-root',tools,'--node',process.execPath,
  '--java',process.env.JAVA_HOME?join(process.env.JAVA_HOME,'bin/java'):'/usr/bin/java',
  '--storage-rules-jar',join(cache,'cloud-storage-rules-runtime-v1.1.3.jar'),'--ui-archive',join(cache,'ui-v1.15.0.zip')];
for(const [service,port] of Object.entries(ports))args.push('--'+service+'-port',String(port));
await Promise.all(reservations.map(listener=>new Promise(resolve=>listener.close(resolve))));
const child=spawn(binary,args,{cwd:output,env,stdio:['pipe','pipe','pipe']});
const exited=once(child,'exit');let log='';
for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{log+=chunk;});
const origin=service=>`http://127.0.0.1:${ports[service]}`;
const record={passed:false,acceptance:false,syntheticOnly:true,node:process.version,assets,
  binarySha256:hash(await readFile(binary)),driverSha256:hash(await readFile(new URL(import.meta.url))),
  oracleFixtureSha256:hash(await readFile(new URL('../../fixtures/developer-tools-v1/fixture.json',import.meta.url))),
  firebaseTools:'15.22.0',firebaseFunctions:'7.2.5'};
let requests;
try{
  const started=performance.now();
  while(!log.includes('\nAll emulators ready\n')){
    assert.equal(child.exitCode,null,log);assert(performance.now()-started<90000,log);await delay(50);
  }
  record.readyMilliseconds=performance.now()-started;
  const config=await (await fetch(origin('ui')+'/api/config')).json();
  record.config=config;
  assert.equal(config.firestore.webSocketPort,ports['firestore-websocket']);
  const frames=[];requests=new WebSocket(`ws://127.0.0.1:${ports['firestore-websocket']}/requests`);
  requests.addEventListener('message',event=>frames.push(JSON.parse(event.data)));
  await once(requests,'open');
  const write=async(id,visible,admin=false)=>{
    const response=await fetch(`${origin('firestore')}/v1/projects/${project}/databases/(default)/documents/notes/${id}`,{
      method:'PATCH',headers:{'content-type':'application/json',...(admin?{authorization:'Bearer owner'}:{})},
      body:JSON.stringify({fields:{visible:{booleanValue:visible},title:{stringValue:'Synthetic 中文 🚀'}}}),signal:AbortSignal.timeout(10000)});
    await response.arrayBuffer();assert.equal(response.status,id==='denied'?403:200);
  };
  await write('visible',true);await write('denied',false);await write('hidden',false,true);
  const deadline=Date.now()+5000;
  while(!frames.some(frame=>frame.outcome==='deny')){assert(Date.now()<deadline,'denied evaluation must reach Requests');await delay(20);}
  const denied=frames.find(frame=>frame.outcome==='deny');
  requests.close();await once(requests,'close');requests=null;
  record.browser=await observeDeveloperUi({origin,project,work:output,output,requestId:denied.requestId,readyLog:'All emulators ready;'});
  const ping=await fetch(`${origin('functions')}/${project}/us-central1/ping`,{signal:AbortSignal.timeout(15000)});
  assert.equal(ping.status,200);assert.deepEqual(await ping.json(),{synthetic:true});
  if(topicReload){
    const observations=[];
    const publish=async(stage,topic,handler,version)=>{
      const data={synthetic:true,stage,unicode:'火🔥'};
      const response=await fetch(`${origin('pubsub')}/v1/projects/${project}/topics/${topic}:publish`,{
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messages:[{data:Buffer.from(JSON.stringify(data)).toString('base64')}]}),signal:AbortSignal.timeout(5000)});
      const body=await response.json();observations.push({stage,status:response.status,response:body});
      record.topicReload=observations;assert.equal(response.status,200,JSON.stringify(observations));
      const deadline=Date.now()+20000;let delivered;
      while(!delivered){
        let events=[];try{events=(await readFile(join(output,'events.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(error){if(error.code!=='ENOENT')throw error;}
        delivered=events.find(event=>event.data?.stage===stage);assert(Date.now()<deadline,`topic delivery ${stage}`);if(!delivered)await delay(100);
      }
      assert.deepEqual(delivered,{handler,version,data});observations.at(-1).delivered=delivered;
    };
    await publish('initial','alpha-topic','alpha',1);
    await delay(1200);await writeFile(join(output,'functions/index.js'),topicSource(2));
    const deadline=Date.now()+30000;
    while(true){
      const response=await fetch(origin('functions')+'/backends',{signal:AbortSignal.timeout(5000)});const backends=await response.json();
      if(backends.backends?.some(backend=>backend.functionTriggers?.some(def=>def.id==='us-central1-beta')))break;
      assert(Date.now()<deadline,'native Functions watcher inventory timeout');await delay(100);
    }
    await publish('added-handler','beta-topic','beta',2);
    await publish('updated-handler','alpha-topic','alpha',2);
  }
  record.functionsPing=true;record.browserAndFunctionPassed=true;
}catch(error){await json('failure.json',{message:error.message,stack:error.stack});throw error;}
finally{
  requests?.close();
  if(child.exitCode===null&&child.signalCode===null)child.stdin.end('FIRESIDE_SHUTDOWN\n');
  const result=await Promise.race([exited,delay(20000,null,{ref:false})]);
  await writeFile(join(output,'suite.log'),log);
  record.passed=record.browserAndFunctionPassed===true&&result?.[0]===0;
  await json('result.json',{...record,shutdown:result});
  assert(result,'owned suite shutdown deadline; preserve live child for diagnosis');
  assert.equal(result[0],0,log);
}
console.log(JSON.stringify({passed:true,output,checks:record.browser.checks}));
