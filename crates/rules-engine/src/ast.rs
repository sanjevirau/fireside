use std::collections::BTreeMap;

#[derive(Clone, Debug)]
pub(crate) struct Program {
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
        self.matches.iter().map(MatchBlock::function_count).sum()
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
        self.matches.iter().map(MatchBlock::parameter_count).sum()
    }

    pub(crate) fn expression_count(&self) -> usize {
        self.matches.iter().map(MatchBlock::expression_count).sum()
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
    pub(crate) parameters: Vec<String>,
    pub(crate) lets: Vec<(String, Expr)>,
    pub(crate) result: Expr,
}

#[derive(Clone, Debug)]
pub(crate) struct Allow {
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
pub(crate) enum Expr {
    Null,
    Bool(bool),
    Integer(i64),
    Float(f64),
    String(String),
    List(Vec<Self>),
    Map(Vec<(String, Self)>),
    Path(Vec<PathPart>),
    Variable(String),
    Field {
        base: Box<Self>,
        name: String,
    },
    Index {
        base: Box<Self>,
        index: Box<Self>,
    },
    Slice {
        base: Box<Self>,
        start: Option<Box<Self>>,
        end: Option<Box<Self>>,
    },
    Call {
        callee: Box<Self>,
        arguments: Vec<Self>,
    },
    Unary {
        operator: UnaryOperator,
        operand: Box<Self>,
    },
    Binary {
        operator: BinaryOperator,
        left: Box<Self>,
        right: Box<Self>,
    },
    Is {
        value: Box<Self>,
        expected: TypeName,
    },
}

impl Expr {
    fn node_count(&self) -> usize {
        1 + match self {
            Self::List(values) => values.iter().map(Self::node_count).sum(),
            Self::Map(entries) => entries.iter().map(|(_, value)| value.node_count()).sum(),
            Self::Path(parts) => parts
                .iter()
                .map(|part| match part {
                    PathPart::Literal(_) => 0,
                    PathPart::Interpolation(expression) => expression.node_count(),
                })
                .sum(),
            Self::Field { base, .. } => base.node_count(),
            Self::Index { base, index } => base.node_count() + index.node_count(),
            Self::Slice { base, start, end } => {
                base.node_count()
                    + start.as_deref().map_or(0, Self::node_count)
                    + end.as_deref().map_or(0, Self::node_count)
            }
            Self::Call { callee, arguments } => {
                callee.node_count() + arguments.iter().map(Self::node_count).sum::<usize>()
            }
            Self::Unary { operand, .. } => operand.node_count(),
            Self::Binary { left, right, .. } => left.node_count() + right.node_count(),
            Self::Is { value, .. } => value.node_count(),
            Self::Null
            | Self::Bool(_)
            | Self::Integer(_)
            | Self::Float(_)
            | Self::String(_)
            | Self::Variable(_) => 0,
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
