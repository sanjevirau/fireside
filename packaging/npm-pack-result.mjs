import { basename } from 'node:path';

export function packResult(text, expectedName) {
  const parsed = JSON.parse(text);
  const entries = Array.isArray(parsed) ? parsed : Object.values(parsed);
  if (entries.length !== 1) throw new Error('Expected exactly one packed package');
  const result = entries[0];
  if (result?.name !== expectedName || typeof result.filename !== 'string' ||
      basename(result.filename) !== result.filename || !result.filename.endsWith('.tgz')) {
    throw new Error('Unexpected npm pack identity or filename');
  }
  return result;
}

export function registryIntegrity(text) {
  const parsed = JSON.parse(text);
  const value = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;
  if (typeof value !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error('Unexpected npm registry integrity response');
  }
  return value;
}
