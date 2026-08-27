use std::path::PathBuf;
use std::process::ExitCode;

use fireside_export_format::{ExportReader, write_export};

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
    let input = arguments
        .next()
        .map(PathBuf::from)
        .ok_or("usage: rewrite_export <overall-metadata> <output-directory>")?;
    let output = arguments
        .next()
        .map(PathBuf::from)
        .ok_or("usage: rewrite_export <overall-metadata> <output-directory>")?;
    if arguments.next().is_some() {
        return Err("usage: rewrite_export <overall-metadata> <output-directory>".into());
    }

    let documents = ExportReader::open(input)?.collect::<Result<Vec<_>, _>>()?;
    let summary = write_export(output, documents)?;
    println!("{}", summary.overall_metadata_path().display());
    Ok(())
}
