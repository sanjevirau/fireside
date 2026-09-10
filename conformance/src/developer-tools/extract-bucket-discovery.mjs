// Recover the omitted /b observation from the original independent UI HAR.
// Usage: node extract-bucket-discovery.mjs original.har fresh-output
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
const [input,output]=process.argv.slice(2);assert(input&&output);
const bytes=await readFile(input),har=JSON.parse(bytes);
const entries=har.log.entries.filter(e=>new URL(e.request.url).pathname==='/b');
assert.equal(entries.length,2);
const exchanges=entries.map(e=>{
  assert.equal(e.response.status,200);
  const body=JSON.parse(e.response.content.text);
  assert.equal(body.items.length,1);
  for(const item of body.items){
    assert.equal(item.name,'demo-fireside-developer-tools.appspot.com');
    const link=new URL(item.selfLink);assert.equal(link.hostname,'127.0.0.1');
    item.selfLink='<storage-origin>'+link.pathname;
    item.timeCreated='<timestamp>';item.updated='<timestamp>';
  }
  return {method:e.request.method,path:'/b',status:e.response.status,response:body};
});
const fixture={schemaVersion:1,oracle:{firebaseTools:'15.22.0',ui:'1.15.0'},
  sourceHarSha256:createHash('sha256').update(bytes).digest('hex'),
  scope:'Default bucket discovery from the original independent developer-tools UI recording; not a bucket lifecycle or multi-tenant claim',exchanges};
await mkdir(resolve(output));
const text=JSON.stringify(fixture,null,2)+'\n';
await writeFile(join(output,'fixture.json'),text);
await writeFile(join(output,'SHA256SUMS'),createHash('sha256').update(text).digest('hex')+'  fixture.json\n');
