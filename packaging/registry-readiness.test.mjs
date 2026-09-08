import test from 'node:test';
import assert from 'node:assert/strict';
import { probeRegistry, waitForRegistry, publishVerifiedRelease, TransientRegistryRead } from './registry-readiness.mjs';

const native = {name:'@fireside-dev/linux-x64',version:'0.1.0-next.0',integrity:'sha512-tested'};
const cli = {...native,name:'@fireside-dev/cli'};
const version = record => ({name:record.name,version:record.version,dist:{integrity:record.integrity}});
const index = record => ({versions:{[record.version]:version(record)},'dist-tags':{next:record.version}});
const response = (status, body) => async () => ({status,json:async()=>body});

test('accepted version is verifiable while the install index is still hidden', async () => {
  assert.deepEqual(await probeRegistry(native,'version',response(200,version(native))),version(native));
  assert.equal(await probeRegistry(native,'index',response(404)),null);
  assert.deepEqual(await probeRegistry(native,'index',response(200,index(native))),index(native));
});

test('identity, integrity and next-tag mismatches fail immediately', async () => {
  for (const body of [{...version(native),name:'wrong'}, {...version(native),version:'other'}, {...version(native),dist:{integrity:'sha512-wrong'}}]) {
    await assert.rejects(probeRegistry(native,'version',response(200,body)));
  }
  await assert.rejects(probeRegistry(native,'index',response(200,{...index(native),'dist-tags':{next:'other'}})));
  await assert.rejects(probeRegistry(native,'version',response(403)));
});

test('only transient transport/status problems become retryable reads', async () => {
  await assert.rejects(probeRegistry(native,'version',response(503)),TransientRegistryRead);
  await assert.rejects(probeRegistry(native,'version',async()=>{throw Error('offline');}),TransientRegistryRead);
  await assert.rejects(probeRegistry(native,'version',async()=>({status:200,json:async()=>{throw new SyntaxError('bad JSON');}})),SyntaxError);
});

test('bounded availability wait tolerates scanning and transient reads without writes', async () => {
  let elapsed=0,calls=0;
  const verified=await waitForRegistry([native],'index',{
    now:()=>elapsed,sleep:async ms=>{elapsed+=ms;},intervalMs:5,timeoutMs:20,report:()=>{},
    probe:async()=>{calls++;if(calls===1)throw new TransientRegistryRead('offline');return calls<3?null:index(native);},
  });
  assert.equal(calls,3);assert.equal(elapsed,10);assert.deepEqual(verified.get(native.name),index(native));
});

test('timeout preserves partial publication and integrity errors are not retried', async () => {
  let elapsed=0;
  await assert.rejects(waitForRegistry([native],'index',{
    now:()=>elapsed,sleep:async ms=>{elapsed+=ms;},intervalMs:5,timeoutMs:10,report:()=>{},probe:async()=>null,
  }),/Preserve accepted uploads/);
  await assert.rejects(waitForRegistry([native],'index',{
    probe:async()=>{throw Error('integrity mismatch');},sleep:async()=>assert.fail('must not retry'),
  }),/integrity mismatch/);
});

test('native scans overlap, all native indexes precede CLI upload, resume skips accepted bytes', async () => {
  const second={...native,name:'@fireside-dev/linux-arm64'};
  const events=[];
  const result=await publishVerifiedRelease([native,second,cli],{
    probe:async record=>record===native?version(record):null,
    publish:async record=>events.push(`publish:${record.name}`),
    wait:async(records,kind)=>{events.push(`wait:${kind}:${records.map(r=>r.name).join(',')}`);return new Map(records.map(r=>[r.name,index(r)]));},
  });
  assert.deepEqual(events,[
    `publish:${second.name}`,
    `wait:index:${native.name},${second.name}`,
    `publish:${cli.name}`,`wait:index:${cli.name}`,
  ]);
  assert.equal(result.size,3);
});

test('an acknowledged upload is never retried when its readback times out', async () => {
  let uploads=0;
  await assert.rejects(publishVerifiedRelease([native,cli],{
    probe:async()=>null,publish:async()=>{uploads++;},wait:async()=>{throw Error('read timeout');},
  }),/read timeout/);
  assert.equal(uploads,1);
});

test('recovery never republishes a previously acknowledged but still hidden upload', async () => {
  let uploads=0;
  await assert.rejects(publishVerifiedRelease([native,cli],{
    accepted:[native.name], probe:async()=>null,
    publish:async()=>{uploads++;}, wait:async()=>{throw Error('still scanning');},
  }),/still scanning/);
  assert.equal(uploads,0);
});

test('an ambiguous publish failure stops without retry or CLI upload', async () => {
  let uploads=0;
  await assert.rejects(publishVerifiedRelease([native,cli],{
    probe:async()=>null, publish:async()=>{uploads++;throw Error('connection lost after upload');},
    wait:async()=>assert.fail('inspect the ambiguous write before recovery'),
  }),/connection lost/);
  assert.equal(uploads,1);
});

test('automatic prerelease latest requires owner review, not another upload', async () => {
  await assert.rejects(publishVerifiedRelease([native,cli],{
    probe:async record=>version(record),publish:async()=>assert.fail('already accepted'),
    wait:async records=>new Map(records.map(r=>[r.name,{...index(r),'dist-tags':{next:r.version,latest:r.version}}])),
  }),/Release owner must review/);
});
