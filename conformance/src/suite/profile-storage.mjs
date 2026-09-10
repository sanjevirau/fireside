// Optional synthetic measurement; the caller owns and shuts down the suite.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile, realpath, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import os from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';

const exec = promisify(execFile);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export async function profileStorage({pid, binary, dependencies, origin, project, bucket, output, phase}) {
  assert.equal(new URL(origin).hostname, '127.0.0.1', 'synthetic loopback only');
  assert(Number.isSafeInteger(pid) && pid > 1, 'owned native PID required');
  const contractBytes = await readFile(new URL('../../../benchmarks/phase-e-storage-profile.json', import.meta.url));
  const contract = JSON.parse(contractBytes);
  const oracleBytes = await readFile(new URL('../../fixtures/firebase-suite-v1/storage-content-encoding/fixture.json', import.meta.url));
  const oracle = JSON.parse(oracleBytes);
  const require = createRequire(await realpath(dependencies + '/node_modules/firebase-functions/package.json'));
  const sdkVersion = require('@google-cloud/storage/package.json').version;
  assert.equal(sdkVersion, oracle.sdkVersions.googleCloudStorage);
  const {Storage} = require('@google-cloud/storage');
  const priorHost = process.env.STORAGE_EMULATOR_HOST;
  process.env.STORAGE_EMULATOR_HOST = origin;
  const storage = new Storage({projectId: project, apiEndpoint: origin,
    timeout: contract.requestDeadlineMilliseconds, retryOptions: {autoRetry: false, maxRetries: 0}});
  const receipt = {passed: false, acceptance: false, syntheticOnly: true, phase,
    startedAt: new Date().toISOString(), node: process.version, sdkVersion,
    host: {platform: os.platform(), release: os.release(), arch: os.arch(), totalMemoryBytes: os.totalmem()},
    binarySha256: sha(await readFile(binary)), contractSha256: sha(contractBytes),
    oracleSha256: sha(oracleBytes), helperSha256: sha(await readFile(new URL(import.meta.url))),
    pid, rssSampleIntervalMilliseconds: 100, nativeRssOnly: true,
    includesClientWorkInLatency: true, retriesDisabled: true, rss: [], payloads: []};
  let sampling = true;
  const sample = async () => {
    while (sampling) {
      const {stdout} = await exec('ps', ['-o', 'rss=', '-p', String(pid)], {timeout: 2000});
      const bytes = Number(stdout.trim()) * 1024;
      assert(Number.isSafeInteger(bytes) && bytes > 0, 'native RSS must be available');
      receipt.rss.push({at: new Date().toISOString(), bytes});
      await delay(100);
    }
  };
  // Capture sampling failures immediately, without an unhandled rejection.
  let samplingError;
  const sampler = sample().catch(error => {samplingError = error;});
  const request = async path => fetch(origin + path, {
    headers: {authorization: 'Bearer owner', 'accept-encoding': 'gzip'},
    signal: AbortSignal.timeout(contract.requestDeadlineMilliseconds)});
  let failure;
  try {
    await delay(contract.settleMilliseconds);
    for (const entries of [16, 1024]) {
      const bytes = Buffer.from(JSON.stringify({synthetic: true,
        values: Array.from({length: entries}, (_, n) => sha('profile-item-' + n))}));
      const payload = {entries, byteLength: bytes.length, sha256: sha(bytes), cycles: []};
      receipt.payloads.push(payload);
      for (let index = 0; index < contract.warmupCyclesPerPayload + contract.measuredCyclesPerPayload; index++) {
        const name = `profile/${phase}/${entries}/${index}.json`;
        const file = storage.bucket(bucket).file(name);
        const path = `/v0/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(name)}`;
        const cycle = {index, warmup: index < contract.warmupCyclesPerPayload, operations: {}};
        payload.cycles.push(cycle);
        const cycleStart = performance.now();
        let start = performance.now();
        await file.save(bytes, {gzip: true, resumable: true,
          timeout: contract.requestDeadlineMilliseconds,
          metadata: {contentType: 'application/json', cacheControl: oracle.metadata.cacheControl}});
        cycle.operations.uploadMilliseconds = performance.now() - start;
        start = performance.now();
        const metadataResponse = await request(path);
        assert.equal(metadataResponse.status, 200);
        const metadata = await metadataResponse.json();
        assert.equal(metadata.contentEncoding, 'gzip');
        assert.equal(metadata.cacheControl, oracle.metadata.cacheControl);
        cycle.operations.metadataMilliseconds = performance.now() - start;
        start = performance.now();
        const response = await request(path + '?alt=media');
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-encoding'), 'gzip');
        const decoded = Buffer.from(await response.arrayBuffer());
        assert.deepEqual(decoded, bytes);
        assert.deepEqual(JSON.parse(decoded), JSON.parse(bytes));
        cycle.operations.downloadMilliseconds = performance.now() - start;
        cycle.decodedSha256 = sha(decoded);
        start = performance.now();
        await file.delete();
        const missing = await request(path);
        assert.equal(missing.status, 404);
        await missing.arrayBuffer();
        cycle.operations.deleteAndVerifyMilliseconds = performance.now() - start;
        cycle.totalMilliseconds = performance.now() - cycleStart;
        cycle.cleaned = true;
      }
    }
    await delay(contract.settleMilliseconds);
  } catch (error) {failure = error;}
  finally {
    sampling = false;
    await sampler;
    if (priorHost === undefined) delete process.env.STORAGE_EMULATOR_HOST;
    else process.env.STORAGE_EMULATOR_HOST = priorHost;
    failure ??= samplingError;
    receipt.passed = !failure;
    receipt.finishedAt = new Date().toISOString();
    receipt.sampledPeakNativeRssBytes = Math.max(0, ...receipt.rss.map(item => item.bytes));
    if (failure) receipt.error = String(failure);
    await writeFile(output, JSON.stringify(receipt, null, 2) + '\n', {flag: 'wx'});
  }
  if (failure) throw failure;
  return {path: output, sha256: sha(await readFile(output)), phase, passed: true};
}
