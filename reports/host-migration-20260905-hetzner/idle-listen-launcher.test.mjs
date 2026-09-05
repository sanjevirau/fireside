import assert from 'node:assert/strict';
import test from 'node:test';
import { ROOT } from './hetzner-preflight.mjs';
import { CASES, PINS, TOOLING_FILES, assertSameIdentity, captureBudget, diagnosticConflict, establishIdentity, listenerOwned, parseArguments, procIdentity,
  serverCommand, validateReceipt } from './run-idle-listen-diagnostic.mjs';

const values = ['--output', ROOT + '/attempts/idle-listen-20260906-r1', '--conformance-dir',
  ROOT + '/diagnostic-idle-listen-20260906/tooling/conformance', '--tooling-receipt', '/tmp/tooling.json',
  '--java-jar', '/tmp/cloud-firestore-emulator-v1.21.0.jar', '--port', '23200'];

test('six isolated cases are official first; natural and forced reconnect stay separate', () => {
  assert.deepEqual(CASES, ['official', 'fireside'].flatMap(stack => ['idle-control', 'churn-natural', 'churn-forced'].map(caseName => ({ stack, caseName }))));
});

test('launcher rejects gate paths, reused harnesses, missing jar and app ports', () => {
  assert.equal(parseArguments(values).port, 23200);
  for (const [from, to] of [
    [ROOT + '/attempts/idle-listen-20260906-r1', ROOT + '/attempts/r49'],
    [ROOT + '/diagnostic-idle-listen-20260906/tooling/conformance', ROOT + '/attempts/r48/harness/conformance'],
    ['/tmp/cloud-firestore-emulator-v1.21.0.jar', '/tmp/arbitrary.jar'], ['23200', '23000'], ['23200', '80'],
  ]) assert.throws(() => parseArguments(values.map(value => value === from ? to : value)));
  assert.throws(() => parseArguments([...values, '--port', '23201']));
  assert.throws(() => parseArguments([...values, '--heap', '8g']));
});

test('tooling receipt binds every required source and lock file without path traversal', () => {
  const receipt = { baseCommit: '1'.repeat(40), files: TOOLING_FILES.map(path => ({ path, sha256: '2'.repeat(64) })) };
  validateReceipt(receipt);
  assert.throws(() => validateReceipt({ ...receipt, files: receipt.files.slice(1) }));
  assert.throws(() => validateReceipt({ ...receipt, files: [...receipt.files, { path: '../private', sha256: '2'.repeat(64) }] }));
  assert.throws(() => validateReceipt({ ...receipt, files: [...receipt.files, receipt.files[0]] }));
});

test('server commands use pinned baseline, explicit loopback and fresh disk state without imports or overrides', () => {
  const options = parseArguments(values);
  const directory = options.output + '/04-fireside-idle-control';
  const official = serverCommand('official', options, directory);
  const fireside = serverCommand('fireside', options, directory);
  assert.equal(official.executable, PINS.java);
  assert.deepEqual(official.args, ['-jar', options.jar, '--host', '127.0.0.1', '--port', '23200', '--project_id', PINS.project, '--single_project_mode', 'true', '--database-edition', 'standard']);
  assert.equal(fireside.executable, PINS.fireside);
  assert.deepEqual(fireside.args, ['firestore', '--host', '127.0.0.1', '--port', '23200', '--project_id', PINS.project, '--data-dir', directory + '/state']);
  assert.doesNotMatch(JSON.stringify([official, fireside]), /seed_from_export|Xmx|redb-cache-size|0\.0\.0\.0/);
});

test('PID ownership rejects reuse, changed command, executable and working directory', () => {
  const fields = Array.from({ length: 25 }, (_, i) => i === 19 ? '12345' : '0');
  const original = procIdentity(`42 (server (worker)) ${fields.join(' ')}`, ['/bin/server', '--port', '23200', ''].join('\0'), '/bin/server', '/case');
  assertSameIdentity(original, { ...original });
  for (const changed of [{ startTicks: '99999' }, { command: ['other'] }, { executable: '/bin/other' }, { directory: '/other' }]) {
    assert.throws(() => assertSameIdentity(original, { ...original, ...changed }));
  }
  assert.throws(() => procIdentity('42 (gone)', '', '', ''));
});

test('additional conflict check catches running oracles but not a launcher shell quotation', () => {
  const command = '/pinned/node /tooling/run-idle-listen-diagnostic.mjs --port 23200';
  assert.equal(diagnosticConflict('node', command), true);
  assert.equal(diagnosticConflict('bash', 'bash -c "' + command + '"'), false);
  assert.equal(diagnosticConflict('java', 'java -jar /cache/cloud-firestore-emulator-v1.21.0.jar'), true);
  assert.equal(diagnosticConflict('node', 'node --import tsx capture-phase5-idle-listen.ts --case idle-control'), true);
  assert.equal(diagnosticConflict('node', 'node /usr/local/bin/portless proxy'), false);
});

test('transient pre-exec image does not establish authority; exact child eventually does', async () => {
  const handle = { child: { pid: 42, exitCode: null, signalCode: null }, identity: null,
    command: { executable: '/bin/server', args: ['--port', '23200'] }, directory: '/case' };
  const identity = { startTicks: '1000', command: ['/bin/server', '--port', '23200'], executable: '/bin/server', directory: '/case' };
  let elapsed = 0; let reads = 0;
  const result = await establishIdentity(handle, { read: async () => ++reads === 1 ? { ...identity, executable: '/bin/pre-exec' } : identity,
    resolve: async value => value, now: () => elapsed, sleep: async milliseconds => { assert.equal(handle.identity, null); elapsed += milliseconds; } });
  assert.equal(reads, 2); assert.equal(result.pid, 42); assert.deepEqual(handle.identity, identity);
});

test('wrong exec timeout or PID reuse never assigns signal authority', async () => {
  const make = () => ({ child: { pid: 42, exitCode: null, signalCode: null }, identity: null,
    command: { executable: '/bin/server', args: [] }, directory: '/case' });
  const identity = { startTicks: '1000', command: ['/bin/wrong'], executable: '/bin/wrong', directory: '/case' };
  let elapsed = 0;
  const handle = make();
  await assert.rejects(establishIdentity(handle, { read: async () => identity, resolve: async value => value,
    now: () => elapsed, sleep: async milliseconds => { elapsed += milliseconds; } }), /five seconds/);
  assert.equal(handle.identity, null); assert.equal(elapsed, 5000);
  let reads = 0;
  const reused = make();
  await assert.rejects(establishIdentity(reused, { read: async () => ({ ...identity, startTicks: String(++reads) }),
    resolve: async value => value, now: () => 0, sleep: async () => undefined }), /PID reused/);
  assert.equal(reused.identity, null);
});

test('external deadline cannot become unbounded through an amended diagnostic plan', () => {
  const plan = { unrelatedDocuments: 4100, batchSize: 1, idleSecondsAfterWrites: 150,
    maximumUnrelatedWriteSeconds: 180, maximumScenarioSeconds: 900, maximumCleanupSeconds: 120 };
  assert.equal(captureBudget(plan), 1080000);
  for (const value of [undefined, NaN, Infinity, 100000, '900']) assert.throws(() => captureBudget({ ...plan, maximumScenarioSeconds: value }));
  assert.throws(() => captureBudget({ ...plan, batchSize: 500 }));
});

test('readiness requires a sole known PID on the explicit loopback port', () => {
  const good = 'LISTEN 0 4096 127.0.0.1:23200 0.0.0.0:* users:(("java",pid=123,fd=10))';
  assert.equal(listenerOwned(good, 123, 23200), true);
  assert.equal(listenerOwned(good.replace('127.0.0.1:23200', '0.0.0.0:23200'), 123, 23200), false);
  assert.equal(listenerOwned(good, 999, 23200), false);
  assert.equal(listenerOwned(good + '\n' + good, 123, 23200), false);
  assert.equal(listenerOwned(good.replace('pid=123,', 'pid=123, pid=999,'), 123, 23200), false);
});
