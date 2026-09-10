// Tiny independent Requests-context oracle. No consumer or production input.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

assert.equal(process.versions.node, '24.20.0');
assert.ok(process.argv[2], 'provide a new output directory');
const output = resolve(process.argv[2]);
const metadataMode = process.argv[3] === '--metadata';
await mkdir(output, {recursive:false});
const work = await mkdtemp(join(tmpdir(), 'fireside-request-values-'));
const jar = join(homedir(), '.cache/firebase/emulators/cloud-firestore-emulator-v1.22.0.jar');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const jarSha256 = hash(await readFile(jar));
assert.equal(jarSha256, '9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c');
const project = 'demo-fireside-request-values';
const rules = `rules_version = '2';
service cloud.firestore {
 match /databases/{database}/documents {
  match /values/{item} {
   allow read, write: if true;
  }
 }
}
`;
const rulesPath = join(work, 'firestore.rules');
await writeFile(rulesPath, rules);
async function port() {
  const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');
  const value=socket.address().port;await new Promise(r=>socket.close(r));return value;
}
const httpPort=await port(), websocketPort=await port();
assert.notEqual(httpPort,websocketPort);
const child=spawn('java',['-jar',jar,'--host','127.0.0.1','--port',String(httpPort),
  '--websocket_port',String(websocketPort),'--project_id',project,'--rules',rulesPath],
  {cwd:work,stdio:['ignore','pipe','pipe']});
const exited=once(child,'exit'), logs=[];
for(const stream of [child.stdout,child.stderr])stream.on('data',b=>logs.push(String(b)));
const record={schemaVersion:1,syntheticOnly:true,capturedAt:new Date().toISOString(),project,rules,
  ...(metadataMode?{profile:'request-metadata'}:{}),
  oracle:{firestore:'1.22.0',jarSha256,node:process.versions.node,
    java:spawnSync('java',['-version'],{encoding:'utf8'}).stderr.trim()},
  operations:[],messages:[]};
const origin=`http://127.0.0.1:${httpPort}`;
const base=`/v1/projects/${project}/databases/(default)/documents`;
let ws;
async function request(id,path,method='GET',body,authorization,expectedStatus=200) {
  const start=record.messages.length;
  const response=await fetch(origin+base+path,{method,
    headers:{'content-type':'application/json',...(authorization?{authorization}:{})},
    ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)});
  const text=await response.text();let data;try{data=JSON.parse(text);}catch{data=text;}
  // Retain every observed evaluation, including the jar's preliminary write checks.
  await delay(250);
  record.operations.push({id,path,method,body:body??null,authenticated:!!authorization,
    status:response.status,response:data,firstMessage:start,endMessage:record.messages.length});
  assert.equal(response.status,expectedStatus,`${id}: ${response.status} ${text}`);
  return data;
}
let failure;
try {
  const deadline=Date.now()+60000;
  while(true){assert.equal(child.exitCode,null,'oracle exited');
    try{const r=await fetch(origin+'/',{signal:AbortSignal.timeout(250)});if(r.status<500)break;}catch{}
    assert.ok(Date.now()<deadline,'readiness deadline');await delay(50);
  }
  ws=new WebSocket(`ws://127.0.0.1:${websocketPort}/requests`);
  ws.addEventListener('message',event=>record.messages.push(JSON.parse(event.data)));
  await Promise.race([once(ws,'open'),delay(5000,undefined,{ref:false}).then(()=>{throw new Error('WebSocket open deadline');})]);
  const firstDeadline=Date.now()+5000;
  while(!record.messages.length){assert.ok(Date.now()<firstDeadline);await delay(10);}
  assert.deepEqual(record.messages,[[]]);
  const fields={nil:{nullValue:null},yes:{booleanValue:true},integer:{integerValue:'9007199254740993'},
    negative:{integerValue:'-7'},double:{doubleValue:1.25},nan:{doubleValue:'NaN'},
    infinity:{doubleValue:'Infinity'},negativeInfinity:{doubleValue:'-Infinity'},
    text:{stringValue:'Synthetic 中文 🚀'},bytes:{bytesValue:'AAEC/w=='},
    timestamp:{timestampValue:'2020-01-02T03:04:05.123456789Z'},
    reference:{referenceValue:`projects/${project}/databases/(default)/documents/values/other`},
    point:{geoPointValue:{latitude:1.25,longitude:-2.5}},
    list:{arrayValue:{values:[{integerValue:'1'},{stringValue:'🚀'},{nullValue:null}]}},
    emptyList:{arrayValue:{values:[]}},emptyMap:{mapValue:{fields:{}}},
    nested:{mapValue:{fields:{active:{booleanValue:false}}}}};
  await request('create-typed','/values/typed','PATCH',{fields});
  await request('get-typed','/values/typed');
  const now=Math.floor(Date.now()/1000);
  const claims={aud:project,iss:`https://securetoken.google.com/${project}`,sub:'synthetic-reader',
    user_id:'synthetic-reader',iat:now-10,exp:now+600,email:'reader@example.invalid',
    email_verified:true,firebase:{sign_in_provider:'custom'},role:'reader'};
  const token=`Bearer ${Buffer.from(JSON.stringify({alg:'none',typ:'JWT'})).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.`;
  // The generated bearer credential is never retained; only synthetic parsed claims are observed.
  await request('get-authenticated','/values/typed','GET',undefined,token);
  await request('query',':runQuery','POST',{structuredQuery:{from:[{collectionId:'values'}],
    orderBy:[{field:{fieldPath:'negative'},direction:'ASCENDING'}],limit:2,offset:0}});
  if(metadataMode){
    await request('query-unbounded',':runQuery','POST',{structuredQuery:{from:[{collectionId:'values'}]}});
    // This rule covers only the root collection, not every descendant group.
    await request('query-group',':runQuery','POST',{structuredQuery:{from:[{collectionId:'values',allDescendants:true}]}},undefined,403);
    await request('query-nested','/parents/p:runQuery','POST',{structuredQuery:{from:[{collectionId:'values'}]}},undefined,403);
    await request('query-nested-group','/parents/p:runQuery','POST',{structuredQuery:{from:[{collectionId:'values',allDescendants:true}]}},undefined,403);
    await request('get-mask','/values/typed?mask.fieldPaths=yes&mask.fieldPaths=text');
    await request('patch-mask','/values/typed?updateMask.fieldPaths=text','PATCH',{fields:{text:{stringValue:'Masked synthetic text'}}});
    await request('patch-quoted-mask','/values/typed?updateMask.fieldPaths=%60a.b%60&updateMask.fieldPaths=nested.active','PATCH',
      {fields:{'a.b':{stringValue:'Quoted field'},nested:{mapValue:{fields:{active:{booleanValue:true}}}}}});
    await request('commit-transform',':commit','POST',{writes:[{
      update:{name:`projects/${project}/databases/(default)/documents/values/typed`,fields:{yes:{booleanValue:true}}},
      updateMask:{fieldPaths:['yes']},updateTransforms:[{fieldPath:'negative',increment:{integerValue:'1'}}]
    }]});
    await request('batch-get-mask',':batchGet','POST',{documents:[`projects/${project}/databases/(default)/documents/values/typed`],mask:{fieldPaths:['yes','text']}});
    const {transaction}=await request('begin-read-transaction',':beginTransaction','POST',{options:{readOnly:{}}});
    assert.equal(typeof transaction,'string');
    await request('transaction-get',':batchGet','POST',{documents:[`projects/${project}/databases/(default)/documents/values/typed`],transaction,mask:{fieldPaths:['yes']}});
    await request('rollback',':rollback','POST',{transaction});
    const writeTransaction=await request('begin-write-transaction',':beginTransaction','POST',{options:{readWrite:{}}});
    await request('write-transaction-get',':batchGet','POST',{documents:[`projects/${project}/databases/(default)/documents/values/typed`],transaction:writeTransaction.transaction});
    await request('write-rollback',':rollback','POST',{transaction:writeTransaction.transaction});
    await request('commit-replacement-transform',':commit','POST',{writes:[{
      update:{name:`projects/${project}/databases/(default)/documents/values/typed`,fields:{yes:{booleanValue:true}}},
      updateTransforms:[{fieldPath:'negative',increment:{integerValue:'1'}}]
    }]});
    await request('commit-empty-mask',':commit','POST',{writes:[{
      update:{name:`projects/${project}/databases/(default)/documents/values/typed`,fields:{}},updateMask:{fieldPaths:[]}
    }]});
  }
  await request('delete','/values/typed','DELETE');
  await request('get-missing','/values/missing','GET',undefined,undefined,404);
} catch(error){failure=error;}
finally {
  if(ws)ws.close();
  if(child.exitCode===null)child.kill('SIGINT');
  record.exit=await Promise.race([exited,delay(20000,undefined,{ref:false}).then(()=>{throw new Error(`owned oracle ${child.pid} shutdown deadline`);})]);
  await writeFile(join(output,'oracle.log'),logs.join(''));
  await writeFile(join(output,'raw.json'),JSON.stringify(record,null,2)+'\n');
}
if(failure)throw failure;
const ids=new Map();
function normalize(value,key=''){
  if(Array.isArray(value))return value.map(v=>normalize(v,key));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,normalize(v,k)]));
  if(key==='requestId'&&typeof value==='string'){if(!ids.has(value))ids.set(value,`request-${ids.size+1}`);return ids.get(value);}
  if(typeof value==='string')return value.replaceAll(work,'<oracle-workdir>')
    .replace(/2026-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g,'<request-time>')
    .replace(/cloud\.firestore-?\d+/g,'cloud.firestore<release-id>');
  return value;
}
const normalized=normalize(record);normalized.capturedAt=record.capturedAt;
normalized.normalization={requestIds:'stable encounter order',time:'2026 request timestamps only; synthetic 2020 field timestamp preserved',
  releases:'opaque release suffix',credentials:'no bearer token retained; synthetic decoded claims only'};
const bytes=JSON.stringify(normalized,null,2)+'\n';
await writeFile(join(output,'fixture.json'),bytes,{flag:'wx'});
await writeFile(join(output,'SHA256SUMS'),hash(bytes)+'  fixture.json\n',{flag:'wx'});
console.log(JSON.stringify({passed:true,output,operations:record.operations.length,messages:record.messages.length}));
