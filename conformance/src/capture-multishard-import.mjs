// Construct a four-shard input from an existing synthetic official export, then
// record what the official importer accepts. This is NOT an observed multi-shard
// export and must never be described as one. No Fireside encoder is involved.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,mkdtemp,copyFile,readdir} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const source=join(root,'fixtures/official-export-v1.22.0/firestore_export');
const output=join(root,'fixtures/firebase-suite-v1/firestore-multi-shard-export-metadata');
await mkdir(output,{recursive:true});assert.deepEqual(await readdir(output),[],'never overwrite evidence');
const temporary=await mkdtemp(join(tmpdir(),'fireside-multishard-'));
const kindPath='all_namespaces/all_kinds/all_namespaces_all_kinds.export_metadata';
const overall='firestore_export.overall_export_metadata';
const exportRoot=join(temporary,'firestore_export');
await mkdir(join(exportRoot,'all_namespaces/all_kinds'),{recursive:true});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const log=await readFile(join(source,'all_namespaces/all_kinds/output-0'));
assert.equal(sha(log),'304668940b2b4a613801d6ec12df159e1b86e09b739c7219f695ae81e7392ad7');
const records=[];let pieces=[];
for(let block=0;block<log.length;block+=32768){
  const end=Math.min(block+32768,log.length);let pos=block;
  while(pos+7<=end){
    const size=log.readUInt16LE(pos+4),kind=log[pos+6];if(size===0&&kind===0)break;
    assert.ok(pos+7+size<=end);const bytes=log.subarray(pos+7,pos+7+size);
    assert.equal(log.readUInt32LE(pos),maskedCrc(Buffer.concat([Buffer.from([kind]),bytes])));
    if(kind===1){assert.equal(pieces.length,0);records.push(bytes);}
    else if(kind===2){assert.equal(pieces.length,0);pieces=[bytes];}
    else {assert.ok(pieces.length);assert.ok(kind===3||kind===4);pieces.push(bytes);if(kind===4){records.push(Buffer.concat(pieces));pieces=[];}}
    pos+=7+size;
  }
}
assert.equal(pieces.length,0);assert.equal(records.length,4);
const sourceMetadata=await readFile(join(source,kindPath));
assert.equal(sourceMetadata[0],10);assert.equal(sourceMetadata[1],36);
const shard=Buffer.concat([Buffer.from([10,0]),...records.map((_,i)=>Buffer.concat([Buffer.from([18,8]),Buffer.from(`output-${i}`)]))]);
const metadata=Buffer.concat([sourceMetadata.subarray(0,38),Buffer.from([18,shard.length]),shard]);
await writeFile(join(exportRoot,kindPath),metadata);
await copyFile(join(source,overall),join(exportRoot,overall));
const inputFiles=[];
for(let i=0;i<records.length;i++){
  const bytes=encodeLog(records[i]);const name=`output-${i}`;
  await writeFile(join(exportRoot,'all_namespaces/all_kinds',name),bytes);
  inputFiles.push({name,byteLength:bytes.length,sha256:sha(bytes)});
}
const jar=join(process.env.HOME,'.cache/firebase/emulators/cloud-firestore-emulator-v1.22.0.jar');
const jarSha=sha(await readFile(jar));assert.equal(jarSha,'9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c');
const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const {port}=server.address();await new Promise(done=>server.close(done));
let logs='';const child=spawn(process.env.JAVA??'java',['-jar',jar,'--host','127.0.0.1','--port',String(port),'--project_id','demo-fireside-export-oracle','--seed_from_export',join(exportRoot,overall)],{cwd:temporary,stdio:['ignore','pipe','pipe']});
const exited=once(child,'exit');child.stdout.on('data',data=>logs+=data);child.stderr.on('data',data=>logs+=data);
try {
  const deadline=Date.now()+45000;
  while(true){assert.equal(child.exitCode,null,logs);try {const response=await fetch(`http://127.0.0.1:${port}`);if(response.ok)break;}catch{}assert.ok(Date.now()<deadline,logs);await new Promise(done=>setTimeout(done,100));}
  const check=spawn(process.execPath,['--import','tsx','src/assert-export-import.ts'],{cwd:root,env:{...process.env,CONFORMANCE_TARGET:'java',GCLOUD_PROJECT:'demo-fireside-export-oracle',FIRESTORE_EMULATOR_HOST:`127.0.0.1:${port}`},stdio:['ignore','pipe','pipe']});
  let verification='';check.stdout.on('data',data=>verification+=data);check.stderr.on('data',data=>verification+=data);
  const [code]=await once(check,'exit');assert.equal(code,0,verification);
  const fixture={schemaVersion:1,syntheticOnly:true,target:'official-firestore-emulator-import',targetVersion:'1.22.0',javaJarSha256:jarSha,capturedAt:new Date().toISOString(),construction:'Four existing synthetic official entity records independently reframed one per LevelDB shard; metadata lists all four. Constructed input, not captured export output.',sourceLogSha256:sha(log),kindMetadataHex:metadata.toString('hex'),inputFiles,observations:{importAccepted:true,verifiedDocuments:4,fieldAssertions:'assert-export-import.ts: scalar, Unicode, nested, reference, bytes, vector and large document',verifierSha256:sha(await readFile(join(root,'src/assert-export-import.ts')))}};
  const json=JSON.stringify(fixture,null,2)+'\n';await writeFile(join(output,'fixture.json'),json,{flag:'wx'});await writeFile(join(output,'SHA256SUMS'),`${sha(json)}  fixture.json\n`,{flag:'wx'});
  console.log(JSON.stringify({passed:true,diagnosticsDirectory:temporary}));
}finally{if(child.exitCode===null){child.kill('SIGTERM');await exited;}await writeFile(join(temporary,'capture.log'),logs);}

function maskedCrc(bytes){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0x82f63b78:0);}crc=(~crc)>>>0;return (((crc>>>15)|(crc<<17))+0xa282ead8)>>>0;}
function encodeLog(record){const chunks=[];let offset=0;while(offset<record.length){const size=Math.min(32761,record.length-offset);const last=offset+size===record.length;const kind=offset===0?(last?1:2):(last?4:3);const bytes=record.subarray(offset,offset+size);const header=Buffer.alloc(7);header.writeUInt32LE(maskedCrc(Buffer.concat([Buffer.from([kind]),bytes])));header.writeUInt16LE(size,4);header[6]=kind;chunks.push(header,bytes);offset+=size;}return Buffer.concat(chunks);}
