import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';

export class TransientRegistryRead extends Error {}

export async function probeRegistry(record, kind, fetchImpl = fetch) {
  assert.ok(['version', 'index'].includes(kind));
  const suffix = kind === 'version' ? `/${record.version}` : '';
  let response;
  try {
    response = await fetchImpl(`https://registry.npmjs.org/${record.name}${suffix}`, {
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new TransientRegistryRead(`Registry transport failed for ${record.name}`, { cause: error });
  }
  if (response.status === 404) return null;
  if ([408, 429].includes(response.status) || response.status >= 500) {
    throw new TransientRegistryRead(`Registry HTTP ${response.status} for ${record.name}`);
  }
  assert.equal(response.status, 200, `Unexpected registry response for ${record.name}`);
  const body = await response.json();
  const version = kind === 'version' ? body : body.versions?.[record.version];
  if (!version) return null;
  assert.equal(version.name, record.name, 'Registry package identity mismatch');
  assert.equal(version.version, record.version, 'Registry version identity mismatch');
  assert.equal(version.dist?.integrity, record.integrity, `Published artifact differs: ${record.name}. Stop; never overwrite a released version.`);
  if (kind === 'index') {
    assert.equal(body['dist-tags']?.next, record.version, `Unexpected next tag for ${record.name}`);
  }
  return body;
}

export async function waitForRegistry(records, kind, {
  probe = probeRegistry,
  sleep = pause,
  now = Date.now,
  timeoutMs = 20 * 60_000,
  intervalMs = 30_000,
  report = console.log,
} = {}) {
  const deadline = now() + timeoutMs;
  const pending = new Map(records.map(record => [record.name, record]));
  const verified = new Map();
  while (pending.size) {
    for (const [name, record] of pending) {
      let result;
      try { result = await probe(record, kind); }
      catch (error) {
        if (!(error instanceof TransientRegistryRead)) throw error;
      }
      if (result) { verified.set(name, result); pending.delete(name); }
    }
    if (!pending.size) return verified;
    if (now() >= deadline) {
      throw new Error(`Registry ${kind} availability timed out for ${[...pending.keys()].join(', ')}. Preserve accepted uploads; do not blindly republish or rebuild this version.`);
    }
    report(`Waiting for npm ${kind} availability: ${[...pending.keys()].join(', ')}`);
    await sleep(Math.min(intervalMs, deadline - now()));
  }
  return verified;
}

export async function publishVerifiedRelease(records, {
  publish,
  probe = probeRegistry,
  wait = waitForRegistry,
  accepted = [],
} = {}) {
  const cli = records.find(record => record.name === '@fireside-dev/cli');
  assert.ok(cli, 'CLI record required');
  const natives = records.filter(record => record !== cli);
  for (const name of accepted) assert.ok(records.some(record => record.name === name), `Unknown accepted package: ${name}`);
  async function ensureAccepted(record) {
    // Exact-version metadata can exist while npm hides the package index for
    // scanning. A matching accepted version is never uploaded a second time.
    if (await probe(record, 'version')) return;
    // A reviewed recovery receipt can prove npm acknowledged an earlier upload
    // even while BOTH metadata endpoints remain hidden. A 404 is not permission
    // to upload those bytes again; the shared read-only barrier below verifies it.
    if (accepted.includes(record.name)) return;
    await publish(record);
    // npm's successful acknowledgement is enough to start the next native scan.
    // Index readback below validates identity + integrity with the full allowance.
    // A failed/ambiguous publish throws; we never retry a write automatically.
  }
  for (const record of natives) await ensureAccepted(record);
  // Native scans overlap, but the CLI cannot become installable before its
  // complete dependency set has cleared the registry's availability barrier.
  const indexes = await wait(natives, 'index', { probe });
  await ensureAccepted(cli);
  for (const [name, body] of await wait([cli], 'index', { probe })) indexes.set(name, body);
  const automaticLatest = records.filter(record => record.version.includes('-') && indexes.get(record.name)?.['dist-tags']?.latest === record.version);
  if (automaticLatest.length) {
    throw new Error(`Verified prerelease artifacts also have automatic latest tags: ${automaticLatest.map(record => record.name).join(', ')}. Release owner must review this unexpected channel state; the registry may reject tag removal. Do not add an automation token, delete a version, or republish.`);
  }
  return indexes;
}
