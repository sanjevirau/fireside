import { spawn } from "node:child_process";

import { CLOUD_PROJECT_ID } from "./target.ts";

if (process.env.FIRESTORE_EMULATOR_HOST !== undefined) {
  throw new Error("cloud runner refuses FIRESTORE_EMULATOR_HOST");
}

await new Promise<void>((resolve, reject) => {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--test",
      "test/error-code-parity.test.ts",
      "test/firestore-smoke.test.ts",
      "test/listen.test.ts",
      "test/partition-query.test.ts",
      "test/query-features.test.ts",
      "test/query-ordering.test.ts",
      "test/rest.test.ts",
      "test/streaming-write.test.ts",
      "test/write-transforms.test.ts",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CONFORMANCE_TARGET: "cloud",
        CONFORMANCE_CLOUD_PROJECT: CLOUD_PROJECT_ID,
        CONFORMANCE_CLOUD_ALLOWLIST: CLOUD_PROJECT_ID,
      },
      stdio: "inherit",
    },
  );

  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (code === 0) {
      resolve();
      return;
    }

    reject(
      new Error(
        `cloud smoke exited with code ${String(code)} and signal ${String(signal)}`,
      ),
    );
  });
});
