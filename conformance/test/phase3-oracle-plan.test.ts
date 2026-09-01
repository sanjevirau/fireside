import assert from "node:assert/strict";
import test from "node:test";

import {
  PHASE3_RULES_BATCHES,
  PHASE3_RULES_CASE_COUNT,
  PHASE3_RULES_CASES_PER_BATCH,
  buildPhase3ExpressionOracleBatches,
} from "../src/rules/phase3-oracle-plan.ts";

test("phase 3 production expression plan is frozen at 1,024 deterministic cases", () => {
  const batches = buildPhase3ExpressionOracleBatches();
  assert.equal(batches.length, PHASE3_RULES_BATCHES);
  assert.equal(
    batches.reduce((total, batch) => total + batch.cases.length, 0),
    PHASE3_RULES_CASE_COUNT,
  );
  assert.equal(PHASE3_RULES_CASE_COUNT, 1_024);
  assert.ok(
    batches.every(
      (batch) => batch.cases.length === PHASE3_RULES_CASES_PER_BATCH,
    ),
  );
  assert.equal(
    new Set(batches.flatMap((batch) => batch.cases.map(({ id }) => id))).size,
    1_024,
  );
  assert.deepEqual(
    new Set(
      batches.flatMap((batch) =>
        batch.cases.map(({ category }) => category),
      ),
    ),
    new Set([
      "literals-and-coercion",
      "boolean-short-circuit-and-errors",
      "numeric-arithmetic-and-comparison",
      "string-list-map-and-map-diff",
      "request-auth-method-time-query-resource-and-existing-resource",
    ]),
  );
  assert.ok(
    batches.every((batch) => batch.source.startsWith("rules_version = '2';")),
  );
});
