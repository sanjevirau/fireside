# fireside differential conformance harness

The harness runs identical TypeScript cases through real Google SDKs. Its three
target names are `cloud`, `java`, and `fireside`; Phase 0 exercises only `java`
to prove the harness and programmatic emulator download.

```sh
npm ci
npm run check
npm test
npm run test:official
```

`test:official` reserves an available loopback port, creates an isolated
temporary emulator configuration, asks the pinned `firebase-tools` dependency
to download the official Firestore emulator, starts it with the synthetic
project `demo-fireside-phase0`, runs the SDK smoke case, and shuts it down.

The `cloud` target has a hard safety interlock: the explicitly selected project
must exactly match a separate allowlist variable. Cloud execution remains
disabled until the maintainer supplies a dedicated billed test project at the
start of Phase 1.
