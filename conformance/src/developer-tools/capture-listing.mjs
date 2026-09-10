// Independent official Firestore REST listing contract used by the pinned UI.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
assert.equal(process.versions.node,'24.20.0');assert(process.argv[2]);
const output=resolve(process.argv[2]);await mkdir(output);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const jar=join(homedir(),'.cache/firebase/emulators/cloud-firestore-emulator-v1.22.0.jar');
const jarSha256=hash(await readFile(jar));assert.equal(jarSha256,'9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c');
const project='demo-fireside-listing';
const rules="rules_version = '2'; service cloud.firestore { match /databases/{db}/documents/{path=**} { allow read, write: if false; } }\n";
await writeFile(join(output,'firestore.rules'),rules);
const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
const child=spawn('java',['-jar',jar,'--host','127.0.0.1','--port',String(port),'--project_id',project,'--rules',join(output,'firestore.rules')],{cwd:output,stdio:['ignore','pipe','pipe']});
const exited=once(child,'exit');let log='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>log+=chunk);
const base=`/v1/projects/${project}/databases/(default)/documents`;
const record={schemaVersion:1,syntheticOnly:true,capturedAt:new Date().toISOString(),project,rules,oracle:{firestore:'1.22.0',jarSha256,node:process.versions.node,java:spawnSync('java',['-version'],{encoding:'utf8'}).stderr.trim()},exchanges:[]};
async function request(id,path,method='GET',body,owner=true,previousToken,allowTimeout=false){
  const headers={...(owner?{authorization:'Bearer owner'}:{}),...(body?{'content-type':'application/json'}:{})};
  let response;
  try{response=await fetch(`http://127.0.0.1:${port}${base}${path}`,{method,headers,...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)});}
  catch(error){if(!allowTimeout||error.name!=='TimeoutError')throw error;record.exchanges.push({id,path,method,body:body??null,owner,status:null,deadlineMilliseconds:10000,error:error.name});return null;}
  const text=await response.text();let data;try{data=JSON.parse(text);}catch{data=text;}
  const row={id,path,method,body:body??null,owner,previousToken:previousToken??null,status:response.status,response:data};record.exchanges.push(row);return data;
}
try{
  const deadline=Date.now()+60000;
  while(true){assert.equal(child.exitCode,null);try{const r=await fetch(`http://127.0.0.1:${port}/`,{signal:AbortSignal.timeout(250)});if(r.status<500)break;}catch{}assert(Date.now()<deadline);await delay(50);}
  for(const [path,title] of [['notes/a','Alpha'],['notes/b','Beta'],['notes/missing/children/one','Nested'],['other/z','Other']]){
    await request('seed-'+path,'/'+path,'PATCH',{fields:{title:{stringValue:title},visible:{booleanValue:true}}});assert.equal(record.exchanges.at(-1).status,200);
  }
  await request('root-ids-empty-body',':listCollectionIds','POST');
  await request('nested-ids-empty-body','/notes/missing:listCollectionIds','POST');
  await request('ids-anonymous',':listCollectionIds','POST',undefined,false);
  await request('list-default','/notes');
  await request('list-show-missing','/notes?showMissing=true');
  await request('list-desc','/notes?orderBy=title%20desc');
  await request('list-mask','/notes?mask.fieldPaths=title');
  await request('list-empty-mask','/notes?mask.fieldPaths=absent');
  await request('list-anonymous','/notes','GET',undefined,false);
  await request('list-empty','/empty');
  await request('list-conflicting-order','/notes?showMissing=true&orderBy=title');
  await request('list-invalid-size','/notes?pageSize=invalid','GET',undefined,true,undefined,true);
  const page=await request('list-page-1','/notes?pageSize=1');
  assert(page.nextPageToken);
  const lastPage=await request('list-page-2','/notes?pageSize=1&pageToken='+encodeURIComponent(page.nextPageToken),'GET',undefined,true,'list-page-1');
  assert(lastPage.nextPageToken);
  await request('list-page-3','/notes?pageSize=1&pageToken='+encodeURIComponent(lastPage.nextPageToken),'GET',undefined,true,'list-page-2');
  const ids=await request('ids-page-1',':listCollectionIds','POST',{pageSize:1});assert(ids.nextPageToken);
  const lastIds=await request('ids-page-2',':listCollectionIds','POST',{pageSize:1,pageToken:ids.nextPageToken},true,'ids-page-1');
  if(lastIds.nextPageToken)await request('ids-page-3',':listCollectionIds','POST',{pageSize:1,pageToken:lastIds.nextPageToken},true,'ids-page-2');
}finally{
  if(child.exitCode===null)child.kill('SIGINT');
  record.exit=await Promise.race([exited,delay(20000,null,{ref:false})]);await writeFile(join(output,'oracle.log'),log);await writeFile(join(output,'raw.json'),JSON.stringify(record,null,2)+'\n');assert(record.exit);
}
const bytes=JSON.stringify(record,null,2)+'\n';await writeFile(join(output,'fixture.json'),bytes,{flag:'wx'});await writeFile(join(output,'SHA256SUMS'),hash(bytes)+'  fixture.json\n',{flag:'wx'});
console.log(JSON.stringify({passed:true,output,statuses:record.exchanges.map(({id,status})=>({id,status}))}));
