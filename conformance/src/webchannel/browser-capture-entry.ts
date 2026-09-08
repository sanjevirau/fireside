import { deleteApp, initializeApp } from "firebase/app";
import {
  collection,
  count,
  deleteDoc,
  doc,
  documentId,
  FieldPath,
  getAggregateFromServer,
  getCountFromServer,
  getDoc,
  getDocs,
  initializeFirestore,
  loadBundle,
  namedQuery,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  setDoc,
  sum,
  terminate,
  updateDoc,
  waitForPendingWrites,
  where,
  writeBatch,
} from "firebase/firestore";

type CaptureScenario =
  | "aggregation-count"
  | "aggregation-composite-filter"
  | "aggregation-limit-error"
  | "bundle-nanosecond-read-time"
  | "listen"
  | "multiple-inequality-query"
  | "numeric-resource-id-ordering"
  | "reconnect-replay"
  | "reserved-resource-id-error"
  | "transaction-commit"
  | "transaction-noop-write"
  | "unicode-framing"
  | "unknown-sid"
  | "write"
  | "write-batch-six"
  | "write-cross-client-update"
  | "write-missing-update-error"
  | "write-overlap";

type TransportVariant = "long-poll" | "streaming";

interface BrowserCaptureConfiguration {
  readonly accessToken?: string;
  readonly apiKey: string;
  readonly host: string;
  readonly projectId: string;
  readonly scenario: CaptureScenario;
  readonly variant: TransportVariant;
}

interface BrowserCaptureResult {
  readonly scenario: CaptureScenario;
  readonly variant: TransportVariant;
  readonly observations: readonly unknown[];
}

declare global {
  interface Window {
    firesideRunWebChannelCapture(
      configuration: BrowserCaptureConfiguration,
    ): Promise<BrowserCaptureResult>;
  }
}

const COLLECTION = "fireside_webchannel_capture";
const DOCUMENT = "oracle";
const BUNDLE_COLLECTION = "fireside_webchannel_bundle_capture";

window.firesideRunWebChannelCapture = async (
  configuration,
): Promise<BrowserCaptureResult> => {
  if (configuration.scenario === "unknown-sid") {
    return await captureUnknownSession(configuration);
  }

  const app = initializeApp(
    {
      apiKey: configuration.apiKey,
      appId: "1:123456789:web:fireside-webchannel-capture",
      projectId: configuration.projectId,
    },
    `capture-${configuration.scenario}-${configuration.variant}-${crypto.randomUUID()}`,
  );
  const settings = {
    experimentalAutoDetectLongPolling: false,
    experimentalForceLongPolling: configuration.variant === "long-poll",
    host: configuration.host,
    ssl: false,
    ...(configuration.accessToken === undefined
      ? {}
      : { credentials: oauthCredentials(configuration.accessToken) }),
  } as Parameters<typeof initializeFirestore>[1];
  const firestore = initializeFirestore(app, settings);
  const reference = doc(firestore, COLLECTION, DOCUMENT);
  const observations: unknown[] = [];

  try {
    switch (configuration.scenario) {
      case "aggregation-count":
        observations.push(
          (await getCountFromServer(collection(firestore, COLLECTION))).data(),
        );
        break;
      case "aggregation-composite-filter":
        try {
          observations.push(
            (await getAggregateFromServer(
              query(
                collection(firestore, COLLECTION),
                where("synthetic", "==", true),
                where("sequence", "==", 1),
              ),
              { aggregate_count: count(), aggregate_sum: sum("sequence") },
            )).data(),
          );
        } catch (error) {
          observations.push(observeError(error));
        }
        break;
      case "aggregation-limit-error":
        try {
          await getAggregateFromServer(collection(firestore, COLLECTION), {
            aggregate_0: count(),
            aggregate_1: count(),
            aggregate_2: count(),
            aggregate_3: count(),
            aggregate_4: count(),
            aggregate_5: count(),
          });
          throw new Error("six aggregations unexpectedly succeeded");
        } catch (error) {
          observations.push(observeError(error));
        }
        break;
      case "bundle-nanosecond-read-time":
        await Promise.all([
          setDoc(doc(firestore, BUNDLE_COLLECTION, "oracle-first"), {
            bar: 0,
            key: "first",
          }),
          setDoc(doc(firestore, BUNDLE_COLLECTION, "oracle-second"), {
            bar: 0,
            key: "second",
          }),
        ]);
        await loadBundle(
          firestore,
          nanosecondReadTimeBundle(configuration.projectId),
        );
        {
          const bundledQuery = await namedQuery(
            firestore,
            "nanosecond-read-time-limit",
          );
          if (bundledQuery === null) {
            throw new Error("loaded bundle did not expose its named query");
          }
          observations.push(
            (await getDocs(bundledQuery)).docs.map((snapshot) => ({
              data: snapshot.data(),
              id: snapshot.id,
            })),
          );
        }
        break;
      case "transaction-commit":
        try {
          await runTransaction(firestore, async (transaction) => {
            await transaction.get(reference);
            transaction.delete(reference);
            transaction.update(reference, { sequence: 3 });
          });
          throw new Error("delete followed by update unexpectedly succeeded");
        } catch (error) {
          observations.push(observeError(error));
        }
        await runTransaction(firestore, async (transaction) => {
          await transaction.get(reference);
        });
        await runTransaction(firestore, async (transaction) => {
          transaction.set(reference, {
            desc: "Description",
            "is.admin": false,
            owner: { name: "Jonny" },
          });
          transaction.update(
            reference,
            "owner.name",
            "Sebastian",
            new FieldPath("is.admin"),
            true,
          );
        });
        observations.push((await getDoc(reference)).data());
        break;
      case "transaction-noop-write":
        await runTransaction(firestore, async (transaction) => {
          observations.push((await transaction.get(reference)).data());
        });
        await runTransaction(firestore, async (transaction) => {
          transaction.set(reference, {
            capture: "transaction-noop-write",
            sequence: 1,
            synthetic: true,
          });
        });
        await runTransaction(firestore, async (transaction) => {
          observations.push((await transaction.get(reference)).data());
        });
        break;
      case "listen":
      case "reconnect-replay":
        observations.push(await observeOneSnapshot(reference));
        break;
      case "multiple-inequality-query":
        {
          const queryCollection = collection(
            firestore,
            "fireside_webchannel_capture_query",
          );
          observations.push(
            (await getDocs(query(queryCollection, where("sort", "<=", 2))))
              .docs.map((snapshot) => snapshot.id),
          );
          try {
            observations.push(
              (await getDocs(query(
                queryCollection,
                where("key", "!=", "a"),
                where("sort", "<=", 2),
              ))).docs.map((snapshot) => snapshot.id),
            );
          } catch (error) {
            observations.push(observeError(error));
          }
          for (const invalidQuery of [
            query(
              queryCollection,
              where("key", "!=", 42),
              orderBy(documentId()),
            ),
            query(
              queryCollection,
              where("key", "!=", 42),
              where(documentId(), "==", "doc1"),
            ),
          ]) {
            try {
              await getDocs(invalidQuery);
              throw new Error("invalid multiple-inequality query unexpectedly succeeded");
            } catch (error) {
              observations.push(observeError(error));
            }
          }
        }
        break;
      case "numeric-resource-id-ordering":
        {
          const numericIdCollection = collection(
            firestore,
            "fireside_webchannel_capture_numeric_ids",
          );
          const numericIds = [
            "__id-9223372036854775808__",
            "__id-2__",
            "__id7__",
            "__id9223372036854775807__",
          ] as const;
          try {
            for (const identifier of numericIds) {
              await setDoc(doc(numericIdCollection, identifier), {
                identifier,
                synthetic: true,
              });
            }
            await setDoc(doc(numericIdCollection, "plain"), {
              identifier: "plain",
              synthetic: true,
            });
            observations.push(
              (await getDocs(query(numericIdCollection, orderBy(documentId()))))
                .docs.map((snapshot) => snapshot.id),
            );
          } finally {
            await Promise.allSettled(
              [...numericIds, "plain"].map((identifier) =>
                deleteDoc(doc(numericIdCollection, identifier))
              ),
            );
          }
        }
        break;
      case "reserved-resource-id-error":
        try {
          await getDocs(collection(firestore, "a/__badpath__/b"));
          throw new Error("reserved resource id query unexpectedly succeeded");
        } catch (error) {
          observations.push(observeError(error));
        }
        break;
      case "unicode-framing":
        {
          const observation = observeOneSnapshot(reference);
          await setDoc(reference, {
            combining: "é",
            emoji: "😀🧪",
            mixed: "東京/emoji-😀/café-é",
            nested: { "路-😀": "值-火🔥" },
            text: "東京火事場",
          });
          await waitForPendingWrites(firestore);
          observations.push(await observation);
        }
        break;
      case "write":
        await setDoc(reference, {
          capture: "write",
          sequence: 1,
          synthetic: true,
        });
        await waitForPendingWrites(firestore);
        observations.push("write-acknowledged");
        break;
      case "write-batch-six":
        {
          const batch = writeBatch(firestore);
          for (let index = 0; index < 6; index += 1) {
            batch.set(doc(firestore, COLLECTION, `oracle-batch-${String(index)}`), {
              capture: "write-batch-six",
              sequence: index,
              synthetic: true,
            });
          }
          await batch.commit();
          await waitForPendingWrites(firestore);
          observations.push("six-write-batch-acknowledged");
        }
        break;
      case "write-cross-client-update":
        {
          const readerApp = initializeApp(
            {
              apiKey: configuration.apiKey,
              appId: "1:123456789:web:fireside-webchannel-capture-reader",
              projectId: configuration.projectId,
            },
            `capture-reader-${configuration.variant}-${crypto.randomUUID()}`,
          );
          const reader = initializeFirestore(readerApp, settings);
          const writerReference = doc(
            firestore,
            COLLECTION,
            "oracle-cross-client",
          );
          const readerReference = doc(
            reader,
            COLLECTION,
            "oracle-cross-client",
          );
          try {
            await setDoc(writerReference, { a: "a" });
            await updateDoc(readerReference, { b: "b" });
            observations.push({
              reader: (await getDoc(readerReference)).data(),
              writer: (await getDoc(writerReference)).data(),
            });
          } finally {
            await terminate(reader);
            await deleteApp(readerApp);
          }
        }
        break;
      case "write-missing-update-error":
        try {
          await updateDoc(
            doc(firestore, COLLECTION, "oracle-missing-update"),
            { b: "b" },
          );
          throw new Error("missing-document update unexpectedly succeeded");
        } catch (error) {
          observations.push(observeError(error));
        }
        break;
      case "write-overlap":
        await Promise.all([
          setDoc(doc(firestore, COLLECTION, "oracle-first"), {
            capture: "write-overlap",
            sequence: 1,
            synthetic: true,
          }),
          setDoc(doc(firestore, COLLECTION, "oracle-second"), {
            capture: "write-overlap",
            sequence: 2,
            synthetic: true,
          }),
        ]);
        await waitForPendingWrites(firestore);
        observations.push("overlapping-writes-acknowledged");
        break;
      default:
        configuration.scenario satisfies never;
    }
  } finally {
    await terminate(firestore);
    await deleteApp(app);
    await delay(250);
  }

  return {
    scenario: configuration.scenario,
    variant: configuration.variant,
    observations,
  };
};

function nanosecondReadTimeBundle(projectId: string): string {
  const database = `projects/${projectId}/databases/(default)`;
  const metadata = {
    metadata: {
      createTime: { nanos: 9999, seconds: 1001 },
      id: "fireside-nanosecond-read-time",
      totalBytes: 0,
      totalDocuments: 2,
      version: 1,
    },
  };
  const elements = [
    {
      namedQuery: {
        bundledQuery: {
          limitType: "FIRST",
          parent: `${database}/documents`,
          structuredQuery: {
            from: [{ collectionId: BUNDLE_COLLECTION }],
            limit: { value: 1 },
            orderBy: [
              { direction: "DESCENDING", field: { fieldPath: "bar" } },
              { direction: "DESCENDING", field: { fieldPath: "__name__" } },
            ],
          },
        },
        name: "nanosecond-read-time-limit",
        readTime: { nanos: 9999, seconds: 1000 },
      },
    },
    ...(["oracle-first", "oracle-second"] as const).flatMap((document, index) => [
      {
        documentMetadata: {
          exists: true,
          name: `${database}/documents/${BUNDLE_COLLECTION}/${document}`,
          readTime: { nanos: 9999, seconds: 1000 },
        },
      },
      {
        document: {
          createTime: { nanos: 9, seconds: 1 },
          fields: {
            bar: { integerValue: index + 1 },
            key: { stringValue: index === 0 ? "first" : "second" },
          },
          name: `${database}/documents/${BUNDLE_COLLECTION}/${document}`,
          updateTime: { nanos: 9, seconds: 1 },
        },
      },
    ]),
  ];
  const encoder = new TextEncoder();
  const encodedElements = elements.map((element) => JSON.stringify(element));
  const bundleBody = encodedElements
    .map((element) => `${String(encoder.encode(element).byteLength)}${element}`)
    .join("");
  metadata.metadata.totalBytes = encoder.encode(bundleBody).byteLength;
  const encodedMetadata = JSON.stringify(metadata);
  return `${String(encoder.encode(encodedMetadata).byteLength)}${encodedMetadata}${bundleBody}`;
}

function observeError(error: unknown): { code?: string; message: string } {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
  return {
    ...(code === undefined ? {} : { code }),
    message: error instanceof Error ? error.message : String(error),
  };
}

async function captureUnknownSession(
  configuration: BrowserCaptureConfiguration,
): Promise<BrowserCaptureResult> {
  const database = `projects/${configuration.projectId}/databases/(default)`;
  const query = new URLSearchParams({
    AID: "0",
    CI: configuration.variant === "long-poll" ? "1" : "0",
    RID: "rpc",
    SID: "fireside-synthetic-unknown-sid",
    TYPE: "xmlhttp",
    VER: "8",
    database,
    t: "1",
    zx: "fireside-synthetic-nonce",
  });
  const response = await fetch(
    `http://${configuration.host}/google.firestore.v1.Firestore/Listen/channel?${query.toString()}`,
  );
  const body = await response.text();

  return {
    scenario: configuration.scenario,
    variant: configuration.variant,
    observations: [{ body, status: response.status }],
  };
}

async function observeOneSnapshot(
  reference: ReturnType<typeof doc>,
): Promise<unknown> {
  return await new Promise<unknown>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      unsubscribe();
      reject(new Error("listener did not produce a server snapshot within 20 seconds"));
    }, 20_000);
    const unsubscribe = onSnapshot(
      reference,
      { includeMetadataChanges: true },
      (snapshot) => {
        if (snapshot.exists() && !snapshot.metadata.hasPendingWrites) {
          window.clearTimeout(timeout);
          unsubscribe();
          resolve(snapshot.data());
        }
      },
      (error) => {
        window.clearTimeout(timeout);
        unsubscribe();
        reject(error);
      },
    );
  });
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
}

function oauthCredentials(accessToken: string): unknown {
  const user = {
    uid: "google-credentials-uid",
    isAuthenticated: () => true,
    isEqual: (other: { readonly uid?: string | null }) =>
      other.uid === "google-credentials-uid",
    toKey: () => "uid:google-credentials-uid",
  };
  return {
    client: {
      getToken: async () => ({
        headers: new Map([["Authorization", `Bearer ${accessToken}`]]),
        type: "OAuth",
        user,
      }),
      invalidateToken: () => undefined,
      shutdown: () => undefined,
      start: (
        asyncQueue: { enqueueRetryable(operation: () => Promise<void>): void },
        listener: (nextUser: typeof user) => Promise<void>,
      ) => asyncQueue.enqueueRetryable(async () => await listener(user)),
    },
    type: "provider",
  };
}
