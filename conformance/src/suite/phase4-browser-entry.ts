import { deleteApp, initializeApp } from "firebase/app";
import {
  connectAuthEmulator,
  getAuth,
  getIdToken,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";
import {
  connectFirestoreEmulator,
  deleteDoc,
  doc,
  getDoc,
  getFirestore,
  onSnapshot,
  setDoc,
  terminate,
  updateDoc,
} from "firebase/firestore";
import {
  connectFunctionsEmulator,
  getFunctions,
  httpsCallable,
} from "firebase/functions";
import {
  connectStorageEmulator,
  deleteObject,
  getBytes,
  getMetadata,
  getStorage,
  listAll,
  ref,
  uploadString,
} from "firebase/storage";

interface BrowserConfiguration {
  readonly assetsBucket: string;
  readonly authPort: number;
  readonly defaultBucket: string;
  readonly email: string;
  readonly firestorePort: number;
  readonly functionsPort: number;
  readonly host: string;
  readonly password: string;
  readonly projectId: string;
  readonly runId: string;
  readonly storagePort: number;
  readonly uid: string;
}

declare global {
  interface Window {
    __PHASE4_CONFIG__: BrowserConfiguration;
    __PHASE4_RESULT__?: unknown;
    __PHASE4_STAGE__?: string;
  }
}

void run().catch((error: unknown) => {
  window.__PHASE4_RESULT__ = {
    message: error instanceof Error ? error.stack ?? error.message : String(error),
    passed: false,
    schemaVersion: 1,
  };
});

async function run(): Promise<void> {
  window.__PHASE4_STAGE__ = "initialize";
  const config = window.__PHASE4_CONFIG__;
  const app = initializeApp({
    apiKey: "phase4-browser-key",
    appId: "1:123:web:phase4",
    authDomain: `${config.projectId}.firebaseapp.com`,
    projectId: config.projectId,
    storageBucket: config.defaultBucket,
  });
  const auth = getAuth(app);
  connectAuthEmulator(auth, `http://${config.host}:${String(config.authPort)}`, {
    disableWarnings: true,
  });
  const firestore = getFirestore(app);
  connectFirestoreEmulator(firestore, config.host, config.firestorePort);
  const functions = getFunctions(app, "us-central1");
  connectFunctionsEmulator(functions, config.host, config.functionsPort);
  const defaultStorage = getStorage(app, `gs://${config.defaultBucket}`);
  const assetsStorage = getStorage(app, `gs://${config.assetsBucket}`);
  connectStorageEmulator(defaultStorage, config.host, config.storagePort);
  connectStorageEmulator(assetsStorage, config.host, config.storagePort);

  let unauthenticatedCallable = false;
  window.__PHASE4_STAGE__ = "unauthenticated-callable";
  try {
    await httpsCallable(functions, "onUpdateStripeSubscription")({});
  } catch (error: unknown) {
    const code = nestedString(error, "code");
    const message = error instanceof Error ? error.message : String(error);
    unauthenticatedCallable =
      code === "functions/unauthenticated" || /unauthenticated|authenticated/iu.test(message);
  }
  if (!unauthenticatedCallable) {
    throw new Error("Twodart callable did not return the safe unauthenticated contract");
  }

  const signInStarted = performance.now();
  window.__PHASE4_STAGE__ = "auth-sign-in";
  const credential = await signInWithEmailAndPassword(auth, config.email, config.password);
  const signInMilliseconds = performance.now() - signInStarted;
  if (credential.user.uid !== config.uid || !credential.user.emailVerified) {
    throw new Error("browser Auth identity did not preserve uid/emailVerified");
  }
  const idToken = await getIdToken(credential.user, true);
  if (idToken.split(".").length !== 3) throw new Error("browser Auth did not issue a JWT");

  const document = doc(firestore, "users", config.uid);
  window.__PHASE4_STAGE__ = "firestore-listener";
  const listenerDeliveries: number[] = [];
  let resolveIncremental: (() => void) | undefined;
  const incremental = new Promise<void>((resolvePromise) => {
    resolveIncremental = resolvePromise;
  });
  const unsubscribe = onSnapshot(document, (snapshot) => {
    const revision = snapshot.data()?.revision;
    if (typeof revision === "number") {
      listenerDeliveries.push(performance.now());
      if (revision === 2) resolveIncremental?.();
    }
  });
  await setDoc(document, {
    email: config.email,
    revision: 1,
    uid: config.uid,
    unicode: "火🔥",
  });
  const read = await getDoc(document);
  if (read.data()?.unicode !== "火🔥") throw new Error("browser Firestore read diverged");
  const updateStarted = performance.now();
  await updateDoc(document, { revision: 2, unicode: "混合🔥" });
  await withTimeout(incremental, 10_000, "browser incremental listener");
  const listenerDeliveryMilliseconds = performance.now() - updateStarted;
  unsubscribe();

  const defaultPath = `users/${config.uid}/phase4-${config.runId}-火🔥.txt`;
  window.__PHASE4_STAGE__ = "storage-default";
  const defaultObject = ref(defaultStorage, defaultPath);
  const payload = `browser storage 火🔥 ${config.runId}`;
  await uploadString(defaultObject, payload, "raw", {
    cacheControl: "private,max-age=60",
    contentType: "text/plain; charset=utf-8",
    customMetadata: { phase: "4", unicode: "火🔥" },
  });
  const downloaded = new TextDecoder().decode(await getBytes(defaultObject));
  const metadata = await getMetadata(defaultObject);
  const listed = await listAll(ref(defaultStorage, `users/${config.uid}`));
  if (
    downloaded !== payload ||
    metadata.customMetadata?.unicode !== "火🔥" ||
    !listed.items.some((item) => item.fullPath === defaultPath)
  ) {
    throw new Error(
      `browser default-bucket Storage round trip diverged: ${JSON.stringify({
        downloaded,
        expected: payload,
        listed: listed.items.map((item) => item.fullPath),
        unicode: metadata.customMetadata?.unicode,
      })}`,
    );
  }

  const publicAssetPath = `_firesidePhase4/${config.runId}/public-火🔥.txt`;
  window.__PHASE4_STAGE__ = "storage-assets";
  const publicAsset = ref(assetsStorage, publicAssetPath);
  const assetPayload = new TextDecoder().decode(await getBytes(publicAsset));
  if (assetPayload !== `public asset ${config.runId} 火🔥`) {
    throw new Error("browser public assets-bucket read diverged");
  }

  const webhook = await fetch(
    `http://${config.host}:${String(config.functionsPort)}/${config.projectId}/us-central1/onReceiveStripeWebhook`,
    {
      body: "{}",
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  if (webhook.status < 400 || webhook.status >= 500) {
    throw new Error(`invalid-signature webhook returned ${String(webhook.status)}`);
  }

  await signOut(auth);
  window.__PHASE4_STAGE__ = "auth-reconnect";
  const secondSignInStarted = performance.now();
  await signInWithEmailAndPassword(auth, config.email, config.password);
  const reconnectMilliseconds = performance.now() - secondSignInStarted;
  await deleteObject(defaultObject);
  await deleteDoc(document);
  await signOut(auth);
  await terminate(firestore);
  await deleteApp(app);

  window.__PHASE4_RESULT__ = {
    auth: { reconnectMilliseconds, signInMilliseconds },
    client: "Twodart vanilla Firebase JavaScript browser SDK",
    firestore: {
      listenerDeliveries: listenerDeliveries.length,
      listenerDeliveryMilliseconds,
      passed: true,
    },
    functions: {
      invalidSignatureWebhookStatus: webhook.status,
      unauthenticatedCallable,
    },
    passed: true,
    schemaVersion: 1,
    storage: {
      assetsPublicRead: true,
      defaultAuthenticatedRoundTrip: true,
    },
  };
  window.__PHASE4_STAGE__ = "complete";
}

function nestedString(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
}

async function withTimeout<T>(
  value: Promise<T>,
  milliseconds: number,
  label: string,
): Promise<T> {
  return await Promise.race([
    value,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
    }),
  ]);
}
