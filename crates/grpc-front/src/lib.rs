//! Firestore gRPC transport for fireside.
//!
//! The vendored Apache-2.0 Google API definitions are compiled with a pure
//! Rust protocol compiler, keeping builds reproducible without `protoc`.

#![forbid(unsafe_code)]

mod codec;
mod listen;
mod pipeline;
mod query_codec;
mod service;
mod write_stream;

pub use service::{FirestoreService, ResponseStream};

/// Generated Google API protocol types and Firestore client/server contracts.
pub mod google {
    /// Shared Google API annotations used by the Firestore descriptor graph.
    #[allow(clippy::all, clippy::pedantic)]
    pub mod api {
        tonic::include_proto!("google.api");
    }

    /// Firestore v1 protocol types and complete service definition.
    pub mod firestore {
        /// The production `google.firestore.v1.Firestore` API.
        #[allow(clippy::all, clippy::pedantic)]
        pub mod v1 {
            tonic::include_proto!("google.firestore.v1");
        }
    }

    /// Shared Google RPC status types.
    #[allow(clippy::all, clippy::pedantic)]
    pub mod rpc {
        tonic::include_proto!("google.rpc");
    }

    /// Shared Google geographic types.
    #[allow(clippy::all, clippy::pedantic)]
    pub mod r#type {
        tonic::include_proto!("google.r#type");
    }
}

#[cfg(test)]
mod tests {
    use prost::Message as _;

    use super::google::firestore::v1::{GetDocumentRequest, Value, value};

    #[test]
    fn generated_types_preserve_named_database_resource_paths() {
        let request = GetDocumentRequest {
            name: "projects/demo/databases/tenant-a/documents/cities/kl".to_owned(),
            ..GetDocumentRequest::default()
        };

        let decoded = GetDocumentRequest::decode(request.encode_to_vec().as_slice())
            .expect("generated request should round-trip");
        assert_eq!(decoded.name, request.name);
    }

    #[test]
    fn generated_values_preserve_int64_without_json_rounding() {
        let value = Value {
            value_type: Some(value::ValueType::IntegerValue(i64::MAX)),
        };

        let decoded = Value::decode(value.encode_to_vec().as_slice())
            .expect("generated value should round-trip");
        assert_eq!(decoded, value);
    }
}
