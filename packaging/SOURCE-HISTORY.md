# Source-history maintenance — 2026-09-09

The repository history was rewritten to remove superseded consumer-shaped
test inputs. Fresh synthetic oracle recordings retain the same types, cases,
operations and assertions. Removed historical fixtures were not edited and
presented as genuine oracle recordings; historical checkouts may therefore
lack those withdrawn fixtures. Use the current source for reproducible tests.

Existing clones should be replaced with a fresh clone. Do not merge or push an
old branch: that can reintroduce withdrawn history. The owner retains a private
archive and revision map. Previously generated CI results qualify only their
original source and artifact bytes, not rewritten commit IDs.

The old `npm-v0.1.0-next.2` Git tag is withdrawn rather than reassigned to a
different commit. The old draft GitHub release is archived privately. Published
npm versions, hashes and signed attestations are immutable and are not relabelled.
Their source links may become unavailable after historical cache cleanup.
The next preview uses a new engine source identity and requires fresh builds,
all existing quality/install checks and protected publication approval.

This maintenance does not revoke external copies or guarantee cache removal.
It is not a claim of zero vulnerabilities, universal Firebase compatibility,
new performance measurements or removal of the documented dependency advisories.
