# Auth refresh reuse oracle

Captured from the installed, version-checked **firebase-tools 15.22.0** Auth
emulator. Only tiny synthetic accounts were created; all emulator and browser
processes are closed by the recorder. No cloud service is contacted.

Reproduce from `conformance/` with Node 24.20.0:

```sh
FIREBASE_TOOLS_15_22_ROOT=/path/to/firebase-tools-15.22.0 node --import tsx src/suite/capture-auth-refresh.ts
```

The 28 HTTP observations cover anonymous, password and custom-token sign-in:
first refresh, reuse of the original grant, four simultaneous requests with that
grant, disabled user, re-enabled user with the original grant, deleted user, and
an unknown grant. Four further HTTP observations come from **Firebase JS SDK
12.18.0 in a real Chromium browser**: forced refresh, concurrent refresh from two
tabs sharing persisted authentication, then reload and forced refresh.

Each observation records exact status, Content-Type, response field names, error
message (where applicable), token relationships and selected decoded JWT claims.
Tokens, user identifiers, passwords and absolute timestamps inside JWTs are not
persisted. This is a semantic credential contract, not a raw credential archive;
HTTP framework header differences are not treated as Auth failures. The fixture
records official source hashes and browser version. SHA256SUMS covers fixture.json.

Observed: refresh grants are reusable and returned unchanged, including under
concurrency. A disabled account gets USER_DISABLED without consuming its grant;
after re-enabling it, the same grant works. Deleted users and unknown grants get
INVALID_REFRESH_TOKEN. Browser operations complete with no page errors.

This is a local-emulator compatibility contract, not a claim about production
Secure Token behavior. The r24 diagnostic did not record credential bodies, so
the fixture does not pretend to reconstruct the exact rejected r24 credentials.
