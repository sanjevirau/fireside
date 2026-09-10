import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir, platform, arch, release, cpus } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const manifestBytes=await readFile(new URL('../../../benchmarks/phase-a-developer-tools.json',import.meta.url));
const manifest=JSON.parse(manifestBytes);
const config=manifest.baseline;
const args=process.argv.slice(2);
const omitListProbe=args.at(-1)==='--omit-list-probe';
if(omitListProbe)args.pop();
const candidateEngine=args[1]==='--candidate-engine'?args[2]:undefined;
assert(args.length===1||(args.length===3&&candidateEngine),
  'fresh-output [--candidate-engine FULL_LOCAL_ENGINE_REVISION] [--omit-list-probe]');
if(candidateEngine)assert.match(candidateEngine,/^[a-f0-9]{40}$/);
const expectedVersion=candidateEngine?`0.1.0-local.g${candidateEngine.slice(0,12)}`:manifest.npmBaseline;
const expectedEngine=candidateEngine??manifest.engineBaseline;
const binary=resolve(process.env.FIRESIDE_BASELINE_BINARY??'missing-baseline-binary');
assert.ok(process.env.FIRESIDE_BASELINE_BINARY,'provide the verified release binary');
const packageMetadata=JSON.parse(await readFile(join(dirname(binary),'../package.json')));
assert.equal(packageMetadata.version,expectedVersion);
assert.equal(packageMetadata.name,`@fireside-dev/${platform()}-${arch()}`);
const packageReceipt=JSON.parse(await readFile(join(dirname(binary),'../receipt.json')));
assert.equal(packageReceipt.engineRevision,expectedEngine);
assert.equal(packageReceipt.sha256,createHash('sha256').update(await readFile(binary)).digest('hex'));
assert.equal(process.versions.node,manifest.oracle.node);
assert.ok(['darwin','linux'].includes(platform()),'RSS sampler implemented for macOS/Linux only; no Windows claim');
const output=resolve(process.argv[2]??'missing-output');assert.ok(process.argv[2]);await mkdir(output);
const root=await mkdtemp(join(tmpdir(),'fireside-developer-baseline-'));
const rules=join(root,'firestore.rules');await writeFile(rules,"rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{doc=**} { allow read, write: if true; } } }\n");
const data=join(root,'state');
const receipt={schemaVersion:1,manifestSha256:createHash('sha256').update(manifestBytes).digest('hex'),
  capturedAt:new Date().toISOString(),binarySha256:createHash('sha256').update(await readFile(binary)).digest('hex'),
  packageVersion:expectedVersion,engineRevision:expectedEngine,
  driverSha256:createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),
  qualificationMode:candidateEngine?'explicit-local-candidate':'original-published-baseline',
  platform:platform(),arch:arch(),osRelease:release(),cpu:cpus()[0].model,node:process.versions.node,
  hostQuiescent:false,scope:config.measurementScope,limitations:config.claims,cycles:[]};
if(omitListProbe){
  receipt.listProbeOmittedForComparability=true;
  receipt.comparisonContractSha256=createHash('sha256').update(await readFile(new URL('../../../benchmarks/phase-e-equivalent-queries.json',import.meta.url))).digest('hex');
}
for (let cycle=0;cycle<=config.nativeReopens;cycle++) {
  const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
  const row={mode:cycle===0?'empty-native-store':'native-reopen',rssSamples:[],operations:[]};receipt.cycles.push(row);
  const started=performance.now();
  const child=spawn(binary,['--host','127.0.0.1','--port',String(port),'--project_id',config.project,'--rules',rules,'--data-dir',data],{cwd:root,stdio:['ignore','pipe','pipe']});
  const exited=once(child,'exit');const logs=[];for(const stream of [child.stdout,child.stderr])stream.on('data',b=>logs.push(String(b)));
  const sampler=setInterval(()=>{
    try{const rss=Number(execFileSync('ps',['-o','rss=','-p',String(child.pid)],{encoding:'utf8'}).trim());
      row.rssSamples.push({elapsedMs:Math.round(performance.now()-started),rssBytes:rss*1024});}catch{/* process may have exited between samples */}
  },config.rssSampleIntervalMs);
  const base=`http://127.0.0.1:${port}/v1/projects/${config.project}/databases/(default)/documents`;
  async function request(name,path,options={}) {
    const before=performance.now();const r=await fetch(base+path,{...options,signal:AbortSignal.timeout(10000)});
    const body=await r.json();
    row.operations.push({name,status:r.status,elapsedMs:performance.now()-before,...(!r.ok?{error:body}:{})});
    assert.ok(r.ok,`${name}: ${r.status} ${JSON.stringify(body)}`);return body;
  }
  try {
    const deadline=Date.now()+config.readinessDeadlineMs;
    while(true){assert.equal(child.exitCode,null);try{const r=await fetch(`http://127.0.0.1:${port}/`,{signal:AbortSignal.timeout(250)});if(r.status<500)break;}catch{}
      assert.ok(Date.now()<deadline,'baseline readiness deadline');await delay(20);}
    row.readyMs=performance.now()-started;
    if(cycle===0)for(let i=0;i<config.documents;i++)await request('seed',`/collection-${i%config.collections}/document-${i}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({fields:{payload:{stringValue:'x'.repeat(config.payloadAsciiBytes)},index:{integerValue:String(i)}}})});
    for(let i=0;i<config.sequentialGets;i++){
      const doc=await request('get',`/collection-${i%config.collections}/document-${i}`);assert.equal(doc.fields.index.integerValue,String(i));
    }
    if(!omitListProbe){
      const unsupported=await fetch(base+'/collection-0?pageSize=1000');
      row.restListDocumentsProbe={status:unsupported.status,body:await unsupported.json()};
    }
    const before=performance.now();
    const counts=await Promise.all(Array.from({length:config.parallelCollectionReads},async(_,i)=>{
      const result=await request('collection-query',':runQuery',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({structuredQuery:{from:[{collectionId:`collection-${i}`}]}})});
      const documents=result.filter(item=>item.document);assert.equal(documents.length,config.documents/config.collections);return documents.length;
    }));row.parallelReadsMs=performance.now()-before;row.verifiedDocuments=counts.reduce((a,b)=>a+b,0);
    row.allocatorTelemetry=await(await fetch(`http://127.0.0.1:${port}/emulator/v1/debug/memory`)).json();
    await delay(1000);
  } finally {
    clearInterval(sampler);const stop=performance.now();if(child.exitCode===null)child.kill('SIGINT');
    const [code,signal]=await Promise.race([exited,delay(config.shutdownDeadlineMs,undefined,{ref:false}).then(()=>{throw new Error(`owned baseline PID ${child.pid} shutdown deadline`);})]);
    row.shutdownMs=performance.now()-stop;row.exit={code,signal};
    await writeFile(join(output,`cycle-${cycle}.log`),logs.join(''));
    await writeFile(join(output,'baseline.json'),JSON.stringify(receipt,null,2)+'\n');
    assert.ok((code===0&&signal===null)||(code===null&&signal==='SIGINT'),
      'standalone native baseline must stop on the requested signal, not crash');
  }
}
receipt.passed=true;
await writeFile(join(output,'baseline.json'),JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify({passed:true,output,cycles:receipt.cycles.map(c=>({mode:c.mode,readyMs:c.readyMs,shutdownMs:c.shutdownMs,peakRssBytes:Math.max(...c.rssSamples.map(s=>s.rssBytes)),verifiedDocuments:c.verifiedDocuments}))}));
