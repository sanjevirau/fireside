import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function normalizeCapture(record,work,ports) {
  const ids=new Map();
  function normalize(value,key='') {
    if(Array.isArray(value))return value.map(item=>normalize(item,key));
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,normalize(v,k)]));
    if(key==='requestId'&&typeof value==='string'){
      if(!ids.has(value))ids.set(value,`request-${ids.size+1}`);return ids.get(value);
    }
    if(typeof value==='string')return value.replaceAll(work,'<oracle-workdir>')
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g,'<timestamp>')
      .replace(/cloud\.firestore\d+/g,'cloud.firestore<release-id>');
    if(key==='pid')return '<oracle-pid>';
    if(['port','webSocketPort','reservedPorts'].includes(key))return Object.entries(ports).find(([,p])=>p===value)?.[0]??value;
    return value;
  }
  const normalized=normalize(record);
  normalized.capturedAt=record.capturedAt;
  normalized.normalization={generatedRequestIds:'stable encounter-order IDs shared by live and replay frames',
    timestamps:'<timestamp>, except capture provenance',paths:'isolated oracle workdir only',ports:'service names',
    html:'status/headers, raw body SHA-256/byte count, title and embedded coverage data; no vendored renderer source',
    credentials:'Auth password/token fields omitted from browser API transcripts; synthetic identities only',
    lengths:'HTTP content-length describes the original response, before normalization'};
  for (const observation of normalized.observations) {
    delete observation.elapsedMs;
    if(observation.id==='coverage-html') {
      const original=record.observations.find(o=>o.id==='coverage-html').body;
      const match=original.match(/const data = ([\s\S]*?);\s*\n/);
      assert.ok(match,'pinned official HTML embeds coverage data');
      observation.body={byteLength:Buffer.byteLength(original),sha256:createHash('sha256').update(original).digest('hex'),
        title:original.match(/<title>([^<]+)<\/title>/)[1],embeddedCoverage:normalize(JSON.parse(match[1]))};
    }
  }
  delete normalized.readyMs;delete normalized.shutdownMs;
  return normalized;
}
export async function writeFixture(record,work,ports,output) {
  const bytes=JSON.stringify(normalizeCapture(record,work,ports),null,2)+'\n';
  await writeFile(join(output,'fixture.json'),bytes,{flag:'wx'});
  await writeFile(join(output,'SHA256SUMS'),createHash('sha256').update(bytes).digest('hex')+'  fixture.json\n',{flag:'wx'});
}
