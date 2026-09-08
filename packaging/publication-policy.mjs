import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {isAbsolute} from 'node:path';

// Customer-specific deny terms belong to the consumer's private environment,
// never this repository or an npm tarball. Generic archive/secret checks always run.
export function publicationPolicy(environment = process.env) {
  const path = environment.FIRESIDE_PUBLICATION_POLICY;
  if (!path) return {forbiddenTerms: []};
  assert.ok(isAbsolute(path), 'The optional private policy requires an absolute external path');
  const policy = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(policy.schemaVersion, 1);
  assert.ok(Array.isArray(policy.forbiddenTerms));
  assert.ok(policy.forbiddenTerms.every(term => typeof term === 'string' && term.length > 0));
  return {forbiddenTerms: policy.forbiddenTerms};
}
