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

## Prerelease publication review

The release preparation refresh on 2026-09-09 MYT found **11 moderate** entries
in the conformance lockfile, **10 moderate** entries in a new production-only
installation of the exact `0.1.0-next.2` CLI/native archives, and **16 moderate**
entries in the retained tiny-suite consumer. All three had zero high/critical
entries. The earlier table is preserved as its original snapshot; advisory
feeds and newly resolved transitive dependencies can change between checks.
Conformance tooling pins firebase-tools 15.28.1; the shipped Functions
compatibility host pins 15.22.0. These are different audited scopes.

The refresh additionally reports
[csv-parse prototype replacement](https://github.com/advisories/GHSA-8cw4-87c7-c6xx)
and, in the conformance lockfile,
[morgan log forging](https://github.com/advisories/GHSA-jxfw-x594-9x9m).
The qs findings also include an
[array-limit bypass](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx).

Review of the installed 15.22.0 source places csv-parse in its Auth-import
command, stream-json filters in its import/framework commands, and morgan in
its Hosting server. The reviewed gaxios call uses UUID v4, rather than the
advisory's caller-provided-buffer v3/v5/v6 path. These observations narrow
those specific call paths; they do not prove every transitive use unreachable.
Express/qs request parsing and OpenTelemetry input handling still warrant
care around untrusted traffic and data.

This distribution-cleanup prerelease leaves dependency versions and engine
behavior unchanged. It is limited to local development with trusted synthetic
inputs and loopback access, not public hosting or hostile-data isolation.
Do not treat these advisories as fixed or harmless. A pinned, compatibility-
tested dependency upgrade is follow-up work; no force downgrade, audit
suppression or zero-advisory claim is part of this release.
