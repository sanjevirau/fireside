//! Versioned fixtures for the fireside capture proxy.
//!
//! Phase 0 deliberately implements the durable fixture boundary and mandatory
//! header redaction, but no network interception. Captures must use synthetic
//! data even after interception support lands.

#![forbid(unsafe_code)]

use std::error::Error;
use std::fmt::{self, Display, Formatter};

use serde::{Deserialize, Serialize};

/// The fixture schema written by this crate.
pub const FIXTURE_SCHEMA_VERSION: u32 = 1;

const SENSITIVE_HEADERS: &[&str] = &[
    "authorization",
    "cookie",
    "proxy-authorization",
    "set-cookie",
    "x-api-key",
    "x-firebase-appcheck",
    "x-goog-api-key",
];

/// A replayable sequence of captured request/response exchanges.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureFixture {
    /// Version of the serialized fixture schema.
    pub schema_version: u32,
    /// Provenance required to reproduce and interpret the capture.
    pub metadata: FixtureMetadata,
    /// Exchanges in observed order.
    pub exchanges: Vec<CapturedExchange>,
}

impl CaptureFixture {
    /// Creates an empty fixture using the current schema.
    #[must_use]
    pub const fn new(metadata: FixtureMetadata) -> Self {
        Self {
            schema_version: FIXTURE_SCHEMA_VERSION,
            metadata,
            exchanges: Vec::new(),
        }
    }

    /// Validates schema compatibility and strict exchange ordering.
    pub fn validate(&self) -> Result<(), FixtureValidationError> {
        if self.schema_version != FIXTURE_SCHEMA_VERSION {
            return Err(FixtureValidationError::UnsupportedSchema {
                found: self.schema_version,
            });
        }

        if self
            .exchanges
            .windows(2)
            .any(|pair| pair[0].sequence >= pair[1].sequence)
        {
            return Err(FixtureValidationError::NonIncreasingSequence);
        }

        Ok(())
    }

    /// Redacts sensitive headers from every request and response in place.
    pub fn redact_sensitive_headers(&mut self) {
        for exchange in &mut self.exchanges {
            redact_headers(&mut exchange.request.headers);
            redact_headers(&mut exchange.response.headers);
        }
    }
}

/// Reproduction metadata attached to every fixture.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FixtureMetadata {
    /// Human-readable hypothesis or contract under test.
    pub hypothesis: String,
    /// Target name, such as `java` or an allowlisted cloud target.
    pub target: String,
    /// Target build or emulator version.
    pub target_version: String,
    /// SDK and exact version used to generate traffic.
    pub sdk: String,
    /// RFC 3339 capture time supplied by the harness.
    pub recorded_at: String,
    /// Transport used by the exchange.
    pub transport: Transport,
}

/// Wire transport represented by a fixture.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Transport {
    /// Cleartext or TLS HTTP/1.1.
    Http1,
    /// Cleartext or TLS HTTP/2.
    Http2,
    /// `WebChannel` carried over HTTP.
    WebChannel,
    /// Raw websocket traffic whose contract is still being discovered.
    WebSocket,
}

/// One ordered request and response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturedExchange {
    /// Monotonically increasing sequence number within the fixture.
    pub sequence: u64,
    /// Request message.
    pub request: CapturedRequest,
    /// Response message.
    pub response: CapturedResponse,
}

/// Captured HTTP-like request data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturedRequest {
    /// Request method.
    pub method: String,
    /// Relative URI with a scrubbed query string.
    pub uri: String,
    /// Ordered headers.
    pub headers: Vec<Header>,
    /// Base64-encoded body, if present.
    pub body_base64: Option<String>,
}

/// Captured HTTP-like response data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturedResponse {
    /// HTTP status code.
    pub status: u16,
    /// Ordered headers.
    pub headers: Vec<Header>,
    /// Base64-encoded body, if present.
    pub body_base64: Option<String>,
}

/// An ordered, case-preserving header pair.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Header {
    /// Header name.
    pub name: String,
    /// Header value, or `[REDACTED]` after scrubbing.
    pub value: String,
}

/// Failure returned when a fixture cannot be replayed safely.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FixtureValidationError {
    /// The reader does not support the serialized schema.
    UnsupportedSchema {
        /// Schema version found in the fixture.
        found: u32,
    },
    /// Exchanges are duplicated or out of order.
    NonIncreasingSequence,
}

impl Display for FixtureValidationError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedSchema { found } => {
                write!(formatter, "unsupported capture fixture schema {found}")
            }
            Self::NonIncreasingSequence => {
                formatter.write_str("capture exchange sequence is not strictly increasing")
            }
        }
    }
}

impl Error for FixtureValidationError {}

fn redact_headers(headers: &mut [Header]) {
    for header in headers {
        if SENSITIVE_HEADERS
            .iter()
            .any(|name| header.name.eq_ignore_ascii_case(name))
        {
            "[REDACTED]".clone_into(&mut header.value);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metadata() -> FixtureMetadata {
        FixtureMetadata {
            hypothesis: "unknown sessions return the observed error".to_owned(),
            target: "java".to_owned(),
            target_version: "example".to_owned(),
            sdk: "example-sdk@1.0.0".to_owned(),
            recorded_at: "2026-08-27T00:00:00Z".to_owned(),
            transport: Transport::WebChannel,
        }
    }

    fn exchange(sequence: u64) -> CapturedExchange {
        CapturedExchange {
            sequence,
            request: CapturedRequest {
                method: "POST".to_owned(),
                uri: "/channel".to_owned(),
                headers: vec![Header {
                    name: "Authorization".to_owned(),
                    value: "Bearer synthetic".to_owned(),
                }],
                body_base64: None,
            },
            response: CapturedResponse {
                status: 200,
                headers: Vec::new(),
                body_base64: Some("W10=".to_owned()),
            },
        }
    }

    #[test]
    fn fixture_round_trips_through_json() {
        let mut fixture = CaptureFixture::new(metadata());
        fixture.exchanges.push(exchange(1));

        let encoded = serde_json::to_string_pretty(&fixture).expect("fixture should serialize");
        let decoded: CaptureFixture =
            serde_json::from_str(&encoded).expect("fixture should deserialize");

        assert_eq!(decoded, fixture);
        assert_eq!(decoded.validate(), Ok(()));
    }

    #[test]
    fn redaction_is_case_insensitive() {
        let mut fixture = CaptureFixture::new(metadata());
        fixture.exchanges.push(exchange(1));

        fixture.redact_sensitive_headers();

        assert_eq!(fixture.exchanges[0].request.headers[0].value, "[REDACTED]");
    }

    #[test]
    fn validation_rejects_duplicate_or_reversed_sequences() {
        let mut fixture = CaptureFixture::new(metadata());
        fixture.exchanges = vec![exchange(2), exchange(2)];

        assert_eq!(
            fixture.validate(),
            Err(FixtureValidationError::NonIncreasingSequence)
        );
    }
}
