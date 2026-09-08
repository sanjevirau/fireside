import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { observePopup } from '../src/suite/auth-popup-browser.mjs';
import { observePopupAccountSafety } from '../src/suite/auth-popup-account-safety.mjs';

const fixtureRoot = new URL('../fixtures/firebase-suite-v1/auth-popup/',import.meta.url);
const load = async () => JSON.parse(await readFile(new URL('fixture.json',fixtureRoot)));
const semantic = observation => {
  const {browserVersion: _browser, ...contract} = observation;
  return {...contract, validation:contract.validation.map(item=>({...item,body:JSON.parse(item.body)})),
    exchanges:contract.exchanges.map(item=>({...item,isNewUser:!!item.isNewUser}))};
};
test('official browser oracle covers imported picker, popup, cancel, new user and redirect', async () => {
  const raw = await readFile(new URL('fixture.json',fixtureRoot));
  assert.equal(await readFile(new URL('SHA256SUMS',fixtureRoot),'utf8'),createHash('sha256').update(raw).digest('hex')+'  fixture.json\n');
  const fixture = await load();
  assert.equal(fixture.version,'15.22.0');
  assert.equal(fixture.sdkVersion,'12.18.0');
  assert.equal(fixture.syntheticOnly,true);
  assert.equal(Object.keys(fixture.sourceHashes).length,3);
  assert.equal(fixture.observation.exchanges.length,3);
  assert.equal(fixture.observation.events.length,2);
  assert.equal(fixture.observation.stages.length,6);
  assert.deepEqual(fixture.observation.pageErrors,[]);
  const safety = await readFile(new URL('account-safety.json',fixtureRoot));
  assert.equal(await readFile(new URL('account-safety.sha256',fixtureRoot),'utf8'),createHash('sha256').update(safety).digest('hex')+'  account-safety.json\n');
  assert.deepEqual(JSON.parse(safety).observation,{signInStatus:200,existingUidReused:true,providers:['github.com','google.com'],disabledStatus:400,disabledError:'USER_DISABLED'});
});

test('Fireside completes real SDK popup and redirect against the official fixture', {timeout:600_000}, async () => {
  const repository = fileURLToPath(new URL('../../',import.meta.url));
  const execute = promisify(execFile);
  await execute('cargo',['build','--locked','-p','fireside-auth-front','--example','refresh_fixture_server'],{cwd:repository});
  const metadata = JSON.parse((await execute('cargo',['metadata','--no-deps','--format-version','1'],{cwd:repository})).stdout);
  const peer = spawn(`${metadata.target_directory}/debug/examples/refresh_fixture_server`,[],{stdio:['ignore','pipe','pipe']});
  const exited = once(peer,'exit');
  let log = '';
  peer.stderr.on('data',chunk=>{log+=chunk});
  try {
    const origin = await new Promise((resolve,reject)=>{
      const timer = setTimeout(()=>reject(new Error('Auth peer readiness timeout: '+log)),30_000);
      peer.stdout.once('data',chunk=>{clearTimeout(timer);resolve(chunk.toString().trim())});
      peer.once('error',reject);
      peer.once('exit',()=>{clearTimeout(timer);reject(new Error('Auth peer exited: '+log))});
    });
    const actual = await observePopup(origin);
    const expected = (await load()).observation;
    assert.deepEqual(semantic(actual),semantic(expected));
    assert.deepEqual(await observePopupAccountSafety(origin),JSON.parse(await readFile(new URL('account-safety.json',fixtureRoot))).observation);
  } finally {
    if(peer.exitCode===null && peer.signalCode===null) peer.kill('SIGTERM');
    await exited;
  }
});
