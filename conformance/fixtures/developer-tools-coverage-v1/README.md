# Expression coverage oracle

Captured from the checksum-pinned official Firestore 1.22.0 jar with Node
24.20.0, one synthetic document and twenty-six tiny rulesets. Run
`conformance/src/developer-tools/capture-coverage.mjs OUTPUT` in a fresh directory.
Only the owned loopback jar is started/stopped; no cloud or consumer inputs.
The capture records the actual Java version. Raw HTTP exchanges and process logs
remain alongside the generated fixture, outside the public fixture directory.

Each profile records coverage before and after two reads following a successful
rules reload. Constant-true rules omit `report` entirely. Dynamic trees omit
literal children, while keeping expression and function-body locations. Offsets
are zero-based Unicode-scalar indices and the end offset is inclusive; line and
column are one-based. The CJK/emoji/CRLF profile distinguishes these from UTF-8
byte offsets and UTF-16 code-unit indices. Calls and composite literals have
oracle-specific ranges that do not necessarily include closing punctuation.
The extended cases retain parentheses, unary/index operations, empty containers,
functions without bindings and interpolated document paths. Slice/type-check,
method arguments, nested grouping, grouped literals and constant functions are
also retained without normalizing their expression trees.
The value profiles additionally exercise durations, sets, map differences,
hashed bytes, timestamps and request context before implementing value capture.

Coverage counts are observed evaluator visits, not HTTP request counts. The jar
can record an undefined preliminary evaluation before loading a resource. A
short-circuited subtree receives an empty value object in this oracle, not a
fabricated evaluated result. Error values carry the observed cause/source position.
User function bodies and call sites both appear. Successful rules reload resets
coverage; rejected compilation retains the last valid source and its counts.

This pins a diagnostic/reporting contract, not an instruction to replay an
evaluation, issue extra reads or change Fireside's policy/accounting merely to
imitate the jar's planner. Any internal-evaluator difference must be explicit.
The fixture is not a Fireside implementation, browser or phase-completion claim.
