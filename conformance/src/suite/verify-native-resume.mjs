// Short, isolated synthetic native-state lifecycle regression.
// Usage: node verify-native-resume.mjs binary dependency-root emulator-cache output
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {createServer as tcpServer} from 'node:net';
import {mkdir,readFile,writeFile,symlink} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {build} from 'esbuild';
import {chromium} from 'playwright';

assert.equal(process.argv.length,6,'binary dependency-root emulator-cache output');
const [binary,dependencies,cache,output]=process.argv.slice(2).map(value=>resolve(value));
const project='demo-native-resume',bucket=project+'.appspot.com';
await mkdir(output,{mode:0o700});
const json=async(name,value)=>writeFile(output+'/'+name,JSON.stringify(value,null,2)+'\n');
const sha=value=>createHash('sha256').update(value).digest('hex');
assert.equal(JSON.parse(await readFile(dependencies+'/node_modules/firebase-tools/package.json','utf8')).version,'15.22.0');
const reservations=[]; const ports={};
for(const service of ['firestore','auth','storage','functions','pubsub','hub','ui','firestore-websocket','logging','eventarc','tasks']){
  const server=tcpServer(); await new Promise((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
  ports[service]=server.address().port; reservations.push(server);
}
await mkdir(output+'/functions'); await mkdir(output+'/functions/node_modules');
await mkdir(output+'/gcloud');
await symlink(dependencies+'/node_modules/firebase-functions',output+'/functions/node_modules/firebase-functions','dir');
await json('functions/package.json',{name:'native-state-fixture',version:'1.0.0',main:'index.js',engines:{node:'24'}});
await writeFile(output+'/functions/index.js',"const {onRequest}=require('firebase-functions/v2/https');exports.ping=onRequest((req,res)=>res.json({ok:true}));\n");
await json('firebase.json',{functions:[{source:'functions',codebase:'native-fixture'}],storage:[{target:'default',rules:'storage.rules'}],emulators:{}});
await json('.firebaserc',{projects:{default:project},targets:{}});
await writeFile(output+'/storage.rules',"rules_version = '2'; service firebase.storage { match /b/{bucket}/o { match /{path=**} { allow read, write: if true; } } }\n");
await json('demo-adc.json',{type:'authorized_user',client_id:'demo',client_secret:'demo',refresh_token:'demo'});
const env=Object.fromEntries(['HOME','USER','LOGNAME','LANG','TZ','PATH','JAVA_HOME'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
Object.assign(env,{PATH:dirname(process.execPath)+':'+env.PATH,GOOGLE_APPLICATION_CREDENTIALS:output+'/demo-adc.json',CLOUDSDK_CONFIG:output+'/gcloud',GCLOUD_PROJECT:project,GOOGLE_CLOUD_PROJECT:project});
const shared=['suite','--host','127.0.0.1','--project-dir',output,'--project-id',project,
  '--storage-bucket','default='+bucket,'--firebase-tools-root',dependencies+'/node_modules/firebase-tools',
  '--node',process.execPath,'--java',process.env.JAVA_HOME?process.env.JAVA_HOME+'/bin/java':'/usr/bin/java',
  '--storage-rules-jar',cache+'/cloud-storage-rules-runtime-v1.1.3.jar','--ui-archive',cache+'/ui-v1.15.0.zip'];
for(const [service,port] of Object.entries(ports))shared.push('--'+service+'-port',String(port));
for(const server of reservations)await new Promise(resolve=>server.close(resolve));
let active=null,browser=null,web=null;const launches=[],pageErrors=[];
const request=async(service,path,method='GET',body)=>{
  const response=await fetch(`http://127.0.0.1:${ports[service]}${path}`,{method,headers:{authorization:'Bearer owner','content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
  assert.equal(response.status,200,`${service} ${method} ${path}: ${await response.clone().text()}`);return response.json();
};
const docPath=collection=>`/v1/projects/${project}/databases/(default)/documents/${collection}/unicode`;
const put=async value=>{for(const collection of ['items','other'])await request('firestore',docPath(collection),'PATCH',{fields:{value:{integerValue:String(value)},text:{stringValue:'火🔥 café'}}});};
async function launch(name,extra){
  const started=performance.now();
  const child=spawn(binary,[...shared,...extra],{cwd:output,env,stdio:['ignore','pipe','pipe']});
  const handle={child,name,log:'',done:false};active=handle;
  handle.finished=new Promise((yes,no)=>{child.once('error',no);child.once('exit',(code,signal)=>{handle.done=true;yes({code,signal});});});
  for(const stream of ['stdout','stderr'])child[stream].on('data',data=>{handle.log+=data.toString();});
  while(!handle.log.includes('\nAll emulators ready\n')){
    assert(!handle.done,handle.log);assert(performance.now()-started<90000,'native suite startup deadline');await delay(100);
  }
  launches.push({name,readyMilliseconds:performance.now()-started,imported:handle.log.includes('imported 2 Firestore'),resumed:handle.log.includes('resuming validated native state')});
}
async function stop(){
  if(!active)return;
  const handle=active;
  if(!handle.done)handle.child.kill('SIGTERM');
  const exit=await Promise.race([handle.finished,delay(30000,undefined,{ref:false}).then(()=>{throw Error('owned suite shutdown deadline');})]);
  await writeFile(output+'/'+handle.name+'.log',handle.log);
  await json(handle.name+'-exit.json',exit);active=null;
  assert.equal(exit.code,0,handle.log);
}
const blobName='native/火🔥.txt',blobText='saved working object 火🔥';
try{
  await launch('seed-builder',['--state-dir',output+'/seed-builder-state','--export-on-exit',output+'/seed']);
  await put(0);await stop();
  const args=['--state-dir',output+'/working','--resume-state','--import',output+'/seed','--export-on-exit',output+'/export'];
  await launch('first-import',args);
  const {outputFiles}=await build({stdin:{contents:`
    import {initializeApp} from 'firebase/app';
    import {initializeFirestore,connectFirestoreEmulator,collection,onSnapshot} from 'firebase/firestore';
    window.seen=[];window.listenerErrors=[];
    for(const mode of ['long-poll','stream']){
      const app=initializeApp({projectId:${JSON.stringify(project)},apiKey:'demo'},mode);
      const db=initializeFirestore(app,{experimentalForceLongPolling:mode==='long-poll',experimentalAutoDetectLongPolling:false});
      connectFirestoreEmulator(db,'127.0.0.1',${ports.firestore});
      for(const target of ['items','other'])onSnapshot(collection(db,target),{includeMetadataChanges:true},snap=>{
        window.seen.push({mode,target,cache:snap.metadata.fromCache,values:snap.docs.map(doc=>doc.data().value)});
      },error=>window.listenerErrors.push(String(error)));
    }`,resolveDir:dependencies},bundle:true,format:'iife',write:false,alias:{firebase:dependencies+'/node_modules/firebase'}});
  web=createServer((req,res)=>{res.setHeader('content-type','text/html');res.end('<script>'+outputFiles[0].text+'</script>');});
  await new Promise(resolve=>web.listen(0,'127.0.0.1',resolve));
  browser=await chromium.launch({headless:true}); const page=await browser.newPage();
  page.on('pageerror',error=>pageErrors.push(String(error)));
  await page.goto('http://127.0.0.1:'+web.address().port);
  const observed=async value=>page.waitForFunction(value=>['long-poll','stream'].every(mode=>['items','other'].every(target=>window.seen.some(event=>event.mode===mode&&event.target===target&&!event.cache&&event.values.includes(value)))),value,{timeout:45000});
  await observed(0);await put(1);await observed(1);
  await request('auth',`/identitytoolkit.googleapis.com/v1/projects/${project}/accounts`,'POST',{localId:'native-synthetic-user',email:'native@example.test'});
  const upload=await fetch(`http://127.0.0.1:${ports.storage}/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(blobName)}`,{method:'POST',headers:{authorization:'Bearer owner','content-type':'text/plain'},body:blobText,signal:AbortSignal.timeout(10000)});
  assert.equal(upload.status,200);
  await stop();
  await launch('native-reopen',args);
  for(const collection of ['items','other'])assert.equal((await request('firestore',docPath(collection))).fields.value.integerValue,'1');
  assert.equal((await request('auth',`/identitytoolkit.googleapis.com/v1/projects/${project}/accounts:batchGet`)).users.length,1);
  const download=await fetch(`http://127.0.0.1:${ports.storage}/download/storage/v1/b/${bucket}/o/${encodeURIComponent(blobName)}?alt=media`,{headers:{authorization:'Bearer owner'},signal:AbortSignal.timeout(10000)});
  assert.equal(download.status,200);assert.equal(await download.text(),blobText);
  await put(2);await observed(2);
  assert.equal(launches[1].imported,true);assert.equal(launches[2].imported,false);assert.equal(launches[2].resumed,true);
  const events=await page.evaluate(()=>({seen:window.seen,listenerErrors:window.listenerErrors}));
  assert.deepEqual(events.listenerErrors,[]);assert.deepEqual(pageErrors,[]);
  await browser.close();browser=null;await stop();
  await json('result.json',{passed:true,acceptance:false,binarySha256:sha(await readFile(binary)),driverSha256:sha(await readFile(new URL(import.meta.url))),node:process.version,launches,authUsersAfterReopen:1,storageBytesExact:true,localWritesPreserved:true,liveBrowserReconnected:true,modes:['long-poll','stream'],targets:['items','other'],events,pageErrors,seedSeparateFromExport:true});
  console.log('Native resume live test passed: import, local writes, clean stop, reopen, both browser modes and two targets.');
}catch(error){await json('failure.json',{error:String(error),stack:error.stack,launches,pageErrors});throw error;}
finally{if(browser)await browser.close();if(active)await stop();if(web)await new Promise(resolve=>web.close(resolve));}
