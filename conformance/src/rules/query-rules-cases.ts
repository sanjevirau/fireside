/** Synthetic potential-result-set probes; no verdicts are assumed before capture. */
export const queryRulesProject = "demo-fireside-query-rules";
export const queryRulesUid = "query-owner";
export type Scalar = string | number | boolean | null;
export type Filter = { field: string; op: string; value: Scalar | Scalar[] } | { op: "AND" | "OR"; filters: Filter[] };
export interface QueryRuleCase {
  id: string;
  collection: string;
  filter?: Filter;
  limit?: number;
  offset?: number;
  orderBy?: [string, "asc" | "desc"][];
  group?: boolean;
  parent?: string;
  unverified?: boolean;
}
const eq = (field: string, value: Scalar): Filter => ({ field, op: "==", value });
const field = (name: string, op: string, value: Scalar | Scalar[]): Filter => ({ field: name, op, value });
const and = (...filters: Filter[]): Filter => ({ op: "AND", filters });
const or = (...filters: Filter[]): Filter => ({ op: "OR", filters });
const owner = eq("createdBy", queryRulesUid);
export const queryRuleCases: QueryRuleCase[] = [
  { id: "owner-equality", collection: "presentations", filter: owner, orderBy: [["updatedAt", "desc"]], limit: 12 },
  { id: "owner-absent", collection: "presentations" },
  { id: "owner-wrong-uid", collection: "presentations", filter: eq("createdBy", "other-owner") },
  { id: "owner-unverified", collection: "presentations", filter: owner, unverified: true },
  { id: "owner-in-single", collection: "presentations", filter: field("createdBy", "in", [queryRulesUid]) },
  { id: "owner-in-mixed", collection: "presentations", filter: field("createdBy", "in", [queryRulesUid, "other-owner"]) },
  { id: "owner-array-is-not-equality", collection: "presentations", filter: field("createdBy", "array-contains", queryRulesUid) },
  { id: "owner-inequality", collection: "presentations", filter: field("createdBy", ">=", queryRulesUid) },
  { id: "owner-bounded-equality", collection: "presentations", filter: and(field("createdBy", ">=", queryRulesUid), field("createdBy", "<=", queryRulesUid)) },
  { id: "owner-compound-and", collection: "presentations", filter: and(owner, eq("published", false)) },
  { id: "owner-compound-or-safe", collection: "presentations", filter: or(and(owner, eq("published", false)), and(owner, eq("published", true))) },
  { id: "owner-compound-or-unsafe", collection: "presentations", filter: or(owner, eq("published", true)) },
  { id: "owner-empty", collection: "emptyPresentations", filter: owner },
  { id: "owner-empty-unconstrained", collection: "emptyPresentations" },
  { id: "owner-empty-wrong-uid", collection: "emptyPresentations", filter: eq("createdBy", "other-owner") },
  { id: "owner-nonmatching-extra-filter", collection: "presentations", filter: and(owner, eq("updatedAt", -1)) },
  { id: "license-get-allowed", collection: "presentations", filter: eq("licenseId", "granted") },
  { id: "license-get-denied", collection: "presentations", filter: eq("licenseId", "denied") },
  { id: "license-get-missing", collection: "presentations", filter: eq("licenseId", "missing") },
  { id: "license-in-all-granted", collection: "presentations", filter: field("licenseId", "in", ["granted", "granted2"]) },
  { id: "license-in-mixed", collection: "presentations", filter: field("licenseId", "in", ["granted", "denied"]) },
  { id: "short-circuit-missing-get", collection: "shortCircuit", filter: owner },
  { id: "array-contains-owner", collection: "shared", filter: field("members", "array-contains", queryRulesUid) },
  { id: "array-contains-other", collection: "shared", filter: field("members", "array-contains", "other-owner") },
  { id: "array-any-owner", collection: "shared", filter: field("members", "array-contains-any", [queryRulesUid]) },
  { id: "array-any-mixed", collection: "shared", filter: field("members", "array-contains-any", [queryRulesUid, "other-owner"]) },
  { id: "array-absent", collection: "shared" },
  { id: "range-equality-inside", collection: "ratings", filter: eq("score", 5) },
  { id: "range-strict-bound", collection: "ratings", filter: field("score", ">", 5) },
  { id: "range-inclusive-bound", collection: "ratings", filter: field("score", ">=", 5) },
  { id: "range-unsafe-inclusive", collection: "ratings", filter: field("score", ">=", 4) },
  { id: "range-safe-in", collection: "ratings", filter: field("score", "in", [5, 7]) },
  { id: "range-unsafe-in", collection: "ratings", filter: field("score", "in", [4, 7]) },
  { id: "range-absent", collection: "ratings" },
  { id: "not-equal-null", collection: "nonnull", filter: field("value", "!=", null) },
  { id: "not-equal-string", collection: "notblocked", filter: field("value", "!=", "blocked") },
  { id: "not-in-blocked", collection: "notblocked", filter: field("value", "not-in", ["blocked", "also-blocked"]) },
  { id: "limit-allowed", collection: "limited", limit: 12 },
  { id: "limit-denied", collection: "limited", limit: 13 },
  { id: "limit-absent", collection: "limited" },
  { id: "offset-allowed", collection: "offsets", offset: 2 },
  { id: "offset-denied", collection: "offsets", offset: 3 },
  { id: "offset-default", collection: "offsets" },
  { id: "order-desc", collection: "ordering", orderBy: [["updatedAt", "desc"]] },
  { id: "order-asc", collection: "ordering", orderBy: [["updatedAt", "asc"]] },
  { id: "order-absent", collection: "ordering" },
  { id: "get-fixed-path", collection: "fixedGet" },
  { id: "exists-fixed-path", collection: "fixedExists" },
  { id: "exists-constrained-path", collection: "dynamicExists", filter: eq("licenseId", "granted") },
  { id: "exists-missing-path", collection: "dynamicExists", filter: eq("licenseId", "missing") },
  { id: "exists-unconstrained-path", collection: "dynamicExists" },
  { id: "group-recursive-owner", collection: "groupDocs", group: true, filter: owner },
  { id: "group-recursive-unconstrained", collection: "groupDocs", group: true },
  { id: "group-recursive-empty-owner", collection: "emptyGroup", group: true, filter: owner },
  { id: "group-root-only-rule", collection: "presentations", group: true, filter: owner },
  { id: "nested-collection-owner", collection: "groupDocs", parent: "parents/p1", filter: owner },
];

export const queryRulesSource = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function verified() { return request.auth != null && request.auth.token.email_verified == true; }
    function owner() { return request.auth.uid == resource.data.createdBy; }
    function licenseAccess(id) { return get(/databases/$(database)/documents/licenses/$(id)).data.uid == request.auth.uid; }
    function presentationRead() { return verified() && (owner() || (resource.data.licenseId != null && licenseAccess(resource.data.licenseId))); }
    match /presentations/{id} { allow read: if presentationRead(); }
    match /emptyPresentations/{id} { allow read: if presentationRead(); }
    match /shortCircuit/{id} { allow list: if owner() || get(/databases/$(database)/documents/licenses/missing).data.uid == request.auth.uid; }
    match /shared/{id} { allow list: if request.auth.uid in resource.data.members; }
    match /ratings/{id} { allow list: if resource.data.score > 4; }
    match /nonnull/{id} { allow list: if resource.data.value != null; }
    match /notblocked/{id} { allow list: if resource.data.value != 'blocked'; }
    match /limited/{id} { allow list: if request.query.limit <= 12; }
    match /offsets/{id} { allow list: if request.query.offset <= 2; }
    match /ordering/{id} { allow list: if request.query.orderBy.updatedAt == 'DESC'; }
    match /fixedGet/{id} { allow list: if get(/databases/$(database)/documents/licenses/granted).data.uid == request.auth.uid; }
    match /fixedExists/{id} { allow list: if exists(/databases/$(database)/documents/licenses/granted); }
    match /dynamicExists/{id} { allow list: if exists(/databases/$(database)/documents/licenses/$(resource.data.licenseId)); }
    match /{prefix=**}/groupDocs/{id} { allow list: if owner(); }
    match /{prefix=**}/emptyGroup/{id} { allow list: if owner(); }
  }
}
`;

export const queryRuleSeeds: [string, Record<string, unknown>][] = [
  ["licenses/granted", { uid: queryRulesUid }],
  ["licenses/granted2", { uid: queryRulesUid }],
  ["licenses/denied", { uid: "other-owner" }],
  ...["presentations", "shortCircuit", "shared", "ratings", "nonnull", "notblocked", "limited", "offsets", "ordering", "fixedGet", "fixedExists", "dynamicExists", "groupDocs", "parents/p1/groupDocs"].flatMap((collection): [string, Record<string, unknown>][] => [
    [`${collection}/owned`, { createdBy: queryRulesUid, updatedAt: 2, licenseId: "denied", published: false, members: [queryRulesUid], score: 7, value: "safe" }],
    [`${collection}/other`, { createdBy: "other-owner", updatedAt: 1, licenseId: "granted", published: true, members: ["other-owner"], score: 4, value: "blocked" }],
  ]),
];
