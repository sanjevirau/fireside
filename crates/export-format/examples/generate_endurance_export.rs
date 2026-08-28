use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use fireside_core_store::{DatabaseName, DocumentKey, Value};
use fireside_export_format::{ExportedDocument, write_export};

const PROJECT_ID: &str = "demo-fireside-endurance-import";
const DATABASE_ID: &str = "(default)";

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut arguments = std::env::args_os().skip(1);
    let output = arguments
        .next()
        .map(PathBuf::from)
        .ok_or("usage: generate_endurance_export <output-directory> <count> <payload-bytes>")?;
    let count = parse_u64(arguments.next(), "count")?;
    let payload_bytes = parse_usize(arguments.next(), "payload-bytes")?;
    if arguments.next().is_some() {
        return Err(
            "usage: generate_endurance_export <output-directory> <count> <payload-bytes>".into(),
        );
    }

    let database = DatabaseName::new(PROJECT_ID, DATABASE_ID)?;
    let documents = EnduranceDocuments {
        database,
        next: 0,
        count,
        payload: Arc::from(vec![0x5a; payload_bytes]),
    };
    let summary = write_export(output, documents)?;
    println!(
        "{}\t{}\t{}",
        summary.overall_metadata_path().display(),
        summary.entity_count(),
        summary.byte_count()
    );
    Ok(())
}

fn parse_u64(value: Option<std::ffi::OsString>, name: &str) -> Result<u64, String> {
    value
        .and_then(|value| value.into_string().ok())
        .ok_or_else(|| format!("missing UTF-8 {name}"))?
        .parse()
        .map_err(|error| format!("invalid {name}: {error}"))
}

fn parse_usize(value: Option<std::ffi::OsString>, name: &str) -> Result<usize, String> {
    let value = parse_u64(value, name)?;
    usize::try_from(value).map_err(|_| format!("{name} does not fit usize"))
}

struct EnduranceDocuments {
    database: DatabaseName,
    next: u64,
    count: u64,
    payload: Arc<[u8]>,
}

impl Iterator for EnduranceDocuments {
    type Item = ExportedDocument;

    fn next(&mut self) -> Option<Self::Item> {
        if self.next >= self.count {
            return None;
        }
        let ordinal = self.next;
        self.next += 1;
        let key = DocumentKey::new(
            self.database.clone(),
            format!("phase1_import/document-{ordinal:08}"),
        )
        .expect("generated endurance document paths are valid");
        let mut fields = BTreeMap::new();
        fields.insert(
            "ordinal".to_owned(),
            Value::Integer(i64::try_from(ordinal).expect("endurance ordinal fits i64")),
        );
        fields.insert("payload".to_owned(), Value::Bytes(self.payload.clone()));
        Some(ExportedDocument::new(key, fields))
    }
}
