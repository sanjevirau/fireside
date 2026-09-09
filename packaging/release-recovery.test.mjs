import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { recoveryReceipt, validateRecoverySource, validateRecoveryPackages } from './release-recovery.mjs';

import { syntheticRecoveryFixture } from './synthetic-recovery-fixture.mjs';
const {fixture, receipt} = syntheticRecoveryFixture();

test('synthetic recovery requires all seven quality and five platform gates green', () => {
  validateRecoverySource(receipt, fixture);
});

test('recovery rejects changed identity, active/rerun source and any failed prerequisite', () => {
  const corruptions = [
    f=>{f.run.id++;}, f=>{f.run.head_sha='0'.repeat(40);}, f=>{f.run.head_branch='feature/unreviewed';},
    f=>{f.run.repository.full_name='other/repo';}, f=>{f.run.path='.github/workflows/other.yml';},
    f=>{f.run.event='pull_request';}, f=>{f.run.status='in_progress';}, f=>{f.run.run_attempt++;},
    f=>{f.run.conclusion='success';}, f=>{f.jobs=f.jobs.filter(j=>j.name!=='authorize');},
    f=>{f.jobs.push(f.jobs[0]);}, f=>{f.jobs.find(j=>j.name==='publish').conclusion='success';},
    f=>{f.artifacts[0].expired=true;}, f=>{f.artifacts[0].digest='sha256-changed';},
    f=>{f.artifacts[0].id++;}, f=>{f.artifacts[0].workflow_run.head_sha='0'.repeat(40);},
  ];
  for (const change of corruptions) {
    const altered = structuredClone(fixture); change(altered);
    assert.throws(()=>validateRecoverySource(receipt, altered));
  }
  for (const job of fixture.jobs.filter(j=>j.conclusion==='success')) {
    const altered=structuredClone(fixture);
    altered.jobs.find(j=>j.name===job.name).conclusion='failure';
    assert.throws(()=>validateRecoverySource(receipt, altered), undefined, job.name);
  }
});

test('recovery requires all six original tarball checksums and integrities', () => {
  const records=receipt.packages.map(p=>({...p,version:receipt.version}));
  validateRecoveryPackages(receipt,records);
  assert.throws(()=>validateRecoveryPackages(receipt,records.slice(1)));
  for (const key of ['name','version','sha256','integrity']) {
    const altered=structuredClone(records); altered[0][key]='changed';
    assert.throws(()=>validateRecoveryPackages(receipt,altered));
  }
});

test('only an existing version-specific receipt enables recovery', () => {
  const current=JSON.parse(readFileSync(new URL('../packages/cli/package.json',import.meta.url)));
  const path=new URL(`./recoveries/npm-v${current.version}.json`,import.meta.url);
  if (existsSync(path)) assert.deepEqual(recoveryReceipt(),JSON.parse(readFileSync(path)));
  else assert.throws(()=>recoveryReceipt(),/ENOENT/);
});

test('recovery preserves protected OIDC workflow and cannot fall through failed fresh gates', () => {
  const workflow=readFileSync(new URL('../.github/workflows/release-npm.yml',import.meta.url),'utf8');
  assert.match(workflow,/environment: npm-release/);
  assert.match(workflow,/id-token: write/);
  assert.match(workflow,/needs: \[authorize, quality, artifacts\]/);
  assert.match(workflow,/always\(\) && needs.authorize.result == 'success' && \(inputs.resume \|\| \(needs.quality.result == 'success' && needs.artifacts.result == 'success'\)\)/);
  assert.match(workflow,/run-id: \$\{\{ needs.authorize.outputs.source_run \|\| github.run_id \}\}/);
  assert.match(workflow,/artifact-ids: \$\{\{ needs.authorize.outputs.artifact_ids \}\}/);
  assert.doesNotMatch(workflow,/NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./);
});
