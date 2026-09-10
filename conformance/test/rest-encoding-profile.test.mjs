import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';

test('optimized runtime retains full synthetic UI, Functions reload and private package rollback evidence',async()=>{
  const load=async(name,sha)=>{
    const bytes=await readFile(new URL('../../benchmarks/results/phase-e/'+name,import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'),sha);return JSON.parse(bytes);
  };
  const ui=await load('native-suite-ui.json','83e7293a508d571c9048ca4bc723c2b9a94eaeca8049d83de1c5d25b83001bc5');
  assert.equal(ui.passed,true);assert.equal(ui.acceptance,false);assert.equal(ui.syntheticOnly,true);
  assert.equal(ui.binarySha256,'63df176389dd697c9057777d570eecde7ef46ae9215d1538b4c454f4b5b91145');
  assert.equal(ui.functionsPing,true);assert.deepEqual(ui.shutdown,[0,null]);assert.deepEqual(ui.browser.errors,[]);
  assert.deepEqual(ui.browser.checks,[
    'service-overview-rendered','denied-request-rule-and-context-rendered',
    'request-details-survive-reload-history-replay','coverage-html-renders-expressions',
    'document-browse-edit-persisted','document-clear-control-persisted',
    'auth-create-and-list','auth-list-refresh','auth-clear-control',
    'storage-upload-and-list','storage-upload-bytes-preserved','storage-metadata-panel',
    'storage-clear-control','logs-history-rendered',
  ]);
  assert.deepEqual(ui.topicReload.map(x=>[x.stage,x.status,x.delivered.handler,x.delivered.version]),[
    ['initial',200,'alpha',1],['added-handler',200,'beta',2],['updated-handler',200,'alpha',2],
  ]);
  const packed=await load('packed-bun-smoke.json','d00b936daa46a6a3c78e88a226bf2b676c1dda5f71797ee03d33f6422f6878a4');
  const restored=await load('local-consumer-smoke.json','69b2ea861f5e7b489995ecfb6aa85e54aa0262f1f0521104df691e8c94ec226f');
  const artifacts=await load('local-packages.json','9428473963f2195ed0307220355f7b1a55fb0c7a79943efb800224d2a98d8a22');
  assert.equal(packed.passed,true);assert.equal(restored.passed,true);
  assert.equal(packed.engineRevision,'7f9a0f35ac842546c1027c2eb536f2d8729d3548');
  assert.equal(packed.version,'0.1.0-local.g7f9a0f35ac84');assert.equal(packed.platform,'darwin-arm64');
  assert.equal(restored.candidate,packed.version);assert.equal(restored.restored,'0.1.0-next.3');
  assert.deepEqual(packed.checks,['packed install without scripts','binary identity','two listeners','UTF-16 content','disk/WAL write/read','native reopen']);
  assert.equal(artifacts.packages.length,2);
  for(const pkg of artifacts.packages)assert.equal(pkg.version,packed.version);
});

test('REST microprofile retains original, intermediate and interleaved measurements without a service claim',async()=>{
  const root=new URL('../../',import.meta.url);
  const r=JSON.parse(await readFile(new URL('benchmarks/results/phase-e/rest-encoding.json',root)));
  const contract=await readFile(new URL('benchmarks/phase-e-rest-encoding.json',root));
  assert.equal(r.contractSha256,createHash('sha256').update(contract).digest('hex'));
  assert.equal(r.acceptance,false);assert.equal(r.syntheticOnly,true);
  assert.equal(r.iterations,500);assert.equal(r.outputBytes,66309);
  assert.equal(r.runs.length,12);assert(r.initialExploration.intermediateElapsedNs>0);
  assert.equal(r.host.quiescent,false);assert.notEqual(r.binarySha256.before,r.binarySha256.after);
  for(const run of r.runs){
    assert.equal(run.exitCode,0);assert.equal(run.outputSha256,r.outputSha256);
    assert.equal(Number(run.rawOutput.match(/elapsed_ns=(\d+)/)[1]),run.elapsedNs);
    assert.equal(Number(run.rawOutput.match(/(\d+)\s+maximum resident/)[1]),run.maximumTestProcessRssBytes);
    assert.equal(Number(run.rawOutput.match(/(\d+)\s+instructions retired/)[1]),run.instructionsRetired);
    assert.match(run.rawOutput,/iterations=500.*json_bytes=66309/);
  }
  for(const pair of [1,2,3]){
    assert.deepEqual(r.runs.filter(run=>run.pair===pair).map(run=>run.variant),
      pair===2?['after','before']:['before','after']);
  }
});
