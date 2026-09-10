import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

test('short admission and native browser receipts retain their separate exact identities',async()=>{
  const root=new URL('../../benchmarks/results/phase-c/',import.meta.url);
  const records={};
  for(const line of (await readFile(new URL('SHA256SUMS',root),'utf8')).trim().split('\n')){
    const [sha,name]=line.split(/\s+/);assert.match(name,/^[a-z0-9-]+\.json$/);
    const bytes=await readFile(new URL(name,root));
    assert.equal(createHash('sha256').update(bytes).digest('hex'),sha);records[name]=JSON.parse(bytes);
  }
  const admission=records['functions-admission-20260911.json'];
  assert.equal(admission.syntheticOnly,true);assert.equal(admission.passed,true);
  assert.equal(admission.target,'fireside-owned-admission-with-official-peers');
  assert.equal(admission.targetVersion,'15.22.0');assert.equal(admission.sdkVersion,'7.2.5');
  assert.equal(admission.ownedAdapterSha256,'83f92a536185f631a522be68f74999471fcf8a8de26dfe3747f0713f86b47676');
  assert.deepEqual(admission.observations.map(row=>row.mode),['healthy','failed-codebase','missing-auxiliary','predefined-backend','colliding-backends']);
  for(const row of admission.observations){
    if(['healthy','predefined-backend'].includes(row.mode))assert.equal(row.connectError,null);
    else assert.match(row.connectError,/discovery did not complete|not admitted|another backend/);
  }
  const browser=records['native-suite-ui-20260911-r11.json'];
  assert.equal(browser.passed,true);assert.equal(browser.syntheticOnly,true);assert.equal(browser.acceptance,false);
  assert.equal(browser.binarySha256,'0ee545e596aebbe9380c4852a7a9d24a17050362ff64e6a4cca81655ca0875fc');
  assert.equal(browser.browser.checks.length,14);assert.equal(browser.functionsPing,true);
  assert.deepEqual(browser.shutdown,[0,null]);
});
