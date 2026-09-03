import assert from "node:assert/strict";

export const refreshProject = "demo-fireside-auth-refresh";
export const refreshPath = "/securetoken.googleapis.com/v1/token?key=synthetic-api-key";
const clientPrefix = "/identitytoolkit.googleapis.com/v1/accounts:";
const adminPrefix = `/identitytoolkit.googleapis.com/v1/projects/${refreshProject}/accounts`;

export interface RefreshObservation {
  id: string;
  status: number;
  contentType: string;
  bodyKeys: string[];
  error?: string;
  sameRefreshToken?: boolean;
  accessTokenEqualsIdToken?: boolean;
  userMatches?: boolean;
  expiresIn?: string;
  tokenType?: string;
  projectId?: string;
  claims?: Record<string, unknown>;
}

export function customRefreshToken(uid: string): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({ uid, aud: "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit", iss: "synthetic@example.invalid", sub: "synthetic@example.invalid", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, claims: { role: "owner", unicode: "火🔥" } })}.`;
}

export function observeRefresh(id: string, status: number, headers: Headers, body: Record<string, any>, inputToken: string, uid?: string): RefreshObservation {
  const result: RefreshObservation = {
    id, status, contentType: (headers.get("content-type") ?? "").toLowerCase(),
    bodyKeys: Object.keys(body).sort(),
  };
  if (status !== 200) return { ...result, error: String(body.error?.message) };
  const claims = JSON.parse(Buffer.from(String(body.id_token).split(".")[1]!, "base64url").toString("utf8")) as Record<string, any>;
  return {
    ...result,
    sameRefreshToken: body.refresh_token === inputToken,
    accessTokenEqualsIdToken: body.access_token === body.id_token,
    userMatches: body.user_id === claims.sub && claims.user_id === claims.sub && (uid === undefined || body.user_id === uid),
    expiresIn: body.expires_in, tokenType: body.token_type, projectId: body.project_id,
    claims: {
      aud: claims.aud, iss: claims.iss, provider: claims.firebase?.sign_in_provider,
      lifetimeSeconds: claims.exp - claims.iat,
      authenticationNotInFuture: claims.auth_time <= claims.iat,
      ...(claims.role === undefined ? {} : { role: claims.role }),
      ...(claims.unicode === undefined ? {} : { unicode: claims.unicode }),
    },
  };
}

export async function captureRefreshContract(origin: string): Promise<RefreshObservation[]> {
  const observations: RefreshObservation[] = [];
  async function json(path: string, value: unknown): Promise<Record<string, any>> {
    const response = await fetch(origin + path, {
      method: "POST", headers: { "content-type": "application/json", ...(path.startsWith(adminPrefix) ? { authorization: "Bearer owner" } : {}) },
      body: JSON.stringify(value), signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json() as Record<string, any>;
    assert.equal(response.status, 200, `${path}: ${JSON.stringify(body)}`);
    return body;
  }
  async function refresh(id: string, token: string, uid?: string): Promise<RefreshObservation> {
    const response = await fetch(origin + refreshPath, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token }),
      signal: AbortSignal.timeout(10_000),
    });
    return observeRefresh(id, response.status, response.headers, await response.json() as Record<string, any>, token, uid);
  }
  for (const provider of ["anonymous", "password", "custom"] as const) {
    const signIn = provider === "custom"
      ? await json(clientPrefix + "signInWithCustomToken?key=synthetic-api-key", { token: customRefreshToken("refresh-custom-user"), returnSecureToken: true })
      : await json(clientPrefix + "signUp?key=synthetic-api-key", {
        returnSecureToken: true,
        ...(provider === "password" ? { email: "refresh-password@example.invalid", password: "Synthetic-password-123" } : {}),
      });
    const token = String(signIn.refreshToken);
    // Custom-token responses need not contain localId: use the signed-in JWT.
    const uid = String(JSON.parse(Buffer.from(String(signIn.idToken).split(".")[1]!, "base64url").toString()).sub);
    observations.push(await refresh(`${provider}-first`, token, uid));
    observations.push(await refresh(`${provider}-repeat-original`, token, uid));
    observations.push(...await Promise.all(Array.from({ length: 4 }, (_, index) => refresh(`${provider}-concurrent-${index + 1}`, token, uid))));
    await json(adminPrefix + ":update", { localId: uid, disableUser: true });
    observations.push(await refresh(`${provider}-disabled`, token, uid));
    await json(adminPrefix + ":update", { localId: uid, disableUser: false });
    observations.push(await refresh(`${provider}-reenabled-original`, token, uid));
    await json(adminPrefix + ":delete", { localId: uid });
    observations.push(await refresh(`${provider}-deleted`, token, uid));
  }
  observations.push(await refresh("unknown-token", "not-an-emulator-refresh-token"));
  return observations;
}

// Header spelling/charset is recorded verbatim, but is not an Auth credential
// contract: both peers must return JSON, not identical HTTP framework headers.
export function semanticRefresh(observations: RefreshObservation[]): unknown {
  return observations.map(({ contentType, ...observation }) => {
    assert.match(contentType, /^application\/json(?:;|$)/u);
    return observation;
  });
}
