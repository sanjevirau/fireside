#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { binaryPath, manifest, release } from '../src/binary.mjs';
import { setupAssets } from '../src/assets.mjs';
import { parseOptions } from '../src/options.mjs';
import { diagnose, prepareLaunch, supervise } from '../src/runtime.mjs';
import { nativeEnvironment, requestNativeStop } from '../src/processes.mjs';

const help = `Fireside ${manifest.version} — Firebase-compatible local emulator preview

  fireside setup                    Download verified Storage-rules/UI assets
  fireside doctor [options]         Read-only package/runtime/config checks
  fireside emulators:start [options]
  fireside emulators:exec [options] -- command [args...]
  fireside binary-path              Verified packaged native binary location
  fireside native <args...>          Explicit advanced native CLI (no adapter)

Options: --project demo-ID, --config firebase.json, --import DIR,
  --export-on-exit[=DIR], --only firestore,auth,storage,functions,pubsub,
  --state-dir DIR, --resume-state, --storage-bucket target=bucket (repeatable),
  --java PATH, --host 127.0.0.1, --minimum-functions N,
  --firestore-websocket-port N, --logging-port N, --eventarc-port N, --tasks-port N.

Uses existing Firebase SDKs/config; disk/WAL by default. Complete suite profile
only in this preview. Unsupported services/subsets fail before launch. Requires
Node 24 and Java for Storage rules. No deployment command or cloud login.
Test commands are argv after -- (use sh -c explicitly if shell syntax is needed).
`;

async function main() {
  const [action, ...args] = process.argv.slice(2);
  if (!action || ['--help','-h','help'].includes(action)) { console.log(help); return 0; }
  if (['--version','-v'].includes(action)) { console.log(`${manifest.version} (engine source ${release.engineRevision})`); return 0; }
  if (action === 'binary-path') { if (args.length) throw new Error('binary-path takes no arguments'); console.log(binaryPath()); return 0; }
  if (action === 'setup') { if (args.length) throw new Error('setup takes no arguments'); binaryPath(); await setupAssets(); return 0; }
  if (action === 'native') {
    if (!args.length) throw new Error('native requires a native command');
    const child = spawn(binaryPath(), args, {env:nativeEnvironment(),detached:process.platform === 'win32',windowsHide:true,stdio:[process.platform === 'win32' ? 'pipe' : 'inherit','inherit','inherit']});
    child.stdin?.on('error', error => console.error(`Native control: ${error.message}`));
    const onInt = () => requestNativeStop(child, 'SIGINT');
    const onTerm = () => requestNativeStop(child, 'SIGTERM');
    process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
    try { return await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve(code ?? 1)); }); }
    finally { process.off('SIGINT', onInt); process.off('SIGTERM', onTerm); }
  }
  if (!['doctor','emulators:start','emulators:exec'].includes(action)) throw new Error(`Unsupported command ${action}; use --help. Firebase deploy/login commands are never intercepted.`);
  const {options, command} = parseOptions(args);
  if (options.help) { console.log(help); return 0; }
  if (action === 'emulators:exec' ? !command?.length : command !== undefined) throw new Error('Only emulators:exec accepts (and requires) a command after --');
  const diagnostic = await diagnose(options);
  if (action === 'doctor') { console.log(JSON.stringify(diagnostic, null, 2)); return 0; }
  return supervise(prepareLaunch(diagnostic, options), command);
}
try { process.exitCode = await main(); }
catch (error) { console.error(`Fireside: ${error.message}`); process.exitCode = 1; }
