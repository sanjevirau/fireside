import { queryRuleCases, queryRuleSeeds, queryRulesSource, queryRulesUid, type QueryRuleCase } from "./query-rules-cases.ts";

// R27: a collection wildcard is not a concrete document path. These are
// hypotheses for official capture; the inputs do not encode expected verdicts.
const collections = ["members", "getMembers", "functionMembers", "reversedMembers", "unknownOnly", "negatedAnd", "literalOr", "concreteErrorOr", "concreteErrorAnd", "budgetErrorOr"];
export const queryPathCases: QueryRuleCase[] = [
  ...queryRuleCases.filter(value => ["owner-equality", "owner-absent", "owner-empty-unconstrained", "get-fixed-path", "limit-allowed"].includes(value.id)),
  ...collections.flatMap(collection => ["granted", "denied", "missing"].map(parent => ({
    id: `path-${collection}-${parent}`, collection, parent: `queryParents/${parent}`,
  }))),
  { id: "path-members-empty-granted", collection: "members", parent: "queryParents/emptyGranted" },
  { id: "path-members-filtered-denied", collection: "members", parent: "queryParents/denied", filter: { field: "uid", op: "==", value: queryRulesUid } },
];

const pathRules = `
    match /queryParents/{parentId} {
      function parentOwner() { return get(/databases/$(database)/documents/queryParents/$(parentId)).data.uid == request.auth.uid; }
      function absent(id) { return !exists(/databases/$(database)/documents/queryParents/$(parentId)/functionMembers/$(id)); }
      match /members/{memberId} {
        allow read: if !exists(/databases/$(database)/documents/queryParents/$(parentId)/members/$(memberId)) || parentOwner();
      }
      match /getMembers/{memberId} {
        allow read: if get(/databases/$(database)/documents/queryParents/$(parentId)/getMembers/$(memberId)).data.uid == request.auth.uid || parentOwner();
      }
      match /functionMembers/{memberId} { allow read: if absent(memberId) || parentOwner(); }
      match /reversedMembers/{memberId} {
        allow read: if parentOwner() || !exists(/databases/$(database)/documents/queryParents/$(parentId)/reversedMembers/$(memberId));
      }
      match /unknownOnly/{memberId} { allow read: if !exists(/databases/$(database)/documents/queryParents/$(parentId)/unknownOnly/$(memberId)); }
      match /negatedAnd/{memberId} { allow read: if !(exists(/databases/$(database)/documents/queryParents/$(parentId)/negatedAnd/$(memberId)) && false); }
      match /literalOr/{memberId} { allow read: if exists(/databases/$(database)/documents/queryParents/$(parentId)/literalOr/$(memberId)) || true; }
      match /concreteErrorOr/{memberId} { allow read: if get(/databases/$(database)/documents/queryParents/missing).data.uid == request.auth.uid || true; }
      match /concreteErrorAnd/{memberId} { allow read: if !(get(/databases/$(database)/documents/queryParents/missing).data.uid == request.auth.uid && false); }
      match /budgetErrorOr/{memberId} { allow read: if (${Array.from({ length: 11 }, (_, i) => `exists(/databases/$(database)/documents/queryBudget/p${i})`).join(" && ")}) || true; }
    }
`;
const closing = queryRulesSource.lastIndexOf("  }\n}");
if (closing < 0) throw new Error("query rules source outer match not found");
export const queryPathRulesSource = queryRulesSource.slice(0, closing) + pathRules + queryRulesSource.slice(closing);
export const queryPathSeeds: [string, Record<string, unknown>][] = [
  ...queryRuleSeeds,
  ...Array.from({ length: 11 }, (_, i): [string, Record<string, unknown>] => [`queryBudget/p${i}`, { exists: true }]),
  ["queryParents/granted", { uid: queryRulesUid }],
  ["queryParents/emptyGranted", { uid: queryRulesUid }],
  ["queryParents/denied", { uid: "other-owner" }],
  ...collections.flatMap(collection => ["granted", "denied", "missing"].flatMap(parent => [
    [`queryParents/${parent}/${collection}/owned`, { uid: queryRulesUid, updatedAt: 1 }] as [string, Record<string, unknown>],
    [`queryParents/${parent}/${collection}/other`, { uid: "other-owner", updatedAt: 2 }] as [string, Record<string, unknown>],
  ])),
];
