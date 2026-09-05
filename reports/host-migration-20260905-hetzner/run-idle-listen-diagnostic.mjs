#!/usr/bin/env node
// External, six-case diagnostic launcher. Importing this module launches nothing.
// Required: --output ROOT/attempts/idle-listen-NAME --conformance-dir ABSOLUTE
// --tooling-receipt ABSOLUTE --java-jar ABSOLUTE --port INTEGER
// Tooling receipt: {baseCommit: <40 hex>, files: [{path: <relative to conformance>, sha256: <64 hex>}]}.
// Supply at least every TOOLING_FILES entry below. This is not a product build/gate.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, createReadStream, openSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, readlink, realpath, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ROOT, preflight, processConflict } from './hetzner-preflight.mjs';

const execute = promisify(execFile);
export const PINS = Object.freeze({
  java: '/home/sanjevi/.local/share/mise/installs/java/26.0.2.1/bin/java',
  node: '/home/sanjevi/.local/share/mise/installs/node/24.20.0/bin/node',
  fireside: ROOT + '/attempts/r48/target/release/fireside',
  firesideSha256: 'e37ef066c45b53a85a13b16c8b1652df6400e9256fc1e4797d602c637dec8df9',
  firesideCommit: '3407c658d31fbedc35fced8670a6afffd2943e97',
  jarVersion: '1.21.0',
  jarSha256: 'c3d3680a89d946a90a027365ea14c26c6472a162bcf37f099bbb1ebd66d25e8e',
  sdkRoot: ROOT + '/stack-official/node_modules/@google-cloud/firestore',
  watchSha256: '5c13770ba52f95cd7508b05eefed7f558edd1ce36f62cd689211cdeed35742d0',
  project: 'demo-phase5-idle-listen',
  readyMilliseconds: 60000,
  stopMilliseconds: 30000,
});
export const TOOLING_FILES = Object.freeze([
  'src/suite/capture-phase5-idle-listen.ts', 'src/target.ts',
  'fixtures/phase5/idle-listen-diagnostic-plan.json', 'package.json', 'package-lock.json',
]);
export const CASES = Object.freeze(['official', 'fireside'].flatMap(stack =>
  ['idle-control', 'churn-natural', 'churn-forced'].map(caseName => Object.freeze({ stack, caseName }))));

export function parseArguments(values) {
  const entries = new Map();
  const allowed = new Set(['output', 'conformance-dir', 'tooling-receipt', 'java-jar', 'port']);
  for (let i = 0; i < values.length; i += 2) {
    const key = values[i]?.replace(/^--/u, '');
    if (!values[i]?.startsWith('--') || !allowed.has(key) || entries.has(key) || !values[i + 1]) throw Error('Unique --name value arguments required');
    entries.set(key, values[i + 1]);
  }
  const required = key => { const value = entries.get(key); if (!value) throw Error('Missing --' + key); return value; };
  const result = { output: required('output'), conformance: required('conformance-dir'), receipt: required('tooling-receipt'), jar: required('java-jar'), port: Number(required('port')) };
  for (const value of [result.output, result.conformance, result.receipt, result.jar]) {
    if (!path.isAbsolute(value) || path.normalize(value) !== value || /[\n\r\0]/u.test(value)) throw Error('Normalized absolute paths required');
  }
  if (path.dirname(result.output) !== ROOT + '/attempts' || !/^idle-listen-[a-z0-9-]+$/u.test(path.basename(result.output))) throw Error('Output must be a NEW idle-listen-* attempt, not an immutable gate directory');
  if (!result.conformance.startsWith(ROOT + '/diagnostic-idle-listen-') || !result.conformance.endsWith('/tooling/conformance')) throw Error('Use a separately prepared diagnostic tooling/conformance directory');
  if (path.basename(result.jar) !== 'cloud-firestore-emulator-v1.21.0.jar') throw Error('Explicit existing Phase 5 v1.21.0 jar path required');
  if (!/^\d+$/u.test(required('port')) || !Number.isInteger(result.port) || result.port < 1024 || result.port > 65535 || (result.port >= 23000 && result.port <= 23117)) throw Error('Use one unprivileged diagnostic port outside the app/gate ranges');
  return result;
}

export function validateReceipt(receipt) {
  assert.match(receipt.baseCommit ?? '', /^[a-f0-9]{40}$/u);
  assert(Array.isArray(receipt.files));
  const names = new Set();
  for (const file of receipt.files) {
    assert.equal(typeof file.path, 'string');
    assert(!path.isAbsolute(file.path) && file.path !== '' && !file.path.split('/').includes('..') && !/[\n\r\0]/u.test(file.path));
    assert(!names.has(file.path), 'Duplicate tooling receipt entry');
    names.add(file.path);
    assert.match(file.sha256 ?? '', /^[a-f0-9]{64}$/u);
  }
  for (const name of TOOLING_FILES) assert(names.has(name), 'Missing pinned tooling file: ' + name);
}

export function serverCommand(stack, options, caseDirectory) {
  const common = ['--host', '127.0.0.1', '--port', String(options.port), '--project_id', PINS.project];
  if (stack === 'official') return { executable: PINS.java, args: ['-jar', options.jar, ...common, '--single_project_mode', 'true', '--database-edition', 'standard'] };
  assert.equal(stack, 'fireside');
  return { executable: PINS.fireside, args: ['firestore', ...common, '--data-dir', path.join(caseDirectory, 'state')] };
}

export function procIdentity(stat, command, executable, directory) {
  const end = stat.lastIndexOf(')');
  const startTicks = stat.slice(end + 2).trim().split(/\s+/u)[19];
  assert(end > 0 && /^\d+$/u.test(startTicks ?? ''), 'Missing procfs start identity');
  return { startTicks, command: command.split('\0').filter(Boolean), executable, directory };
}

export function assertSameIdentity(expected, actual) {
  assert.deepEqual(actual, expected, 'Owned child PID identity changed: do not signal it');
}

const localAddress = line => line.trim().split(/\s+/u)[3] ?? '';
const listenerPids = line => [...line.matchAll(/pid=(\d+)/gu)].map(match => match[1]);
const solePid = (line, pid) => { const pids = listenerPids(line); return pids.length === 1 && pids[0] === String(pid); };
const loopbackAddress = address => /^(?:127\.0\.0\.1|\[::1\]|\[::ffff:127\.0\.0\.1\]):\d+$/u.test(address);
const portListeners = (lines, port) => lines.split('\n').filter(line => localAddress(line).endsWith(':' + port));

export function listenerOwned(lines, pid, port) {
  const relevant = portListeners(lines, port);
  return relevant.length === 1 && loopbackAddress(localAddress(relevant[0])) && solePid(relevant[0], pid);
}

export async function checkReadinessSample(handle, port, stdout, record, read = readIdentity) {
  const observation = { at: new Date().toISOString(), pid: handle.child.pid, ss: stdout };
  // Preserve even a failed assertion's exact ss output before interpreting it.
  await record(observation);
  assert(handle.child.exitCode === null && handle.child.signalCode === null, 'Owned server exited before readiness');
  const ownedLines = stdout.split('\n').filter(line => listenerPids(line).includes(String(handle.child.pid)));
  assert(ownedLines.every(line => loopbackAddress(localAddress(line)) && solePid(line, handle.child.pid)), 'Owned server exposed a non-loopback or shared listener');
  assert.equal(new Set(ownedLines.map(localAddress)).size, ownedLines.length, 'Owned server has duplicate listener addresses');
  if (listenerOwned(stdout, handle.child.pid, port)) {
    assertSameIdentity(handle.identity, await read(handle.child.pid));
    return { at: observation.at, pid: handle.child.pid, listeners: ownedLines };
  }
  assert.equal(portListeners(stdout, port).length, 0, 'Diagnostic listener is not exclusively owned loopback server');
  return null;
}

export function diagnosticConflict(name, command) {
  // Only executable processes, not an enclosing shell mentioning our own
  // launch arguments. Existing app/gate detection remains unchanged below.
  return name === 'fireside' || (name === 'java' && /cloud-firestore-emulator.*\.jar/u.test(command)) ||
    (/^node(?:js)?$/u.test(name) && /(?:capture-phase5-idle-listen\.ts|run-idle-listen-diagnostic\.mjs)(?:\s|$)/u.test(command));
}

export function captureBudget(plan) {
  const frozen = { unrelatedDocuments: 4100, batchSize: 1, idleSecondsAfterWrites: 150,
    maximumUnrelatedWriteSeconds: 180, maximumScenarioSeconds: 900, maximumCleanupSeconds: 120 };
  for (const [name, value] of Object.entries(frozen)) assert.equal(plan[name], value, 'Diagnostic plan changed: ' + name);
  return (plan.maximumScenarioSeconds + plan.maximumCleanupSeconds + 60) * 1000;
}

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fileHash(filename) {
  const hasher = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hasher.update(chunk);
  return hasher.digest('hex');
}
const json = (filename, value) => writeFile(filename, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const describe = error => ({ message: error?.message ?? String(error), code: error?.code, stack: error?.stack });

async function readIdentity(pid) {
  const base = `/proc/${pid}`;
  const [stat, command, executable, directory] = await Promise.all([
    readFile(base + '/stat', 'utf8'), readFile(base + '/cmdline', 'utf8'), readlink(base + '/exe'), readlink(base + '/cwd'),
  ]);
  const identity = procIdentity(stat, command, executable, directory);
  const after = await readFile(base + '/stat', 'utf8');
  assert.equal(procIdentity(after, command, executable, directory).startTicks, identity.startTicks, 'PID changed while reading identity');
  return identity;
}

async function assertQuiescent(port) {
  const active = [];
  for (const pid of (await readdir('/proc')).filter(name => /^\d+$/u.test(name))) {
    if (Number(pid) === process.pid) continue;
    try {
      const name = (await readFile(`/proc/${pid}/comm`, 'utf8')).trim();
      const command = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).replaceAll('\0', ' ');
      const directory = await readlink(`/proc/${pid}/cwd`);
      if (processConflict(name, command, directory) || diagnosticConflict(name, command)) active.push({ pid, name, command, directory });
    } catch (error) { if (!['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code)) throw error; }
  }
  const { stdout } = await execute('/usr/bin/ss', ['-H', '-ltnp'], { timeout: 5000 });
  assert.equal(active.length, 0, 'Conflicting app, gate, emulator or diagnostic: ' + JSON.stringify(active));
  assert(!new RegExp(`:${port}\\s`, 'u').test(stdout), 'Diagnostic port already in use');
  return { at: new Date().toISOString(), active, listeners: stdout };
}

function startChild(command, directory, environment, log) {
  const fd = openSync(log, 'wx', 0o600);
  let child;
  try { child = spawn(command.executable, command.args, { cwd: directory, env: environment, stdio: ['ignore', fd, fd] }); }
  finally { closeSync(fd); }
  const finished = new Promise(resolve => {
    child.once('error', error => resolve({ code: null, signal: null, spawnError: describe(error) }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return { child, finished, identity: null, command, directory };
}

async function waitBounded(promise, milliseconds) {
  let timer;
  try { return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(null), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

export async function establishIdentity(handle, { read = readIdentity, resolve = realpath, now = () => performance.now(), sleep = delay } = {}) {
  assert(handle.child.pid, 'Owned child did not spawn');
  const expected = { executable: await resolve(handle.command.executable), directory: await resolve(handle.directory),
    command: [handle.command.executable, ...handle.command.args] };
  const started = now();
  let startTicks;
  while (now() - started < 5000) {
    assert(handle.child.exitCode === null && handle.child.signalCode === null, 'Owned child exited before identity establishment');
    const identity = await read(handle.child.pid);
    startTicks ??= identity.startTicks;
    assert.equal(identity.startTicks, startTicks, 'PID reused before child exec identity established: do not signal');
    // Linux may briefly expose the pre-exec image after spawn. Never assign
    // signal authority until the exact executable, argv and cwd all match.
    if (identity.executable === expected.executable && identity.directory === expected.directory &&
        JSON.stringify(identity.command) === JSON.stringify(expected.command)) {
      handle.identity = identity;
      return { pid: handle.child.pid, ...identity, establishedAt: new Date().toISOString() };
    }
    await sleep(50);
  }
  throw Error('Owned child exec identity not established within five seconds: refusal to signal');
}

async function stopOwned(handle, record) {
  if (!handle) return null;
  const already = await waitBounded(handle.finished, 1);
  if (already !== null) return { alreadyExited: true, ...already };
  assert(handle.identity, 'No established child identity: refusal to signal');
  try { assertSameIdentity(handle.identity, await readIdentity(handle.child.pid)); }
  catch (error) {
    if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;
    const exited = await waitBounded(handle.finished, PINS.stopMilliseconds);
    assert(exited !== null, 'Gone PID has no child-exit receipt');
    return { alreadyGone: true, ...exited };
  }
  // Recheck the ChildProcess after asynchronous identity reads. Never signal a
  // process group, guessed PID, or a PID found by a general process scan.
  if (handle.child.exitCode === null && handle.child.signalCode === null) {
    await record('owned-child-sigterm', { pid: handle.child.pid, identity: handle.identity });
    if (handle.child.exitCode === null && handle.child.signalCode === null) handle.child.kill('SIGTERM');
  }
  const exited = await waitBounded(handle.finished, PINS.stopMilliseconds);
  assert(exited !== null, 'Owned child did not exit after SIGTERM; stop sequence, retain PID evidence, no SIGKILL/escalation');
  return { identityChecked: true, ...exited };
}

async function waitReady(handle, port, record) {
  const deadline = performance.now() + PINS.readyMilliseconds;
  while (performance.now() < deadline) {
    let stdout;
    try { ({ stdout } = await execute('/usr/bin/ss', ['-H', '-ltnp'], { timeout: 5000 })); }
    catch (error) {
      await record({ at: new Date().toISOString(), pid: handle.child.pid, ss: error.stdout ?? null, error: describe(error) });
      throw error;
    }
    const ready = await checkReadinessSample(handle, port, stdout, record);
    if (ready !== null) {
      const connected = await new Promise(resolve => {
        const socket = createConnection({ host: '127.0.0.1', port });
        const finish = value => { socket.destroy(); resolve(value); };
        socket.setTimeout(1000, () => finish(false)); socket.once('connect', () => finish(true)); socket.once('error', () => finish(false));
      });
      if (connected) return ready;
    }
    await delay(100);
  }
  throw Error('Owned server readiness deadline exceeded');
}

async function reservePortCheck(port) {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function acquireDeploymentLock() {
  // flock execs only our cat child. An echoed nonce proves the existing shared
  // gate deployment lock was acquired; closing stdin releases it on exit.
  const nonce = `idle-listen-${process.pid}-${Date.now()}\n`;
  const lock = spawn('/usr/bin/flock', ['-n', '-F', ROOT + '/deployment.lock', '/usr/bin/cat'], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  const ready = new Promise((resolve, reject) => {
    lock.on('error', reject);
    lock.once('exit', code => reject(Error('Deployment lock unavailable: ' + code)));
    lock.stdout.on('data', data => { output += data.toString(); if (output === nonce) resolve(); });
  });
  lock.stdin.on('error', () => undefined);
  lock.stdin.write(nonce);
  try {
    const acquired = await waitBounded(ready.then(() => true), 5000);
    assert(acquired, 'Deployment lock acquisition deadline');
  } catch (error) { lock.stdin.end(); throw error; }
  return () => lock.stdin.end();
}

async function verifyInputs(options) {
  const receiptBytes = await readFile(options.receipt);
  const receipt = JSON.parse(receiptBytes); validateReceipt(receipt);
  for (const item of receipt.files) assert.equal(await fileHash(path.join(options.conformance, item.path)), item.sha256, 'Tooling identity differs: ' + item.path);
  assert.equal(await fileHash(PINS.fireside), PINS.firesideSha256, 'R48 failing baseline binary differs');
  assert.equal(await fileHash(options.jar), PINS.jarSha256, 'Official Phase 5 v1.21.0 jar differs');
  const sdk = JSON.parse(await readFile(PINS.sdkRoot + '/package.json', 'utf8'));
  assert.equal(sdk.name, '@google-cloud/firestore'); assert.equal(sdk.version, '7.11.6');
  assert.equal(await fileHash(PINS.sdkRoot + '/build/src/watch.js'), PINS.watchSha256, 'Pinned 7.11.6 watch implementation differs');
  const node = await execute(PINS.node, ['--version'], { timeout: 10000 }); assert.equal(node.stdout.trim(), 'v24.20.0');
  const java = await execute(PINS.java, ['-version'], { timeout: 10000 }); assert.match(java.stderr + java.stdout, /\b26\.0\.2\.1\b/u);
  const plan = JSON.parse(await readFile(path.join(options.conformance, TOOLING_FILES[2]), 'utf8'));
  return { at: new Date().toISOString(), receipt, receiptSha256: hash(receiptBytes), pins: PINS,
    jar: options.jar, nodeVersion: node.stdout.trim(), javaVersion: java.stderr + java.stdout,
    javaExecutableSha256: await fileHash(PINS.java), nodeExecutableSha256: await fileHash(PINS.node),
    launcherSha256: await fileHash(fileURLToPath(import.meta.url)),
    preflightSha256: await fileHash(new URL('./hetzner-preflight.mjs', import.meta.url)),
    captureMaximumMilliseconds: captureBudget(plan),
    measuredProductIsR48NotToolingBaseCommit: true };
}

async function checksumEvidence(directory) {
  // State and TMPDIR stay preserved in place. Hash diagnostic records only;
  // never read a database which a failed owned shutdown may have left active.
  const entries = [];
  async function visit(current, relative = '') {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const name = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isDirectory()) {
        if (entry.name !== 'state' && entry.name !== 'tmp') await visit(path.join(current, entry.name), name);
      } else if (entry.isFile() && name !== 'launcher-checksums.sha256') {
        entries.push([name, await fileHash(path.join(current, entry.name))]);
      }
    }
  }
  await visit(directory);
  await writeFile(path.join(directory, 'launcher-checksums.sha256'), entries.sort(([a], [b]) => a.localeCompare(b, 'en'))
    .map(([name, digest]) => `${digest}  ./${name}\n`).join(''), { flag: 'wx', mode: 0o600 });
}

export async function main(options) {
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 1000, 'Run as the provisioned non-root worker');
  for (const name of ['JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS', 'NODE_OPTIONS', 'MALLOC_CONF',
    'MIMALLOC_PURGE_DELAY', 'MIMALLOC_PURGE_DECOMMITS', 'FIRESIDE_REDB_CACHE_BYTES', 'FIRESIDE_REDB_CACHE_MIB']) assert(!process.env[name], 'Unexpected launch override: ' + name);
  const releaseLock = await acquireDeploymentLock();
  let created = false;
  const outcomes = [];
  let failure = null;
  try {
    await mkdir(options.output, { recursive: false, mode: 0o700 }); created = true;
    const inputs = await verifyInputs(options);
    await json(path.join(options.output, 'inputs.json'), inputs);
    for (const [index, item] of CASES.entries()) {
      const directory = path.join(options.output, `${String(index + 1).padStart(2, '0')}-${item.stack}-${item.caseName}`);
      await mkdir(directory); await mkdir(path.join(directory, 'tmp'));
      const record = (kind, value) => appendFile(path.join(directory, 'launcher-events.jsonl'), JSON.stringify({ at: new Date().toISOString(), kind, value }) + '\n');
      let server = null; let capture = null;
      const outcome = { ...item, directory, captureExit: null, captureCompleted: false, serverStop: null, captureStop: null, failure: null, cleanupFailures: [] };
      try {
        await json(path.join(directory, 'quiescence-before.json'), await assertQuiescent(options.port));
        const health = await preflight(path.join(directory, 'preflight'), inputs.receipt.baseCommit);
        assert(health.passed, 'Unchanged replacement-host preflight failed');
        // Revalidate executable/tooling bytes and the port after preflight.
        await verifyInputs(options); await reservePortCheck(options.port);
        const environment = Object.fromEntries(['HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TZ'].filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
        environment.PATH = path.dirname(PINS.node) + ':' + path.dirname(PINS.java) + ':/usr/local/bin:/usr/bin:/bin';
        environment.TMPDIR = path.join(directory, 'tmp');
        server = startChild(serverCommand(item.stack, options, directory), directory, environment, path.join(directory, 'server.log'));
        await record('server-spawn', { pid: server.child.pid, command: server.command, directory: server.directory });
        await json(path.join(directory, 'server-identity.json'), await establishIdentity(server));
        const recordReadiness = sample => appendFile(path.join(directory, 'server-readiness.jsonl'), JSON.stringify(sample) + '\n', { mode: 0o600, flush: true });
        await json(path.join(directory, 'server-readiness.json'), await waitReady(server, options.port, recordReadiness));
        const command = { executable: PINS.node, args: ['--import', 'tsx', 'src/suite/capture-phase5-idle-listen.ts',
          '--host', `127.0.0.1:${options.port}`, '--project-id', PINS.project, '--stack', item.stack, '--case', item.caseName,
          '--sdk-root', PINS.sdkRoot, '--output', path.join(directory, 'capture'), '--server-pid', String(server.child.pid)] };
        capture = startChild(command, options.conformance, environment, path.join(directory, 'capture.log'));
        await record('capture-spawn', { pid: capture.child.pid, command: capture.command, directory: capture.directory });
        await json(path.join(directory, 'capture-identity.json'), await establishIdentity(capture));
        outcome.captureExit = await waitBounded(capture.finished, inputs.captureMaximumMilliseconds);
        assert(outcome.captureExit !== null, 'Capture exceeded its external deadline');
        assert.equal(outcome.captureExit.code, 0, 'Capture setup/cleanup failed (behavioral differences are retained observations)');
        assert(server.child.exitCode === null && server.child.signalCode === null, 'Owned server exited unexpectedly during capture');
        const result = JSON.parse(await readFile(path.join(directory, 'capture/result.json'), 'utf8'));
        assert.equal(result.scenarioCompleted, true); assert.equal(result.cleanupCompleted, true);
        outcome.captureCompleted = true;
      } catch (error) { outcome.failure = describe(error); }
      finally {
        const cleanupFailure = (step, error) => { outcome.cleanupFailures.push({ step, ...describe(error) }); outcome.failure ??= describe(error); };
        try { outcome.captureStop = await stopOwned(capture, record); } catch (error) { cleanupFailure('capture-stop', error); }
        try { outcome.serverStop = await stopOwned(server, record); } catch (error) { cleanupFailure('server-stop', error); }
        try { await json(path.join(directory, 'quiescence-after.json'), await assertQuiescent(options.port)); }
        catch (error) { cleanupFailure('quiescence-after', error); }
        await json(path.join(directory, 'outcome.json'), outcome); outcomes.push(outcome);
      }
      if (outcome.failure !== null) throw Error('Diagnostic case stopped sequence: ' + item.stack + '/' + item.caseName);
    }
  } catch (error) { failure = describe(error); }
  finally {
    try {
      if (created) {
        await json(path.join(options.output, 'summary.json'), { at: new Date().toISOString(),
          sixCasesCompleted: outcomes.length === 6 && failure === null, outcomes, failure,
          productGatePassClaimed: false, performanceWinnerClaimed: false, gateAttemptLaunched: false,
          sourceInputTreesModified: false, checksumExclusions: ['*/state/**', '*/tmp/**'],
          checksumsAreSnapshotOnFailure: failure !== null });
        await checksumEvidence(options.output);
      }
    } finally { releaseLock(); }
  }
  return failure === null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(parseArguments(process.argv.slice(2))).then(completed => { process.exit(completed ? 0 : 1); })
    .catch(error => { process.stderr.write(String(error.stack ?? error) + '\n'); process.exit(1); });
}
