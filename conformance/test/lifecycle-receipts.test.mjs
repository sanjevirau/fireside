import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';

const root=new URL('../../',import.meta.url);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function receipt(name,sha){
  const bytes=await readFile(new URL('benchmarks/results/phase-d/'+name,root));
  assert.equal(hash(bytes),sha);return JSON.parse(bytes);
}
test('export failure remains failure but corrected teardown permits native recovery',async()=>{
  const before=await receipt('export-failure-r1.json','b5676ea2e0caa5697b8a34ba59937988c2f7b12d4c721752921dcb958128da41');
  const after=await receipt('export-recovery-r2.json','1147584ec747ce14964110114bdee392ee9d7fe47ce89ac92c01af352afc03a4');
  assert.equal(before.passed,false);assert.equal(before.functionsDrained,false);
  assert.equal(after.passed,true);assert.equal(after.functionsDrained,true);
  assert.equal(before.driverSha256,after.driverSha256);assert.notEqual(before.binarySha256,after.binarySha256);
  for(const observed of [before,after]){
    assert.equal(observed.acceptance,false);assert.equal(observed.exportErrorReported,true);
    assert.deepEqual(observed.failedExportExit,[1,null]);assert.deepEqual(observed.openPorts,[]);
    assert.equal(observed.locatorRemaining,false);assert.equal(observed.nativeReceiptRetained,true);
    assert.equal(observed.incompleteExportNotPublished,true);
  }
  assert.equal(after.acknowledgedWriteRecovered,true);assert.equal(after.completedRecoveryExport,true);
  assert.deepEqual(after.recoveryExit,[0,null]);assert.equal(after.launches[1].resumed,true);
});
test('published-state upgrade is not a fresh import and rollback uses the completed export',async()=>{
  const r=await receipt('native-upgrade-r1.json','bddff21f4bfbabca9239e1c868ceeed2a14831a88e97a089962bc8a93d6c6525');
  assert.equal(r.passed,true);assert.equal(r.acceptance,false);assert.equal(r.nativeUpgrade,true);assert.equal(r.portableRollback,true);
  assert.equal(r.contractSha256,hash(await readFile(new URL('benchmarks/phase-d-native-upgrade.json',root))));
  assert.equal(r.nativeFormat,2);assert.equal(r.nativeReceiptUnchanged,true);
  assert.equal(r.previousReceipt.version,'0.1.0-next.3');assert.equal(r.previousReceipt.engineRevision,'5cb2437112039a91f1389c70545f97fb030e79c8');
  assert.equal(r.launches.length,4);const [,previous,current,rollback]=r.launches;
  assert.equal(previous.binarySha256,r.previousReceipt.sha256);assert.equal(current.binarySha256,r.binarySha256);
  assert.notEqual(previous.binarySha256,current.binarySha256);assert.equal(previous.imported,true);
  assert.equal(current.imported,false);assert.equal(current.resumed,true);
  assert.equal(rollback.binarySha256,previous.binarySha256);assert.equal(rollback.imported,true);assert.equal(rollback.resumed,false);
  assert.equal(r.authUsersAfterReopen,1);assert.equal(r.storageBytesExact,true);assert.equal(r.localWritesPreserved,true);assert.equal(r.seedSeparateFromExport,true);
  assert.deepEqual(r.pageErrors,[]);assert.deepEqual(r.events.listenerErrors,[]);
  for(const mode of ['long-poll','stream'])for(const target of ['items','other'])for(const value of [0,1,2]){
    assert(r.events.seen.some(event=>event.mode===mode&&event.target===target&&!event.cache&&event.values.includes(value)));
  }
});
