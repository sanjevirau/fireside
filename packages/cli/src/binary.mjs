import { createHash } from 'node:crypto';
import { accessSync, constants, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
export const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
export const release = JSON.parse(readFileSync(new URL('../release.json', import.meta.url)));
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function platformKey(platform = process.platform, arch = process.arch, report = process.report.getReport()) {
  const key = `${platform}-${arch}`;
  if (!Object.hasOwn(release.platforms, key) || (platform === 'linux' && !report.header?.glibcVersionRuntime)) {
    throw new Error(`Unsupported platform ${key}. Supported: ${Object.keys(release.platforms).join(', ')} (Linux requires glibc). No automatic build/download fallback.`);
  }
  return key;
}

export function verifyBinary(directory, key) {
  const pkg = JSON.parse(readFileSync(join(directory, 'package.json')));
  const receipt = JSON.parse(readFileSync(join(directory, 'receipt.json')));
  const binary = join(directory, 'bin', key.startsWith('win32-') ? 'fireside.exe' : 'fireside');
  if (pkg.name !== `@fireside-dev/${key}` || pkg.version !== manifest.version ||
      receipt.engineRevision !== release.engineRevision || receipt.platform !== key ||
      receipt.version !== manifest.version || receipt.target !== release.platforms[key]) {
    throw new Error('Fireside platform package identity mismatch; reinstall the pinned CLI and its optional dependencies.');
  }
  accessSync(binary, constants.X_OK);
  if (sha256(readFileSync(binary)) !== receipt.sha256) throw new Error('Fireside binary checksum mismatch; refusing execution.');
  return binary;
}

export function binaryPath() {
  const key = platformKey();
  let file;
  try { file = require.resolve(`@fireside-dev/${key}/package.json`); }
  catch { throw new Error(`Missing @fireside-dev/${key}@${manifest.version}. Install with optional dependencies enabled. No postinstall script is needed.`); }
  return verifyBinary(dirname(file), key);
}
