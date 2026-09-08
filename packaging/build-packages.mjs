import { chmodSync, copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifest as publishedManifest, release as publishedRelease, sha256 } from '../packages/cli/src/binary.mjs';
import { packResult } from './npm-pack-result.mjs';
import { packageManager } from './package-manager.mjs';
import { localIdentity } from './local-identity.mjs';
import { auditPublicPackage } from './public-artifacts.mjs';
import { publicationPolicy as loadPublicationPolicy } from './publication-policy.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const publicationPolicy = loadPublicationPolicy();
const [binaryArgument, key, outArgument, localRevision] = process.argv.slice(2);
const {manifest,release} = localRevision ? localIdentity(publishedManifest,publishedRelease,localRevision,key)
  : {manifest:publishedManifest,release:publishedRelease};
if (!binaryArgument || !Object.hasOwn(release.platforms, key) || !outArgument) throw new Error('Usage: node packaging/build-packages.mjs BINARY PLATFORM NEW_OUTPUT_DIRECTORY');
const binary = resolve(binaryArgument);
const out = resolve(outArgument);
mkdirSync(dirname(out), {recursive:true});
mkdirSync(out); // refuse to overwrite an earlier release attempt
const packages = [];
for (const name of [key, 'cli']) {
  const dir = join(out, name);
  mkdirSync(dir);
  if (name === 'cli') {
    for (const path of ['src','bin','package.json','release.json','README.md']) cpSync(join(root, 'packages/cli', path), join(dir, path), {recursive:true});
    if (localRevision) {
      writeFileSync(join(dir,'package.json'),JSON.stringify(manifest,null,2)+'\n');
      writeFileSync(join(dir,'release.json'),JSON.stringify(release,null,2)+'\n');
    }
    // Canonical source archive mode on Windows and Unix. Package managers
    // create/fix the installed executable from package.json's bin mapping;
    // the actual npm/Bun command-shim smokes verify this with scripts disabled.
    chmodSync(join(dir, 'bin/fireside.mjs'), 0o644);
  } else {
    const [os, cpu] = key.split('-');
    mkdirSync(join(dir, 'bin'));
    const binaryName = os === 'win32' ? 'fireside.exe' : 'fireside';
    copyFileSync(binary, join(dir, 'bin', binaryName));
    chmodSync(join(dir, 'bin', binaryName), 0o755);
    const platformManifest = {
      name:`@fireside-dev/${key}`, version:manifest.version,
      ...(localRevision ? {private:true} : {}),
      description:`Prebuilt Fireside engine for ${key}; install @fireside-dev/cli`,
      os:[os], cpu:[cpu], ...(os === 'linux' ? {libc:['glibc']} : {}),
      license:manifest.license, repository:{...manifest.repository, directory:'packaging'},
      publishConfig:manifest.publishConfig, files:['bin','receipt.json','LICENSE-MIT','LICENSE-APACHE'],
    };
    writeFileSync(join(dir, 'package.json'), JSON.stringify(platformManifest, null, 2) + '\n');
    writeFileSync(join(dir, 'receipt.json'), JSON.stringify({version:manifest.version, platform:key,
      target:release.platforms[key], engineRevision:release.engineRevision, sha256:sha256(readFileSync(binary))}, null, 2) + '\n');
  }
  for (const license of ['LICENSE-MIT','LICENSE-APACHE']) copyFileSync(join(root, license), join(dir, license));
  const expectedName = name === 'cli' ? manifest.name : `@fireside-dev/${key}`;
  console.log(JSON.stringify({stage:'pack',package:expectedName}));
  const result = packResult(packageManager('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', out], {cwd:dir, encoding:'utf8'}), expectedName);
  console.log(JSON.stringify({stage:'audit',package:expectedName}));
  auditPublicPackage(readFileSync(join(out, result.filename)), {
    name: result.name, version: manifest.version, engineRevision: release.engineRevision, localDevelopment: Boolean(localRevision),
  }, localRevision ? undefined : publicationPolicy);
  console.log(JSON.stringify({stage:'audited',package:expectedName}));
  packages.push({name:result.name, version:result.version, filename:result.filename,
    sha256:sha256(readFileSync(join(out, result.filename))), integrity:result.integrity, files:result.files.map(file => file.path)});
}
const artifactJson = JSON.stringify({schemaVersion:1, platform:key,
  version:manifest.version, engineRevision:release.engineRevision, packages}, null, 2) + '\n';
writeFileSync(join(out, 'artifacts.json'), artifactJson);
writeFileSync(join(out, `${key}-manifest.json`), artifactJson);
console.log(JSON.stringify({directory:out, packages}, null, 2));
