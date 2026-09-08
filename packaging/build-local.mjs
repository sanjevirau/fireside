// Build this clean source revision, then produce matching private CLI/native
// tarballs. This never installs into a consumer or starts/stops its emulator.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platformKey } from '../packages/cli/src/binary.mjs';

const root = fileURLToPath(new URL('../',import.meta.url));
const outArgument = process.argv[2];
if (!outArgument || process.argv.length!==3) throw new Error('Usage: node packaging/build-local.mjs NEW_OUTPUT_DIRECTORY');
const out = resolve(outArgument);
if (existsSync(out)) throw new Error('Output already exists; preserve it and choose a new directory');
const git = args => execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
if (git(['status','--porcelain','--untracked-files=no'])) throw new Error('Commit tracked source changes before building a traceable local candidate');
const revision = git(['rev-parse','HEAD']);
const key = platformKey();
execFileSync('cargo',['build','--locked','--release','--bin','fireside'],{cwd:root,stdio:'inherit'});
if (git(['rev-parse','HEAD'])!==revision || git(['status','--porcelain','--untracked-files=no'])) {
  throw new Error('Source changed during build; refusing to attribute this binary to the starting commit');
}
const metadata = JSON.parse(execFileSync('cargo',['metadata','--no-deps','--format-version','1'],{cwd:root,encoding:'utf8'}));
const target = process.env.CARGO_BUILD_TARGET;
const binary = join(metadata.target_directory,...(target?[target]:[]),'release',process.platform==='win32'?'fireside.exe':'fireside');
execFileSync(process.execPath,[join(root,'packaging/build-packages.mjs'),binary,key,out,revision],{cwd:root,stdio:'inherit'});
