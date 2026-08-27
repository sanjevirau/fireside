use std::error::Error;

const FIRESTORE_SERVICE: &str = "proto/google/firestore/v1/firestore.proto";

fn main() -> Result<(), Box<dyn Error>> {
    println!("cargo:rerun-if-changed=proto");

    let descriptors = protox::compile([FIRESTORE_SERVICE], ["proto"])?;
    tonic_prost_build::configure()
        .build_client(true)
        .build_server(true)
        .compile_fds(descriptors)?;

    Ok(())
}
