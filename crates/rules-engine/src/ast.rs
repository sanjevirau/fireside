use std::collections::BTreeMap;

#[derive(Clone, Debug)]
pub(crate) struct Program {
    pub(crate) functions: BTreeMap<String, Function>,
    pub(crate) matches: Vec<MatchBlock>,
}

impl Program {
    pub(crate) fn match_count(&self) -> usize {
        self.matches.iter().map(MatchBlock::match_count).sum()
    }

    pub(crate) fn allow_count(&self) -> usize {
        self.matches.iter().map(MatchBlock::allow_count).sum()
    }

    pub(crate) fn function_count(&self) -> usize {
        self.functions.len()
            + self
                .matches
                .iter()
                .map(MatchBlock::function_count)
                .sum::<usize>()
    }

    pub(crate) fn pattern_segment_count(&self) -> usize {
        self.matches
            .iter()
            .map(MatchBlock::pattern_segment_count)
            .sum()
    }

    pub(crate) fn operation_count(&self) -> usize {
        self.matches.iter().map(MatchBlock::operation_count).sum()
    }

    pub(crate) fn parameter_count(&self) -> usize {
        self.functions
            .values()
            .map(|function| function.parameters.len())
            .sum::<usize>()
            + self
                .matches
                .iter()
                .map(MatchBlock::parameter_count)
                .sum::<usize>()
    }

    pub(crate) fn expression_count(&self) -> usize {
        self.functions
            .values()
            .map(|function| {
                function
                    .lets
                    .iter()
                    .map(|(_, expression)| expression.node_count())
                    .sum::<usize>()
                    + function.result.node_count()
            })
            .sum::<usize>()
            + self
                .matches
                .iter()
                .map(MatchBlock::expression_count)
                .sum::<usize>()
    }
}

#[derive(Clone, Debug)]
pub(crate) struct MatchBlock {
    pub(crate) pattern: Vec<PatternSegment>,
    pub(crate) functions: BTreeMap<String, Function>,
    pub(crate) allows: Vec<Allow>,
    pub(crate) children: Vec<Self>,
}

impl MatchBlock {
    fn match_count(&self) -> usize {
        1 + self.children.iter().map(Self::match_count).sum::<usize>()
    }

    fn allow_count(&self) -> usize {
        self.allows.len() + self.children.iter().map(Self::allow_count).sum::<usize>()
    }

    fn function_count(&self) -> usize {
        self.functions.len()
            + self
                .children
                .iter()
                .map(Self::function_count)
                .sum::<usize>()
    }

    fn pattern_segment_count(&self) -> usize {
        self.pattern.len()
            + self
                .children
                .iter()
                .map(Self::pattern_segment_count)
                .sum::<usize>()
    }

    fn operation_count(&self) -> usize {
        self.allows
            .iter()
            .map(|allow| allow.operations.len())
            .sum::<usize>()
            + self
                .children
                .iter()
                .map(Self::operation_count)
                .sum::<usize>()
    }

    fn parameter_count(&self) -> usize {
        self.functions
            .values()
            .map(|function| function.parameters.len())
            .sum::<usize>()
            + self
                .children
                .iter()
                .map(Self::parameter_count)
                .sum::<usize>()
    }

    fn expression_count(&self) -> usize {
        self.functions
            .values()
            .map(|function| {
                function
                    .lets
                    .iter()
                    .map(|(_, expression)| expression.node_count())
                    .sum::<usize>()
                    + function.result.node_count()
            })
            .sum::<usize>()
            + self
                .allows
                .iter()
                .map(|allow| allow.condition.node_count())
                .sum::<usize>()
            + self
                .children
                .iter()
                .map(Self::expression_count)
                .sum::<usize>()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum PatternSegment {
    Literal(String),
    Wildcard(String),
    RecursiveWildcard(String),
}

#[derive(Clone, Debug)]
pub(crate) struct Function {
    pub(crate) body_start: usize,
    pub(crate) parameters: Vec<String>,
    pub(crate) lets: Vec<(String, Expr)>,
    pub(crate) result: Expr,
}

#[derive(Clone, Debug)]
pub(crate) struct Allow {
    pub(crate) location: crate::AllowLocation,
    pub(crate) operations: Vec<Operation>,
    pub(crate) condition: Expr,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Operation {
    Get,
    List,
    Create,
    Update,
    Delete,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Expr {
    pub(crate) kind: ExprKind,
    /// Half-open UTF-8 source span. Coverage converts to its scalar positions.
    pub(crate) span: std::ops::Range<usize>,
}

impl Expr {
    pub(crate) const fn new(kind: ExprKind, start: usize, end: usize) -> Self {
        Self {
            kind,
            span: start..end,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum ExprKind {
    Null,
    Bool(bool),
    Integer(i64),
    Float(f64),
    String(String),
    List(Vec<Expr>),
    Map(Vec<(String, Expr)>),
    Path(Vec<PathPart>),
    Variable(String),
    Field {
        base: Box<Expr>,
        name: String,
    },
    Index {
        base: Box<Expr>,
        index: Box<Expr>,
    },
    Slice {
        base: Box<Expr>,
        start: Option<Box<Expr>>,
        end: Option<Box<Expr>>,
    },
    Call {
        callee: Box<Expr>,
        arguments: Vec<Expr>,
    },
    Unary {
        operator: UnaryOperator,
        operand: Box<Expr>,
    },
    Binary {
        operator: BinaryOperator,
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Is {
        value: Box<Expr>,
        expected: TypeName,
    },
}

impl Expr {
    fn node_count(&self) -> usize {
        1 + match &self.kind {
            ExprKind::List(values) => values.iter().map(Self::node_count).sum(),
            ExprKind::Map(entries) => entries.iter().map(|(_, value)| value.node_count()).sum(),
            ExprKind::Path(parts) => parts
                .iter()
                .map(|part| match part {
                    PathPart::Literal(_) => 0,
                    PathPart::Interpolation(expression) => expression.node_count(),
                })
                .sum(),
            ExprKind::Field { base, .. } => base.node_count(),
            ExprKind::Index { base, index } => base.node_count() + index.node_count(),
            ExprKind::Slice { base, start, end } => {
                base.node_count()
                    + start.as_deref().map_or(0, Self::node_count)
                    + end.as_deref().map_or(0, Self::node_count)
            }
            ExprKind::Call { callee, arguments } => {
                callee.node_count() + arguments.iter().map(Self::node_count).sum::<usize>()
            }
            ExprKind::Unary { operand, .. } => operand.node_count(),
            ExprKind::Binary { left, right, .. } => left.node_count() + right.node_count(),
            ExprKind::Is { value, .. } => value.node_count(),
            ExprKind::Null
            | ExprKind::Bool(_)
            | ExprKind::Integer(_)
            | ExprKind::Float(_)
            | ExprKind::String(_)
            | ExprKind::Variable(_) => 0,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum PathPart {
    Literal(String),
    Interpolation(Expr),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum UnaryOperator {
    Not,
    Negate,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum BinaryOperator {
    Or,
    And,
    Equal,
    NotEqual,
    Less,
    LessEqual,
    Greater,
    GreaterEqual,
    In,
    Add,
    Subtract,
    Multiply,
    Divide,
    Remainder,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TypeName {
    Null,
    Bool,
    Int,
    Float,
    Number,
    String,
    List,
    Map,
    Timestamp,
    Duration,
    Path,
    Bytes,
    LatLng,
}
