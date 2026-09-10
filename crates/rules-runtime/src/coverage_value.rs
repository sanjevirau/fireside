//! Coverage borrows the same typed representation as Requests.
use super::*;
use fireside_rules_engine::{ExpressionValue, SourcePosition};

pub(crate) struct Observed<'a> {
    pub value: ExpressionValue<'a>,
    pub position: SourcePosition,
    pub metadata: Metadata<'a>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Position {
    line: usize,
    column: usize,
    current_offset: usize,
    end_offset: usize,
}
impl From<SourcePosition> for Position {
    fn from(p: SourcePosition) -> Self {
        Self {
            line: p.line,
            column: p.column,
            current_offset: p.current_offset,
            end_offset: p.end_offset,
        }
    }
}

impl Serialize for Observed<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self.value {
            ExpressionValue::Data(Value::Duration(duration)) => {
                let total =
                    i128::from(duration.seconds) * 1_000_000_000 + i128::from(duration.nanoseconds);
                let absolute = total.abs();
                let mut text = format!(
                    "{}{}",
                    if total < 0 { "-" } else { "" },
                    absolute / 1_000_000_000
                );
                let fraction = absolute % 1_000_000_000;
                if fraction != 0 {
                    text.push('.');
                    text.push_str(format!("{fraction:09}").trim_end_matches('0'));
                }
                text.push('s');
                tagged(s, "durationValue", &text)
            }
            ExpressionValue::Data(value) => Typed(value).serialize(s),
            ExpressionValue::Auth(auth) => AuthValue(Some(auth)).serialize(s),
            ExpressionValue::Resource(resource) => ResourceValue(resource).serialize(s),
            ExpressionValue::Request(request) => RequestValue(&Context {
                request,
                metadata: self.metadata,
            })
            .serialize(s),
            ExpressionValue::Bytes(bytes) => tagged(s, "bytesValue", &Base64Value(bytes)),
            ExpressionValue::Set(values) => tagged(s, "setValue", &ListValues(values)),
            // The compiler's symbolic query proof is not a materialized row.
            // Do not invent concrete values for it.
            ExpressionValue::Symbolic => Err(S::Error::custom("nonconcrete coverage value")),
            ExpressionValue::Query(request) => metadata::QueryValue(request).serialize(s),
            ExpressionValue::Error(error) => {
                #[derive(Serialize)]
                #[serde(rename_all = "camelCase")]
                struct ErrorValue<'a> {
                    source_position: Position,
                    cause_message: &'a str,
                }
                tagged(
                    s,
                    "undefined",
                    &ErrorValue {
                        source_position: self.position.into(),
                        cause_message: &error.message,
                    },
                )
            }
            ExpressionValue::MapDiff(diff) => {
                struct Statuses<'a>(fireside_rules_engine::MapDifference<'a>);
                impl Serialize for Statuses<'_> {
                    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                        use fireside_rules_engine::MapKeyStatus;
                        s.collect_map(self.0.keys().map(|(key, status)| {
                            (
                                key,
                                match status {
                                    MapKeyStatus::OnlyLeft => "ADDED",
                                    MapKeyStatus::OnlyRight => "REMOVED",
                                    MapKeyStatus::Equal => "UNCHANGED",
                                    MapKeyStatus::Different => "CHANGED",
                                },
                            )
                        }))
                    }
                }
                #[derive(Serialize)]
                #[serde(rename_all = "camelCase")]
                struct Diff<'a> {
                    key_statuses: Statuses<'a>,
                }
                tagged(
                    s,
                    "mapDiffValue",
                    &Diff {
                        key_statuses: Statuses(diff),
                    },
                )
            }
        }
    }
}
