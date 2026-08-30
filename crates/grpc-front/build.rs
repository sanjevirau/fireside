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
        .extern_path(".google.protobuf", "::pbjson_types")
        .compile_fds(descriptors.clone())?;
    pbjson_build::Builder::new()
        .register_descriptors(&descriptors.encode_to_vec())?
        .extern_path(".google.protobuf", "::pbjson_types")
        .build(&[".google.firestore.v1", ".google.rpc", ".google.type"])?;

    Ok(())
}
