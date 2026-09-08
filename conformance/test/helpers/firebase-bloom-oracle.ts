import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Script, createContext } from "node:vm";

export interface FirebaseBloomFilter {
  readonly bitmap: Uint8Array;
  readonly padding: number;
  readonly hashCount: number;
  mightContain(value: string): boolean;
}

export interface FirebaseBloomOracle {
  new(bitmap: Uint8Array, padding: number, hashCount: number): FirebaseBloomFilter;
  create(bitCount: number, hashCount: number, members: readonly string[]): FirebaseBloomFilter;
}

const conformanceRoot = new URL("../../", import.meta.url);
const fixtureUrl = new URL(
  "fixtures/firestore-bloom-nonmember-false-positive/fixture.json", conformanceRoot,
);
const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

/** Load only the hash-verified official client implementation; no emulator I/O. */
export async function loadPinnedFirebaseBloomOracle(): Promise<FirebaseBloomOracle> {
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
  const pins = fixture.oracle;
  const lock = JSON.parse(await readFile(new URL("package-lock.json", conformanceRoot), "utf8"));
  for (const [name, version, integrity] of [
    ["firebase", pins.firebaseVersion, undefined],
    ["@firebase/firestore", pins.firestorePackageVersion, pins.firestorePackageIntegrity],
    ["@firebase/webchannel-wrapper", pins.bloomPackageVersion, pins.bloomPackageIntegrity],
  ] as const) {
    const installed = JSON.parse(await readFile(new URL(`node_modules/${name}/package.json`, conformanceRoot), "utf8"));
    assert.equal(installed.version, version, `${name} oracle package version`);
    assert.equal(lock.packages[`node_modules/${name}`].version, version, `${name} lockfile version`);
    if (integrity !== undefined) {
      assert.equal(lock.packages[`node_modules/${name}`].integrity, integrity, `${name} lockfile integrity`);
    }
  }
  const source = await readFile(new URL(pins.firestoreSource, conformanceRoot), "utf8");
  assert.equal(sha256(source), pins.firestoreSourceSha256, "official Firestore source changed; recapture oracle deliberately");
  const start = source.indexOf(pins.extractionStart);
  const errorClass = source.indexOf(pins.extractionEndClass, start);
  const end = source.indexOf("\n/**", errorClass);
  assert.ok(start >= 0 && errorClass > start && end > errorClass, "official Bloom extraction boundaries");
  const selectedSource = source.slice(start, end);
  assert.equal(sha256(selectedSource), pins.extractedSourceSha256, "official Bloom block identity");

  const require = createRequire(new URL("package.json", conformanceRoot));
  const blobPath = require.resolve("@firebase/webchannel-wrapper/bloom-blob");
  assert.equal(sha256(await readFile(blobPath)), pins.bloomBlobSourceSha256, "actual official MD5/Integer dependency identity");
  assert.equal(sha256(await readFile(new URL(pins.bloomBlobSource, conformanceRoot))), pins.bloomBlobSourceSha256);
  const context = createContext({
    bloomBlob: require("@firebase/webchannel-wrapper/bloom-blob") as unknown,
    newTextEncoder: () => new TextEncoder(),
    DataView,
    Uint8Array,
  }, { codeGeneration: { strings: false, wasm: false } });
  // Only the already hash-verified upstream block is compiled. The appended
  // assignment exposes its class without loading unrelated SDK networking code.
  new Script(`${selectedSource}\nglobalThis.oracleBloomFilter = BloomFilter;`, {
    filename: "pinned-firebase-bloom-oracle.js",
  }).runInContext(context, { timeout: 1_000 });
  const result = context.oracleBloomFilter as FirebaseBloomOracle | undefined;
  assert.equal(typeof result, "function");
  assert.equal(typeof result?.create, "function");
  return result!;
}
