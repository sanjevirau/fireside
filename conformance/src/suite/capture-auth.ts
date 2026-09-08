import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer as createTcpServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOST = "127.0.0.1";
const PROJECT_ID = "demo-fireside-phase4-auth-oracle";
const API_KEY = "phase4-fake-api-key";
const FIREBASE_TOOLS_VERSION = "15.22.0";
const fixtureBase = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../fixtures/firebase-suite-v1",
);

interface HttpObservation {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly request?: unknown;
  readonly status: number;
  readonly responseHeaders: Readonly<Record<string, string>>;
  readonly response: unknown;
}

interface RawResult {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
  readonly text: string;
}

interface DispatchObservation {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

interface EmulatorLike {
  start(): Promise<void>;
  stop(): Promise<void>;
}

const packageRoot = process.env.FIREBASE_TOOLS_15_22_ROOT;
if (!packageRoot) {
  throw new Error(
    "FIREBASE_TOOLS_15_22_ROOT must name the root of firebase-tools 15.22.0",
  );
}
const packageJsonPath = join(packageRoot, "package.json");
const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
  readonly name: string;
  readonly version: string;
};
if (
  packageJson.name !== "firebase-tools" ||
  packageJson.version !== FIREBASE_TOOLS_VERSION
) {
  throw new Error(
    `expected firebase-tools ${FIREBASE_TOOLS_VERSION}, found ${packageJson.name} ${packageJson.version}`,
  );
}

const require = createRequire(packageJsonPath);
const authModulePath = join(packageRoot, "lib/emulator/auth/index.js");
const registryModulePath = join(packageRoot, "lib/emulator/registry.js");
const authModule = require(authModulePath) as {
  readonly AuthEmulator: new (args: {
    readonly host: string;
    readonly port: number;
    readonly projectId: string;
    readonly singleProjectMode: number;
  }) => EmulatorLike;
  readonly SingleProjectMode: Readonly<Record<string, number>>;
};
const registryModule = require(registryModulePath) as {
  readonly EmulatorRegistry: {
    set(name: string, instance: unknown): void;
    clear(name: string): void;
  };
};

const functionsPort = await reserveAvailablePort();
const authPort = await reserveAvailablePort();
const dispatches: DispatchObservation[] = [];
const functionsServer = createServer(handleFunctionDispatch);
const functionsEmulator = {
  getName: () => "functions",
  getInfo: () => ({ name: "functions", host: HOST, port: functionsPort }),
};
let authEmulator: EmulatorLike | undefined;

try {
  await listen(functionsServer, functionsPort);
  registryModule.EmulatorRegistry.set("functions", functionsEmulator);
  authEmulator = new authModule.AuthEmulator({
    host: HOST,
    port: authPort,
    projectId: PROJECT_ID,
    singleProjectMode: authModule.SingleProjectMode.NO_WARNING ?? 0,
  });
  await authEmulator.start();
  await waitForReady(authPort, 30_000);

  const origin = `http://${HOST}:${String(authPort)}`;
  const sourceHashes = await hashOracleSources(packageRoot);
  const core = await captureCoreContract(origin);
  const browser = await captureBrowserContract(origin);
  const triggerStart = dispatches.length;
  const lifecycle = await captureImportExportAndTriggers(origin, triggerStart);

  await writeFixture("auth-identity-toolkit-and-admin", {
    schemaVersion: 1,
    target: "official-firebase-tools-auth-emulator",
    targetVersion: FIREBASE_TOOLS_VERSION,
    targetProject: PROJECT_ID,
    capturedAt: new Date().toISOString(),
    hypothesis:
      "Identity Toolkit client and privileged Admin routes preserve Firebase response, error, custom-claim, custom-token, and unsigned JWT contracts",
    credentialsStored: false,
    accessTokensStored: false,
    realUserDataStored: false,
    sourceHashes,
    observations: core.observations,
    decodedTokenContracts: core.decodedTokenContracts,
  });
  await writeFixture("auth-browser-oauth-and-token-refresh", {
    schemaVersion: 1,
    target: "official-firebase-tools-auth-emulator",
    targetVersion: FIREBASE_TOOLS_VERSION,
    targetProject: PROJECT_ID,
    capturedAt: new Date().toISOString(),
    hypothesis:
      "Browser discovery, fake Google IdP, helper popup/iframe, and secure-token refresh routes expose the contract consumed by the Firebase browser SDK",
    credentialsStored: false,
    accessTokensStored: false,
    realUserDataStored: false,
    sourceHashes,
    observations: browser.observations,
    decodedTokenContracts: browser.decodedTokenContracts,
  });
  await writeFixture("auth-import-export-and-trigger-dispatch", {
    schemaVersion: 1,
    target: "official-firebase-tools-auth-emulator",
    targetVersion: FIREBASE_TOOLS_VERSION,
    targetProject: PROJECT_ID,
    capturedAt: new Date().toISOString(),
    hypothesis:
      "Auth config/accounts import and export preserve persisted fields while user create/delete lifecycle operations multicast legacy Firebase Auth events to Functions",
    credentialsStored: false,
    accessTokensStored: false,
    realUserDataStored: false,
    sourceHashes,
    observations: lifecycle.observations,
    dispatches: normalizeDynamicValue(dispatches.slice(triggerStart)),
    invariants: lifecycle.invariants,
  });
} finally {
  await authEmulator?.stop();
  registryModule.EmulatorRegistry.clear("functions");
  await close(functionsServer);
}

async function captureCoreContract(origin: string): Promise<{
  readonly observations: readonly HttpObservation[];
  readonly decodedTokenContracts: readonly unknown[];
}> {
  const observations: HttpObservation[] = [];
  const decodedTokenContracts: unknown[] = [];
  observations.push(await observe(origin, "readiness", "GET", "/"));

  const signUp = await observe(
    origin,
    "password-sign-up",
    "POST",
    `/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`,
    {
      email: "phase4-auth-oracle@example.com",
      password: "correct-horse",
      displayName: "火🔥 Auth Oracle",
      returnSecureToken: true,
    },
  );
  observations.push(signUp);
  assertStatus(signUp, 200);
  const signUpBody = asRecord(signUp.response);
  const localId = expectString(signUpBody.localId, "signUp.localId");
  const idToken = expectString(signUpBody.idToken, "signUp.idToken");
  const refreshToken = expectString(signUpBody.refreshToken, "signUp.refreshToken");
  decodedTokenContracts.push({ id: "password-sign-up", claims: decodeJwt(idToken) });

  observations.push(
    await observe(
      origin,
      "client-account-lookup",
      "POST",
      `/identitytoolkit.googleapis.com/v1/accounts:lookup?key=${API_KEY}`,
      { idToken },
    ),
  );
  observations.push(
    await observe(
      origin,
      "client-profile-update",
      "POST",
      `/identitytoolkit.googleapis.com/v1/accounts:update?key=${API_KEY}`,
      { idToken, displayName: "更新済み 🔥", returnSecureToken: true },
    ),
  );
  observations.push(
    await observe(
      origin,
      "admin-custom-claims-update",
      "POST",
      `/identitytoolkit.googleapis.com/v1/projects/${PROJECT_ID}/accounts:update`,
      { localId, customAttributes: JSON.stringify({ role: "owner", unicode: "火🔥" }) },
      { authorization: "Bearer owner" },
    ),
  );
  observations.push(
    await observe(
      origin,
      "admin-lookup-by-email",
      "POST",
      `/identitytoolkit.googleapis.com/v1/projects/${PROJECT_ID}/accounts:lookup`,
      { email: ["phase4-auth-oracle@example.com"] },
      { authorization: "Bearer owner" },
    ),
  );
  observations.push(
    await observe(
      origin,
      "admin-query-users",
      "POST",
      `/identitytoolkit.googleapis.com/v1/projects/${PROJECT_ID}/accounts:query`,
      { returnUserInfo: true, sortBy: "USER_ID", order: "ASC" },
      { authorization: "Bearer owner" },
    ),
  );

  const passwordSignIn = await observe(
    origin,
    "password-sign-in",
    "POST",
    `/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`,
    {
      email: "phase4-auth-oracle@example.com",
      password: "correct-horse",
      returnSecureToken: true,
    },
  );
  observations.push(passwordSignIn);
  assertStatus(passwordSignIn, 200);
  decodedTokenContracts.push({
    id: "password-sign-in",
    claims: decodeJwt(expectString(asRecord(passwordSignIn.response).idToken, "password.idToken")),
  });

  const customSignIn = await observe(
    origin,
    "strict-json-custom-token-sign-in",
    "POST",
    `/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${API_KEY}`,
    {
      token: JSON.stringify({ uid: "phase4-custom-user", claims: { tier: "oracle", emoji: "🔥" } }),
      returnSecureToken: true,
    },
  );
  observations.push(customSignIn);
  assertStatus(customSignIn, 200);
  decodedTokenContracts.push({
    id: "custom-token-sign-in",
    claims: decodeJwt(expectString(asRecord(customSignIn.response).idToken, "custom.idToken")),
  });

  const refresh = await observeForm(
    origin,
    "secure-token-refresh",
    "POST",
    `/securetoken.googleapis.com/v1/token?key=${API_KEY}`,
    { grant_type: "refresh_token", refresh_token: refreshToken },
  );
  observations.push(refresh);
  assertStatus(refresh, 200);
  decodedTokenContracts.push({
    id: "secure-token-refresh",
    claims: decodeJwt(expectString(asRecord(refresh.response).id_token, "refresh.id_token")),
  });

  const invalidPassword = await observe(
    origin,
    "wrong-password-error",
    "POST",
    `/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`,
    {
      email: "phase4-auth-oracle@example.com",
      password: "definitely-wrong",
      returnSecureToken: true,
    },
  );
  observations.push(invalidPassword);
  assertStatus(invalidPassword, 400);

  return {
    observations: normalizeObservations(observations),
    decodedTokenContracts: normalizeDynamicValue(decodedTokenContracts) as readonly unknown[],
  };
}

async function captureBrowserContract(origin: string): Promise<{
  readonly observations: readonly HttpObservation[];
  readonly decodedTokenContracts: readonly unknown[];
}> {
  const observations: HttpObservation[] = [];
  const decodedTokenContracts: unknown[] = [];
  observations.push(
    await observe(
      origin,
      "create-auth-uri-existing-password-user",
      "POST",
      `/identitytoolkit.googleapis.com/v1/accounts:createAuthUri?key=${API_KEY}`,
      {
        identifier: "phase4-auth-oracle@example.com",
        continueUri: "http://localhost:5173/auth/callback",
      },
    ),
  );
  observations.push(
    await observe(
      origin,
      "recaptcha-parameters",
      "GET",
      `/identitytoolkit.googleapis.com/v1/recaptchaParams?key=${API_KEY}`,
    ),
  );

  const idpClaims = JSON.stringify({
    sub: "phase4-google-subject",
    email: "phase4-google@example.com",
    email_verified: true,
    name: "Google 火🔥",
    given_name: "Google",
    family_name: "Oracle",
    picture: "https://example.invalid/avatar.png",
  });
  const postBody = new URLSearchParams({
    providerId: "google.com",
    id_token: idpClaims,
  }).toString();
  const idpSignIn = await observe(
    origin,
    "fake-google-idp-sign-in",
    "POST",
    `/identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${API_KEY}`,
    {
      requestUri: "http://localhost:5173/auth/callback",
      postBody,
      returnIdpCredential: true,
      returnSecureToken: true,
    },
  );
  observations.push(idpSignIn);
  assertStatus(idpSignIn, 200);
  const idpBody = asRecord(idpSignIn.response);
  const idpToken = expectString(idpBody.idToken, "idp.idToken");
  const idpRefresh = expectString(idpBody.refreshToken, "idp.refreshToken");
  decodedTokenContracts.push({ id: "fake-google-idp", claims: decodeJwt(idpToken) });

  const refreshed = await observeForm(
    origin,
    "idp-secure-token-refresh",
    "POST",
    `/securetoken.googleapis.com/v1/token?key=${API_KEY}`,
    { grant_type: "refresh_token", refresh_token: idpRefresh },
  );
  observations.push(refreshed);
  assertStatus(refreshed, 200);
  decodedTokenContracts.push({
    id: "idp-refresh",
    claims: decodeJwt(expectString(asRecord(refreshed.response).id_token, "idpRefresh.id_token")),
  });

  observations.push(
    await observeText(
      origin,
      "oauth-popup-handler",
      "GET",
      `/emulator/auth/handler?apiKey=${API_KEY}&providerId=google.com`,
    ),
  );
  observations.push(
    await observeText(
      origin,
      "oauth-helper-iframe",
      "GET",
      `/emulator/auth/iframe?apiKey=${API_KEY}&appName=phase4`,
    ),
  );

  return {
    observations: normalizeObservations(observations),
    decodedTokenContracts: normalizeDynamicValue(decodedTokenContracts) as readonly unknown[],
  };
}

async function captureImportExportAndTriggers(
  origin: string,
  triggerStart: number,
): Promise<{
  readonly observations: readonly HttpObservation[];
  readonly invariants: Readonly<Record<string, unknown>>;
}> {
  const observations: HttpObservation[] = [];
  observations.push(
    await observe(
      origin,
      "emulator-config-before",
      "GET",
      `/emulator/v1/projects/${PROJECT_ID}/config`,
      undefined,
      { authorization: "Bearer owner" },
    ),
  );
  observations.push(
    await observe(
      origin,
      "emulator-config-update",
      "PATCH",
      `/emulator/v1/projects/${PROJECT_ID}/config`,
      {
        signIn: { allowDuplicateEmails: false },
        emailPrivacyConfig: { enableImprovedEmailPrivacy: false },
      },
      { authorization: "Bearer owner" },
    ),
  );

  const beforeImportDispatches = dispatches.length;
  const batchCreate = await observe(
    origin,
    "accounts-json-batch-import",
    "POST",
    `/identitytoolkit.googleapis.com/v1/projects/${PROJECT_ID}/accounts:batchCreate`,
    {
      users: [
        {
          localId: "phase4-import-user-a",
          email: "phase4-import-a@example.com",
          emailVerified: true,
          displayName: "Imported 火",
          customAttributes: JSON.stringify({ imported: true }),
          createdAt: "1700000000000",
          lastLoginAt: "1700000001000",
        },
        {
          localId: "phase4-import-user-b",
          email: "phase4-import-b@example.com",
          emailVerified: false,
          disabled: true,
          createdAt: "1700000002000",
          lastLoginAt: "1700000003000",
        },
      ],
    },
    { authorization: "Bearer owner" },
  );
  observations.push(batchCreate);
  assertStatus(batchCreate, 200);
  await settleDispatches();
  const afterImportDispatches = dispatches.length;

  observations.push(
    await observe(
      origin,
      "accounts-json-batch-export",
      "GET",
      `/identitytoolkit.googleapis.com/v1/projects/${PROJECT_ID}/accounts:batchGet?maxResults=1000`,
      undefined,
      { authorization: "Bearer owner" },
    ),
  );

  const beforeLifecycleDispatches = dispatches.length;
  const adminCreate = await observe(
    origin,
    "admin-create-user",
    "POST",
    `/identitytoolkit.googleapis.com/v1/projects/${PROJECT_ID}/accounts`,
    {
      localId: "phase4-lifecycle-user",
      email: "phase4-lifecycle@example.com",
      emailVerified: true,
      displayName: "Lifecycle 🔥",
    },
    { authorization: "Bearer owner" },
  );
  observations.push(adminCreate);
  assertStatus(adminCreate, 200);
  await waitForDispatchCount(beforeLifecycleDispatches + 1, 10_000);

  const adminDelete = await observe(
    origin,
    "admin-delete-user",
    "POST",
    `/identitytoolkit.googleapis.com/v1/projects/${PROJECT_ID}/accounts:delete`,
    { localId: "phase4-lifecycle-user" },
    { authorization: "Bearer owner" },
  );
  observations.push(adminDelete);
  assertStatus(adminDelete, 200);
  await waitForDispatchCount(beforeLifecycleDispatches + 2, 10_000);

  observations.push(
    await observe(
      origin,
      "emulator-delete-all-accounts",
      "DELETE",
      `/emulator/v1/projects/${PROJECT_ID}/accounts`,
      undefined,
      { authorization: "Bearer owner" },
    ),
  );

  return {
    observations: normalizeObservations(observations),
    invariants: {
      batchImportDispatchCount: afterImportDispatches - beforeImportDispatches,
      lifecycleDispatchCount: dispatches.length - beforeLifecycleDispatches,
      capturedDispatchCount: dispatches.length - triggerStart,
      batchImportTriggersCreateEvents: false,
      lifecycleActions: ["create", "delete"],
      dispatchEndpoint: `/functions/projects/${PROJECT_ID}/trigger_multicast`,
    },
  };
}

async function observe(
  origin: string,
  id: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Readonly<Record<string, string>> = {},
): Promise<HttpObservation> {
  const result = await request(origin, method, path, body, headers);
  return {
    id,
    method,
    path,
    ...(body === undefined ? {} : { request: redactRequest(body) }),
    status: result.status,
    responseHeaders: captureResponseHeaders(result.headers),
    response: result.body,
  };
}

async function observeForm(
  origin: string,
  id: string,
  method: string,
  path: string,
  fields: Readonly<Record<string, string>>,
): Promise<HttpObservation> {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
  const text = await response.text();
  const parsed = parseBody(text);
  return {
    id,
    method,
    path,
    request: redactRequest(fields),
    status: response.status,
    responseHeaders: captureResponseHeaders(response.headers),
    response: parsed,
  };
}

async function observeText(
  origin: string,
  id: string,
  method: string,
  path: string,
): Promise<HttpObservation> {
  const response = await fetch(`${origin}${path}`, { method });
  const text = await response.text();
  return {
    id,
    method,
    path,
    status: response.status,
    responseHeaders: captureResponseHeaders(response.headers),
    response: {
      byteLength: Buffer.byteLength(text),
      sha256: sha256(text),
      contains: [
        "Firebase Auth Emulator",
        "sendAuthEvent",
        "gapi.iframes",
      ].filter((needle) => text.includes(needle)),
    },
  };
}

async function request(
  origin: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Readonly<Record<string, string>> = {},
): Promise<RawResult> {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: parseBody(text),
    text,
  };
}

function handleFunctionDispatch(
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    const text = Buffer.concat(chunks).toString("utf8");
    dispatches.push({
      method: request.method ?? "",
      path: request.url ?? "",
      headers: captureRequestHeaders(request),
      body: parseBody(text),
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"status":"ok"}');
  });
}

function normalizeObservations(
  observations: readonly HttpObservation[],
): readonly HttpObservation[] {
  return normalizeDynamicValue(
    observations.map((observation) => ({
      ...observation,
      response: sanitizeTokens(observation.response),
    })),
  ) as readonly HttpObservation[];
}

function sanitizeTokens(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeTokens);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (["idToken", "id_token", "access_token", "sessionCookie"].includes(key)) {
      output[key] = typeof child === "string"
        ? { redacted: "emulator-jwt", claims: normalizeDynamicValue(decodeJwt(child)) }
        : child;
    } else if (["refreshToken", "refresh_token"].includes(key)) {
      output[key] = "<emulator-refresh-token>";
    } else if (["passwordHash", "salt"].includes(key)) {
      output[key] = `<${key}>`;
    } else {
      output[key] = sanitizeTokens(child);
    }
  }
  return output;
}

function normalizeDynamicValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeDynamicValue);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (
      [
        "eventId",
        "sessionId",
        "oobCode",
        "sessionInfo",
        "mfaEnrollmentId",
      ].includes(key) && typeof child === "string"
    ) {
      output[key] = `<generated-${key}>`;
    } else if (
      ["timestamp", "creationTime", "lastSignInTime", "enrolledAt"].includes(key) &&
      typeof child === "string"
    ) {
      output[key] = `<generated-${key}>`;
    } else if (
      [
        "createdAt",
        "lastLoginAt",
        "lastRefreshAt",
        "passwordUpdatedAt",
        "validSince",
        "iat",
        "exp",
        "auth_time",
      ].includes(key) && (typeof child === "string" || typeof child === "number")
    ) {
      output[key] =
        typeof child === "string" && /^170000000[0-9]{4}$/u.test(child)
          ? child
          : `<generated-${key}>`;
    } else if (key === "localId" && typeof child === "string" && child.length === 28) {
      output[key] = "<generated-localId>";
    } else if (key === "sub" && typeof child === "string" && child.length === 28) {
      output[key] = "<generated-localId>";
    } else if (key === "user_id" && typeof child === "string" && child.length === 28) {
      output[key] = "<generated-localId>";
    } else if (key === "host" && typeof child === "string" && child.startsWith(`${HOST}:`)) {
      output[key] = "<functions-emulator-host>";
    } else {
      output[key] = normalizeDynamicValue(child);
    }
  }
  return output;
}

function redactRequest(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactRequest);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (["idToken", "token"].includes(key)) {
      output[key] = "<emulator-token-redacted>";
    } else if (["refreshToken", "refresh_token"].includes(key)) {
      output[key] = "<emulator-refresh-token-redacted>";
    } else if (key === "password") {
      output[key] = "<synthetic-password-redacted>";
    } else {
      output[key] = redactRequest(child);
    }
  }
  return output;
}

function decodeJwt(token: string): unknown {
  const segments = token.split(".");
  if (segments.length < 2 || !segments[1]) {
    throw new Error("expected JWT token");
  }
  return JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
}

function parseBody(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function captureRequestHeaders(
  request: IncomingMessage,
): Readonly<Record<string, string>> {
  const captured: Record<string, string> = {};
  for (const name of ["content-type", "content-length", "host"]) {
    const value = request.headers[name];
    if (typeof value === "string") captured[name] = value;
  }
  return captured;
}

function captureResponseHeaders(headers: Headers): Readonly<Record<string, string>> {
  const captured: Record<string, string> = {};
  for (const name of [
    "content-type",
    "location",
    "access-control-allow-origin",
    "access-control-allow-credentials",
  ]) {
    const value = headers.get(name);
    if (value !== null) captured[name] = value;
  }
  return captured;
}

async function hashOracleSources(
  root: string,
): Promise<Readonly<Record<string, string>>> {
  const files = [
    "package.json",
    "lib/emulator/auth/apiSpec.js",
    "lib/emulator/auth/cloudFunctions.js",
    "lib/emulator/auth/handlers.js",
    "lib/emulator/auth/operations.js",
    "lib/emulator/auth/server.js",
    "lib/emulator/auth/state.js",
  ];
  const hashes: Record<string, string> = {};
  for (const file of files) {
    hashes[file] = sha256(await readFile(join(root, file)));
  }
  return hashes;
}

async function writeFixture(name: string, fixture: unknown): Promise<void> {
  const root = join(fixtureBase, name);
  await mkdir(root, { recursive: true });
  const fixtureText = `${JSON.stringify(fixture, null, 2)}\n`;
  const decodedContract = decodeFixtureContract(name, fixture);
  const contractText = `${JSON.stringify(decodedContract, null, 2)}\n`;
  await writeFile(join(root, "fixture.json"), fixtureText, "utf8");
  await writeFile(join(root, "decoded-contract.json"), contractText, "utf8");
  await writeFile(
    join(root, "SHA256SUMS"),
    `${sha256(fixtureText)}  fixture.json\n${sha256(contractText)}  decoded-contract.json\n`,
    "utf8",
  );
}

function decodeFixtureContract(name: string, fixture: unknown): unknown {
  const record = asRecord(fixture);
  const observations = record.observations as readonly HttpObservation[];
  return {
    schemaVersion: 1,
    fixtureSet: name,
    target: record.target,
    targetVersion: record.targetVersion,
    operationCount: observations.length,
    operations: observations.map(({ id, method, path, status, responseHeaders }) => ({
      id,
      method,
      path,
      status,
      responseContentType: responseHeaders["content-type"],
    })),
    ...(record.invariants === undefined ? {} : { invariants: record.invariants }),
  };
}

function assertStatus(observation: HttpObservation, expected: number): void {
  if (observation.status !== expected) {
    throw new Error(
      `${observation.id} returned ${String(observation.status)}: ${JSON.stringify(observation.response)}`,
    );
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected object, found ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  return value;
}

async function waitForReady(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://${HOST}:${String(port)}/`);
      if (response.status === 200) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`Auth emulator did not become ready: ${String(lastError)}`);
}

async function waitForDispatchCount(
  expected: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (dispatches.length >= expected) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error(
    `expected ${String(expected)} function dispatches, observed ${String(dispatches.length)}`,
  );
}

async function settleDispatches(): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
}

async function reserveAvailablePort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, HOST, () => resolvePromise());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("failed to reserve a TCP port");
  }
  const port = address.port;
  await new Promise<void>((resolvePromise, reject) =>
    server.close((error) => (error ? reject(error) : resolvePromise())),
  );
  return port;
}

async function listen(
  server: ReturnType<typeof createServer>,
  port: number,
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => resolvePromise());
  });
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolvePromise, reject) =>
    server.close((error) => (error ? reject(error) : resolvePromise())),
  );
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
