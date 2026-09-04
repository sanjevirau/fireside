import { createHash } from "node:crypto";

import { canonicalJson } from "../serialization/cases.ts";

export const PHASE5_GENERATED_CACHE_BUCKET = "assets-local.twodart.com";
export const PHASE5_GENERATED_CACHE_NAME = "cache/main-cache-local.json";

export interface Phase5GeneratedCacheMeasurement {
  readonly decodedBytes: number;
  readonly normalizedSha256: string;
  readonly physicalBytes: number;
}

interface JsonRecord {
  [key: string]: unknown;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isPhase5GeneratedCacheObject(bucket: string, name: string): boolean {
  return bucket === PHASE5_GENERATED_CACHE_BUCKET && name === PHASE5_GENERATED_CACHE_NAME;
}

export function phase5GeneratedCacheMetadataSize(value: unknown): number | null {
  if (
    !isRecord(value) ||
    value.bucket !== PHASE5_GENERATED_CACHE_BUCKET ||
    value.name !== PHASE5_GENERATED_CACHE_NAME
  ) {
    return null;
  }
  const size = Number(value.size);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error("Frozen Phase 5 generated cache size is invalid");
  }
  return size;
}

export function normalizePhase5GeneratedCache(value: unknown): unknown {
  const normalized = structuredClone(value);
  if (!isRecord(normalized)) throw new Error("Phase 5 generated cache must be a JSON object");

  if (isRecord(normalized.metadata)) delete normalized.metadata.buildTimestamp;
  const data = normalized.data;
  if (!isRecord(data)) return normalized;
  const general = data.general;
  if (!isRecord(general) || !Array.isArray(general.slideThemeData)) return normalized;
  for (const theme of general.slideThemeData) {
    if (!isRecord(theme) || typeof theme.chunkedJsonLink !== "string") continue;
    theme.chunkedJsonLink = theme.chunkedJsonLink.replace(
      /http:\/\/127\.0\.0\.1:\d+(?=\/)/u,
      "http://127.0.0.1:<storage-port>",
    );
  }
  return normalized;
}

export function measurePhase5GeneratedCache(
  decodedBody: Uint8Array,
  physicalBytes: number,
): Phase5GeneratedCacheMeasurement {
  if (!Number.isSafeInteger(physicalBytes) || physicalBytes < 0) {
    throw new Error("Phase 5 generated cache physical byte count is invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(decodedBody).toString("utf8")) as unknown;
  } catch (error: unknown) {
    throw new Error("Phase 5 generated cache did not decode as JSON", { cause: error });
  }
  const normalized = canonicalJson(normalizePhase5GeneratedCache(parsed));
  return {
    decodedBytes: decodedBody.byteLength,
    normalizedSha256: createHash("sha256").update(normalized).digest("hex"),
    physicalBytes,
  };
}

export function assertPhase5GeneratedCacheParity(
  left: Phase5GeneratedCacheMeasurement | null,
  right: Phase5GeneratedCacheMeasurement | null,
  label: string,
): void {
  if (
    left === null ||
    right === null ||
    left.normalizedSha256 !== right.normalizedSha256
  ) {
    throw new Error(
      `Phase 5 ${label} generated cache logical values diverged: ${JSON.stringify({ left, right })}`,
    );
  }
}
