import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { BASELINE_SUMS, CANDIDATE, INPUTS, ROOT, journalErrors, processConflict, steadySwapSamples, validateCandidate, validateInputReceipt, validateRaid, validateSmart } from './hetzner-preflight.mjs';

test('corrected-candidate preflight retains the historical input receipt identity', () => {
  assert.equal(validateCandidate('abf4df4c396010f7970b3e0091df3a6ed103cba9'), 'abf4df4c396010f7970b3e0091df3a6ed103cba9');
  for (const invalid of ['', 'HEAD', 'main', 'a'.repeat(39), 'a'.repeat(41), undefined, null]) assert.throws(() => validateCandidate(invalid));
  assert.doesNotThrow(() => validateInputReceipt(receipt()));
  assert.throws(() => validateInputReceipt({ ...receipt(), candidate: 'abf4df4c396010f7970b3e0091df3a6ed103cba9' }));
});

test('corrected-candidate controller keeps seven-job CI and all launch interlocks', async () => {
  const launcher = await readFile(new URL('./deploy-templates-candidate-then-r36.sh', import.meta.url), 'utf8');
  for (const required of ['phase5_candidate="$3"', 'ci.headSha !== candidate', 'ci.jobs.length !== 7',
    'test -d "$phase5_fresh/.git"', 'test ! -e "$phase5_fresh/apps/templates-firebase/loadData/datasets/full-data"',
    'fresh-acceptance/$1/fresh-colleague', '--fresh-dir "$phase5_fresh"', 'cargo build --release --locked',
    'phase5_manifest=c281263a95cadb7ba254d9b9355bd00808c6054865853158adc54a9886b683aa',
    'phase5_runner=ad61e2e6720abe5e53c745ec264c94166ccd3ff9662c84c1655062c9dd0258cc']) assert.ok(launcher.includes(required), required);
  for (const stage of ['build', 'smoke', 'full']) assert.ok(launcher.includes(`preflight-before-${stage}" "$phase5_candidate"`));
  assert.ok(launcher.indexOf('preflight-before-build') < launcher.indexOf('cargo build --release --locked'));
  assert.ok(launcher.indexOf('preflight-before-smoke') < launcher.indexOf('-- --smoke'));
  assert.ok(launcher.indexOf('preflight-before-full') < launcher.indexOf('--official-baseline-evidence "$phase5_baseline"'));
  assert.ok(launcher.includes('Cheap smoke failed; stopping without a full-data run or silent retry.'));
});

const raid = () => [0, 1, 2].map((index) => ({ name: `md${index}`, level: 'raid1', raidDisks: '2', degraded: '0', syncAction: 'idle', state: 'clean', members: [`nvme0n1p${index + 1}`, `nvme1n1p${index + 1}`], memberStates: ['in_sync', 'in_sync'] }));
const smart = () => ({ device: { name: '/dev/nvme0n1' }, smartctl: { exit_status: 0 }, smart_status: { passed: true }, nvme_smart_health_information_log: { critical_warning: 0, media_errors: 0, num_err_log_entries: 0 } });
const receipt = () => ({ root: ROOT, candidate: CANDIDATE, completed: true, allTransfersComplete: true, verifiedAtIso: '2026-09-05T10:00:00Z', bankedEvidenceChecksumsSha256: BASELINE_SUMS, trees: Object.fromEntries(Object.entries(INPUTS).map(([name, [files, bytes, sha256]]) => [name, { files, bytes, sha256 }])) });

test('all three expected complete idle RAID1 arrays pass', () => assert.doesNotThrow(() => validateRaid(raid())));
test('r47 exact write-pending capture remains a rejected readiness state', async () => {
  const fixture = JSON.parse(await readFile(new URL('../../conformance/fixtures/phase5/raid-write-pending-r47.json', import.meta.url), 'utf8'));
  const captured = JSON.parse(await readFile(new URL('../phase-5-metrics/hetzner-r47-20260905/completed-attempt/preflight-before-full/raid.json', import.meta.url), 'utf8'));
  assert.equal(fixture.observed.fullWorkloadStarted, false);
  assert.equal(captured[2].state, 'write-pending');
  assert.throws(() => validateRaid(captured), /write-pending/u);
});
test('resync, degraded, inactive, unexpected or missing RAID members block', () => {
  for (const [field, value] of [['syncAction', 'resync'], ['syncAction', 'check'], ['degraded', '1'], ['state', 'inactive'], ['raidDisks', '1'], ['level', 'raid0'], ['members', ['nvme0n1p1']], ['memberStates', ['in_sync', 'faulty']]]) {
    const arrays = raid(); arrays[0][field] = value;
    assert.throws(() => validateRaid(arrays));
  }
  assert.throws(() => validateRaid(raid().slice(1)));
  assert.throws(() => validateRaid([...raid(), { ...raid()[0], name: 'md3' }]));
});
test('both fixed SMART identities require explicit zero health and error counters', () => {
  assert.doesNotThrow(() => validateSmart('nvme0n1', smart()));
  assert.throws(() => validateSmart('nvme1n1', smart()));
  for (const field of ['critical_warning', 'media_errors', 'num_err_log_entries']) {
    const report = smart(); report.nvme_smart_health_information_log[field] = 1;
    assert.throws(() => validateSmart('nvme0n1', report));
    delete report.nvme_smart_health_information_log[field];
    assert.throws(() => validateSmart('nvme0n1', report));
  }
  const report = smart(); report.smartctl.exit_status = 4;
  assert.throws(() => validateSmart('nvme0n1', report));
});
test('input receipt cannot accept live profile drift, partial transfers or wrong host', () => {
  assert.doesNotThrow(() => validateInputReceipt(receipt()));
  for (const field of ['completed', 'allTransfersComplete']) {
    const record = receipt(); record[field] = false;
    assert.throws(() => validateInputReceipt(record));
  }
  const record = receipt(); record.trees['inputs/full-data'].bytes -= 507;
  assert.throws(() => validateInputReceipt(record));
  record.root = '/tmp/other';
  assert.throws(() => validateInputReceipt(record));
});
test('journal predicates detect original storage failure and resource failures without generic error noise', () => {
  const result = journalErrors('nvme0n1: I/O Error\ncritical medium error\nEXT4-fs error\nACPI: unrelated notice', 'task: Killed process 42\nresource temporarily unavailable');
  assert.equal(result.hardware.length, 3);
  assert.equal(result.resources.length, 2);
  assert.deepEqual(journalErrors('PCI: normal startup\nerror-log capabilities supported', 'sshd: session opened'), { hardware: [], resources: [] });
});
test('r45 captured NVMe shutdown-budget notices are not actual timeouts', async () => {
  const captured = JSON.parse(await readFile(new URL('./r45-preflight-rejected/preflight-before-build/journal-errors.json', import.meta.url), 'utf8'));
  assert.equal(captured.hardware.length, 2);
  assert.deepEqual(journalErrors(captured.hardware.join('\n'), ''), { hardware: [], resources: [] });
});
test('NVMe fault detection remains fail-closed beside an informational shutdown budget', () => {
  const faults = [
    'nvme nvme0: I/O 17 QID 1 timeout, aborting',
    'nvme nvme0: I/O 17 QID 1 timeout, reset controller',
    'nvme nvme0: controller is down; will reset',
    'nvme nvme1: Shutdown timeout set to 10 seconds; I/O Error',
    'nvme nvme0: critical medium error',
    'nvme nvme0: I/O timed out',
    'nvme nvme0: Abort status: 0x371',
  ];
  for (const fault of faults) {
    assert.deepEqual(journalErrors(`nvme nvme0: Shutdown timeout set to 10 seconds\n${fault}`, '').hardware, [fault]);
  }
});
test('vmstat discards boot average but requires three zero steady samples', () => {
  const row = (si, so) => `1 0 100 900 0 0 ${si} ${so} 0 0 1 1 1 1 98 0 0`;
  assert.equal(steadySwapSamples([row(50, 50), row(0, 0), row(0, 0), row(0, 0)].join('\n')).length, 3);
  assert.throws(() => steadySwapSamples([row(0, 0), row(0, 0), row(1, 0)].join('\n')));
  assert.throws(() => steadySwapSamples(row(0, 0)));
});
test('conflict scan sees stack work and scoped transfers, not proxy/controller/read-only inventory', () => {
  assert.equal(processConflict('node', 'node server.js', `${ROOT}/stack-fireside/apps/templates`), true);
  assert.equal(processConflict('rsync', `rsync --server . ${ROOT}/inputs/full-data`, '/home/sanjevi'), true);
  assert.equal(processConflict('tar', `tar xf - -C ${ROOT}/banked-r36/exports/official/full-data`, '/home/sanjevi'), true);
  assert.equal(processConflict('node', 'node portless proxy start', '/home/sanjevi'), false);
  assert.equal(processConflict('bash', `bash ${ROOT}/deployment/deploy-b5fe1d5-then-r36.sh r45`, '/home/sanjevi'), false);
  assert.equal(processConflict('sha256sum', `sha256sum ${ROOT}/inputs/full-data/file`, '/home/sanjevi'), false);
  assert.equal(processConflict('node', 'node conformance/src/suite/run-phase5-gate.ts', `${ROOT}/attempts/other/harness`), true);
});
test('launcher pins candidate/manifest/runner and gates build, smoke and full independently', async () => {
  const launcher = await readFile(new URL('./deploy-b5fe1d5-then-r36.sh', import.meta.url), 'utf8');
  assert.ok(launcher.includes(`phase5_candidate=${CANDIDATE}`));
  assert.ok(launcher.includes('phase5_manifest=c281263a95cadb7ba254d9b9355bd00808c6054865853158adc54a9886b683aa'));
  assert.ok(launcher.includes('phase5_runner=ad61e2e6720abe5e53c745ec264c94166ccd3ff9662c84c1655062c9dd0258cc'));
  assert.ok(launcher.indexOf('preflight-before-build') < launcher.indexOf('cargo build --release --locked'));
  assert.ok(launcher.indexOf('preflight-before-smoke') < launcher.indexOf('-- --smoke'));
  assert.ok(launcher.indexOf('preflight-before-full') < launcher.indexOf('--official-baseline-evidence "$phase5_baseline"'));
  assert.ok(launcher.includes('ci.jobs.length !== 7'));
  assert.ok(launcher.includes('bash -e -u -o pipefail -s --'));
});
