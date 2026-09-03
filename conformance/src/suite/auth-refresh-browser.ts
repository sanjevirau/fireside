import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { customRefreshToken, observeRefresh, refreshPath, refreshProject, type RefreshObservation } from "./auth-refresh-contract.ts";

export async function captureRefreshBrowser(origin: string): Promise<{ observations: RefreshObservation[]; stages: string[]; pageErrors: string[]; browserVersion: string }> {
  const bundle = await build({
    stdin: { contents: `
      import { initializeApp } from "firebase/app";
      import { getAuth, connectAuthEmulator, signInWithCustomToken, getIdToken } from "firebase/auth";
      const auth = getAuth(initializeApp({ apiKey: "synthetic-api-key", projectId: ${JSON.stringify(refreshProject)} }));
      connectAuthEmulator(auth, ${JSON.stringify(origin)}, { disableWarnings: true });
      window.refreshProbe = {
        ready: async () => { await auth.authStateReady(); return !!auth.currentUser; },
        signIn: async (token) => { await signInWithCustomToken(auth, token); return !!auth.currentUser; },
        refresh: async () => { await getIdToken(auth.currentUser, true); return true; }
      };
    `, resolveDir: fileURLToPath(new URL("../../", import.meta.url)) },
    bundle: true, write: false, format: "esm", platform: "browser", target: "es2022",
  });
  const server = createServer((request, response) => {
    response.setHeader("content-type", request.url === "/app.js" ? "text/javascript" : "text/html");
    response.end(request.url === "/app.js" ? bundle.outputFiles[0]!.text : '<script type="module" src="/app.js"></script>');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let executablePath: string | undefined;
  for (const candidate of [process.env.PHASE4_BROWSER_EXECUTABLE, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"]) {
    if (!candidate) continue;
    try { await access(candidate); executablePath = candidate; break; } catch { /* Try managed Chromium last. */ }
  }
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const stages: string[] = [];
  const pageErrors: string[] = [];
  const pending: Promise<RefreshObservation>[] = [];
  try {
    const context = await browser.newContext();
    context.on("page", (page) => page.on("pageerror", (error) => pageErrors.push(error.message)));
    context.on("response", (response) => {
      if (response.request().method() !== "POST" || !response.url().includes(refreshPath.split("?")[0]!)) return;
      const id = `browser-refresh-${pending.length + 1}`;
      const input = new URLSearchParams(response.request().postData() ?? "").get("refresh_token") ?? "";
      pending.push((async () => observeRefresh(id, response.status(), new Headers(await response.allHeaders()), await response.json(), input, "refresh-browser-user"))());
    });
    const first = await context.newPage();
    const app = `http://127.0.0.1:${address.port}`;
    await first.goto(app);
    await first.waitForFunction("!!window.refreshProbe");
    assert.equal(await first.evaluate("window.refreshProbe.ready()"), false);
    assert.equal(await first.evaluate(`window.refreshProbe.signIn(${JSON.stringify(customRefreshToken("refresh-browser-user"))})`), true);
    stages.push("custom-token-sign-in");
    assert.equal(await first.evaluate("window.refreshProbe.refresh()"), true);
    await Promise.all(pending);
    stages.push("forced-refresh");
    const second = await context.newPage();
    await second.goto(app);
    await second.waitForFunction("!!window.refreshProbe");
    assert.equal(await second.evaluate("window.refreshProbe.ready()"), true);
    stages.push("second-tab-restored-user");
    assert.deepEqual(await Promise.all([first, second].map((page) => page.evaluate("window.refreshProbe.refresh()"))), [true, true]);
    await Promise.all(pending);
    stages.push("concurrent-two-tab-refresh");
    await first.reload();
    await first.waitForFunction("!!window.refreshProbe");
    assert.equal(await first.evaluate("window.refreshProbe.ready()"), true);
    assert.equal(await first.evaluate("window.refreshProbe.refresh()"), true);
    stages.push("reload-restored-user-and-refresh");
    const observations = await Promise.all(pending);
    assert.equal(observations.length, 4);
    return { observations, stages, pageErrors, browserVersion: browser.version() };
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}
