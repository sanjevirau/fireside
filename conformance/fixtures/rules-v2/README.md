# Phase 3 security-rules fixtures

These fixtures are synthetic, credential-free observations for the immutable
Phase 3 gate in `benchmarks/phase-3-rules.json`. Production verdict and
expression-value behavior takes precedence; the official Java emulator is the
secondary oracle for access accounting, `getAfter`, and runtime behavior that
the inline Rules API cannot fully establish.

`production-expression-corpus.json` contains 1,024 deterministic
`projects.test` cases captured from project `fireside-conformance` with
`expressionReportLevel=FULL`. The capture made no persistent Firestore reads
or writes and stores no authorization header, ADC token, cookie, or user data.
Every request uses synthetic auth claims and paths under `/phase3`.

The corpus uses the expectation `ALLOW` only as an observation probe. A
`SUCCESS` result means production allowed the request; a `FAILURE` means the
expression denied or raised a runtime error. The full report disambiguates
errors and preserves intermediate expression values.

`production-language-contract.json` adds 44 targeted production cases for the
documented value and namespace surface. Forty-three allow. The one captured
failure is intentional evidence: the production `projects.test` service
returns `Function not found` for `debug()`. That projects.test-specific result
is retained rather than normalized away; emulator behavior is classified
separately.

`production-parse-errors.json` and `production-limit-probes.json` preserve raw
compiler, request-envelope, call-depth, expression-complexity, and runtime
budget boundaries. They freeze a function call-depth maximum of 20 and an
evaluated-expression maximum of 1,000. The Rules API request envelope starts
rejecting the large synthetic source below the documented 256 KiB deployed
rules maximum, so the fixture does not mislabel its transport boundary as the
deployment limit.

The three `java-*.json` fixtures were captured against the exact official Java
v1.22.0 jar. They prove the 10/20 document-access limits, cached repeated
access, pending-write `getAfter` behavior, and permission-denied handling for
missing fields, division by zero, list bounds, wrong-type method dispatch, and
missing `get()` resources.

`complex-firestore.rules` is a 1,193-nonblank-line application ruleset. Its
companion fixture records a clean production compile and 45 official-Java
cases: 27 allow and 18 deny. The cases cover auth/custom claims, CRUD resource
differences, field-change validation, nested and recursive matches, query
limits, cross-document access, `getAfter`, timestamps/durations, and generated
multi-tenant policy branches.

Capture command:

```sh
CONFORMANCE_CLOUD_ALLOWLIST=fireside-conformance npm run capture:rules:cloud
CONFORMANCE_CLOUD_ALLOWLIST=fireside-conformance npm run capture:rules:language
CONFORMANCE_CLOUD_ALLOWLIST=fireside-conformance npm run capture:rules:boundaries
npm run capture:rules:java
CONFORMANCE_CLOUD_ALLOWLIST=fireside-conformance npm run capture:rules:complex
```

All captures are synthetic. The production captures make no persistent reads
or writes, and no fixture stores credentials, authorization headers, cookies,
or access tokens. `SHA256SUMS` locks the complete fixture set before product
implementation begins.
