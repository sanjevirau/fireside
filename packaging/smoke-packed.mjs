import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { packageManager } from './package-manager.mjs';
import { nativeEnvironment, requestNativeStop } from '../packages/cli/src/processes.mjs';

const [directoryArgument, manager = 'npm'] = process.argv.slice(2);
if (!directoryArgument || !['npm','bun'].includes(manager)) throw new Error('Usage: smoke-packed.mjs ARTIFACT_DIRECTORY [npm|bun]');
const directory = resolve(directoryArgument);
const receipt = JSON.parse(readFileSync(join(directory,'artifacts.json')));
const consumer = mkdtempSync(join(tmpdir(),`fireside ${manager} 中文 consumer-`));
writeFileSync(join(consumer,'package.json'),JSON.stringify({name:'fireside-install-smoke',private:true,version:'1.0.0'}));
const tarballs = receipt.packages.map(pkg=>join(directory,pkg.filename));
const testDependencies = ['@google-cloud/firestore@9.0.0'];
packageManager(manager,manager === 'npm' ? ['install','--ignore-scripts','--no-audit','--no-fund',...tarballs,...testDependencies] : ['add','--ignore-scripts',...tarballs,...testDependencies],{cwd:consumer,stdio:'inherit'});
const installedVersion = packageManager(manager, manager === 'npm' ? ['exec','--offline','--','fireside','--version'] : ['run','fireside','--version'], {cwd:consumer,encoding:'utf8'});
assert.ok(installedVersion.includes(receipt.version),'Installed command shim must work');
const cli = join(consumer,'node_modules/@fireside-dev/cli/bin/fireside.mjs');
const binary = execFileSync(process.execPath,[cli,'binary-path'],{cwd:consumer,encoding:'utf8'}).trim();
assert.match(execFileSync(process.execPath,[cli,'--version'],{encoding:'utf8'}),new RegExp(receipt.version.replaceAll('.','\\.')));
const require = createRequire(join(consumer,'package.json'));
const {Firestore} = require('@google-cloud/firestore');
const reservation = createServer(); reservation.listen(0,'127.0.0.1'); await once(reservation,'listening');
const port = reservation.address().port; await new Promise(resolve=>reservation.close(resolve));
const host = `127.0.0.1:${port}`;
let child, client, log = '', starts = 0;
const unsubscribers = [];
async function stop() {
  for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
  if (client) { await client.terminate(); client = undefined; }
  if (child && child.exitCode === null && child.signalCode === null) {
    const exit = once(child,'close'); requestNativeStop(child, 'SIGTERM'); await exit;
  }
}
async function start() {
  const env = nativeEnvironment();
  if (process.platform === 'win32' && ++starts === 2) {
    // Verify bare native bootstrap too, not only the npm launcher's defaults.
    delete env.MIMALLOC_PURGE_DELAY; delete env.MIMALLOC_PURGE_DECOMMITS;
  }
  child = spawn(binary,['firestore','--host','127.0.0.1','--port',String(port),'--project-id','demo-package-smoke','--data-dir',join(consumer,'state')],{cwd:consumer,env,stdio:['pipe','pipe','pipe']});
  child.stdin.on('error', error => {log+=error.message;});
  child.stdout.on('data',chunk=>{log+=chunk}); child.stderr.on('data',chunk=>{log+=chunk});
  for (let attempt=0; attempt<200; attempt++) {
    if (child.exitCode !== null) throw new Error(log);
    try { await fetch(`http://${host}/`,{signal:AbortSignal.timeout(200)}); return; }
    catch { await delay(50); }
  }
  throw new Error('Packaged engine did not become ready');
}
const timeout = setTimeout(()=>{console.error(`Smoke timed out; preserve ${consumer}`); if(child) requestNativeStop(child,'SIGTERM'); process.exitCode=1;},60000);
try {
  await start();
  client = new Firestore({projectId:'demo-package-smoke',host,ssl:false});
  const refs = [client.doc('smoke/one'),client.doc('smoke/two')];
  const observed = Promise.all(refs.map(ref=>new Promise((resolve,reject)=>{
    unsubscribers.push(ref.onSnapshot(snapshot=>{if(snapshot.data()?.text==='中文 😀 live') resolve()},reject));
  })));
  await client.batch().set(refs[0],{text:'中文 😀 live',empty:[]}).set(refs[1],{text:'中文 😀 live'}).commit();
  await observed;
  assert.equal((await client.collection('smoke').get()).size,2);
  await stop(); await start();
  client = new Firestore({projectId:'demo-package-smoke',host,ssl:false});
  assert.deepEqual((await client.doc('smoke/one').get()).data(),{text:'中文 😀 live',empty:[]});
  assert.match(log,/write-ahead journal enabled/);
  await stop();
  const result = {passed:true,manager,version:receipt.version,engineRevision:receipt.engineRevision,platform:receipt.platform,
    binary,consumer,checks:['packed install without scripts','binary identity','two listeners','UTF-16 content','disk/WAL write/read','native reopen'],completedAt:new Date().toISOString()};
  writeFileSync(join(directory,`${manager}-smoke.json`),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result,null,2));
} finally {clearTimeout(timeout); await stop(); writeFileSync(join(consumer,'engine.log'),log);}
