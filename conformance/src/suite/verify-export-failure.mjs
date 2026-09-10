// Constructed, isolated filesystem fault regression; not a live official capture.
// node verify-export-failure.mjs binary tools-root sdk-root emulator-cache fresh-output [isolated-volume [--working-disk]]
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {access,mkdir,readFile,writeFile,symlink,stat,statfs,open,readdir,unlink} from 'node:fs/promises';
import {createServer,createConnection} from 'node:net';
import {tmpdir} from 'node:os';
import {resolve,dirname,join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

const workingDisk=process.argv[8]==='--working-disk';
assert([7,8].includes(process.argv.length)||(process.argv.length===9&&workingDisk),'binary tools-root sdk-root emulator-cache fresh-output [isolated-volume [--working-disk]]');
const [binary,tools,sdk,cache,output,volume]=process.argv.slice(2,8).map(resolvePath=>resolve(resolvePath));
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
const record={passed:false,acceptance:false,syntheticOnly:true,fault:workingDisk?'ENOSPC on native working-data and export filesystem':volume?'ENOSPC on isolated export filesystem':'export parent becomes a regular file after readiness',filesystem,binarySha256:sha(await readFile(binary)),driverSha256:sha(await readFile(new URL(import.meta.url))),node:process.version,launches:[]};
async function launch(name,extra=[]){
  const child=spawn(binary,[...args,...extra],{cwd:output,env,stdio:['pipe','pipe','pipe']});
  const handle={child,name,log:'',finished:once(child,'exit')};active=handle;
  for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{handle.log+=chunk;});
  const start=performance.now();
  while(!handle.log.includes('\nAll emulators ready\n')){assert(child.exitCode===null&&child.signalCode===null,handle.log);assert(performance.now()-start<90000,handle.log);await delay(50);}
  record.launches.push({name,readyMilliseconds:performance.now()-start,resumed:handle.log.includes('resuming validated native state')});
  const ping=await fetch(`http://127.0.0.1:${ports.functions}/${project}/us-central1/ping`,{signal:AbortSignal.timeout(15000)});assert.equal(ping.status,200);await ping.arrayBuffer();
}
async function stop(){
  const handle=active;if(handle.child.exitCode===null&&handle.child.signalCode===null)handle.child.stdin.end('FIRESIDE_SHUTDOWN\n');
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
try{
  await launch('failed-export',['--export-on-exit',join(faultRoot,'export')]);
  const write=await fetch(doc,{method:'PATCH',headers:{authorization:'Bearer owner','content-type':'application/json'},body:JSON.stringify({fields:{text:{stringValue:'acknowledged 火🔥'}}}),signal:AbortSignal.timeout(10000)});assert.equal(write.status,200);await write.arrayBuffer();
  if(workingDisk){
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
  }else await writeFile(faultRoot,'controlled export-parent fault\n');
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
  const stopped=await stop();record.failedExportExit=stopped.exit;
  record.exportErrorReported=volume?/No space left on device|os error 28/i.test(stopped.log):/failed to create export parent/.test(stopped.log);
  record.functionsDrained=/functions host: stopping/.test(stopped.log);
  record.openPorts=[];for(const [name,port] of Object.entries(ports))if(await listening(port))record.openPorts.push(name);
  record.locatorRemaining=await exists(join(tmpdir(),'hub-'+project+'.json'));
  record.nativeReceiptRetained=await exists(join(stateDirectory,'native-state.json'));
  record.incompleteExportNotPublished=!(await exists(join(faultRoot,'export/firebase-export-metadata.json')));
  if(volume)record.partialExportPaths=(await readdir(faultRoot,{recursive:true})).filter(path=>path!=='capacity-fill');
  await json('result.json',record);
  assert.notEqual(stopped.exit[0],0);assert(record.exportErrorReported);
  assert(record.functionsDrained,'Functions must receive orderly shutdown even when export fails');
  assert.deepEqual(record.openPorts,[]);assert.equal(record.locatorRemaining,false);assert(record.nativeReceiptRetained&&record.incompleteExportNotPublished);
  if(workingDisk){await unlink(join(faultRoot,'capacity-fill'));record.onlySyntheticFillerRemoved=true;}
  await launch('native-recovery',['--export-on-exit',join(output,'recovered-export')]);
  const read=await fetch(doc,{headers:{authorization:'Bearer owner'},signal:AbortSignal.timeout(10000)});assert.equal(read.status,200);assert.equal((await read.json()).fields.text.stringValue,'acknowledged 火🔥');
  assert(record.launches.at(-1).resumed);record.acknowledgedWriteRecovered=true;
  if(workingDisk){
    const users=await serviceRequest('auth',authPath+':batchGet',undefined,'GET');assert.equal(users.status,200);
    assert(JSON.parse(users.body).users.some(user=>user.localId==='acknowledged-user'&&user.email==='synthetic@example.test'));
    assert.deepEqual(await serviceRequest('storage',downloadPath('acknowledged'),undefined,'GET'),{status:200,body:'acknowledged object 火🔥'});
    const attempts=[];
    for(const name of ['attempt-left','attempt-right']){
      const found=await serviceRequest('firestore','/v1/'+documentName(name),undefined,'GET');assert([200,404].includes(found.status));
      if(found.status===200)assert.equal(JSON.parse(found.body).fields.payload.stringValue,largeBody);attempts.push(found.status);
    }
    assert.equal(attempts[0],attempts[1],'unacknowledged batch must not recover partially');
    record.unacknowledgedBatchRecoveredStatuses=attempts;
    const blob=await serviceRequest('storage',downloadPath('attempt-object'),undefined,'GET');assert([200,404].includes(blob.status));
    if(blob.status===200)assert.equal(blob.body,largeBody);record.unacknowledgedObjectRecoveredStatus=blob.status;
    record.acknowledgedAuthAndStorageRecovered=true;
    const next=await serviceRequest('firestore','/v1/'+documentName('after-recovery'),{fields:{ok:{booleanValue:true}}},'PATCH');assert.equal(next.status,200);record.writesResumeAfterRecovery=true;
  }
  const recovered=await stop();assert.equal(recovered.exit[0],0,recovered.log);record.recoveryExit=recovered.exit;
  assert(await exists(join(output,'recovered-export/firebase-export-metadata.json')));record.completedRecoveryExport=true;record.passed=true;
}catch(error){record.error=String(error);throw error;}
finally{if(active)await stop();record.ownedSuiteExited=!active;await json('result.json',record);}
console.log(JSON.stringify({passed:record.passed,output}));
