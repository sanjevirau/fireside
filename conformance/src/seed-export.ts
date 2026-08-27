import { FieldValue, GeoPoint, Timestamp } from "@google-cloud/firestore";

import { createFirestore, resolveTarget } from "./target.ts";

const configuration = resolveTarget(process.env);
if (configuration.name !== "java") {
  throw new Error("export seeding is restricted to the isolated Java emulator");
}

const firestore = createFirestore(configuration);
const root = firestore.collection("fireside_export_fixture");
const reference = root.doc("reference-target");

await Promise.all([
  reference.set({ kind: "reference-target" }),
  root.doc("values").set({
    array: [null, true, 42, 4.25, "array-value"],
    bytes: Buffer.from([0, 1, 2, 127, 128, 255]),
    incremented: FieldValue.increment(3),
    location: new GeoPoint(3.139, 101.6869),
    map: { nested: { enabled: true }, score: 9 },
    nullValue: null,
    reference,
    string: "fireside-export-🔥",
    timestamp: Timestamp.fromMillis(1_700_000_000_123),
  }),
  root.doc("large").set({
    payload: "🔥".repeat(40_000),
  }),
]);

await firestore.terminate();
