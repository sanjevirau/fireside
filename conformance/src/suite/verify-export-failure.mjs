// Constructed, isolated filesystem fault regression; not a live official capture.
// node verify-export-failure.mjs binary tools-root sdk-root emulator-cache fresh-output
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {access,mkdir,readFile,writeFile,symlink} from 'node:fs/promises';
import {createServer,createConnection} from 'node:net';
import {tmpdir} from 'node:os';
import {resolve,dirname,join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

assert.equal(process.argv.length,7,'binary tools-root sdk-root emulator-cache fresh-output');
const [binary,tools,sdk,cache,output]=process.argv.slice(2).map(resolvePath=>resolve(resolvePath));
assert.equal(JSON.parse(await readFile(join(tools,'package.json'))).version,'15.22.0');
assert.equal(JSON.parse(await readFile(join(sdk,'package.json'))).version,'7.2.5');
await mkdir(output,{mode:0o700});
const json=(name,value)=>writeFile(join(output,name),JSON.stringify(value,null,2)+'\n');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const project='demo-export-fault-'+process.pid,bucket=project+'.appspot.com';
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
const args=['suite','--host','127.0.0.1','--project-id',project,'--project-dir',output,'--state-dir',join(output,'working'),'--resume-state','--import',join(output,'seed'),
  '--storage-bucket','default='+bucket,'--firebase-tools-root',tools,'--node',process.execPath,'--java',process.env.JAVA_HOME?join(process.env.JAVA_HOME,'bin/java'):'/usr/bin/java',
  '--storage-rules-jar',join(cache,'cloud-storage-rules-runtime-v1.1.3.jar'),'--ui-archive',join(cache,'ui-v1.15.0.zip')];
for(const [name,port] of Object.entries(ports))args.push('--'+name+'-port',String(port));
await Promise.all(reservations.map(listener=>new Promise(resolve=>listener.close(resolve))));
const exists=path=>access(path).then(()=>true,()=>false);
const listening=port=>new Promise(resolve=>{const socket=createConnection({host:'127.0.0.1',port});const done=value=>{socket.destroy();resolve(value);};socket.setTimeout(1000,()=>done(true));socket.once('connect',()=>done(true));socket.once('error',()=>done(false));});
let active;
const record={passed:false,acceptance:false,syntheticOnly:true,fault:'export parent becomes a regular file after readiness',binarySha256:sha(await readFile(binary)),driverSha256:sha(await readFile(new URL(import.meta.url))),node:process.version,launches:[]};
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
try{
  await launch('failed-export',['--export-on-exit',join(output,'blocked/export')]);
  const write=await fetch(doc,{method:'PATCH',headers:{authorization:'Bearer owner','content-type':'application/json'},body:JSON.stringify({fields:{text:{stringValue:'acknowledged 火🔥'}}}),signal:AbortSignal.timeout(10000)});assert.equal(write.status,200);await write.arrayBuffer();
  await writeFile(join(output,'blocked'),'controlled export-parent fault\n');
  const stopped=await stop();record.failedExportExit=stopped.exit;
  record.exportErrorReported=/failed to create export parent/.test(stopped.log);
  record.functionsDrained=/functions host: stopping/.test(stopped.log);
  record.openPorts=[];for(const [name,port] of Object.entries(ports))if(await listening(port))record.openPorts.push(name);
  record.locatorRemaining=await exists(join(tmpdir(),'hub-'+project+'.json'));
  record.nativeReceiptRetained=await exists(join(output,'working/native-state.json'));
  record.incompleteExportNotPublished=!(await exists(join(output,'blocked/export/firebase-export-metadata.json')));
  await json('result.json',record);
  assert.notEqual(stopped.exit[0],0);assert(record.exportErrorReported);
  assert(record.functionsDrained,'Functions must receive orderly shutdown even when export fails');
  assert.deepEqual(record.openPorts,[]);assert.equal(record.locatorRemaining,false);assert(record.nativeReceiptRetained&&record.incompleteExportNotPublished);
  await launch('native-recovery',['--export-on-exit',join(output,'recovered-export')]);
  const read=await fetch(doc,{headers:{authorization:'Bearer owner'},signal:AbortSignal.timeout(10000)});assert.equal(read.status,200);assert.equal((await read.json()).fields.text.stringValue,'acknowledged 火🔥');
  assert(record.launches.at(-1).resumed);record.acknowledgedWriteRecovered=true;
  const recovered=await stop();assert.equal(recovered.exit[0],0,recovered.log);record.recoveryExit=recovered.exit;
  assert(await exists(join(output,'recovered-export/firebase-export-metadata.json')));record.completedRecoveryExport=true;record.passed=true;
}catch(error){record.error=String(error);throw error;}
finally{if(active)await stop();await json('result.json',record);}
console.log(JSON.stringify({passed:record.passed,output}));
