import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {gunzipSync} from 'node:zlib';

test('native suite receipt includes all browser controls, a real Function and clean shutdown',async()=>{
  const bytes=await readFile(new URL('../../benchmarks/results/phase-b/native-suite-ui-20260911-r9.json',import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),'5e5786b5a8040ae9077e9a7459081795c63949bdf405a6650b1726601fd79456');
  const receipt=JSON.parse(bytes);
  assert.equal(receipt.passed,true);assert.equal(receipt.acceptance,false);assert.equal(receipt.syntheticOnly,true);
  assert.equal(receipt.functionsPing,true);assert.deepEqual(receipt.shutdown,[0,null]);
  assert.deepEqual(receipt.browser.errors,[]);
  assert.deepEqual(receipt.browser.checks,[
    'service-overview-rendered','denied-request-rule-and-context-rendered',
    'request-details-survive-reload-history-replay','coverage-html-renders-expressions',
    'document-browse-edit-persisted','document-clear-control-persisted',
    'auth-create-and-list','auth-list-refresh','auth-clear-control',
    'storage-upload-and-list','storage-upload-bytes-preserved','storage-metadata-panel',
    'storage-clear-control','logs-history-rendered',
  ]);
  assert.equal(receipt.firebaseTools,'15.22.0');assert.equal(receipt.firebaseFunctions,'7.2.5');
  assert.equal(receipt.binarySha256,'f50fe064513e4cf8712d5337cdcb9a50d434a3f57a44ef9e979cf49c761c0210');
});

for(const recorded of [
  {name:'diagnostics-overhead-20260911.json.gz',sha:'64f69dc6c5d90141553fe6f1c29219d7d1c191d8870a5635cf606dfd5d3f7171',binary:'50bf6063bbfc2c4c147691537bce6de03ab1b2074bafc4a9fad8d76ab51caa79'},
  {name:'diagnostics-overhead-20260911-r2.json.gz',sha:'967d5cdca4b119739c8eb22e9f981e29ec762ab5a86eb32b6bd720fc780f7305',binary:'5a54dd47c72b3865506d8fe18a88abc1a0734c4b35b34967111eea60f15ad91e'},
])test('Phase B diagnostic receipt retains all samples and unchanged limits: '+recorded.name,async()=>{
  const root=new URL('../../',import.meta.url);
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
  const compressed=await readFile(new URL('benchmarks/results/phase-b/'+recorded.name,root));
  assert.equal(hash(compressed),recorded.sha);
  const receipt=JSON.parse(gunzipSync(compressed));
  assert.equal(receipt.passed,true);assert.equal(receipt.acceptance,false);
  assert.equal(receipt.hostQuiescent,false);assert.equal(receipt.runs.length,9);
  const criteriaBytes=await readFile(new URL('benchmarks/phase-a-developer-tools.json',root));
  const manifestBytes=await readFile(new URL('benchmarks/phase-b-diagnostics-overhead.json',root));
  const limits=JSON.parse(criteriaBytes).phaseBChecksBeforeImplementation;
  assert.equal(hash(criteriaBytes),receipt.criteriaSha256);assert.equal(hash(manifestBytes),receipt.manifestSha256);
  assert.equal(receipt.binarySha256,recorded.binary);
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
