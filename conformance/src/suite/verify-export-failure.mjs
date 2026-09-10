// Constructed, isolated filesystem fault regression; not a live official capture.
// node verify-export-failure.mjs binary tools-root sdk-root emulator-cache fresh-output [isolated-volume [--working-disk] | --interrupt-export]
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {watch} from 'node:fs';
import {access,mkdir,readFile,writeFile,symlink,stat,statfs,open,readdir,unlink} from 'node:fs/promises';
import {createServer,createConnection} from 'node:net';
import {tmpdir} from 'node:os';
import {resolve,dirname,join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';

const workingDisk=process.argv[8]==='--working-disk';
const interruptExport=process.argv[7]==='--interrupt-export';
const verifyServices=workingDisk||interruptExport;
assert([7,8].includes(process.argv.length)||(process.argv.length===9&&workingDisk),'binary tools-root sdk-root emulator-cache fresh-output [isolated-volume [--working-disk]]');
assert(!interruptExport||process.platform!=='win32','process-crash diagnostic requires Unix process groups');
const [binary,tools,sdk,cache,output,volume]=process.argv.slice(2,interruptExport?7:8).map(resolvePath=>resolve(resolvePath));
assert.equal(JSON.parse(await readFile(join(tools,'package.json'))).version,'15.22.0');
assert.equal(JSON.parse(await readFile(join(sdk,'package.json'))).version,'7.2.5');
await mkdir(output,{mode:0o700});
const json=(name,value)=>writeFile(join(output,name),JSON.stringify(value,null,2)+'\n');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const project='demo-export-fault-'+process.pid,bucket=project+'.appspot.com';
let faultRoot=join(output,'blocked'),filesystem;
if(volume){
  const fs=await statfs(volume);
  assert.notEqual((await stat(volume)).dev,(await stat(output)).dev,'refuse to fill the host/output filesystem');
  const capacity=fs.blocks*fs.bsize;
  assert(capacity>=4*1024*1024&&capacity<=64*1024*1024,'fault volume must be a separate tiny 4–64 MiB filesystem');
  faultRoot=join(volume,'fireside-export-fault');await mkdir(faultRoot);
  filesystem={type:fs.type,capacityBytes:capacity,availableBeforeBytes:fs.bavail*fs.bsize,separateFromWorkingState:!workingDisk};
}
const stateDirectory=workingDisk?join(faultRoot,'working'):join(output,'working');
await mkdir(join(output,'functions/node_modules'),{recursive:true});
await symlink(sdk,join(output,'functions/node_modules/firebase-functions'),'dir');
await json('functions/package.json',{name:'export-fault-fixture',version:'1.0.0',main:'index.js',engines:{node:'24'}});
await writeFile(join(output,'functions/index.js'),"const {onRequest}=require('firebase-functions/v2/https');exports.ping=onRequest((req,res)=>res.json({synthetic:true}));\n");
await writeFile(join(output,'storage.rules'),"rules_version = '2'; service firebase.storage { match /b/{bucket}/o { match /{path=**} { allow read, write: if true; } } }\n");
await json('firebase.json',{functions:[{source:'functions',codebase:'synthetic'}],storage:[{target:'default',rules:'storage.rules'}]});
await json('.firebaserc',{projects:{default:project},targets:{}});
await mkdir(join(output,'seed'));await json('seed/firebase-export-metadata.json',{version:'15.22.0'});
await mkdir(join(output,'gcloud'));await json('demo-adc.json',{type:'authorized_user',client_id:'demo',client_secret:'demo',refresh_token:'demo'});
const ports={},reservations=[];
for(const name of ['firestore','auth','storage','functions','pubsub','hub','ui','firestore-websocket','logging','eventarc','tasks']){
  const listener=createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');ports[name]=listener.address().port;reservations.push(listener);
}
const env=Object.fromEntries(['HOME','USER','LOGNAME','LANG','TZ','PATH','JAVA_HOME'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
Object.assign(env,{PATH:dirname(process.execPath)+':'+env.PATH,GOOGLE_APPLICATION_CREDENTIALS:join(output,'demo-adc.json'),CLOUDSDK_CONFIG:join(output,'gcloud'),FIRESIDE_CONTROL_STDIN:'1'});
const args=['suite','--host','127.0.0.1','--project-id',project,'--project-dir',output,'--state-dir',stateDirectory,'--resume-state','--import',join(output,'seed'),
  '--storage-bucket','default='+bucket,'--firebase-tools-root',tools,'--node',process.execPath,'--java',process.env.JAVA_HOME?join(process.env.JAVA_HOME,'bin/java'):'/usr/bin/java',
  '--storage-rules-jar',join(cache,'cloud-storage-rules-runtime-v1.1.3.jar'),'--ui-archive',join(cache,'ui-v1.15.0.zip')];
for(const [name,port] of Object.entries(ports))args.push('--'+name+'-port',String(port));
await Promise.all(reservations.map(listener=>new Promise(resolve=>listener.close(resolve))));
const exists=path=>access(path).then(()=>true,()=>false);
const listening=port=>new Promise(resolve=>{const socket=createConnection({host:'127.0.0.1',port});const done=value=>{socket.destroy();resolve(value);};socket.setTimeout(1000,()=>done(true));socket.once('connect',()=>done(true));socket.once('error',()=>done(false));});
let active;
const record={passed:false,acceptance:false,syntheticOnly:true,fault:interruptExport?'owned process-group crash during incomplete export staging':workingDisk?'ENOSPC on native working-data and export filesystem':volume?'ENOSPC on isolated export filesystem':'export parent becomes a regular file after readiness',filesystem,binarySha256:sha(await readFile(binary)),driverSha256:sha(await readFile(new URL(import.meta.url))),node:process.version,launches:[]};
if(interruptExport)record.contractSha256=sha(await readFile(new URL('../../../benchmarks/phase-d-interrupted-export.json',import.meta.url)));
async function launch(name,extra=[]){
  const child=spawn(binary,[...args,...extra],{cwd:output,env,stdio:['pipe','pipe','pipe'],detached:interruptExport});
  const handle={child,name,log:'',finished:once(child,'exit')};active=handle;
  for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{handle.log+=chunk;});
  const start=performance.now();
  while(!handle.log.includes('\nAll emulators ready\n')){assert(child.exitCode===null&&child.signalCode===null,handle.log);assert(performance.now()-start<90000,handle.log);await delay(50);}
  record.launches.push({name,readyMilliseconds:performance.now()-start,resumed:handle.log.includes('resuming validated native state')});
  const ping=await fetch(`http://127.0.0.1:${ports.functions}/${project}/us-central1/ping`,{signal:AbortSignal.timeout(15000)});assert.equal(ping.status,200);await ping.arrayBuffer();
}
async function stop(){
  const handle=active;
  if(handle.stopped){handle.child.kill('SIGCONT');handle.stopped=false;}
  if(handle.child.exitCode===null&&handle.child.signalCode===null)handle.child.stdin.end('FIRESIDE_SHUTDOWN\n');
  const exit=await Promise.race([handle.finished,delay(45000,null,{ref:false})]);
  await writeFile(join(output,handle.name+'.log'),handle.log);assert(exit,'owned suite shutdown deadline; leave live process for diagnosis');active=null;
  return {exit,log:handle.log};
}
const doc=`http://127.0.0.1:${ports.firestore}/v1/projects/${project}/databases/(default)/documents/items/acknowledged`;
const authPath=`/identitytoolkit.googleapis.com/v1/projects/${project}/accounts`;
const largeBody='synthetic'.repeat(8192);
async function serviceRequest(service,path,body,method='POST',raw=false){
  const response=await fetch(`http://127.0.0.1:${ports[service]}${path}`,{method,headers:{authorization:'Bearer owner','content-type':raw?'text/plain':'application/json'},body:body===undefined?undefined:raw?body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
  return {status:response.status,body:await response.text()};
}
const uploadPath=name=>`/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${name}`;
const downloadPath=name=>`/download/storage/v1/b/${bucket}/o/${name}?alt=media`;
const documentName=name=>`projects/${project}/databases/(default)/documents/items/${name}`;
async function inventory(root){
  const files={};for(const name of (await readdir(root,{recursive:true})).sort()){
    const path=join(root,name);if((await stat(path)).isFile())files[name]=sha(await readFile(path));
  }return files;
}
async function crashDuringExport(){
  await mkdir(faultRoot);
  const destination=join(faultRoot,'export');
  const baseline=await serviceRequest('hub','/_admin/export',{path:destination});assert.equal(baseline.status,200,baseline.body);
  record.previousExport=await inventory(destination);
  assert(record.previousExport['firebase-export-metadata.json']);
  for(let start=0;start<4096;start+=128){
    const writes=Array.from({length:128},(_,i)=>({update:{name:`projects/${project}/databases/(default)/documents/interruption-fixture/${start+i}`,fields:{ordinal:{integerValue:String(start+i)},payload:{stringValue:'x'.repeat(2048)}}}}));
    const result=await serviceRequest('firestore',`/v1/projects/${project}/databases/(default)/documents:commit`,{writes});assert.equal(result.status,200,result.body);
  }
  record.acknowledgedAdditionalDocuments=4096;
  const handle=active;let staging;
  const watcher=watch(faultRoot,(_event,name)=>{
    if(!staging&&name?.startsWith('.fireside-export-')&&!name.startsWith('.fireside-export-backup-')){
      staging=join(faultRoot,name);handle.stopped=handle.child.kill('SIGSTOP');
    }
  });
  // Keep the pending request observed even when the injected crash closes it.
  const request=serviceRequest('hub','/_admin/export',{path:destination}).then(result=>result,error=>({error:String(error)}));
  try{
    const deadline=performance.now()+5000;
    while(!handle.stopped){assert(performance.now()<deadline,'export staging checkpoint missed');await delay(5);}
    while(true){
      const {stdout}=await promisify(execFile)('ps',['-o','stat=','-p',String(handle.child.pid)]);
      if(stdout.includes('T'))break;
      assert(performance.now()<deadline,'owned process did not reach stopped state');await delay(5);
    }
    record.interruptedStagingPaths=await readdir(staging,{recursive:true});
    record.incompleteStagingObserved=!(await exists(join(staging,'firebase-export-metadata.json')));
    assert(record.incompleteStagingObserved,'missed incomplete export checkpoint; no crash coverage claimed');
    assert.deepEqual(await inventory(destination),record.previousExport);
    process.kill(-handle.child.pid,'SIGKILL');handle.stopped=false;
    const exit=await Promise.race([handle.finished,delay(45000,null,{ref:false})]);assert.deepEqual(exit,[null,'SIGKILL']);
    await writeFile(join(output,handle.name+'.log'),handle.log);active=null;
    record.crashExit=exit;record.interruptedRequest=await request;
    const closeDeadline=performance.now()+5000;
    while(await Promise.all(Object.values(ports).map(listening)).then(values=>values.some(Boolean))){
      assert(performance.now()<closeDeadline,'owned port remains after injected group crash');await delay(20);
    }
    record.openPortsAfterCrash=[];
    assert.deepEqual(await inventory(destination),record.previousExport);record.previousExportByteIdentical=true;
    return {exit,log:handle.log};
  }finally{watcher.close();}
}
try{
  await launch('failed-export',['--export-on-exit',join(faultRoot,'export')]);
  const write=await fetch(doc,{method:'PATCH',headers:{authorization:'Bearer owner','content-type':'application/json'},body:JSON.stringify({fields:{text:{stringValue:'acknowledged 火🔥'}}}),signal:AbortSignal.timeout(10000)});assert.equal(write.status,200);await write.arrayBuffer();
  if(verifyServices){
    assert.equal((await serviceRequest('auth',authPath,{localId:'acknowledged-user',email:'synthetic@example.test'})).status,200);
    assert.equal((await serviceRequest('storage',uploadPath('acknowledged'),'acknowledged object 火🔥','POST',true)).status,200);
  }
  if(volume){
    const filler=await open(join(faultRoot,'capacity-fill'),'wx');let written=0;
    try{
      // Some filesystems reject a whole large allocation while smaller free
      // extents remain. Reach allocation-block exhaustion, not the first error.
      for(const size of [1024*1024,4096,1]){
        try{
          while(written<=filesystem.capacityBytes){const result=await filler.write(Buffer.alloc(size));assert(result.bytesWritten>0);written+=result.bytesWritten;}
          assert.fail('bounded fill did not produce ENOSPC');
        }catch(error){assert.equal(error.code,'ENOSPC');filesystem.observedWriteError=error.code;}
      }
    }
    finally{await filler.close();}
    const full=await statfs(volume);filesystem.availableAtExportBytes=full.bavail*full.bsize;filesystem.fillerBytes=(await stat(join(faultRoot,'capacity-fill'))).size;
    assert.equal(filesystem.availableAtExportBytes,0,'tiny export filesystem must actually have no available space');
  }else if(!interruptExport)await writeFile(faultRoot,'controlled export-parent fault\n');
  if(workingDisk){
    const batch={writes:['attempt-left','attempt-right'].map(name=>({update:{name:documentName(name),fields:{payload:{stringValue:largeBody}}}}))};
    record.fullDiskRequests={};
    record.fullDiskRequests.firestore=await serviceRequest('firestore',`/v1/projects/${project}/databases/(default)/documents:commit`,batch);
    record.fullDiskRequests.auth=await serviceRequest('auth',authPath,{localId:'attempt-user',email:'attempt@example.test',displayName:'Synthetic attempted account'});
    record.fullDiskRequests.storage=await serviceRequest('storage',uploadPath('attempt-object'),largeBody,'POST',true);
    for(const result of Object.values(record.fullDiskRequests)){
      assert(result.status>=400&&result.status<600,JSON.stringify(result));
      assert.match(result.body,/No space left on device|os error 28/i);
    }
    record.writeFence=await serviceRequest('firestore',`/v1/projects/${project}/databases/(default)/documents:commit`,batch);
    assert.equal(record.writeFence.status,503);assert.match(record.writeFence.body,/reopen the store to recover before writing/);
  }
  const stopped=interruptExport?await crashDuringExport():await stop();record.failedExportExit=stopped.exit;
  record.exportErrorReported=volume?/No space left on device|os error 28/i.test(stopped.log):/failed to create export parent/.test(stopped.log);
  record.functionsDrained=/functions host: stopping/.test(stopped.log);
  record.openPorts=[];for(const [name,port] of Object.entries(ports))if(await listening(port))record.openPorts.push(name);
  record.locatorRemaining=await exists(join(tmpdir(),'hub-'+project+'.json'));
  record.nativeReceiptRetained=await exists(join(stateDirectory,'native-state.json'));
  record.incompleteExportNotPublished=interruptExport?record.previousExportByteIdentical:!(await exists(join(faultRoot,'export/firebase-export-metadata.json')));
  if(volume)record.partialExportPaths=(await readdir(faultRoot,{recursive:true})).filter(path=>path!=='capacity-fill');
  await json('result.json',record);
  assert.notEqual(stopped.exit[0],0);
  if(!interruptExport){
    assert(record.exportErrorReported);assert(record.functionsDrained,'Functions must receive orderly shutdown even when export fails');
    assert.equal(record.locatorRemaining,false);
  }
  assert.deepEqual(record.openPorts,[]);assert(record.nativeReceiptRetained&&record.incompleteExportNotPublished);
  if(workingDisk){await unlink(join(faultRoot,'capacity-fill'));record.onlySyntheticFillerRemoved=true;}
  await launch('native-recovery',['--export-on-exit',join(output,'recovered-export')]);
  const read=await fetch(doc,{headers:{authorization:'Bearer owner'},signal:AbortSignal.timeout(10000)});assert.equal(read.status,200);assert.equal((await read.json()).fields.text.stringValue,'acknowledged 火🔥');
  assert(record.launches.at(-1).resumed);record.acknowledgedWriteRecovered=true;
  if(verifyServices){
    const users=await serviceRequest('auth',authPath+':batchGet',undefined,'GET');assert.equal(users.status,200);
    assert(JSON.parse(users.body).users.some(user=>user.localId==='acknowledged-user'&&user.email==='synthetic@example.test'));
    assert.deepEqual(await serviceRequest('storage',downloadPath('acknowledged'),undefined,'GET'),{status:200,body:'acknowledged object 火🔥'});
    if(workingDisk){
    const attempts=[];
    for(const name of ['attempt-left','attempt-right']){
      const found=await serviceRequest('firestore','/v1/'+documentName(name),undefined,'GET');assert([200,404].includes(found.status));
      if(found.status===200)assert.equal(JSON.parse(found.body).fields.payload.stringValue,largeBody);attempts.push(found.status);
    }
    assert.equal(attempts[0],attempts[1],'unacknowledged batch must not recover partially');
    record.unacknowledgedBatchRecoveredStatuses=attempts;
    const blob=await serviceRequest('storage',downloadPath('attempt-object'),undefined,'GET');assert([200,404].includes(blob.status));
    if(blob.status===200)assert.equal(blob.body,largeBody);record.unacknowledgedObjectRecoveredStatus=blob.status;
    }
    if(interruptExport){
      const result=await serviceRequest('firestore',`/v1/projects/${project}/databases/(default)/documents:runQuery`,{structuredQuery:{from:[{collectionId:'interruption-fixture'}]}});
      assert.equal(result.status,200,result.body);const documents=JSON.parse(result.body).filter(row=>row.document).map(row=>row.document);
      assert.equal(documents.length,4096);const ordinals=new Set();
      for(const document of documents){assert.equal(document.fields.payload.stringValue,'x'.repeat(2048));ordinals.add(Number(document.fields.ordinal.integerValue));}
      assert.equal(ordinals.size,4096);for(let i=0;i<4096;i++)assert(ordinals.has(i));
      record.allAdditionalAcknowledgedDocumentsRecovered=true;
    }
    record.acknowledgedAuthAndStorageRecovered=true;
    const next=await serviceRequest('firestore','/v1/'+documentName('after-recovery'),{fields:{ok:{booleanValue:true}}},'PATCH');assert.equal(next.status,200);record.writesResumeAfterRecovery=true;
  }
  const recovered=await stop();assert.equal(recovered.exit[0],0,recovered.log);record.recoveryExit=recovered.exit;
  if(interruptExport){
    assert.equal(await exists(join(tmpdir(),'hub-'+project+'.json')),false);
    for(const port of Object.values(ports))assert.equal(await listening(port),false);
    record.recoveryLocatorRemoved=true;record.recoveryPortsClosed=true;
  }
  assert(await exists(join(output,'recovered-export/firebase-export-metadata.json')));record.completedRecoveryExport=true;record.passed=true;
}catch(error){record.error=String(error);throw error;}
finally{if(active)await stop();record.ownedSuiteExited=!active;await json('result.json',record);}
console.log(JSON.stringify({passed:record.passed,output}));
