import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { assetPaths } from './assets.mjs';
import { binaryPath, manifest, release } from './binary.mjs';
import { loadProject } from './options.mjs';
import { nativeEnvironment, requestNativeStop, resolveExecutable } from './processes.mjs';

const require = createRequire(import.meta.url);
export async function diagnose(options, cwd = process.cwd()) {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error(`Node 24 is required for the tested Functions host; received ${process.versions.node}`);
  const binary = binaryPath();
  const project = loadProject(options, cwd);
  const toolsRoot = dirname(require.resolve('firebase-tools/package.json'));
  if (JSON.parse(readFileSync(join(toolsRoot, 'package.json'))).version !== '15.22.0') throw new Error('Expected firebase-tools 15.22.0');
  const java = resolveExecutable(options.java || 'java');
  const javaResult = spawnSync(java, ['-version'], {encoding:'utf8', timeout:10000});
  if (javaResult.status !== 0) throw new Error('Java runtime missing; install Java 26 for the tested Storage-rules compatibility runtime. Fireside does not install system runtimes.');
  // Rust canonicalizes runtime executable paths, so resolve PATH explicitly.
  const javaPath = java;
  const files = await assetPaths().catch(error => { throw new Error(`${error.message}. Run fireside setup to provision pinned public compatibility assets.`); });
  return {binary, toolsRoot, java:javaPath, files, project, version:manifest.version, engineRevision:release.engineRevision};
}

export function prepareLaunch(diagnostic, options) {
  const p = diagnostic.project;
  const parent = join(p.directory, '.fireside', 'runs');
  mkdirSync(parent, {recursive:true});
  const run = mkdtempSync(join(parent, 'session-'));
  const state = p.state || join(run, 'state');
  const rc = existsSync(p.rc) ? p.rc : join(run, '.firebaserc');
  if (!existsSync(rc)) writeFileSync(rc, '{}\n', {flag:'wx', mode:0o600});
  const credentials = join(run, 'demo-adc.json');
  writeFileSync(credentials, JSON.stringify({type:'authorized_user', client_id:'demo', client_secret:'demo', refresh_token:'demo'}), {flag:'wx', mode:0o600});
  const args = ['suite', '--project-dir', p.directory, '--config', p.config, '--firebase-rc', rc,
    '--project-id', p.project, '--host', p.host, '--firebase-tools-root', diagnostic.toolsRoot,
    '--node', process.execPath, '--java', diagnostic.java, '--storage-rules-jar', diagnostic.files.storageRules,
    '--ui-archive', diagnostic.files.ui, '--state-dir', state, '--minimum-functions', options['minimum-functions'] || '0'];
  for (const [name, port] of Object.entries(p.ports)) args.push(`--${name}-port`, String(port));
  for (const bucket of options['storage-bucket']) args.push('--storage-bucket', bucket);
  if (p.imported) args.push('--import', p.imported);
  if (p.exported) args.push('--export-on-exit', p.exported);
  if (options['resume-state']) args.push('--resume-state');
  const env = {...process.env, GOOGLE_CLOUD_PROJECT:p.project, GCLOUD_PROJECT:p.project,
    GOOGLE_APPLICATION_CREDENTIALS:credentials, CLOUDSDK_CONFIG:join(run, 'gcloud'),
    FIRESTORE_EMULATOR_HOST:`${p.host}:${p.ports.firestore}`, FIREBASE_AUTH_EMULATOR_HOST:`${p.host}:${p.ports.auth}`,
    FIREBASE_STORAGE_EMULATOR_HOST:`${p.host}:${p.ports.storage}`, STORAGE_EMULATOR_HOST:`http://${p.host}:${p.ports.storage}`,
    FIREBASE_EMULATOR_HUB:`${p.host}:${p.ports.hub}`, PUBSUB_EMULATOR_HOST:`${p.host}:${p.ports.pubsub}`};
  delete env.FIREBASE_TOKEN;
  delete env.CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE;
  writeFileSync(join(run, 'launch.json'), JSON.stringify({version:manifest.version, engineRevision:release.engineRevision, args, state, exported:p.exported}, null, 2));
  console.error(`Fireside ${manifest.version}; engine ${release.engineRevision}; disk/WAL state ${state}`);
  console.error('Local demo project only. User Functions can still contact external providers; this CLI is not a network sandbox.');
  console.error(`Working data and launch receipt are preserved in ${run}. No automatic deletion.`);
  return {binary:diagnostic.binary, args, env:nativeEnvironment(env), cwd:p.directory};
}

// Signal only children owned by this invocation. Wait through native export;
// never kill by port/name or return success before shutdown completes.
export async function supervise(launch, command) {
  const child = spawn(launch.binary, launch.args, {cwd:launch.cwd, env:launch.env,
    detached:process.platform === 'win32', windowsHide:true,
    stdio:[process.platform === 'win32' ? 'pipe' : 'inherit','pipe','pipe']});
  child.stdin?.on('error', error => { startupError = error; });
  let testChild;
  let ready = false;
  let requestedStop = false;
  let commandStatus;
  let tail = '';
  let startupError;
  const stop = signal => {
    requestedStop = true;
    if (testChild && testChild.exitCode === null) testChild.kill(signal);
    if (child.exitCode === null) requestNativeStop(child, signal);
  };
  const onInt = () => stop('SIGINT');
  const onTerm = () => stop('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  const timeout = setTimeout(() => {
    startupError = new Error('Emulator readiness exceeded 20 minutes; requesting graceful shutdown and preserving state.');
    stop('SIGTERM');
  }, 20 * 60 * 1000);
  function output(chunk, destination) {
    destination.write(chunk);
    tail = (tail + chunk.toString()).slice(-4096);
    if (!ready && /(?:^|\n)All emulators ready\r?\n/.test(tail)) {
      ready = true;
      clearTimeout(timeout);
      if (command?.length && !requestedStop) {
        testChild = spawn(command[0], command.slice(1), {cwd:process.cwd(), env:launch.env, stdio:'inherit'});
        testChild.on('error', error => { startupError = error; commandStatus = 1; stop('SIGTERM'); });
        testChild.on('exit', (code, signal) => {
          commandStatus = code ?? (signal === 'SIGINT' ? 130 : 1);
          // A normal test completion initiates export-first native shutdown.
          requestedStop = true;
          requestNativeStop(child);
        });
      }
    }
  }
  child.stdout.on('data', chunk => output(chunk, process.stdout));
  child.stderr.on('data', chunk => output(chunk, process.stderr));
  try {
    const outcome = await new Promise((resolveExit, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolveExit({code, signal}));
    });
    if (testChild && testChild.exitCode === null) {
      testChild.kill('SIGTERM');
      await new Promise(resolveExit => testChild.once('close', resolveExit));
    }
    if (startupError) throw startupError;
    if (outcome.code !== 0) return outcome.code ?? (outcome.signal === 'SIGINT' ? 130 : 1);
    if (!requestedStop) throw new Error('Emulator exited unexpectedly before requested shutdown');
    return commandStatus ?? 0;
  } finally {
    clearTimeout(timeout);
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
  }
}
