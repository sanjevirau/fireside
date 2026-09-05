// One-time, pre-workload preservation. Does not change a gate or its runner.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, readlink, rename, writeFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { processConflict } from './hetzner-preflight.mjs';

const root = '/srv/dev-fast/runtime-data/fireside-templates-hetzner-20260905';
const preparation = root + '/preparation-r48';
const banked = root + '/banked-r36/exports/official/full-data';
const sum = bytes => createHash('sha256').update(bytes).digest('hex');
async function absent(filename) {
  try { await lstat(filename); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw Error('Refusing an existing destination: ' + filename);
}
let quiescenceIndex = 0;
async function quiescent() {
  assert.equal(execFileSync('id', ['-un'], { encoding: 'utf8' }).trim(), 'sanjevi');
  assert.equal(execFileSync('hostname', [], { encoding: 'utf8' }).trim(), 'fireside-hetzner');
  const tmux = spawnSync('tmux', ['list-sessions'], { encoding: 'utf8' });
  assert.equal(tmux.status, 1, 'No tmux session may be active during preservation');
  assert.match(tmux.stderr, /no server running|failed to connect to server/);
  const listeners = execFileSync('ss', ['-H', '-lntp'], { encoding: 'utf8' });
  assert.doesNotMatch(listeners, /:23[01](?:0\d|1[0-7])\s/, 'A stack port is listening');
  const active = [];
  for (const pid of (await readdir('/proc')).filter(value => /^\d+$/.test(value))) {
    if (Number(pid) === process.pid) continue;
    try {
      const commandName = (await readFile(`/proc/${pid}/comm`, 'utf8')).trim();
      const command = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).replaceAll('\0', ' ').trim();
      const directory = await readlink(`/proc/${pid}/cwd`);
      if (processConflict(commandName, command, directory)) active.push({ pid: Number(pid), commandName, command, directory });
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'EPERM', 'ESRCH'].includes(error.code)) throw error;
    }
  }
  await writeFile(preparation + '/preservation-quiescence-' + quiescenceIndex++ + '.json',
    JSON.stringify({ at: new Date().toISOString(), listeners, active }, null, 2) + '\n', { flag: 'wx' });
  assert.equal(active.length, 0, 'A stack, gate, or transfer process remains');
}
async function tree(directory, corresponding = null) {
  assert((await lstat(directory)).isDirectory(), 'Expected a real directory');
  const names = [];
  async function visit(relative) {
    for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) names.push(name);
      else throw Error('Non-regular artifact: ' + name);
    }
  }
  await visit('');
  names.sort((a, b) => Buffer.compare(Buffer.from('./' + a), Buffer.from('./' + b)));
  const aggregate = createHash('sha256');
  let bytes = 0;
  for (const name of names) {
    const filename = path.join(directory, name);
    const before = await lstat(filename);
    assert(before.isFile());
    if (corresponding) {
      const original = await lstat(path.join(corresponding, name));
      assert(original.isFile());
      assert.equal(before.dev, original.dev); assert.equal(before.ino, original.ino);
      assert.equal(before.size, original.size);
    }
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(filename)) digest.update(chunk);
    const after = await lstat(filename);
    assert.equal(before.size, after.size); assert.equal(before.mtimeMs, after.mtimeMs);
    assert.equal(before.ino, after.ino);
    bytes += after.size;
    aggregate.update(`${digest.digest('hex')}  ./${name}\n`);
  }
  return { files: names.length, bytes, sha256: aggregate.digest('hex') };
}
await quiescent();
await absent(root + '/attempts/r48');
assert.equal((await readFile(preparation + '/setup.exit', 'utf8')).trim(), '0');
assert.equal((await readFile(root + '/attempts/r47/controller.exit', 'utf8')).trim(), '1');
assert.equal((await readFile(root + '/attempts/r47/smoke.exit', 'utf8')).trim(), '0');
const targets = [{
  source: root + '/stack-fireside/apps/templates-firebase/loadData/datasets/phase5-r36-official-export',
  destination: preparation + '/preserved-r46-official-export',
  provenance: 'R46 official-export parity staging; all files must still hardlink the unchanged banked export.',
  corresponding: banked,
}];
for (const stack of ['official', 'fireside']) {
  const source = root + '/exports/' + stack + '/smoke/smoke';
  const logPath = root + '/attempts/r47/smoke/' + stack + '-initial-tmux.log';
  const log = await readFile(logPath);
  assert(log.toString().includes("TWODART_EMULATOR_EXPORT_OVERRIDE='" + source + "'"));
  targets.push({ source, destination: preparation + '/preserved-r47-' + stack + '-smoke-export',
    provenance: { logPath, logSha256: sum(log), exportPathObservedInR47Launch: true } });
}
for (const target of targets) {
  await absent(target.destination);
  target.before = await tree(target.source, target.corresponding);
}
assert.deepEqual(targets[0].before, { files: 66756, bytes: 8180612785,
  sha256: 'c1a1451827c326fb680b2133b0a2c42b79302f1fb89febfb02228ad056b619ca' });
await writeFile(preparation + '/staging-preservation-plan.json', JSON.stringify({
  at: new Date().toISOString(), targets, frozenInputsModified: false, gateCriteriaChanged: false,
}, null, 2) + '\n', { flag: 'wx' });
for (const [index, target] of targets.entries()) {
  await quiescent();
  await absent(target.destination);
  const before = await lstat(target.source);
  await rename(target.source, target.destination);
  const after = await lstat(target.destination);
  assert.equal(before.dev, after.dev); assert.equal(before.ino, after.ino);
  await absent(target.source);
  const receipt = { at: new Date().toISOString(), ...target, atomicRename: true,
    sameDirectoryInode: true, recoverable: true, sourceNowAbsent: true, deletedFiles: 0 };
  await writeFile(preparation + '/staging-preservation-' + index + '.json',
    JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(receipt));
}
