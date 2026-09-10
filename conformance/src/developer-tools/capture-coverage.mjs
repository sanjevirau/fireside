// Tiny independent expression-coverage oracle; no consumer or cloud inputs.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

assert.equal(process.versions.node, '24.20.0');
assert.ok(process.argv[2], 'provide a fresh output directory');
const output = resolve(process.argv[2]);
await mkdir(output, { recursive: false });
const work = await mkdtemp(join(tmpdir(), 'fireside-coverage-'));
const jar = join(homedir(), '.cache/firebase/emulators/cloud-firestore-emulator-v1.22.0.jar');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const jarSha256 = hash(await readFile(jar));
assert.equal(jarSha256, '9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c');
const socket = createServer();
socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const project = 'demo-fireside-coverage';
const source = (condition, functions = '', prefix = '', newline = '\n') =>
  [`rules_version = '2';`, 'service cloud.firestore {',
    ' match /databases/{database}/documents {', functions,
    `  match /items/{item} { ${prefix}allow get: if ${condition}; }`, ' }', '}'].join(newline);
const profiles = [
  { id: 'constant', source: source('true'), status: 200 },
  { id: 'short-circuit', source: source('false && resource.data.missing'), status: 403 },
  { id: 'field-equality', source: source('resource.data.visible == true'), status: 200 },
  { id: 'missing-field', source: source('resource.data.missing == true'), status: 403 },
  { id: 'function', source: source('accept(resource.data.visible)', '  function accept(value) { let checked = value == true; return checked; }'), status: 200 },
  { id: 'list-and-map', source: source("[1, 2].size() == 2 && {'ok': true}.ok"), status: 200 },
  { id: 'unicode-crlf', source: source("'中文🚀' == '中文🚀' && resource.data.visible", '', '/* 中文🚀 */ ', '\r\n'), status: 200 },
  { id: 'parentheses', source: source('(resource.data.visible == true) || false'), status: 200 },
  { id: 'unary', source: source('!resource.data.visible'), status: 403 },
  { id: 'index', source: source("resource.data['visible']"), status: 200 },
  { id: 'empty-containers', source: source('[].size() == 0 && {}.size() == 0'), status: 200 },
  { id: 'simple-function', source: source('accept(resource.data.visible)', '  function accept(value) { return value; }'), status: 200 },
  { id: 'path-interpolation', source: source('exists(/databases/$(database)/documents/items/one)'), status: 200 },
  { id: 'slice', source: source('[1, 2, 3][1:2] == [2]'), status: 200 },
  { id: 'type-check', source: source('resource.data.visible is bool'), status: 200 },
  { id: 'method-arguments', source: source("'hello'.matches('h.*')"), status: 200 },
  { id: 'nested-grouping', source: source('((resource.data.visible))'), status: 200 },
  { id: 'grouped-literal', source: source("('hello').size() == 5"), status: 200 },
  { id: 'constant-function', source: source('accept()', '  function accept() { return true; }'), status: 200 },
  { id: 'duration', source: source("duration.value(1, 's') == duration.value(1000, 'ms')"), status: 200 },
  { id: 'set', source: source('[1, 2].toSet().hasAll([1])'), status: 200 },
  { id: 'map-diff', source: source("{'x': 1}.diff({'x': 2}).changedKeys().hasOnly(['x'])"), status: 200 },
  { id: 'bytes', source: source("hashing.sha256('hello'.toUtf8()).size() == 32"), status: 200 },
  { id: 'timestamp', source: source('timestamp.date(2020, 1, 2).year() == 2020'), status: 200 },
  { id: 'request', source: source('request.auth == null && request.method == "get"'), status: 200 },
];
await writeFile(join(work, 'firestore.rules'), profiles[0].source);
const child = spawn('java', ['-jar', jar, '--host', '127.0.0.1', '--port', String(port),
  '--project_id', project, '--rules', join(work, 'firestore.rules')],
{ cwd: work, stdio: ['ignore', 'pipe', 'pipe'] });
const exited = once(child, 'exit'), logs = [];
for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => logs.push(String(bytes)));
const record = { schemaVersion: 1, syntheticOnly: true, capturedAt: new Date().toISOString(), project,
  oracle: { firestore: '1.22.0', jarSha256, node: process.versions.node,
    java: spawnSync('java', ['-version'], { encoding: 'utf8' }).stderr.trim() }, exchanges: [], profiles: [] };
const origin = `http://127.0.0.1:${port}`;
const control = `/emulator/v1/projects/${project}`;
const document = `/v1/projects/${project}/databases/(default)/documents/items/one`;
async function request(id, path, method = 'GET', body, owner = false) {
  const response = await fetch(origin + path, { method,
    headers: { 'content-type': 'application/json', ...(owner ? { authorization: 'Bearer owner' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) });
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  record.exchanges.push({ id, path, method, body: body ?? null, owner, status: response.status, response: data });
  return { status: response.status, data };
}
let failure;
try {
  const deadline = Date.now() + 60000;
  while (true) {
    assert.equal(child.exitCode, null, 'oracle exited during readiness');
    try { const response = await fetch(origin + '/', { signal: AbortSignal.timeout(250) }); if (response.status < 500) break; } catch {}
    assert.ok(Date.now() < deadline, 'oracle readiness deadline'); await delay(50);
  }
  assert.equal((await request('seed', document, 'PATCH', { fields: { visible: { booleanValue: true } } }, true)).status, 200);
  for (const profile of profiles) {
    const reload = await request(`${profile.id}-reload`, `${control}:securityRules`, 'PUT', { rules: { files: [{ name: 'firestore.rules', content: profile.source }] } });
    assert.equal(reload.status, 200, JSON.stringify(reload));
    const before = await request(`${profile.id}-before`, `${control}:ruleCoverage`);
    assert.equal(before.status, 200);
    for (let i = 0; i < 2; i++) assert.equal((await request(`${profile.id}-get-${i}`, document)).status, profile.status);
    const after = await request(`${profile.id}-after`, `${control}:ruleCoverage`);
    assert.equal(after.status, 200);
    record.profiles.push({ ...profile, before: before.data, after: after.data });
  }
  // An invalid reload must retain the last valid source and coverage.
  const invalid = await request('invalid-reload', `${control}:securityRules`, 'PUT', { rules: { files: [{ name: 'firestore.rules', content: 'broken' }] } });
  assert.equal(invalid.status, 400);
  const retained = await request('coverage-after-invalid', `${control}:ruleCoverage`);
  assert.equal(retained.status, 200);
  record.afterInvalidReload = retained.data;
} catch (error) { failure = error; }
finally {
  if (child.exitCode === null) child.kill('SIGINT');
  record.exit = await Promise.race([exited, delay(20000, undefined, { ref: false }).then(() => { throw new Error(`owned oracle ${child.pid} shutdown deadline`); })]);
  await writeFile(join(output, 'oracle.log'), logs.join(''));
  await writeFile(join(output, 'raw.json'), JSON.stringify(record, null, 2) + '\n');
}
if (failure) throw failure;
// Public fixture keeps complete per-profile observations without duplicating
// every coverage response in the raw HTTP transcript retained alongside it.
const { exchanges, ...publicRecord } = record;
publicRecord.seed = exchanges[0];
publicRecord.invalidReload = exchanges.find(exchange => exchange.id === 'invalid-reload');
const bytes = (JSON.stringify(publicRecord, null, 2) + '\n').replaceAll(work, '<oracle-workdir>');
assert.ok(!/Bearer |\/Users\/|\/var\/folders\//.test(bytes));
await writeFile(join(output, 'fixture.json'), bytes, { flag: 'wx' });
await writeFile(join(output, 'SHA256SUMS'), hash(bytes) + '  fixture.json\n', { flag: 'wx' });
console.log(JSON.stringify({ passed: true, output, profiles: record.profiles.length }));
