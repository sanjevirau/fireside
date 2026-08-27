# fireside capture proxy

Phase 0 defines the versioned, redaction-aware fixture schema used by the future
recording proxy. Network interception and TLS support are intentionally not yet
implemented; they require scoped synthetic capture cases in later phases.

Fixtures must contain synthetic data only. Redaction is defense in depth, not
permission to record credentials or production user data.
