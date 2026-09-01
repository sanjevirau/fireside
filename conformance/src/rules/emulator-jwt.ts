const CLOCK_SKEW_SECONDS = 30;
const TOKEN_TTL_SECONDS = 86_400;

export interface EmulatorJwtWindow {
  readonly authTime: number;
  readonly expiresAt: number;
  readonly issuedAt: number;
}

/**
 * Return a currently valid window for unsigned JWTs accepted only by local
 * Firebase-compatible emulators. Captures freeze claim semantics, not expired
 * wall-clock timestamps, and never persist the resulting authorization value.
 */
export function emulatorJwtWindow(nowMilliseconds = Date.now()): EmulatorJwtWindow {
  const issuedAt = Math.floor(nowMilliseconds / 1_000) - CLOCK_SKEW_SECONDS;
  return {
    authTime: issuedAt,
    expiresAt: issuedAt + TOKEN_TTL_SECONDS,
    issuedAt,
  };
}
