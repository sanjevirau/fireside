import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const assets = [
  {name: 'storageRules', file: 'cloud-storage-rules-runtime-v1.1.3.jar', bytes: 52892936, sha256: '0cd52db6f6271d62078f805220706377c849220b73bd68aa27078d977df9c900'},
  {name: 'ui', file: 'ui-v1.15.0.zip', bytes: 3538469, sha256: '97d8c4c574e3f20c4d690a2ce8373eef76ab024da73279a062dba8517f88cf9a'},
];
export const cacheRoot = () => process.env.FIREBASE_EMULATORS_PATH || join(homedir(), '.cache/firebase/emulators');

export async function verifyAsset(path, asset) {
  if ((await stat(path)).size !== asset.bytes) throw new Error(`Unexpected size for ${path}`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest('hex') !== asset.sha256) throw new Error(`Checksum mismatch for ${path}; preserve and inspect it before reinstalling.`);
  return path;
}

export async function assetPaths(root = cacheRoot()) {
  return Object.fromEntries(await Promise.all(assets.map(async asset => [asset.name, await verifyAsset(join(root, asset.file), asset)])));
}

// Explicit setup only. Never called by package lifecycle or normal start.
export async function setupAssets(root = cacheRoot()) {
  await mkdir(root, {recursive: true});
  for (const asset of assets) {
    const path = join(root, asset.file);
    try { await stat(path); await verifyAsset(path, asset); continue; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const lockPath = `${path}.fireside-lock`;
    const lock = await open(lockPath, 'wx');
    const temporary = `${path}.${randomUUID()}.partial`;
    try {
      // Re-check after exclusive lock: another setup may have completed.
      try { await stat(path); await verifyAsset(path, asset); continue; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const response = await fetch(`https://storage.googleapis.com/firebase-preview-drop/emulator/${asset.file}`, {signal: AbortSignal.timeout(120000), redirect: 'error'});
      if (!response.ok || !response.body) throw new Error(`Asset download ${asset.file}: HTTP ${response.status}`);
      let bytes = 0;
      const bound = new Transform({transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        callback(bytes > asset.bytes ? new Error('Asset exceeds pinned size') : null, chunk);
      }});
      await pipeline(Readable.fromWeb(response.body), bound, createWriteStream(temporary, {flags: 'wx', mode: 0o600}));
      await verifyAsset(temporary, asset);
      await rename(temporary, path);
      console.log(`Verified compatibility asset: ${path}`);
    } finally {
      await lock.close();
      await unlink(lockPath);
      // Partial downloads are preserved on error; never touch emulator data.
    }
  }
}
