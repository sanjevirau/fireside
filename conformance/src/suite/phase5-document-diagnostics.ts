import { createHash } from "node:crypto";

interface SnapshotLike {
  readonly readTime?: unknown;
  readonly ref?: { readonly path?: unknown };
  readonly updateTime?: unknown;
}

interface SnapshotConstructorLike {
  readonly prototype: SnapshotLike & { data?: unknown };
}

export interface Phase5DocumentSnapshotObservation {
  readonly canonicalSha256: string;
  readonly documentPath: string;
  readonly exactJson: string;
  readonly readTime: string | null;
  readonly updateTime: string | null;
  readonly value: unknown;
}

function canonicalJson(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(Object.entries(input).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0).map(([key, field]) => [key, sort(field)]));
    }
    return input;
  };
  return JSON.stringify(sort(value));
}

function timestampText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object" && "toDate" in value && typeof value.toDate === "function") {
    const date = value.toDate.call(value) as unknown;
    if (date instanceof Date) return date.toISOString();
  }
  return String(value);
}

export function phase5DocumentSnapshotObservation(
  snapshot: SnapshotLike,
  value: unknown,
): Phase5DocumentSnapshotObservation | null {
  const documentPath = snapshot.ref?.path;
  if (typeof documentPath !== "string" || !/^presentations\/[^/]+$/u.test(documentPath) ||
      value === undefined) return null;
  const exactJson = JSON.stringify(value);
  return {
    canonicalSha256: createHash("sha256").update(canonicalJson(value)).digest("hex"),
    documentPath,
    exactJson,
    readTime: timestampText(snapshot.readTime),
    updateTime: timestampText(snapshot.updateTime),
    value,
  };
}

export function installPhase5DocumentSnapshotDiagnostics(
  enabled: boolean,
  constructors: readonly SnapshotConstructorLike[],
  observe: (observation: Phase5DocumentSnapshotObservation) => void,
): () => void {
  if (!enabled) return () => undefined;
  const restorers: (() => void)[] = [];
  const seen = new Set<object>();
  for (const constructor of constructors) {
    const prototype = constructor.prototype;
    if (seen.has(prototype)) continue;
    seen.add(prototype);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "data");
    if (descriptor === undefined || typeof descriptor.value !== "function") continue;
    const original = descriptor.value as (this: SnapshotLike, ...args: unknown[]) => unknown;
    Object.defineProperty(prototype, "data", {
      ...descriptor,
      value: function diagnosticData(this: SnapshotLike, ...args: unknown[]): unknown {
        const value = original.apply(this, args);
        try {
          const observation = phase5DocumentSnapshotObservation(this, value);
          if (observation !== null) observe(observation);
        } catch {
          // A read-only observer must never change the protected journey.
        }
        return value;
      },
    });
    restorers.push(() => Object.defineProperty(prototype, "data", descriptor));
  }
  return () => { for (const restore of restorers.reverse()) restore(); };
}
