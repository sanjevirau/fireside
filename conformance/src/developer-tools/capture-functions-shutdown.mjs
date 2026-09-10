// Tiny official Functions lifecycle observation, before changing the wrapper.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {mkdir,readFile,writeFile,symlink} from 'node:fs/promises';
import {createServer} from 'node:net';
import {dirname,join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
const [tools,sdk,output]=process.argv.slice(2).map(path=>resolve(path));assert(output);
assert.equal(process.versions.node,'24.20.0');
assert.equal(JSON.parse(await readFile(join(tools,'package.json'))).version,'15.22.0');
assert.equal(JSON.parse(await readFile(join(sdk,'package.json'))).version,'7.2.5');
await mkdir(output,{mode:0o700});await mkdir(join(output,'functions/node_modules'),{recursive:true});
await symlink(sdk,join(output,'functions/node_modules/firebase-functions'),'dir');
const source="const {onRequest}=require('firebase-functions/v2/https');exports.ping=onRequest((req,res)=>res.json({synthetic:true}));\n";
await writeFile(join(output,'functions/index.js'),source);
await writeFile(join(output,'functions/package.json'),JSON.stringify({name:'synthetic-lifecycle',main:'index.js',engines:{node:'24'}}));
const reservations=[],ports=[];
for(let i=0;i<3;i++){const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');ports.push(server.address().port);reservations.push(server);}
const project='demo-fireside-functions-lifecycle';
await writeFile(join(output,'firebase.json'),JSON.stringify({functions:[{source:'functions',codebase:'synthetic'}],emulators:{functions:{host:'127.0.0.1',port:ports[0]},hub:{host:'127.0.0.1',port:ports[1]},logging:{host:'127.0.0.1',port:ports[2]},ui:{enabled:false}}}));
await mkdir(join(output,'gcloud'));
await writeFile(join(output,'adc.json'),JSON.stringify({type:'authorized_user',client_id:'demo',client_secret:'demo',refresh_token:'demo'}));
const env=Object.fromEntries(['HOME','USER','LOGNAME','LANG','TZ','PATH','JAVA_HOME'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
Object.assign(env,{PATH:dirname(process.execPath)+':'+env.PATH,CI:'1',FIREBASE_CLI_DISABLE_UPDATE_CHECK:'1',CLOUDSDK_CONFIG:join(output,'gcloud'),GOOGLE_APPLICATION_CREDENTIALS:join(output,'adc.json')});
await Promise.all(reservations.map(server=>new Promise(resolve=>server.close(resolve))));
const child=spawn(process.execPath,[join(tools,'lib/bin/firebase.js'),'emulators:start','--only','functions','--project',project,'--config',join(output,'firebase.json')],{cwd:output,env,stdio:['ignore','pipe','pipe']});
const exited=once(child,'exit');let log='';for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>{log+=bytes;});
const result={schemaVersion:1,oracle:{firebaseTools:'15.22.0',firebaseFunctions:'7.2.5',node:process.version},source,sourceSha256:createHash('sha256').update(source).digest('hex'),passed:false};
try{
  const started=performance.now();while(!log.includes('All emulators ready')){assert.equal(child.exitCode,null,log);assert(performance.now()-started<60000,log);await delay(50);}
  result.readyMilliseconds=performance.now()-started;
  const response=await fetch(`http://127.0.0.1:${ports[0]}/${project}/us-central1/ping`,{signal:AbortSignal.timeout(15000)});
  result.exchange={method:'GET',path:`/${project}/us-central1/ping`,status:response.status,body:await response.json()};
  assert.equal(response.status,200);assert.deepEqual(result.exchange.body,{synthetic:true});result.workloadPassed=true;
}catch(error){result.failure=error.message;throw error;}
finally{
  const started=performance.now();if(child.exitCode===null&&child.signalCode===null)child.kill('SIGINT');
  result.exit=await Promise.race([exited,delay(40000,null,{ref:false})]);result.shutdownMilliseconds=performance.now()-started;
  result.passed=result.workloadPassed===true&&result.exit?.[0]===0;
  await writeFile(join(output,'official.log'),log);
  await writeFile(join(output,'result.json'),JSON.stringify(result,null,2)+'\n');
  assert(result.exit,'preserve owned official process for diagnosis');assert(result.passed,log);
}
console.log(JSON.stringify(result));
