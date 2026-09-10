# Official Functions shutdown after one HTTP invocation

Independent firebase-tools 15.22.0 / firebase-functions 7.2.5 / Node 24.20.0
capture using a fresh `demo-*` project and one synthetic `ping` handler. Run
`conformance/src/developer-tools/capture-functions-shutdown.mjs` with isolated
pinned dependency roots and a fresh output directory to reproduce it.

The actual CLI acknowledges the request, drains/stops the emulator on SIGINT,
and exits successfully. The recorded 34 ms is a local observation, not a latency
threshold or performance comparison. The wrapper must wait for its stop/drain
promise; after that, an unused dependency timer must not keep it alive.
No consumer code, schema, credentials or external provider request is involved.
