import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// npm 12.0.2 treats a failed OIDC exchange as optional and can then fall back
// to other credentials. Dry-run performs that exchange but never uploads.
// Require its explicit success before any package write. Do not stream verbose
// npm output: it includes authentication request URLs and registry error bodies.
export function authenticationFailure(stderr = '') {
  const statuses = [...stderr.matchAll(/npm http fetch POST (\d{3}) https:\/\/registry\.npmjs\.org\/-\/npm\/v1\/oidc\/token\/exchange\/package\/[^\s]+/g)];
  const status = statuses.at(-1)?.[1];
  let reason = 'no explicit OIDC success';
  if (stderr.includes('Failed token exchange request')) reason = 'registry rejected OIDC exchange';
  else if (stderr.includes('Failed to fetch id_token from GitHub')) reason = 'GitHub identity request failed';
  else if (stderr.includes('incorrect permissions for id-token')) reason = 'GitHub identity permission missing';
  else if (stderr.includes('no id_token available')) reason = 'GitHub identity unavailable';
  else if (stderr.includes('missing the token in the response body')) reason = 'registry exchange returned no token';
  // Only these fixed labels and a three-digit status leave the child process.
  return `${reason}${status ? ` (HTTP ${status})` : ''}`;
}

export function verifyPublishingAuth(records, { env = process.env, run = spawnSync, report = console.log } = {}) {
  assert.equal(env.GITHUB_ACTIONS, 'true', 'Protected GitHub publishing only');
  assert.ok(env.ACTIONS_ID_TOKEN_REQUEST_URL && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    'Missing GitHub id-token permission; no publication attempted');
  assert.ok(!env.NPM_ID_TOKEN, 'An externally supplied identity cannot replace this GitHub job');
  const version = run('npm', ['--version'], { encoding: 'utf8', env });
  assert.ok(version.status === 0 && version.stdout.trim() === '12.0.2',
    'Authentication contract requires the reviewed npm 12.0.2 client');
  for (const record of records) {
    assert.match(record.name, /^@fireside-dev\/(?:cli|darwin-arm64|darwin-x64|linux-arm64|linux-x64|win32-x64)$/);
    const result = run('npm', ['publish', record.path, '--dry-run', '--provenance',
      '--access', 'public', '--tag', 'next', '--ignore-scripts', '--loglevel', 'verbose', '--logs-max', '0'],
    { encoding: 'utf8', env, maxBuffer: 4 * 1024 * 1024, timeout: 120_000 });
    // A successful dry-run alone is insufficient: npm permits unauthenticated
    // dry-runs. Check the exact pinned-client OIDC success record as well.
    const stderr = typeof result.stderr === 'string' ? result.stderr : '';
    if (result.status !== 0 || !stderr.split(/\r?\n/).includes('npm verbose oidc Successfully retrieved and set token')) {
      throw new Error(`Publishing authentication failed for ${record.name}: ${authenticationFailure(stderr)}. No upload attempted by this preflight.`);
    }
    report(`OIDC authentication verified without upload: ${record.name}`);
  }
}
