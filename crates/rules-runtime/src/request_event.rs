//! Borrowed Requests serialization: documents are never cloned into a JSON tree.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use fireside_core_store::Write;
use fireside_rules_engine::{
    AllowDecision, Auth, EvaluationRequest, EvaluationResult, EvaluationTrace, RequestOperation,
    Resource, Timestamp, Value,
};
use serde::ser::{Error as _, SerializeMap};
use serde::{Serialize, Serializer};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::InstalledRules;
use crate::request_history::RequestHistory;

#[path = "request_event_metadata.rs"]
mod metadata;

#[derive(Clone, Copy, Default)]
pub(crate) struct Metadata<'a> {
    pub in_read_write_transaction: bool,
    pub write: Option<&'a Write>,
}

static NEXT_EVENT: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
pub(crate) struct RequestRecorder {
    history: RequestHistory,
    identity: Arc<str>,
}

impl RequestRecorder {
    pub(crate) fn new(history: RequestHistory) -> Self {
        let time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        Self {
            history,
            identity: format!("fireside-{}-{time}", std::process::id()).into(),
        }
    }

    pub(crate) fn record(
        &self,
        project: &str,
        installed: &InstalledRules,
        request: &EvaluationRequest,
        result: &EvaluationResult,
        trace: &EvaluationTrace,
        metadata: Metadata<'_>,
    ) {
        let id = format!(
            "{}-{}",
            self.identity,
            NEXT_EVENT.fetch_add(1, Ordering::Relaxed)
        );
        let release = format!(
            "projects/{project}/releases/cloud.firestore-{}",
            installed.source_hash
        );
        // All recursive serialization happens under RequestHistory's nonblocking
        // admission and capped writer. A failed serialization increments omissions.
        let _ = self.history.record(&RequestEvent {
            rules: installed.rules.source(),
            time: DebugTime(request.time),
            rules_release_key: &release,
            request_id: &id,
            outcome: if result.allowed {
                "allow"
            } else if result.error.is_some() {
                "error"
            } else {
                "deny"
            },
            granular_allow_outcomes: Outcomes(trace),
            rules_context: Context { request, metadata },
        });
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RequestEvent<'a> {
    rules: &'a str,
    time: DebugTime,
    rules_release_key: &'a str,
    request_id: &'a str,
    outcome: &'static str,
    granular_allow_outcomes: Outcomes<'a>,
    rules_context: Context<'a>,
}

struct Outcomes<'a>(&'a EvaluationTrace);
impl Serialize for Outcomes<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        struct Outcome {
            line: usize,
            outcome: bool,
        }
        if self.0.omitted_outcomes() != 0 {
            return Err(S::Error::custom("incomplete allow trace"));
        }
        s.collect_seq(self.0.outcomes().iter().map(|v| Outcome {
            line: v.location.line,
            outcome: v.decision == AllowDecision::Allow,
        }))
    }
}

fn tagged<S: Serializer, T: Serialize + ?Sized>(
    s: S,
    name: &'static str,
    value: &T,
) -> Result<S::Ok, S::Error> {
    let mut map = s.serialize_map(Some(1))?;
    map.serialize_entry(name, value)?;
    map.end()
}

#[derive(Serialize)]
struct Empty {}

#[derive(Clone, Copy)]
struct DebugTime(Timestamp);
impl Serialize for DebugTime {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let time = OffsetDateTime::from_unix_timestamp_nanos(
            i128::from(self.0.seconds()) * 1_000_000_000 + i128::from(self.0.nanoseconds()),
        )
        .map_err(S::Error::custom)?;
        s.serialize_str(&time.format(&Rfc3339).map_err(S::Error::custom)?)
    }
}

struct Decimal(i64);
impl Serialize for Decimal {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(&self.0)
    }
}

struct Typed<'a>(&'a Value);
impl Serialize for Typed<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self.0 {
            Value::Null => tagged(s, "nullValue", &()),
            Value::Bool(v) => tagged(s, "boolValue", v),
            Value::Integer(v) => tagged(s, "intValue", &Decimal(*v)),
            Value::Float(v) if v.is_finite() => tagged(s, "floatValue", v),
            Value::Float(v) => tagged(
                s,
                "floatValue",
                if v.is_nan() {
                    "NaN"
                } else if v.is_sign_positive() {
                    "Infinity"
                } else {
                    "-Infinity"
                },
            ),
            Value::String(v) => tagged(s, "stringValue", v),
            Value::Map(v) => tagged(s, "mapValue", &MapFields(v)),
            Value::List(v) => tagged(s, "listValue", &ListValues(v)),
            Value::Timestamp(v) => tagged(s, "timestampValue", &DebugTime(*v)),
            Value::Path(v) => PathValue(v).serialize(s),
            Value::Bytes(v) => tagged(
                s,
                "bytesValue",
                &base64::engine::general_purpose::STANDARD.encode(v),
            ),
            Value::LatLng(v) => {
                #[derive(Serialize)]
                struct Point {
                    latitude: f64,
                    longitude: f64,
                }
                tagged(
                    s,
                    "latlngValue",
                    &Point {
                        latitude: v.latitude,
                        longitude: v.longitude,
                    },
                )
            }
            // Duration is an evaluator intermediate, not a Firestore input value.
            // Do not invent an unobserved Requests representation if supplied by a caller.
            Value::Duration(_) => Err(S::Error::custom("uncaptured duration in request context")),
        }
    }
}

struct MapFields<'a>(&'a BTreeMap<String, Value>);
impl Serialize for MapFields<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut map = s.serialize_map(None)?;
        if !self.0.is_empty() {
            map.serialize_entry("fields", &Fields(self.0))?;
        }
        map.end()
    }
}
struct Fields<'a>(&'a BTreeMap<String, Value>);
impl Serialize for Fields<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_map(self.0.iter().map(|(k, v)| (k, Typed(v))))
    }
}
struct ListValues<'a>(&'a [Value]);
impl Serialize for ListValues<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        struct Values<'a>(&'a [Value]);
        impl Serialize for Values<'_> {
            fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                s.collect_seq(self.0.iter().map(Typed))
            }
        }
        let mut map = s.serialize_map(None)?;
        if !self.0.is_empty() {
            map.serialize_entry("values", &Values(self.0))?;
        }
        map.end()
    }
}

struct PathValue<'a>(&'a str);
impl Serialize for PathValue<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        struct Path<'a> {
            segments: Segments<'a>,
        }
        struct Segments<'a>(&'a str);
        impl Serialize for Segments<'_> {
            fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                #[derive(Serialize)]
                struct Segment<'a> {
                    simple: &'a str,
                }
                let path = self.0.find("/databases/").map_or(self.0, |i| &self.0[i..]);
                s.collect_seq(
                    path.trim_start_matches('/')
                        .split('/')
                        .filter(|p| !p.is_empty())
                        .map(|simple| Segment { simple }),
                )
            }
        }
        tagged(
            s,
            "pathValue",
            &Path {
                segments: Segments(self.0),
            },
        )
    }
}

struct ResourceValue<'a>(&'a Resource);
impl Serialize for ResourceValue<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        struct ResourceFields<'a> {
            data: TypedMap<'a>,
            __name__: PathValue<'a>,
            id: TypedString<'a>,
        }
        tagged(
            s,
            "mapValue",
            &WithFields {
                fields: ResourceFields {
                    data: TypedMap(&self.0.data),
                    __name__: PathValue(&self.0.name),
                    id: TypedString(self.0.name.rsplit('/').next().unwrap_or_default()),
                },
            },
        )
    }
}
#[derive(Serialize)]
struct WithFields<T> {
    fields: T,
}

struct TypedMap<'a>(&'a BTreeMap<String, Value>);
impl Serialize for TypedMap<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        tagged(s, "mapValue", &MapFields(self.0))
    }
}
struct TypedString<'a>(&'a str);
impl Serialize for TypedString<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        tagged(s, "stringValue", self.0)
    }
}
struct AuthValue<'a>(Option<&'a Auth>);
impl Serialize for AuthValue<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        struct AuthFields<'a> {
            uid: TypedString<'a>,
            token: TypedMap<'a>,
        }
        match self.0 {
            None => tagged(s, "nullValue", &()),
            Some(auth) => tagged(
                s,
                "mapValue",
                &WithFields {
                    fields: AuthFields {
                        uid: TypedString(&auth.uid),
                        token: TypedMap(&auth.token),
                    },
                },
            ),
        }
    }
}

fn method(operation: RequestOperation) -> &'static str {
    match operation {
        RequestOperation::Get => "get",
        RequestOperation::List => "list",
        RequestOperation::Create => "create",
        RequestOperation::Update => "update",
        RequestOperation::Delete => "delete",
    }
}

struct Context<'a> {
    request: &'a EvaluationRequest,
    metadata: Metadata<'a>,
}
impl Serialize for Context<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut map = s.serialize_map(Some(5))?;
        map.serialize_entry("method", method(self.request.operation))?;
        if self.request.operation == RequestOperation::List {
            map.serialize_entry(
                "path",
                &metadata::query_domain(self.request).map_err(S::Error::custom)?,
            )?;
        } else {
            map.serialize_entry("path", &self.request.path)?;
        }
        map.serialize_entry("time", &DebugTime(self.request.time))?;
        map.serialize_entry("request", &RequestValue(self))?;
        if let Some(resource) = &self.request.resource {
            map.serialize_entry("resource", &ResourceValue(resource))?;
        } else {
            map.serialize_entry("resource", &Undefined)?;
        }
        map.end()
    }
}
struct Undefined;
impl Serialize for Undefined {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        tagged(s, "undefined", &Empty {})
    }
}
struct RequestValue<'a>(&'a Context<'a>);
impl Serialize for RequestValue<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        tagged(
            s,
            "mapValue",
            &WithFields {
                fields: RequestFields(self.0),
            },
        )
    }
}
struct RequestFields<'a>(&'a Context<'a>);
impl Serialize for RequestFields<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        struct TimeValue {
            #[serde(rename = "timestampValue")]
            time: DebugTime,
        }
        let request = self.0.request;
        let mut map = s.serialize_map(None)?;
        map.serialize_entry(
            "time",
            &TimeValue {
                time: DebugTime(request.time),
            },
        )?;
        map.serialize_entry("auth", &AuthValue(request.auth.as_ref()))?;
        let writing = matches!(
            request.operation,
            RequestOperation::Create | RequestOperation::Update | RequestOperation::Delete
        );
        map.serialize_entry(
            "inTransaction",
            &Typed(&Value::Bool(
                writing || self.0.metadata.in_read_write_transaction,
            )),
        )?;
        if request.operation == RequestOperation::List {
            map.serialize_entry("path", &metadata::QueryPath(request))?;
        } else {
            map.serialize_entry("path", &PathValue(&request.path))?;
        }
        map.serialize_entry("method", &TypedString(method(request.operation)))?;
        match request.operation {
            RequestOperation::Get | RequestOperation::List => {
                map.serialize_entry("fields", &Typed(&Value::Null))?;
                if request.operation == RequestOperation::List {
                    map.serialize_entry("query", &metadata::QueryValue(request))?;
                }
            }
            _ => {
                map.serialize_entry(
                    "transforms",
                    &metadata::WritePaths {
                        write: self.0.metadata.write,
                        transforms_only: true,
                    },
                )?;
                map.serialize_entry(
                    "writeFields",
                    &metadata::WritePaths {
                        write: self.0.metadata.write,
                        transforms_only: false,
                    },
                )?;
                map.serialize_entry("readFields", &Typed(&Value::Null))?;
                if let Some(resource) = &request.request_resource {
                    map.serialize_entry("resource", &ResourceValue(resource))?;
                } else {
                    map.serialize_entry("resource", &Typed(&Value::Null))?;
                }
            }
        }
        map.end()
    }
}
#[cfg(test)]
#[path = "request_event_tests.rs"]
mod tests;
