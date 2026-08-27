import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  createFirestore,
  createV1Firestore,
  resolveTarget,
} from "../src/target.ts";

type WriteStream = ReturnType<ReturnType<typeof createV1Firestore>["write"]>;

interface ObservedWriteResponse {
  readonly commitTime?: object | null;
  readonly streamId?: string | null;
  readonly streamToken?: string | Uint8Array | null;
  readonly writeResults?: readonly unknown[] | null;
}

test("streaming Write performs a tokened handshake and atomic write", async (context) => {
  const configuration = resolveTarget(process.env);
  const firestore = createFirestore(configuration);
  const rawFirestore = createV1Firestore(configuration);
  const documentId = randomUUID();
  const documentName = `projects/${configuration.projectId}/databases/(default)/documents/runs/${documentId}`;
  const stream = rawFirestore.write();
  const responses = responseQueue(stream);

  context.after(async () => {
    stream.end();
    await firestore.doc(`runs/${documentId}`).delete().catch(() => undefined);
    await Promise.all([firestore.terminate(), rawFirestore.close()]);
  });

  stream.write({
    database: `projects/${configuration.projectId}/databases/(default)`,
  });
  if (configuration.name === "java") {
    await assert.rejects(
      responses.next(),
      (error: unknown) => grpcCode(error) === 2,
      "Java v1.22.0 should expose its production divergence as UNKNOWN",
    );
    return;
  }
  const handshake = await responses.next();
  assert.notEqual(handshake.streamId, undefined);
  assert.notEqual(handshake.streamId, "");
  assert.ok(byteLength(handshake.streamToken) > 0);
  assert.equal(handshake.writeResults?.length ?? 0, 0);
  assert.equal(handshake.commitTime ?? null, null);

  stream.write({
    streamId: handshake.streamId,
    streamToken: handshake.streamToken,
    writes: [
      {
        update: {
          name: documentName,
          fields: {
            source: { stringValue: "streaming-write" },
          },
        },
      },
    ],
  });
  const applied = await responses.next();
  assert.equal(applied.streamId ?? "", "");
  assert.ok(byteLength(applied.streamToken) > 0);
  assert.notDeepEqual(applied.streamToken, handshake.streamToken);
  assert.equal(applied.writeResults?.length, 1);
  assert.notEqual(applied.commitTime, undefined);

  const stored = await firestore.doc(`runs/${documentId}`).get();
  assert.equal(stored.get("source"), "streaming-write");
});

function responseQueue(stream: WriteStream): {
  readonly next: () => Promise<ObservedWriteResponse>;
} {
  const responses: ObservedWriteResponse[] = [];
  const waiters: Array<{
    readonly resolve: (response: ObservedWriteResponse) => void;
    readonly reject: (error: Error) => void;
  }> = [];
  let terminalError: Error | undefined;

  stream.on("data", (response: ObservedWriteResponse) => {
    const waiter = waiters.shift();
    if (waiter === undefined) {
      responses.push(response);
    } else {
      waiter.resolve(response);
    }
  });
  stream.on("error", (error: Error) => {
    terminalError = error;
    for (const waiter of waiters.splice(0)) {
      waiter.reject(error);
    }
  });

  return {
    next: async () => {
      const response = responses.shift();
      if (response !== undefined) {
        return response;
      }
      if (terminalError !== undefined) {
        throw terminalError;
      }
      return await new Promise<ObservedWriteResponse>((resolvePromise, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("timed out waiting for a streaming Write response"));
        }, 45_000);
        waiters.push({
          resolve: (value) => {
            clearTimeout(timeout);
            resolvePromise(value);
          },
          reject: (error) => {
            clearTimeout(timeout);
            reject(error);
          },
        });
      });
    },
  };
}

function grpcCode(error: unknown): number | undefined {
  if (!(error instanceof Error) || !("code" in error)) {
    return undefined;
  }
  const { code } = error as Error & { readonly code?: unknown };
  return typeof code === "number" ? code : undefined;
}

function byteLength(value: string | Uint8Array | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }
  return typeof value === "string" ? Buffer.from(value, "base64").byteLength : value.byteLength;
}
