import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { chromium, type Page, type Request } from "playwright";
import { installPhase5DocumentSnapshotDiagnostics } from "./phase5-document-diagnostics.ts";
import { phase5ListenRequestSummary, phase5ListenResponseSummary, phase5SmokeDomEvidence } from "./phase5-listen-diagnostics.ts";

interface DiagnosticFailure {
  readonly kind: string;
  readonly text: string;
  readonly url?: string;
  readonly syntheticGoogleClientId?: boolean;
}

export interface Phase5PendingRequest {
  readonly method: string;
  readonly resourceType: string;
  readonly startedAt: number;
  readonly url: string;
}

export interface Phase5PendingRequestEvidence {
  readonly ageMs: number;
  readonly method: string;
  readonly resourceType: string;
  readonly url: string;
}

export interface Phase5StorageProbeTargets {
  readonly alias: string;
  readonly raw: string;
}

export const PHASE5_STORAGE_PENDING_PROBE_DELAY_MS = 30_000;
export const PHASE5_STORAGE_ATTRIBUTION_PROBE_BUDGET_MS = 10_000;

export function phase5PendingRequestEvidence(
  requests: Iterable<Phase5PendingRequest>,
  observedAt: number = Date.now(),
): Phase5PendingRequestEvidence[] {
  return [...requests]
    .sort((left, right) =>
      left.startedAt === right.startedAt
        ? left.url.localeCompare(right.url)
        : left.startedAt - right.startedAt,
    )
    .map((request) => ({
      ageMs: Math.max(0, observedAt - request.startedAt),
      method: request.method,
      resourceType: request.resourceType,
      url: request.url,
    }));
}

export function phase5StorageImageProbeTargets(
  requestUrl: string,
  resourceType: string,
  baseUrl: string,
  storagePort: number,
): Phase5StorageProbeTargets | null {
  if (resourceType !== "image") return null;
  const requested = new URL(requestUrl);
  const alias = new URL(baseUrl);
  alias.hostname = alias.hostname.replace("templates.", "storage.");
  if (
    requested.origin !== alias.origin ||
    !requested.pathname.startsWith("/v0/b/") ||
    requested.searchParams.get("alt") !== "media"
  ) {
    return null;
  }
  const raw = new URL(requested.href);
  raw.protocol = "http:";
  raw.hostname = "127.0.0.1";
  raw.port = String(storagePort);
  return { alias: requested.href, raw: raw.href };
}

export function phase5TemplateWarmupLines(log: string): string[] {
  return log
    .split(/\r?\n/u)
    .filter((line) =>
      /\[UserImage\]|\[API Upload Order\]|\[CDN Warming\]|Warmed:|Error warming|POST \/api\/user\/uploadUserImage/u.test(line),
    );
}

// Classification only: observers never suppress or replace runner events.
export function phase5BenignDiagnostic(input: DiagnosticFailure): string | null {
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
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname.endsWith(".twodart.localhost")) {
      return "harness-navigation-net-ERR_ABORTED";
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
  const pendingRequests = new Map<Request, Phase5PendingRequest & {
    probeTimer?: ReturnType<typeof setTimeout>;
  }>();
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
  const isListen = (url: string): boolean => new URL(url).pathname === "/google.firestore.v1.Firestore/Listen/channel";
  const exportPath = "/api/user/editor/ExportEditorPresentationJob/start";
  const settleRequest = (request: Request): void => {
    const observed = pendingRequests.get(request);
    if (observed?.probeTimer !== undefined) clearTimeout(observed.probeTimer);
    pendingRequests.delete(request);
  };
  const probeStorageTarget = async (
    page: Page,
    target: "alias" | "raw",
    url: string,
  ): Promise<Record<string, unknown>> => {
    const startedAt = Date.now();
    try {
      const response = await page.context().request.get(url, {
        failOnStatusCode: false,
        timeout: PHASE5_STORAGE_ATTRIBUTION_PROBE_BUDGET_MS,
      });
      const result = {
        budgetMs: PHASE5_STORAGE_ATTRIBUTION_PROBE_BUDGET_MS,
        elapsedMs: Date.now() - startedAt,
        outcome: "response",
        status: response.status(),
        statusText: response.statusText(),
        target,
        url,
      };
      await response.dispose();
      return result;
    } catch (error: unknown) {
      return {
        budgetMs: PHASE5_STORAGE_ATTRIBUTION_PROBE_BUDGET_MS,
        elapsedMs: Date.now() - startedAt,
        error: String(error),
        outcome: "error",
        status: null,
        target,
        url,
      };
    }
  };
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
      const observed = {
        method: request.method(),
        resourceType: request.resourceType(),
        startedAt: Date.now(),
        url: request.url(),
      } as Phase5PendingRequest & { probeTimer?: ReturnType<typeof setTimeout> };
      pendingRequests.set(request, observed);
      const probeTargets = request.method() === "GET"
        ? phase5StorageImageProbeTargets(
            request.url(),
            request.resourceType(),
            argument("base-url"),
            Number(argument("storage-port")),
          )
        : null;
      if (probeTargets !== null) {
        observed.probeTimer = setTimeout(() => {
          if (pendingRequests.get(request) !== observed) return;
          observeTask((async () => {
            const triggerAgeMs = Date.now() - observed.startedAt;
            const probes = await Promise.all([
              probeStorageTarget(page, "raw", probeTargets.raw),
              probeStorageTarget(page, "alias", probeTargets.alias),
            ]);
            record("storage-image-pending-probes", {
              pendingAgeMs: Date.now() - observed.startedAt,
              request: phase5PendingRequestEvidence([observed], Date.now())[0],
              probes,
              triggerAgeMs,
            });
          })());
        }, PHASE5_STORAGE_PENDING_PROBE_DELAY_MS);
      }
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
      if (isListen(request.url()) && request.method() === "POST" && request.postData() !== null) {
        try {
          record("listen-request", { url: request.url(), summary: phase5ListenRequestSummary(request.postData()!) });
        } catch (error: unknown) { record("listen-observer-error", { text: String(error) }); }
      }
    });
    // Wait for requestfinished rather than awaiting an open streaming response
    // at shutdown. Observers must not keep a backchannel or browser alive.
    page.on("requestfinished", (request) => {
      if (!isListen(request.url())) return;
      observeTask((async () => {
        const response = await request.response();
        if (response === null) return;
        record("listen-response", {
          url: response.url(), status: response.status(),
          ...(response.ok() ? { summary: phase5ListenResponseSummary(await response.text()) } : {}),
        });
      })());
    });
    page.on("requestfailed", (request) => {
      settleRequest(request);
      const text = request.failure()?.errorText ?? "unknown transport failure";
      record("request-failed", {
        method: request.method(), url: request.url(), resourceType: request.resourceType(),
        status: null, text,
        allowlistedAs: phase5BenignDiagnostic({ kind: "request-failed", text, url: request.url() }),
      });
    });
    page.on("response", (response) => {
      settleRequest(response.request());
      const url = response.url();
      const isExportStart = new URL(url).pathname === exportPath;
      const isExportStatus = new URL(url).pathname.startsWith("/api/user/editor/ExportEditorPresentationJob/status/");
      if (response.status() >= 400 || isCache(url) || isExportStart || isExportStatus) {
        observeTask((async () => record("response", {
          url, method: response.request().method(), status: response.status(), statusText: response.statusText(),
          ...(isExportStart || isExportStatus ? { body: await response.text(), exportStart: isExportStart, exportStatus: isExportStatus } : {}),
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
    const requireFromTwodart = createRequire(path.join(path.resolve(argument("twodart-dir")), "package.json"));
    const firestoreModule = requireFromTwodart("firebase-admin/firestore") as {
      readonly DocumentSnapshot: { readonly prototype: { data?: unknown } };
      readonly QueryDocumentSnapshot: { readonly prototype: { data?: unknown } };
    };
    const restoreDocumentDiagnostics = installPhase5DocumentSnapshotDiagnostics(
      process.argv.includes("--seed-smoke"),
      [firestoreModule.DocumentSnapshot, firestoreModule.QueryDocumentSnapshot],
      observation => record("synthetic-deck-snapshot", { observation }),
    );
    record("diagnostic-contract", {
      syntheticGoogleClientId, verbatimSyntheticText: true,
      userIdentifiersAndOtpsHashed: true, runnerEventsSuppressed: false,
      listenShapeObservations: true, completeDomSyntheticSmokeOnly: true,
      syntheticDeckSnapshotValues: true, fullDataDocumentValues: false,
      additionalFirestoreRequests: 0,
      additionalStorageRequests: {
        maximumPerStalledImage: 2,
        pendingDelayMs: PHASE5_STORAGE_PENDING_PROBE_DELAY_MS,
        probeBudgetMs: PHASE5_STORAGE_ATTRIBUTION_PROBE_BUDGET_MS,
        readOnly: true,
      },
    });
    const browser = await originalLaunch(options);
    const originalContext = browser.newContext.bind(browser);
    browser.newContext = async (contextOptions) => {
      const context = await originalContext(contextOptions);
      context.on("page", observePage);
      return context;
    };
    const originalClose = browser.close.bind(browser);
    browser.close = async (closeOptions) => {
      try {
        const runnerEvidence = JSON.parse(await readFile(argument("output"), "utf8")) as {
          readonly passed?: unknown;
        };
        if (runnerEvidence.passed === false) {
          record("pending-requests-at-journey-failure", {
            requests: phase5PendingRequestEvidence(pendingRequests.values()),
          });
        }
      } catch (error: unknown) {
        record("pending-request-snapshot-error", { text: String(error) });
      }
      if (argument("stack") === "official") {
        try {
          const log = await readFile(
            path.join(argument("twodart-dir"), ".logs", "templates.log"),
            "utf8",
          );
          record("official-templates-warmup", {
            lines: phase5TemplateWarmupLines(log),
          });
        } catch (error: unknown) {
          record("official-templates-warmup-error", { text: String(error) });
        }
      }
      for (const context of browser.contexts()) for (const page of context.pages()) {
        try {
          const text = await page.locator("body").innerText({ timeout: 2_000 });
          record("loader-dom", { url: page.url(), text: text.split("\n").filter((line) => /Failed to load app data|Loading app|Loading\.\.\./iu.test(line)).join("\n") });
          const smokeText = phase5SmokeDomEvidence(process.argv.includes("--seed-smoke"), text);
          if (smokeText !== null) {
            const overlayText: unknown = await page.evaluate(`Array.from(document.querySelectorAll('nextjs-portal')).map(function (portal) { var root = portal.shadowRoot; return root ? Array.from(root.querySelectorAll('[role="dialog"], [data-nextjs-dialog-body]')).map(function (node) { return node.textContent; }) : []; })`);
            record("synthetic-smoke-dom", { url: page.url(), text: smokeText, overlayText });
          }
        } catch (error: unknown) { record("loader-dom-error", { text: String(error) }); }
      }
      await Promise.allSettled([...pending]);
      for (const request of pendingRequests.values()) {
        if (request.probeTimer !== undefined) clearTimeout(request.probeTimer);
      }
      await writes;
      await originalClose(closeOptions);
      await writes;
      restoreDocumentDiagnostics();
    };
    return browser;
  };
}
