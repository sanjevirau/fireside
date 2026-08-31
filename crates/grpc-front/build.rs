use std::error::Error;

use prost::Message as _;

const FIRESTORE_SERVICE: &str = "proto/google/firestore/v1/firestore.proto";

fn main() -> Result<(), Box<dyn Error>> {
    println!("cargo:rerun-if-changed=proto");

    let descriptors = protox::compile([FIRESTORE_SERVICE], ["proto"])?;
    tonic_prost_build::configure()
        .build_client(true)
        .build_server(true)
        .compile_well_known_types(true)
        .extern_path(".google.protobuf.Any", "::pbjson_types::Any")
        .extern_path(
            ".google.protobuf.DoubleValue",
            "::pbjson_types::DoubleValue",
        )
        .extern_path(".google.protobuf.Duration", "::pbjson_types::Duration")
        .extern_path(".google.protobuf.Empty", "::pbjson_types::Empty")
        .extern_path(".google.protobuf.Int32Value", "::pbjson_types::Int32Value")
        .extern_path(".google.protobuf.Int64Value", "::pbjson_types::Int64Value")
        .extern_path(
            ".google.protobuf.StringValue",
            "::pbjson_types::StringValue",
        )
        .extern_path(".google.protobuf.Struct", "::pbjson_types::Struct")
        .extern_path(".google.protobuf.Timestamp", "::pbjson_types::Timestamp")
        .compile_fds(descriptors.clone())?;
    pbjson_build::Builder::new()
        .register_descriptors(&descriptors.encode_to_vec())?
        .extern_path(".google.protobuf.Any", "::pbjson_types::Any")
        .extern_path(
            ".google.protobuf.DoubleValue",
            "::pbjson_types::DoubleValue",
        )
        .extern_path(".google.protobuf.Duration", "::pbjson_types::Duration")
        .extern_path(".google.protobuf.Empty", "::pbjson_types::Empty")
        .extern_path(".google.protobuf.Int32Value", "::pbjson_types::Int32Value")
        .extern_path(".google.protobuf.Int64Value", "::pbjson_types::Int64Value")
        .extern_path(
            ".google.protobuf.StringValue",
            "::pbjson_types::StringValue",
        )
        .extern_path(".google.protobuf.Struct", "::pbjson_types::Struct")
        .extern_path(".google.protobuf.Timestamp", "::pbjson_types::Timestamp")
        .build(&[
            ".google.firestore.v1",
            ".google.protobuf.NullValue",
            ".google.rpc",
            ".google.type",
        ])?;

    Ok(())
}
