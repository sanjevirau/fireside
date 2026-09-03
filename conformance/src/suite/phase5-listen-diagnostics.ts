import { createHash } from "node:crypto";

type JsonRecord = Record<string, unknown>;

function object(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord : {};
}

function nameHash(value: unknown): string | null {
  return typeof value === "string"
    ? createHash("sha256").update(value).digest("hex") : null;
}

function filterShape(value: unknown): unknown {
  const filter = object(value);
  if (filter.compositeFilter !== undefined) {
    const composite = object(filter.compositeFilter);
    return { op: composite.op, filters: Array.isArray(composite.filters) ? composite.filters.map(filterShape) : [] };
  }
  const field = object(filter.fieldFilter ?? filter.unaryFilter);
  return { field: object(field.field).fieldPath, op: field.op, valueTypes: Object.keys(object(field.value)) };
}

// Observations only. Never retain headers= (credentials), query values, resume
// tokens, document contents, or raw user-bearing document names.
export function phase5ListenRequestSummary(body: string): unknown {
  const form = new URLSearchParams(body);
  return {
    count: form.get("count"), ofs: form.get("ofs"),
    maps: [...form].filter(([key]) => /^req\d+___data__$/u.test(key)).map(([key, value]) => {
      const message = object(JSON.parse(value));
      const target = object(message.addTarget);
      const query = object(target.query);
      const structured = object(query.structuredQuery);
      const documents = object(target.documents).documents;
      return {
        map: key, targetId: target.targetId, removeTarget: message.removeTarget,
        parentHash: nameHash(query.parent),
        documentHashes: Array.isArray(documents) ? documents.map(nameHash) : undefined,
        from: structured.from,
        filter: structured.where === undefined ? undefined : filterShape(structured.where),
        orderBy: structured.orderBy, limit: structured.limit, offset: structured.offset,
        resumeTokenPresent: target.resumeToken !== undefined,
        expectedCount: target.expectedCount,
      };
    }),
  };
}

function messageSummary(value: unknown): unknown {
  if (Array.isArray(value)) return typeof value[0] === "string"
    ? { control: value[0] } : { messages: value.map(messageSummary) };
  const message = object(value);
  if (message.targetChange !== undefined) {
    const change = object(message.targetChange);
    return { targetChange: {
      type: change.targetChangeType, targetIds: change.targetIds,
      cause: change.cause === undefined ? undefined : { code: object(change.cause).code, message: object(change.cause).message }, readTime: change.readTime,
      resumeTokenPresent: change.resumeToken !== undefined,
    } };
  }
  if (message.documentChange !== undefined) {
    const change = object(message.documentChange);
    const document = object(change.document);
    return { documentChange: {
      documentHash: nameHash(document.name), targetIds: change.targetIds,
      removedTargetIds: change.removedTargetIds,
      fieldTypes: Object.fromEntries(Object.entries(object(document.fields))
        .map(([field, value]) => [field, Object.keys(object(value))])),
    } };
  }
  for (const kind of ["documentDelete", "documentRemove"]) {
    if (message[kind] !== undefined) {
      const change = object(message[kind]);
      return { [kind]: { documentHash: nameHash(change.document), removedTargetIds: change.removedTargetIds } };
    }
  }
  if (message.filter !== undefined) {
    const filter = object(message.filter);
    return { filter: { targetId: filter.targetId, count: filter.count } };
  }
  return { unknownMessageKeys: Object.keys(message) };
}

export function phase5ListenResponseSummary(body: string): unknown {
  if (body.startsWith("[")) {
    const ack: unknown = JSON.parse(body);
    if (!Array.isArray(ack) || ack.length !== 3 || !ack.every(value => typeof value === "number" && Number.isFinite(value))) {
      throw new Error("Listen diagnostic: invalid forward acknowledgement");
    }
    return { forwardAck: ack };
  }
  const arrays: unknown[] = [];
  let remaining = body;
  while (remaining.length > 0) {
    const newline = remaining.indexOf("\n");
    const prefix = remaining.slice(0, newline);
    if (newline < 0 || !/^\d+$/u.test(prefix)) throw new Error("Listen diagnostic: invalid frame length prefix");
    const length = Number(prefix);
    remaining = remaining.slice(newline + 1);
    if (!Number.isSafeInteger(length) || length > remaining.length) throw new Error("Listen diagnostic: incomplete UTF-16 frame");
    const frame: unknown = JSON.parse(remaining.slice(0, length));
    remaining = remaining.slice(length);
    if (!Array.isArray(frame)) throw new Error("Listen diagnostic: frame is not an array");
    if (frame.length === 3 && frame.every(value => typeof value === "number" && Number.isFinite(value))) {
      arrays.push({ forwardAck: frame });
      continue;
    }
    for (const array of frame) {
      if (!Array.isArray(array)) throw new Error("Listen diagnostic: array entry is malformed");
      arrays.push({ arrayId: array[0], message: messageSummary(array[1]) });
    }
  }
  return { arrays };
}

export function phase5SmokeDomEvidence(smoke: boolean, text: string): string | null {
  // The full-data dataset may contain private deck content. Never record its
  // complete DOM. The smoke uses only the existing synthetic application seed.
  return smoke ? text : null;
}
