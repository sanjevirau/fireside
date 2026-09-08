// Tiny local official oracle. All identities/passwords below are synthetic.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
const [toolsRoot, output] = process.argv.slice(2);
const require = createRequire(join(resolve(toolsRoot),'package.json'));
assert.equal(JSON.parse(readFileSync(join(toolsRoot,'package.json'))).version,'15.22.0');
const {createApp} = require(join(resolve(toolsRoot),'lib/emulator/auth/server.js'));
const project = 'demo-package-auth-oracle';
const password = 'synthetic-package-test-123';
const email = 'package@example.test';
async function server() {
  const http = createServer(await createApp(project,0));
  http.listen(0,'127.0.0.1'); await once(http,'listening');
  return {http,url:`http://127.0.0.1:${http.address().port}`};
}
async function call(target,path,body,method='POST') {
  const response = await fetch(target.url+path,{method,headers:{'content-type':'application/json',authorization:'Bearer owner'},
    body:body === undefined ? undefined : JSON.stringify(body),signal:AbortSignal.timeout(5000)});
  return {status:response.status,body:await response.json()};
}
function stop(target) {target.http.closeAllConnections(); return new Promise(resolve=>target.http.close(resolve));}
const source = await server();
let exported;
try {
  assert.equal((await call(source,'/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo',{email,password,returnSecureToken:true})).status,200);
  const result = await call(source,`/identitytoolkit.googleapis.com/v1/projects/${project}/accounts:batchGet`,undefined,'GET');
  assert.equal(result.status,200); exported = result.body;
} finally {await stop(source);}
const destination = await server();
try {
  const imported = await call(destination,`/identitytoolkit.googleapis.com/v1/projects/${project}/accounts:batchCreate`,exported);
  assert.equal(imported.status,200);
  const correct = await call(destination,'/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo',{email,password,returnSecureToken:true});
  const wrong = await call(destination,'/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo',{email,password:'wrong',returnSecureToken:true});
  assert.equal(correct.status,200); assert.equal(wrong.status,400);
  const user = exported.users[0];
  const fixture = {schemaVersion:1,oracle:'firebase-tools Auth emulator',version:'15.22.0',syntheticOnly:true,
    password,email,user:{salt:user.salt,passwordHash:user.passwordHash,email:user.email},
    userIdSha256:createHash('sha256').update(user.localId).digest('hex'),
    expected:{importStatus:imported.status,correctPasswordStatus:correct.status,wrongPasswordStatus:wrong.status},
    sourceContract:'lib/emulator/auth/operations.js hashPassword and signInWithPassword',
    capturedAt:new Date().toISOString()};
  writeFileSync(output,JSON.stringify(fixture,null,2)+'\n',{flag:'wx'});
  console.log(`Official Auth export/import/login oracle saved: ${output}`);
} finally {await stop(destination);}
