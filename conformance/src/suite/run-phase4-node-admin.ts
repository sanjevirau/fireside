import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

interface Arguments {
  readonly authHost: string;
  readonly firestoreHost: string;
  readonly output: string;
  readonly projectId: string;
  readonly storageHost: string;
  readonly twodartDirectory: string;
}

interface Latencies {
  readonly p50Milliseconds: number;
  readonly p95Milliseconds: number;
  readonly p99Milliseconds: number;
  readonly samples: number;
}

const arguments_ = parseArguments(process.argv.slice(2));
const requireFromTwodart = createRequire(
  join(resolve(arguments_.twodartDirectory), "package.json"),
);
const firebaseAdminVersion = await packageVersion(
  arguments_.twodartDirectory,
  "firebase-admin",
);

process.env.GCLOUD_PROJECT = arguments_.projectId;
process.env.GOOGLE_CLOUD_PROJECT = arguments_.projectId;
process.env.FIREBASE_AUTH_EMULATOR_HOST = arguments_.authHost;
process.env.FIRESTORE_EMULATOR_HOST = arguments_.firestoreHost;
process.env.STORAGE_EMULATOR_HOST = `http://${arguments_.storageHost}`;
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;

const { deleteApp, initializeApp } = requireFromTwodart("firebase-admin/app") as {
  readonly deleteApp: (app: unknown) => Promise<void>;
  readonly initializeApp: (options: unknown, name?: string) => unknown;
};
const { getAuth } = requireFromTwodart("firebase-admin/auth") as {
  readonly getAuth: (app: unknown) => {
    createUser(input: unknown): Promise<{ uid: string }>;
    deleteUser(uid: string): Promise<void>;
    getUser(uid: string): Promise<{ customClaims?: Record<string, unknown>; email?: string }>;
    getUserByEmail(email: string): Promise<{ uid: string }>;
    listUsers(limit: number): Promise<{ users: readonly { uid: string }[] }>;
    setCustomUserClaims(uid: string, claims: Record<string, unknown>): Promise<void>;
    updateUser(uid: string, input: unknown): Promise<{ displayName?: string }>;
  };
};
const { getFirestore } = requireFromTwodart("firebase-admin/firestore") as {
  readonly getFirestore: (app: unknown) => {
    doc(path: string): {
      delete(): Promise<unknown>;
      get(): Promise<{ data(): Record<string, unknown> | undefined; exists: boolean }>;
      set(value: unknown): Promise<unknown>;
    };
  };
};
const { getStorage } = requireFromTwodart("firebase-admin/storage") as {
  readonly getStorage: (app: unknown) => {
    bucket(name?: string): {
      file(path: string): {
        delete(options?: unknown): Promise<unknown>;
        download(): Promise<readonly [Buffer]>;
        getMetadata(): Promise<readonly [Record<string, unknown>]>;
        save(bytes: Buffer, options?: unknown): Promise<void>;
      };
      getFiles(options?: unknown): Promise<readonly [readonly { name: string }[]]>;
    };
  };
};

const runId = `phase4-node-${Date.now()}-${crypto.randomUUID()}`;
const app = initializeApp(
  {
    projectId: arguments_.projectId,
    storageBucket: `${arguments_.projectId}.appspot.com`,
  },
  runId,
);
const auth = getAuth(app);
const firestore = getFirestore(app);
const storage = getStorage(app);
const cleanup: Array<() => Promise<unknown>> = [];

try {
  const authDurations: number[] = [];
  for (let index = 0; index < 100; index += 1) {
    const uid = `${runId}-${String(index)}`;
    const email = `${uid}@example.test`;
    const started = performance.now();
    await auth.createUser({ email, emailVerified: true, uid });
    cleanup.push(async () => await auth.deleteUser(uid));
    const byId = await auth.getUser(uid);
    const byEmail = await auth.getUserByEmail(email);
    await auth.updateUser(uid, { displayName: `Node Admin 火🔥 ${String(index)}` });
    await auth.setCustomUserClaims(uid, { admin: index === 0, phase: 4 });
    const withClaims = await auth.getUser(uid);
    if (
      byId.email !== email ||
      byEmail.uid !== uid ||
      withClaims.customClaims?.phase !== 4
    ) {
      throw new Error(`Auth Admin round trip diverged for ${uid}`);
    }
    authDurations.push(performance.now() - started);
  }
  const listed = await auth.listUsers(1_000);
  if (!listed.users.some((user) => user.uid === `${runId}-0`)) {
    throw new Error("Auth paginated list omitted the synthetic user");
  }

  const document = firestore.doc(`_firesidePhase4/${runId}`);
  cleanup.push(async () => await document.delete());
  await document.set({ client: "node-admin", runId, unicode: "火🔥" });
  const snapshot = await document.get();
  if (!snapshot.exists || snapshot.data()?.unicode !== "火🔥") {
    throw new Error("Node Admin Firestore round trip diverged");
  }

  const storageDurations: number[] = [];
  const bucketNames = [
    `${arguments_.projectId}.appspot.com`,
    "assets-local.twodart.com",
  ];
  for (const bucketName of bucketNames) {
    const bucket = storage.bucket(bucketName);
    for (let index = 0; index < 50; index += 1) {
      const path = `_firesidePhase4/${runId}/${String(index)}-火🔥.txt`;
      const file = bucket.file(path);
      cleanup.push(async () => await file.delete({ ignoreNotFound: true }));
      const bytes = Buffer.from(`Node Admin ${bucketName} ${String(index)} 火🔥\n`);
      const started = performance.now();
      await file.save(bytes, {
        metadata: {
          cacheControl: "private,max-age=60",
          contentType: "text/plain; charset=utf-8",
          metadata: { phase: "4", unicode: "火🔥" },
        },
      });
      const [metadata] = await file.getMetadata();
      const [downloaded] = await file.download();
      const [files] = await bucket.getFiles({ prefix: path });
      if (
        !downloaded.equals(bytes) ||
        (metadata.metadata as Record<string, unknown> | undefined)?.unicode !== "火🔥" ||
        files.length !== 1 ||
        files[0]?.name !== path
      ) {
        throw new Error(`Node Admin Storage round trip diverged for ${bucketName}/${path}`);
      }
      storageDurations.push(performance.now() - started);
    }
  }

  const evidence = {
    auth: summarize(authDurations),
    client: "Twodart Node Firebase Admin SDK",
    firestore: { passed: true, unicode: "火🔥" },
    packageVersions: {
      firebaseAdmin: firebaseAdminVersion,
    },
    passed: true,
    projectId: arguments_.projectId,
    schemaVersion: 1,
    storage: {
      buckets: bucketNames,
      operations: summarize(storageDurations),
    },
  };
  await writeFile(resolve(arguments_.output), `${JSON.stringify(evidence, null, 2)}\n`);
} finally {
  for (const action of cleanup.reverse()) {
    try {
      await action();
    } catch {
      // The gate records the verified operation; cleanup remains best-effort.
    }
  }
  await deleteApp(app);
}

async function packageVersion(root: string, name: string): Promise<string> {
  const body = JSON.parse(
    await readFile(join(resolve(root), "node_modules", name, "package.json"), "utf8"),
  ) as { readonly version?: unknown };
  if (typeof body.version !== "string") throw new Error(`${name} has no package version`);
  return body.version;
}

function summarize(values: readonly number[]): Latencies {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) throw new Error("cannot summarize zero samples");
  return {
    p50Milliseconds: percentile(sorted, 0.5),
    p95Milliseconds: percentile(sorted, 0.95),
    p99Milliseconds: percentile(sorted, 0.99),
    samples: sorted.length,
  };
}

function percentile(sorted: readonly number[], quantile: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index] ?? Number.NaN;
}

function parseArguments(values: readonly string[]): Arguments {
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (key === undefined || value === undefined || !key.startsWith("--")) {
      throw new Error("Phase 4 Node Admin arguments must be --key value pairs");
    }
    parsed.set(key.slice(2), value);
  }
  const required = (key: string): string => {
    const value = parsed.get(key);
    if (value === undefined || value.length === 0) throw new Error(`--${key} is required`);
    return value;
  };
  return {
    authHost: required("auth-host"),
    firestoreHost: required("firestore-host"),
    output: required("output"),
    projectId: required("project-id"),
    storageHost: required("storage-host"),
    twodartDirectory: required("twodart-dir"),
  };
}
