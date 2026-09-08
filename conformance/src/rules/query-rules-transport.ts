import assert from "node:assert/strict";
import type * as protos from "../../node_modules/@google-cloud/firestore/types/protos/firestore_v1_proto_api.js";
import { createV1Firestore } from "../target.ts";
import { emulatorJwtWindow } from "./emulator-jwt.ts";
import { queryRulesProject, queryRulesUid, type Filter, type QueryRuleCase } from "./query-rules-cases.ts";

export const database = `projects/${queryRulesProject}/databases/(default)`;
export type RawClient = ReturnType<typeof createV1Firestore>;
type StructuredQuery = protos.google.firestore.v1.IStructuredQuery;
export type Observation = { id: string; transport: string; operation: string; code: number; documents: string[]; count?: string; error?: string; responses: unknown[]; checkpoints?: string[][] };
export function clientFor(origin: string): RawClient {
  return createV1Firestore({ name: "java", projectId: queryRulesProject, host: new URL(origin).host });
}
export function userToken(unverified = false): string {
  const { authTime, issuedAt, expiresAt } = emulatorJwtWindow();
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({ aud: queryRulesProject, iss: `https://securetoken.google.com/${queryRulesProject}`, sub: queryRulesUid, user_id: queryRulesUid, email_verified: !unverified, auth_time: authTime, iat: issuedAt, exp: expiresAt, firebase: { sign_in_provider: "custom" } })}.`;
}
export function structuredQuery(testCase: QueryRuleCase): StructuredQuery {
  return {
    from: [{ collectionId: testCase.collection, allDescendants: testCase.group ?? false }],
    ...(testCase.filter ? { where: encodeFilter(testCase.filter) } : {}),
    ...(testCase.limit === undefined ? {} : { limit: { value: testCase.limit } }),
    ...(testCase.offset === undefined ? {} : { offset: testCase.offset }),
    orderBy: (testCase.orderBy ?? []).map(([fieldPath, direction]) => ({ field: { fieldPath }, direction: direction === "asc" ? "ASCENDING" : "DESCENDING" })),
  };
}
export function parentFor(testCase: QueryRuleCase): string {
  return `${database}/documents${testCase.parent ? `/${testCase.parent}` : ""}`;
}
function encodeFilter(filter: Filter): protos.google.firestore.v1.StructuredQuery.IFilter {
  if ("filters" in filter) return { compositeFilter: { op: filter.op, filters: filter.filters.map(encodeFilter) } };
  const operators = { "==": "EQUAL", "!=": "NOT_EQUAL", ">": "GREATER_THAN", ">=": "GREATER_THAN_OR_EQUAL", "<": "LESS_THAN", "<=": "LESS_THAN_OR_EQUAL", in: "IN", "not-in": "NOT_IN", "array-contains": "ARRAY_CONTAINS", "array-contains-any": "ARRAY_CONTAINS_ANY" } as const;
  const op = operators[filter.op as keyof typeof operators];
  assert.ok(op);
  if (filter.value === null && (op === "EQUAL" || op === "NOT_EQUAL")) return { unaryFilter: { field: { fieldPath: filter.field }, op: op === "EQUAL" ? "IS_NULL" : "IS_NOT_NULL" } };
  return { fieldFilter: { field: { fieldPath: filter.field }, op, value: encodeValue(filter.value) } };
}
export function encodeValue(value: unknown): protos.google.firestore.v1.IValue {
  if (value === null) return { nullValue: "NULL_VALUE" };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "number") return { integerValue: String(value) };
  if (typeof value === "boolean") return { booleanValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeValue) } };
  if (typeof value === "object") return { mapValue: { fields: encodeFields(value as Record<string, unknown>) } };
  throw new Error(`unsupported fixture value ${String(value)}`);
}
export function encodeFields(fields: Record<string, unknown>): Record<string, protos.google.firestore.v1.IValue> {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, encodeValue(value)]));
}
export async function seedDocument(client: RawClient, path: string, fields: Record<string, unknown>): Promise<void> {
  await client.commit({ database, writes: [{ update: { name: `${database}/documents/${path}`, fields: encodeFields(fields) } }] }, { otherArgs: { headers: { authorization: "Bearer owner" } } });
}
export async function grpcList(client: RawClient, testCase: QueryRuleCase): Promise<Observation> {
  const observation: Observation = { id: testCase.id, transport: "grpc", operation: "ListDocuments", code: 0, documents: [], responses: [] };
  try {
    const [documents] = await client.listDocuments({ parent: parentFor(testCase), collectionId: testCase.collection, pageSize: 12 }, { autoPaginate: false, retry: null, timeout: 10_000, otherArgs: { headers: { authorization: `Bearer ${userToken()}` } } });
    observation.documents = documents.map((document) => document.name ?? "");
    observation.responses.push(...JSON.parse(JSON.stringify(documents)) as unknown[]);
  } catch (error) {
    const failure = error as { code: number; details?: string; message: string };
    observation.code = failure.code; observation.error = failure.details ?? failure.message;
  }
  return observation;
}
export async function grpcQuery(client: RawClient, testCase: QueryRuleCase, aggregation: boolean): Promise<Observation> {
  const request = { parent: parentFor(testCase), structuredQuery: structuredQuery(testCase) };
  const options = { timeout: 10_000, retry: null, retryRequestOptions: { retries: 0, noResponseRetries: 0 }, otherArgs: { headers: { authorization: `Bearer ${userToken(testCase.unverified)}` } } };
  const stream = aggregation
    ? client.runAggregationQuery({ parent: request.parent, structuredAggregationQuery: { structuredQuery: request.structuredQuery, aggregations: [{ alias: "total", count: {} }] } }, options)
    : client.runQuery(request, options);
  const observation: Observation = { id: testCase.id, transport: "grpc", operation: aggregation ? "RunAggregationQuery" : "RunQuery", code: 0, documents: [], responses: [] };
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { stream.cancel(); reject(new Error(`RPC timeout: ${testCase.id}`)); }, 15_000);
    stream.on("data", (response: protos.google.firestore.v1.IRunQueryResponse & protos.google.firestore.v1.IRunAggregationQueryResponse) => {
      observation.responses.push(JSON.parse(JSON.stringify(response)));
      if (response.document?.name) observation.documents.push(response.document.name);
      if (response.result?.aggregateFields?.total?.integerValue !== undefined) observation.count = String(response.result.aggregateFields.total.integerValue);
    });
    stream.on("error", (error: { code: number; details?: string; message: string }) => {
      clearTimeout(timer); observation.code = error.code; observation.error = error.details ?? error.message; resolve(observation);
    });
    stream.on("end", () => { clearTimeout(timer); resolve(observation); });
  });
}

export async function grpcListen(client: RawClient, testCase: QueryRuleCase, mutate?: (stage: "update" | "leave") => Promise<void>): Promise<Observation> {
  const stream = client.listen({ otherArgs: { headers: { authorization: `Bearer ${userToken(testCase.unverified)}`, "google-cloud-resource-prefix": database } } });
  const observation: Observation = { id: testCase.id, transport: "grpc", operation: mutate ? "ListenChanges" : "Listen", code: 0, documents: [], responses: [] };
  return await new Promise((resolve, reject) => {
    let finished = false;
    let mutated = false;
    let leaving = false;
    let current = false;
    const liveDocuments = new Set<string>();
    const timer = setTimeout(() => { observation.code = -1; observation.error = `capture Listen timeout: ${testCase.id}`; finish(); resolve(observation); }, 15_000);
    function finish(): void { finished = true; clearTimeout(timer); stream.end(); stream.cancel(); }
    stream.on("error", (error: { code: number; details?: string; message: string }) => {
      if (finished) return;
      observation.code = error.code; observation.error = error.details ?? error.message; finish(); resolve(observation);
    });
    stream.on("data", (response: protos.google.firestore.v1.IListenResponse) => {
      if (finished) return;
      observation.responses.push(JSON.parse(JSON.stringify(response)));
      if (response.documentChange?.document?.name) observation.documents.push(response.documentChange.document.name);
      const change = response.targetChange;
      if (change?.targetChangeType === "RESET" || Number(change?.targetChangeType) === 4) liveDocuments.clear();
      if (response.documentChange?.document?.name) {
        if (response.documentChange.targetIds?.includes(2)) liveDocuments.add(response.documentChange.document.name);
        if (response.documentChange.removedTargetIds?.includes(2)) liveDocuments.delete(response.documentChange.document.name);
      }
      const removed = response.documentRemove?.document ?? response.documentDelete?.document;
      if (removed) liveDocuments.delete(removed);
      if (change?.cause) { observation.code = change.cause.code ?? -1; observation.error = change.cause.message ?? ""; finish(); resolve(observation); return; }
      const checkpoint = change?.targetChangeType === "CURRENT" || Number(change?.targetChangeType) === 3;
      if (checkpoint) {
        current = true;
        (observation.checkpoints ??= []).push([...liveDocuments].sort());
      }
      if (!current) return;
      if (!mutate) { finish(); resolve(observation); return; }
      if (!mutated) {
        mutated = true;
        void mutate("update").catch((error: unknown) => { finish(); reject(error); });
      } else if (!leaving && response.documentChange?.document?.fields?.updatedAt?.integerValue?.toString() === "3") {
        leaving = true;
        void mutate("leave").catch((error: unknown) => { finish(); reject(error); });
      } else if ((checkpoint && liveDocuments.size === 0) || removed || response.documentChange?.removedTargetIds?.includes(2)) {
        finish(); resolve(observation);
      }
    });
    stream.write({ database, addTarget: { targetId: 2, query: { parent: parentFor(testCase), structuredQuery: structuredQuery(testCase) } } });
  });
}
