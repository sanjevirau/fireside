import { deleteApp, initializeApp } from "firebase/app";
import {
  doc,
  initializeFirestore,
  onSnapshot,
  setDoc,
  terminate,
  waitForPendingWrites,
} from "firebase/firestore";

type CaptureScenario =
  | "listen"
  | "reconnect-replay"
  | "unicode-framing"
  | "unknown-sid"
  | "write"
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
      case "listen":
      case "reconnect-replay":
        observations.push(await observeOneSnapshot(reference));
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
