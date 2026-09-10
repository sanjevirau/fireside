import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { assets, verifyAsset } from '../packages/cli/src/assets.mjs';
import { manifest, platformKey, release, sha256, verifyBinary } from '../packages/cli/src/binary.mjs';
import { canonical, loadProject, parseOptions } from '../packages/cli/src/options.mjs';
import { prepareLaunch, supervise } from '../packages/cli/src/runtime.mjs';

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'fireside-cli-test-'));
  const config = {firestore:{rules:'firestore.rules'}, storage:[{target:'default',rules:'storage.rules'}], functions:{source:'functions'},
    emulators:Object.fromEntries(['firestore','auth','storage','functions','pubsub'].map(name=>[name,{}]))};
  writeFileSync(join(dir, 'firebase.json'), JSON.stringify(config));
  writeFileSync(join(dir, '.firebaserc'), JSON.stringify({projects:{default:'demo-fixture', local:'demo-local'}}));
  return {dir, config, options:{'storage-bucket':[]}};
}
function binaryPackage() {
  const dir = mkdtempSync(join(tmpdir(), 'fireside-bin-test-'));
  mkdirSync(join(dir,'bin'));
  writeFileSync(join(dir,'bin/fireside'), '#!/bin/sh\nexit 0\n', {mode:0o755});
  writeFileSync(join(dir,'package.json'), JSON.stringify({name:'@fireside-dev/darwin-arm64',version:manifest.version}));
  const receipt = {version:manifest.version,platform:'darwin-arm64',target:release.platforms['darwin-arm64'],engineRevision:release.engineRevision,sha256:sha256(readFileSync(join(dir,'bin/fireside')))};
  writeFileSync(join(dir,'receipt.json'), JSON.stringify(receipt));
  return {dir,receipt};
}

test('CLI source oracle pins asset hashes and export conventions', () => {
  const oracle = JSON.parse(readFileSync(new URL('fixtures/firebase-cli-15.22.0.json', import.meta.url)));
  for (const asset of assets) { assert.equal(asset.sha256,oracle[asset.name].sha256); assert.equal(asset.bytes,oracle[asset.name].bytes); }
  assert.equal(oracle.exportWithoutImportOrDestination,'reject');
});
test('registry-only exact dependencies; no lifecycle scripts or source-build installer', () => {
  assert.equal(manifest.scripts,undefined);
  assert.equal(manifest.name,'@fireside-dev/cli');
  for (const version of Object.values({...manifest.dependencies,...manifest.optionalDependencies})) assert.match(version,/^\d+\.\d+\.\d+(?:-[a-z]+\.\d+)?$/);
  assert.equal(manifest.bin.fireside,'bin/fireside.mjs');
});
test('explicit supported platforms; untested architectures and musl rejected', () => {
  assert.equal(platformKey('linux','x64',{header:{glibcVersionRuntime:'2.39'}}),'linux-x64');
  assert.equal(platformKey('darwin','arm64',{}),'darwin-arm64');
  for (const key of Object.keys(release.platforms)) {
    const [os, cpu] = key.split('-');
    assert.equal(platformKey(os,cpu,{header:{glibcVersionRuntime:'2.39'}}),key);
  }
  for (const args of [['linux','x64',{}],['linux','arm64',{}],['win32','ia32',{}],['darwin','ia32',{}]]) assert.throws(()=>platformKey(...args),/Unsupported/);
});
test('binary checks identity, target, checksum and executable bit', () => {
  const {dir,receipt} = binaryPackage();
  assert.equal(verifyBinary(dir,'darwin-arm64'),join(dir,'bin/fireside'));
  for (const [key,value] of [['version','9.9.9'],['engineRevision','wrong'],['platform','linux-x64'],['target','wrong'],['sha256','wrong']]) {
    writeFileSync(join(dir,'receipt.json'),JSON.stringify({...receipt,[key]:value}));
    assert.throws(()=>verifyBinary(dir,'darwin-arm64'));
  }
  writeFileSync(join(dir,'receipt.json'),JSON.stringify(receipt));
  chmodSync(join(dir,'bin/fireside'),0o600);
  if (process.platform !== 'win32') assert.throws(()=>verifyBinary(dir,'darwin-arm64'));
});
test('options preserve argv; no ignored flags, duplicate options or shell interpretation', () => {
  const parsed = parseOptions(['--project=demo-a','--import','seed','--export-on-exit','--storage-bucket','default=demo-a','--','echo','hello;touch nope']);
  assert.equal(parsed.options['export-on-exit'],true);
  assert.deepEqual(parsed.command,['echo','hello;touch nope']);
  assert.equal(parseOptions(['--no-diagnostics']).options['no-diagnostics'], true);
  assert.throws(() => parseOptions(['--no-diagnostics=false']));
  for (const args of [['--wat'],['--project'],['--project=a','--project=b'],['--resume-state=false']]) assert.throws(()=>parseOptions(args));
});
test('existing config, project aliases and exact full --only selection', () => {
  const {dir,options} = project();
  assert.equal(loadProject(options,dir).project,'demo-fixture');
  assert.equal(loadProject({...options,project:'local'},dir).project,'demo-local');
  assert.equal(loadProject({...options,only:'storage,auth,firestore,pubsub,functions'},dir).ports.firestore,8080);
  for (const only of ['firestore','database','firestore,auth,storage,functions,pubsub,auth']) assert.throws(()=>loadProject({...options,only},dir),/profile|Partial/);
});
test('unsupported config and real project IDs fail before side effects', () => {
  const {dir,config,options} = project();
  assert.throws(()=>loadProject({...options,project:'real-production'},dir),/demo-/);
  config.emulators.database = {};
  writeFileSync(join(dir,'firebase.json'),JSON.stringify(config));
  assert.throws(()=>loadProject(options,dir),/Unsupported configured emulator/);
});
test('zero, conflicting and configured WebSocket ports are checked', () => {
  const {dir,config,options} = project();
  config.emulators.firestore.websocketPort=32011;
  writeFileSync(join(dir,'firebase.json'),JSON.stringify(config));
  assert.equal(loadProject(options,dir).ports['firestore-websocket'],32011);
  assert.throws(()=>loadProject({...options,'firestore-websocket-port':'8080'},dir),/distinct/);
  config.emulators.firestore.port=0;
  writeFileSync(join(dir,'firebase.json'),JSON.stringify(config));
  assert.throws(()=>loadProject(options,dir),/Invalid port/);
});
test('export default, parent/symlink safety and resume isolation', () => {
  const {dir,options} = project();
  assert.throws(()=>loadProject({...options,'export-on-exit':true},dir),/requires/);
  assert.equal(loadProject({...options,import:'seed','export-on-exit':true},dir).exported,canonical(join(dir,'seed')));
  for (const destination of ['.','..']) assert.throws(()=>loadProject({...options,'export-on-exit':destination},dir),/ancestor/);
  symlinkSync(dir,join(dir,'alias'),process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(canonical(join(dir,'alias','new')),canonical(join(dir,'new')));
  assert.throws(()=>loadProject({...options,'export-on-exit':'alias'},dir),/ancestor/);
  assert.throws(()=>loadProject({...options,import:'seed','state-dir':'seed/state'},dir),/separate/);
  assert.throws(()=>loadProject({...options,import:'seed','state-dir':'work','resume-state':true,'export-on-exit':true},dir),/immutable seed/);
  assert.throws(()=>loadProject({...options,'resume-state':true},dir),/requires/);
  mkdirSync(join(dir,'existing'));
  writeFileSync(join(dir,'existing','data'),'preserve');
  assert.throws(()=>loadProject({...options,'state-dir':'existing'},dir),/nonempty state/);
  assert.equal(readFileSync(join(dir,'existing','data'),'utf8'),'preserve');
});
test('state and credential isolation stay outside original config and seed', () => {
  const {dir,options} = project();
  const before = readFileSync(join(dir,'firebase.json'),'utf8');
  const diagnostic = {project:loadProject(options,dir),binary:'/fake',toolsRoot:'/tools',java:'/java',files:{storageRules:'/rules',ui:'/ui'}};
  const launch = prepareLaunch(diagnostic,options);
  assert.equal(readFileSync(join(dir,'firebase.json'),'utf8'),before);
  assert.ok(launch.args.includes('--state-dir'));
  assert.ok(!launch.args.includes('--firestore-memory'));
  assert.ok(!launch.args.includes('--no-diagnostics'));
  assert.ok(prepareLaunch(diagnostic, {...options, 'no-diagnostics': true}).args.includes('--no-diagnostics'));
  assert.equal(launch.env.GCLOUD_PROJECT,'demo-fixture');
  assert.equal(launch.env.FIREBASE_AUTH_EMULATOR_HOST,'127.0.0.1:9099');
  assert.equal(launch.env.FIREBASE_TOKEN,undefined);
});
test('asset verification refuses corrupt data without changing it', async () => {
  const dir = mkdtempSync(join(tmpdir(),'fireside-asset-test-'));
  const file = join(dir,'test'); writeFileSync(file,'okay');
  await verifyAsset(file,{bytes:4,sha256:sha256('okay')});
  await assert.rejects(verifyAsset(file,{bytes:4,sha256:'wrong'}),/Checksum/);
  assert.equal(readFileSync(file,'utf8'),'okay');
});
test('exec waits for child readiness and graceful shutdown, preserves test status', async () => {
  const launch = {binary:process.execPath,args:['-e', `const stop=()=>setTimeout(()=>process.exit(0),60); process.on('SIGINT',stop); if(process.platform==='win32') process.stdin.on('data',stop); console.log('All emulators ready'); setInterval(()=>{},1000)`],cwd:process.cwd(),env:process.env};
  assert.equal(await supervise(launch,[process.execPath,'-e','process.exit(7)']),7);
});
test('export failure overrides passing test and unrequested exits fail', async () => {
  const launch = {binary:process.execPath,args:['-e', `const stop=()=>process.exit(9); process.on('SIGINT',stop); if(process.platform==='win32') process.stdin.on('data',stop); console.log('All emulators ready'); setInterval(()=>{},1000)`],cwd:process.cwd(),env:process.env};
  assert.equal(await supervise(launch,[process.execPath,'-e','process.exit(0)']),9);
  await assert.rejects(supervise({...launch,args:['-e','process.exit(0)']}),/unexpectedly/);
});
test('help and version do not need installed binaries; deploy is not intercepted', () => {
  const cli = new URL('../packages/cli/bin/fireside.mjs',import.meta.url);
  assert.equal(spawnSync(process.execPath,[fileURLToPath(cli),'--help']).status,0);
  assert.equal(spawnSync(process.execPath,[fileURLToPath(cli),'--version']).status,0);
  assert.equal(spawnSync(process.execPath,[fileURLToPath(cli),'deploy']).status,1);
});
