# Twodart Phase 5 source oracle

This fixture freezes the browser-visible routes, the concrete `/login/overview` login
variant, stable login selectors, the TwodartNet `/api/HealthCheck` readiness endpoint,
local OTP API, admin navigation inventory, and ordered acceptance journeys observed in
the readable Twodart source at the exact Phase 5 candidate revision. It also pins the
signed-out dynamic-route behavior, its module-local canonical bootstrap path, and the
cache watcher's server/browser port handoff that the tiny diagnostic smoke exercises.

The 2026-09-03 pin includes the five Mac-verified fixes: stable form ids after
MobX bindings, InputOTP id forwarding, missing header/slide/footer arrays, and
re-fetching coreFreeSlideIds when the general collection changes. This is an
application-source pin, not a claim that the Linux differential gate has passed.

It contains only contract metadata and source hashes. It intentionally contains no
dataset values, user identifiers, OTP values, credentials, access tokens, or provider
secrets. Live measurements and browser/network traces belong in the checksummed Phase 5
gate evidence, not in this oracle fixture.
