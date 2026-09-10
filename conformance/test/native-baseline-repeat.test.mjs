import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {test} from 'node:test';

test('native baseline repeat preserves both binaries, all cycles and the unchanged workload',async()=>{
  const root=new URL('../../',import.meta.url),hash=b=>createHash('sha256').update(b).digest('hex');
  const contract=await readFile(new URL('benchmarks/phase-e-native-baseline-repeat.json',root));
  assert.equal(hash(contract),'c6a7e5812ec46041dfd726d20b20a546b9e7e01c9ce9e96dc3f696472e8c00bb');
  assert.equal(JSON.parse(contract).workloadChanged,false);
  const originalManifest=hash(await readFile(new URL('benchmarks/phase-a-developer-tools.json',root)));
  const sums=(await readFile(new URL('benchmarks/results/phase-e/SHA256SUMS',root),'utf8')).trim().split('\n');
  let previousStarted=0;
  for(const pair of [1,2,3])for(const variant of pair===2?['candidate','published']:['published','candidate']){
    const name=`native-baseline-pair${pair}-${variant}.json.gz`;
    const bytes=await readFile(new URL('benchmarks/results/phase-e/'+name,root));
    assert(sums.includes(hash(bytes)+'  '+name));const r=JSON.parse(gunzipSync(bytes));
    assert.equal(r.passed,true);assert.equal(r.hostQuiescent,false);
    assert.equal(r.manifestSha256,originalManifest);
    assert.equal(r.driverSha256,'2affc532e3e7a032547ca2424f36d3f8693267eced8bcd08f6524f22ccbee704');
    assert.equal(r.binarySha256,variant==='published'?
      '82a8f81e31b0b62a21c3c1d8e531b93ec72edf496c9c10d1fee735760a248054':
      '63df176389dd697c9057777d570eecde7ef46ae9215d1538b4c454f4b5b91145');
    assert.equal(r.packageVersion,variant==='published'?'0.1.0-next.3':'0.1.0-local.g7f9a0f35ac84');
    assert.equal(r.qualificationMode,variant==='published'?'original-published-baseline':'explicit-local-candidate');
    assert(Date.parse(r.capturedAt)>previousStarted);previousStarted=Date.parse(r.capturedAt);
    assert.deepEqual(r.cycles.map(c=>c.mode),['empty-native-store','native-reopen']);
    for(const [index,c] of r.cycles.entries()){
      assert.equal(c.verifiedDocuments,200);assert.equal(c.operations.length,index===0?250:50);
      for(const [name,count] of [['seed',index===0?200:0],['get',40],['collection-query',10]])
        assert.equal(c.operations.filter(o=>o.name===name).length,count);
      for(const o of c.operations){assert.equal(o.status,200);assert(Number.isFinite(o.elapsedMs)&&o.elapsedMs>=0);}
      assert(Number.isFinite(c.parallelReadsMs)&&c.parallelReadsMs>0);
      assert(c.rssSamples.length>0);assert(c.rssSamples.every(s=>s.rssBytes>0));
      assert(c.exit.code===0&&c.exit.signal===null||c.exit.code===null&&c.exit.signal==='SIGINT');
      // This unmeasured probe changed with the independently tested listing feature.
      assert.equal(c.restListDocumentsProbe.status,variant==='published'?400:200);
    }
  }
});

test('separate equivalent-query repeats omit only the asymmetric listing probe',async()=>{
  const root=new URL('../../',import.meta.url),hash=b=>createHash('sha256').update(b).digest('hex');
  const contract=await readFile(new URL('benchmarks/phase-e-equivalent-queries.json',root));
  assert.equal(hash(contract),'e1aa52bd23a9ff13da0a9dae273e7f0ed78cb5df120685d18e88bce0989a01cd');
  const sums=(await readFile(new URL('benchmarks/results/phase-e/SHA256SUMS',root),'utf8')).trim().split('\n');
  let prior=0;
  for(const pair of [1,2,3])for(const variant of pair===2?['candidate','published']:['published','candidate']){
    const name=`equivalent-queries-pair${pair}-${variant}.json.gz`;
    const bytes=await readFile(new URL('benchmarks/results/phase-e/'+name,root));
    assert(sums.includes(hash(bytes)+'  '+name));const r=JSON.parse(gunzipSync(bytes));
    assert.equal(r.passed,true);assert.equal(r.listProbeOmittedForComparability,true);
    assert.equal(r.comparisonContractSha256,hash(contract));
    assert.equal(r.driverSha256,'83eaf5e6ccaeb8a1beb82ac34813e899a17fd12cf826e2f7435ec6214b10db72');
    assert.equal(r.binarySha256,variant==='published'?'82a8f81e31b0b62a21c3c1d8e531b93ec72edf496c9c10d1fee735760a248054':'63df176389dd697c9057777d570eecde7ef46ae9215d1538b4c454f4b5b91145');
    assert(Date.parse(r.capturedAt)>prior);prior=Date.parse(r.capturedAt);
    assert.equal(r.cycles.length,2);
    for(const [index,c] of r.cycles.entries()){
      assert.equal(c.restListDocumentsProbe,undefined);assert.equal(c.verifiedDocuments,200);
      assert.equal(c.operations.length,index===0?250:50);
      for(const [name,count] of [['seed',index===0?200:0],['get',40],['collection-query',10]])assert.equal(c.operations.filter(o=>o.name===name).length,count);
      for(const o of c.operations){assert.equal(o.status,200);assert(Number.isFinite(o.elapsedMs)&&o.elapsedMs>=0);}
      assert(Number.isFinite(c.parallelReadsMs)&&c.parallelReadsMs>0);
      assert(c.rssSamples.length>0&&c.rssSamples.every(s=>s.rssBytes>0));
      assert(c.exit.code===0&&c.exit.signal===null||c.exit.code===null&&c.exit.signal==='SIGINT');
    }
  }
});
