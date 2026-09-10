// Independent oracle capture of REST masks and read consistency selectors.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createV1Firestore} from '../target.ts';
assert.equal(process.version,'v24.20.0');assert.equal(process.argv.length,3);
const output=resolve(process.argv[2]);await mkdir(output,{mode:0o700});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const jar=join(homedir(),'.cache/firebase/emulators/cloud-firestore-emulator-v1.22.0.jar');
const jarSha256=hash(await readFile(jar));assert.equal(jarSha256,'9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c');
const project='demo-fireside-rest-reads',base=`/v1/projects/${project}/databases/(default)/documents`;
const rules="rules_version = '2'; service cloud.firestore { match /databases/{db}/documents/{path=**} { allow read,write: if false; } }\n";
await writeFile(join(output,'firestore.rules'),rules);
const reserve=createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
const child=spawn('java',['-jar',jar,'--host','127.0.0.1','--port',String(port),'--project_id',project,'--rules',join(output,'firestore.rules')],{cwd:output,stdio:['ignore','pipe','pipe']});
const exited=once(child,'exit');let log='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>log+=chunk);
const grpc=createV1Firestore({name:'java',projectId:project,host:`127.0.0.1:${port}`});
const record={schemaVersion:1,syntheticOnly:true,project,rules,capturedAt:new Date().toISOString(),captureSha256:hash(await readFile(new URL(import.meta.url))),
  oracle:{firestore:'1.22.0',jarSha256,node:process.version,java:spawnSync('java',['-version'],{encoding:'utf8'}).stderr.trim()},exchanges:[],grpc:[],passed:false};
async function request(id,path,method='GET',body,owner=true,bindings={}){
  let response;
  try {response=await fetch(`http://127.0.0.1:${port}${base}${path}`,{method,headers:{...(owner?{authorization:'Bearer owner'}:{}),...(body?{'content-type':'application/json'}:{})},
    ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)});}
  catch(error){
    if(error.name!=='TimeoutError'||method!=='GET')throw error;
    record.exchanges.push({id,path,method,body:body??null,owner,bindings,status:null,error:error.name,deadlineMilliseconds:10000});return null;
  }
  const text=await response.text();let data;try{data=JSON.parse(text);}catch{data=text;}
  record.exchanges.push({id,path,method,body:body??null,owner,bindings,status:response.status,response:data});return data;
}
async function grpcGet(id,transaction){
  const input={name:base.slice(4)+'/notes/a',transaction:Buffer.from(transaction,'base64'),mask:{fieldPaths:['title']}};
  try{const [response]=await grpc.getDocument(input,{timeout:5000,otherArgs:{headers:{authorization:'Bearer owner'}}});record.grpc.push({id,status:0,response});}
  catch(error){record.grpc.push({id,status:error.code,details:error.details});}
}
try{
  const deadline=Date.now()+60000;
  while(true){assert.equal(child.exitCode,null);try{const response=await fetch(`http://127.0.0.1:${port}/`,{signal:AbortSignal.timeout(250)});await response.arrayBuffer();if(response.status<500)break;}catch{}assert(Date.now()<deadline);await delay(50);}
  const fields={title:{stringValue:'before 火🔥'},visible:{booleanValue:true},nested:{mapValue:{fields:{one:{integerValue:'1'},two:{integerValue:'2'}}}}};
  const seed=await request('seed','/notes/a','PATCH',{fields});assert.equal(record.exchanges.at(-1).status,200);
  await request('get-mask','/notes/a?mask.fieldPaths=title');
  await request('get-nested-mask','/notes/a?mask.fieldPaths=nested.one');
  await request('get-absent-mask','/notes/a?mask.fieldPaths=absent');
  await request('get-repeated-mask','/notes/a?mask.fieldPaths=title&mask.fieldPaths=visible');
  await request('get-invalid-mask','/notes/a?mask.fieldPaths=a..b');
  await request('get-anonymous','/notes/a?mask.fieldPaths=title','GET',undefined,false);
  const tx=await request('begin-read-only',':beginTransaction','POST',{options:{readOnly:{}}});assert(tx.transaction);
  const selector='transaction='+encodeURIComponent(tx.transaction),binding={transactionFrom:'begin-read-only'};
  await grpcGet('get-in-read-only',tx.transaction);
  await request('get-in-read-only','/notes/a?'+selector,'GET',undefined,true,binding);
  await request('mutate','/notes/a','PATCH',{fields:{...fields,title:{stringValue:'after'}}});
  await grpcGet('get-read-only-after-mutation',tx.transaction);
  await request('get-current','/notes/a');
  await request('get-read-only-after-mutation','/notes/a?'+selector+'&mask.fieldPaths=title','GET',undefined,true,binding);
  await request('get-read-time','/notes/a?readTime='+encodeURIComponent(seed.updateTime),'GET',undefined,true,{readTimeFrom:'seed'});
  await request('get-selector-conflict','/notes/a?'+selector+'&readTime='+encodeURIComponent(seed.updateTime),'GET',undefined,true,{...binding,readTimeFrom:'seed'});
  await request('get-invalid-transaction','/notes/a?transaction=YmFk');
  await request('get-invalid-read-time','/notes/a?readTime=not-a-timestamp');
  const names=[base.slice(4)+'/notes/a',base.slice(4)+'/notes/missing'];
  await request('batch-mask',':batchGet','POST',{documents:names,mask:{fieldPaths:['title']}});
  await request('batch-read-only',':batchGet','POST',{documents:names,transaction:tx.transaction,mask:{fieldPaths:['title']}},true,binding);
  await request('batch-new-read-only',':batchGet','POST',{documents:names,newTransaction:{readOnly:{}},mask:{fieldPaths:['nested.one']}});
  await request('batch-read-time',':batchGet','POST',{documents:names,readTime:seed.updateTime},true,{readTimeFrom:'seed'});
  await request('rollback',':rollback','POST',{transaction:tx.transaction},true,binding);
  await request('get-rolled-back','/notes/a?'+selector,'GET',undefined,true,binding);
  await grpcGet('get-rolled-back',tx.transaction);
  record.passed=true;
}catch(error){record.failure={message:error.message,stack:error.stack};throw error;}
finally{
  await grpc.close();
  if(child.exitCode===null&&child.signalCode===null)child.kill('SIGINT');
  record.exit=await Promise.race([exited,delay(20000,null,{ref:false})]);
  await writeFile(join(output,'oracle.log'),log);await writeFile(join(output,'fixture.json'),JSON.stringify(record,null,2)+'\n');assert(record.exit);
}
console.log(JSON.stringify({output,statuses:record.exchanges.map(({id,status})=>({id,status}))}));
