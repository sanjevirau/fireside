import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { queryRulesProject } from "../src/rules/query-rules-cases.ts";
import { compareNativeCapture, verifyBrowserCapture, type BrowserCapture, type NativeCapture } from "../src/rules/query-rules-verification.ts";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const fixture = new URL("../fixtures/rules-v2/query-authorization/java-1.21.0/", import.meta.url);

test("query authorization matches native and real browser oracles in memory and disk/WAL", { timeout: 600_000 }, async (context) => {
  await execute("cargo", ["build", "--locked", "-p", "fireside"], { cwd: root });
  const metadata = JSON.parse((await execute("cargo", ["metadata", "--no-deps", "--format-version", "1"], { cwd: root })).stdout) as { target_directory: string };
  const expected = JSON.parse(await readFile(new URL("grpc.json", fixture), "utf8")) as NativeCapture;
  for (const mode of ["memory", "disk-wal"]) {
    const output = await mkdtemp(join(tmpdir(), `fireside-query-replay-${mode}-`));
    context.diagnostic(`${mode} evidence: ${output}`);
    const reservation = createServer();
    await new Promise<void>((done) => reservation.listen(0, "127.0.0.1", done));
    const address = reservation.address(); assert.ok(address && typeof address !== "string");
    await new Promise<void>((done) => reservation.close(() => done()));
    const origin = `http://127.0.0.1:${address.port}`;
    const binary = join(metadata.target_directory, "debug/fireside");
    const args = ["--host", "127.0.0.1", "--port", String(address.port), "--project_id", queryRulesProject, "--single_project_mode", "true", "--rules", fileURLToPath(new URL("firestore.rules", fixture))];
    if (mode === "disk-wal") args.push("--data-dir", join(output, "database"));
    const server = spawn(binary, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    const exited = once(server, "exit");
    const log: string[] = [];
    server.stdout.on("data", (data: Buffer) => log.push(data.toString()));
    server.stderr.on("data", (data: Buffer) => log.push(data.toString()));
    try {
      const deadline = Date.now() + 30_000;
      while (true) {
        assert.equal(server.exitCode, null, log.join(""));
        try { await fetch(origin, { signal: AbortSignal.timeout(500) }); break; } catch { /* Startup only. */ }
        assert.ok(Date.now() < deadline, log.join(""));
        await new Promise((done) => setTimeout(done, 50));
      }
      await execute(process.execPath, ["--import", "tsx", "src/rules/capture-query-rules.ts", "--origin", origin, "--output", join(output, "capture")], { cwd: join(root, "conformance"), env: { ...process.env, FIRESIDE_CAPTURE_BINARY: binary }, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
      const actual = JSON.parse(await readFile(join(output, "capture/grpc.json"), "utf8")) as NativeCapture;
      compareNativeCapture(actual, expected);
      for (const variant of ["long-poll", "streaming"]) {
        verifyBrowserCapture(JSON.parse(await readFile(join(output, `capture/${variant}-browser.json`), "utf8")) as BrowserCapture, expected);
      }
    } finally {
      if (server.exitCode === null && server.signalCode === null) {
        const timer = setTimeout(() => server.kill("SIGKILL"), 5000);
        server.kill("SIGTERM");
        await exited;
        clearTimeout(timer);
      }
      await writeFile(join(output, "server.log"), log.join(""));
    }
  }
});
