import assert from "node:assert/strict";
import test from "node:test";

import { createFirestore, resolveTarget } from "../src/target.ts";

test("ExecutePipeline preserves the production database-edition gate", async () => {
  const configuration = resolveTarget(process.env);
  const firestore = createFirestore(configuration);

  try {
    await assert.rejects(
      firestore
        .pipeline()
        .collection("fireside_pipeline_standard_probe")
        .limit(1)
        .execute(),
      (error: unknown) => grpcCode(error) === (configuration.name === "java" ? 3 : 9),
    );
  } finally {
    await firestore.terminate();
  }
});

function grpcCode(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "code" in error &&
      typeof error.code === "number"
    ? error.code
    : undefined;
}
