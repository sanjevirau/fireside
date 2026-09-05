#!/usr/bin/env bash
# Preparation only: no emulator or browser workload. Preserve all earlier attempts.
set -euo pipefail
export PATH=/home/sanjevi/.local/share/mise/installs/java/26.0.2.1/bin:/home/sanjevi/.local/share/mise/installs/node/24.20.0/bin:/home/sanjevi/.local/share/mise/installs/bun/1.3.14/bin:/home/sanjevi/.local/share/mise/dotnet-root:/home/sanjevi/.local/share/mise/installs/python/3.14.6/bin:/home/sanjevi/.rustup/toolchains/1.98.0-x86_64-unknown-linux-gnu/bin:/home/sanjevi/.local/share/mise/shims:/home/sanjevi/.local/bin:/usr/local/bin:/usr/bin:/bin
export TWODART_DISABLE_EXTERNALS=1 TWODART_SETUP_SKIP_WORKTREE_BOOTSTRAP=1
phase5_root=/srv/dev-fast/runtime-data/fireside-templates-hetzner-20260905
phase5_preparation="$phase5_root/preparation-r47"
phase5_fresh="$phase5_root/fresh-acceptance/r47/fresh-colleague"
test "$(id -un)" = sanjevi
test ! -e "$phase5_fresh"
mkdir "$phase5_preparation"
exec > >(tee "$phase5_preparation/setup.log") 2>&1
trap 'phase5_result=$?; printf "%s\n" "$phase5_result" > "$phase5_preparation/setup.exit"' EXIT
date --iso-8601=seconds
node "$phase5_root/deployment-473d883/hetzner-preflight.mjs" "$phase5_root/attempts/r47-preparation-preflight" 473d883fcb502612b89dcc304206bf1a83aa3f31
test "$(sha256sum /home/sanjevi/.cache/fireside-provisioning/twodart-6bda5bf.bundle | cut -d ' ' -f 1)" = 1ed8a6fb84259ec29f859675946a1003dc9aaba4792ba5b992c1cec2f7c4110b
cd "$phase5_root/setup-harness-b5fe1d5/conformance"
node --import tsx --input-type=module - <<'NODE'
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { applyPhase5PortlessApplicationPorts, PHASE5_APPLICATION_PORTS, PHASE5_MPROCS_APPLICATION_CONFIG } from './src/suite/phase5-host-prepare.ts';
const root='/srv/dev-fast/runtime-data/fireside-templates-hetzner-20260905';
const sum=x=>createHash('sha256').update(x).digest('hex');
const receipt=[];
for(const stack of ['official','fireside']) {
  const cwd=root+'/stack-'+stack;
  const git=args=>execFileSync('git',args,{cwd,encoding:'utf8'});
  if(git(['rev-parse','HEAD']).trim()!=='6bda5bf29b2399017d2a872e8f3fc1a15d073a54') throw Error('Wrong source revision');
  if(git(['status','--porcelain','--untracked-files=no'])!==' M '+PHASE5_MPROCS_APPLICATION_CONFIG+'\n') throw Error('Unexpected tracked change');
  const base=git(['show','HEAD:'+PHASE5_MPROCS_APPLICATION_CONFIG]);
  const current=await readFile(cwd+'/'+PHASE5_MPROCS_APPLICATION_CONFIG,'utf8');
  if(current!==applyPhase5PortlessApplicationPorts(base,PHASE5_APPLICATION_PORTS[stack])) throw Error('Not exactly owned harness port edits');
  const patch=git(['diff','--',PHASE5_MPROCS_APPLICATION_CONFIG]);
  await writeFile(root+'/preparation-r47/'+stack+'-r46-owned-ports.patch',patch,{flag:'wx'});
  execFileSync('git',['apply','--reverse','--check','-'],{cwd,input:patch});
  execFileSync('git',['apply','--reverse','-'],{cwd,input:patch});
  if(git(['status','--porcelain','--untracked-files=no'])!=='') throw Error('Restored checkout is not tracked clean');
  if(await readFile(cwd+'/'+PHASE5_MPROCS_APPLICATION_CONFIG,'utf8')!==base) throw Error('Restoration mismatch');
  receipt.push({stack,beforeSha256:sum(current),afterSha256:sum(base),patchSha256:sum(patch),onlyHarnessOwnedPortEditsReversed:true});
}
await writeFile(root+'/preparation-r47/owned-port-restoration.json',JSON.stringify({at:new Date().toISOString(),receipt},null,2)+'\n',{flag:'wx'});
NODE
mkdir -p "$phase5_root/fresh-acceptance/r47"
git clone --branch feature/san/fireside-emulator /home/sanjevi/.cache/fireside-provisioning/twodart-6bda5bf.bundle "$phase5_fresh"
test "$(git -C "$phase5_fresh" rev-parse HEAD)" = 6bda5bf29b2399017d2a872e8f3fc1a15d073a54
node --import tsx --input-type=module - <<'NODE'
import { writeFile, readFile, lstat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { renderSafeTwodartEnvironment, stageIsolatedRuntimeAssetTree, phase5PortEnvironment, PHASE5_STACK_PORTS, applyPhase5Ports } from './src/suite/phase5-host-prepare.ts';
const root='/srv/dev-fast/runtime-data/fireside-templates-hetzner-20260905';
const fresh=root+'/fresh-acceptance/r47/fresh-colleague';
await writeFile(fresh+'/.env.local',renderSafeTwodartEnvironment(),{flag:'wx',mode:0o600});
for(const name of ['globalFonts','masterSlidesBase','slides']) {
  await stageIsolatedRuntimeAssetTree(root+'/inputs/Assets/'+name,fresh+'/engines/twodartnet/TwodartNet/Assets/'+name);
}
try { await lstat(fresh+'/apps/templates-firebase/loadData/datasets/full-data'); throw Error('full-data must remain absent'); }
catch(error) { if(error.code!=='ENOENT') throw error; }
const ports=PHASE5_STACK_PORTS.fireside;
execFileSync('bun',['setup'],{cwd:fresh,stdio:'inherit',env:{...process.env,...phase5PortEnvironment(ports)},timeout:1800000});
const configPath=fresh+'/apps/templates-firebase/firebase.json';
await writeFile(configPath,applyPhase5Ports(await readFile(configPath,'utf8'),ports));
const portText=await readFile(fresh+'/.env.ports','utf8');
for(const [key,value] of Object.entries(phase5PortEnvironment(ports))) {
  if(!portText.includes(key+'="'+value+'"')) throw Error('Fresh port not frozen: '+key);
}
await writeFile(root+'/preparation-r47/fresh-ports.json',JSON.stringify(phase5PortEnvironment(ports),null,2)+'\n',{flag:'wx'});
NODE
cd "$phase5_fresh"
test -d .git
test -d node_modules
test -d apps/papi/.venv
test ! -e apps/templates-firebase/loadData/datasets/full-data
test -z "$(git status --porcelain --untracked-files=no)"
date --iso-8601=seconds
printf 'Independent fresh setup completed; no gate workload started.\n'
