use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt::{self, Display, Formatter};

use serde::Deserialize;

use crate::query::{Direction, FieldOperator, Filter, Query, QueryScope as StructuredQueryScope};

/// Index query scope used by `firestore.indexes.json`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum IndexScope {
    Collection,
    CollectionGroup,
}

/// Ordered index direction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum IndexDirection {
    Ascending,
    Descending,
}

/// Index mode required for one field.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum IndexMode {
    Ordered(IndexDirection),
    ArrayContains,
    Vector(usize),
}

/// One field in a missing index requirement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexRequirementField {
    pub field_path: String,
    pub mode: IndexMode,
}

/// A production-style index requirement derived from a structured query.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexRequirement {
    pub collection_group: String,
    pub query_scope: IndexScope,
    pub fields: Vec<IndexRequirementField>,
}

/// Parsed strict-index catalog.
#[derive(Debug, Default, Clone)]
pub struct IndexCatalog {
    indexes: Vec<IndexRequirement>,
    field_overrides: Vec<FieldOverride>,
}

impl IndexCatalog {
    /// Parses the checked-in CLI index format.
    pub fn from_json(json: &str) -> Result<Self, IndexConfigError> {
        let raw: RawCatalog = serde_json::from_str(json)
            .map_err(|error| IndexConfigError::InvalidJson(error.to_string()))?;
        let indexes = raw
            .indexes
            .into_iter()
            .map(IndexRequirement::try_from)
            .collect::<Result<Vec<_>, _>>()?;
        let field_overrides = raw
            .field_overrides
            .into_iter()
            .map(FieldOverride::try_from)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self {
            indexes,
            field_overrides,
        })
    }

    /// Validates that automatic or declared indexes can serve `query`.
    ///
    /// This is only called when `--strict-indexes` is enabled. Collection
    /// automatic indexes are assumed unless a field override replaces them;
    /// collection-group automatic indexes must be declared explicitly.
    pub fn validate(&self, query: &Query) -> Result<(), IndexConfigError> {
        let (collection_group, scope) = query_target(query.scope_ref());
        let usages = collect_usages(query);
        if usages.is_empty() {
            return Ok(());
        }

        if let Some(requirement) = manual_requirement(&collection_group, scope, &usages) {
            if self.indexes.iter().any(|index| index == &requirement) {
                return Ok(());
            }
            return Err(IndexConfigError::Missing(requirement));
        }

        for usage in usages.values() {
            let modes = usage.single_field_modes();
            for mode in modes {
                if !self.single_field_available(&collection_group, scope, &usage.path, mode) {
                    return Err(IndexConfigError::Missing(IndexRequirement {
                        collection_group: collection_group.clone(),
                        query_scope: scope,
                        fields: vec![IndexRequirementField {
                            field_path: usage.path.clone(),
                            mode,
                        }],
                    }));
                }
            }
        }
        Ok(())
    }

    fn single_field_available(
        &self,
        collection_group: &str,
        scope: IndexScope,
        field_path: &str,
        mode: IndexMode,
    ) -> bool {
        let override_ = self.field_overrides.iter().find(|override_| {
            override_.collection_group == collection_group && override_.field_path == field_path
        });
        match (scope, override_) {
            (IndexScope::Collection, None) => true,
            (_, Some(override_)) => override_
                .indexes
                .contains(&SingleFieldIndex { scope, mode }),
            (IndexScope::CollectionGroup, None) => false,
        }
    }
}

#[derive(Debug, Clone)]
struct FieldOverride {
    collection_group: String,
    field_path: String,
    indexes: BTreeSet<SingleFieldIndex>,
}

impl TryFrom<RawFieldOverride> for FieldOverride {
    type Error = IndexConfigError;

    fn try_from(raw: RawFieldOverride) -> Result<Self, Self::Error> {
        let indexes = raw
            .indexes
            .into_iter()
            .map(|index| {
                Ok(SingleFieldIndex {
                    scope: index.query_scope.into(),
                    mode: index.mode()?,
                })
            })
            .collect::<Result<_, IndexConfigError>>()?;
        Ok(Self {
            collection_group: raw.collection_group,
            field_path: raw.field_path,
            indexes,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct SingleFieldIndex {
    scope: IndexScope,
    mode: IndexMode,
}

#[derive(Debug, Default)]
struct FieldUsage {
    path: String,
    equality: bool,
    inequality: bool,
    order: Option<IndexDirection>,
    special_modes: BTreeSet<IndexMode>,
}

impl FieldUsage {
    fn single_field_modes(&self) -> Vec<IndexMode> {
        let mut modes = Vec::new();
        modes.extend(self.special_modes.iter().copied());
        if let Some(order) = self.order {
            modes.push(IndexMode::Ordered(order));
        } else if self.inequality || self.equality {
            modes.push(IndexMode::Ordered(IndexDirection::Ascending));
        }
        modes
    }
}

fn collect_usages(query: &Query) -> BTreeMap<String, FieldUsage> {
    let mut usages = BTreeMap::new();
    if let Some(filter) = query.filter_ref() {
        collect_filter_usages(filter, &mut usages);
    }
    for order in query.orders_ref() {
        let Some(path) = order.path.config_name() else {
            continue;
        };
        let usage = usages.entry(path.clone()).or_insert_with(|| FieldUsage {
            path,
            ..FieldUsage::default()
        });
        usage.order = Some(order.direction.into());
    }
    if let Some(nearest) = query.nearest_ref()
        && let Some(path) = nearest.vector_field.config_name()
    {
        let usage = usages.entry(path.clone()).or_insert_with(|| FieldUsage {
            path,
            ..FieldUsage::default()
        });
        usage
            .special_modes
            .insert(IndexMode::Vector(nearest.query_vector.len()));
    }
    usages
}

fn collect_filter_usages(filter: &Filter, usages: &mut BTreeMap<String, FieldUsage>) {
    match filter {
        Filter::Field(filter) => {
            let Some(path) = filter.path.config_name() else {
                return;
            };
            let usage = usages.entry(path.clone()).or_insert_with(|| FieldUsage {
                path,
                ..FieldUsage::default()
            });
            match filter.operator {
                FieldOperator::Equal | FieldOperator::In => usage.equality = true,
                FieldOperator::ArrayContains | FieldOperator::ArrayContainsAny => {
                    usage.special_modes.insert(IndexMode::ArrayContains);
                }
                FieldOperator::LessThan
                | FieldOperator::LessThanOrEqual
                | FieldOperator::GreaterThan
                | FieldOperator::GreaterThanOrEqual
                | FieldOperator::NotEqual
                | FieldOperator::NotIn => usage.inequality = true,
            }
        }
        Filter::And(filters) | Filter::Or(filters) => {
            for filter in filters {
                collect_filter_usages(filter, usages);
            }
        }
    }
}

fn manual_requirement(
    collection_group: &str,
    scope: IndexScope,
    usages: &BTreeMap<String, FieldUsage>,
) -> Option<IndexRequirement> {
    let vector = usages.values().find_map(|usage| {
        usage.special_modes.iter().find_map(|mode| match mode {
            IndexMode::Vector(dimension) => Some((usage, *dimension)),
            IndexMode::Ordered(_) | IndexMode::ArrayContains => None,
        })
    });
    let equality = usages
        .values()
        .filter(|usage| usage.equality && !usage.inequality && usage.order.is_none())
        .collect::<Vec<_>>();
    let range_or_order = usages
        .values()
        .filter(|usage| usage.inequality || usage.order.is_some())
        .collect::<Vec<_>>();
    let requires_manual = vector.is_some()
        || range_or_order.len() > 1
        || (!equality.is_empty() && range_or_order.iter().any(|usage| !usage.equality));
    if !requires_manual {
        return None;
    }

    let mut fields = Vec::new();
    for usage in usages
        .values()
        .filter(|usage| usage.special_modes.contains(&IndexMode::ArrayContains))
    {
        fields.push(IndexRequirementField {
            field_path: usage.path.clone(),
            mode: IndexMode::ArrayContains,
        });
    }
    for usage in equality {
        fields.push(IndexRequirementField {
            field_path: usage.path.clone(),
            mode: IndexMode::Ordered(IndexDirection::Ascending),
        });
    }
    for usage in range_or_order {
        if fields.iter().any(|field| field.field_path == usage.path) {
            continue;
        }
        fields.push(IndexRequirementField {
            field_path: usage.path.clone(),
            mode: IndexMode::Ordered(usage.order.unwrap_or(IndexDirection::Ascending)),
        });
    }
    if let Some((vector, dimension)) = vector
        && fields.iter().all(|field| field.field_path != vector.path)
    {
        fields.push(IndexRequirementField {
            field_path: vector.path.clone(),
            mode: IndexMode::Vector(dimension),
        });
    }
    requires_manual.then(|| IndexRequirement {
        collection_group: collection_group.to_owned(),
        query_scope: scope,
        fields,
    })
}

fn query_target(scope: &StructuredQueryScope) -> (String, IndexScope) {
    match scope {
        StructuredQueryScope::Collection(path) => (
            path.rsplit('/').next().unwrap_or_default().to_owned(),
            IndexScope::Collection,
        ),
        StructuredQueryScope::CollectionGroup(collection_group) => {
            (collection_group.clone(), IndexScope::CollectionGroup)
        }
    }
}

impl TryFrom<RawIndex> for IndexRequirement {
    type Error = IndexConfigError;

    fn try_from(raw: RawIndex) -> Result<Self, Self::Error> {
        let fields = raw
            .fields
            .into_iter()
            .map(|field| {
                let mode = field.mode()?;
                Ok(IndexRequirementField {
                    field_path: field.field_path,
                    mode,
                })
            })
            .collect::<Result<_, IndexConfigError>>()?;
        Ok(Self {
            collection_group: raw.collection_group,
            query_scope: raw.query_scope.into(),
            fields,
        })
    }
}

impl From<RawScope> for IndexScope {
    fn from(scope: RawScope) -> Self {
        match scope {
            RawScope::Collection => Self::Collection,
            RawScope::CollectionGroup => Self::CollectionGroup,
        }
    }
}

impl From<RawDirection> for IndexDirection {
    fn from(direction: RawDirection) -> Self {
        match direction {
            RawDirection::Ascending => Self::Ascending,
            RawDirection::Descending => Self::Descending,
        }
    }
}

impl From<Direction> for IndexDirection {
    fn from(direction: Direction) -> Self {
        match direction {
            Direction::Ascending => Self::Ascending,
            Direction::Descending => Self::Descending,
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct RawCatalog {
    indexes: Vec<RawIndex>,
    field_overrides: Vec<RawFieldOverride>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawIndex {
    collection_group: String,
    #[serde(default)]
    query_scope: RawScope,
    fields: Vec<RawIndexField>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawFieldOverride {
    collection_group: String,
    field_path: String,
    #[serde(default)]
    indexes: Vec<RawIndexMode>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawIndexField {
    field_path: String,
    #[serde(alias = "mode")]
    order: Option<RawDirection>,
    array_config: Option<RawArrayConfig>,
    vector_config: Option<RawVectorConfig>,
}

impl RawIndexField {
    fn mode(&self) -> Result<IndexMode, IndexConfigError> {
        raw_mode(self.order, self.array_config, self.vector_config.as_ref())
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawIndexMode {
    #[serde(default)]
    query_scope: RawScope,
    order: Option<RawDirection>,
    array_config: Option<RawArrayConfig>,
    vector_config: Option<RawVectorConfig>,
}

impl RawIndexMode {
    fn mode(&self) -> Result<IndexMode, IndexConfigError> {
        raw_mode(self.order, self.array_config, self.vector_config.as_ref())
    }
}

fn raw_mode(
    order: Option<RawDirection>,
    array_config: Option<RawArrayConfig>,
    vector_config: Option<&RawVectorConfig>,
) -> Result<IndexMode, IndexConfigError> {
    match (order, array_config, vector_config) {
        (Some(order), None, None) => Ok(IndexMode::Ordered(order.into())),
        (None, Some(RawArrayConfig::Contains), None) => Ok(IndexMode::ArrayContains),
        (None, None, Some(config)) if config.dimension > 0 => {
            Ok(IndexMode::Vector(config.dimension))
        }
        _ => Err(IndexConfigError::InvalidDefinition(
            "an index field must define exactly one mode".to_owned(),
        )),
    }
}

#[derive(Debug, Deserialize)]
struct RawVectorConfig {
    dimension: usize,
    #[serde(rename = "flat")]
    _flat: RawFlatVectorConfig,
}

#[derive(Debug, Deserialize)]
struct RawFlatVectorConfig {}

#[derive(Debug, Default, Clone, Copy, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum RawScope {
    #[default]
    Collection,
    CollectionGroup,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum RawDirection {
    Ascending,
    Descending,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum RawArrayConfig {
    Contains,
}

/// Invalid index file or a missing strict-mode requirement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IndexConfigError {
    InvalidJson(String),
    InvalidDefinition(String),
    Missing(IndexRequirement),
}

impl Display for IndexConfigError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidJson(error) => write!(formatter, "invalid index JSON: {error}"),
            Self::InvalidDefinition(error) => {
                write!(formatter, "invalid index definition: {error}")
            }
            Self::Missing(requirement) => write!(
                formatter,
                "query requires a {:?} index on {} with fields {:?}",
                requirement.query_scope, requirement.collection_group, requirement.fields
            ),
        }
    }
}

impl Error for IndexConfigError {}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use fireside_core_store::Value;

    use super::*;
    use crate::{FieldFilter, FieldPath, Filter};

    const INDEXES: &str = r#"{
      "indexes": [
        {
          "collectionGroup": "items",
          "queryScope": "COLLECTION",
          "fields": [
            { "fieldPath": "group", "order": "ASCENDING" },
            { "fieldPath": "score", "order": "ASCENDING" }
          ]
        },
        {
          "collectionGroup": "vectors",
          "queryScope": "COLLECTION",
          "fields": [
            { "fieldPath": "embedding", "vectorConfig": { "dimension": 3, "flat": {} } }
          ]
        }
      ],
      "fieldOverrides": [
        {
          "collectionGroup": "fireside_conformance",
          "fieldPath": "runId",
          "indexes": [
            { "order": "ASCENDING", "queryScope": "COLLECTION" },
            { "order": "ASCENDING", "queryScope": "COLLECTION_GROUP" }
          ]
        }
      ]
    }"#;

    fn field(name: &str) -> FieldPath {
        FieldPath::field([name]).expect("valid field")
    }

    fn equality(name: &str) -> Filter {
        Filter::Field(FieldFilter {
            path: field(name),
            operator: FieldOperator::Equal,
            value: Value::String(Arc::from("value")),
        })
    }

    fn vector_query(collection: &str) -> Query {
        Query::new(
            StructuredQueryScope::collection(format!("runs/run/{collection}"))
                .expect("valid scope"),
        )
        .find_nearest(
            field("embedding"),
            vec![0.0, 0.0, 0.0],
            crate::DistanceMeasure::Euclidean,
            3,
            None,
            None,
        )
        .expect("valid vector query")
    }

    #[test]
    fn vector_indexes_are_always_explicit() {
        let catalog = IndexCatalog::from_json(INDEXES).expect("catalog should parse");
        catalog
            .validate(&vector_query("vectors"))
            .expect("declared vector index should match");
        assert!(matches!(
            catalog.validate(&vector_query("missing_vectors")),
            Err(IndexConfigError::Missing(IndexRequirement { fields, .. }))
                if fields == [IndexRequirementField {
                    field_path: "embedding".to_owned(),
                    mode: IndexMode::Vector(3),
                }]
        ));
    }

    #[test]
    fn collection_group_single_field_indexes_are_explicit() {
        let catalog = IndexCatalog::from_json(INDEXES).expect("catalog should parse");
        let query = Query::new(
            StructuredQueryScope::collection_group("fireside_conformance").expect("valid scope"),
        )
        .filter(equality("runId"));
        catalog.validate(&query).expect("override should match");

        let missing = Query::new(
            StructuredQueryScope::collection_group("fireside_conformance").expect("valid scope"),
        )
        .filter(equality("other"));
        assert!(matches!(
            catalog.validate(&missing),
            Err(IndexConfigError::Missing(IndexRequirement {
                query_scope: IndexScope::CollectionGroup,
                ..
            }))
        ));
    }

    #[test]
    fn collection_automatic_and_composite_indexes_are_distinguished() {
        let catalog = IndexCatalog::from_json(INDEXES).expect("catalog should parse");
        let simple =
            Query::new(StructuredQueryScope::collection("parents/p/items").expect("valid scope"))
                .filter(equality("group"));
        catalog
            .validate(&simple)
            .expect("automatic equality index should suffice");

        let composite =
            Query::new(StructuredQueryScope::collection("parents/p/items").expect("valid scope"))
                .filter(equality("group"))
                .order_by(field("score"), Direction::Ascending);
        catalog
            .validate(&composite)
            .expect("declared composite should match");

        let missing =
            Query::new(StructuredQueryScope::collection("parents/p/items").expect("valid scope"))
                .filter(equality("group"))
                .order_by(field("created"), Direction::Ascending);
        assert!(matches!(
            catalog.validate(&missing),
            Err(IndexConfigError::Missing(_))
        ));
    }
}
