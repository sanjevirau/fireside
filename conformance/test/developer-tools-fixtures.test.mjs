import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { normalizeCapture } from '../src/developer-tools/normalize-capture.mjs';

const directory=new URL('../fixtures/developer-tools-v1/',import.meta.url);
const bytes=await readFile(new URL('fixture.json',directory));
const fixture=JSON.parse(bytes);
const observation=id=>fixture.observations.find(o=>o.id===id);
test('typed Requests values preserve the additional live oracle contract',async()=>{
  const root=new URL('../fixtures/developer-tools-request-values-v1/',import.meta.url);
  const bytes=await readFile(new URL('fixture.json',root)), f=JSON.parse(bytes);
  assert.equal(await readFile(new URL('SHA256SUMS',root),'utf8'),createHash('sha256').update(bytes).digest('hex')+'  fixture.json\n');
  assert.equal(f.oracle.jarSha256,'9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c');
  assert.equal(f.oracle.node,'24.20.0');assert.equal(f.oracle.firestore,'1.22.0');assert.equal(f.syntheticOnly,true);
  assert.deepEqual(f.messages[0],[]);assert.equal(f.operations.length,6);assert.equal(f.messages.length,8);
  assert.ok(!/Bearer |\/Users\/|\/var\/folders\//.test(bytes.toString()));
  const event=id=>f.messages[f.operations.find(o=>o.id===id).firstMessage];
  const fields=event('create-typed').rulesContext.request.mapValue.fields.resource.mapValue.fields.data.mapValue.fields;
  assert.equal(fields.integer.intValue,'9007199254740993');assert.equal(fields.double.floatValue,1.25);
  assert.equal(fields.nan.floatValue,'NaN');assert.equal(fields.infinity.floatValue,'Infinity');
  assert.equal(fields.negativeInfinity.floatValue,'-Infinity');assert.equal(fields.bytes.bytesValue,'AAEC/w==');
  assert.equal(fields.timestamp.timestampValue,'2020-01-02T03:04:05.123456Z');
  assert.deepEqual(fields.emptyList,{listValue:{}});assert.deepEqual(fields.emptyMap,{mapValue:{}});
  assert.deepEqual(fields.point.latlngValue,{latitude:1.25,longitude:-2.5});
  assert.equal(fields.reference.pathValue.segments[0].simple,'databases');
  assert.deepEqual(fields.list.listValue.values,[{intValue:'1'},{stringValue:'🚀'},{nullValue:null}]);
  assert.equal(event('get-authenticated').rulesContext.request.mapValue.fields.auth.mapValue.fields.uid.stringValue,'synthetic-reader');
  assert.deepEqual(event('get-typed').rulesContext.resource,{undefined:{}});
  const query=event('query').rulesContext.request.mapValue.fields.query.mapValue.fields;
  assert.equal(query.limit.intValue,'2');assert.equal(query.orderBy.mapValue.fields.negative.stringValue,'ASC');
  assert.deepEqual(event('delete').rulesContext.request.mapValue.fields.resource,{nullValue:null});
  assert.equal(f.operations.at(-1).status,404);
});
test('live oracle identity and artifact integrity are pinned',async()=>{
  assert.equal(await readFile(new URL('SHA256SUMS',directory),'utf8'),createHash('sha256').update(bytes).digest('hex')+'  fixture.json\n');
  assert.equal(fixture.syntheticOnly,true);assert.equal(fixture.oracle.launchedJarVerified,true);
  assert.equal(fixture.oracle.firebaseTools,'15.22.0');assert.equal(fixture.oracle.firestore,'1.22.0');assert.equal(fixture.oracle.ui,'1.15.0');
  assert.equal(fixture.oracle.assets['cloud-firestore-emulator-v1.22.0.jar'],'9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c');
  assert.ok(Number.isFinite(Date.parse(fixture.capturedAt)));
  assert.ok(!bytes.toString().includes('/Users/'));assert.ok(!bytes.toString().includes('/var/folders/'));
  assert.ok(!/"(?:idToken|refreshToken|passwordHash|downloadTokens)"/.test(bytes.toString()));
});
test('HTTP decisions distinguish allowed, denied, missing and admin bypass',()=>{
  for(const [id,status] of [['write-visible',200],['write-denied',403],['write-hidden',200],['read-visible',200],['read-hidden',403],['read-missing',403],['read-hidden-admin',200],['list-documents-admin',200]])assert.equal(observation(id).status,status,id);
  assert.equal(observation('write-hidden').admin,true);
  assert.equal(observation('read-hidden-admin').admin,true);
  assert.equal(observation('list-documents-admin').body.documents.length,2);
  assert.equal(observation('write-denied').body.error.status,'PERMISSION_DENIED');
});
test('Requests initial/live/reconnected frames preserve the actual oracle contract',()=>{
  const [initial,...live]=fixture.websocket.firstConnection;
  assert.deepEqual(initial,[]);assert.equal(live.length,10);
  const [history]=fixture.websocket.reconnected;assert.equal(history.length,live.length);
  assert.deepEqual(history.map(v=>v.requestId),live.map(v=>v.requestId));
  assert.equal(new Set(live.map(v=>v.requestId)).size,live.length);
  assert.deepEqual([...new Set(live.map(v=>v.outcome))].sort(),['allow','deny','error']);
  for(const event of live){
    assert.equal(event.rules,fixture.rules);assert.ok(event.rulesReleaseKey.startsWith(`projects/${fixture.project}/`));
    assert.equal(event.rulesReleaseName,undefined,'preserve observed Key, do not silently rename to UI model Name');
    assert.ok(['create','update','get'].includes(event.rulesContext.method));
    assert.equal(event.rulesContext.request.mapValue.fields.auth.nullValue,null);
    for(const outcome of event.granularAllowOutcomes){assert.equal(typeof outcome.line,'number');assert.equal(typeof outcome.outcome,'boolean');}
  }
  assert.ok(history.some((event,i)=>event.granularAllowOutcomes.length>live[i].granularAllowOutcomes.length),'history enrichment is an observed oracle quirk');
  for(let i=0;i<live.length;i++) {
    const {granularAllowOutcomes:before,...restBefore}=live[i];
    const {granularAllowOutcomes:after,...restAfter}=history[i];
    assert.deepEqual(restBefore,restAfter);assert.deepEqual(after.slice(0,before.length),before);
  }
});
test('JSON and HTML coverage retain expression positions, counts and errors',()=>{
  const before=observation('coverage-before').body, after=observation('coverage-after').body;
  assert.equal(before.rules.files[0].content,fixture.rules);
  const count=nodes=>nodes.reduce((sum,n)=>sum+(n.values??[]).reduce((a,v)=>a+v.count,0)+count(n.children??[]),0);
  assert.equal(count(before.report),0);assert.ok(count(after.report)>0);
  assert.ok(after.report.every(node=>node.sourcePosition.line>0&&node.sourcePosition.endOffset>=node.sourcePosition.currentOffset));
  const html=observation('coverage-html');assert.equal(html.status,200);
  assert.equal(html.body.title,'Firestore Rule Coverage Report');assert.match(html.body.sha256,/^[a-f0-9]{64}$/);
  assert.deepEqual(html.body.embeddedCoverage,after);
  assert.ok(fixture.browser.coverage.expressionCount>0);assert.equal(fixture.browser.coverage.rulesVisible,true);
});
test('real UI controls, persisted edits and reload are represented without page errors',()=>{
  assert.deepEqual(fixture.browser.errors,[]);
  assert.equal(fixture.browser.checks.length,14);
  for(const check of ['denied-request-rule-and-context-rendered','request-details-survive-reload-history-replay','document-browse-edit-persisted','auth-create-and-list','auth-clear-control','storage-upload-bytes-preserved','storage-clear-control','logs-history-rendered'])assert.ok(fixture.browser.checks.includes(check),check);
  assert.ok(fixture.browser.exchanges.some(e=>e.service==='auth'&&e.method==='POST'&&e.status===200));
  assert.ok(fixture.browser.exchanges.some(e=>e.service==='storage'&&e.method==='DELETE'&&e.path.endsWith('/synthetic.txt')&&e.status===204));
  assert.ok(fixture.browser.exchanges.some(e=>e.service==='storage'&&e.method==='DELETE'&&e.path.endsWith('/%252f')&&e.status===404),'UI tolerates a missing physical folder marker');
});
test('starting baseline matches its predeclared protocol and retains the unsupported REST observation',async()=>{
  const manifestBytes=await readFile(new URL('../../benchmarks/phase-a-developer-tools.json',import.meta.url));
  const baselineBytes=await readFile(new URL('../../benchmarks/results/phase-a/native-baseline.json',import.meta.url));
  const manifest=JSON.parse(manifestBytes),baseline=JSON.parse(baselineBytes);
  assert.equal(baseline.manifestSha256,createHash('sha256').update(manifestBytes).digest('hex'));
  assert.equal(baseline.engineRevision,manifest.engineBaseline);assert.equal(baseline.passed,true);
  assert.equal(baseline.cycles.length,2);assert.equal(baseline.hostQuiescent,false);
  for(const cycle of baseline.cycles){
    assert.equal(cycle.verifiedDocuments,200);assert.ok(cycle.rssSamples.length>0);
    assert.deepEqual(cycle.exit,{code:null,signal:'SIGINT'},'this is direct native signal termination, not suite export/shutdown');
    assert.equal(cycle.restListDocumentsProbe.status,400);assert.equal(cycle.restListDocumentsProbe.body.error.status,'INVALID_ARGUMENT');
    assert.equal(cycle.operations.filter(o=>o.name==='get').length,40);
    assert.equal(cycle.operations.filter(o=>o.name==='collection-query').length,10);
  }
});
test('normalization preserves related IDs and does not turn HTTP lengths into normalized-body lengths',()=>{
  const normalized=normalizeCapture({capturedAt:'2026-09-10T00:00:00Z',observations:[{id:'synthetic',elapsedMs:1,headers:{'content-length':'123'}}],
    first:{requestId:'same',path:'/isolated/work/rules'},second:{requestId:'same',port:1234},third:{requestId:'other'}},'/isolated/work',{ui:1234});
  assert.equal(normalized.first.requestId,normalized.second.requestId);assert.notEqual(normalized.first.requestId,normalized.third.requestId);
  assert.equal(normalized.first.path,'<oracle-workdir>/rules');assert.equal(normalized.second.port,'ui');
  assert.equal(normalized.observations[0].headers['content-length'],'123');assert.equal(normalized.observations[0].elapsedMs,undefined);
});
