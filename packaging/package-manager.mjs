import { existsSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { envValue, resolveExecutable } from '../packages/cli/src/processes.mjs';

export function packageManager(manager, args, options = {}) {
  if (manager !== 'npm') {
    let binary;
    try { binary = resolveExecutable(manager); }
    catch (error) {
      if (manager !== 'bun' || process.platform !== 'win32') throw error;
      binary = (envValue(process.env,'PATH') || '').split(delimiter)
        .map(dir => join(dir,'node_modules/bun/bin/bun.exe')).find(existsSync);
      if (!binary) throw error;
    }
    return execFileSync(binary, args, options);
  }
  // Invoke npm's JavaScript entry directly: never execute a Windows .cmd with
  // execFile, and never reinterpret arbitrary tarball paths as shell syntax.
  const dirs = (envValue(process.env,'PATH') || '').split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    const shim = join(dir, process.platform === 'win32' ? 'npm.cmd' : 'npm');
    if (!existsSync(shim)) continue;
    const candidates = [realpathSync(shim), join(dir,'node_modules/npm/bin/npm-cli.js'), join(dirname(dir),'lib/node_modules/npm/bin/npm-cli.js')];
    const cli = candidates.find(path => path.endsWith('npm-cli.js') && existsSync(path));
    if (cli) return execFileSync(process.execPath, [cli,...args], options);
  }
  throw new Error('Cannot locate npm-cli.js from PATH');
}
