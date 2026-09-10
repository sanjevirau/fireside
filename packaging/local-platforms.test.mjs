import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {gzipSync} from 'node:zlib';
import {manifest, release} from '../packages/cli/src/binary.mjs';
import {localIdentity} from './local-identity.mjs';
import {checkLocalPlatforms} from './check-local-platforms.mjs';

// Constructed artifact-verifier models, never executable/platform evidence.
function archive(files) {
  const blocks = [];
  for (const [name, input] of Object.entries(files)) {
    const body = Buffer.from(input), header = Buffer.alloc(512);
    header.write('package/' + name); header.write('0000644\0', 100);
    header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write('00000000000\0', 136); header.fill(32, 148, 156);
    header.write('0', 156); header.write('ustar\0', 257);
    header.write([...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
const revision = '1'.repeat(40);
function fixture(root, fault) {
  for (const platform of Object.keys(release.platforms)) {
    const directory = join(root, platform); mkdirSync(directory);
    const identity = localIdentity(manifest, release, revision, platform);
    const version = identity.manifest.version;
    const packages = [];
    for (const name of [manifest.name, `@fireside-dev/${platform}`]) {
      const cli = name === manifest.name;
      const metadata = cli ? {...identity.manifest} : {name, version, private: true};
      if (fault === 'non-private') delete metadata.private;
      if (fault === 'wrong-dependency' && cli) metadata.optionalDependencies = {};
      const files = {'package.json': JSON.stringify(metadata), 'LICENSE-MIT': 'synthetic', 'LICENSE-APACHE': 'synthetic'};
      if (cli) {
        files['release.json'] = JSON.stringify(identity.release);
        for (const path of ['README.md', 'bin/fireside.mjs', 'src/assets.mjs', 'src/binary.mjs', 'src/options.mjs', 'src/processes.mjs', 'src/runtime.mjs']) files[path] = 'synthetic';
      } else {
        files['receipt.json'] = JSON.stringify({engineRevision: revision, platform,
          version, target: release.platforms[platform],
          sha256: createHash('sha256').update('not an executable').digest('hex')});
        files[platform.startsWith('win32') ? 'bin/fireside.exe' : 'bin/fireside'] = 'not an executable';
      }
      const bytes = archive(files), filename = cli ? 'cli.tgz' : 'native.tgz';
      writeFileSync(join(directory, filename), bytes);
      packages.push({name, version, filename,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64')});
    }
    if (fault === 'checksum') packages[0].sha256 = '0'.repeat(64);
    if (fault === 'duplicate-package') packages[1] = packages[0];
    writeFileSync(join(directory, 'artifacts.json'), JSON.stringify({platform, version, engineRevision: revision, packages}));
    for (const name of ['npm-smoke.json', 'bun-smoke.json', 'suite-smoke.json']) {
      writeFileSync(join(directory, name), JSON.stringify({passed: fault !== 'failed-smoke', version,
        engineRevision: fault === 'wrong-smoke-revision' ? '2'.repeat(40) : revision}));
    }
  }
}
test('current-source platform checker accepts complete private identities and never publishes', () => {
  const root = mkdtempSync(join(tmpdir(), 'fireside-candidate-model-'));
  try {
    fixture(root);
    assert.deepEqual(checkLocalPlatforms(root, revision), {passed: true, publication: false,
      engineRevision: revision, platforms: Object.keys(release.platforms)});
    assert.throws(() => checkLocalPlatforms(root, 'main'), /Exact candidate/);
    assert.throws(() => checkLocalPlatforms(root, '2'.repeat(40)));
  } finally {rmSync(root, {recursive: true, force: true});}
});
test('candidate checks reject missing platforms, wrong identity, corrupted bytes and incomplete smokes', () => {
  for (const fault of ['non-private', 'wrong-dependency', 'checksum', 'duplicate-package', 'failed-smoke', 'wrong-smoke-revision', 'missing-platform']) {
    const root = mkdtempSync(join(tmpdir(), 'fireside-candidate-model-'));
    try {
      fixture(root, fault);
      if (fault === 'missing-platform') rmSync(join(root, 'win32-x64'), {recursive: true});
      assert.throws(() => checkLocalPlatforms(root, revision), fault);
    } finally {rmSync(root, {recursive: true, force: true});}
  }
});
test('manual candidate workflow preserves the separate release-pinned verification path', () => {
  const workflow = readFileSync(new URL('../.github/workflows/packages.yml', import.meta.url), 'utf8');
  assert.match(workflow, /candidate\?process.env.CANDIDATE_REVISION:r.engineRevision/);
  assert.match(workflow, /github.event.pull_request.head.sha \|\| github.sha/);
  assert.match(workflow, /if: inputs.candidate \|\| github.event_name == 'pull_request'/);
  assert.match(workflow, /node packaging\/check-local-platforms.mjs dist "\$CANDIDATE_REVISION"/);
  assert.match(workflow, /if: \$\{\{ !inputs.candidate && github.event_name != 'pull_request' \}\}\n\s+run: node packaging\/publish-packages.mjs dist --check/);
  assert.doesNotMatch(workflow, /--publish|id-token: write/);
});
