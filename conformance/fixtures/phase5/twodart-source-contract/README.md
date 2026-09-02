# Twodart Phase 5 source oracle

This fixture freezes the browser-visible routes, the concrete `/login/overview` login
variant, stable login selectors, the TwodartNet `/api/HealthCheck` readiness endpoint,
local OTP API, admin navigation inventory, and ordered acceptance journeys observed in
the readable Twodart source at the exact Phase 5 candidate revision.

It contains only contract metadata and source hashes. It intentionally contains no
dataset values, user identifiers, OTP values, credentials, access tokens, or provider
secrets. Live measurements and browser/network traces belong in the checksummed Phase 5
gate evidence, not in this oracle fixture.
