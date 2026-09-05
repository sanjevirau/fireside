# Official-client Bloom nonmember collision

This is an **offline official Firebase JS SDK oracle**, captured before changing
the failing Listen assertion. It is not a cloud capture, an emulator replay, or
the original CI input. The CI log records the failed assertion but does not
contain its random collection UUID or filter bitmap.

The installed, lockfile-pinned Firebase 12.18.0 dependency provides
`@firebase/firestore` 4.17.1 and `@firebase/webchannel-wrapper` 1.0.7. The helper
verifies package versions, lockfile integrity entries, source hashes and the
extracted block hash before evaluating the **unmodified official Bloom class**
with its actual MD5/Integer dependency. It does not reimplement Fireside's
filter builder, vendor the SDK, or access a service.

Reproduce from the repository root:

```sh
cd conformance
node --import tsx --test test/bloom-nonmember-oracle.test.ts
```

For the two fixture members, the official client generates bitmap
`57XW81ipFQ==`, padding 3 and 18 hashes. Both members test positive. The absent
name `missing` also tests positive: all its hash indices are bit 13, which is
set. A different absent name, `not-present`, tests negative. These are fixed,
repeatable observations, not a search during the regression test.

The vendored Google `ExistenceFilter` contract gives a one-way guarantee: a
negative means the name is not in the target. A positive is not proof of
membership. The recorded official-client collision demonstrates why the
randomized nonmember negative assertion at `listen.test.ts:300` is unsound.
Actual-member no-false-negative checks, filter dimensions/count and every
resume/document assertion remain necessary. A future assertion correction must
use independent oracle expectations; finding a convenient negative in the
returned server filter would conceal malformed filters and is not acceptable.

The CI failure remains a failed run. This fixture does not establish a Fireside
resume defect, a timing race, a successful CI retry, or a completed Phase 5 gate.
