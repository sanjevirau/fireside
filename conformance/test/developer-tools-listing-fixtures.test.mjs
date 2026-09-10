import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
test('REST listing fixture preserves pinned oracle identity, success, denial and malformed-input timeout',async()=>{
  const root=new URL('../fixtures/developer-tools-listing-v1/',import.meta.url);
  const bytes=await readFile(new URL('fixture.json',root));const fixture=JSON.parse(bytes);
  assert.equal(await readFile(new URL('SHA256SUMS',root),'utf8'),createHash('sha256').update(bytes).digest('hex')+'  fixture.json\n');
  assert.equal(fixture.oracle.firestore,'1.22.0');assert.equal(fixture.oracle.node,'24.20.0');
  assert.equal(fixture.oracle.jarSha256,'9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c');
  assert.equal(fixture.syntheticOnly,true);assert.equal(fixture.exchanges.length,22);
  const row=id=>fixture.exchanges.find(row=>row.id===id);
  assert.equal(row('root-ids-empty-body').body,null);assert.equal(row('root-ids-empty-body').status,200);
  assert.equal(row('ids-anonymous').status,403);assert.equal(row('list-anonymous').status,403);
  assert.equal(row('list-show-missing').response.documents.at(-1).fields,undefined);
  assert.equal(row('list-invalid-size').status,null);assert.equal(row('list-invalid-size').error,'TimeoutError');
  assert.equal(row('list-invalid-size').deadlineMilliseconds,10000);
  for(const kind of ['list','ids'])assert.equal(row(`${kind}-page-2`).previousToken,`${kind}-page-1`);
  assert.ok(!/Bearer |\/Users\/|\/var\/folders\//.test(bytes.toString()));
});

test('UI bucket and Functions lifecycle observations retain exact checksums and pinned peers',async()=>{
  for(const name of ['developer-tools-buckets-v1','developer-tools-functions-lifecycle-v1']){
    const root=new URL(`../fixtures/${name}/`,import.meta.url);
    const bytes=await readFile(new URL('fixture.json',root)),fixture=JSON.parse(bytes);
    assert.equal(await readFile(new URL('SHA256SUMS',root),'utf8'),createHash('sha256').update(bytes).digest('hex')+'  fixture.json\n');
    assert.equal(fixture.oracle.firebaseTools,'15.22.0');
    if(name==='developer-tools-buckets-v1'){
      assert.equal(fixture.oracle.ui,'1.15.0');assert.equal(fixture.exchanges.length,2);
      for(const row of fixture.exchanges){assert.equal(row.path,'/b');assert.equal(row.status,200);assert.equal(row.response.items[0].name,'demo-fireside-developer-tools.appspot.com');}
    }else{
      assert.equal(fixture.oracle.firebaseFunctions,'7.2.5');assert.equal(fixture.passed,true);
      assert.equal(fixture.exchange.status,200);assert.deepEqual(fixture.exchange.body,{synthetic:true});assert.deepEqual(fixture.exit,[0,null]);
      assert.equal(createHash('sha256').update(fixture.source).digest('hex'),fixture.sourceSha256);
    }
    assert.ok(!/Bearer |\/Users\/|\/var\/folders\//.test(bytes.toString()));
  }
});
