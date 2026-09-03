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
import { queryRuleCases, queryRuleSeeds, queryRulesProject, queryRulesSource } from "./query-rules-cases.ts";
import { clientFor, grpcList, grpcListen, grpcQuery, seedDocument } from "./query-rules-transport.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const version = argument("--java-version") ?? "1.22.0";
const jarHashes: Record<string, string> = { "1.22.0": "9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c", "1.21.0": "c3d3680a89d946a90a027365ea14c26c6472a162bcf37f099bbb1ebd66d25e8e" };
const jarSha = jarHashes[version];
assert.ok(jarSha, "only the two pinned local emulator versions may be captured");
const jar = process.env.FIRESTORE_EMULATOR_JAR ?? join(process.env.HOME!, `.cache/firebase/emulators/cloud-firestore-emulator-v${version}.jar`);
const external = argument("--origin");
if (external) {
  const endpoint = new URL(external);
  assert.ok(endpoint.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname), "query fixture replay is loopback-only");
}
const output = resolve(argument("--output") ?? join(root, "conformance/fixtures/rules-v2/query-authorization"));
await mkdir(output, { recursive: true });
assert.deepEqual(await readdir(output), [], "capture output must be empty; never overwrite recorded oracle evidence");
const temporary = await mkdtemp(join(tmpdir(), "fireside-query-rules-"));
const logs: string[] = [];
const children: ChildProcess[] = [];
const generated: string[] = [];
const port = await reservePort();
const origin = external ?? `http://127.0.0.1:${port}`;
const client = clientFor(origin);
const startedAt = new Date().toISOString();
try {
  if (!external) {
    assert.equal(sha(await readFile(jar)), jarSha, "pinned official JAR");
    const rules = join(temporary, "firestore.rules");
    await writeFile(rules, queryRulesSource);
    start(process.env.JAVA ?? "java", ["-jar", jar, "--host", "127.0.0.1", "--port", String(port), "--project_id", queryRulesProject, "--single_project_mode", "true", "--rules", rules]);
  }
  await ready(origin);
  for (const [path, fields] of queryRuleSeeds) await seedDocument(client, path, fields);
  // Four independent read-only cases at a time. Ordering in the fixture remains
  // deterministic; seed mutations start only after every static probe finishes.
  const observations = [];
  for (let index = 0; index < queryRuleCases.length; index += 4) {
    const batch = await Promise.all(queryRuleCases.slice(index, index + 4).map(async (testCase) => {
      const values = await Promise.all([grpcQuery(client, testCase, false), grpcQuery(client, testCase, true), grpcListen(client, testCase)]);
      console.log(`${testCase.id}: ${values.map((value) => `${value.operation}=${value.code}`).join(" ")}`);
      return values;
    }));
    observations.push(...batch.flat());
    await writeFile(join(temporary, "grpc-checkpoint.json"), JSON.stringify(observations, null, 2));
  }
  for (const id of ["owner-absent", "owner-empty-unconstrained", "get-fixed-path", "limit-allowed"]) {
    observations.push(await grpcList(client, queryRuleCases.find((value) => value.id === id)!));
  }
  const owner = queryRuleCases[0]!;
  const [ownedPath, ownedFields] = queryRuleSeeds.find(([path]) => path === "presentations/owned")!;
  const mutation = async (stage: "update" | "leave") => {
    await seedDocument(client, ownedPath, stage === "update" ? { ...ownedFields, updatedAt: 3 } : { ...ownedFields, createdBy: "other-owner", updatedAt: 4 });
  };
  observations.push(await grpcListen(client, owner, mutation));
  await seedDocument(client, ownedPath, ownedFields);
  await save("grpc.json", { target: external ? "fireside" : `official-java-v${version}`, startedAt, cases: queryRuleCases, observations });
  assert.ok(observations.every((value) => value.code >= 0), "capture timeout is not an oracle verdict; inspect grpc.json");

  if (!process.argv.includes("--grpc-only")) {
    const bundle = await build({ entryPoints: [join(root, "conformance/src/rules/query-rules-browser-entry.ts")], bundle: true, write: false, format: "iife", globalName: "QueryRules", platform: "browser", target: "es2022" });
    const staticServer = createServer((request, response) => {
      if (request.url === "/mutate?stage=update" || request.url === "/mutate?stage=leave") {
        void mutation(request.url.endsWith("=update") ? "update" : "leave").then(() => { response.end("ok"); }, (error: unknown) => { response.statusCode = 500; response.end(String(error)); });
        return;
      }
      response.setHeader("content-type", request.url === "/app.js" ? "text/javascript" : "text/html");
      response.end(request.url === "/app.js" ? bundle.outputFiles[0]!.text : '<script src="/app.js"></script>');
    });
    await new Promise<void>((done) => staticServer.listen(0, "127.0.0.1", done));
    const address = staticServer.address();
    assert.ok(address && typeof address !== "string");
    const staticOrigin = `http://127.0.0.1:${address.port}`;
    const browser = await chromium.launch({ headless: true, ...(process.env.PHASE4_BROWSER_EXECUTABLE ? { executablePath: process.env.PHASE4_BROWSER_EXECUTABLE } : {}) });
    try {
      for (const variant of ["long-poll", "streaming"]) {
        const proxyPort = await reservePort();
        const proxyOrigin = `http://127.0.0.1:${proxyPort}`;
        const proxy = start(process.env.FIRESIDE_CAPTURE_BINARY ?? join(root, "target/debug/fireside"), ["capture-proxy", "--host", "127.0.0.1", "--port", String(proxyPort), "--upstream", origin, "--hypothesis", "Query authorization is over potential results, independent of stored rows", "--target", external ? "fireside" : "java", "--target-version", version, "--sdk", "firebase@12.18.0", "--recorded-at", startedAt, "--transport", "web-channel"]);
        await ready(`${proxyOrigin}/__fireside_capture/fixture`);
        // A separate proxy pool keeps cancelled WebChannel backchannels from
        // sharing upstream HTTP/1 connections with the SDK's unary REST count.
        // Neither rules, requests, nor responses are altered by this isolation.
        const countPort = await reservePort();
        const countOrigin = `http://127.0.0.1:${countPort}`;
        const countProxy = start(process.env.FIRESIDE_CAPTURE_BINARY ?? join(root, "target/debug/fireside"), ["capture-proxy", "--host", "127.0.0.1", "--port", String(countPort), "--upstream", origin, "--hypothesis", "Aggregation uses the same potential-result rules as Listen", "--target", external ? "fireside" : "java", "--target-version", version, "--sdk", "firebase@12.18.0", "--recorded-at", startedAt, "--transport", "http1"]);
        await ready(`${countOrigin}/__fireside_capture/fixture`);
        const page = await browser.newPage();
        const pageErrors: string[] = [];
        const consoleErrors: string[] = [];
        const requestFailures: { url: string; reason: string | null }[] = [];
        const httpFailures: { url: string; status: number; body: string }[] = [];
        const diagnostics: Promise<void>[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
        page.on("requestfailed", (request) => requestFailures.push({ url: request.url(), reason: request.failure()?.errorText ?? null }));
        page.on("response", (response) => {
          if (response.status() >= 500) diagnostics.push(response.text().then((body) => { httpFailures.push({ url: response.url(), status: response.status(), body }); }, (error: unknown) => { httpFailures.push({ url: response.url(), status: response.status(), body: String(error) }); }));
        });
        await page.goto(staticOrigin);
        const values = [];
        for (const testCase of queryRuleCases.filter((value) => value.offset === undefined)) {
          for (const operation of ["Listen", "RunAggregationQuery"]) {
            const endpoint = operation === "RunAggregationQuery" ? countOrigin : proxyOrigin;
            const value: unknown = await page.evaluate(`QueryRules.observe(${JSON.stringify(new URL(endpoint).host)}, ${JSON.stringify(variant)}, ${JSON.stringify(testCase)}, ${JSON.stringify(operation)})`);
            values.push({ id: testCase.id, operation, result: value });
          }
          console.log(`browser ${variant}: ${testCase.id}`);
        }
        const changes: unknown = await page.evaluate(`QueryRules.observe(${JSON.stringify(new URL(proxyOrigin).host)}, ${JSON.stringify(variant)}, ${JSON.stringify(owner)}, "Listen", ${JSON.stringify(`${staticOrigin}/mutate`)})`);
        values.push({ id: owner.id, operation: "ListenChanges", result: changes });
        await seedDocument(client, ownedPath, ownedFields);
        await Promise.all(diagnostics);
        await page.close();
        await save(`${variant}-browser.json`, { variant, browserVersion: browser.version(), pageErrors, consoleErrors, requestFailures, httpFailures, observations: values });
        const capture = await (await fetch(`${proxyOrigin}/__fireside_capture/fixture`)).json();
        await save(`${variant}-wire.json`, capture);
        await save(`${variant}-aggregation-wire.json`, await (await fetch(`${countOrigin}/__fireside_capture/fixture`)).json());
        await stop(countProxy);
        await stop(proxy);
        assert.deepEqual(pageErrors, [], "page exceptions are capture failures, not rules verdicts");
        assert.ok(values.every((value) => [0, "permission-denied"].includes((value.result as { code: number | string }).code)), "non-rules browser failure; inspect the preserved browser and wire evidence");
      }
    } finally {
      await browser.close();
      await new Promise<void>((done) => staticServer.close(() => done()));
    }
  }
  await save("metadata.json", { schemaVersion: 1, target: external ? "fireside" : "official-java-emulator", version, javaJarSha256: external ? null : jarSha, capturedAt: startedAt, rulesSourceSha256: sha(queryRulesSource), syntheticOnly: true, authorizationHeadersStored: false, cases: queryRuleCases.length, temporaryDirectory: temporary, nodeVersion: process.version, platform: process.platform, sdk: "firebase@12.18.0", nativeClient: "@google-cloud/firestore@9.0.0", separateListenAndAggregationProxyPools: true });
  await writeFile(join(output, "firestore.rules"), queryRulesSource);
  generated.push("firestore.rules");
} finally {
  await client.close();
  for (const child of children) await stop(child);
  await writeFile(join(output, "capture.log"), logs.join(""));
  generated.push("capture.log");
  await writeFile(join(output, "SHA256SUMS"), (await Promise.all(generated.map(async (name) => `${sha(await readFile(join(output, name)))}  ${name}\n`))).join(""));
}

async function save(name: string, value: unknown): Promise<void> {
  await writeFile(join(output, name), JSON.stringify(value, null, 2) + "\n");
  generated.push(name);
}
function sha(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function argument(name: string): string | undefined { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; }
function start(command: string, args: string[]): ChildProcess {
  const child = spawn(command, args, { cwd: temporary, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (data: Buffer) => logs.push(data.toString()));
  child.stderr?.on("data", (data: Buffer) => logs.push(data.toString()));
  children.push(child); return child;
}
async function ready(url: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (children.some((child) => child.exitCode !== null && child.exitCode !== 0 && child.signalCode === null)) throw new Error(`capture child exited: ${logs.join("")}`);
    try { await fetch(url, { signal: AbortSignal.timeout(1000) }); return; } catch { await new Promise((done) => setTimeout(done, 100)); }
  }
  throw new Error(`capture readiness failed: ${logs.join("")}`);
}
async function reservePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  await new Promise<void>((done) => server.close(() => done())); return address.port;
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((done) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.once("exit", () => { clearTimeout(timer); done(); }); child.kill("SIGTERM");
  });
}
