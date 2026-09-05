#!/usr/bin/env node
// Setup-only destination verification, run only after both transfers exit zero.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, readFile, readdir, readlink, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { ROOT, CANDIDATE, BASELINE_SUMS, INPUTS, validateInputReceipt } from './hetzner-preflight.mjs';

if (process.argv.slice(2).join(' ') !== '--transfers-exited-zero') {
  throw new Error('Require observed successful transfer exits before verification');
}
const output = path.join(ROOT, 'input-verification.json');
try { await access(output); throw new Error('Input receipt already exists; do not overwrite'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

for (const pid of (await readdir('/proc')).filter(value => /^\d+$/u.test(value))) {
  try {
    const name = (await readFile(`/proc/${pid}/comm`, 'utf8')).trim();
    if (!['rsync', 'scp', 'sftp', 'sftp-server', 'tar'].includes(name)) continue;
    const command = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).replaceAll('\0', ' ');
    const cwd = await readlink(`/proc/${pid}/cwd`);
    if (command.includes(ROOT) || cwd.startsWith(`${ROOT}/inputs`) || cwd.startsWith(`${ROOT}/banked-r36`)) {
      throw new Error(`Transfer remains active: pid=${pid} command=${command}`);
    }
  } catch (error) {
    if (!['ENOENT', 'EACCES', 'EPERM', 'ESRCH'].includes(error.code)) throw error;
  }
}

async function files(directory, relative = '') {
  const listing = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const next = path.join(relative, entry.name);
    if (entry.isDirectory()) listing.push(...await files(path.join(directory, entry.name), next));
    else if (entry.isFile()) listing.push(next);
    else throw new Error(`Non-regular input: ${next}`);
  }
  return listing;
}

const receipt = {
  root: ROOT, candidate: CANDIDATE, startedAtIso: new Date().toISOString(),
  completed: false, allTransfersComplete: true, bankedEvidenceChecksumsSha256: '', trees: {},
};
for (const [relative, expected] of Object.entries(INPUTS)) {
  const directory = path.join(ROOT, relative);
  const listing = (await files(directory)).sort((a, b) => Buffer.compare(Buffer.from(`./${a}`), Buffer.from(`./${b}`)));
  const aggregate = createHash('sha256');
  let bytes = 0;
  for (const name of listing) {
    const absolute = path.join(directory, name);
    const digest = createHash('sha256');
    const before = await stat(absolute);
    for await (const chunk of createReadStream(absolute)) digest.update(chunk);
    const after = await stat(absolute);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error(`Input changed while hashing: ${relative}/${name}`);
    bytes += after.size;
    aggregate.update(`${digest.digest('hex')}  ./${name}\n`);
  }
  const observed = { files: listing.length, bytes, sha256: aggregate.digest('hex') };
  if (observed.files !== expected[0] || observed.bytes !== expected[1] || observed.sha256 !== expected[2]) {
    throw new Error(`Transferred identity mismatch: ${JSON.stringify({ relative, observed, expected })}`);
  }
  receipt.trees[relative] = observed;
  process.stdout.write(`${JSON.stringify({ relative, ...observed, verified: true })}\n`);
}
const baseline = path.join(ROOT, 'banked-r36/evidence');
receipt.bankedEvidenceChecksumsSha256 = createHash('sha256').update(await readFile(path.join(baseline, 'checksums.sha256'))).digest('hex');
if (receipt.bankedEvidenceChecksumsSha256 !== BASELINE_SUMS) throw new Error('Banked evidence inventory changed');
execFileSync('/usr/bin/sha256sum', ['-c', 'checksums.sha256'], { cwd: baseline, stdio: 'inherit' });
receipt.completed = true;
receipt.verifiedAtIso = new Date().toISOString();
validateInputReceipt(receipt);
await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
process.stdout.write(`${JSON.stringify({ receipt: output, completed: true, verifiedAtIso: receipt.verifiedAtIso })}\n`);
