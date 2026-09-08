import assert from "node:assert/strict";
import test from "node:test";

import {
  isAcceptedKarmaProcess,
  parseKarmaEvidence,
} from "../src/webchannel/firebase-js-sdk-karma-evidence.ts";

const nativeSkipOutput = `
  (Persistence=memory_lru_gc) Large Documents
    ✖ can read and cache a 15.9MB Unicode document (skipped)
    ✖ cache integrity with multiple large documents (skipped)
    ✖ can run watch snapshot listener on a large document (skipped)
    ✖ can run transaction read-modify-write on a large document (skipped)
    ✖ can query large documents (skipped)
    ✖ query large documents forces local scan (skipped)
    ✖ gracefully rejects oversized payloads (skipped)
    ✖ can write a 15.9MB document (skipped)
TOTAL: 0 SUCCESS

SUMMARY:
✔ 0 tests completed
ℹ 8 tests skipped
error Command failed with exit code 1.
`;

test("accepts and preserves the pinned native-skip-only partition", () => {
  const evidence = parseKarmaEvidence(nativeSkipOutput);

  assert.deepEqual(evidence, {
    completedTests: 0,
    failedTests: 0,
    nativeSkipNames: [
      "cache integrity with multiple large documents",
      "can query large documents",
      "can read and cache a 15.9MB Unicode document",
      "can run transaction read-modify-write on a large document",
      "can run watch snapshot listener on a large document",
      "can write a 15.9MB document",
      "gracefully rejects oversized payloads",
      "query large documents forces local scan",
    ],
    nativeSkips: 8,
  });
  assert.equal(
    isAcceptedKarmaProcess(
      { exitCode: 1, output: nativeSkipOutput, signal: null },
      evidence,
    ),
    true,
  );
});

test("accepts a normal successful Karma partition", () => {
  const output = "TOTAL: 12 SUCCESS\nSUMMARY:\n✔ 12 tests completed\n";
  const evidence = parseKarmaEvidence(output);

  assert.equal(
    isAcceptedKarmaProcess({ exitCode: 0, output, signal: null }, evidence),
    true,
  );
});

test("rejects failures, empty selections, and infrastructure errors", () => {
  const failures = [
    {
      exitCode: 1,
      output: "TOTAL: 1 FAILED, 0 SUCCESS\nSUMMARY:\n✖ 1 test failed\n",
    },
    {
      exitCode: 1,
      output: "TOTAL: 0 SUCCESS\nSUMMARY:\n✔ 0 tests completed\n",
    },
    {
      exitCode: 1,
      output: `${nativeSkipOutput}\nChrome Headless 151.0.0.0 ERROR Disconnected`,
    },
  ];

  for (const failure of failures) {
    const evidence = parseKarmaEvidence(failure.output);
    assert.equal(
      isAcceptedKarmaProcess(
        { ...failure, signal: null },
        evidence,
      ),
      false,
    );
  }
});
