// Tiny official Java oracle: SIGTERM while both browser transport variants listen.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {createServer as tcpServer} from 'node:net';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {build} from 'esbuild';
import {chromium} from 'playwright';

assert.equal(process.argv.length,5,'java-jar dependency-root output');
const [jar,dependencies,output]=process.argv.slice(2).map(path=>resolve(path));
await mkdir(output,{mode:0o700});
const reserve=tcpServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));
const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
const project='demo-listener-shutdown';
const env=Object.fromEntries(['HOME','PATH','JAVA_HOME','LANG'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
const args=['-jar',jar,'--host','127.0.0.1','--port',String(port),'--project_id',project];
const child=spawn('/usr/bin/java',args,{cwd:output,env,stdio:['ignore','pipe','pipe']});
let log='',browser,web,exited=false;const errors=[];
for(const stream of ['stdout','stderr'])child[stream].on('data',chunk=>{log+=chunk;});
const finished=new Promise((yes,no)=>{child.once('error',no);child.once('exit',(code,signal)=>{exited=true;yes({code,signal});});});
const sha=value=>createHash('sha256').update(value).digest('hex');
try{
  const deadline=performance.now()+30000;
  while(true){
    assert(!exited,log);assert(performance.now()<deadline,'Java startup deadline');
    try{await fetch(`http://127.0.0.1:${port}/`,{signal:AbortSignal.timeout(500)});break;}catch{await delay(100);}
  }
  const {outputFiles}=await build({stdin:{contents:`
    import {initializeApp} from 'firebase/app';
    import {initializeFirestore,connectFirestoreEmulator,collection,onSnapshot} from 'firebase/firestore';
    window.ready=[];for(const mode of ['long-poll','stream']){
      const app=initializeApp({projectId:${JSON.stringify(project)},apiKey:'demo'},mode);
      const db=initializeFirestore(app,{experimentalForceLongPolling:mode==='long-poll',experimentalAutoDetectLongPolling:false});
      connectFirestoreEmulator(db,'127.0.0.1',${port});
      for(const target of ['items','other'])onSnapshot(collection(db,target),snap=>{if(!snap.metadata.fromCache)window.ready.push(mode+':'+target);});
    }`,resolveDir:dependencies},bundle:true,format:'iife',write:false,alias:{firebase:dependencies+'/node_modules/firebase'}});
  web=createServer((req,res)=>{res.setHeader('content-type','text/html');res.end('<script>'+outputFiles[0].text+'</script>');});
  await new Promise(resolve=>web.listen(0,'127.0.0.1',resolve));
  browser=await chromium.launch({headless:true});const page=await browser.newPage();page.on('pageerror',error=>errors.push(String(error)));
  await page.goto('http://127.0.0.1:'+web.address().port);
  await page.waitForFunction(()=>new Set(window.ready).size===4,undefined,{timeout:20000});
  const started=performance.now();child.kill('SIGTERM');
  const exit=await Promise.race([finished,delay(15000,undefined,{ref:false}).then(()=>{throw Error('Java open-listener shutdown deadline');})]);
  const result={oracle:'official Java Firestore v1.22.0',jarSha256:sha(await readFile(jar)),driverSha256:sha(await readFile(new URL(import.meta.url))),args,passed:true,exit,shutdownMilliseconds:performance.now()-started,browserStillOpenAtExit:browser.isConnected(),liveTargets:4,modes:['long-poll','stream'],pageErrors:errors};
  await writeFile(output+'/result.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}finally{
  if(browser)await browser.close();if(!exited){child.kill('SIGTERM');await finished;}
  if(web)await new Promise(resolve=>web.close(resolve));await writeFile(output+'/java.log',log);
}
