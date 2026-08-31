import { deleteApp, initializeApp } from "firebase/app";
import {
  collection,
  deleteDoc,
  doc,
  initializeFirestore,
  onSnapshot,
  query,
  setDoc,
  terminate,
  waitForPendingWrites,
  where,
  type DocumentData,
  type DocumentReference,
  type Query,
  type QuerySnapshot,
} from "firebase/firestore";

type TransportVariant =
  | "buffering-proxy-auto-detection"
  | "long-polling"
  | "streaming";

interface BrowserDemoConfiguration {
  readonly host: string;
  readonly projectId: string;
  readonly runId: string;
  readonly variant: TransportVariant;
}

interface BrowserDemoResult {
  readonly initialDocuments: readonly string[];
  readonly listenerDeliveryMilliseconds: readonly number[];
  readonly liveDocuments: readonly string[];
  readonly observedUnicode: string;
  readonly projectId: string;
  readonly runId: string;
  readonly variant: TransportVariant;
}

declare global {
  interface Window {
    firesideRunWebChannelDemo(
      configuration: BrowserDemoConfiguration,
    ): Promise<BrowserDemoResult>;
  }
}

const COLLECTION = "fireside_phase2_browser_demo";
const LISTENER_DELIVERY_SAMPLES = 100;
const TIMEOUT_MILLISECONDS = 20_000;

window.firesideRunWebChannelDemo = async (
  configuration,
): Promise<BrowserDemoResult> => {
  const app = initializeApp(
    {
      apiKey: "fireside-synthetic-emulator-key",
      appId: "1:123456789:web:fireside-phase2-browser-demo",
      projectId: configuration.projectId,
    },
    `phase2-${configuration.variant}-${configuration.runId}`,
  );
  const firestore = initializeFirestore(app, {
    experimentalAutoDetectLongPolling:
      configuration.variant === "buffering-proxy-auto-detection",
    experimentalForceLongPolling: configuration.variant === "long-polling",
    host: configuration.host,
    ssl: false,
  });
  const first = doc(firestore, COLLECTION, `${configuration.runId}-first`);
  const second = doc(firestore, COLLECTION, `${configuration.runId}-second`);
  const matchingQuery = query(
    collection(firestore, COLLECTION),
    where("runId", "==", configuration.runId),
  );
  let querySubscription: SnapshotSubscription<readonly DemoDocument[]> | undefined;
  let documentSubscription: SnapshotSubscription<DemoDocument | undefined> | undefined;

  try {
    await Promise.all([
      setDoc(first, demoDocument(configuration.runId, "first", 1)),
      setDoc(second, demoDocument(configuration.runId, "second", 1)),
    ]);
    await waitForPendingWrites(firestore);

    querySubscription = subscribeToQuery(matchingQuery);
    documentSubscription = subscribeToDocument(second);
    const initialQuery = await querySubscription.next(
      (documents) => documents.length === 2 && documents.every((value) => value.sequence === 1),
    );
    await documentSubscription.next((value) => value?.sequence === 1);

    await Promise.all([
      setDoc(first, demoDocument(configuration.runId, "first", 2)),
      setDoc(second, demoDocument(configuration.runId, "second", 2)),
    ]);
    await waitForPendingWrites(firestore);
    const liveQuery = await querySubscription.next(
      (documents) => documents.length === 2 && documents.every((value) => value.sequence === 2),
    );
    const liveDocument = await documentSubscription.next(
      (value) => value?.sequence === 2,
    );

    const listenerDeliveryMilliseconds: number[] = [];
    for (let index = 0; index < LISTENER_DELIVERY_SAMPLES; index += 1) {
      const sequence = index + 3;
      const startedAt = performance.now();
      await setDoc(second, demoDocument(configuration.runId, "second", sequence));
      await waitForPendingWrites(firestore);
      await documentSubscription.next((value) => value?.sequence === sequence);
      listenerDeliveryMilliseconds.push(performance.now() - startedAt);
    }

    querySubscription.unsubscribe();
    querySubscription = undefined;
    documentSubscription.unsubscribe();
    documentSubscription = undefined;
    await Promise.all([deleteDoc(first), deleteDoc(second)]);
    await waitForPendingWrites(firestore);

    return {
      initialDocuments: initialQuery.map((value) => value.name).sort(),
      listenerDeliveryMilliseconds,
      liveDocuments: liveQuery.map((value) => value.name).sort(),
      observedUnicode: liveDocument?.unicode ?? "",
      projectId: configuration.projectId,
      runId: configuration.runId,
      variant: configuration.variant,
    };
  } finally {
    querySubscription?.unsubscribe();
    documentSubscription?.unsubscribe();
    await terminate(firestore);
    await deleteApp(app);
    await delay(250);
  }
};

interface DemoDocument {
  readonly name: string;
  readonly runId: string;
  readonly sequence: number;
  readonly unicode: string;
}

interface SnapshotSubscription<T> {
  next(predicate: (value: T) => boolean): Promise<T>;
  unsubscribe(): void;
}

function demoDocument(runId: string, name: string, sequence: number): DemoDocument {
  return {
    name,
    runId,
    sequence,
    unicode: `東京/emoji-😀/é/${name}/${String(sequence)}`,
  };
}

function subscribeToQuery(reference: Query<DocumentData>): SnapshotSubscription<readonly DemoDocument[]> {
  return createSubscription<readonly DemoDocument[]>((publish, fail) =>
    onSnapshot(
      reference,
      { includeMetadataChanges: true },
      (snapshot) => {
        if (!snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites) {
          publish(queryDocuments(snapshot));
        }
      },
      fail,
    )
  );
}

function subscribeToDocument(
  reference: DocumentReference<DocumentData>,
): SnapshotSubscription<DemoDocument | undefined> {
  return createSubscription<DemoDocument | undefined>((publish, fail) =>
    onSnapshot(
      reference,
      { includeMetadataChanges: true },
      (snapshot) => {
        if (!snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites) {
          publish(snapshot.exists() ? snapshot.data() as DemoDocument : undefined);
        }
      },
      fail,
    )
  );
}

function queryDocuments(snapshot: QuerySnapshot<DocumentData>): readonly DemoDocument[] {
  return snapshot.docs.map((snapshotDocument) => snapshotDocument.data() as DemoDocument);
}

function createSubscription<T>(
  start: (
    publish: (value: T) => void,
    fail: (error: Error) => void,
  ) => () => void,
): SnapshotSubscription<T> {
  const buffered: T[] = [];
  const waiting: Array<{
    readonly predicate: (value: T) => boolean;
    readonly resolve: (value: T) => void;
    readonly reject: (error: Error) => void;
    readonly timeout: number;
  }> = [];
  let terminalError: Error | undefined;
  const unsubscribe = start(
    (value) => {
      const index = waiting.findIndex(({ predicate }) => predicate(value));
      if (index < 0) {
        buffered.push(value);
        return;
      }
      const [match] = waiting.splice(index, 1);
      if (match !== undefined) {
        window.clearTimeout(match.timeout);
        match.resolve(value);
      }
    },
    (error) => {
      terminalError = error;
      for (const waiter of waiting.splice(0)) {
        window.clearTimeout(waiter.timeout);
        waiter.reject(error);
      }
    },
  );

  return {
    next(predicate): Promise<T> {
      if (terminalError !== undefined) {
        return Promise.reject(terminalError);
      }
      const index = buffered.findIndex(predicate);
      if (index >= 0) {
        const [value] = buffered.splice(index, 1);
        return Promise.resolve(value as T);
      }
      return new Promise<T>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          const waiterIndex = waiting.findIndex((candidate) => candidate.resolve === resolve);
          if (waiterIndex >= 0) {
            waiting.splice(waiterIndex, 1);
          }
          reject(new Error("browser demo listener timed out"));
        }, TIMEOUT_MILLISECONDS);
        waiting.push({ predicate, reject, resolve, timeout });
      });
    },
    unsubscribe,
  };
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
}
