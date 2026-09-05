#!/usr/bin/env node
// Deployment-only checks. Importing this module never probes or changes a host.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, readlink, statfs, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export const ROOT = '/srv/dev-fast/runtime-data/fireside-templates-hetzner-20260905';
export const CANDIDATE = 'b5fe1d51ea1fd0b5912cab0ae2d4f1d4d1f0987d';
export const BASELINE_SUMS = 'a9aa4df4f37b535ba429bdcc8da3b863f0d608eaee96883de3a6b45112a18a95';
export const INPUTS = {
  'inputs/full-data': [66758, 8180616677, '3505b5fd24dc4e8fb1f9925b5201c6e28dbb993c7a0a2bebb34cb70d13d91fc7'],
  'banked-r36/exports/official/full-data': [66756, 8180612785, 'c1a1451827c326fb680b2133b0a2c42b79302f1fb89febfb02228ad056b619ca'],
  'inputs/Assets/globalFonts': [46, 14315300, '415edbf85ef3d09789b3a64bf14eb65550e8876915d892c0018b7ec96b8a40cf'],
  'inputs/Assets/masterSlidesBase': [3, 93371, '27dd0b395aee2f557a90c7b8cb58fbdd2b1dd4fd2b0861cc76911d34ba7685a8'],
  'inputs/Assets/slides': [10918, 522696779, 'b1ecdef81da630d286fabcc5f6973b5544c09e3f381f9c29ffef1b93e543fd63'],
};
const resourcePattern = /out of memory|oom-kill|killed process|memory cgroup out of memory|resource temporarily unavailable|fork: retry/iu;
const hardwarePattern = /\bI\/O error\b|\bI\/O Error\b|critical medium error|buffer I\/O|blk_update_request.*error|EXT4-fs error|XFS.*(?:corrupt|metadata I\/O)|hardware error|machine check|uncorrect(?:ed|able).*error|nvme.*(?:timeout|timed out|reset controller|controller is down|abort status)|md\/raid.*(?:disk failure|failed)|ata\d.*failed command/iu;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const read = async (filename) => (await readFile(filename, 'utf8')).trim();

export function validateInputReceipt(receipt) {
  if (receipt.candidate !== CANDIDATE || receipt.root !== ROOT || receipt.completed !== true ||
      receipt.allTransfersComplete !== true || !Number.isFinite(Date.parse(receipt.verifiedAtIso)) ||
      receipt.bankedEvidenceChecksumsSha256 !== BASELINE_SUMS) {
    throw new Error('Missing or incomplete exact-host input verification receipt');
  }
  for (const [relative, expected] of Object.entries(INPUTS)) {
    const actual = receipt.trees?.[relative];
    if (!actual || actual.files !== expected[0] || actual.bytes !== expected[1] || actual.sha256 !== expected[2]) {
      throw new Error(`Input identity mismatch in transfer receipt: ${relative}`);
    }
  }
}

export function validateRaid(arrays) {
  if (arrays.length !== 3 || arrays.map((item) => item.name).sort().join(',') !== 'md0,md1,md2') {
    throw new Error('Expected exactly md0, md1, and md2');
  }
  for (const array of arrays) {
    const partition = Number(array.name.slice(2)) + 1;
    const expected = [`nvme0n1p${partition}`, `nvme1n1p${partition}`];
    if (array.level !== 'raid1' || array.raidDisks !== '2' || array.degraded !== '0' ||
        array.syncAction !== 'idle' || !['active', 'clean'].includes(array.state) ||
        [...array.members].sort().join(',') !== expected.join(',') ||
        array.memberStates.length !== 2 || array.memberStates.some((state) => state !== 'in_sync')) {
      throw new Error(`RAID not fully healthy and idle: ${JSON.stringify(array)}`);
    }
  }
}

export function validateSmart(device, report) {
  const health = report.nvme_smart_health_information_log;
  if (report.smartctl?.exit_status !== 0 || report.smart_status?.passed !== true ||
      report.device?.name !== `/dev/${device}` || !health || health.critical_warning !== 0 ||
      health.media_errors !== 0 || health.num_err_log_entries !== 0) {
    throw new Error(`NVMe health/counters not clean or evidence incomplete: ${device}`);
  }
}

export function journalErrors(kernel, journal) {
  return {
    // Linux 6.8 nvme_init_identify() reports a configured budget with dev_info,
    // not an elapsed timeout. Strip only that exact terminal notice for matching;
    // keep the original journal and still detect any other fault on the line.
    hardware: kernel.split('\n').filter((line) => hardwarePattern.test(
      line.replace(/\bnvme nvme\d+: Shutdown timeout set to \d+ seconds$/u, ''),
    )),
    resources: journal.split('\n').filter((line) => resourcePattern.test(line)),
  };
}

export function steadySwapSamples(output) {
  const samples = output.split('\n').map((line) => line.trim().split(/\s+/u))
    .filter((fields) => fields.length >= 17 && fields.every((value) => /^-?\d+$/u.test(value)))
    .slice(-3).map((fields) => ({ swapInKiBPerSecond: Number(fields[6]), swapOutKiBPerSecond: Number(fields[7]) }));
  if (samples.length !== 3 || samples.some((sample) => sample.swapInKiBPerSecond !== 0 || sample.swapOutKiBPerSecond !== 0)) {
    throw new Error(`Three steady zero-activity vmstat samples required: ${JSON.stringify(samples)}`);
  }
  return samples;
}

export function processConflict(commandName, command, directory) {
  // Portless 80/443 is infrastructure, not a workload. Do not match this launcher
  // or general provisioning checks merely because their command mentions ROOT.
  const stackRoot = /\/(?:stack-official|stack-fireside|fresh-colleague)(?:\/|$)/u;
  const scopedDirectory = directory.startsWith(`${ROOT}/`) && stackRoot.test(directory.slice(ROOT.length));
  const gateCommand = /(?:^|[\s/])(?:run-phase5-gate|run-phase5-soak|run-phase5-browser-journeys)\.(?:ts|js)(?:\s|$)/u.test(command);
  const runtimeBinary = command.includes(`${ROOT}/`) && /(?:\/release\/fireside|cloud-firestore-emulator|\.next\/|next dev|twodartnet|cache-watcher)/iu.test(command);
  const transfer = /^(?:rsync|scp|sftp|sftp-server|tar)$/u.test(commandName) &&
    (command.includes(ROOT) || directory.startsWith(`${ROOT}/inputs`) || directory.startsWith(`${ROOT}/banked-r36`));
  return scopedDirectory || gateCommand || runtimeBinary || transfer;
}

export function validateCandidate(candidate) {
  if (typeof candidate !== 'string' || !/^[a-f0-9]{40}$/u.test(candidate)) throw new Error('Exact 40-character candidate commit required');
  return candidate;
}

export async function preflight(evidenceDirectory, candidate = CANDIDATE) {
  validateCandidate(candidate);
  const resolved = path.resolve(evidenceDirectory);
  if (!resolved.startsWith(`${ROOT}/attempts/`) || resolved.includes('\n')) throw new Error('Evidence must be a new directory under ROOT/attempts');
  await mkdir(resolved, { recursive: false });
  const files = [];
  const result = { startedAt: new Date().toISOString(), candidate, inputReceiptCandidate: CANDIDATE, root: ROOT, passed: false, failures: [] };
  let sequence = 0;
  async function save(name, value) {
    const content = typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;
    await writeFile(path.join(resolved, name), content, { flag: 'wx' });
    files.push([name, hash(content)]);
  }
  async function command(name, executable, args, options = {}) {
    const startedAt = new Date().toISOString();
    let output;
    try {
      const response = await execute(executable, args, { timeout: 30000, maxBuffer: 64 * 1024 * 1024, ...options });
      output = { startedAt, executable, args, code: 0, ...response };
    } catch (error) {
      output = { startedAt, executable, args, code: error.code ?? null, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? ''), error: error.message };
    }
    await save(`${String(++sequence).padStart(2, '0')}-${name}.json`, output);
    if (output.code !== 0) throw new Error(`${name} failed: ${output.code}: ${output.stderr || output.error}`);
    return output.stdout.trim();
  }
  async function check(name, action) {
    try { await action(); } catch (error) { result.failures.push(`${name}: ${error.message}`); }
  }
  async function assertQuiescent(label) {
    const samples = [];
    // Three consecutive empty snapshots; never signal or terminate a process.
    for (let index = 0; index < 3; index++) {
      const active = [];
      for (const pid of (await readdir('/proc')).filter((item) => /^\d+$/u.test(item))) {
        if (Number(pid) === process.pid) continue;
        try {
          const commandName = await read(`/proc/${pid}/comm`);
          const cmdline = (await read(`/proc/${pid}/cmdline`)).replaceAll('\0', ' ');
          const directory = await readlink(`/proc/${pid}/cwd`);
          if (processConflict(commandName, cmdline, directory)) active.push({ pid: Number(pid), commandName, command: cmdline, directory });
        } catch (error) {
          if (!['ENOENT', 'EACCES', 'EPERM', 'ESRCH'].includes(error.code)) throw error;
        }
      }
      const listeners = await command(`${label}-listeners-${index}`, '/usr/bin/ss', ['-ltnH']);
      const conflicts = listeners.split('\n').filter((line) => /:(?:230(?:0\d|1[0-7])|231(?:0\d|1[0-7]))\s/u.test(line));
      samples.push({ at: new Date().toISOString(), active, conflictingListeners: conflicts });
      if (active.length || conflicts.length) {
        await save(`${label}-quiescence.json`, samples);
        throw new Error(`Active stack or transfer/listener remains: ${JSON.stringify(samples.at(-1))}`);
      }
      if (index < 2) await delay(250);
    }
    await save(`${label}-quiescence.json`, samples);
  }
  try {
    await check('identity', async () => {
      const identity = { hostname: os.hostname(), kernel: os.release(), architecture: os.arch(), memoryBytes: os.totalmem(), cpus: os.cpus().map((cpu) => cpu.model), osRelease: await read('/etc/os-release') };
      await save('identity.json', identity);
      if (identity.hostname !== 'fireside-hetzner' || identity.kernel !== '6.8.0-138-generic' || identity.architecture !== 'x64' ||
          identity.memoryBytes !== 67343601664 || identity.cpus.length !== 12 || !identity.cpus.every((cpu) => cpu.includes('AMD Ryzen 5 3600')) ||
          !identity.osRelease.includes('PRETTY_NAME="Ubuntu 24.04.4 LTS"')) throw new Error('Host differs from frozen replacement identity');
    });
    await check('inputs', async () => {
      const raw = await readFile(`${ROOT}/input-verification.json`, 'utf8');
      await save('input-verification.json', raw);
      validateInputReceipt(JSON.parse(raw));
      const baseline = `${ROOT}/banked-r36/evidence`;
      if (hash(await readFile(`${baseline}/checksums.sha256`)) !== BASELINE_SUMS) throw new Error('Banked checksum manifest differs');
      await command('banked-evidence-checksums', '/usr/bin/sha256sum', ['-c', 'checksums.sha256'], { cwd: baseline });
    });
    await check('raid', async () => {
      await save('mdstat.txt', await readFile('/proc/mdstat', 'utf8'));
      const arrays = [];
      for (const name of (await readdir('/sys/block')).filter((item) => /^md\d+$/u.test(item)).sort()) {
        const base = `/sys/block/${name}`;
        const members = (await readdir(`${base}/slaves`)).sort();
        arrays.push({ name, members, level: await read(`${base}/md/level`), raidDisks: await read(`${base}/md/raid_disks`),
          degraded: await read(`${base}/md/degraded`), syncAction: await read(`${base}/md/sync_action`), state: await read(`${base}/md/array_state`),
          memberStates: await Promise.all(members.map((member) => read(`${base}/md/dev-${member}/state`))) });
      }
      await save('raid.json', arrays);
      validateRaid(arrays);
    });
    for (const device of ['nvme0n1', 'nvme1n1']) await check(device, async () => {
      const output = await command(device, '/usr/bin/sudo', ['-n', '/usr/local/sbin/fireside-hetzner-smart-read', device]);
      validateSmart(device, JSON.parse(output));
    });
    await check('system', async () => {
      if (await command('system-state', '/usr/bin/systemctl', ['is-system-running']) !== 'running') throw new Error('System not running');
      if (await command('ssh-state', '/usr/bin/systemctl', ['is-active', 'ssh']) !== 'active') throw new Error('SSH not active');
      if (await command('failed-units', '/usr/bin/systemctl', ['--failed', '--no-legend', '--plain']) !== '') throw new Error('Failed systemd units');
    });
    await check('journals', async () => {
      const kernel = await command('kernel-journal', '/usr/bin/journalctl', ['-k', '-b', '--no-pager', '-o', 'short-iso-precise']);
      const journal = await command('boot-journal', '/usr/bin/journalctl', ['-b', '--no-pager', '-o', 'cat']);
      if (!kernel || kernel === '-- No entries --' || !journal || journal === '-- No entries --') throw new Error('Journal evidence unavailable');
      const errors = journalErrors(kernel, journal);
      await save('journal-errors.json', errors);
      if (errors.hardware.length || errors.resources.length) throw new Error('Current-boot hardware/I/O/OOM/resource evidence present');
    });
    await check('disk', async () => {
      const free = {};
      for (const directory of [ROOT, '/srv/dev-fast/p5-runtime']) {
        const status = await statfs(directory);
        free[directory] = Number(status.bavail) * Number(status.bsize);
      }
      await save('available-disk-bytes.json', free);
      if (Object.values(free).some((bytes) => bytes < 80000000000)) throw new Error('Less than 80,000,000,000 available disk bytes');
    });
    await check('quiescence', () => assertQuiescent('initial'));
    // Health or input failure prevents even the authorized swap drain.
    if (result.failures.length === 0) await check('swap', async () => {
      const before = { swappiness: await read('/proc/sys/vm/swappiness'), memory: await read('/proc/meminfo'), configuredSwap: await read('/proc/swaps') };
      await save('swap-before.json', before);
      try {
        await command('swapoff', '/usr/bin/sudo', ['-n', 'swapoff', '-a'], { timeout: 120000 });
      } finally {
        await command('swapon', '/usr/bin/sudo', ['-n', 'swapon', '-a'], { timeout: 120000 });
      }
      const after = { swappiness: await read('/proc/sys/vm/swappiness'), memory: await read('/proc/meminfo'), configuredSwap: await read('/proc/swaps') };
      await save('swap-after.json', after);
      if (before.swappiness !== after.swappiness || before.swappiness !== '60') throw new Error('vm.swappiness differs from setup or changed');
      await save('steady-vmstat.json', steadySwapSamples(await command('vmstat', '/usr/bin/vmstat', ['-w', '1', '4'])));
      await assertQuiescent('after-drain');
    });
    result.passed = result.failures.length === 0;
  } catch (error) {
    result.failures.push(error.stack ?? error.message);
  } finally {
    result.finishedAt = new Date().toISOString();
    await save('result.json', result);
    await writeFile(path.join(resolved, 'checksums.sha256'), files.sort(([a], [b]) => a.localeCompare(b, 'en')).map(([name, digest]) => `${digest}  ./${name}\n`).join(''), { flag: 'wx' });
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (![3, 4].includes(process.argv.length)) throw new Error('Usage: node hetzner-preflight.mjs NEW_EVIDENCE_DIRECTORY [EXACT_CANDIDATE]');
  const result = await preflight(process.argv[2], process.argv[3]);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.passed) process.exitCode = 1;
}
