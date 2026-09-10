import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../fixtures/developer-tools-coverage-v1/', import.meta.url);
const bytes = await readFile(new URL('fixture.json', root));
const fixture = JSON.parse(bytes);
const profile = id => fixture.profiles.find(value => value.id === id);
const nodes = (list = []) => list.flatMap(node => [node, ...nodes(node.children)]);

test('coverage capture has pinned identity, inputs, outcomes and checksums', async () => {
  assert.equal(await readFile(new URL('SHA256SUMS', root), 'utf8'), createHash('sha256').update(bytes).digest('hex') + '  fixture.json\n');
  assert.equal(fixture.oracle.firestore, '1.22.0');
  assert.equal(fixture.oracle.node, '24.20.0');
  assert.equal(fixture.oracle.jarSha256, '9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c');
  assert.equal(fixture.syntheticOnly, true);
  assert.equal(fixture.profiles.length, 13);
  assert.equal(fixture.seed.status, 200);
  assert.equal(fixture.seed.owner, true);
  assert.ok(!/Bearer |\/Users\/|\/var\/folders\//.test(bytes.toString()));
  for (const value of fixture.profiles) {
    assert.equal(value.before.rules.files[0].content, value.source);
    assert.equal(value.after.rules.files[0].content, value.source);
    assert.ok(nodes(value.before.report).every(node => node.values === undefined));
  }
});

test('Unicode scalar source locations preserve inclusive ranges and CRLF positions', () => {
  const value = profile('unicode-crlf');
  const source = Array.from(value.source);
  const extract = node => source.slice(node.sourcePosition.currentOffset, node.sourcePosition.endOffset + 1).join('');
  assert.equal(extract(value.after.report[0]), "'中文🚀' == '中文🚀' && resource.data.visible");
  assert.equal(extract(value.after.report[0].children[1]), 'resource.data.visible');
  for (const node of nodes(value.after.report)) {
    const position = node.sourcePosition;
    const before = source.slice(0, position.currentOffset);
    assert.equal(position.line, before.filter(char => char === '\n').length + 1);
    assert.equal(position.column, before.length - before.lastIndexOf('\n'));
  }
  assert.notEqual(value.source.slice(value.after.report[0].sourcePosition.currentOffset, value.after.report[0].sourcePosition.endOffset + 1), extract(value.after.report[0]));
});

test('constants, skipped subtrees and errors are preserved rather than normalized into passes', () => {
  assert.equal(profile('constant').before.report, undefined);
  assert.equal(profile('constant').after.report, undefined);
  const skipped = profile('short-circuit');
  assert.equal(skipped.status, 403);
  assert.deepEqual(skipped.after.report[0].values, [{ value: { boolValue: false }, count: 2 }]);
  assert.deepEqual(skipped.after.report[0].children[0].values, [{ value: {}, count: 2 }]);
  const missing = profile('missing-field');
  assert.equal(missing.status, 403);
  assert.ok(missing.after.report[0].values.some(entry => entry.value.undefined?.causeMessage === 'Property missing is undefined on object.'));
  assert.equal(profile('function').after.report.length, 2);
});

test('invalid reload retains the last valid source and all coverage counters', () => {
  assert.equal(fixture.invalidReload.status, 400);
  assert.deepEqual(fixture.afterInvalidReload, fixture.profiles.at(-1).after);
});
