import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { assertPublicText, auditPublicPackage, packageEntries } from './public-artifacts.mjs';

// Synthetic customer markers only; real integration policy stays private.
const policy = {forbiddenTerms: ['private-customer.invalid']};
function archive(files) {
  const blocks = [];
  for (const [name, input, type = '0'] of files) {
    const body = Buffer.from(input), header = Buffer.alloc(512);
    header.write(`package/${name}`);
    header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write('00000000000\0', 136); header.fill(32, 148, 156); header.write(type, 156);
    header.write('ustar\0', 257);
    const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
const expected = {name: '@fireside-dev/linux-x64', version: '0.0.0-test.0', engineRevision: '1'.repeat(40)};
const native = () => [
  ['package.json', JSON.stringify({name: expected.name, version: expected.version})],
  ['receipt.json', JSON.stringify({engineRevision: expected.engineRevision})],
  ['LICENSE-APACHE', 'synthetic license'], ['LICENSE-MIT', 'synthetic license'], ['bin/fireside', 'synthetic executable'],
];

test('allowlisted package bytes pass without extraction or execution', () => {
  assert.equal(auditPublicPackage(archive(native()), expected, policy).passed, true);
});
test('unexpected files, hidden exports, symlinks, path traversal and duplicates fail closed', () => {
  for (const item of [['.env', 'private'], ['reports/acceptance.json', '{}'], ['bin/alias', '', '2']]) {
    assert.throws(() => auditPublicPackage(archive([...native(), item]), expected, policy));
  }
  for (const path of ['../outside', '/absolute', 'a/../outside', 'a\\outside']) {
    assert.throws(() => packageEntries(archive([[path, 'not extracted']])));
  }
  assert.throws(() => packageEntries(archive([['same', '1'], ['same', '2']])));
  assert.throws(() => packageEntries(Buffer.from('not an archive')));
});
test('private context is detected in metadata and native strings without echoing it', () => {
  for (const encoding of ['utf8', 'utf16le']) {
    const bytes = Buffer.from('PRIVATE-CUSTOMER.INVALID', encoding);
    assert.throws(() => assertPublicText(bytes, 'binary', policy), error => {
      assert.match(error.message, /value withheld/);
      assert.ok(!error.message.includes('PRIVATE-CUSTOMER'));
      return true;
    });
  }
  assert.throws(() => assertPublicText(Buffer.concat([Buffer.from([1]), Buffer.from('private-customer.invalid', 'utf16le')]), 'binary', policy));
  const files = native(); files[4][1] = 'private-customer.invalid';
  assert.throws(() => auditPublicPackage(archive(files), expected, policy));
});
test('archive text scanning stays bounded for native-sized inputs', () => {
  const scanner = new URL('./public-artifacts.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--max-old-space-size=64', '--input-type=module', '-e',
    `import {assertPublicText} from ${JSON.stringify(scanner)};
     const bytes = Buffer.alloc(48 * 1024 * 1024, 0x80);
     assertPublicText(bytes, 'synthetic native bytes');
     console.log('bounded scan passed');`], {encoding:'utf8', timeout:30_000});
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /bounded scan passed/);
});
test('bounded scans detect markers across chunk boundaries and both UTF-16 alignments', () => {
  const markers = ['private-customer.invalid', '-----BEGIN PRIVATE KEY-----', 'ghp_' + 'x'.repeat(40),
    'github_pat_' + 'x'.repeat(50), 'npm_' + 'x'.repeat(40), 'AKIA' + 'A'.repeat(16)];
  for (const marker of markers) for (const encoding of ['utf8', 'utf16le']) {
    const value = Buffer.from(marker, encoding);
    for (const displacement of [-value.length + 1, -5, -1, 0, 1]) {
      const bytes = Buffer.alloc(128 * 1024, 65);
      value.copy(bytes, 64 * 1024 + displacement);
      assert.throws(() => assertPublicText(bytes, 'synthetic boundary bytes', policy));
    }
  }
  const longPolicy = {forbiddenTerms: ['界'.repeat(30_000)]};
  const bytes = Buffer.from('A'.repeat(65_535) + longPolicy.forbiddenTerms[0], 'utf8');
  assert.throws(() => assertPublicText(bytes, 'long synthetic rule', longPolicy));
});
test('credential markers, wrong identity and lifecycle scripts are rejected', () => {
  assert.throws(() => assertPublicText(Buffer.from('-----BEGIN PRIVATE KEY-----'), 'fixture', policy));
  assert.throws(() => auditPublicPackage(archive(native()), {...expected, engineRevision: '2'.repeat(40)}, policy));
  const files = native(); files[0][1] = JSON.stringify({...expected, scripts: {postinstall: 'unexpected'}});
  assert.throws(() => auditPublicPackage(archive(files), expected, policy));
});
test('private candidates require explicit local-only inspection and fail public inspection', () => {
  const files = native(); files[0][1] = JSON.stringify({name: expected.name, version: expected.version, private: true});
  assert.throws(() => auditPublicPackage(archive(files), expected, policy));
  assert.equal(auditPublicPackage(archive(files), {...expected, localDevelopment: true}, policy).passed, true);
});
test('current CLI metadata does not link private acceptance or assert a consumer-specific profile', () => {
  const release = JSON.parse(readFileSync(new URL('../packages/cli/release.json', import.meta.url)));
  assert.ok(!Object.hasOwn(release, 'acceptanceReport'));
  assert.ok(!Object.hasOwn(release, 'acceptedBaselineRevision'));
  for (const file of ['README.md', 'package.json', 'bin/fireside.mjs', 'src/options.mjs']) {
    const bytes = readFileSync(new URL(`../packages/cli/${file}`, import.meta.url));
    assert.doesNotMatch(bytes.toString(), /private-customer\.invalid|\/reports\//i);
  }
});
test('publication requires reviewed clean history and public provenance; normal PR checks stay available', () => {
  const check = readFileSync(new URL('./check-release.mjs', import.meta.url), 'utf8');
  const workflow = readFileSync(new URL('../.github/workflows/release-npm.yml', import.meta.url), 'utf8');
  assert.match(check, /source\.reviewedCleanPublicHistory, true/);
  assert.match(workflow, /--jq '\.private' \| grep -qx false/);
  assert.doesNotMatch(workflow, /NPM_CONFIG_PROVENANCE|provenance=false/);
  const packages = readFileSync(new URL('../.github/workflows/packages.yml', import.meta.url), 'utf8');
  assert.match(packages, /actions\/upload-artifact[^\n]*\n\s+if: success\(\)/);
});
test('unreviewed history blocks direct publication before accessing artifacts or npm', () => {
  const source = JSON.parse(readFileSync(new URL('./source-publication.json', import.meta.url)));
  if (source.reviewedCleanPublicHistory) return;
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./publish-packages.mjs', import.meta.url)), 'nonexistent-artifacts', '--publish'], {encoding: 'utf8'});
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cutover must be reviewed before publication/);
  assert.doesNotMatch(result.stderr, /ENOENT/);
});
