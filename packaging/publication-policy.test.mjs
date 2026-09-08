import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {publicationPolicy} from './publication-policy.mjs';

test('public package tooling runs without a private checkout or embedded customer names', () => {
  assert.deepEqual(publicationPolicy({}), {forbiddenTerms: []});
});
test('an explicitly supplied external policy is enforced and malformed policies fail closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'fireside-policy-'));
  const path = join(root, 'policy.json');
  try {
    writeFileSync(path, JSON.stringify({schemaVersion: 1, forbiddenTerms: ['private-customer.invalid']}));
    assert.deepEqual(publicationPolicy({FIRESIDE_PUBLICATION_POLICY: path}), {forbiddenTerms: ['private-customer.invalid']});
    writeFileSync(path, JSON.stringify({schemaVersion: 1, forbiddenTerms: [null]}));
    assert.throws(() => publicationPolicy({FIRESIDE_PUBLICATION_POLICY: path}));
    assert.throws(() => publicationPolicy({FIRESIDE_PUBLICATION_POLICY: join(root, 'missing.json')}));
    assert.throws(() => publicationPolicy({FIRESIDE_PUBLICATION_POLICY: 'relative.json'}));
  } finally { rmSync(root, {recursive: true}); }
});
