import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {gunzipSync} from 'node:zlib';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function load(name) {
  const root = new URL(`../fixtures/firebase-suite-v1/${name}/`, import.meta.url);
  const bytes = readFileSync(new URL('fixture.json', root));
  assert.equal(readFileSync(new URL('SHA256SUMS', root), 'utf8'), `${digest(bytes)}  fixture.json\n`);
  const fixture = JSON.parse(bytes);
  assert.equal(fixture.target, 'official-firebase-tools-storage-emulator');
  assert.equal(fixture.targetVersion, '15.22.0');
  assert.equal(fixture.syntheticOnly, true);
  assert.equal(fixture.credentialsStored, false);
  assert.equal(fixture.bucket, 'synthetic-objects.example.test');
  assert.match(fixture.projectId, /^demo-fireside-storage-/);
  assert.ok(Number.isFinite(Date.parse(fixture.capturedAt)));
  assert.ok(Object.keys(fixture.sourceHashes).length >= 3);
  for (const hash of Object.values(fixture.sourceHashes)) assert.match(hash, /^[a-f0-9]{64}$/);
  verifyBodies(fixture);
  return fixture;
}

function verifyBodies(value) {
  if (!value || typeof value !== 'object') return;
  if (typeof value.base64 === 'string') {
    const bytes = Buffer.from(value.base64, 'base64');
    assert.equal(bytes.length, value.byteLength);
    assert.equal(digest(bytes), value.sha256);
  }
  for (const child of Object.values(value)) verifyBodies(child);
}

test('fresh synthetic gzip capture covers five upload/copy paths and both download APIs', () => {
  const fixture = load('storage-content-encoding');
  assert.deepEqual(fixture.objects.map(object => object.name), [
    'gcs-resumable.json', 'gcs-multipart.json', 'firebase-multipart.json',
    'firebase-resumable.json', 'gcs-copy.json',
  ]);
  const expectedJson = JSON.parse(Buffer.from(fixture.json.base64, 'base64'));
  assert.equal(expectedJson.synthetic, true);
  assert.deepEqual(expectedJson.catalogue, ['火', '🔥', 'café']);
  for (const object of fixture.objects) {
    assert.equal(object.observations.length, 12);
    for (const api of ['gcs', 'firebase']) {
      const observations = object.observations.filter(observation => observation.api === api);
      assert.deepEqual(observations.map(observation => observation.kind),
        ['metadata', 'gzip', 'decoded', 'gzip-range', 'decoded-range', 'browser']);
      for (const observation of observations) {
        assert.equal(observation.status, observation.kind === 'gzip-range' ? 206 : 200);
        const bytes = Buffer.from(observation.body.base64, 'base64');
        if (observation.kind === 'browser') assert.deepEqual(JSON.parse(gunzipSync(bytes)), expectedJson);
        if (observation.kind.startsWith('decoded')) {
          assert.deepEqual(JSON.parse(bytes), expectedJson);
          assert.equal(observation.headers['content-encoding'], undefined);
          assert.equal(observation.headers['content-range'], undefined);
        }
      }
    }
  }
  assert.equal(fixture.exported.length, 5);
  for (const object of fixture.exported) {
    assert.deepEqual(JSON.parse(Buffer.from(object.body.base64, 'base64')), object.metadata);
    for (const field of ['contentType', 'contentEncoding', 'cacheControl', 'contentDisposition', 'contentLanguage']) {
      assert.equal(object.metadata[field], fixture.metadata[field]);
    }
  }
  for (const record of fixture.recordings) {
    if (record.requestHeaders.authorization !== undefined) assert.equal(record.requestHeaders.authorization, 'Bearer owner');
    assert.match(record.requestHeaders.host, /^127\.0\.0\.1:\d+$/);
  }
});

test('fresh synthetic pagination capture crosses the default 1000-object boundary', () => {
  const fixture = load('storage-list-pagination');
  assert.equal(fixture.objectCorpus.count, 1002);
  assert.equal(fixture.sdkAutopagination.count, 1002);
  assert.equal(fixture.observations.length, 10);
  assert.equal(fixture.invariants.defaultPageSize, 1000);
  for (const name of ['pageTokenIsNextObjectName', 'pageTokenIsInclusiveOnResume',
    'unknownPageTokenRestartsAtFirstItem', 'gcsAndFirebaseRoutesSharePagination',
    'sdkAutopaginationReturnsAllObjects']) assert.equal(fixture.invariants[name], true);
  for (const api of ['gcs', 'firebase']) {
    assert.equal(fixture.observations.find(item => item.id === `${api}-default-first`).itemCount, 1000);
    assert.equal(fixture.observations.find(item => item.id === `${api}-default-second`).itemCount, 2);
  }
});

test('fresh missing-object capture records HTTP 404 rather than a browser network failure', () => {
  const fixture = load('storage-missing-object');
  assert.equal(fixture.object, 'samples/missing/picture.png');
  assert.equal(fixture.probes.length, 4);
  for (const probe of fixture.probes) assert.equal(probe.status, 404);
  assert.equal(fixture.browser.domEvent, 'error');
  assert.deepEqual(fixture.browser.events, [{kind: 'response', status: 404, statusText: 'Not Found'}]);
});
