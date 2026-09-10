// Independent, tiny official-emulator observations. No consumer checkout required.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir, platform, arch, release } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { observeDeveloperUi } from './observe-ui.mjs';
import { writeFixture } from './normalize-capture.mjs';

export const project = 'demo-fireside-developer-tools';
export const rules = `rules_version = '2';
service cloud.firestore {
 match /databases/{database}/documents {
  match /notes/{note} {
   allow read: if resource.data.visible == true;
   allow write: if request.resource.data.visible == true;
  }
 }
}
`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const tools = resolve(process.env.FIREBASE_TOOLS_15_22_ROOT ?? 'missing-oracle-install');
assert.equal(JSON.parse(await readFile(join(tools, 'package.json'))).version, '15.22.0');
assert.equal(process.versions.node, '24.20.0');
const output = resolve(process.argv[2] ?? 'missing-output');
assert.ok(process.argv[2], 'provide a fresh output directory; no existing fixture is overwritten');
await mkdir(output, { recursive: false });
const work = await mkdtemp(join(tmpdir(), 'fireside-devtools-oracle-'));
const ports = {};
for (const name of ['firestore', 'auth', 'storage', 'hub', 'logging', 'ui', 'websocket']) {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  ports[name] = server.address().port; await new Promise(r => server.close(r));
}
const cache = join(homedir(), '.cache/firebase/emulators');
const assets = {};
for (const name of ['cloud-firestore-emulator-v1.22.0.jar', 'cloud-storage-rules-runtime-v1.1.3.jar', 'ui-v1.15.0.zip']) {
  assets[name] = hash(await readFile(join(cache, name)));
}
assert.equal(assets['ui-v1.15.0.zip'], '97d8c4c574e3f20c4d690a2ce8373eef76ab024da73279a062dba8517f88cf9a');
assert.equal(assets['cloud-firestore-emulator-v1.22.0.jar'],'9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c');
assert.equal(assets['cloud-storage-rules-runtime-v1.1.3.jar'],'0cd52db6f6271d62078f805220706377c849220b73bd68aa27078d977df9c900');
const sources = {};
for (const name of ['package.json', 'lib/emulator/controller.js', 'lib/emulator/firestoreEmulator.js', 'lib/emulator/ui.js']) {
  sources[name] = hash(await readFile(join(tools, name)));
}
await writeFile(join(work, 'firestore.rules'), rules);
await writeFile(join(work, 'storage.rules'), "rules_version = '2'; service firebase.storage { match /b/{bucket}/o { match /{object=**} { allow read, write: if true; } } }\n");
const emulators = Object.fromEntries(Object.entries(ports).filter(([name]) => name !== 'websocket').map(([name, port]) => [name, {host:'127.0.0.1', port}]));
emulators.firestore.websocketPort = ports.websocket;
emulators.ui.enabled = true;
await writeFile(join(work, 'firebase.json'), JSON.stringify({firestore:{rules:'firestore.rules'}, storage:{rules:'storage.rules'}, emulators}));
const origin = name => `http://127.0.0.1:${ports[name]}`;
const cliArgs = ['emulators:start', '--only', 'firestore,auth,storage', '--project', project, '--config', join(work, 'firebase.json'), '--non-interactive'];
const started = performance.now();
const child = spawn(process.execPath, [join(tools, 'lib/bin/firebase.js'), ...cliArgs], {
  cwd:work, env:{PATH:process.env.PATH, HOME:homedir(), TMPDIR:work, CI:'1', FIREBASE_CLI_DISABLE_UPDATE_CHECK:'true',
    FIRESTORE_EMULATOR_VERSION:'1.22.0', FIRESTORE_EMULATOR_BINARY_PATH:join(cache,'cloud-firestore-emulator-v1.22.0.jar')},
  stdio:['ignore','pipe','pipe'],
});
const logs = [];
for (const pipe of [child.stdout, child.stderr]) pipe.on('data', chunk => logs.push(String(chunk)));
const exited = once(child, 'exit');
const samples = [];
const sample = () => {
  if (platform() === 'win32') return;
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,comm='], {encoding:'utf8'}).trim().split('\n').map(line => {
    const [, pid, ppid, rss, command] = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/) ?? [];
    return {pid:Number(pid), ppid:Number(ppid), rssBytes:Number(rss)*1024, command};
  });
  const owned = new Set([child.pid]);
  for (let i=0;i<8;i++) for (const row of rows) if (owned.has(row.ppid)) owned.add(row.pid);
  samples.push({elapsedMs:Math.round(performance.now()-started), processes:rows.filter(row=>owned.has(row.pid))});
};
const sampler = setInterval(sample, 1000);
const connections = [];
const record = {schemaVersion:1, capturedAt:new Date().toISOString(), project, syntheticOnly:true,
  oracle:{firebaseTools:'15.22.0', firestore:'1.22.0', ui:'1.15.0', storageRules:'1.1.3', node:process.versions.node,
    java:null, assets, sources},
  rules, observations:[], websocket:{}, browser:null};
// java writes its version to stderr, so record it without inheriting terminal output.
record.oracle.java = await new Promise(resolveVersion => {
  const p=spawn('java',['-version']); let text=''; p.stderr.on('data',b=>text+=b); p.on('exit',()=>resolveVersion(text.trim()));
});
async function http(id, path, options={}) {
  const before=performance.now();
  const response=await fetch(`${origin('firestore')}${path}`, {...options, signal:AbortSignal.timeout(10000)});
  const text=await response.text(); let body;
  try {body=JSON.parse(text);} catch {body=text;}
  record.observations.push({id, method:options.method??'GET', path, requestBody:options.body?JSON.parse(options.body):null,
    admin:options.headers?.authorization==='Bearer owner', status:response.status,
    headers:Object.fromEntries(response.headers), body, elapsedMs:performance.now()-before});
  return {response,body};
}
async function connect() {
  const ws=new WebSocket(`ws://127.0.0.1:${ports.websocket}/requests`); connections.push(ws);
  const messages=[]; ws.addEventListener('message',event=>messages.push(JSON.parse(event.data)));
  await Promise.race([once(ws,'open'),delay(5000,undefined,{ref:false}).then(()=>{throw new Error('Requests websocket open deadline');})]);
  const deadline=Date.now()+5000;
  while (!messages.length && Date.now()<deadline) await delay(20);
  assert.ok(Array.isArray(messages[0]), 'first frame must be an observed history array');
  return {ws,messages};
}
let failure;
try {
  const deadline=Date.now()+60000;
  while (!logs.join('').includes('All emulators ready')) {
    assert.equal(child.exitCode,null,'oracle exited before readiness');
    assert.ok(Date.now()<deadline,'oracle readiness deadline'); await delay(50);
  }
  record.readyMs=performance.now()-started;
  const config=await (await fetch(`${origin('ui')}/api/config`)).json();
  assert.equal(config.firestore.webSocketPort,ports.websocket);
  record.config=config;
  const launchedCommand=execFileSync('ps',['-o','command=','-p',String(config.firestore.pid)],{encoding:'utf8'});
  assert.ok(launchedCommand.includes(join(cache,'cloud-firestore-emulator-v1.22.0.jar')),'actual launched Firestore jar must match the pinned oracle');
  record.oracle.launchedJarVerified=true;
  await http('coverage-before',`/emulator/v1/projects/${project}:ruleCoverage`);
  const first=await connect(); assert.deepEqual(first.messages,[[]]);
  const documents=`/v1/projects/${project}/databases/(default)/documents/notes/`;
  for (const [id,visible,admin] of [['visible',true,false],['denied',false,false],['hidden',false,true]]) {
    const body=JSON.stringify({fields:{visible:{booleanValue:visible},title:{stringValue:'Synthetic 中文 🚀'}}});
    const headers={'content-type':'application/json',...(admin?{authorization:'Bearer owner'}:{})};
    const result=await http(`write-${id}`,documents+id,{method:'PATCH',headers,body});
    assert.equal(result.response.status,id==='denied'?403:200);
  }
  for (const [id,admin,status] of [['visible',false,200],['hidden',false,403],['missing',false,403],['hidden',true,200]]) {
    const result=await http(`read-${id}${admin?'-admin':''}`,documents+id,{headers:admin?{authorization:'Bearer owner'}:{}});
    assert.equal(result.response.status,status);
  }
  const listed=await http('list-documents-admin',documents.slice(0,-1)+'?pageSize=1000',{headers:{authorization:'Bearer owner'}});
  assert.equal(listed.response.status,200);assert.equal(listed.body.documents.length,2);
  await delay(300); first.ws.close(); await once(first.ws,'close');
  record.websocket.firstConnection=first.messages;
  const second=await connect(); record.websocket.reconnected=second.messages;
  const live=first.messages.slice(1), replay=second.messages[0];
  assert.deepEqual(replay.map(m=>m.requestId),live.map(m=>m.requestId),'reconnect preserves evaluation IDs and order');
  // Observed 1.22.0 quirk: shared granular outcomes accumulate after a live event
  // has been sent. History can therefore contain more outcomes for the same ID.
  for (let i=0;i<live.length;i++) {
    const {granularAllowOutcomes:sent,...sentRest}=live[i];
    const {granularAllowOutcomes:retained,...retainedRest}=replay[i];
    assert.deepEqual(sentRest,retainedRest);
    assert.deepEqual(retained.slice(0,sent.length),sent);
  }
  second.ws.close(); await once(second.ws,'close');
  await http('coverage-after',`/emulator/v1/projects/${project}:ruleCoverage`);
  await http('coverage-html',`/emulator/v1/projects/${project}:ruleCoverage.html`);
  record.browser=await observeDeveloperUi({origin,project,work,output,requestId:first.messages.find(m=>m.outcome==='deny').requestId});
  sample();
} catch(error) { failure=error; }
finally {
  for (const ws of connections) ws.close();
  clearInterval(sampler);
  const stopping=performance.now();
  if (child.exitCode===null) child.kill('SIGINT');
  // Only our child is signalled; a failed clean shutdown is retained, never a kill-all.
  await Promise.race([exited,delay(20000,undefined,{ref:false}).then(()=>{throw new Error(`owned oracle shutdown timed out; PID ${child.pid}`);})]);
  record.shutdownMs=performance.now()-stopping;
  await writeFile(join(output,'raw.json'),JSON.stringify(record,null,2)+'\n');
  await writeFile(join(output,'oracle.log'),logs.join(''));
  await writeFile(join(output,'memory.json'),JSON.stringify({platform:platform(),arch:arch(),osRelease:release(),
    scope:'owned official CLI and descendants only; browser, harness and other host processes excluded',
    measurement:'RSS snapshots, not PSS; shared pages may be counted more than once',
    hostQuiescent:false, samples},null,2)+'\n');
}
if (failure) throw failure;
await writeFixture(record,work,ports,output);
console.log(JSON.stringify({passed:true,output,observations:record.observations.length,requestFrames:record.websocket.firstConnection.length,browser:record.browser.checks}));
