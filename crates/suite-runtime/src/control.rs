//! Private launcher-owned stdin control; not a network or Firebase API.
use std::io::BufRead;

use crate::{SuiteRuntimeError, failure};

fn read_shutdown(input: impl BufRead) -> std::io::Result<()> {
    let mut line = Vec::new();
    input.take(64).read_until(b'\n', &mut line)?;
    if line.is_empty() || line == b"FIRESIDE_SHUTDOWN\n" || line == b"FIRESIDE_SHUTDOWN\r\n" {
        Ok(())
    } else {
        Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "invalid private shutdown command",
        ))
    }
}

/// Waits for console shutdown, or the explicitly opted-in launcher's private pipe.
/// EOF also requests export-first shutdown when the launcher disappears.
pub async fn wait_for_shutdown() -> Result<(), SuiteRuntimeError> {
    if std::env::var_os("FIRESIDE_CONTROL_STDIN").as_deref() != Some(std::ffi::OsStr::new("1")) {
        return crate::shutdown_signal().await;
    }
    let (sender, receiver) = tokio::sync::oneshot::channel();
    // A detached OS thread avoids a blocking Tokio stdin task preventing
    // runtime shutdown when Ctrl-C wins the select while stdin remains open.
    std::thread::Builder::new()
        .name("fireside-control".to_owned())
        .spawn(move || {
            let _ = sender.send(read_shutdown(std::io::stdin().lock()));
        })
        .map_err(|error| failure(format!("cannot monitor launcher pipe: {error}")))?;
    tokio::select! {
        signal = crate::shutdown_signal() => signal,
        result = receiver => result
            .map_err(|error| failure(format!("launcher monitor failed: {error}")))?
            .map_err(|error| failure(format!("launcher control failed: {error}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::read_shutdown;

    #[test]
    fn bounded_control_accepts_shutdown_or_disconnect_not_arbitrary_input() {
        for input in [
            b"".as_slice(),
            b"FIRESIDE_SHUTDOWN\n",
            b"FIRESIDE_SHUTDOWN\r\n",
        ] {
            assert!(read_shutdown(input).is_ok());
        }
        for input in [b"do something\n".as_slice(), &[b'x'; 128]] {
            assert!(read_shutdown(input).is_err());
        }
    }
}
