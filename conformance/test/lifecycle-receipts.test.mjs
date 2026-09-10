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
test('real isolated ENOSPC preserves acknowledged state and fences ambiguous writes',async()=>{
  const first=await receipt('export-enospc-r1.json','c1f9d0970e6977df15c58fb3460838f75d572f1452397f7beac71a36a31f261f');
  const exported=await receipt('export-enospc-r2.json','441e2d523ef5ece9b49dc02827962030c94a1fb0dc16e7af0e387a99e2c6a0e5');
  const nativeFirst=await receipt('native-enospc-r1.json','270d26bd5a7c8a5ed1cd2e45097823023b2966d815b5a7308ac93380a474f133');
  const native=await receipt('native-enospc-r2.json','b27739911abedefc259f6c15aaab5c34416834a02eab6a800dff647cdff817a9');
  assert.equal(first.passed,false);assert(first.filesystem.availableAtExportBytes>0);
  assert.deepEqual(first.failedExportExit,[0,null]); // Insufficient fault injection, not a product failure.
  assert.equal(nativeFirst.passed,false);assert.match(nativeFirst.writeFence.body,/reopen the store to recover before writing/);
  for(const r of [first,exported,nativeFirst,native]){
    assert.equal(r.syntheticOnly,true);assert.equal(r.acceptance,false);
    assert.equal(r.binarySha256,'5a54dd47c72b3865506d8fe18a88abc1a0734c4b35b34967111eea60f15ad91e');
    assert.equal(r.filesystem.observedWriteError,'ENOSPC');assert(r.filesystem.capacityBytes<=67108864);
  }
  for(const r of [exported,native]){
    assert.equal(r.passed,true);assert.equal(r.filesystem.availableAtExportBytes,0);
    assert.deepEqual(r.failedExportExit,[1,null]);assert.equal(r.functionsDrained,true);
    assert.deepEqual(r.openPorts,[]);assert.equal(r.locatorRemaining,false);
    assert.equal(r.nativeReceiptRetained,true);assert.equal(r.incompleteExportNotPublished,true);
    assert.equal(r.acknowledgedWriteRecovered,true);assert.equal(r.launches[1].resumed,true);
    assert.deepEqual(r.recoveryExit,[0,null]);assert.equal(r.completedRecoveryExport,true);
  }
  assert.equal(exported.filesystem.separateFromWorkingState,true);
  assert.equal(native.filesystem.separateFromWorkingState,false);
  for(const response of Object.values(native.fullDiskRequests)){
    assert(response.status>=400&&response.status<600);assert.match(response.body,/No space left on device/);
  }
  assert.equal(native.writeFence.status,503);assert.match(native.writeFence.body,/reopen the store to recover before writing/);
  assert.equal(native.onlySyntheticFillerRemoved,true);assert.equal(native.acknowledgedAuthAndStorageRecovered,true);
  assert.equal(native.writesResumeAfterRecovery,true);
  assert.deepEqual(native.unacknowledgedBatchRecoveredStatuses,[404,404]);
  assert.equal(native.unacknowledgedObjectRecoveredStatus,404);
});
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
