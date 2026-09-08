// Inspect the bytes that will be published, without extracting or executing them.
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';

const cliFiles = ['LICENSE-APACHE', 'LICENSE-MIT', 'README.md', 'package.json', 'release.json',
  'bin/fireside.mjs', 'src/assets.mjs', 'src/binary.mjs', 'src/options.mjs', 'src/processes.mjs', 'src/runtime.mjs'];
const licenses = ['LICENSE-APACHE', 'LICENSE-MIT'];

function octal(bytes) {
  const value = bytes.toString('ascii').replace(/\0.*$/s, '').trim();
  assert.match(value, /^[0-7]+$/, 'Invalid tar numeric field');
  const number = Number.parseInt(value, 8);
  assert.ok(Number.isSafeInteger(number), 'Oversized tar numeric field');
  return number;
}

export function packageEntries(compressed) {
  const tar = gunzipSync(compressed, {maxOutputLength: 256 * 1024 * 1024});
  const entries = new Map();
  let offset = 0;
  while (offset + 512 <= tar.length && tar.subarray(offset, offset + 512).some(byte => byte !== 0)) {
    const header = tar.subarray(offset, offset + 512);
    const checksum = [...header].reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    assert.equal(octal(header.subarray(148, 156)), checksum, 'Tar header checksum mismatch');
    // npm's reviewed package paths fit ordinary ustar. Links, PAX/GNU path
    // overrides and other entry types are not needed and fail closed.
    assert.ok(header[156] === 0 || header[156] === 48, 'Only regular package files are allowed');
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
    assert.equal(prefix, '', 'Unexpected tar path prefix');
    assert.ok(name.startsWith('package/') && !name.includes('\\'), 'Invalid package path');
    const path = name.slice(8);
    assert.ok(path && path.split('/').every(part => part && part !== '.' && part !== '..'), 'Unsafe package path');
    assert.ok(!entries.has(path), 'Duplicate package entry');
    const size = octal(header.subarray(124, 136));
    offset += 512;
    assert.ok(offset + size <= tar.length, 'Truncated package entry');
    entries.set(path, tar.subarray(offset, offset + size));
    offset += Math.ceil(size / 512) * 512;
  }
  assert.ok(tar.length - offset >= 1024 && tar.subarray(offset).every(byte => byte === 0), 'Invalid tar trailer');
  return entries;
}

export function assertPublicText(bytes, label, policy = {forbiddenTerms: []}) {
  // Labels identify the file, never print a matched confidential value.
  for (const [encoding, offset] of [['utf8', 0], ['utf16le', 0], ['utf16le', 1]]) {
    const text = bytes.subarray(offset).toString(encoding);
    assert.ok(!/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/.test(text), `${label}: private key`);
    assert.ok(!/(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|npm_[A-Za-z0-9]{30,}|AKIA[A-Z0-9]{16})/.test(text), `${label}: credential pattern`);
    const folded = text.toLowerCase();
    for (const term of policy.forbiddenTerms) {
      assert.ok(typeof term === 'string' && term.length >= 4, 'Invalid publication policy');
      assert.ok(!folded.includes(term.toLowerCase()), `${label}: confidential context (value withheld)`);
    }
  }
}

export function auditPublicPackage(bytes, expected, policy) {
  const entries = packageEntries(bytes);
  const cli = expected.name === '@fireside-dev/cli';
  assert.ok(cli || /^@fireside-dev\/(darwin|linux|win32)-(arm64|x64)$/.test(expected.name), 'Unexpected package name');
  const executable = expected.name.includes('/win32-') ? 'bin/fireside.exe' : 'bin/fireside';
  const allowed = cli ? cliFiles : [...licenses, 'package.json', 'receipt.json', executable];
  assert.ok(entries.size === allowed.length && allowed.every(path => entries.has(path)), 'Package file allowlist mismatch');
  for (const [path, content] of entries) assertPublicText(content, path, policy);
  const metadata = JSON.parse(entries.get('package.json'));
  assert.equal(metadata.name, expected.name);
  assert.equal(metadata.version, expected.version);
  assert.equal(metadata.scripts, undefined, 'Published packages must not have lifecycle scripts');
  assert.ok(metadata.private === undefined || expected.localDevelopment === true, 'Private candidates cannot be published');
  const identity = JSON.parse(entries.get(cli ? 'release.json' : 'receipt.json'));
  assert.equal(identity.engineRevision, expected.engineRevision, 'Package engine identity mismatch');
  if (cli) {
    assert.equal(identity.acceptanceReport, undefined, 'Private report links do not belong in public metadata');
    assert.equal(identity.acceptedBaselineRevision, undefined, 'Private acceptance belongs in a separate receipt');
  }
  return {passed: true, package: metadata.name, version: metadata.version, files: entries.size};
}
