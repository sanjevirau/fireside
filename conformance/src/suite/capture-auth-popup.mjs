import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { observePopup, popupProject } from './auth-popup-browser.mjs';
import { observePopupAccountSafety } from './auth-popup-account-safety.mjs';

const root = resolve(process.env.FIREBASE_TOOLS_15_22_ROOT);
const require = createRequire(join(root, 'package.json'));
assert.equal(require(join(root, 'package.json')).version, '15.22.0');
const {createApp} = require(join(root, 'lib/emulator/auth/server.js'));
const server = createServer(await createApp(popupProject, 0));
server.listen(0, '127.0.0.1'); await once(server, 'listening');
try {
  const safety = process.argv.includes('--account-safety');
  const observation = await (safety ? observePopupAccountSafety : observePopup)(`http://127.0.0.1:${server.address().port}`);
  const sourceHashes = Object.fromEntries(await Promise.all(['handlers.js','widget_ui.js','operations.js'].map(async name=>[
    name, createHash('sha256').update(await readFile(join(root,'lib/emulator/auth',name))).digest('hex')])));
  const sdk = JSON.parse(await readFile(new URL('../../node_modules/firebase/package.json',import.meta.url)));
  const fixture = {schemaVersion:1,oracle:'firebase-tools Auth emulator',version:'15.22.0',sdkVersion:sdk.version,
    capturedAt:new Date().toISOString(),syntheticOnly:true,sourceHashes,observation};
  const directory = new URL('../../fixtures/firebase-suite-v1/auth-popup/',import.meta.url);
  await mkdir(directory,{recursive:true});
  const json = JSON.stringify(fixture,null,2)+'\n';
  const filename = safety ? 'account-safety.json' : 'fixture.json';
  await writeFile(new URL(filename,directory),json,{flag:'wx'});
  await writeFile(new URL(safety ? 'account-safety.sha256' : 'SHA256SUMS',directory),createHash('sha256').update(json).digest('hex')+'  '+filename+'\n',{flag:'wx'});
  console.log(JSON.stringify(fixture,null,2));
} finally {
  server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));
}
