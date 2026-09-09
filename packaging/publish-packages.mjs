import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { manifest, release, sha256 } from '../packages/cli/src/binary.mjs';
import { publishVerifiedRelease } from './registry-readiness.mjs';
import { recoveryReceipt, validateRecoveryPackages } from './release-recovery.mjs';
import { auditPublicPackage } from './public-artifacts.mjs';
import { publicationPolicy as loadPublicationPolicy } from './publication-policy.mjs';
import { verifyMissingPublishingAuth } from './publishing-auth.mjs';

const [artifactRoot, mode = '--check'] = process.argv.slice(2);
if (!artifactRoot || !['--check','--publish'].includes(mode)) throw new Error('Usage: publish-packages.mjs ARTIFACT_ROOT [--check|--publish]');
if (mode === '--publish') {
  const source = JSON.parse(readFileSync(new URL('./source-publication.json', import.meta.url)));
  if (source.reviewedCleanPublicHistory !== true) throw new Error('Public source/history cutover must be reviewed before publication');
}
const records = new Map();
const publicationPolicy = loadPublicationPolicy();
for (const platform of Object.keys(release.platforms)) {
  const directory = resolve(artifactRoot, platform);
  const receipt = JSON.parse(readFileSync(join(directory, 'artifacts.json')));
  if (receipt.version !== manifest.version || receipt.platform !== platform || receipt.engineRevision !== release.engineRevision || receipt.packages.length !== 2) throw new Error('Artifact set identity mismatch');
  for (const smoke of ['npm-smoke.json','bun-smoke.json','suite-smoke.json']) {
    const result = JSON.parse(readFileSync(join(directory, smoke)));
    if (result.passed !== true || result.version !== manifest.version || result.engineRevision !== release.engineRevision) throw new Error(`Missing or mismatched passing smoke: ${platform}/${smoke}`);
  }
  for (const record of receipt.packages) {
    if (![manifest.name, `@fireside-dev/${platform}`].includes(record.name) || record.version !== manifest.version || basename(record.filename) !== record.filename || !record.filename.endsWith('.tgz')) throw new Error('Unexpected package in artifact set');
    const path = join(directory, record.filename);
    const bytes = readFileSync(path);
    if (sha256(bytes) !== record.sha256) throw new Error(`Artifact checksum mismatch: ${path}`);
    if (`sha512-${createHash('sha512').update(bytes).digest('base64')}` !== record.integrity) throw new Error(`Artifact integrity mismatch: ${path}`);
    auditPublicPackage(bytes, {name: record.name, version: manifest.version, engineRevision: release.engineRevision}, publicationPolicy);
    if (records.has(record.name) && records.get(record.name).sha256 !== record.sha256) throw new Error('CLI package differs across platform builds');
    records.set(record.name, {...record, path});
  }
}
if (records.size !== Object.keys(release.platforms).length + 1) throw new Error('Incomplete release artifact set');
const ordered = [...records.values()].sort((a, b) => Number(a.name === manifest.name) - Number(b.name === manifest.name));
const recovery = process.env.RELEASE_RESUME === 'true' ? recoveryReceipt() : null;
if (recovery) validateRecoveryPackages(recovery, ordered);
console.log(JSON.stringify({mode, version:manifest.version, packages:ordered}, null, 2));
if (mode === '--publish') {
  await verifyMissingPublishingAuth(ordered, { accepted: recovery?.accepted ?? [] });
  // Native packages first, CLI last. Every package goes to next first, never
  // latest until all exact registry artifacts have been verified.
  await publishVerifiedRelease(ordered, {
    accepted: recovery?.accepted ?? [],
    publish: record => execFileSync('npm', ['publish', record.path, '--provenance', '--access', 'public', '--tag', 'next', '--ignore-scripts'], {stdio:'inherit'}),
  });
  if (!manifest.version.includes('-')) {
    // npm dist-tag is NOT supported by OIDC. Do not fall back to a stored token.
    console.log('All stable artifacts verified on next. Release owner must promote the CLI to latest interactively with 2FA.');
  }
}
