import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { createFirestore, createV1Firestore } from "../target.ts";
import { encodeFields } from "../rules/query-rules-transport.ts";
import { serializationCases, serializationProject, serializationRepeats, type SerializationObservation } from "./cases.ts";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1];
};
const version = argument("--java-version") ?? "1.21.0";
const hashes: Record<string, string> = {
  "1.21.0": "c3d3680a89d946a90a027365ea14c26c6472a162bcf37f099bbb1ebd66d25e8e",
  "1.22.0": "9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c",
};
assert.ok(hashes[version]);
const external = argument("--origin");
if (external) {
  const url = new URL(external);
  assert.ok(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "replay is loopback-only");
}
const output = resolve(argument("--output")!);
await mkdir(output, { recursive: true });
assert.deepEqual(await readdir(output), [], "never overwrite a recorded capture");
const temporary = await mkdtemp(join(tmpdir(), "fireside-map-capture-"));
const port = await reservePort();
const origin = external ?? `http://127.0.0.1:${port}`;
const configuration = { name: external ? "fireside" : "java", projectId: serializationProject, host: new URL(origin).host } as const;
const raw = createV1Firestore(configuration);
const sdk = createFirestore(configuration);
const parent = `projects/${serializationProject}/databases/(default)/documents`;
const options = { retry: null, timeout: 10_000, otherArgs: { headers: { authorization: "Bearer owner" } } };
const observations: SerializationObservation[] = [];
const startedAt = new Date().toISOString();
let child: ChildProcess | undefined;
let logs = "";
try {
  if (!external) {
    const jar = process.env.FIRESTORE_EMULATOR_JAR ?? join(process.env.HOME!, `.cache/firebase/emulators/cloud-firestore-emulator-v${version}.jar`);
    assert.equal(sha(await readFile(jar)), hashes[version]);
    const rules = join(temporary, "firestore.rules");
    await writeFile(rules, "rules_version = '2'; service cloud.firestore { match /databases/{db}/documents { match /{path=**} { allow read, write: if true; } } }\n");
    child = spawn(process.env.JAVA ?? "java", ["-jar", jar, "--host", "127.0.0.1", "--port", String(port), "--project_id", serializationProject, "--rules", rules], { cwd: temporary, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", data => { logs += String(data); });
    child.stderr?.on("data", data => { logs += String(data); });
  }
  const deadline = Date.now() + 30_000;
  while (true) {
    try { await fetch(origin); break; } catch {
      assert.ok(Date.now() < deadline, logs); assert.ok(child === undefined || child.exitCode === null, logs);
      await new Promise(done => setTimeout(done, 100));
    }
  }
  for (const testCase of serializationCases) {
    const path = `serialization-${testCase.id}/document`;
    const name = `${parent}/${path}`;
    await raw.commit({ database: parent.replace(/\/documents$/u, ""), writes: [{ update: { name, fields: encodeFields(testCase.fields) } }] }, options);
    for (const operation of ["sdk-get", "grpc-get", "grpc-list", "grpc-query", "rest-get"] as const) {
      const reads: string[] = [];
      for (let index = 0; index < serializationRepeats; index++) {
        let fields: unknown;
        if (operation === "sdk-get") fields = (await sdk.doc(path).get()).data();
        if (operation === "grpc-get") fields = (await raw.getDocument({ name }, options))[0].fields;
        if (operation === "grpc-list") {
          const [documents] = await raw.listDocuments({ parent, collectionId: `serialization-${testCase.id}` }, { ...options, autoPaginate: false });
          assert.equal(documents.length, 1); fields = documents[0]!.fields;
        }
        if (operation === "grpc-query") {
          const stream = raw.runQuery({ parent, structuredQuery: { from: [{ collectionId: `serialization-${testCase.id}` }] } }, options);
          const documents: unknown[] = [];
          for await (const message of stream) if (message.document) documents.push(message.document.fields);
          assert.equal(documents.length, 1); fields = documents[0];
        }
        if (operation === "rest-get") {
          const response = await fetch(`${origin}/v1/${name}`, { headers: { authorization: "Bearer owner" } });
          assert.equal(response.status, 200);
          fields = (await response.json() as { fields: unknown }).fields;
        }
        assert.ok(fields !== undefined); reads.push(JSON.stringify(fields));
      }
      observations.push({ id: testCase.id, operation, reads });
    }
  }
  const bundle = await build({ stdin: { sourcefile: "map-serialization.js", resolveDir: join(repo, "conformance"), contents: `
    import {initializeApp,deleteApp} from 'firebase/app';
    import {initializeFirestore,connectFirestoreEmulator,doc,getDocFromServer,terminate} from 'firebase/firestore';
    window.readMaps = async (port,variant,cases,repeats) => {
      const app=initializeApp({projectId:${JSON.stringify(serializationProject)},apiKey:'synthetic-map-capture'});
      const db=initializeFirestore(app,{experimentalForceLongPolling:variant==='long-poll',experimentalAutoDetectLongPolling:false});
      connectFirestoreEmulator(db,'127.0.0.1',port);
      const results=[];
      try { for(const testCase of cases){ const reads=[];for(let i=0;i<repeats;i++)reads.push(JSON.stringify((await getDocFromServer(doc(db,'serialization-'+testCase.id,'document'))).data()));results.push({id:testCase.id,operation:'browser-'+variant,reads});}return results; }
      finally {await terminate(db);await deleteApp(app);}
    };` }, bundle: true, write: false, platform: "browser", format: "iife", target: "es2022" });
  const server = createServer((request, response) => {
    response.setHeader("content-type", request.url === "/app.js" ? "text/javascript" : "text/html");
    response.end(request.url === "/app.js" ? bundle.outputFiles[0]!.text : '<script src="/app.js"></script>');
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_BIN ?? (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome") });
  try {
    for (const variant of ["long-poll", "streaming"]) {
      const page = await browser.newPage();
      const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${address.port}`);
      const values: SerializationObservation[] = await page.evaluate(`window.readMaps(${Number(new URL(origin).port)},${JSON.stringify(variant)},${JSON.stringify(serializationCases)},${serializationRepeats})`);
      assert.deepEqual(errors, []); observations.push(...values); await page.close();
    }
  } finally { await browser.close(); await new Promise<void>(done => server.close(() => done())); }
  await writeFile(join(output, "observations.json"), JSON.stringify({ cases: serializationCases, repeats: serializationRepeats, observations }, null, 2) + "\n");
  await writeFile(join(output, "metadata.json"), JSON.stringify({ schemaVersion: 1, target: external ? "fireside" : "official-java-emulator", version: external ? argument("--candidate-version") : version, javaJarSha256: external ? null : hashes[version], capturedAt: startedAt, syntheticOnly: true, operations: 7, repeatedReads: observations.reduce((sum, item) => sum + item.reads.length, 0), nodeVersion: process.version, platform: process.platform, nativeSdk: "@google-cloud/firestore@9.0.0", browserSdk: "firebase@12.18.0", observationLevel: "exact decoded document-field JSON; no timestamp/envelope comparison", writesDuringReadGroups: 0 }, null, 2) + "\n");
} finally {
  await sdk.terminate(); await raw.close();
  if (child && child.exitCode === null) { const exited = new Promise(done => child!.once("exit", done)); child.kill("SIGTERM"); await exited; }
  await writeFile(join(output, "capture.log"), logs);
  const files = (await readdir(output)).sort();
  await writeFile(join(output, "SHA256SUMS"), (await Promise.all(files.map(async name => `${sha(await readFile(join(output, name)))}  ${name}\n`))).join(""));
}
function sha(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
async function reservePort(): Promise<number> {
  const server = createNetServer(); await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  await new Promise<void>(done => server.close(() => done())); return address.port;
}
