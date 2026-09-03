//! Clean-room Firestore Security Rules v2 compiler and evaluator.
//!
//! Phase 3 behavior is derived from the frozen production and official Java
//! oracle fixtures under `conformance/fixtures/rules-v2`.

#![forbid(unsafe_code)]

mod ast;
mod evaluator;
mod lexer;
mod model;
mod parser;

pub use model::{
    AtomicEvaluationResult, Auth, ConstraintOperator, DocumentAccess, DocumentAccessError,
    EmptyDocumentAccess, EvaluationRequest, EvaluationResult, FieldConstraint, LatLng, Query,
    QueryFilter, QueryScope, RequestOperation, Resource, RulesDuration, RuntimeError, Timestamp,
    TimestampParseError, Value,
};

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use ast::{Expr, MatchBlock, Program};

/// Maximum UTF-8 source size accepted by a deployed ruleset.
pub const MAXIMUM_SOURCE_BYTES: usize = 262_144;

/// Severity attached to a compiler diagnostic.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DiagnosticSeverity {
    /// The ruleset cannot be installed.
    Error,
    /// The ruleset is valid but contains a suspicious construct.
    Warning,
}

/// One source-positioned rules compiler diagnostic.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Diagnostic {
    /// Diagnostic severity.
    pub severity: DiagnosticSeverity,
    /// Human-readable explanation.
    pub message: String,
    /// One-based source line.
    pub line: usize,
    /// One-based Unicode-scalar source column.
    pub column: usize,
    /// Zero-based UTF-8 byte offset.
    pub byte_offset: usize,
}

/// Structural counts for an installed ruleset.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RulesetStatistics {
    /// Match declarations, including nested matches.
    pub matches: usize,
    /// Allow declarations before method expansion.
    pub allows: usize,
    /// User-defined functions.
    pub functions: usize,
    /// Literal, single-wildcard, and recursive-wildcard match segments.
    pub pattern_segments: usize,
    /// Expanded concrete operations covered by allow declarations.
    pub operations: usize,
    /// User-defined function parameters.
    pub parameters: usize,
    /// Parsed expression nodes.
    pub expressions: usize,
}

/// Parsed and validated Firestore Security Rules v2 source.
#[derive(Clone, Debug)]
pub struct Ruleset {
    program: Arc<Program>,
}

impl Ruleset {
    /// Returns stable structural counts for diagnostics and gate evidence.
    #[must_use]
    pub fn statistics(&self) -> RulesetStatistics {
        RulesetStatistics {
            matches: self.program.match_count(),
            allows: self.program.allow_count(),
            functions: self.program.function_count(),
            pattern_segments: self.program.pattern_segment_count(),
            operations: self.program.operation_count(),
            parameters: self.program.parameter_count(),
            expressions: self.program.expression_count(),
        }
    }

    /// Evaluates one request against this immutable ruleset and snapshot.
    #[must_use]
    pub fn evaluate<A: DocumentAccess + ?Sized>(
        &self,
        request: &EvaluationRequest,
        access: &A,
    ) -> EvaluationResult {
        evaluator::evaluate(&self.program, request, access)
    }

    /// Evaluates a transaction or batched write with one shared 20-access
    /// budget while retaining the frozen 10-access per-operation limit.
    #[must_use]
    pub fn evaluate_atomic<A: DocumentAccess + ?Sized>(
        &self,
        requests: &[EvaluationRequest],
        access: &A,
    ) -> AtomicEvaluationResult {
        evaluator::evaluate_atomic(&self.program, requests, access)
    }
}

/// Compiles Firestore Security Rules v2 source without consulting runtime data.
///
/// # Errors
///
/// Returns source-positioned diagnostics for oversized, malformed, recursive,
/// or over-depth rulesets. A caller must keep the previously installed ruleset
/// when this function returns an error.
pub fn compile(source: &str) -> Result<Ruleset, Vec<Diagnostic>> {
    if source.len() > MAXIMUM_SOURCE_BYTES {
        return Err(vec![diagnostic(
            source,
            MAXIMUM_SOURCE_BYTES.min(source.len()),
            format!(
                "rules source is {} bytes; maximum is {MAXIMUM_SOURCE_BYTES}",
                source.len()
            ),
        )]);
    }
    let program = parser::parse(source)
        .map_err(|error| vec![diagnostic(source, error.offset, error.message)])?;
    let mut validation = Vec::new();
    validate_function_map(source, &program.functions, &mut validation);
    for block in &program.matches {
        validate_functions(source, block, &mut validation);
    }
    if validation.is_empty() {
        Ok(Ruleset {
            program: Arc::new(program),
        })
    } else {
        Err(validation)
    }
}

fn validate_functions(source: &str, block: &MatchBlock, diagnostics: &mut Vec<Diagnostic>) {
    validate_function_map(source, &block.functions, diagnostics);
    for child in &block.children {
        validate_functions(source, child, diagnostics);
    }
}

fn validate_function_map(
    source: &str,
    functions: &BTreeMap<String, ast::Function>,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let function_names = functions.keys().cloned().collect::<BTreeSet<_>>();
    let graph = functions
        .iter()
        .map(|(name, function)| {
            let mut calls = BTreeSet::new();
            for (_, value) in &function.lets {
                collect_direct_calls(value, &mut calls);
            }
            collect_direct_calls(&function.result, &mut calls);
            calls.retain(|called| function_names.contains(called));
            (name.clone(), calls)
        })
        .collect::<BTreeMap<_, _>>();
    let mut memo = BTreeMap::new();
    for name in graph.keys() {
        let mut visiting = BTreeSet::new();
        match function_depth(name, &graph, &mut visiting, &mut memo) {
            Ok(depth) if depth > 21 => diagnostics.push(diagnostic(
                source,
                0,
                "maximum allowed function call depth of 20 is exceeded".to_owned(),
            )),
            Ok(_) => {}
            Err(cycle) => diagnostics.push(diagnostic(
                source,
                0,
                format!("recursive function call is not allowed: {cycle}"),
            )),
        }
    }
}

fn function_depth(
    name: &str,
    graph: &BTreeMap<String, BTreeSet<String>>,
    visiting: &mut BTreeSet<String>,
    memo: &mut BTreeMap<String, usize>,
) -> Result<usize, String> {
    if let Some(depth) = memo.get(name) {
        return Ok(*depth);
    }
    if !visiting.insert(name.to_owned()) {
        return Err(name.to_owned());
    }
    let mut depth = 1_usize;
    if let Some(calls) = graph.get(name) {
        for called in calls {
            depth = depth.max(1 + function_depth(called, graph, visiting, memo)?);
        }
    }
    visiting.remove(name);
    memo.insert(name.to_owned(), depth);
    Ok(depth)
}

fn collect_direct_calls(expression: &Expr, calls: &mut BTreeSet<String>) {
    match expression {
        Expr::Call { callee, arguments } => {
            if let Expr::Variable(name) = callee.as_ref() {
                calls.insert(name.clone());
            }
            collect_direct_calls(callee, calls);
            for argument in arguments {
                collect_direct_calls(argument, calls);
            }
        }
        Expr::List(values) => {
            for value in values {
                collect_direct_calls(value, calls);
            }
        }
        Expr::Map(entries) => {
            for (_, value) in entries {
                collect_direct_calls(value, calls);
            }
        }
        Expr::Path(parts) => {
            for part in parts {
                if let ast::PathPart::Interpolation(value) = part {
                    collect_direct_calls(value, calls);
                }
            }
        }
        Expr::Field { base, .. } => collect_direct_calls(base, calls),
        Expr::Index { base, index } => {
            collect_direct_calls(base, calls);
            collect_direct_calls(index, calls);
        }
        Expr::Slice { base, start, end } => {
            collect_direct_calls(base, calls);
            if let Some(start) = start {
                collect_direct_calls(start, calls);
            }
            if let Some(end) = end {
                collect_direct_calls(end, calls);
            }
        }
        Expr::Unary { operand, .. } => collect_direct_calls(operand, calls),
        Expr::Binary { left, right, .. } => {
            collect_direct_calls(left, calls);
            collect_direct_calls(right, calls);
        }
        Expr::Is { value, .. } => collect_direct_calls(value, calls),
        Expr::Null
        | Expr::Bool(_)
        | Expr::Integer(_)
        | Expr::Float(_)
        | Expr::String(_)
        | Expr::Variable(_) => {}
    }
}

fn diagnostic(source: &str, offset: usize, message: String) -> Diagnostic {
    let offset = offset.min(source.len());
    let before = &source[..offset];
    let line = before.bytes().filter(|byte| *byte == b'\n').count() + 1;
    let column = before
        .rsplit_once('\n')
        .map_or(before, |(_, line)| line)
        .chars()
        .count()
        + 1;
    Diagnostic {
        severity: DiagnosticSeverity::Error,
        message,
        line,
        column,
        byte_offset: offset,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value as JsonValue;

    const COMPLEX_RULES: &str =
        include_str!("../../../conformance/fixtures/rules-v2/complex-firestore.rules");
    const PARSE_ORACLE: &str =
        include_str!("../../../conformance/fixtures/rules-v2/production-parse-errors.json");

    #[test]
    fn compiles_the_frozen_complex_ruleset() {
        let rules = compile(COMPLEX_RULES).expect("frozen complex rules should compile");
        let statistics = rules.statistics();
        assert!(statistics.matches >= 70, "{statistics:?}");
        assert!(statistics.allows >= 300, "{statistics:?}");
        assert!(statistics.functions >= 10, "{statistics:?}");
    }

    #[test]
    fn rejects_oversized_source_before_parsing() {
        let source = "x".repeat(MAXIMUM_SOURCE_BYTES + 1);
        let error = compile(&source).expect_err("oversized source must fail");
        assert!(error[0].message.contains("maximum is 262144"));
    }

    #[test]
    fn rejects_recursive_functions() {
        let source = r"
          rules_version = '2'; service cloud.firestore {
            match /databases/{database}/documents {
              function recurse() { return recurse(); }
              match /items/{item} { allow get: if recurse(); }
            }
          }
        ";
        let error = compile(source).expect_err("recursive function must fail");
        assert!(error[0].message.contains("recursive function"));
    }

    #[test]
    fn replays_the_frozen_production_parse_boundary() {
        let fixture: JsonValue =
            serde_json::from_str(PARSE_ORACLE).expect("parse fixture should be valid JSON");
        let observations = fixture["observations"]
            .as_array()
            .expect("parse observations should be an array");
        for observation in observations {
            let id = observation["id"]
                .as_str()
                .expect("observation id should be a string");
            let source = observation["source"]
                .as_str()
                .expect("observation source should be a string");
            let result = compile(source);
            match id {
                "unexpected-token"
                | "unclosed-block"
                | "duplicate-let"
                | "recursive-function"
                | "invalid-recursive-wildcard"
                | "source-bytes-262145" => {
                    assert!(result.is_err(), "{id} must be rejected");
                }
                "undefined-name"
                | "invalid-function-arity"
                | "source-bytes-255999"
                | "source-bytes-256000"
                | "source-bytes-256001"
                | "source-bytes-262143"
                | "source-bytes-262144" => {
                    assert!(result.is_ok(), "{id} should compile: {result:?}");
                }
                other => panic!("unclassified frozen parse observation {other}"),
            }
        }
    }
}
