//! Oracle-backed domain and mutation metadata, independent of evaluation.
use std::collections::BTreeSet;

use fireside_core_store::FieldPath;
use fireside_rules_engine::QueryScope;

use super::*;

struct Domain<'a> {
    base: &'a str,
    kind: &'a str,
    parent: Option<&'a str>,
    group: bool,
}

impl<'a> Domain<'a> {
    fn new(request: &'a EvaluationRequest) -> Result<Self, &'static str> {
        let (base, _) = request
            .path
            .split_once("/documents/")
            .ok_or("invalid query database path")?;
        match request.query.scope.as_ref().ok_or("missing query domain")? {
            QueryScope::Collection(path) => {
                let (parent, kind) = path
                    .rsplit_once('/')
                    .map_or((None, path.as_str()), |(p, k)| (Some(p), k));
                Ok(Self {
                    base,
                    kind,
                    parent,
                    group: false,
                })
            }
            QueryScope::CollectionGroup {
                collection_id,
                ancestor,
            } => Ok(Self {
                base,
                kind: collection_id,
                parent: ancestor.as_deref(),
                group: true,
            }),
        }
    }
    fn parent_path(&self) -> String {
        self.parent.map_or_else(
            || format!("{}/documents", self.base),
            |parent| format!("{}/documents/{parent}", self.base),
        )
    }
    fn collection_path(&self) -> String {
        format!("{}/{}", self.parent_path(), self.kind)
    }
}

pub(super) fn query_domain(request: &EvaluationRequest) -> Result<String, &'static str> {
    let domain = Domain::new(request)?;
    Ok(if domain.group {
        format!("{}/**/{}/*", domain.parent_path(), domain.kind)
    } else {
        format!("{}/*", domain.collection_path())
    })
}

pub(super) struct QueryPath<'a>(pub &'a EvaluationRequest);
impl Serialize for QueryPath<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let domain = Domain::new(self.0).map_err(S::Error::custom)?;
        if domain.group {
            Undefined.serialize(s)
        } else {
            PathValue(&domain.collection_path()).serialize(s)
        }
    }
}

pub(super) struct QueryValue<'a>(pub &'a EvaluationRequest);
impl Serialize for QueryValue<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        tagged(
            s,
            "mapValue",
            &WithFields {
                fields: QueryFields(self.0),
            },
        )
    }
}
struct QueryFields<'a>(&'a EvaluationRequest);
impl Serialize for QueryFields<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let domain = Domain::new(self.0).map_err(S::Error::custom)?;
        let query = &self.0.query;
        let mut map = s.serialize_map(None)?;
        map.serialize_entry("distinct", &Typed(&Value::Bool(false)))?;
        map.serialize_entry("selectOnlyKeys", &Typed(&Value::Bool(false)))?;
        map.serialize_entry("groupBy", &EmptyMap)?;
        map.serialize_entry("kind", &TypedString(domain.kind))?;
        let parent_key = if domain.group { "ancestor" } else { "parent" };
        if domain.parent.is_some() {
            map.serialize_entry(parent_key, &PathValue(&domain.parent_path()))?;
        } else {
            map.serialize_entry(parent_key, &Typed(&Value::Null))?;
        }
        map.serialize_entry("orderBy", &Orders(&query.order_by))?;
        map.serialize_entry(
            "limit",
            &Typed(&query.limit.map_or(Value::Null, Value::Integer)),
        )?;
        map.serialize_entry("offset", &Typed(&Value::Integer(query.offset.unwrap_or(0))))?;
        map.serialize_entry("allDescendants", &Typed(&Value::Bool(domain.group)))?;
        map.end()
    }
}
struct EmptyMap;
impl Serialize for EmptyMap {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        tagged(s, "mapValue", &Empty {})
    }
}
struct Orders<'a>(&'a BTreeMap<String, String>);
impl Serialize for Orders<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        struct Fields<'a>(&'a BTreeMap<String, String>);
        impl Serialize for Fields<'_> {
            fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                s.collect_map(self.0.iter().map(|(k, v)| (k, TypedString(v))))
            }
        }
        if self.0.is_empty() {
            EmptyMap.serialize(s)
        } else {
            tagged(
                s,
                "mapValue",
                &WithFields {
                    fields: Fields(self.0),
                },
            )
        }
    }
}

pub(super) struct WritePaths<'a> {
    pub write: Option<&'a Write>,
    pub transforms_only: bool,
}
impl Serialize for WritePaths<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        struct Paths<'a>(BTreeSet<&'a FieldPath>);
        impl Serialize for Paths<'_> {
            fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                s.collect_seq(self.0.iter().map(|p| FieldName(p)))
            }
        }
        #[derive(Serialize)]
        struct Values<T> {
            values: T,
        }
        let (mask, transforms) = match self.write {
            Some(Write::Patch {
                update_mask,
                transforms,
                ..
            }) => (Some(update_mask.as_slice()), transforms.as_slice()),
            Some(Write::Set { transforms, .. }) => (None, transforms.as_slice()),
            _ => (None, &[][..]),
        };
        let mut paths: BTreeSet<&FieldPath> = transforms.iter().map(|t| &t.path).collect();
        if !self.transforms_only
            && let Some(mask) = mask
        {
            paths.extend(mask);
        }
        if paths.is_empty() && (self.transforms_only || mask.is_none()) {
            return Typed(&Value::Null).serialize(s);
        }
        if paths.is_empty() {
            return tagged(s, "listValue", &Empty {});
        }
        tagged(
            s,
            "listValue",
            &Values {
                values: Paths(paths),
            },
        )
    }
}
struct FieldName<'a>(&'a FieldPath);
impl Serialize for FieldName<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let escaped = self
            .0
            .segments()
            .iter()
            .map(|s| s.replace('\\', "\\\\").replace('.', "\\."))
            .collect::<Vec<_>>()
            .join(".");
        TypedString(&escaped).serialize(s)
    }
}
