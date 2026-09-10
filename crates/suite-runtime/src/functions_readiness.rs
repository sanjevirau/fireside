//! Compact identities, never environment/configuration values, cross the
//! owned host's bounded stdout pipe. Discovery is separately fetched and checked.
use std::fmt::Write as _;
use std::time::Duration;

use fireside_functions_bridge::FunctionsInventory;
use serde::Deserialize;
use sha2::{Digest as _, Sha256};

pub(crate) type Signal = Option<Result<Receipt, String>>;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Receipt {
    firebase_tools_version: String,
    inventory_count: usize,
    inventory_sha256: String,
}

impl Receipt {
    pub(crate) fn parse(json: &str) -> Result<Self, String> {
        let receipt: Self = serde_json::from_str(json)
            .map_err(|error| format!("Invalid Functions readiness receipt: {error}"))?;
        if receipt.firebase_tools_version != "15.22.0"
            || receipt.inventory_count == 0
            || receipt.inventory_sha256.len() != 64
            || !receipt
                .inventory_sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err("Invalid Functions readiness version, count or checksum".to_owned());
        }
        Ok(receipt)
    }

    fn verify(&self, inventory: &FunctionsInventory, minimum: usize) -> Result<(), String> {
        let count = inventory.functions().count();
        if count < minimum
            || count != self.inventory_count
            || fingerprint(inventory)? != self.inventory_sha256
        {
            return Err(format!(
                "Functions inventory does not match admitted handlers: received {count}, admitted {}, minimum {minimum}",
                self.inventory_count
            ));
        }
        Ok(())
    }
}

fn fingerprint(inventory: &FunctionsInventory) -> Result<String, String> {
    let mut rows = Vec::new();
    for function in inventory.functions() {
        let region = if function.region.is_empty() {
            function.regions.first().map_or("", String::as_str)
        } else {
            &function.region
        };
        let id = if function.id.is_empty() {
            format!("{region}-{}", function.name)
        } else {
            function.id.clone()
        };
        let identity = [
            id.as_str(),
            function.name.as_str(),
            region,
            function.platform.as_str(),
        ];
        if identity.iter().any(|value| value.is_empty()) {
            return Err("Functions inventory contains an incomplete identity".to_owned());
        }
        rows.push(serde_json::to_string(&identity).map_err(|error| error.to_string())?);
    }
    // Rust string ordering is UTF-8 byte ordering, matching Node Buffer.compare.
    // Keep duplicate rows: an extra handler must change both count and digest.
    rows.sort();
    let bytes = serde_json::to_vec(&rows).map_err(|error| error.to_string())?;
    let mut digest = String::with_capacity(64);
    for byte in Sha256::digest(bytes) {
        write!(digest, "{byte:02x}").map_err(|error| error.to_string())?;
    }
    Ok(digest)
}

pub(crate) async fn discover(
    endpoint: &str,
    receipt: &Receipt,
    minimum: usize,
) -> Result<FunctionsInventory, String> {
    let inventory = tokio::time::timeout(
        Duration::from_secs(5),
        FunctionsInventory::discover(endpoint),
    )
    .await
    .map_err(|_| "Functions inventory request timed out after readiness (5 seconds)".to_owned())?
    .map_err(|error| error.to_string())?;
    receipt.verify(&inventory, minimum)?;
    Ok(inventory)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn captured(mode: &str) -> FunctionsInventory {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../conformance/fixtures/functions-readiness-v1/fixture.json"
        ))
        .unwrap();
        let observation = fixture["observations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["mode"] == mode)
            .unwrap();
        FunctionsInventory {
            backends: serde_json::from_value(observation["inventory"]["backends"].clone()).unwrap(),
        }
    }

    fn receipt(count: usize, sha: &str) -> Receipt {
        Receipt::parse(
            &json!({"firebaseToolsVersion":"15.22.0","inventoryCount":count,"inventorySha256":sha})
                .to_string(),
        )
        .unwrap()
    }

    #[test]
    fn captured_identities_match_node_and_reject_missing_changed_or_duplicate_handlers() {
        let healthy = receipt(
            4,
            "8532cd316320668eb493034eeedce3ae2694a8d31e4c1a2090ffae8083fb95d6",
        );
        let mut inventory = captured("healthy");
        healthy.verify(&inventory, 1).unwrap();
        inventory.backends.reverse();
        healthy.verify(&inventory, 4).unwrap();
        assert!(healthy.verify(&captured("failed-codebase"), 1).is_err());
        assert!(healthy.verify(&inventory, 5).is_err());
        inventory.backends[0].function_triggers[0]
            .name
            .push_str("-changed");
        assert!(healthy.verify(&inventory, 1).is_err());
        let mut duplicate = captured("healthy");
        let extra = duplicate.backends[0].function_triggers[0].clone();
        duplicate.backends[0].function_triggers.push(extra);
        assert!(healthy.verify(&duplicate, 1).is_err());
        receipt(
            1,
            "8aec3fff76586e3233f5ef55609ca4166373b28540ce65eda85a307b72eb4f7a",
        )
        .verify(&captured("predefined-backend"), 1)
        .unwrap();
    }

    #[test]
    fn malformed_or_legacy_ready_markers_do_not_admit_a_minimum_count() {
        for body in [
            "{}",
            "not-json",
            r#"{"firebaseToolsVersion":"15.22.0","inventoryCount":0,"inventorySha256":"bad"}"#,
        ] {
            assert!(Receipt::parse(body).is_err());
        }
    }

    #[tokio::test]
    async fn a_discovery_response_with_a_stalled_body_has_a_bounded_deadline() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let application = axum::Router::new().route(
            "/backends",
            axum::routing::get(|| async {
                axum::body::Body::from_stream(futures_util::stream::pending::<
                    Result<axum::body::Bytes, std::io::Error>,
                >())
            }),
        );
        let server = tokio::spawn(async move {
            axum::serve(listener, application)
                .with_graceful_shutdown(async {
                    let _ = stopped.await;
                })
                .await
                .unwrap();
        });
        let expected = receipt(
            4,
            "8532cd316320668eb493034eeedce3ae2694a8d31e4c1a2090ffae8083fb95d6",
        );
        let result = tokio::time::timeout(
            Duration::from_secs(8),
            discover(&format!("http://{address}/"), &expected, 1),
        )
        .await
        .unwrap();
        assert!(result.unwrap_err().contains("timed out"));
        stop.send(()).unwrap();
        // Hyper can retain the deliberately infinite fixture stream even after
        // its client leaves. Only this owned test server is aborted if needed.
        server.abort();
        let _ = server.await;
    }
}
