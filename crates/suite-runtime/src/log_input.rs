//! Drain arbitrary child output without accumulating an unbounded line.
use std::io;
use tokio::io::{AsyncBufRead, AsyncBufReadExt as _};

const MAXIMUM_LINE_BYTES: usize = 8192;

pub(super) async fn next<R: AsyncBufRead + Unpin>(reader: &mut R) -> io::Result<Option<String>> {
    let mut line = Vec::new();
    let mut omitted = false;
    let mut saw_bytes = false;
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return Ok(saw_bytes.then(|| decode(line, omitted)));
        }
        saw_bytes = true;
        let newline = available.iter().position(|byte| *byte == b'\n');
        let count = newline.unwrap_or(available.len());
        if !omitted {
            if line.len().saturating_add(count) > MAXIMUM_LINE_BYTES {
                line.clear();
                omitted = true;
            } else {
                line.extend_from_slice(&available[..count]);
            }
        }
        reader.consume(count + usize::from(newline.is_some()));
        if newline.is_some() {
            return Ok(Some(decode(line, omitted)));
        }
    }
}

fn decode(mut bytes: Vec<u8>, omitted: bool) -> String {
    if omitted {
        return "Oversized Functions log line omitted; payload was not retained".into();
    }
    if bytes.last() == Some(&b'\r') {
        bytes.pop();
    }
    String::from_utf8(bytes).unwrap_or_else(|_| {
        "Invalid UTF-8 Functions log line omitted; payload was not retained".into()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::BufReader;

    #[tokio::test]
    async fn bounded_child_lines_drain_oversized_and_invalid_data_then_resume() {
        let contract: serde_json::Value =
            serde_json::from_str(include_str!("../../../benchmarks/phase-b-logging.json")).unwrap();
        assert_eq!(contract["maximumInputLineBytes"], MAXIMUM_LINE_BYTES);
        let mut input = "hello 火🔥\r\n".as_bytes().to_vec();
        input.extend(vec![b'x'; MAXIMUM_LINE_BYTES + 1]);
        input.extend(b"\n\xff\nready\nlast");
        let mut reader = BufReader::with_capacity(7, input.as_slice());
        assert_eq!(next(&mut reader).await.unwrap().unwrap(), "hello 火🔥");
        assert!(
            next(&mut reader)
                .await
                .unwrap()
                .unwrap()
                .starts_with("Oversized")
        );
        assert!(
            next(&mut reader)
                .await
                .unwrap()
                .unwrap()
                .starts_with("Invalid UTF-8")
        );
        assert_eq!(next(&mut reader).await.unwrap().unwrap(), "ready");
        assert_eq!(next(&mut reader).await.unwrap().unwrap(), "last");
        assert_eq!(next(&mut reader).await.unwrap(), None);
    }

    #[tokio::test]
    async fn exact_limit_and_empty_lines_are_preserved() {
        let input = format!("\n{}\n", "x".repeat(MAXIMUM_LINE_BYTES));
        let mut reader = BufReader::with_capacity(13, input.as_bytes());
        assert_eq!(next(&mut reader).await.unwrap(), Some(String::new()));
        assert_eq!(
            next(&mut reader).await.unwrap().unwrap().len(),
            MAXIMUM_LINE_BYTES
        );
        assert_eq!(next(&mut reader).await.unwrap(), None);
    }
}
