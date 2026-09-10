import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {gunzipSync} from 'node:zlib';

test('Phase B diagnostic receipt retains all samples and meets the unchanged limits',async()=>{
  const root=new URL('../../',import.meta.url);
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
  const compressed=await readFile(new URL('benchmarks/results/phase-b/diagnostics-overhead-20260911.json.gz',root));
  assert.equal(hash(compressed),'64f69dc6c5d90141553fe6f1c29219d7d1c191d8870a5635cf606dfd5d3f7171');
  const receipt=JSON.parse(gunzipSync(compressed));
  assert.equal(receipt.passed,true);assert.equal(receipt.acceptance,false);
  assert.equal(receipt.hostQuiescent,false);assert.equal(receipt.runs.length,9);
  const criteriaBytes=await readFile(new URL('benchmarks/phase-a-developer-tools.json',root));
  const manifestBytes=await readFile(new URL('benchmarks/phase-b-diagnostics-overhead.json',root));
  const limits=JSON.parse(criteriaBytes).phaseBChecksBeforeImplementation;
  assert.equal(hash(criteriaBytes),receipt.criteriaSha256);assert.equal(hash(manifestBytes),receipt.manifestSha256);
  assert.equal(receipt.binarySha256,'50bf6063bbfc2c4c147691537bce6de03ab1b2074bafc4a9fad8d76ab51caa79');
  // This immutable receipt records the captured driver, not later driver edits.
  assert.equal(receipt.driverSha256,'ff6583c67d2a5a9cc32cc36db22cc36044cc7c4d8ccb5df0efb4c4f5a6f48202');
  assert.equal(new Set(receipt.runs.map(run=>run.finalStateSha256)).size,1);
  for(const run of receipt.runs){
    assert.equal(run.passed,true);assert.deepEqual(run.exit,[0,null]);
    assert.equal(run.failure,undefined);assert.equal(run.rssSampleError,undefined);
    assert.deepEqual(run.requestErrors,[]);assert.equal(run.operations.length,5000);
    run.operations.forEach((operation,index)=>{
      assert.equal(operation.i,index);assert.equal(operation.status,index%100===5?403:200);
      assert(Number.isFinite(operation.elapsedMs)&&operation.elapsedMs>=0);
    });
    const sorted=run.operations.map(operation=>operation.elapsedMs).sort((a,b)=>a-b);
    assert.equal(run.p99Ms,sorted[4949]);assert.equal(run.medianMs,sorted[2499]);
    assert.equal(run.operationsPerSecond,5000/(run.measuredMs/1000));
    assert.equal(run.peakActiveRssBytes,Math.max(...run.rssSamples.filter(sample=>sample.phase==='measured').map(sample=>sample.rssBytes)));
    assert.equal(run.settledRssBytes,run.rssSamples.filter(sample=>sample.phase==='settled-after').at(-1).rssBytes);
  }
  assert.equal(receipt.comparisons.length,6);
  for(const comparison of receipt.comparisons){
    const baseline=receipt.runs.find(run=>run.repetition===comparison.repetition&&run.variant==='disabled');
    const enabled=receipt.runs.find(run=>run.repetition===comparison.repetition&&run.variant===comparison.variant);
    assert.equal(comparison.p99IncreaseMs,enabled.p99Ms-baseline.p99Ms);
    assert.equal(comparison.throughputReductionPercent,100*(1-enabled.operationsPerSecond/baseline.operationsPerSecond));
    assert.equal(comparison.settledRssIncreaseBytes,enabled.settledRssBytes-baseline.settledRssBytes);
    assert.equal(comparison.activeRssIncreaseBytes,enabled.peakActiveRssBytes-baseline.peakActiveRssBytes);
    assert(comparison.p99IncreaseMs<=Math.max(baseline.p99Ms*.2,2));
    assert(comparison.throughputReductionPercent<=limits.maximumThroughputReductionPercent);
    assert(comparison.settledRssIncreaseBytes<=limits.maximumSettledRssIncreaseBytes);
    assert(comparison.activeRssIncreaseBytes<=limits.maximumActiveRssIncreaseBytes);
    assert.equal(comparison.sameFinalState,true);assert.equal(comparison.passed,true);
  }
});
