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

The pinned conformance development lockfile reported nine moderate npm audit
entries and no high/critical entries on 2026-09-09 MYT. They include transitive
OpenTelemetry, qs, stream-json and uuid advisories through test tooling. These
dependencies are not bundled into the native binary, but this does not make
them harmless: local oracle/test tooling and the separately installed Functions
compatibility host need their own dependency review.

The oracle versions have not been silently changed or force-downgraded to make
an audit summary green. Updates require a separate pinned compatibility check.
Before publication, record current results for both the conformance lockfile
and the installed CLI/Functions dependency closure. Relevant advisories:
[OpenTelemetry](https://github.com/advisories/GHSA-8988-4f7v-96qf),
[qs](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g),
[stream-json](https://github.com/advisories/GHSA-528h-pc64-c93x),
[uuid](https://github.com/advisories/GHSA-w5hq-g745-h8pq).
