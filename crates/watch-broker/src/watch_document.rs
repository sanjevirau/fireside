use std::borrow::Cow;
use std::sync::{Arc, OnceLock};

use fireside_core_store::{Document, DocumentKey, Fields, Value, fields_logical_bytes};

/// A document as visible through a target, including a possible projection.
/// Disk views retain exact encoded values; emitted clones decode on demand.
#[derive(Debug, Clone)]
pub struct WatchDocument {
    pub(super) key: DocumentKey,
    payload: Payload,
}

#[derive(Debug, Clone)]
enum Payload {
    // Memory snapshots already share these documents. Encoding them would add
    // another copy rather than release the store's decoded allocation.
    Shared(Decoded),
    Compact(Compact),
}

#[derive(Debug, Clone, PartialEq)]
struct Decoded {
    document: Arc<Document>,
    projected_fields: Option<Fields>,
}

impl Decoded {
    fn fields(&self) -> &Fields {
        self.projected_fields
            .as_ref()
            .unwrap_or_else(|| self.document.fields())
    }
}

#[derive(Debug)]
struct Compact {
    bytes: Arc<[u8]>,
    field_logical_bytes: u64,
    has_nan: bool,
    decoded: OnceLock<Decoded>,
}

impl Clone for Compact {
    fn clone(&self) -> Self {
        Self {
            bytes: self.bytes.clone(),
            field_logical_bytes: self.field_logical_bytes,
            has_nan: self.has_nan,
            // Never share a materialized outgoing response with retained state.
            decoded: OnceLock::new(),
        }
    }
}

impl Compact {
    fn decode(&self) -> Decoded {
        let ((document, projected_fields), consumed): ((Document, Option<Fields>), _) =
            bincode::decode_from_slice(&self.bytes, bincode::config::standard())
                .expect("watch bytes were encoded internally from typed document values");
        debug_assert_eq!(consumed, self.bytes.len());
        Decoded {
            document: Arc::new(document),
            projected_fields,
        }
    }
}

impl WatchDocument {
    pub(super) fn new(
        key: DocumentKey,
        document: Arc<Document>,
        projected_fields: Option<Fields>,
        compact: bool,
    ) -> Self {
        let decoded = Decoded {
            document,
            projected_fields,
        };
        let payload = if compact {
            let bytes = bincode::encode_to_vec(
                (decoded.document.as_ref(), decoded.projected_fields.as_ref()),
                bincode::config::standard(),
            )
            .expect("typed watch values have an infallible in-memory encoding");
            Payload::Compact(Compact {
                bytes: bytes.into(),
                field_logical_bytes: fields_logical_bytes(decoded.fields()),
                has_nan: decoded.document.fields().values().any(has_nan)
                    || decoded
                        .projected_fields
                        .as_ref()
                        .is_some_and(|fields| fields.values().any(has_nan)),
                decoded: OnceLock::new(),
            })
        } else {
            Payload::Shared(decoded)
        };
        Self { key, payload }
    }

    fn decoded(&self) -> &Decoded {
        match &self.payload {
            Payload::Shared(decoded) => decoded,
            Payload::Compact(compact) => compact.decoded.get_or_init(|| compact.decode()),
        }
    }

    // Comparison must not materialize the retained target. Byte inequality can
    // still mean equal values (+0.0/-0.0), so decode exactly on that slow path.
    fn comparison_view(&self) -> Cow<'_, Decoded> {
        match &self.payload {
            Payload::Shared(decoded) => Cow::Borrowed(decoded),
            Payload::Compact(compact) => Cow::Owned(compact.decode()),
        }
    }

    /// Document key.
    #[must_use]
    pub const fn key(&self) -> &DocumentKey {
        &self.key
    }

    /// Stored timestamps and complete document state.
    #[must_use]
    pub fn document(&self) -> &Arc<Document> {
        &self.decoded().document
    }

    /// Fields visible through the target projection.
    #[must_use]
    pub fn fields(&self) -> &Fields {
        self.decoded().fields()
    }

    pub(super) fn field_logical_bytes(&self) -> u64 {
        match &self.payload {
            Payload::Shared(decoded) => fields_logical_bytes(decoded.fields()),
            Payload::Compact(compact) => compact.field_logical_bytes,
        }
    }
}

impl PartialEq for WatchDocument {
    fn eq(&self, other: &Self) -> bool {
        if self.key != other.key {
            return false;
        }
        if let (Payload::Compact(left), Payload::Compact(right)) = (&self.payload, &other.payload)
            && left.bytes == right.bytes
        {
            // Retain existing PartialEq semantics, including NaN != NaN.
            return !left.has_nan;
        }
        self.comparison_view() == other.comparison_view()
    }
}

fn has_nan(value: &Value) -> bool {
    match value {
        Value::Double(value) => value.is_nan(),
        Value::GeoPoint {
            latitude,
            longitude,
        } => latitude.is_nan() || longitude.is_nan(),
        Value::Vector(values) => values.iter().any(|value| value.is_nan()),
        Value::Array(values) => values.iter().any(has_nan),
        Value::Map(fields) => fields.values().any(has_nan),
        _ => false,
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod target_tests;
