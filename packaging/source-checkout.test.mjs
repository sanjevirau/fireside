import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));

test('package source and licenses retain LF bytes on Windows checkouts', () => {
  // npm preserves file bytes. Without repository attributes, Windows Git's
  // autocrlf conversion makes the common CLI differ from Unix builds even
  // though every platform can install it successfully.
  const paths = execFileSync('git', ['ls-files', '-z', '--', 'packages', 'packaging',
    'LICENSE-MIT', 'LICENSE-APACHE'], {cwd: root, encoding: 'utf8'})
    .split('\0').filter(Boolean);
  assert.ok(paths.includes('packages/cli/package.json'));
  assert.ok(paths.includes('LICENSE-APACHE'));
  const fields = execFileSync('git', ['check-attr', '-z', 'eol', '--', ...paths],
    {cwd: root, encoding: 'utf8'}).split('\0');
  fields.pop();
  assert.equal(fields.length, paths.length * 3);
  for (let index = 0; index < fields.length; index += 3) {
    assert.equal(fields[index + 1], 'eol');
    assert.equal(fields[index + 2], 'lf', `${fields[index]} must retain LF bytes`);
  }
});
