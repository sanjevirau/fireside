import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Page } from "playwright";

interface DiagnosticFailure {
  readonly kind: string;
  readonly text: string;
  readonly url?: string;
  readonly syntheticGoogleClientId?: boolean;
}

// Classification only: observers never suppress or replace runner events.
export function phase5BenignDiagnostic(input: DiagnosticFailure): string | null {
  if (input.kind === "page-error" && input.syntheticGoogleClientId === true &&
      /ReferenceError/u.test(input.text) &&
      /useGoogleOneTap|accounts\.google\.com\/gsi|Google One Tap/iu.test(input.text)) {
    return "synthetic-google-one-tap-reference-error";
  }
  if (input.kind === "page-error" && /TypeError/u.test(input.text) &&
      /handleStaticIndicator/u.test(input.text) && /_next\/|next[\\/]|hot-reloader|dev-bundler/iu.test(input.text)) {
    return "next-dev-hmr-handleStaticIndicator-type-error";
  }
  if (input.kind === "request-failed" && input.text === "net::ERR_ABORTED" && input.url !== undefined) {
    const url = new URL(input.url);
    if ((url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
        /^\/google\.firestore\.v1\.Firestore\/(?:Listen|Write)\/channel$/u.test(url.pathname)) {
      return "firestore-long-poll-net-ERR_ABORTED";
    }
  }
  return null;
}

export function redactPhase5Identifiers(text: string, identifiers: ReadonlySet<string>): string {
  let output = text;
  for (const value of [...identifiers].filter(Boolean).sort((a, b) => b.length - a.length)) {
    const replacement = `[identity-sha256:${createHash("sha256").update(value).digest("hex")}]`;
    output = output.split(value).join(replacement).split(encodeURIComponent(value)).join(replacement);
  }
  return output.replace(/((?:otpCode|verificationCode|OTP(?: code)?)\s*[=:"']*\s*)(\d{6})/giu,
    (_match, prefix: string, otp: string) => `${prefix}[otp-sha256:${createHash("sha256").update(otp).digest("hex")}]`);
}

export async function readPhase5DiagnosticIdentities(url: string, fetcher: typeof fetch = fetch): Promise<Set<string>> {
  const response = await fetcher(url, {
    method: "POST", headers: { authorization: "Bearer owner", "content-type": "application/json" },
    body: JSON.stringify({ order: "ASC", returnUserInfo: true, sortBy: "USER_ID" }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`diagnostic identity redaction preflight returned ${response.status}: ${await response.text()}`);
  }
  const accounts = await response.json() as { userInfo?: readonly Record<string, unknown>[] };
  if (accounts.userInfo === undefined || accounts.userInfo.length !== 1) {
    throw new Error("diagnostic identity redaction requires the single seeded Auth account");
  }
  const result = new Set<string>();
  for (const user of accounts.userInfo) {
    for (const key of ["localId", "email", "displayName"]) if (typeof user[key] === "string") result.add(user[key]);
  }
  return result;
}

if (process.argv[1]?.endsWith("run-phase5-browser-journeys.ts") === true) {
  const argument = (name: string): string => {
    const index = process.argv.indexOf(`--${name}`);
    const value = index < 0 ? undefined : process.argv[index + 1];
    if (value === undefined) throw new Error(`diagnostic preload requires --${name}`);
    return value;
  };
  const output = `${argument("output")}.diagnostics.jsonl`;
  const identities = new Set<string>();
  const pending = new Set<Promise<unknown>>();
  let writes = Promise.resolve();
  let syntheticGoogleClientId = false;
  const record = (kind: string, data: Record<string, unknown>): void => {
    const line = redactPhase5Identifiers(JSON.stringify({ at: new Date().toISOString(), kind, ...data }), identities);
    writes = writes.then(async () => { await appendFile(output, `${line}\n`); });
  };
  const observeTask = (task: Promise<unknown>): void => {
    pending.add(task);
    void task.catch((error: unknown) => record("observer-error", { text: String(error) }))
      .finally(() => pending.delete(task));
  };
  const isCache = (url: string): boolean => /\/o\/cache%2Fmain-cache-local\.json(?:\?|$)/iu.test(url);
  const exportPath = "/api/user/editor/ExportEditorPresentationJob/start";
  const observePage = (page: Page): void => {
    page.on("pageerror", (error) => {
      const text = `${error.name}: ${error.message}\n${error.stack ?? ""}`;
      record("page-error", { text, allowlistedAs: phase5BenignDiagnostic({ kind: "page-error", text, syntheticGoogleClientId }) });
    });
    page.on("console", (message) => {
      if (message.type() === "error" || /Local cache data fetched|Failed to fetch local cache data|Cache WebSocket|Failed to load app data/iu.test(message.text())) {
        record("console", { level: message.type(), text: message.text(), location: message.location() });
      }
    });
    page.on("request", (request) => {
      // Only extract identifier/OTP values; no auth request or credential bodies are stored.
      if (new URL(request.url()).pathname === "/api/login/verificationCode") {
        try {
          const body = request.postDataJSON() as Record<string, unknown>;
          for (const key of ["email", "otpCode", "verificationCode", "code"]) {
            if (typeof body[key] === "string") identities.add(body[key]);
          }
        } catch { /* no JSON body */ }
      }
      if (new URL(request.url()).pathname === exportPath || isCache(request.url())) {
        record("required-request", { method: request.method(), url: request.url() });
      }
    });
    page.on("requestfailed", (request) => {
      const text = request.failure()?.errorText ?? "unknown transport failure";
      record("request-failed", {
        method: request.method(), url: request.url(), resourceType: request.resourceType(),
        status: null, text,
        allowlistedAs: phase5BenignDiagnostic({ kind: "request-failed", text, url: request.url() }),
      });
    });
    page.on("response", (response) => {
      const url = response.url();
      const isExportStart = new URL(url).pathname === exportPath;
      if (response.status() >= 400 || isCache(url) || isExportStart) {
        observeTask((async () => record("response", {
          url, method: response.request().method(), status: response.status(), statusText: response.statusText(),
          ...(isExportStart ? { body: await response.text(), exportStart: true } : {}),
          ...(isCache(url) ? { requiredCache: true } : {}),
        }))());
      }
    });
    page.on("websocket", (socket) => {
      if (new URL(socket.url()).port !== argument("cache-websocket-port")) return;
      record("required-cache-websocket", { url: socket.url(), event: "opened" });
      socket.on("socketerror", (text) => record("required-cache-websocket", { url: socket.url(), event: "error", text }));
      socket.on("framereceived", ({ payload }) => record("required-cache-websocket", {
        url: socket.url(), event: "frame", text: Buffer.isBuffer(payload) ? payload.toString() : payload,
      }));
      socket.on("close", () => record("required-cache-websocket", { url: socket.url(), event: "closed" }));
    });
  };

  const originalLaunch = chromium.launch.bind(chromium);
  chromium.launch = async (options) => {
    await mkdir(path.dirname(output), { recursive: true });
    const known = await readPhase5DiagnosticIdentities(`http://127.0.0.1:${argument("auth-port")}/identitytoolkit.googleapis.com/v1/projects/${argument("project-id")}/accounts:query`);
    for (const value of known) identities.add(value);
    const appEnv = await readFile(path.join(argument("twodart-dir"), "apps/templates/.env.local"), "utf8");
    syntheticGoogleClientId = /^NEXT_PUBLIC_FIREBASE_AUTH_GOAUTH=["']?false["']?\s*$/mu.test(appEnv);
    record("diagnostic-contract", { syntheticGoogleClientId, verbatimSyntheticText: true, userIdentifiersAndOtpsHashed: true, runnerEventsSuppressed: false });
    const browser = await originalLaunch(options);
    const originalContext = browser.newContext.bind(browser);
    browser.newContext = async (contextOptions) => {
      const context = await originalContext(contextOptions);
      context.on("page", observePage);
      return context;
    };
    const originalClose = browser.close.bind(browser);
    browser.close = async (closeOptions) => {
      for (const context of browser.contexts()) for (const page of context.pages()) {
        try {
          const text = await page.locator("body").innerText({ timeout: 2_000 });
          record("loader-dom", { url: page.url(), text: text.split("\n").filter((line) => /Failed to load app data|Loading app|Loading\.\.\./iu.test(line)).join("\n") });
        } catch (error: unknown) { record("loader-dom-error", { text: String(error) }); }
      }
      await Promise.allSettled([...pending]);
      await writes;
      await originalClose(closeOptions);
      await writes;
    };
    return browser;
  };
}
