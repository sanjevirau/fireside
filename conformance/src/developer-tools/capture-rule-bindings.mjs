// Tiny compiler-only oracle: no documents, user code or production requests.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

assert.equal(process.version,'v24.20.0');assert.equal(process.argv.length,3);
const output=resolve(process.argv[2]);await mkdir(output,{mode:0o700});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const jar=join(homedir(),'.cache/firebase/emulators/cloud-firestore-emulator-v1.22.0.jar');
const jarSha256=hash(await readFile(jar));assert.equal(jarSha256,'9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c');
const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
const project='demo-fireside-rule-bindings';
const child=spawn('java',['-jar',jar,'--host','127.0.0.1','--port',String(port),'--project_id',project],{cwd:output,stdio:['ignore','pipe','pipe']});
const exited=once(child,'exit');let log='';for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>log+=bytes);
const record={schemaVersion:1,syntheticOnly:true,project,capturedAt:new Date().toISOString(),captureSha256:hash(await readFile(new URL(import.meta.url))),
  oracle:{firestore:'1.22.0',jarSha256,node:process.version,java:spawnSync('java',['-version'],{encoding:'utf8'}).stderr.trim()},profiles:[],passed:false};
const source=body=>`rules_version = '2';\nservice cloud.firestore {\n match /databases/{database}/documents {\n${body}\n }\n}\n`;
try{
  const deadline=Date.now()+60000;
  while(true){assert.equal(child.exitCode,null);try{const response=await fetch(`http://127.0.0.1:${port}/`,{signal:AbortSignal.timeout(250)});await response.arrayBuffer();if(response.status<500)break;}catch{}assert(Date.now()<deadline);await delay(25);}
  for(const name of ['duration','hashing','latlng','math','timestamp','request','resource','value']){
    const cases={
      parameter:` function accept(${name}) { return ${name}; }\n match /items/{item} { allow get: if accept(true); }`,
      binding:` function accept() { let ${name} = true; return ${name}; }\n match /items/{item} { allow get: if accept(); }`,
      function:` function ${name}() { return true; }\n match /items/{item} { allow get: if ${name}(); }`,
      wildcard:` match /items/{${name}} { allow get: if ${name} == 'one'; }`,
      field:` match /items/{item} { allow get: if {'${name}': true}.${name}; }`,
    };
    for(const [kind,body] of Object.entries(cases)){
      const rules=source(body);
      const response=await fetch(`http://127.0.0.1:${port}/emulator/v1/projects/${project}:securityRules`,{
        method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({rules:{files:[{name:'firestore.rules',content:rules}]}}),signal:AbortSignal.timeout(10000)});
      record.profiles.push({name,kind,source:rules,status:response.status,response:await response.json()});
    }
  }
  record.passed=true;
}catch(error){record.failure={message:error.message};throw error;}
finally{
  if(child.exitCode===null&&child.signalCode===null)child.kill('SIGINT');
  record.exit=await Promise.race([exited,delay(20000,null,{ref:false})]);
  await writeFile(join(output,'oracle.log'),log);await writeFile(join(output,'fixture.json'),JSON.stringify(record,null,2)+'\n');assert(record.exit);
}
console.log(JSON.stringify(record.profiles.map(({name,kind,status})=>({name,kind,status}))));
