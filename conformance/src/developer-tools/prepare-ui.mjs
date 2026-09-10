// Download only the two pinned official compatibility assets used by this test.
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
const root=resolve(process.argv[2]);
assert.equal(JSON.parse(await readFile(join(root,'package.json'))).version,'15.22.0');
const require=createRequire(import.meta.url);
const {downloadEmulator}=require(join(root,'lib/emulator/download.js'));
const cache=join(homedir(),'.cache/firebase/emulators');
for(const [service,filename] of [['storage','cloud-storage-rules-runtime-v1.1.3.jar'],['ui','ui-v1.15.0.zip']]){
  if(!existsSync(join(cache,filename)))await downloadEmulator(service);
}
// verify-native-ui rechecks both archive bytes against the committed SHA-256s.
