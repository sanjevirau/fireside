#![forbid(unsafe_code)]

use std::process::ExitCode;

use clap::{Parser, Subcommand};

#[derive(Debug, Parser)]
#[command(
    name = "fireside",
    version,
    about = "A clean-room local emulator suite grounded in production behavior"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, PartialEq, Eq, Subcommand)]
enum Command {
    /// Start the Firestore-compatible service (implemented in Phase 1).
    Firestore,
    /// Start fixture capture (network interception lands after Phase 0).
    CaptureProxy,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let feature = match cli.command {
        Command::Firestore => "the Firestore-compatible service",
        Command::CaptureProxy => "network capture",
    };

    eprintln!("fireside Phase 0 scaffold: {feature} is not implemented yet");
    ExitCode::FAILURE
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_firestore_command() {
        let cli = Cli::try_parse_from(["fireside", "firestore"]).expect("command should parse");
        assert_eq!(cli.command, Command::Firestore);
    }

    #[test]
    fn parses_capture_proxy_command() {
        let cli = Cli::try_parse_from(["fireside", "capture-proxy"]).expect("command should parse");
        assert_eq!(cli.command, Command::CaptureProxy);
    }
}
