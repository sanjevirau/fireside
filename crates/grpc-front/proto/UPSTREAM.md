# Google API protocol provenance

The `.proto` files in this directory are the minimal transitive source graph
for `google/firestore/v1/firestore.proto`. They were copied without
modification from:

- repository: `https://github.com/googleapis/googleapis`
- commit: `de3c0d362adbaafc7a0cd1254a8cd49a528505ee`
- retrieved: 2026-08-27
- license: Apache License 2.0; see `LICENSE` in this directory

`build.rs` compiles these definitions with protox and tonic-prost-build. The
generated Rust exists only in Cargo's build output and is not checked in.
