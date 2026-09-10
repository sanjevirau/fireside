// Paired, short diagnostic qualification. The committed manifest is immutable input.
// Usage: node diagnostic-overhead.mjs release-binary fresh-output
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {arch,cpus,platform,release,totalmem} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';

assert.equal(process.argv.length,4,'release-binary fresh-output');
assert.equal(process.versions.node,'24.20.0');
assert(['darwin','linux'].includes(platform()),'native process RSS supported on macOS/Linux only');
const [binary,output]=process.argv.slice(2).map(path=>resolve(path));
assert.equal(dirname(binary).split('/').at(-1),'release','measure an optimized release binary');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const manifestBytes=await readFile(new URL('../../../benchmarks/phase-b-diagnostics-overhead.json',import.meta.url));
const manifest=JSON.parse(manifestBytes);
const contractBytes=await readFile(new URL('../../../benchmarks/phase-a-developer-tools.json',import.meta.url));
const limits=JSON.parse(contractBytes).phaseBChecksBeforeImplementation;
assert.equal(manifest.criteriaChanged,false);
assert.equal(limits.maximumP99Increase,'larger of 20 percent or 2 milliseconds');
assert.equal(manifest.documents,200);assert.equal(manifest.collections,10);
assert.equal(manifest.warmupOperations,500);assert.equal(manifest.measuredOperations,5000);
assert.equal(manifest.pairs,3);
const rules="rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read: if resource.data.index >= 0; allow write: if request.resource.data.index >= 0; } } }\n";
await mkdir(output,{mode:0o700});
await writeFile(join(output,'firestore.rules'),rules);
const record={schemaVersion:1,passed:false,acceptance:false,startedAt:new Date().toISOString(),
  binarySha256:hash(await readFile(binary)),driverSha256:hash(await readFile(new URL(import.meta.url))),
  manifestSha256:hash(manifestBytes),criteriaSha256:hash(contractBytes),rulesSha256:hash(rules),
  host:{platform:platform(),arch:arch(),osRelease:release(),cpu:cpus()[0].model,totalMemoryBytes:totalmem()},
  node:process.version,scope:manifest.scope,hostQuiescent:false,runs:[],comparisons:[]};
const save=()=>writeFile(join(output,'result.json'),JSON.stringify(record,null,2)+'\n');
const execute=promisify(execFile);
const documentPath=i=>`/collection-${i%manifest.collections}/document-${i}`;
const fields=(index,revision=0)=>({index:{integerValue:String(index)},payload:{stringValue:'x'.repeat(manifest.payloadAsciiBytes)},revision:{integerValue:String(revision)}});
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?
  Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const percentile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*p)-1)];

async function run(repetition,variant){
  const dir=join(output,`${repetition}-${variant}`);await mkdir(dir);
  const reservations=[],ports=[];
  for(let i=0;i<2;i++){const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');ports.push(server.address().port);reservations.push(server);}
  await Promise.all(reservations.map(server=>new Promise(resolve=>server.close(resolve))));
  const args=['firestore','--host','127.0.0.1','--port',String(ports[0]),'--project_id',manifest.project,
    '--data-dir',join(dir,'state'),'--rules',join(output,'firestore.rules')];
  if(variant!=='disabled')args.push('--websocket-port',String(ports[1]));
  const env=Object.fromEntries(['HOME','PATH','LANG','TZ'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
  env.FIRESIDE_CONTROL_STDIN='1';
  const child=spawn(binary,args,{cwd:dir,env,stdio:['pipe','pipe','pipe']});
  const exited=once(child,'exit');let log='',socket,phase='startup',sampling=false,sampleTask=Promise.resolve();
  for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>{log+=bytes;});
  const started=performance.now();
  const row={repetition,variant,pid:child.pid,operations:[],rssSamples:[],requestsEvents:0,requestErrors:[],expectedStatuses:{}};
  const expectedFields=Array.from({length:manifest.documents},(_,i)=>fields(i));
  record.runs.push(row);
  const sample=()=>{
    if(sampling)return sampleTask;
    sampling=true;const sampledPhase=phase,elapsedMs=performance.now()-started;
    sampleTask=execute('ps',['-o','rss=','-p',String(child.pid)],{timeout:2000}).then(({stdout})=>{
      const rss=Number(stdout.trim());assert(Number.isFinite(rss)&&rss>0,'valid native RSS');
      row.rssSamples.push({phase:sampledPhase,elapsedMs,rssBytes:rss*1024});
    }).catch(error=>{row.rssSampleError=error.message;}).finally(()=>{sampling=false;});return sampleTask;
  };
  const timer=setInterval(sample,manifest.rssSampleIntervalMilliseconds);
  const origin=`http://127.0.0.1:${ports[0]}`;
  const base=origin+`/v1/projects/${manifest.project}/databases/(default)/documents`;
  async function request(path,method='GET',body,owner=false){
    const response=await fetch(base+path,{method,headers:{...(body?{'content-type':'application/json'}:{}),...(owner?{authorization:'Bearer owner'}:{})},
      ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(manifest.requestDeadlineMilliseconds)});
    return {status:response.status,body:await response.json()};
  }
  async function operation(i,measured){
    const index=i%manifest.documents,slot=i%100,before=performance.now();let result,kind;
    if(slot<=5){kind=slot===5?'denied-patch':'patch';result=await request(documentPath(index),'PATCH',{fields:fields(slot===5?-1:index,i)});}
    else if(slot===6){kind='query';result=await request(':runQuery','POST',{structuredQuery:{from:[{collectionId:`collection-${index%manifest.collections}`}],
      where:{fieldFilter:{field:{fieldPath:'index'},op:'GREATER_THAN_OR_EQUAL',value:{integerValue:'0'}}}}});}
    else {kind='get';result=await request(documentPath(index));}
    const elapsedMs=performance.now()-before;
    if(measured)row.operations.push({i,kind,status:result.status,elapsedMs});
    assert.equal(result.status,slot===5?403:200,JSON.stringify(result));
    if(slot===6){const docs=result.body.filter(item=>item.document).map(item=>item.document);
      assert.equal(docs.length,manifest.documents/manifest.collections);
      assert.equal(new Set(docs.map(doc=>doc.name)).size,docs.length);
      for(const doc of docs)assert.equal(Number(doc.fields.index.integerValue)%manifest.collections,index%manifest.collections);
    } else if(slot!==5){assert.equal(result.body.fields.index.integerValue,String(index));assert.equal(result.body.fields.payload.stringValue,'x'.repeat(manifest.payloadAsciiBytes));}
    if(slot<5){assert.deepEqual(result.body.fields,fields(index,i));expectedFields[index]=fields(index,i);}
    if(measured)row.expectedStatuses[result.status]=(row.expectedStatuses[result.status]??0)+1;
  }
  try{
    while(true){
      assert.equal(child.exitCode,null,log);
      let ready=false;try{const r=await fetch(origin+'/',{signal:AbortSignal.timeout(250)});await r.arrayBuffer();ready=r.status<500;}catch{}
      if(ready)break;assert(performance.now()-started<manifest.readinessDeadlineMilliseconds,'readiness deadline');await delay(20);
    }
    row.readyMs=performance.now()-started;phase='seed';
    const coverage=await fetch(`${origin}/emulator/v1/projects/${manifest.project}:ruleCoverage`,{signal:AbortSignal.timeout(10000)});
    assert.equal(coverage.status,variant==='disabled'?503:200,'recording opt-in must match measured variant');await coverage.arrayBuffer();
    for(let i=0;i<manifest.documents;i++){const r=await request(documentPath(i),'PATCH',{fields:fields(i)},true);assert.equal(r.status,200);}
    if(variant==='enabled-one-subscriber'){
      socket=new WebSocket(`ws://127.0.0.1:${ports[1]}/requests`);
      socket.addEventListener('message',event=>{try{
        const data=JSON.parse(event.data),events=Array.isArray(data)?data:[data];
        for(const item of events){assert(item.requestId);assert(['allow','deny','error'].includes(item.outcome));row.requestsEvents++;}
      }catch(error){row.requestErrors.push(error.message);}});
      await Promise.race([once(socket,'open'),delay(10000,null,{ref:false}).then(()=>{throw new Error('Requests open deadline');})]);
    }
    phase='warmup';for(let i=0;i<manifest.warmupOperations;i++)await operation(i,false);
    phase='settled-before';await delay(manifest.settleMilliseconds);await sample();
    phase='measured';await sample();const measuredAt=performance.now();
    for(let i=0;i<manifest.measuredOperations;i++)await operation(i,true);
    row.measuredMs=performance.now()-measuredAt;await sample();
    phase='settled-after';await delay(manifest.settleMilliseconds);await sample();
    row.p99Ms=percentile(row.operations.map(op=>op.elapsedMs),0.99);
    row.medianMs=percentile(row.operations.map(op=>op.elapsedMs),0.5);
    row.operationsPerSecond=manifest.measuredOperations/(row.measuredMs/1000);
    row.peakActiveRssBytes=Math.max(...row.rssSamples.filter(s=>s.phase==='measured').map(s=>s.rssBytes));
    row.settledRssBytes=row.rssSamples.filter(s=>s.phase==='settled-after').at(-1).rssBytes;
    assert(Number.isFinite(row.peakActiveRssBytes)&&row.peakActiveRssBytes>0,'active native RSS was sampled');
    assert.equal(row.rssSampleError,undefined);assert.deepEqual(row.requestErrors,[]);
    if(socket){assert.equal(socket.readyState,WebSocket.OPEN,'subscriber remains healthy throughout measurement');assert(row.requestsEvents>=manifest.measuredOperations);}
    phase='verify';const state=[];
    for(let i=0;i<manifest.documents;i++){const r=await request(documentPath(i),'GET',undefined,true);assert.equal(r.status,200);assert.deepEqual(r.body.fields,expectedFields[i]);state.push(canonical(r.body.fields));}
    row.finalStateSha256=hash(JSON.stringify(state));
    row.passed=true;
  }catch(error){row.failure={message:error.message,stack:error.stack};throw error;}
  finally{
    phase='shutdown';clearInterval(timer);await sampleTask;socket?.close();
    const before=performance.now();if(child.exitCode===null&&child.signalCode===null)child.stdin.end('FIRESIDE_SHUTDOWN\n');
    const stopped=await Promise.race([exited,delay(manifest.shutdownDeadlineMilliseconds,null,{ref:false})]);
    row.shutdownMs=performance.now()-before;row.exit=stopped;
    await writeFile(join(dir,'native.log'),log);await save();
    assert(stopped,`owned diagnostic PID ${child.pid} failed to stop; preserve for diagnosis`);assert.equal(stopped[0],0,log);
  }
}

try{
  for(let pair=0;pair<manifest.pairs;pair++){
    for(let offset=0;offset<manifest.variants.length;offset++)await run(pair,manifest.variants[(pair+offset)%manifest.variants.length]);
    const rows=record.runs.filter(row=>row.repetition===pair),baseline=rows.find(row=>row.variant==='disabled');
    for(const row of rows.filter(row=>row.variant!=='disabled')){
      const comparison={repetition:pair,variant:row.variant,p99IncreaseMs:row.p99Ms-baseline.p99Ms,
        throughputReductionPercent:100*(1-row.operationsPerSecond/baseline.operationsPerSecond),
        settledRssIncreaseBytes:row.settledRssBytes-baseline.settledRssBytes,
        activeRssIncreaseBytes:row.peakActiveRssBytes-baseline.peakActiveRssBytes,
        sameFinalState:row.finalStateSha256===baseline.finalStateSha256};
      comparison.passed=comparison.sameFinalState&&comparison.p99IncreaseMs<=Math.max(baseline.p99Ms*0.2,2)&&
        comparison.throughputReductionPercent<=limits.maximumThroughputReductionPercent&&
        comparison.settledRssIncreaseBytes<=limits.maximumSettledRssIncreaseBytes&&comparison.activeRssIncreaseBytes<=limits.maximumActiveRssIncreaseBytes;
      record.comparisons.push(comparison);
    }
    await save();console.log(JSON.stringify({completedPair:pair,comparisons:record.comparisons.filter(c=>c.repetition===pair)}));
  }
  assert.equal(new Set(record.runs.map(row=>row.finalStateSha256)).size,1,'all variants preserve the same final documents');
  record.passed=record.comparisons.every(row=>row.passed);await save();
  assert(record.passed,'frozen diagnostic overhead threshold exceeded; preserve and investigate');
}catch(error){record.failure={message:error.message,stack:error.stack};await save();throw error;}
console.log(JSON.stringify({passed:true,output}));
