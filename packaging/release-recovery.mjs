import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { manifest, release } from '../packages/cli/src/binary.mjs';

export function recoveryReceipt() {
  // Recovery is opt-in and backed by a version-specific, reviewed receipt.
  // No free-form external run ID or artifact URLs can enter the publisher.
  const receipt = JSON.parse(readFileSync(new URL(`./recoveries/npm-v${manifest.version}.json`, import.meta.url)));
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.tag, `npm-v${manifest.version}`);
  assert.equal(receipt.version, manifest.version);
  assert.equal(receipt.engineRevision, release.engineRevision);
  assert.ok(Number.isSafeInteger(receipt.sourceRun) && receipt.sourceRun > 0);
  assert.match(receipt.sourceCommit, /^[a-f0-9]{40}$/);
  assert.deepEqual(receipt.artifacts.map(a => a.name).sort(), Object.keys(release.platforms).sort());
  assert.deepEqual(receipt.packages.map(p => p.name).sort(), [manifest.name, ...Object.keys(manifest.optionalDependencies)].sort());
  assert.equal(new Set(receipt.accepted).size, receipt.accepted.length);
  for (const name of receipt.accepted) assert.ok(receipt.packages.some(p => p.name === name));
  return receipt;
}

export function validateRecoverySource(receipt, {run, jobs, artifacts}) {
  assert.equal(run.id, receipt.sourceRun);
  assert.equal(run.run_attempt, receipt.sourceAttempt, 'Original run was rerun; re-audit before recovery');
  assert.equal(run.repository.full_name, 'sanjevirau/fireside');
  assert.equal(run.path, '.github/workflows/release-npm.yml');
  assert.equal(run.event, 'workflow_dispatch');
  assert.equal(run.head_branch, 'main');
  assert.equal(run.head_sha, receipt.sourceCommit);
  assert.equal(run.status, 'completed', 'Never recover an active workload');
  assert.equal(run.conclusion, 'failure');
  const required = ['authorize', 'artifacts / verify',
    'quality / Rust quality gate', 'quality / Public fixture and package checks', 'quality / Differential harness',
    ...receipt.artifacts.map(a => `artifacts / Packed install (${a.name})`),
    ...['memory', 'disk-wal'].flatMap(mode => ['memory', 'persistence'].map(client =>
      `quality / Firebase JS SDK browser integration (${mode}, client ${client})`)),
  ];
  for (const name of [...required, 'publish']) {
    const matches = jobs.filter(job => job.name === name);
    assert.equal(matches.length, 1, `Missing or ambiguous source job: ${name}`);
    assert.equal(matches[0].conclusion, name === 'publish' ? 'failure' : 'success', `Source gate failed: ${name}`);
  }
  for (const expected of receipt.artifacts) {
    const matches = artifacts.filter(a => a.id === expected.id && a.name === expected.name);
    assert.equal(matches.length, 1, `Missing pinned artifact: ${expected.name}`);
    const actual = matches[0];
    assert.equal(actual.expired, false, `Expired artifact: ${expected.name}`);
    assert.equal(actual.digest, expected.digest, `Changed artifact archive: ${expected.name}`);
    assert.equal(actual.workflow_run.id, receipt.sourceRun);
    assert.equal(actual.workflow_run.head_sha, receipt.sourceCommit);
    assert.equal(actual.workflow_run.repository_id, actual.workflow_run.head_repository_id);
  }
}

export function validateRecoveryPackages(receipt, records) {
  assert.equal(records.length, receipt.packages.length);
  for (const expected of receipt.packages) {
    const actual = records.find(record => record.name === expected.name);
    assert.ok(actual, `Missing recovery package: ${expected.name}`);
    assert.equal(actual.version, receipt.version);
    assert.equal(actual.sha256, expected.sha256, `Recovery requires original bytes: ${expected.name}`);
    assert.equal(actual.integrity, expected.integrity, `Recovery integrity changed: ${expected.name}`);
  }
}

export function authorizeRecovery(receipt, tagged) {
  assert.equal(tagged, receipt.sourceCommit, 'Never move the reviewed release tag');
  const git = args => execFileSync('git', args, {encoding:'utf8'}).trim();
  git(['merge-base', '--is-ancestor', tagged, 'HEAD']);
  // Only release tooling can differ. Do not publish old bytes as a new CLI or
  // engine, and do not create misleading notes for a changed product.
  git(['diff', '--exit-code', tagged, 'HEAD', '--', 'packages', 'crates', 'Cargo.toml',
    'Cargo.lock', 'rust-toolchain.toml', 'packaging/build-packages.mjs', 'packaging/CHANGELOG.md']);
  const api = path => JSON.parse(execFileSync('gh', ['api', `repos/sanjevirau/fireside/${path}`], {encoding:'utf8',maxBuffer:10*1024*1024}));
  const run = api(`actions/runs/${receipt.sourceRun}`);
  const jobPage = api(`actions/runs/${receipt.sourceRun}/jobs?per_page=100`);
  const artifactPage = api(`actions/runs/${receipt.sourceRun}/artifacts?per_page=100`);
  assert.equal(jobPage.total_count, jobPage.jobs.length, 'Incomplete jobs response');
  assert.equal(artifactPage.total_count, artifactPage.artifacts.length, 'Incomplete artifact response');
  validateRecoverySource(receipt, {run,jobs:jobPage.jobs,artifacts:artifactPage.artifacts});
  console.log(`Recovery authorized for original tag ${receipt.tag}, source run ${receipt.sourceRun}; no rebuild.`);
}
