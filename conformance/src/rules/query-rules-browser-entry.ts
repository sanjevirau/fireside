import { initializeApp, deleteApp } from "firebase/app";
import {
  collection, collectionGroup, connectFirestoreEmulator, initializeFirestore,
  query, where, and, or, limit, orderBy, getDocsFromServer, getCountFromServer,
  onSnapshot, terminate, type QueryNonFilterConstraint, type QueryFilterConstraint,
  type QuerySnapshot, type WhereFilterOp,
} from "firebase/firestore";
import { queryRulesProject, queryRulesUid, type Filter, type QueryRuleCase } from "./query-rules-cases.ts";

function condition(filter: Filter): QueryFilterConstraint {
  if ("filters" in filter) return (filter.op === "AND" ? and : or)(...filter.filters.map(condition));
  return where(filter.field, filter.op as WhereFilterOp, filter.value);
}
function snapshot(value: QuerySnapshot): unknown {
  return { documents: value.docs.map((document) => `projects/${queryRulesProject}/databases/(default)/documents/${document.ref.path}`), changes: value.docChanges().map((change) => ({ type: change.type, path: change.doc.ref.path, data: change.doc.data() })) };
}
export async function observe(host: string, variant: string, testCase: QueryRuleCase, operation: "Listen" | "RunAggregationQuery", mutationUrl?: string): Promise<unknown> {
  const app = initializeApp({ projectId: queryRulesProject, apiKey: "synthetic-query-key" }, `${testCase.id}-${variant}-${operation}`);
  const db = initializeFirestore(app, { experimentalForceLongPolling: variant === "long-poll", experimentalAutoDetectLongPolling: false });
  const [hostname, port] = host.split(":");
  connectFirestoreEmulator(db, hostname!, Number(port), { mockUserToken: { sub: queryRulesUid, user_id: queryRulesUid, email_verified: !testCase.unverified, firebase: { sign_in_provider: "custom", identities: {} } } });
  const constraints: QueryNonFilterConstraint[] = [];
  if (testCase.limit !== undefined) constraints.push(limit(testCase.limit));
  for (const [name, direction] of testCase.orderBy ?? []) constraints.push(orderBy(name, direction));
  const base = testCase.group ? collectionGroup(db, testCase.collection) : collection(db, `${testCase.parent ? `${testCase.parent}/` : ""}${testCase.collection}`);
  const target = testCase.filter ? query(base, and(condition(testCase.filter)), ...constraints) : query(base, ...constraints);
  try {
    if (operation === "RunAggregationQuery") return { code: 0, count: String((await getCountFromServer(target)).data().count) };
    if (!mutationUrl) return { code: 0, ...snapshot(await getDocsFromServer(target)) as object };
    const snapshots: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { unsubscribe(); reject(new Error("browser ListenChanges timeout")); }, 15_000);
      const unsubscribe = onSnapshot(target, (value) => {
        if (value.metadata.fromCache) return;
        snapshots.push(snapshot(value));
        if (snapshots.length === 1 || value.docChanges().some((change) => change.type === "modified")) {
          const stage = snapshots.length === 1 ? "update" : "leave";
          void fetch(`${mutationUrl}?stage=${stage}`, { method: "POST" }).then((response) => { if (!response.ok) throw new Error(`mutation HTTP ${response.status}`); }).catch((error: unknown) => { clearTimeout(timer); unsubscribe(); reject(error); });
        } else if (value.docChanges().some((change) => change.type === "removed")) {
          clearTimeout(timer); unsubscribe(); resolve();
        }
      }, (error) => { clearTimeout(timer); unsubscribe(); reject(error); });
    });
    return { code: 0, snapshots };
  } catch (error) {
    const failure = error as { code?: string; message: string };
    return { code: failure.code ?? "capture-error", error: failure.message };
  } finally {
    await terminate(db);
    await deleteApp(app);
  }
}
