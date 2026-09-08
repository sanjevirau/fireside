// Prove an explicit local dependency pin and rollback in a throwaway consumer.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { manifest } from '../packages/cli/src/binary.mjs';
import { packageManager } from './package-manager.mjs';

const [artifactArgument, registryBaseline = manifest.version] = process.argv.slice(2);
if (!artifactArgument || process.argv.length > 4) throw new Error('Usage: smoke-local-consumer.mjs ARTIFACT_DIRECTORY [EXACT_PUBLISHED_BASELINE]');
assert.match(registryBaseline, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/, 'The registry baseline must be an exact version, not a tag, range or file path');
const artifacts = resolve(artifactArgument);
const receipt = JSON.parse(readFileSync(join(artifacts,'artifacts.json')));
assert.match(receipt.version,/-local\.g[a-f0-9]{12}$/);
const consumer = mkdtempSync(join(tmpdir(),'fireside local override proof-'));
writeFileSync(join(consumer,'package.json'),JSON.stringify({private:true,devDependencies:{[manifest.name]:registryBaseline}},null,2)+'\n');
const bun = args => packageManager('bun',args,{cwd:consumer,stdio:'inherit'});
const cli = join(consumer,'node_modules/@fireside-dev/cli/bin/fireside.mjs');
const version = () => execFileSync(process.execPath,[cli,'--version'],{encoding:'utf8'}).trim();
bun(['install','--ignore-scripts']);
assert.ok(version().startsWith(registryBaseline+' '));
const originals = ['package.json','bun.lock'].map(name=>[name,readFileSync(join(consumer,name))]);
const localManifest = JSON.parse(originals[0][1]);
for(const pkg of receipt.packages) localManifest.devDependencies[pkg.name] = 'file:'+join(artifacts,pkg.filename);
writeFileSync(join(consumer,'package.json'),JSON.stringify(localManifest,null,2)+'\n');
bun(['install','--ignore-scripts']);
assert.ok(version().startsWith(receipt.version+' '));
execFileSync(process.execPath,[cli,'binary-path'],{stdio:'inherit'});
// These are generated test manifests, not the user's checkout. In a real app,
// preserve the local diff for review and restore only these exact dependency
// changes when returning to the published pin.
for(const [name,bytes] of originals) writeFileSync(join(consumer,name),bytes);
bun(['install','--frozen-lockfile','--ignore-scripts']);
assert.ok(version().startsWith(registryBaseline+' '));
for(const [name,bytes] of originals) assert.deepEqual(readFileSync(join(consumer,name)),bytes,name+' changed on rollback');
const result = {passed:true,consumer,candidate:receipt.version,restored:registryBaseline,
  checks:['Bun explicit local tarball dependency pins','binary checksum verified','restored manifests plus frozen-lockfile install restore registry pin'],completedAt:new Date().toISOString()};
writeFileSync(join(artifacts,'local-consumer-smoke.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
