//! Source-only report layout. Counts/values come from actual evaluation later.
use std::collections::BTreeSet;
use std::ops::Range;

use crate::ast::{Expr, ExprKind, Function, MatchBlock, PathPart, Program};

/// Official coverage coordinates, distinct from compiler UTF-8 byte offsets.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SourcePosition {
    /// One-based source line.
    pub line: usize,
    /// One-based Unicode-scalar column.
    pub column: usize,
    /// Zero-based Unicode-scalar start offset.
    pub current_offset: usize,
    /// Inclusive Unicode-scalar end offset.
    pub end_offset: usize,
}

/// One dynamic expression or function body in the source-only coverage tree.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CoverageNode {
    /// Stable internal expression identity within this immutable source.
    pub expression_key: crate::ExpressionKey,
    /// Range observed by the coverage protocol, not a byte slicing range.
    pub source_position: SourcePosition,
    /// Dynamic child expressions in source order; literals are omitted.
    pub children: Vec<Self>,
}

struct SourceIndex {
    boundaries: Vec<usize>,
    line_starts: Vec<usize>,
}

impl SourceIndex {
    fn new(source: &str) -> Self {
        let mut boundaries = Vec::new();
        let mut line_starts = vec![0];
        for (index, (byte, character)) in source.char_indices().enumerate() {
            boundaries.push(byte);
            if character == '\n' {
                line_starts.push(index + 1);
            }
        }
        boundaries.push(source.len());
        Self {
            boundaries,
            line_starts,
        }
    }

    fn position(&self, span: Range<usize>) -> SourcePosition {
        let start = self
            .boundaries
            .binary_search(&span.start)
            .expect("parser start boundary");
        let end = self
            .boundaries
            .binary_search(&span.end)
            .expect("parser end boundary");
        let line = self.line_starts.partition_point(|offset| *offset <= start);
        SourcePosition {
            line,
            column: start - self.line_starts[line - 1] + 1,
            current_offset: start,
            end_offset: end.saturating_sub(1).max(start),
        }
    }

    fn expression(&self, expression: &Expr, bound: &BTreeSet<String>) -> Option<CoverageNode> {
        let children: Vec<&Expr> = match &expression.kind {
            ExprKind::Null
            | ExprKind::Bool(_)
            | ExprKind::Integer(_)
            | ExprKind::Float(_)
            | ExprKind::String(_) => return None,
            ExprKind::Variable(name) => {
                if !bound.contains(name)
                    && matches!(
                        name.as_str(),
                        "duration" | "hashing" | "latlng" | "math" | "timestamp"
                    )
                {
                    return None;
                }
                vec![]
            }
            ExprKind::Field { base, .. } => vec![base],
            ExprKind::Index { base, index } => vec![base, index],
            ExprKind::Slice { base, start, end } => {
                let mut children = vec![base.as_ref()];
                children.extend(start.as_deref());
                children.extend(end.as_deref());
                children
            }
            ExprKind::List(values) => values.iter().collect(),
            ExprKind::Map(entries) => entries.iter().map(|(_, value)| value).collect(),
            ExprKind::Path(parts) => parts
                .iter()
                .filter_map(|part| match part {
                    PathPart::Interpolation(value) => Some(value),
                    PathPart::Literal(_) => None,
                })
                .collect(),
            ExprKind::Call { callee, arguments } => {
                let mut children = Vec::new();
                if let ExprKind::Field { base, .. } = &callee.kind {
                    children.push(base.as_ref());
                }
                children.extend(arguments);
                children
            }
            ExprKind::Unary { operand, .. } => vec![operand],
            ExprKind::Binary { left, right, .. } => vec![left, right],
            ExprKind::Is { value, .. } => vec![value],
        };
        Some(CoverageNode {
            expression_key: crate::ExpressionKey {
                start: expression.span.start,
                end: expression.span.end,
            },
            source_position: self.position(expression.span.start..Self::report_end(expression)),
            children: children
                .into_iter()
                .filter_map(|child| self.expression(child, bound))
                .collect(),
        })
    }

    // An operator's final operand contributes its report range, which can end
    // before the raw syntax ends (for example a list's closing bracket).
    fn report_end(expression: &Expr) -> usize {
        match &expression.kind {
            ExprKind::List(values) => values
                .last()
                .map_or(expression.span.start + 1, Self::report_end),
            ExprKind::Map(entries) => entries
                .last()
                .map_or(expression.span.start + 1, |(_, value)| {
                    Self::report_end(value)
                }),
            ExprKind::Call { callee, arguments } => {
                arguments.last().map_or(callee.span.end, Self::report_end)
            }
            ExprKind::Index { index, .. } => Self::report_end(index),
            ExprKind::Slice { .. } => expression.span.end - 1,
            ExprKind::Unary { operand, .. } => Self::report_end(operand),
            ExprKind::Binary { right, .. } => Self::report_end(right),
            _ => expression.span.end,
        }
    }

    fn function(&self, function: &Function, inherited: &BTreeSet<String>) -> Option<CoverageNode> {
        let mut bound = inherited.clone();
        bound.extend(function.parameters.iter().cloned());
        if function.lets.is_empty() {
            return self.expression(&function.result, &bound);
        }
        let mut children = Vec::new();
        for (name, expression) in &function.lets {
            children.extend(self.expression(expression, &bound));
            bound.insert(name.clone());
        }
        children.extend(self.expression(&function.result, &bound));
        Some(CoverageNode {
            expression_key: crate::ExpressionKey {
                start: function.body_start,
                end: function.result.span.end,
            },
            source_position: self.position(function.body_start..Self::report_end(&function.result)),
            children,
        })
    }

    fn block(
        &self,
        block: &MatchBlock,
        nodes: &mut Vec<CoverageNode>,
        inherited: &BTreeSet<String>,
    ) {
        let mut bound = inherited.clone();
        for part in &block.pattern {
            if let crate::ast::PatternSegment::Wildcard(name)
            | crate::ast::PatternSegment::RecursiveWildcard(name) = part
            {
                bound.insert(name.clone());
            }
        }
        nodes.extend(
            block
                .functions
                .values()
                .filter_map(|function| self.function(function, &bound)),
        );
        nodes.extend(
            block
                .allows
                .iter()
                .filter_map(|allow| self.expression(&allow.condition, &bound)),
        );
        for child in &block.children {
            self.block(child, nodes, &bound);
        }
    }
}

pub(crate) fn layout(program: &Program, source: &str) -> Vec<CoverageNode> {
    let index = SourceIndex::new(source);
    let bound = BTreeSet::new();
    let mut nodes: Vec<_> = program
        .functions
        .values()
        .filter_map(|function| index.function(function, &bound))
        .collect();
    for block in &program.matches {
        index.block(block, &mut nodes, &bound);
    }
    nodes.sort_by_key(|node| node.source_position.current_offset);
    nodes
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn json_node(node: &CoverageNode) -> Value {
        let position = node.source_position;
        let mut value = json!({ "sourcePosition": {
            "line": position.line, "column": position.column,
            "currentOffset": position.current_offset, "endOffset": position.end_offset,
        }});
        if !node.children.is_empty() {
            value["children"] = Value::Array(node.children.iter().map(json_node).collect());
        }
        value
    }

    #[test]
    fn layouts_match_every_captured_before_evaluation_tree() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../conformance/fixtures/developer-tools-coverage-v1/fixture.json"
        ))
        .unwrap();
        for profile in fixture["profiles"].as_array().unwrap() {
            let rules = crate::compile(profile["source"].as_str().unwrap()).unwrap();
            let actual = Value::Array(rules.coverage_layout().iter().map(json_node).collect());
            let expected = profile["before"]
                .get("report")
                .cloned()
                .unwrap_or_else(|| json!([]));
            assert_eq!(actual, expected, "{}", profile["id"]);
        }
    }

    #[test]
    fn existing_expression_corpus_has_valid_stable_source_ranges() {
        let corpus: Value = serde_json::from_str(include_str!(
            "../../../conformance/fixtures/rules-v2/production-expression-corpus.json"
        ))
        .unwrap();
        for batch in corpus["batches"].as_array().unwrap() {
            let source = batch["source"].as_str().unwrap();
            let rules = crate::compile(source).unwrap();
            let layout = rules.coverage_layout();
            assert_eq!(layout, rules.coverage_layout());
            assert_positions(&layout, source);
        }
        let source = include_str!("../../../conformance/fixtures/rules-v2/complex-firestore.rules");
        assert_positions(&crate::compile(source).unwrap().coverage_layout(), source);
    }

    fn assert_positions(nodes: &[CoverageNode], source: &str) {
        let characters: Vec<_> = source.chars().collect();
        for node in nodes {
            let position = node.source_position;
            assert!(position.current_offset <= position.end_offset);
            assert!(position.end_offset < characters.len());
            let prefix = &characters[..position.current_offset];
            assert_eq!(
                position.line,
                prefix.iter().filter(|c| **c == '\n').count() + 1
            );
            assert_eq!(
                position.column,
                prefix.iter().rev().take_while(|c| **c != '\n').count() + 1
            );
            assert_positions(&node.children, source);
        }
    }
}
