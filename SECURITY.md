# Security boundaries

This is a local development emulator preview, not a production database or
network sandbox. Use synthetic accounts and demo projects. Do not expose its
ports publicly or import production credentials. User Functions may make
outbound requests independently of the emulator.

Report suspected sensitive exposure privately to the repository owner; do not
paste secrets, user exports or private application logs in public issues.

Source review and actual-package allowlists reduce accidental publication risk;
neither proves that formerly accessible material was never copied. Updating a
package does not erase older immutable package versions.

## Dependency review during source preparation

On 2026-09-09 MYT, `npm audit --json` reported the following dependency entries
(including transitive propagation, not distinct vulnerabilities):

| Isolated installation | Moderate | High / critical |
| --- | ---: | ---: |
| Pinned conformance development lockfile | 9 | 0 / 0 |
| Packed CLI and native package only, production dependency closure | 9 | 0 / 0 |
| Tiny suite consumer, additionally using Firestore 9.0.0 and firebase-functions 7.2.5 | 16 | 0 / 0 |

They include transitive OpenTelemetry, qs, stream-json and uuid advisories.
These JavaScript dependencies are not bundled into the native binary, but are
installed alongside the CLI for its Functions compatibility host. They are
not harmless merely because this is local development. The additional suite
dependencies belong to the synthetic consumer, not the CLI manifest.

The oracle versions have not been silently changed or force-downgraded to make
an audit summary green. Updates require a separate pinned compatibility check.
Before publication, refresh both audits and review remaining findings. The
registry's suggested automatic fixes included breaking version changes; none
was applied. This preview does not claim a zero-advisory dependency closure.
Relevant advisories:
[OpenTelemetry](https://github.com/advisories/GHSA-8988-4f7v-96qf),
[qs](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g),
[stream-json](https://github.com/advisories/GHSA-528h-pc64-c93x),
[uuid](https://github.com/advisories/GHSA-w5hq-g745-h8pq).
