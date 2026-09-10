// Non-publishing verification for private, current-source platform candidates.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {basename, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {manifest, release, sha256} from '../packages/cli/src/binary.mjs';
import {localIdentity} from './local-identity.mjs';
import {auditPublicPackage, packageEntries} from './public-artifacts.mjs';

export function checkLocalPlatforms(root, revision) {
  assert(/^[a-f0-9]{40}$/.test(revision), 'Exact candidate commit required');
  const platforms = [];
  for (const platform of Object.keys(release.platforms)) {
    const expected = localIdentity(manifest, release, revision, platform);
    const directory = resolve(root, platform);
    const receipt = JSON.parse(readFileSync(join(directory, 'artifacts.json')));
    assert.equal(receipt.platform, platform); assert.equal(receipt.version, expected.manifest.version);
    assert.equal(receipt.engineRevision, revision); assert.equal(receipt.packages.length, 2);
    assert.deepEqual(receipt.packages.map(item => item.name).sort(), [manifest.name, `@fireside-dev/${platform}`].sort());
    for (const name of ['npm-smoke.json', 'bun-smoke.json', 'suite-smoke.json']) {
      const smoke = JSON.parse(readFileSync(join(directory, name)));
      assert.equal(smoke.passed, true); assert.equal(smoke.version, expected.manifest.version);
      assert.equal(smoke.engineRevision, revision);
    }
    for (const record of receipt.packages) {
      assert.equal(record.version, expected.manifest.version);
      assert.equal(basename(record.filename), record.filename); assert(record.filename.endsWith('.tgz'));
      const bytes = readFileSync(join(directory, record.filename));
      assert.equal(sha256(bytes), record.sha256);
      assert.equal('sha512-' + createHash('sha512').update(bytes).digest('base64'), record.integrity);
      auditPublicPackage(bytes, {name: record.name, version: expected.manifest.version,
        engineRevision: revision, localDevelopment: true});
      const entries = packageEntries(bytes);
      assert.equal(JSON.parse(entries.get('package.json')).private, true, 'Every candidate package must be private');
      if (record.name === manifest.name) {
        assert.deepEqual(JSON.parse(entries.get('release.json')), expected.release);
        assert.deepEqual(JSON.parse(entries.get('package.json')).optionalDependencies, expected.manifest.optionalDependencies);
      } else {
        const native = JSON.parse(entries.get('receipt.json'));
        assert.equal(native.platform, platform); assert.equal(native.target, release.platforms[platform]);
        assert.equal(native.version, expected.manifest.version);
        const executable = platform.startsWith('win32') ? 'bin/fireside.exe' : 'bin/fireside';
        assert.equal(native.sha256, sha256(entries.get(executable)));
      }
    }
    platforms.push(platform);
  }
  return {passed: true, publication: false, engineRevision: revision, platforms};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.argv.length, 4, 'Usage: check-local-platforms.mjs ARTIFACT_ROOT EXACT_COMMIT');
  console.log(JSON.stringify(checkLocalPlatforms(process.argv[2], process.argv[3]), null, 2));
}
