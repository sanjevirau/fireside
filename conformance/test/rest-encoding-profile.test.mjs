import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';

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
