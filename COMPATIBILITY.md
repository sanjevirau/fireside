# Preview compatibility

Fireside is not yet a universal Firebase Emulator Suite replacement.

| Surface | Current preview | Not claimed |
| --- | --- | --- |
| Firestore | Native/Admin and browser SDK paths, rules, realtime targets, disk/WAL, official-format import/export | Every production feature, edition or arbitrary client version |
| Auth | Captured password/custom-token/refresh/admin and local Google popup/redirect flows | Every provider, tenant or production authentication flow |
| Storage | Captured Firebase/GCS paths, metadata, gzip, pagination, multi-bucket and export/import | All GCS features or every Firebase CLI config shape |
| Functions | Node/firebase-tools compatibility host and captured dispatch/control paths | Pure Rust JavaScript execution or a network sandbox |
| Pub/Sub | Limited function-oriented publication/dispatch adapter | General subscriber, push/pull and ordering parity |
| Hub/UI | Captured discovery/control/static/logging paths | Complete Emulator UI parity |
| Other services | None claimed | Realtime Database, Hosting, App Hosting, Data Connect and universal extensions |
| CLI | Complete local suite, explicit setup, doctor, start/exec, state/resume | Arbitrary service subsets, cloud deploy or real-project configuration |

Firestore Requests/rule-evaluation tracing and rules-coverage tooling remain
unfinished. Closing these developer-tool gaps is a required
[first-release priority](ROADMAP.md#phase-b--functional-developer-tools), not
a capability claimed by the current preview. Auxiliary Eventarc/Tasks ports
support host startup registration only. Unsupported task/event delivery routes
return HTTP 501 `UNIMPLEMENTED`; registration is not a promise of delivery.

The package supports only its enumerated native targets after their exact
candidate checks pass. Linux musl, Windows ARM64/32-bit, network-filesystem
durability and Windows power-loss recovery are not qualified.

Use synthetic demo data, loopback interfaces and a representative private
consumer test before adoption. Consult the CLI guide for stricter configuration
limitations. Performance depends on workload and hardware; source separation
is not evidence of faster execution or lower memory.
