use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::io::{self, Read, Write};

const BLOCK_BYTES: usize = 32 * 1_024;
const HEADER_BYTES: usize = 7;
const CRC_MASK_DELTA: u32 = 0xa282_ead8;

/// Resource limits for untrusted export logs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LogOptions {
    /// Maximum reassembled logical record size.
    pub max_record_bytes: usize,
}

impl Default for LogOptions {
    fn default() -> Self {
        Self {
            max_record_bytes: 16 * 1_024 * 1_024,
        }
    }
}

/// Streaming reader for 32 KiB `LevelDB` log blocks.
pub struct LevelDbLogReader<R> {
    reader: R,
    options: LogOptions,
    block: Box<[u8]>,
    block_len: usize,
    block_position: usize,
    blocks_loaded: u64,
    assembly: Option<Vec<u8>>,
}

impl<R: Read> LevelDbLogReader<R> {
    /// Creates a bounded reader.
    #[must_use]
    pub fn new(reader: R, options: LogOptions) -> Self {
        Self {
            reader,
            options,
            block: vec![0; BLOCK_BYTES].into_boxed_slice(),
            block_len: 0,
            block_position: 0,
            blocks_loaded: 0,
            assembly: None,
        }
    }

    /// Reads and reassembles the next logical record.
    pub fn next_record(&mut self) -> Result<Option<Vec<u8>>, LogError> {
        loop {
            let Some(fragment) = self.next_fragment()? else {
                if self.assembly.is_some() {
                    return Err(LogError::IncompleteRecord);
                }
                return Ok(None);
            };
            match fragment.kind {
                FragmentKind::Full => {
                    if self.assembly.is_some() {
                        return Err(LogError::InvalidSequence(
                            "FULL fragment interrupted an assembled record",
                        ));
                    }
                    self.check_record_size(fragment.payload.len())?;
                    return Ok(Some(fragment.payload));
                }
                FragmentKind::First => {
                    if self.assembly.is_some() {
                        return Err(LogError::InvalidSequence(
                            "FIRST fragment interrupted an assembled record",
                        ));
                    }
                    self.check_record_size(fragment.payload.len())?;
                    self.assembly = Some(fragment.payload);
                }
                FragmentKind::Middle => {
                    self.append_fragment(fragment.payload, "MIDDLE without FIRST")?;
                }
                FragmentKind::Last => {
                    self.append_fragment(fragment.payload, "LAST without FIRST")?;
                    return Ok(self.assembly.take());
                }
            }
        }
    }

    fn append_fragment(
        &mut self,
        payload: Vec<u8>,
        missing_first: &'static str,
    ) -> Result<(), LogError> {
        let current = self
            .assembly
            .as_ref()
            .ok_or(LogError::InvalidSequence(missing_first))?
            .len();
        let next = current
            .checked_add(payload.len())
            .ok_or(LogError::RecordTooLarge {
                maximum: self.options.max_record_bytes,
            })?;
        self.check_record_size(next)?;
        self.assembly
            .as_mut()
            .expect("assembly was checked above")
            .extend(payload);
        Ok(())
    }

    fn check_record_size(&self, size: usize) -> Result<(), LogError> {
        if size > self.options.max_record_bytes {
            Err(LogError::RecordTooLarge {
                maximum: self.options.max_record_bytes,
            })
        } else {
            Ok(())
        }
    }

    fn next_fragment(&mut self) -> Result<Option<PhysicalFragment>, LogError> {
        loop {
            if self.block_position == self.block_len && !self.load_block()? {
                return Ok(None);
            }
            let remaining = self.block_len - self.block_position;
            if remaining < HEADER_BYTES {
                if self.block[self.block_position..self.block_len]
                    .iter()
                    .any(|byte| *byte != 0)
                {
                    return Err(LogError::TruncatedHeader {
                        offset: self.absolute_offset(),
                    });
                }
                self.block_position = self.block_len;
                continue;
            }

            let offset = self.absolute_offset();
            let header = &self.block[self.block_position..self.block_position + HEADER_BYTES];
            let checksum = u32::from_le_bytes(header[..4].try_into().expect("four-byte checksum"));
            let length = usize::from(u16::from_le_bytes(
                header[4..6].try_into().expect("two-byte length"),
            ));
            let raw_kind = header[6];
            if checksum == 0 && length == 0 && raw_kind == 0 {
                if self.block[self.block_position..self.block_len]
                    .iter()
                    .any(|byte| *byte != 0)
                {
                    return Err(LogError::InvalidFragmentType { value: 0, offset });
                }
                self.block_position = self.block_len;
                continue;
            }
            let payload_start = self.block_position + HEADER_BYTES;
            let payload_end = payload_start
                .checked_add(length)
                .ok_or(LogError::TruncatedPayload { offset })?;
            if payload_end > self.block_len {
                return Err(LogError::TruncatedPayload { offset });
            }
            let kind = FragmentKind::try_from(raw_kind)
                .map_err(|value| LogError::InvalidFragmentType { value, offset })?;
            let payload = &self.block[payload_start..payload_end];
            let actual = masked_crc(kind, payload);
            if actual != checksum {
                return Err(LogError::ChecksumMismatch {
                    offset,
                    expected: checksum,
                    actual,
                });
            }
            self.block_position = payload_end;
            return Ok(Some(PhysicalFragment {
                kind,
                payload: payload.to_vec(),
            }));
        }
    }

    fn load_block(&mut self) -> Result<bool, LogError> {
        self.block_len = 0;
        self.block_position = 0;
        while self.block_len < BLOCK_BYTES {
            let read = self.reader.read(&mut self.block[self.block_len..])?;
            if read == 0 {
                break;
            }
            self.block_len += read;
        }
        if self.block_len == 0 {
            return Ok(false);
        }
        self.blocks_loaded = self.blocks_loaded.saturating_add(1);
        Ok(true)
    }

    fn absolute_offset(&self) -> u64 {
        self.blocks_loaded
            .saturating_sub(1)
            .saturating_mul(u64::try_from(BLOCK_BYTES).expect("block size fits u64"))
            .saturating_add(u64::try_from(self.block_position).unwrap_or(u64::MAX))
    }
}

/// Streaming writer for `LevelDB` log records.
pub struct LevelDbLogWriter<W> {
    writer: W,
    block_position: usize,
}

impl<W: Write> LevelDbLogWriter<W> {
    /// Creates a writer at the start of a log block.
    #[must_use]
    pub const fn new(writer: W) -> Self {
        Self {
            writer,
            block_position: 0,
        }
    }

    /// Writes one logical record, fragmenting it across 32 KiB blocks.
    pub fn write_record(&mut self, record: &[u8]) -> io::Result<()> {
        let mut position = 0;
        let mut first = true;
        loop {
            let remaining_in_block = BLOCK_BYTES - self.block_position;
            if remaining_in_block < HEADER_BYTES {
                self.writer.write_all(&vec![0; remaining_in_block])?;
                self.block_position = 0;
            }

            let capacity = BLOCK_BYTES - self.block_position - HEADER_BYTES;
            let remaining = record.len() - position;
            let length = remaining.min(capacity);
            let last = length == remaining;
            let kind = match (first, last) {
                (true, true) => FragmentKind::Full,
                (true, false) => FragmentKind::First,
                (false, false) => FragmentKind::Middle,
                (false, true) => FragmentKind::Last,
            };
            let payload = &record[position..position + length];
            let checksum = masked_crc(kind, payload);
            let mut header = [0_u8; HEADER_BYTES];
            header[..4].copy_from_slice(&checksum.to_le_bytes());
            let physical_length = u16::try_from(length).map_err(|_| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    "physical fragment length exceeds u16",
                )
            })?;
            header[4..6].copy_from_slice(&physical_length.to_le_bytes());
            header[6] = kind as u8;
            self.writer.write_all(&header)?;
            self.writer.write_all(payload)?;
            self.block_position += HEADER_BYTES + length;
            if self.block_position == BLOCK_BYTES {
                self.block_position = 0;
            }
            if last {
                return Ok(());
            }
            position += length;
            first = false;
        }
    }

    /// Flushes the underlying writer.
    pub fn flush(&mut self) -> io::Result<()> {
        self.writer.flush()
    }

    /// Returns the underlying writer.
    #[must_use]
    pub fn into_inner(self) -> W {
        self.writer
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
enum FragmentKind {
    Full = 1,
    First = 2,
    Middle = 3,
    Last = 4,
}

impl TryFrom<u8> for FragmentKind {
    type Error = u8;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            1 => Ok(Self::Full),
            2 => Ok(Self::First),
            3 => Ok(Self::Middle),
            4 => Ok(Self::Last),
            value => Err(value),
        }
    }
}

struct PhysicalFragment {
    kind: FragmentKind,
    payload: Vec<u8>,
}

fn masked_crc(kind: FragmentKind, payload: &[u8]) -> u32 {
    let crc = crc32c::crc32c_append(0, &[kind as u8]);
    let crc = crc32c::crc32c_append(crc, payload);
    crc.rotate_right(15).wrapping_add(CRC_MASK_DELTA)
}

/// Invalid or unreadable `LevelDB` log data.
#[derive(Debug)]
pub enum LogError {
    Io(io::Error),
    TruncatedHeader {
        offset: u64,
    },
    TruncatedPayload {
        offset: u64,
    },
    InvalidFragmentType {
        value: u8,
        offset: u64,
    },
    ChecksumMismatch {
        offset: u64,
        expected: u32,
        actual: u32,
    },
    InvalidSequence(&'static str),
    IncompleteRecord,
    RecordTooLarge {
        maximum: usize,
    },
}

impl Display for LogError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => Display::fmt(error, formatter),
            Self::TruncatedHeader { offset } => {
                write!(formatter, "truncated log header at byte {offset}")
            }
            Self::TruncatedPayload { offset } => {
                write!(formatter, "truncated log payload at byte {offset}")
            }
            Self::InvalidFragmentType { value, offset } => {
                write!(formatter, "invalid fragment type {value} at byte {offset}")
            }
            Self::ChecksumMismatch {
                offset,
                expected,
                actual,
            } => write!(
                formatter,
                "checksum mismatch at byte {offset}: expected {expected:#010x}, got {actual:#010x}"
            ),
            Self::InvalidSequence(message) => formatter.write_str(message),
            Self::IncompleteRecord => formatter.write_str("log ended during a fragmented record"),
            Self::RecordTooLarge { maximum } => {
                write!(formatter, "logical record exceeds {maximum} bytes")
            }
        }
    }
}

impl Error for LogError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            _ => None,
        }
    }
}

impl From<io::Error> for LogError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

#[cfg(test)]
mod tests {
    use std::fs::File;

    use super::*;

    const ORACLE: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../conformance/fixtures/official-export-v1.22.0/",
        "firestore_export/all_namespaces/all_kinds/output-0"
    );

    #[test]
    fn official_artifact_round_trips_byte_for_byte() {
        let original = std::fs::read(ORACLE).expect("oracle fixture should exist");
        let mut reader = LevelDbLogReader::new(
            File::open(ORACLE).expect("oracle fixture should open"),
            LogOptions::default(),
        );
        let mut records = Vec::new();
        while let Some(record) = reader.next_record().expect("oracle log should decode") {
            records.push(record);
        }
        assert_eq!(records.len(), 3);
        assert!(records[0].len() > BLOCK_BYTES * 4);

        let mut writer = LevelDbLogWriter::new(Vec::new());
        for record in &records {
            writer.write_record(record).expect("record should encode");
        }
        let rewritten = writer.into_inner();
        assert_eq!(rewritten, original);
    }

    #[test]
    fn checksum_corruption_is_rejected() {
        let mut log = Vec::new();
        LevelDbLogWriter::new(&mut log)
            .write_record(b"synthetic record")
            .expect("record should encode");
        log[HEADER_BYTES] ^= 0x80;
        let error = LevelDbLogReader::new(log.as_slice(), LogOptions::default())
            .next_record()
            .expect_err("corruption should fail");
        assert!(matches!(error, LogError::ChecksumMismatch { .. }));
    }

    #[test]
    fn configured_record_limit_is_enforced_while_reassembling() {
        let record = vec![42; BLOCK_BYTES * 2];
        let mut log = Vec::new();
        LevelDbLogWriter::new(&mut log)
            .write_record(&record)
            .expect("record should encode");
        let error = LevelDbLogReader::new(
            log.as_slice(),
            LogOptions {
                max_record_bytes: BLOCK_BYTES,
            },
        )
        .next_record()
        .expect_err("oversized record should fail");
        assert!(matches!(error, LogError::RecordTooLarge { .. }));
    }
}
