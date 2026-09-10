import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {test} from 'node:test';

test('Storage profile preserves all paired operations, decoded bytes and native-only samples', async () => {
  const root = new URL('../../', import.meta.url);
  const hash = value => createHash('sha256').update(value).digest('hex');
  const contractBytes = await readFile(new URL('benchmarks/phase-e-storage-profile.json', root));
  const contract = JSON.parse(contractBytes);
  assert.equal(hash(contractBytes), 'd77c372793f7a9316b5a6ecd90ce2fa1a546987e68b9a1135d053539ab003c7d');
  const sums = (await readFile(new URL('benchmarks/results/phase-e/SHA256SUMS', root), 'utf8')).trim().split('\n');
  const load = async name => {
    const bytes = await readFile(new URL('benchmarks/results/phase-e/' + name, root));
    assert(sums.includes(hash(bytes) + '  ' + name));
    return JSON.parse(gunzipSync(bytes));
  };
  let lastFinished = 0;
  for (const pair of [1, 2, 3]) for (const variant of pair === 2 ? ['candidate', 'published'] : ['published', 'candidate']) {
    const prefix = `storage-pair${pair}-${variant}`;
    const binary = variant === 'published'
      ? '82a8f81e31b0b62a21c3c1d8e531b93ec72edf496c9c10d1fee735760a248054'
      : '63df176389dd697c9057777d570eecde7ef46ae9215d1538b4c454f4b5b91145';
    for (const phase of ['first-import', 'native-reopen']) {
      const r = await load(`${prefix}-${phase}.json.gz`);
      assert.equal(r.passed, true); assert.equal(r.acceptance, false);
      assert.equal(r.phase, phase); assert.equal(r.binarySha256, binary);
      assert.equal(r.helperSha256, 'aa8c01e0ea3c1bec9fab1e2403f790759bba15c977b2e567519504af46fa57c8');
      assert.equal(r.contractSha256, hash(contractBytes));
      assert.equal(r.sdkVersion, '7.22.0'); assert.equal(r.nativeRssOnly, true);
      assert.equal(r.oracleSha256, '0601c8430b9019733db4d3ac9937a470fc878e4490e32c13ac852e616e4d9ecc');
      assert(Date.parse(r.startedAt) > lastFinished);
      lastFinished = Date.parse(r.finishedAt);
      assert(r.rss.length > 0 && r.rss.every(sample => Number.isSafeInteger(sample.bytes) && sample.bytes > 0));
      assert.equal(r.sampledPeakNativeRssBytes, Math.max(...r.rss.map(sample => sample.bytes)));
      assert.deepEqual(r.payloads.map(payload => payload.entries), [16, 1024]);
      for (const payload of r.payloads) {
        const bytes = Buffer.from(JSON.stringify({synthetic: true,
          values: Array.from({length: payload.entries}, (_, index) => hash('profile-item-' + index))}));
        assert.equal(payload.byteLength, bytes.length); assert.equal(payload.sha256, hash(bytes));
        assert.equal(payload.cycles.length, contract.warmupCyclesPerPayload + contract.measuredCyclesPerPayload);
        for (const [index, cycle] of payload.cycles.entries()) {
          assert.equal(cycle.index, index); assert.equal(cycle.warmup, index < contract.warmupCyclesPerPayload);
          assert.equal(cycle.cleaned, true); assert.equal(cycle.decodedSha256, payload.sha256);
          assert.deepEqual(Object.keys(cycle.operations), ['uploadMilliseconds', 'metadataMilliseconds', 'downloadMilliseconds', 'deleteAndVerifyMilliseconds']);
          assert(Object.values(cycle.operations).every(value => Number.isFinite(value) && value >= 0));
          assert(cycle.totalMilliseconds >= Object.values(cycle.operations).reduce((sum, value) => sum + value, 0));
        }
      }
    }
    const lifecycle = await load(`${prefix}-lifecycle.json.gz`);
    assert.equal(lifecycle.passed, true); assert.equal(lifecycle.acceptance, false);
    assert.equal(lifecycle.binarySha256, binary);
    assert.equal(lifecycle.driverSha256, '060529fe29618883136b1a35d40432165f6c213a6fc36c558bb7ed1d5224e197');
    assert.equal(lifecycle.liveBrowserReconnected, true);
    assert.equal(lifecycle.localWritesPreserved, true); assert.equal(lifecycle.storageBytesExact, true);
    assert.equal(lifecycle.nativeReceiptUnchanged, true); assert.deepEqual(lifecycle.pageErrors, []);
    assert.equal(lifecycle.authUsersAfterReopen, 1);
    assert.deepEqual(lifecycle.modes, ['long-poll', 'stream']);
    assert.deepEqual(lifecycle.targets, ['items', 'other']);
    assert.equal(lifecycle.launches[1].imported, true);
    assert.equal(lifecycle.launches[2].imported, false); assert.equal(lifecycle.launches[2].resumed, true);
  }
});
