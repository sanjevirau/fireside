# Rules variable binding contract

Independent compiler-only official Firestore emulator 1.22.0 capture, with the
jar, Node, Java and capture-driver hashes recorded in `fixture.json`. No document
data, consumer source or cloud project is involved. Reproduce using Node 24.20.0:

```
node conformance/src/developer-tools/capture-rule-bindings.mjs /tmp/fresh-rule-bindings
```

Forty actual rules-install responses distinguish five package identifiers
(`duration`, `hashing`, `latlng`, `math`, `timestamp`) from `request`, `resource`
and an ordinary `value` identifier. Packages are rejected as function parameters,
let variables and match wildcards, but accepted as function names and map fields.
The three control identifiers are accepted in every captured position. These
are compilation observations, not a claim that every shadowed name evaluates
identically in every context. Exact source and errors are retained.

The earlier `developer-tools-coverage-v1` duration-parameter rejection remains
unchanged. This expanded fixture precedes the general binding correction.
