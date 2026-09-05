// Binding-only oracle after the preserved diagnostic-r1 readiness rejection.
// No Firestore client, writes, import, application stack or gate is launched.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
const root = '/srv/dev-fast/runtime-data/fireside-templates-hetzner-20260905';
const tooling = root + '/diagnostic-idle-listen-20260906/tooling';
const source = tooling + '/reports/host-migration-20260905-hetzner/';
const output = root + '/attempts/idle-listen-binding-20260906-r1';
const jar = '/home/sanjevi/.cache/firebase/emulators/cloud-firestore-emulator-v1.21.0.jar';
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
assert.equal(hash(source + 'run-idle-listen-diagnostic.mjs'), '8f53dcaa617e0dd4e3c9db3a135172f02d6d5cf2b131c26f2b7cc5f23ba0d7ef');
const { PINS, serverCommand, establishIdentity, procIdentity, assertSameIdentity } = await import(source + 'run-idle-listen-diagnostic.mjs');
const { preflight } = await import(source + 'hetzner-preflight.mjs');
assert.equal(hash(jar), PINS.jarSha256);
assert.equal(process.getuid(), 1000);
for (const name of ['JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS']) assert(!process.env[name]);
fs.mkdirSync(output, { recursive: false, mode: 0o700 });
const save = (name, value) => fs.writeFileSync(output + '/' + name, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const health = await preflight(output + '/preflight', '70043eb700ac82b6084a314cc1e972afa4345464');
assert(health.passed);
assert(!/:23200\s/u.test(execFileSync('/usr/bin/ss', ['-H', '-ltnp'], { encoding: 'utf8', timeout: 5000 })));
const command = serverCommand('official', { port: 23200, jar }, output);
const fd = fs.openSync(output + '/server.log', 'wx', 0o600);
const child = spawn(command.executable, command.args, { cwd: output,
  env: { HOME: process.env.HOME, LANG: 'C.UTF-8', PATH: '/usr/bin:/bin' }, stdio: ['ignore', fd, fd] });
fs.closeSync(fd);
const exited = new Promise(resolve => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', error => resolve({ error: error.message })); });
const handle = { child, command, directory: output, identity: null };
let failure = null;
const samples = [];
try {
  save('server-identity.json', await establishIdentity(handle));
  for (let index = 0; index < 12; index++) {
    const sample = { at: new Date().toISOString(), pid: child.pid,
      ss: execFileSync('/usr/bin/ss', ['-H', '-ltnp'], { encoding: 'utf8', timeout: 5000 }) };
    samples.push(sample); save(`listeners-${String(index).padStart(2, '0')}.json`, sample);
    assert(child.exitCode === null && child.signalCode === null, 'Java exited during binding-only observation');
    await delay(500);
  }
} catch (error) { failure = { message: error.message, stack: error.stack }; }
finally {
  if (child.exitCode === null && child.signalCode === null) {
    assert(handle.identity, 'No signal authority without exact child identity');
    const p = '/proc/' + child.pid;
    const identity = procIdentity(fs.readFileSync(p + '/stat', 'utf8'), fs.readFileSync(p + '/cmdline', 'utf8'), fs.readlinkSync(p + '/exe'), fs.readlinkSync(p + '/cwd'));
    assertSameIdentity(handle.identity, identity);
    child.kill('SIGTERM');
  }
  let timer;
  const stop = await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => resolve(null), 30000); })]);
  clearTimeout(timer);
  save('result.json', { at: new Date().toISOString(), failure, stop, sampleCount: samples.length,
    clientTrafficSent: false, gateLaunched: false, jarSha256: hash(jar), command,
    after: execFileSync('/usr/bin/ss', ['-H', '-ltnp'], { encoding: 'utf8', timeout: 5000 }) });
  assert(stop !== null, 'Owned Java did not exit; no forced escalation or retry');
}
process.exitCode = failure ? 1 : 0;
