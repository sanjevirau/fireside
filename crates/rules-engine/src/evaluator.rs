use std::cmp::Ordering;
use std::collections::BTreeMap;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use md5::{Digest as _, Md5};
use regex::Regex;
use sha2::Sha256;
use time::{Date, Month};

use crate::ast::{
    BinaryOperator, Expr, Function, MatchBlock, Operation, PathPart, PatternSegment, Program,
    TypeName, UnaryOperator,
};
use crate::model::{
    AtomicEvaluationResult, Auth, DocumentAccess, EvaluationRequest, EvaluationResult, LatLng,
    Query, RequestOperation, Resource, RulesDuration, RuntimeError, Timestamp, Value,
};

#[path = "query_constraints.rs"]
mod query_constraints;

const MAXIMUM_EVALUATED_EXPRESSIONS: usize = 1_000;
const MAXIMUM_FUNCTION_CALL_DEPTH: usize = 20;
const SINGLE_REQUEST_ACCESS_LIMIT: usize = 10;
const MULTI_REQUEST_ACCESS_LIMIT: usize = 20;

pub(crate) fn evaluate<A: DocumentAccess + ?Sized>(
    program: &Program,
    request: &EvaluationRequest,
    access: &A,
) -> EvaluationResult {
    let mut state = AccessState::new(SINGLE_REQUEST_ACCESS_LIMIT);
    evaluate_with_state(program, request, access, &mut state)
}

pub(crate) fn evaluate_atomic<A: DocumentAccess + ?Sized>(
    program: &Program,
    requests: &[EvaluationRequest],
    access: &A,
) -> AtomicEvaluationResult {
    let mut state = AccessState::new(MULTI_REQUEST_ACCESS_LIMIT);
    let operations = requests
        .iter()
        .map(|request| evaluate_with_state(program, request, access, &mut state))
        .collect::<Vec<_>>();
    AtomicEvaluationResult {
        allowed: operations.iter().all(|result| result.allowed),
        operations,
        document_accesses: state.document_accesses,
        document_cache_hits: state.document_cache_hits,
    }
}

fn evaluate_with_state<A: DocumentAccess + ?Sized>(
    program: &Program,
    request: &EvaluationRequest,
    access: &A,
    state: &mut AccessState,
) -> EvaluationResult {
    let initial_accesses = state.document_accesses;
    let initial_cache_hits = state.document_cache_hits;
    let mut evaluator = Evaluator::new(request, access, state);
    let functions = program
        .functions
        .iter()
        .map(|(name, function)| (name.clone(), function))
        .collect();
    let branches = if request.operation == RequestOperation::List && request.query.scope.is_some() {
        match query_constraints::branches(request.query.filter.as_ref()) {
            Ok(branches) => branches.into_iter().map(Some).collect(),
            Err(error) => {
                evaluator.record_error(error);
                Vec::new()
            }
        }
    } else {
        vec![None]
    };
    for branch in branches {
        evaluator.allowed = false;
        evaluator.query_branch = branch;
        for block in &program.matches {
            evaluator.walk(block, &[], &functions);
            if evaluator.allowed {
                break;
            }
        }
        // Every alternative is a possible result, even if the store is empty.
        // Budgets/caches and expression accounting remain shared across proof
        // branches, rather than multiplying the allowed resource usage.
        if !evaluator.allowed {
            break;
        }
    }
    EvaluationResult {
        allowed: evaluator.allowed,
        error: if evaluator.allowed {
            None
        } else {
            evaluator.first_error
        },
        evaluated_expressions: evaluator.evaluated_expressions,
        document_accesses: evaluator.state.document_accesses - initial_accesses,
        document_cache_hits: evaluator.state.document_cache_hits - initial_cache_hits,
        matching_allows: evaluator.matching_allows,
    }
}

struct AccessState {
    maximum_accesses: usize,
    document_accesses: usize,
    document_cache_hits: usize,
    current_cache: BTreeMap<String, Option<Resource>>,
    after_cache: BTreeMap<String, Option<Resource>>,
}

impl AccessState {
    fn new(maximum_accesses: usize) -> Self {
        Self {
            maximum_accesses,
            document_accesses: 0,
            document_cache_hits: 0,
            current_cache: BTreeMap::new(),
            after_cache: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Namespace {
    Duration,
    Hashing,
    LatLng,
    Math,
    Timestamp,
}

#[derive(Clone, Debug)]
struct MapDiff {
    left: BTreeMap<String, Value>,
    right: BTreeMap<String, Value>,
}

#[derive(Clone, Debug)]
enum EvalValue {
    Data(Value),
    Auth(Auth),
    Query(Query),
    Request,
    Resource(Resource),
    Namespace(Namespace),
    Set(Vec<Value>),
    MapDiff(MapDiff),
    Bytes { value: Vec<u8>, uppercase_hex: bool },
    QueryResource,
    QueryData,
    Constraint(query_constraints::Constraint),
    Unknown,
}

impl EvalValue {
    fn is_symbolic(&self) -> bool {
        matches!(
            self,
            Self::QueryResource | Self::QueryData | Self::Constraint(_) | Self::Unknown
        )
    }

    fn data(value: impl Into<Value>) -> Self {
        Self::Data(value.into())
    }

    fn into_data(self) -> Result<Value, RuntimeError> {
        match self {
            Self::Data(value) => Ok(value),
            Self::Bytes { value, .. } => Ok(Value::Bytes(value)),
            Self::Set(values) => Ok(Value::List(values)),
            _ => Err(RuntimeError::new("value cannot be used as rules data")),
        }
    }
}

struct Evaluator<'a, A: DocumentAccess + ?Sized> {
    request: &'a EvaluationRequest,
    access: &'a A,
    allowed: bool,
    first_error: Option<RuntimeError>,
    evaluated_expressions: usize,
    state: &'a mut AccessState,
    operation_document_accesses: usize,
    matching_allows: usize,
    call_depth: usize,
    query_branch: Option<Vec<crate::FieldConstraint>>,
}

impl<'a, A: DocumentAccess + ?Sized> Evaluator<'a, A> {
    fn new(request: &'a EvaluationRequest, access: &'a A, state: &'a mut AccessState) -> Self {
        Self {
            request,
            access,
            allowed: false,
            first_error: None,
            evaluated_expressions: 0,
            state,
            operation_document_accesses: 0,
            matching_allows: 0,
            call_depth: 0,
            query_branch: None,
        }
    }

    fn walk<'program>(
        &mut self,
        block: &'program MatchBlock,
        parent_pattern: &[PatternSegment],
        inherited_functions: &BTreeMap<String, &'program Function>,
    ) {
        let mut pattern = parent_pattern.to_vec();
        pattern.extend(block.pattern.iter().cloned());
        let mut functions = inherited_functions.clone();
        functions.extend(
            block
                .functions
                .iter()
                .map(|(name, function)| (name.clone(), function)),
        );

        let bindings = if let Some(scope) = self
            .request
            .query
            .scope
            .as_ref()
            .filter(|_| self.query_branch.is_some())
        {
            query_constraints::bindings(&pattern, &self.request.path, scope)
        } else {
            match_pattern(&pattern, &self.request.path).map(|bindings| {
                bindings
                    .into_iter()
                    .map(|(name, value)| (name, EvalValue::Data(value)))
                    .collect()
            })
        };
        if let Some(mut environment) = bindings {
            environment.insert("request".to_owned(), EvalValue::Request);
            environment.insert(
                "resource".to_owned(),
                if self.query_branch.is_some() {
                    EvalValue::QueryResource
                } else {
                    self.request
                        .resource
                        .clone()
                        .map_or(EvalValue::Data(Value::Null), EvalValue::Resource)
                },
            );
            for allow in &block.allows {
                if !allow
                    .operations
                    .iter()
                    .any(|operation| operation_matches(*operation, self.request.operation))
                {
                    continue;
                }
                self.matching_allows += 1;
                match self.eval_expr(&allow.condition, &mut environment, &functions) {
                    Ok(EvalValue::Data(Value::Bool(true))) => {
                        self.allowed = true;
                        return;
                    }
                    Ok(EvalValue::Data(Value::Bool(false))) => {}
                    Ok(_) => self.record_error(RuntimeError::new(
                        "allow condition did not evaluate to a boolean",
                    )),
                    Err(error) => self.record_error(error),
                }
            }
        }

        for child in &block.children {
            self.walk(child, &pattern, &functions);
            if self.allowed {
                return;
            }
        }
    }

    fn record_error(&mut self, error: RuntimeError) {
        if self.first_error.is_none() {
            self.first_error = Some(error);
        }
    }

    fn eval_expr<'program>(
        &mut self,
        expression: &'program Expr,
        environment: &mut BTreeMap<String, EvalValue>,
        functions: &BTreeMap<String, &'program Function>,
    ) -> Result<EvalValue, RuntimeError> {
        self.evaluated_expressions += 1;
        if self.evaluated_expressions > MAXIMUM_EVALUATED_EXPRESSIONS {
            return Err(RuntimeError::new(
                "maximum of 1000 expressions to evaluate has been reached",
            ));
        }
        match expression {
            Expr::Null => Ok(EvalValue::Data(Value::Null)),
            Expr::Bool(value) => Ok(EvalValue::Data(Value::Bool(*value))),
            Expr::Integer(value) => Ok(EvalValue::Data(Value::Integer(*value))),
            Expr::Float(value) => Ok(EvalValue::Data(Value::Float(*value))),
            Expr::String(value) => Ok(EvalValue::Data(Value::String(value.clone()))),
            Expr::List(values) => values
                .iter()
                .map(|value| self.eval_expr(value, environment, functions)?.into_data())
                .collect::<Result<Vec<_>, _>>()
                .map(|values| EvalValue::Data(Value::List(values))),
            Expr::Map(entries) => entries
                .iter()
                .map(|(key, value)| {
                    Ok((
                        key.clone(),
                        self.eval_expr(value, environment, functions)?.into_data()?,
                    ))
                })
                .collect::<Result<BTreeMap<_, _>, RuntimeError>>()
                .map(|map| EvalValue::Data(Value::Map(map))),
            Expr::Path(parts) => self.eval_path(parts, environment, functions),
            Expr::Variable(name) => Self::variable(name, environment),
            Expr::Field { base, name } => {
                let base = self.eval_expr(base, environment, functions)?;
                self.field(base, name)
            }
            Expr::Index { base, index } => {
                let base = self.eval_expr(base, environment, functions)?;
                let index = self.eval_expr(index, environment, functions)?;
                if matches!(base, EvalValue::QueryData | EvalValue::Constraint(_)) {
                    let EvalValue::Data(Value::String(name)) = index else {
                        return Ok(EvalValue::Unknown);
                    };
                    return self.field(base, &name);
                }
                index_value(base, index)
            }
            Expr::Slice { base, start, end } => {
                let base = self.eval_expr(base, environment, functions)?;
                let start = start
                    .as_deref()
                    .map(|value| self.eval_expr(value, environment, functions))
                    .transpose()?;
                let end = end
                    .as_deref()
                    .map(|value| self.eval_expr(value, environment, functions))
                    .transpose()?;
                slice_value(base, start, end)
            }
            Expr::Call { callee, arguments } => {
                self.eval_call(callee, arguments, environment, functions)
            }
            Expr::Unary { operator, operand } => {
                let value = self.eval_expr(operand, environment, functions)?;
                eval_unary(*operator, value)
            }
            Expr::Binary {
                operator,
                left,
                right,
            } => self.eval_binary(*operator, left, right, environment, functions),
            Expr::Is { value, expected } => {
                let value = self.eval_expr(value, environment, functions)?;
                if value.is_symbolic() {
                    return Ok(EvalValue::Unknown);
                }
                Ok(EvalValue::Data(Value::Bool(is_type(&value, *expected))))
            }
        }
    }

    fn variable(
        name: &str,
        environment: &BTreeMap<String, EvalValue>,
    ) -> Result<EvalValue, RuntimeError> {
        if let Some(value) = environment.get(name) {
            return Ok(value.clone());
        }
        let namespace = match name {
            "duration" => Namespace::Duration,
            "hashing" => Namespace::Hashing,
            "latlng" => Namespace::LatLng,
            "math" => Namespace::Math,
            "timestamp" => Namespace::Timestamp,
            _ => return Err(RuntimeError::new(format!("undefined rules name {name:?}"))),
        };
        Ok(EvalValue::Namespace(namespace))
    }

    fn eval_path<'program>(
        &mut self,
        parts: &'program [PathPart],
        environment: &mut BTreeMap<String, EvalValue>,
        functions: &BTreeMap<String, &'program Function>,
    ) -> Result<EvalValue, RuntimeError> {
        let mut path = String::new();
        for part in parts {
            match part {
                PathPart::Literal(value) => path.push_str(value),
                PathPart::Interpolation(expression) => {
                    let value = self.eval_expr(expression, environment, functions)?;
                    // A list proof has no concrete child document wildcard.
                    // Do not manufacture a path or look up a current result row.
                    if value.is_symbolic() {
                        return Ok(EvalValue::Unknown);
                    }
                    path.push_str(&path_interpolation(value)?);
                }
            }
        }
        Ok(EvalValue::Data(Value::Path(path)))
    }

    fn field(&self, base: EvalValue, name: &str) -> Result<EvalValue, RuntimeError> {
        match base {
            EvalValue::QueryResource => Ok(match name {
                "data" => EvalValue::QueryData,
                _ => EvalValue::Unknown,
            }),
            EvalValue::QueryData => Ok(query_constraints::field_value(
                vec![name.to_owned()],
                self.query_branch.as_deref().unwrap_or_default(),
            )),
            EvalValue::Constraint(mut constraint) => {
                constraint.field.push(name.to_owned());
                Ok(query_constraints::field_value(
                    constraint.field,
                    &constraint.predicates,
                ))
            }
            EvalValue::Unknown => Ok(EvalValue::Unknown),
            EvalValue::Data(Value::Map(map)) => map
                .get(name)
                .cloned()
                .map(EvalValue::Data)
                .ok_or_else(|| RuntimeError::new(format!("map field {name:?} does not exist"))),
            EvalValue::Request => match name {
                "auth" => Ok(self
                    .request
                    .auth
                    .clone()
                    .map_or(EvalValue::Data(Value::Null), EvalValue::Auth)),
                "method" => Ok(EvalValue::data(operation_name(self.request.operation))),
                "time" => Ok(EvalValue::Data(Value::Timestamp(self.request.time))),
                "resource" => Ok(self
                    .request
                    .request_resource
                    .clone()
                    .map_or(EvalValue::Data(Value::Null), EvalValue::Resource)),
                "query" => Ok(EvalValue::Query(self.request.query.clone())),
                _ => Err(RuntimeError::new(format!(
                    "request field {name:?} does not exist"
                ))),
            },
            EvalValue::Auth(auth) => match name {
                "uid" => Ok(EvalValue::data(auth.uid)),
                "token" => Ok(EvalValue::Data(Value::Map(auth.token))),
                _ => Err(RuntimeError::new(format!(
                    "auth field {name:?} does not exist"
                ))),
            },
            EvalValue::Query(query) => match name {
                "limit" => Ok(EvalValue::Data(
                    query.limit.map_or(Value::Null, Value::Integer),
                )),
                "offset" => Ok(EvalValue::Data(Value::Integer(query.offset.unwrap_or(0)))),
                "orderBy" => Ok(EvalValue::Data(Value::Map(
                    query
                        .order_by
                        .into_iter()
                        .map(|(field, direction)| (field, Value::String(direction)))
                        .collect(),
                ))),
                _ => Err(RuntimeError::new(format!(
                    "query field {name:?} does not exist"
                ))),
            },
            EvalValue::Resource(resource) => match name {
                "data" => Ok(EvalValue::Data(Value::Map(resource.data))),
                "__name__" => Ok(EvalValue::Data(Value::Path(resource.name))),
                "createTime" => resource.create_time.map_or_else(
                    || Err(RuntimeError::new("resource createTime is unavailable")),
                    |value| Ok(EvalValue::Data(Value::Timestamp(value))),
                ),
                "updateTime" => resource.update_time.map_or_else(
                    || Err(RuntimeError::new("resource updateTime is unavailable")),
                    |value| Ok(EvalValue::Data(Value::Timestamp(value))),
                ),
                _ => Err(RuntimeError::new(format!(
                    "resource field {name:?} does not exist"
                ))),
            },
            _ => Err(RuntimeError::new(format!(
                "field {name:?} is not available on this value"
            ))),
        }
    }

    fn eval_call<'program>(
        &mut self,
        callee: &'program Expr,
        arguments: &'program [Expr],
        environment: &mut BTreeMap<String, EvalValue>,
        functions: &BTreeMap<String, &'program Function>,
    ) -> Result<EvalValue, RuntimeError> {
        if let Expr::Variable(name) = callee {
            let values = arguments
                .iter()
                .map(|argument| self.eval_expr(argument, environment, functions))
                .collect::<Result<Vec<_>, _>>()?;
            if let Some(function) = functions.get(name) {
                // The production evaluator charges call-frame setup, argument
                // binding, entry, return, and result propagation in addition
                // to the call expression itself. This accounting is what
                // separates the frozen 100-term and 125-term balanced probes.
                self.evaluated_expressions += 5;
                if self.evaluated_expressions > MAXIMUM_EVALUATED_EXPRESSIONS {
                    return Err(RuntimeError::new(
                        "maximum of 1000 expressions to evaluate has been reached",
                    ));
                }
                return self.call_user_function(function, values, environment, functions);
            }
            return self.call_builtin(name, values);
        }
        if let Expr::Field { base, name } = callee {
            let receiver = self.eval_expr(base, environment, functions)?;
            let values = arguments
                .iter()
                .map(|argument| self.eval_expr(argument, environment, functions))
                .collect::<Result<Vec<_>, _>>()?;
            return call_method(receiver, name, values);
        }
        Err(RuntimeError::new("rules call target is not callable"))
    }

    fn call_user_function<'program>(
        &mut self,
        function: &'program Function,
        arguments: Vec<EvalValue>,
        caller_environment: &BTreeMap<String, EvalValue>,
        functions: &BTreeMap<String, &'program Function>,
    ) -> Result<EvalValue, RuntimeError> {
        if function.parameters.len() != arguments.len() {
            return Err(RuntimeError::new(format!(
                "function expected {} arguments but received {}",
                function.parameters.len(),
                arguments.len()
            )));
        }
        if self.call_depth >= MAXIMUM_FUNCTION_CALL_DEPTH {
            return Err(RuntimeError::new(
                "maximum allowed call depth of 20 is reached",
            ));
        }
        self.call_depth += 1;
        let mut environment = caller_environment.clone();
        for (name, value) in function.parameters.iter().zip(arguments) {
            environment.insert(name.clone(), value);
        }
        let result = (|| {
            for (name, expression) in &function.lets {
                let value = self.eval_expr(expression, &mut environment, functions)?;
                environment.insert(name.clone(), value);
            }
            self.eval_expr(&function.result, &mut environment, functions)
        })();
        self.call_depth -= 1;
        result
    }

    fn call_builtin(
        &mut self,
        name: &str,
        arguments: Vec<EvalValue>,
    ) -> Result<EvalValue, RuntimeError> {
        match name {
            "debug" => one_argument(name, arguments),
            "string" => {
                let value = one_argument(name, arguments)?;
                Ok(EvalValue::data(string_coercion(value)?))
            }
            "get" | "exists" | "getAfter" => {
                let argument = one_argument(name, arguments)?;
                if argument.is_symbolic() {
                    return Ok(EvalValue::Unknown);
                }
                let path = data_path(argument)?;
                let after = name == "getAfter";
                let resource = self.document(path, after)?;
                if name == "exists" {
                    Ok(EvalValue::Data(Value::Bool(resource.is_some())))
                } else {
                    resource.map(EvalValue::Resource).ok_or_else(|| {
                        RuntimeError::new("document access returned a missing resource")
                    })
                }
            }
            _ => Err(RuntimeError::new(format!(
                "undefined rules function {name:?}"
            ))),
        }
    }

    fn document(&mut self, path: String, after: bool) -> Result<Option<Resource>, RuntimeError> {
        let cache = if after {
            &mut self.state.after_cache
        } else {
            &mut self.state.current_cache
        };
        if let Some(resource) = cache.get(&path) {
            self.state.document_cache_hits += 1;
            return Ok(resource.clone());
        }
        if self.operation_document_accesses >= SINGLE_REQUEST_ACCESS_LIMIT {
            return Err(RuntimeError::new(format!(
                "maximum of {SINGLE_REQUEST_ACCESS_LIMIT} document access calls for one operation is exceeded"
            )));
        }
        if self.state.document_accesses >= self.state.maximum_accesses {
            return Err(RuntimeError::new(format!(
                "maximum of {} document access calls is exceeded",
                self.state.maximum_accesses
            )));
        }
        self.operation_document_accesses += 1;
        self.state.document_accesses += 1;
        let resource = if after {
            self.access.get_after(&path)
        } else {
            self.access.get(&path)
        }
        .map_err(|error| RuntimeError::new(format!("document access failed: {error}")))?;
        cache.insert(path, resource.clone());
        Ok(resource)
    }

    fn eval_binary<'program>(
        &mut self,
        operator: BinaryOperator,
        left: &'program Expr,
        right: &'program Expr,
        environment: &mut BTreeMap<String, EvalValue>,
        functions: &BTreeMap<String, &'program Function>,
    ) -> Result<EvalValue, RuntimeError> {
        if self.query_branch.is_some()
            && matches!(operator, BinaryOperator::And | BinaryOperator::Or)
        {
            let left = self
                .eval_expr(left, environment, functions)
                .and_then(query_boolean);
            let terminal = operator == BinaryOperator::Or;
            if matches!(&left, Ok(EvalValue::Data(Value::Bool(value))) if *value == terminal) {
                return left;
            }
            // Official query proofs allow an independent true OR / false AND
            // branch to dominate unknowns and runtime errors. Keep the failed
            // branch's error unless the other operand actually proves that
            // terminal value. Access caches and all budgets remain shared.
            let right = self
                .eval_expr(right, environment, functions)
                .and_then(query_boolean);
            if matches!(&right, Ok(EvalValue::Data(Value::Bool(value))) if *value == terminal)
                || matches!(&left, Ok(EvalValue::Data(Value::Bool(_))))
            {
                return right;
            }
            left?;
            right?;
            return Ok(EvalValue::Unknown);
        }
        if operator == BinaryOperator::And {
            let left = self.eval_expr(left, environment, functions)?;
            let left = data_bool(left)?;
            if !left {
                return Ok(EvalValue::Data(Value::Bool(false)));
            }
            return self
                .eval_expr(right, environment, functions)
                .and_then(data_bool)
                .map(|value| EvalValue::Data(Value::Bool(value)));
        }
        if operator == BinaryOperator::Or {
            let left = self.eval_expr(left, environment, functions)?;
            let left = data_bool(left)?;
            if left {
                return Ok(EvalValue::Data(Value::Bool(true)));
            }
            return self
                .eval_expr(right, environment, functions)
                .and_then(data_bool)
                .map(|value| EvalValue::Data(Value::Bool(value)));
        }
        let left = self.eval_expr(left, environment, functions)?;
        let right = self.eval_expr(right, environment, functions)?;
        eval_binary_values(operator, left, right)
    }
}

fn query_boolean(value: EvalValue) -> Result<EvalValue, RuntimeError> {
    if matches!(value, EvalValue::Data(Value::Bool(_))) || value.is_symbolic() {
        Ok(value)
    } else {
        Err(RuntimeError::new("logical operand is not a boolean"))
    }
}

fn operation_matches(operation: Operation, requested: RequestOperation) -> bool {
    matches!(
        (operation, requested),
        (Operation::Get, RequestOperation::Get)
            | (Operation::List, RequestOperation::List)
            | (Operation::Create, RequestOperation::Create)
            | (Operation::Update, RequestOperation::Update)
            | (Operation::Delete, RequestOperation::Delete)
    )
}

fn operation_name(operation: RequestOperation) -> &'static str {
    match operation {
        RequestOperation::Get => "get",
        RequestOperation::List => "list",
        RequestOperation::Create => "create",
        RequestOperation::Update => "update",
        RequestOperation::Delete => "delete",
    }
}

fn match_pattern(pattern: &[PatternSegment], path: &str) -> Option<BTreeMap<String, Value>> {
    let path = path.trim_matches('/');
    let segments = if path.is_empty() {
        Vec::new()
    } else {
        path.split('/').collect::<Vec<_>>()
    };
    match_pattern_from(pattern, &segments, 0, 0, BTreeMap::new())
}

fn match_pattern_from(
    pattern: &[PatternSegment],
    path: &[&str],
    pattern_index: usize,
    path_index: usize,
    bindings: BTreeMap<String, Value>,
) -> Option<BTreeMap<String, Value>> {
    if pattern_index == pattern.len() {
        return (path_index == path.len()).then_some(bindings);
    }
    match &pattern[pattern_index] {
        PatternSegment::Literal(expected) => {
            if path.get(path_index).copied() != Some(expected.as_str()) {
                return None;
            }
            match_pattern_from(pattern, path, pattern_index + 1, path_index + 1, bindings)
        }
        PatternSegment::Wildcard(name) => {
            let value = path.get(path_index)?;
            let mut bindings = bindings;
            bindings.insert(name.clone(), Value::String((*value).to_owned()));
            match_pattern_from(pattern, path, pattern_index + 1, path_index + 1, bindings)
        }
        PatternSegment::RecursiveWildcard(name) => {
            for end in path_index..=path.len() {
                let mut candidate = bindings.clone();
                candidate.insert(
                    name.clone(),
                    Value::Path(format!("/{}", path[path_index..end].join("/"))),
                );
                if let Some(candidate) =
                    match_pattern_from(pattern, path, pattern_index + 1, end, candidate)
                {
                    return Some(candidate);
                }
            }
            None
        }
    }
}

fn one_argument(name: &str, arguments: Vec<EvalValue>) -> Result<EvalValue, RuntimeError> {
    let [value]: [EvalValue; 1] = arguments.try_into().map_err(|arguments: Vec<_>| {
        RuntimeError::new(format!(
            "function {name:?} expected one argument but received {}",
            arguments.len()
        ))
    })?;
    Ok(value)
}

fn exact_arguments<const N: usize>(
    name: &str,
    arguments: Vec<EvalValue>,
) -> Result<[EvalValue; N], RuntimeError> {
    arguments.try_into().map_err(|arguments: Vec<_>| {
        RuntimeError::new(format!(
            "function {name:?} expected {N} arguments but received {}",
            arguments.len()
        ))
    })
}

#[allow(clippy::needless_pass_by_value)]
fn data_bool(value: EvalValue) -> Result<bool, RuntimeError> {
    match value {
        EvalValue::Data(Value::Bool(value)) => Ok(value),
        _ => Err(RuntimeError::new("expected a boolean value")),
    }
}

#[allow(clippy::needless_pass_by_value)]
fn data_integer(value: EvalValue) -> Result<i64, RuntimeError> {
    match value {
        EvalValue::Data(Value::Integer(value)) => Ok(value),
        _ => Err(RuntimeError::new("expected an integer value")),
    }
}

#[allow(clippy::needless_pass_by_value)]
fn data_number(value: EvalValue) -> Result<Number, RuntimeError> {
    match value {
        EvalValue::Data(Value::Integer(value)) => Ok(Number::Integer(value)),
        EvalValue::Data(Value::Float(value)) => Ok(Number::Float(value)),
        _ => Err(RuntimeError::new("expected a numeric value")),
    }
}

fn data_string(value: EvalValue) -> Result<String, RuntimeError> {
    match value {
        EvalValue::Data(Value::String(value)) => Ok(value),
        _ => Err(RuntimeError::new("expected a string value")),
    }
}

fn data_path(value: EvalValue) -> Result<String, RuntimeError> {
    match value {
        EvalValue::Data(Value::Path(value)) => Ok(value),
        _ => Err(RuntimeError::new("expected a path value")),
    }
}

fn data_list(value: EvalValue) -> Result<Vec<Value>, RuntimeError> {
    match value {
        EvalValue::Data(Value::List(value)) | EvalValue::Set(value) => Ok(value),
        _ => Err(RuntimeError::new("expected a list or set value")),
    }
}

fn data_map(value: EvalValue) -> Result<BTreeMap<String, Value>, RuntimeError> {
    match value {
        EvalValue::Data(Value::Map(value)) => Ok(value),
        _ => Err(RuntimeError::new("expected a map value")),
    }
}

fn data_bytes(value: EvalValue) -> Result<Vec<u8>, RuntimeError> {
    match value {
        EvalValue::Data(Value::Bytes(value)) | EvalValue::Bytes { value, .. } => Ok(value),
        _ => Err(RuntimeError::new("expected a bytes value")),
    }
}

fn path_interpolation(value: EvalValue) -> Result<String, RuntimeError> {
    match value {
        EvalValue::Data(Value::String(value) | Value::Path(value)) => Ok(value),
        EvalValue::Data(Value::Integer(value)) => Ok(value.to_string()),
        _ => Err(RuntimeError::new(
            "path interpolation requires a string, integer, or path",
        )),
    }
}

fn string_coercion(value: EvalValue) -> Result<String, RuntimeError> {
    match value {
        EvalValue::Data(Value::String(value) | Value::Path(value)) => Ok(value),
        EvalValue::Data(Value::Integer(value)) => Ok(value.to_string()),
        EvalValue::Data(Value::Float(value)) => Ok(value.to_string()),
        EvalValue::Data(Value::Bool(value)) => Ok(value.to_string()),
        EvalValue::Data(Value::Null) => Ok("null".to_owned()),
        _ => Err(RuntimeError::new("value cannot be converted to a string")),
    }
}

fn eval_unary(operator: UnaryOperator, value: EvalValue) -> Result<EvalValue, RuntimeError> {
    if value.is_symbolic() {
        return Ok(EvalValue::Unknown);
    }
    match operator {
        UnaryOperator::Not => Ok(EvalValue::Data(Value::Bool(!data_bool(value)?))),
        UnaryOperator::Negate => match data_number(value)? {
            Number::Integer(value) => value.checked_neg().map_or_else(
                || Err(RuntimeError::new("integer negation overflow")),
                |value| Ok(EvalValue::Data(Value::Integer(value))),
            ),
            Number::Float(value) => Ok(EvalValue::Data(Value::Float(-value))),
        },
    }
}

fn eval_binary_values(
    operator: BinaryOperator,
    left: EvalValue,
    right: EvalValue,
) -> Result<EvalValue, RuntimeError> {
    if let Some(proof) = query_constraints::binary(operator, &left, &right) {
        return Ok(proof);
    }
    match operator {
        BinaryOperator::Equal => Ok(EvalValue::Data(Value::Bool(eval_equal(&left, &right)))),
        BinaryOperator::NotEqual => Ok(EvalValue::Data(Value::Bool(!eval_equal(&left, &right)))),
        BinaryOperator::Less
        | BinaryOperator::LessEqual
        | BinaryOperator::Greater
        | BinaryOperator::GreaterEqual => {
            let ordering = eval_compare(&left, &right)?;
            let value = match operator {
                BinaryOperator::Less => ordering == Ordering::Less,
                BinaryOperator::LessEqual => ordering != Ordering::Greater,
                BinaryOperator::Greater => ordering == Ordering::Greater,
                BinaryOperator::GreaterEqual => ordering != Ordering::Less,
                _ => unreachable!(),
            };
            Ok(EvalValue::Data(Value::Bool(value)))
        }
        BinaryOperator::In => {
            let needle = left.into_data()?;
            let contains = match right {
                EvalValue::Data(Value::List(values)) | EvalValue::Set(values) => {
                    values.iter().any(|value| rules_equal(&needle, value))
                }
                EvalValue::Data(Value::Map(values)) => match needle {
                    Value::String(key) => values.contains_key(&key),
                    _ => false,
                },
                _ => return Err(RuntimeError::new("right side of 'in' is not a list or map")),
            };
            Ok(EvalValue::Data(Value::Bool(contains)))
        }
        BinaryOperator::Add => eval_add(left, right),
        BinaryOperator::Subtract => eval_subtract(left, right),
        BinaryOperator::Multiply => numeric_binary(
            left,
            right,
            i64::checked_mul,
            |left, right| left * right,
            "multiplication overflow",
        ),
        BinaryOperator::Divide => match (data_number(left)?, data_number(right)?) {
            (Number::Integer(left), Number::Integer(right)) => {
                if right == 0 {
                    return Err(RuntimeError::new("division by zero"));
                }
                left.checked_div(right).map_or_else(
                    || Err(RuntimeError::new("integer division overflow")),
                    |value| Ok(EvalValue::Data(Value::Integer(value))),
                )
            }
            (left, right) => {
                let right = right.to_f64();
                if right == 0.0 {
                    return Err(RuntimeError::new("division by zero"));
                }
                Ok(EvalValue::Data(Value::Float(left.to_f64() / right)))
            }
        },
        BinaryOperator::Remainder => {
            let left = data_integer(left)?;
            let right = data_integer(right)?;
            if right == 0 {
                return Err(RuntimeError::new("remainder by zero"));
            }
            left.checked_rem(right).map_or_else(
                || Err(RuntimeError::new("integer remainder overflow")),
                |value| Ok(EvalValue::Data(Value::Integer(value))),
            )
        }
        BinaryOperator::And | BinaryOperator::Or => unreachable!(),
    }
}

#[derive(Clone, Copy, Debug)]
enum Number {
    Integer(i64),
    Float(f64),
}

impl Number {
    #[allow(clippy::cast_precision_loss)]
    fn to_f64(self) -> f64 {
        match self {
            Self::Integer(value) => value as f64,
            Self::Float(value) => value,
        }
    }
}

fn numeric_binary(
    left: EvalValue,
    right: EvalValue,
    integer: impl FnOnce(i64, i64) -> Option<i64>,
    float: impl FnOnce(f64, f64) -> f64,
    overflow: &str,
) -> Result<EvalValue, RuntimeError> {
    match (data_number(left)?, data_number(right)?) {
        (Number::Integer(left), Number::Integer(right)) => integer(left, right).map_or_else(
            || Err(RuntimeError::new(overflow)),
            |value| Ok(EvalValue::Data(Value::Integer(value))),
        ),
        (left, right) => Ok(EvalValue::Data(Value::Float(float(
            left.to_f64(),
            right.to_f64(),
        )))),
    }
}

fn eval_add(left: EvalValue, right: EvalValue) -> Result<EvalValue, RuntimeError> {
    match (left, right) {
        (EvalValue::Data(Value::String(mut left)), EvalValue::Data(Value::String(right))) => {
            left.push_str(&right);
            Ok(EvalValue::Data(Value::String(left)))
        }
        (EvalValue::Data(Value::List(mut left)), EvalValue::Data(Value::List(right))) => {
            left.extend(right);
            Ok(EvalValue::Data(Value::List(left)))
        }
        (
            EvalValue::Data(Value::Timestamp(timestamp)),
            EvalValue::Data(Value::Duration(duration)),
        )
        | (
            EvalValue::Data(Value::Duration(duration)),
            EvalValue::Data(Value::Timestamp(timestamp)),
        ) => add_timestamp_duration(timestamp, duration)
            .map(|value| EvalValue::Data(Value::Timestamp(value))),
        (EvalValue::Data(Value::Duration(left)), EvalValue::Data(Value::Duration(right))) => {
            let total = left
                .total_nanoseconds()
                .checked_add(right.total_nanoseconds())
                .ok_or_else(|| RuntimeError::new("duration addition overflow"))?;
            Ok(EvalValue::Data(Value::Duration(
                RulesDuration::from_nanoseconds(total),
            )))
        }
        (left, right) => numeric_binary(
            left,
            right,
            i64::checked_add,
            |left, right| left + right,
            "integer addition overflow",
        ),
    }
}

fn eval_subtract(left: EvalValue, right: EvalValue) -> Result<EvalValue, RuntimeError> {
    match (left, right) {
        (EvalValue::Data(Value::Timestamp(left)), EvalValue::Data(Value::Timestamp(right))) => {
            let left = i128::from(left.seconds()) * 1_000_000_000 + i128::from(left.nanoseconds());
            let right =
                i128::from(right.seconds()) * 1_000_000_000 + i128::from(right.nanoseconds());
            Ok(EvalValue::Data(Value::Duration(
                RulesDuration::from_nanoseconds(left - right),
            )))
        }
        (
            EvalValue::Data(Value::Timestamp(timestamp)),
            EvalValue::Data(Value::Duration(duration)),
        ) => {
            let negated = RulesDuration::from_nanoseconds(-duration.total_nanoseconds());
            add_timestamp_duration(timestamp, negated)
                .map(|value| EvalValue::Data(Value::Timestamp(value)))
        }
        (EvalValue::Data(Value::Duration(left)), EvalValue::Data(Value::Duration(right))) => {
            let total = left
                .total_nanoseconds()
                .checked_sub(right.total_nanoseconds())
                .ok_or_else(|| RuntimeError::new("duration subtraction overflow"))?;
            Ok(EvalValue::Data(Value::Duration(
                RulesDuration::from_nanoseconds(total),
            )))
        }
        (left, right) => numeric_binary(
            left,
            right,
            i64::checked_sub,
            |left, right| left - right,
            "integer subtraction overflow",
        ),
    }
}

fn add_timestamp_duration(
    timestamp: Timestamp,
    duration: RulesDuration,
) -> Result<Timestamp, RuntimeError> {
    let total =
        i128::from(timestamp.seconds()) * 1_000_000_000 + i128::from(timestamp.nanoseconds());
    let total = total
        .checked_add(duration.total_nanoseconds())
        .ok_or_else(|| RuntimeError::new("timestamp arithmetic overflow"))?;
    let seconds = total.div_euclid(1_000_000_000);
    let nanos = total.rem_euclid(1_000_000_000);
    Ok(Timestamp::new(
        i64::try_from(seconds).map_err(|_| RuntimeError::new("timestamp is outside range"))?,
        u32::try_from(nanos).map_err(|_| RuntimeError::new("timestamp is outside range"))?,
    ))
}

fn eval_equal(left: &EvalValue, right: &EvalValue) -> bool {
    match (left, right) {
        (EvalValue::Data(left), EvalValue::Data(right)) => rules_equal(left, right),
        (EvalValue::Bytes { value: left, .. }, EvalValue::Bytes { value: right, .. })
        | (EvalValue::Bytes { value: left, .. }, EvalValue::Data(Value::Bytes(right)))
        | (EvalValue::Data(Value::Bytes(left)), EvalValue::Bytes { value: right, .. }) => {
            left == right
        }
        (EvalValue::Set(left), EvalValue::Set(right)) => set_equal(left, right),
        _ => false,
    }
}

#[allow(clippy::cast_precision_loss, clippy::float_cmp)]
fn rules_equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Integer(left), Value::Float(right))
        | (Value::Float(right), Value::Integer(left)) => {
            right.is_finite() && right.fract() == 0.0 && (*left as f64) == *right
        }
        (Value::Float(left), Value::Float(right)) if left.is_nan() && right.is_nan() => true,
        (Value::List(left), Value::List(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(left, right)| rules_equal(left, right))
        }
        (Value::Map(left), Value::Map(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .all(|(key, left)| right.get(key).is_some_and(|right| rules_equal(left, right)))
        }
        _ => left == right,
    }
}

#[allow(clippy::cast_precision_loss)]
fn eval_compare(left: &EvalValue, right: &EvalValue) -> Result<Ordering, RuntimeError> {
    match (left, right) {
        (EvalValue::Data(Value::Integer(left)), EvalValue::Data(Value::Integer(right))) => {
            Ok(left.cmp(right))
        }
        (EvalValue::Data(Value::Integer(left)), EvalValue::Data(Value::Float(right))) => (*left
            as f64)
            .partial_cmp(right)
            .ok_or_else(|| RuntimeError::new("NaN values are unordered")),
        (EvalValue::Data(Value::Float(left)), EvalValue::Data(Value::Integer(right))) => left
            .partial_cmp(&(*right as f64))
            .ok_or_else(|| RuntimeError::new("NaN values are unordered")),
        (EvalValue::Data(Value::Float(left)), EvalValue::Data(Value::Float(right))) => left
            .partial_cmp(right)
            .ok_or_else(|| RuntimeError::new("NaN values are unordered")),
        (EvalValue::Data(Value::String(left)), EvalValue::Data(Value::String(right)))
        | (EvalValue::Data(Value::Path(left)), EvalValue::Data(Value::Path(right))) => {
            Ok(left.cmp(right))
        }
        (EvalValue::Data(Value::Timestamp(left)), EvalValue::Data(Value::Timestamp(right))) => {
            Ok(left.cmp(right))
        }
        (EvalValue::Data(Value::Duration(left)), EvalValue::Data(Value::Duration(right))) => {
            Ok(left.total_nanoseconds().cmp(&right.total_nanoseconds()))
        }
        _ => Err(RuntimeError::new("values cannot be ordered")),
    }
}

fn is_type(value: &EvalValue, expected: TypeName) -> bool {
    match expected {
        TypeName::Null => matches!(value, EvalValue::Data(Value::Null)),
        TypeName::Bool => matches!(value, EvalValue::Data(Value::Bool(_))),
        TypeName::Int => matches!(value, EvalValue::Data(Value::Integer(_))),
        TypeName::Float => matches!(value, EvalValue::Data(Value::Float(_))),
        TypeName::Number => matches!(value, EvalValue::Data(Value::Integer(_) | Value::Float(_))),
        TypeName::String => matches!(value, EvalValue::Data(Value::String(_))),
        TypeName::List => matches!(value, EvalValue::Data(Value::List(_))),
        TypeName::Map => matches!(value, EvalValue::Data(Value::Map(_))),
        TypeName::Timestamp => matches!(value, EvalValue::Data(Value::Timestamp(_))),
        TypeName::Duration => matches!(value, EvalValue::Data(Value::Duration(_))),
        TypeName::Path => matches!(value, EvalValue::Data(Value::Path(_))),
        TypeName::Bytes => matches!(
            value,
            EvalValue::Data(Value::Bytes(_)) | EvalValue::Bytes { .. }
        ),
        TypeName::LatLng => matches!(value, EvalValue::Data(Value::LatLng(_))),
    }
}

fn index_value(base: EvalValue, index: EvalValue) -> Result<EvalValue, RuntimeError> {
    match base {
        EvalValue::Data(Value::List(values)) => {
            let index = usize::try_from(data_integer(index)?)
                .map_err(|_| RuntimeError::new("list index is negative"))?;
            values
                .get(index)
                .cloned()
                .map(EvalValue::Data)
                .ok_or_else(|| RuntimeError::new("list index is outside the available range"))
        }
        EvalValue::Data(Value::Map(values)) => {
            let key = data_string(index)?;
            values
                .get(&key)
                .cloned()
                .map(EvalValue::Data)
                .ok_or_else(|| RuntimeError::new(format!("map key {key:?} does not exist")))
        }
        _ => Err(RuntimeError::new("value cannot be indexed")),
    }
}

fn slice_value(
    base: EvalValue,
    start: Option<EvalValue>,
    end: Option<EvalValue>,
) -> Result<EvalValue, RuntimeError> {
    let EvalValue::Data(Value::List(values)) = base else {
        return Err(RuntimeError::new("only lists can be sliced"));
    };
    let start = start.map(data_integer).transpose()?.unwrap_or(0);
    let end = end
        .map(data_integer)
        .transpose()?
        .unwrap_or(i64::try_from(values.len()).unwrap_or(i64::MAX));
    let start = usize::try_from(start).map_err(|_| RuntimeError::new("slice start is negative"))?;
    let end = usize::try_from(end).map_err(|_| RuntimeError::new("slice end is negative"))?;
    if start > end || end > values.len() {
        return Err(RuntimeError::new("slice is outside the available range"));
    }
    Ok(EvalValue::Data(Value::List(values[start..end].to_vec())))
}

fn call_method(
    receiver: EvalValue,
    name: &str,
    arguments: Vec<EvalValue>,
) -> Result<EvalValue, RuntimeError> {
    match receiver {
        EvalValue::Namespace(namespace) => call_namespace(namespace, name, arguments),
        EvalValue::Data(Value::String(value)) => string_method(value, name, arguments),
        EvalValue::Data(Value::List(value)) => list_method(value, name, arguments),
        EvalValue::Data(Value::Map(value)) => map_method(value, name, arguments),
        EvalValue::Set(value) => set_method(value, name, arguments),
        EvalValue::MapDiff(value) => map_diff_method(value, name, arguments),
        EvalValue::Bytes {
            value,
            uppercase_hex,
        } => bytes_method(value, uppercase_hex, name, arguments),
        EvalValue::Data(Value::Bytes(value)) => bytes_method(value, false, name, arguments),
        EvalValue::Data(Value::Duration(value)) => duration_method(value, name, arguments),
        EvalValue::Data(Value::Timestamp(value)) => timestamp_method(value, name, arguments),
        EvalValue::Data(Value::LatLng(value)) => latlng_method(value, name, arguments),
        _ => Err(RuntimeError::new(format!(
            "method {name:?} is not available on this value"
        ))),
    }
}

#[allow(clippy::needless_pass_by_value)]
fn no_arguments(name: &str, arguments: Vec<EvalValue>) -> Result<(), RuntimeError> {
    if arguments.is_empty() {
        Ok(())
    } else {
        Err(RuntimeError::new(format!(
            "method {name:?} expected no arguments but received {}",
            arguments.len()
        )))
    }
}

fn string_method(
    value: String,
    name: &str,
    arguments: Vec<EvalValue>,
) -> Result<EvalValue, RuntimeError> {
    match name {
        "size" => {
            no_arguments(name, arguments)?;
            Ok(EvalValue::Data(Value::Integer(
                i64::try_from(value.chars().count()).unwrap_or(i64::MAX),
            )))
        }
        "lower" => {
            no_arguments(name, arguments)?;
            Ok(EvalValue::data(value.to_lowercase()))
        }
        "upper" => {
            no_arguments(name, arguments)?;
            Ok(EvalValue::data(value.to_uppercase()))
        }
        "trim" => {
            no_arguments(name, arguments)?;
            Ok(EvalValue::data(value.trim().to_owned()))
        }
        "matches" => {
            let pattern = data_string(one_argument(name, arguments)?)?;
            let regex = Regex::new(&pattern)
                .map_err(|error| RuntimeError::new(format!("invalid regex: {error}")))?;
            Ok(EvalValue::Data(Value::Bool(regex.is_match(&value))))
        }
        "replace" => {
            let [from, to] = exact_arguments::<2>(name, arguments)?;
            Ok(EvalValue::data(
                value.replace(&data_string(from)?, &data_string(to)?),
            ))
        }
        "split" => {
            let delimiter = data_string(one_argument(name, arguments)?)?;
            Ok(EvalValue::Data(Value::List(
                value
                    .split(&delimiter)
                    .map(|part| Value::String(part.to_owned()))
                    .collect(),
            )))
        }
        "toUtf8" => {
            no_arguments(name, arguments)?;
            Ok(EvalValue::Bytes {
                value: value.into_bytes(),
                uppercase_hex: false,
            })
        }
        _ => Err(RuntimeError::new(format!(
            "unsupported string method {name:?}"
        ))),
    }
}

fn list_method(
    mut value: Vec<Value>,
    name: &str,
    arguments: Vec<EvalValue>,
) -> Result<EvalValue, RuntimeError> {
    match name {
        "size" => {
            no_arguments(name, arguments)?;
            Ok(EvalValue::Data(Value::Integer(
                i64::try_from(value.len()).unwrap_or(i64::MAX),
            )))
        }
        "concat" => {
            value.extend(data_list(one_argument(name, arguments)?)?);
            Ok(EvalValue::Data(Value::List(value)))
        }
        "hasAll" => {
            let required = data_list(one_argument(name, arguments)?)?;
            Ok(EvalValue::Data(Value::Bool(required.iter().all(
                |required| value.iter().any(|value| rules_equal(value, required)),
            ))))
        }
        "hasAny" => {
            let candidates = data_list(one_argument(name, arguments)?)?;
            Ok(EvalValue::Data(Value::Bool(candidates.iter().any(
                |candidate| value.iter().any(|value| rules_equal(value, candidate)),
            ))))
        }
        "hasOnly" => {
            let expected = data_list(one_argument(name, arguments)?)?;
            Ok(EvalValue::Data(Value::Bool(value.iter().all(|value| {
                expected.iter().any(|expected| rules_equal(value, expected))
            }))))
        }
        "join" => {
            let separator = data_string(one_argument(name, arguments)?)?;
            let values = value
                .into_iter()
                .map(|value| string_coercion(EvalValue::Data(value)))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(EvalValue::data(values.join(&separator)))
        }
        "removeAll" => {
            let removed = data_list(one_argument(name, arguments)?)?;
            value.retain(|value| !removed.iter().any(|removed| rules_equal(value, removed)));
            Ok(EvalValue::Data(Value::List(value)))
        }
        "toSet" => {
            no_arguments(name, arguments)?;
            Ok(EvalValue::Set(unique_values(value)))
        }
        _ => Err(RuntimeError::new(format!(
            "unsupported list method {name:?}"
        ))),
    }
}

fn map_method(
    value: BTreeMap<String, Value>,
    name: &str,
    arguments: Vec<EvalValue>,
) -> Result<EvalValue, RuntimeError> {
    match name {
        "size" => {
            no_arguments(name, arguments)?;
            Ok(EvalValue::Data(Value::Integer(
                i64::try_from(value.len()).unwrap_or(i64::MAX),
            )))
        }
        "keys" => {
            no_arguments(name, arguments)?;
            Ok(EvalValue::Data(Value::List(
                value.keys().cloned().map(Value::String).collect(),
            )))
        }
        "values" => {
            no_arguments(name, arguments)?;
            Ok(EvalValue::Data(Value::List(value.into_values().collect())))
        }
        "get" => {
            let [key, default] = exact_arguments::<2>(name, arguments)?;
            let key = data_string(key)?;
            Ok(EvalValue::Data(
                value.get(&key).cloned().unwrap_or(default.into_data()?),
            ))
        }
        "diff" => {
            let right = data_map(one_argument(name, arguments)?)?;
            Ok(EvalValue::MapDiff(MapDiff { left: value, right }))
        }
        _ => Err(RuntimeError::new(format!(
            "unsupported map method {name:?}"
        ))),
    }
}

#[allow(clippy::needless_pass_by_value)]
fn map_diff_method(
    diff: MapDiff,
    name: &str,
    arguments: Vec<EvalValue>,
) -> Result<EvalValue, RuntimeError> {
    no_arguments(name, arguments)?;
    let keys: Vec<String> = match name {
        "addedKeys" => diff
            .right
            .keys()
            .filter(|key| !diff.left.contains_key(*key))
            .cloned()
            .collect(),
        "removedKeys" => diff
            .left
            .keys()
            .filter(|key| !diff.right.contains_key(*key))
            .cloned()
            .collect(),
        "changedKeys" => diff
            .left
            .iter()
            .filter_map(|(key, left)| {
                diff.right
                    .get(key)
                    .filter(|right| !rules_equal(left, right))
                    .map(|_| key.clone())
            })
            .collect(),
        "unchangedKeys" => diff
            .left
            .iter()
            .filter_map(|(key, left)| {
                diff.right
                    .get(key)
                    .filter(|right| rules_equal(left, right))
                    .map(|_| key.clone())
            })
            .collect(),
        "affectedKeys" => diff
            .left
            .keys()
            .chain(diff.right.keys())
            .filter(|key| match (diff.left.get(*key), diff.right.get(*key)) {
                (Some(left), Some(right)) => !rules_equal(left, right),
                _ => true,
            })
            .cloned()
            .collect(),
        _ => {
            return Err(RuntimeError::new(format!(
                "unsupported map diff method {name:?}"
            )));
        }
    };
    Ok(EvalValue::Set(
        keys.into_iter().map(Value::String).collect(),
    ))
}

fn set_method(
    value: Vec<Value>,
    name: &str,
    arguments: Vec<EvalValue>,
) -> Result<EvalValue, RuntimeError> {
    match name {
        "size" => {
            no_arguments(name, arguments)?;
            Ok(EvalValue::Data(Value::Integer(
                i64::try_from(value.len()).unwrap_or(i64::MAX),
            )))
        }
        "hasAll" => {
            let required = data_list(one_argument(name, arguments)?)?;
            Ok(EvalValue::Data(Value::Bool(required.iter().all(
                |required| value.iter().any(|value| rules_equal(value, required)),
            ))))
        }
        "hasAny" => {
            let candidates = data_list(one_argument(name, arguments)?)?;
            Ok(EvalValue::Data(Value::Bool(candidates.iter().any(
                |candidate| value.iter().any(|value| rules_equal(value, candidate)),
            ))))
        }
        "hasOnly" => {
            let expected = data_list(one_argument(name, arguments)?)?;
            Ok(EvalValue::Data(Value::Bool(value.iter().all(|value| {
                expected.iter().any(|expected| rules_equal(value, expected))
            }))))
        }
        "union" => {
            let mut result = value;
            result.extend(data_list(one_argument(name, arguments)?)?);
            Ok(EvalValue::Set(unique_values(result)))
        }
        "intersection" => {
            let right = data_list(one_argument(name, arguments)?)?;
            Ok(EvalValue::Set(unique_values(
                value
                    .into_iter()
                    .filter(|left| right.iter().any(|right| rules_equal(left, right)))
                    .collect(),
            )))
        }
        "difference" => {
            let right = data_list(one_argument(name, arguments)?)?;
            Ok(EvalValue::Set(unique_values(
                value
                    .into_iter()
                    .filter(|left| !right.iter().any(|right| rules_equal(left, right)))
                    .collect(),
            )))
        }
        _ => Err(RuntimeError::new(format!(
            "unsupported set method {name:?}"
        ))),
    }
}

fn unique_values(values: Vec<Value>) -> Vec<Value> {
    let mut unique = Vec::new();
    for value in values {
        if !unique
            .iter()
            .any(|candidate| rules_equal(candidate, &value))
        {
            unique.push(value);
        }
    }
    unique
}

fn set_equal(left: &[Value], right: &[Value]) -> bool {
    left.iter()
        .all(|left| right.iter().any(|right| rules_equal(left, right)))
        && right
            .iter()
            .all(|right| left.iter().any(|left| rules_equal(left, right)))
}

fn bytes_method(
    value: Vec<u8>,
    uppercase_hex: bool,
    name: &str,
    arguments: Vec<EvalValue>,
) -> Result<EvalValue, RuntimeError> {
    no_arguments(name, arguments)?;
    match name {
        "size" => Ok(EvalValue::Data(Value::Integer(
            i64::try_from(value.len()).unwrap_or(i64::MAX),
        ))),
        "toHexString" => {
            let mut encoded = String::with_capacity(value.len() * 2);
            for byte in value {
                use std::fmt::Write as _;
                if uppercase_hex {
                    write!(&mut encoded, "{byte:02X}").expect("writing to a string cannot fail");
                } else {
                    write!(&mut encoded, "{byte:02x}").expect("writing to a string cannot fail");
                }
            }
            Ok(EvalValue::data(encoded))
        }
        "toBase64" => Ok(EvalValue::data(BASE64_STANDARD.encode(value))),
        _ => Err(RuntimeError::new(format!(
            "unsupported bytes method {name:?}"
        ))),
    }
}

fn call_namespace(
    namespace: Namespace,
    name: &str,
    arguments: Vec<EvalValue>,
) -> Result<EvalValue, RuntimeError> {
    match namespace {
        Namespace::Duration => duration_namespace(name, arguments),
        Namespace::Hashing => hashing_namespace(name, arguments),
        Namespace::LatLng => latlng_namespace(name, arguments),
        Namespace::Math => math_namespace(name, arguments),
        Namespace::Timestamp => timestamp_namespace(name, arguments),
    }
}

fn duration_namespace(name: &str, arguments: Vec<EvalValue>) -> Result<EvalValue, RuntimeError> {
    if name != "value" {
        return Err(RuntimeError::new(format!(
            "unsupported duration function {name:?}"
        )));
    }
    let [amount, unit] = exact_arguments::<2>(name, arguments)?;
    let amount = data_integer(amount)?;
    let unit = data_string(unit)?;
    let multiplier = match unit.as_str() {
        "w" => 604_800_000_000_000_i128,
        "d" => 86_400_000_000_000_i128,
        "h" => 3_600_000_000_000_i128,
        "m" => 60_000_000_000_i128,
        "s" => 1_000_000_000_i128,
        "ms" => 1_000_000_i128,
        "us" | "µs" => 1_000_i128,
        "ns" => 1_i128,
        _ => {
            return Err(RuntimeError::new(format!(
                "unsupported duration unit {unit:?}"
            )));
        }
    };
    let total = i128::from(amount)
        .checked_mul(multiplier)
        .ok_or_else(|| RuntimeError::new("duration is outside the supported range"))?;
    Ok(EvalValue::Data(Value::Duration(
        RulesDuration::from_nanoseconds(total),
    )))
}

fn hashing_namespace(name: &str, arguments: Vec<EvalValue>) -> Result<EvalValue, RuntimeError> {
    let bytes = data_bytes(one_argument(name, arguments)?)?;
    let value = match name {
        "md5" => Md5::digest(bytes).to_vec(),
        "sha256" => Sha256::digest(bytes).to_vec(),
        _ => {
            return Err(RuntimeError::new(format!(
                "unsupported hashing function {name:?}"
            )));
        }
    };
    Ok(EvalValue::Bytes {
        value,
        uppercase_hex: true,
    })
}

fn latlng_namespace(name: &str, arguments: Vec<EvalValue>) -> Result<EvalValue, RuntimeError> {
    if name != "value" {
        return Err(RuntimeError::new(format!(
            "unsupported latlng function {name:?}"
        )));
    }
    let [latitude, longitude] = exact_arguments::<2>(name, arguments)?;
    let latitude = data_number(latitude)?.to_f64();
    let longitude = data_number(longitude)?.to_f64();
    if !(-90.0..=90.0).contains(&latitude) || !(-180.0..=180.0).contains(&longitude) {
        return Err(RuntimeError::new(
            "latitude or longitude is outside its valid range",
        ));
    }
    Ok(EvalValue::Data(Value::LatLng(LatLng {
        latitude,
        longitude,
    })))
}

fn math_namespace(name: &str, arguments: Vec<EvalValue>) -> Result<EvalValue, RuntimeError> {
    match name {
        "abs" => match data_number(one_argument(name, arguments)?)? {
            Number::Integer(value) => value.checked_abs().map_or_else(
                || Err(RuntimeError::new("integer absolute value overflow")),
                |value| Ok(EvalValue::Data(Value::Integer(value))),
            ),
            Number::Float(value) => Ok(EvalValue::Data(Value::Float(value.abs()))),
        },
        "ceil" => Ok(EvalValue::Data(Value::Float(
            data_number(one_argument(name, arguments)?)?.to_f64().ceil(),
        ))),
        "floor" => Ok(EvalValue::Data(Value::Float(
            data_number(one_argument(name, arguments)?)?
                .to_f64()
                .floor(),
        ))),
        "round" => Ok(EvalValue::Data(Value::Float(
            data_number(one_argument(name, arguments)?)?
                .to_f64()
                .round(),
        ))),
        "sqrt" => {
            let value = data_number(one_argument(name, arguments)?)?.to_f64();
            if value < 0.0 {
                return Err(RuntimeError::new("square root of a negative value"));
            }
            Ok(EvalValue::Data(Value::Float(value.sqrt())))
        }
        "pow" => {
            let [base, exponent] = exact_arguments::<2>(name, arguments)?;
            Ok(EvalValue::Data(Value::Float(
                data_number(base)?
                    .to_f64()
                    .powf(data_number(exponent)?.to_f64()),
            )))
        }
        _ => Err(RuntimeError::new(format!(
            "unsupported math function {name:?}"
        ))),
    }
}

fn timestamp_namespace(name: &str, arguments: Vec<EvalValue>) -> Result<EvalValue, RuntimeError> {
    match name {
        "date" => {
            let [year, month, day] = exact_arguments::<3>(name, arguments)?;
            let year = i32::try_from(data_integer(year)?)
                .map_err(|_| RuntimeError::new("timestamp year is outside range"))?;
            let month = u8::try_from(data_integer(month)?)
                .map_err(|_| RuntimeError::new("timestamp month is outside range"))?;
            let day = u8::try_from(data_integer(day)?)
                .map_err(|_| RuntimeError::new("timestamp day is outside range"))?;
            let month = Month::try_from(month)
                .map_err(|error| RuntimeError::new(format!("invalid month: {error}")))?;
            let date = Date::from_calendar_date(year, month, day)
                .map_err(|error| RuntimeError::new(format!("invalid date: {error}")))?;
            Ok(EvalValue::Data(Value::Timestamp(
                Timestamp::from_offset_date_time(date.midnight().assume_utc()),
            )))
        }
        _ => Err(RuntimeError::new(format!(
            "unsupported timestamp function {name:?}"
        ))),
    }
}

fn duration_method(
    value: RulesDuration,
    name: &str,
    arguments: Vec<EvalValue>,
) -> Result<EvalValue, RuntimeError> {
    no_arguments(name, arguments)?;
    match name {
        "seconds" => Ok(EvalValue::Data(Value::Integer(value.seconds))),
        "nanos" => Ok(EvalValue::Data(Value::Integer(i64::from(
            value.nanoseconds,
        )))),
        _ => Err(RuntimeError::new(format!(
            "unsupported duration method {name:?}"
        ))),
    }
}

fn timestamp_method(
    value: Timestamp,
    name: &str,
    arguments: Vec<EvalValue>,
) -> Result<EvalValue, RuntimeError> {
    no_arguments(name, arguments)?;
    let value = value
        .to_offset_date_time()
        .map_err(|error| RuntimeError::new(format!("invalid timestamp: {error}")))?;
    let component = match name {
        "year" => i64::from(value.year()),
        "month" => i64::from(u8::from(value.month())),
        "day" => i64::from(value.day()),
        "dayOfWeek" => i64::from(value.weekday().number_from_monday()),
        "hours" => i64::from(value.hour()),
        "minutes" => i64::from(value.minute()),
        "seconds" => i64::from(value.second()),
        "nanos" => i64::from(value.nanosecond()),
        "date" => {
            let midnight = value.date().midnight().assume_utc();
            return Ok(EvalValue::Data(Value::Timestamp(
                Timestamp::from_offset_date_time(midnight),
            )));
        }
        "time" => {
            let nanos = i128::from(value.hour()) * 3_600_000_000_000
                + i128::from(value.minute()) * 60_000_000_000
                + i128::from(value.second()) * 1_000_000_000
                + i128::from(value.nanosecond());
            return Ok(EvalValue::Data(Value::Duration(
                RulesDuration::from_nanoseconds(nanos),
            )));
        }
        _ => {
            return Err(RuntimeError::new(format!(
                "unsupported timestamp method {name:?}"
            )));
        }
    };
    Ok(EvalValue::Data(Value::Integer(component)))
}

fn latlng_method(
    value: LatLng,
    name: &str,
    arguments: Vec<EvalValue>,
) -> Result<EvalValue, RuntimeError> {
    match name {
        "latitude" => {
            no_arguments(name, arguments)?;
            Ok(EvalValue::Data(Value::Float(value.latitude)))
        }
        "longitude" => {
            no_arguments(name, arguments)?;
            Ok(EvalValue::Data(Value::Float(value.longitude)))
        }
        "distance" => {
            let EvalValue::Data(Value::LatLng(other)) = one_argument(name, arguments)? else {
                return Err(RuntimeError::new("distance expects a latlng argument"));
            };
            Ok(EvalValue::Data(Value::Float(haversine_distance(
                value, other,
            ))))
        }
        _ => Err(RuntimeError::new(format!(
            "unsupported latlng method {name:?}"
        ))),
    }
}

fn haversine_distance(left: LatLng, right: LatLng) -> f64 {
    if left == right {
        return 0.0;
    }
    let latitude_delta = (right.latitude - left.latitude).to_radians();
    let longitude_delta = (right.longitude - left.longitude).to_radians();
    let left_latitude = left.latitude.to_radians();
    let right_latitude = right.latitude.to_radians();
    let a = (latitude_delta / 2.0).sin().powi(2)
        + left_latitude.cos() * right_latitude.cos() * (longitude_delta / 2.0).sin().powi(2);
    6_371_000.0 * 2.0 * a.sqrt().asin()
}
