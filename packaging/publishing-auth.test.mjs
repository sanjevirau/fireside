import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { authenticationFailure, verifyPublishingAuth, verifyMissingPublishingAuth } from './publishing-auth.mjs';

const env = { GITHUB_ACTIONS: 'true', ACTIONS_ID_TOKEN_REQUEST_URL: 'synthetic-url', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'synthetic-identity' };
const records = ['darwin-arm64', 'cli'].map(name => ({ name: `@fireside-dev/${name}`, path: `/synthetic/${name}.tgz` }));
const success = { status: 0, stdout: '', stderr: 'npm verbose oidc Successfully retrieved and set token\n' };
function executor(reply, calls = []) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    return args[0] === '--version' ? { status: 0, stdout: '12.0.2\n' } : reply;
  };
}

test('each package authenticates without uploading, running scripts or logging credentials', () => {
  const calls = [], reports = [];
  verifyPublishingAuth(records, { env, run: executor(success, calls), report: line => reports.push(line) });
  assert.equal(calls.length, 3);
  assert.equal(reports.length, 2);
  for (const { command, args, options } of calls.slice(1)) {
    assert.equal(command, 'npm');
    for (const flag of ['--dry-run', '--provenance', '--ignore-scripts']) assert.ok(args.includes(flag));
    assert.deepEqual(args.slice(-2), ['--logs-max', '0']);
    assert.equal(options.stdio, undefined);
    assert.equal(options.timeout, 120_000);
  }
});

test('successful unauthenticated dry-run and failed or timed-out clients stop before publishing', () => {
  for (const reply of [
    { status: 0, stderr: 'npm warn This command requires you to be logged in (dry-run)' },
    { ...success, status: 1 }, { status: null, stderr: null },
    { status: 0, stderr: 'npm verbose other Successfully retrieved and set token' },
  ]) {
    assert.throws(() => verifyPublishingAuth(records, { env, run: executor(reply) }), /Publishing authentication failed/);
  }
});

test('wrong environment, externally supplied identity and unreviewed npm are rejected', () => {
  for (const changes of [{ GITHUB_ACTIONS: 'false' }, { ACTIONS_ID_TOKEN_REQUEST_TOKEN: '' }, { NPM_ID_TOKEN: 'synthetic' }]) {
    assert.throws(() => verifyPublishingAuth(records, { env: { ...env, ...changes }, run: () => assert.fail('must not execute npm') }));
  }
  assert.throws(() => verifyPublishingAuth(records, { env, run: () => ({ status: 0, stdout: '12.0.3' }) }), /reviewed npm/);
});

test('diagnostics expose only fixed reasons and HTTP status, never URLs, tokens or server bodies', () => {
  const raw = 'npm http fetch POST 404 https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/@fireside-dev%2fcli\n' +
    'npm verbose oidc Failed token exchange request with body message: synthetic-secret https://private.invalid npm_synthetic\n';
  assert.equal(authenticationFailure(raw), 'registry rejected OIDC exchange (HTTP 404)');
  assert.throws(() => verifyPublishingAuth(records, { env, run: executor({ status: 0, stderr: raw }) }), error => {
    assert.match(error.message, /registry rejected OIDC exchange \(HTTP 404\)/);
    assert.doesNotMatch(error.message, /synthetic-secret|private.invalid|npm_synthetic/);
    return true;
  });
});

test('publisher checks every connection before writes and requires provenance on uploads', () => {
  const source = readFileSync(new URL('./publish-packages.mjs', import.meta.url), 'utf8');
  assert.ok(source.indexOf('const ordered =') < source.indexOf('await verifyMissingPublishingAuth(ordered,'));
  assert.ok(source.indexOf('validateRecoveryPackages(recovery, ordered)') < source.indexOf('await verifyMissingPublishingAuth(ordered,'));
  assert.ok(source.indexOf('await verifyMissingPublishingAuth(ordered,') < source.indexOf('await publishVerifiedRelease'));
  assert.match(source, /\['publish', record.path, '--provenance'/);
});

test('accepted hidden and registry-verified versions are not subjected to another publish dry-run', async () => {
  const calls = [];
  await verifyMissingPublishingAuth(records, {
    accepted: [records[0].name], env, run: executor(success, calls),
    probe: async record => { assert.equal(record.name, records[1].name); return { verified: true }; },
  });
  assert.equal(calls.length, 0);
  await verifyMissingPublishingAuth(records, {
    accepted: [records[0].name], env, run: executor(success, calls), probe: async () => null, report: () => {},
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].args[1], records[1].path);
});

test('registry uncertainty fails closed before authentication or uploads', async () => {
  await assert.rejects(verifyMissingPublishingAuth(records, {
    env, run: () => assert.fail('must not start authentication'),
    probe: async () => { throw new Error('synthetic integrity mismatch'); },
  }), /integrity mismatch/);
});
