use std::collections::{BTreeMap, BTreeSet};
use std::mem::discriminant;

use crate::ast::{
    Allow, BinaryOperator, Expr, Function, MatchBlock, Operation, PathPart, PatternSegment,
    Program, TypeName, UnaryOperator,
};
use crate::lexer::{Token, TokenKind, lex};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ParseError {
    pub(crate) message: String,
    pub(crate) offset: usize,
}

pub(crate) fn parse(source: &str) -> Result<Program, ParseError> {
    let tokens = lex(source).map_err(|error| ParseError {
        message: error.message,
        offset: error.offset,
    })?;
    Parser::new(tokens).program()
}

struct Parser {
    tokens: Vec<Token>,
    index: usize,
}

impl Parser {
    const fn new(tokens: Vec<Token>) -> Self {
        Self { tokens, index: 0 }
    }

    fn program(mut self) -> Result<Program, ParseError> {
        self.expect_identifier("rules_version")?;
        self.expect(&TokenKind::Assign, "'=' after rules_version")?;
        let version = self.take_string("rules version string")?;
        if version != "2" {
            return Err(self.error_at_previous("only rules_version = '2' is supported"));
        }
        self.expect(&TokenKind::Semicolon, "';' after rules_version")?;
        self.expect_identifier("service")?;
        self.expect_identifier("cloud")?;
        self.expect(&TokenKind::Dot, "'.' in cloud.firestore")?;
        self.expect_identifier("firestore")?;
        self.expect(&TokenKind::LeftBrace, "'{' after service cloud.firestore")?;
        let mut functions = BTreeMap::new();
        let mut matches = Vec::new();
        while !self.check(&TokenKind::RightBrace) {
            if self.check_identifier("function") {
                let (name, function) = self.function()?;
                if functions.insert(name.clone(), function).is_some() {
                    return Err(self.error_at_previous(format!(
                        "function {name:?} is declared more than once"
                    )));
                }
            } else if self.check_identifier("match") {
                matches.push(self.match_block()?);
            } else {
                return Err(self.error("expected a function or match declaration in service block"));
            }
        }
        self.advance();
        self.expect(&TokenKind::Eof, "end of rules source")?;
        if matches.is_empty() {
            return Err(self.error_at_previous("service must contain at least one match"));
        }
        Ok(Program { functions, matches })
    }

    fn match_block(&mut self) -> Result<MatchBlock, ParseError> {
        self.expect_identifier("match")?;
        let raw = self.take_path("match path")?;
        let pattern = parse_pattern(&raw, self.previous_offset())?;
        self.expect(&TokenKind::LeftBrace, "'{' after match path")?;
        let mut functions = BTreeMap::new();
        let mut allows = Vec::new();
        let mut children = Vec::new();
        while !self.check(&TokenKind::RightBrace) {
            if self.check_identifier("function") {
                let (name, function) = self.function()?;
                if functions.insert(name.clone(), function).is_some() {
                    return Err(self.error_at_previous(format!(
                        "function {name:?} is declared more than once"
                    )));
                }
            } else if self.check_identifier("allow") {
                allows.push(self.allow()?);
            } else if self.check_identifier("match") {
                children.push(self.match_block()?);
            } else {
                return Err(self.error("expected function, allow, or nested match"));
            }
        }
        self.advance();
        Ok(MatchBlock {
            pattern,
            functions,
            allows,
            children,
        })
    }

    fn function(&mut self) -> Result<(String, Function), ParseError> {
        self.expect_identifier("function")?;
        let name = self.take_identifier("function name")?;
        self.expect(&TokenKind::LeftParen, "'(' after function name")?;
        let mut parameters = Vec::new();
        if !self.check(&TokenKind::RightParen) {
            loop {
                let parameter = self.take_identifier("function parameter")?;
                if parameters.contains(&parameter) {
                    return Err(self.error_at_previous(format!(
                        "function parameter {parameter:?} is duplicated"
                    )));
                }
                parameters.push(parameter);
                if !self.consume(&TokenKind::Comma) {
                    break;
                }
            }
        }
        self.expect(&TokenKind::RightParen, "')' after function parameters")?;
        self.expect(&TokenKind::LeftBrace, "'{' before function body")?;
        let mut lets = Vec::new();
        let mut names = BTreeSet::new();
        while self.check_identifier("let") {
            self.advance();
            let binding = self.take_identifier("let binding")?;
            if !names.insert(binding.clone()) {
                return Err(
                    self.error_at_previous(format!("let binding {binding:?} is already bound"))
                );
            }
            self.expect(&TokenKind::Assign, "'=' after let binding")?;
            let value = self.expression(0)?;
            self.expect(&TokenKind::Semicolon, "';' after let binding")?;
            lets.push((binding, value));
        }
        self.expect_identifier("return")?;
        let result = self.expression(0)?;
        self.expect(
            &TokenKind::Semicolon,
            "';' after function return expression",
        )?;
        self.expect(&TokenKind::RightBrace, "'}' after function body")?;
        Ok((
            name,
            Function {
                parameters,
                lets,
                result,
            },
        ))
    }

    fn allow(&mut self) -> Result<Allow, ParseError> {
        self.expect_identifier("allow")?;
        let mut operations = Vec::new();
        loop {
            let method = self.take_identifier("allow method")?;
            let expanded: &[Operation] = match method.as_str() {
                "get" => &[Operation::Get],
                "list" => &[Operation::List],
                "read" => &[Operation::Get, Operation::List],
                "create" => &[Operation::Create],
                "update" => &[Operation::Update],
                "delete" => &[Operation::Delete],
                "write" => &[Operation::Create, Operation::Update, Operation::Delete],
                _ => {
                    return Err(
                        self.error_at_previous(format!("unsupported allow method {method:?}"))
                    );
                }
            };
            for operation in expanded {
                if !operations.contains(operation) {
                    operations.push(*operation);
                }
            }
            if !self.consume(&TokenKind::Comma) {
                break;
            }
        }
        self.expect(&TokenKind::Colon, "':' after allow methods")?;
        self.expect_identifier("if")?;
        let condition = self.expression(0)?;
        self.expect(&TokenKind::Semicolon, "';' after allow condition")?;
        Ok(Allow {
            operations,
            condition,
        })
    }

    fn expression(&mut self, minimum_binding_power: u8) -> Result<Expr, ParseError> {
        let mut left = self.prefix()?;
        loop {
            if 30 >= minimum_binding_power && self.consume(&TokenKind::Dot) {
                let name = self.take_identifier("field or method name after '.'")?;
                left = Expr::Field {
                    base: Box::new(left),
                    name,
                };
                continue;
            }
            if 30 >= minimum_binding_power && self.consume(&TokenKind::LeftParen) {
                let arguments = self.arguments()?;
                left = Expr::Call {
                    callee: Box::new(left),
                    arguments,
                };
                continue;
            }
            if 30 >= minimum_binding_power && self.consume(&TokenKind::LeftBracket) {
                left = self.index_or_slice(left)?;
                continue;
            }

            if self.check_identifier("is") {
                let (left_binding_power, right_binding_power) = (8, 9);
                if left_binding_power < minimum_binding_power {
                    break;
                }
                self.advance();
                let name = self.take_identifier("type name after 'is'")?;
                let expected = parse_type_name(&name).ok_or_else(|| {
                    self.error_at_previous(format!("unsupported rules type {name:?}"))
                })?;
                let _ = right_binding_power;
                left = Expr::Is {
                    value: Box::new(left),
                    expected,
                };
                continue;
            }

            let Some((operator, left_binding_power, right_binding_power)) = self.binary_operator()
            else {
                break;
            };
            if left_binding_power < minimum_binding_power {
                break;
            }
            self.advance();
            let right = self.expression(right_binding_power)?;
            left = Expr::Binary {
                operator,
                left: Box::new(left),
                right: Box::new(right),
            };
        }
        Ok(left)
    }

    fn prefix(&mut self) -> Result<Expr, ParseError> {
        let token = self.advance().clone();
        match token.kind {
            TokenKind::Identifier(value) if value == "true" => Ok(Expr::Bool(true)),
            TokenKind::Identifier(value) if value == "false" => Ok(Expr::Bool(false)),
            TokenKind::Identifier(value) if value == "null" => Ok(Expr::Null),
            TokenKind::Identifier(value) => Ok(Expr::Variable(value)),
            TokenKind::String(value) => Ok(Expr::String(value)),
            TokenKind::Integer(value) => Ok(Expr::Integer(value)),
            TokenKind::Float(value) => Ok(Expr::Float(value)),
            TokenKind::Path(value) => parse_expression_path(&value, token.offset),
            TokenKind::Bang => Ok(Expr::Unary {
                operator: UnaryOperator::Not,
                operand: Box::new(self.expression(20)?),
            }),
            TokenKind::Minus => Ok(Expr::Unary {
                operator: UnaryOperator::Negate,
                operand: Box::new(self.expression(20)?),
            }),
            TokenKind::LeftParen => {
                let expression = self.expression(0)?;
                self.expect(&TokenKind::RightParen, "')' after parenthesized expression")?;
                Ok(expression)
            }
            TokenKind::LeftBracket => self.list(),
            TokenKind::LeftBrace => self.map(),
            _ => Err(ParseError {
                message: "expected a rules expression".to_owned(),
                offset: token.offset,
            }),
        }
    }

    fn list(&mut self) -> Result<Expr, ParseError> {
        let mut values = Vec::new();
        if !self.check(&TokenKind::RightBracket) {
            loop {
                values.push(self.expression(0)?);
                if !self.consume(&TokenKind::Comma) {
                    break;
                }
                if self.check(&TokenKind::RightBracket) {
                    break;
                }
            }
        }
        self.expect(&TokenKind::RightBracket, "']' after list literal")?;
        Ok(Expr::List(values))
    }

    fn map(&mut self) -> Result<Expr, ParseError> {
        let mut entries = Vec::new();
        if !self.check(&TokenKind::RightBrace) {
            loop {
                let (TokenKind::String(key) | TokenKind::Identifier(key)) =
                    self.advance().kind.clone()
                else {
                    return Err(self.error_at_previous("map keys must be strings"));
                };
                self.expect(&TokenKind::Colon, "':' after map key")?;
                entries.push((key, self.expression(0)?));
                if !self.consume(&TokenKind::Comma) {
                    break;
                }
                if self.check(&TokenKind::RightBrace) {
                    break;
                }
            }
        }
        self.expect(&TokenKind::RightBrace, "'}' after map literal")?;
        Ok(Expr::Map(entries))
    }

    fn arguments(&mut self) -> Result<Vec<Expr>, ParseError> {
        let mut arguments = Vec::new();
        if !self.check(&TokenKind::RightParen) {
            loop {
                arguments.push(self.expression(0)?);
                if !self.consume(&TokenKind::Comma) {
                    break;
                }
            }
        }
        self.expect(&TokenKind::RightParen, "')' after call arguments")?;
        Ok(arguments)
    }

    fn index_or_slice(&mut self, base: Expr) -> Result<Expr, ParseError> {
        let start = if self.check(&TokenKind::Colon) {
            None
        } else {
            Some(Box::new(self.expression(0)?))
        };
        if self.consume(&TokenKind::Colon) {
            let end = if self.check(&TokenKind::RightBracket) {
                None
            } else {
                Some(Box::new(self.expression(0)?))
            };
            self.expect(&TokenKind::RightBracket, "']' after slice")?;
            return Ok(Expr::Slice {
                base: Box::new(base),
                start,
                end,
            });
        }
        let index = start.ok_or_else(|| self.error("index expression is missing"))?;
        self.expect(&TokenKind::RightBracket, "']' after index")?;
        Ok(Expr::Index {
            base: Box::new(base),
            index,
        })
    }

    fn binary_operator(&self) -> Option<(BinaryOperator, u8, u8)> {
        let operator = match &self.current().kind {
            TokenKind::Or => (BinaryOperator::Or, 1, 2),
            TokenKind::And => (BinaryOperator::And, 3, 4),
            TokenKind::Identifier(value) if value == "in" => (BinaryOperator::In, 7, 8),
            TokenKind::Equal => (BinaryOperator::Equal, 7, 8),
            TokenKind::NotEqual => (BinaryOperator::NotEqual, 7, 8),
            TokenKind::Less => (BinaryOperator::Less, 9, 10),
            TokenKind::LessEqual => (BinaryOperator::LessEqual, 9, 10),
            TokenKind::Greater => (BinaryOperator::Greater, 9, 10),
            TokenKind::GreaterEqual => (BinaryOperator::GreaterEqual, 9, 10),
            TokenKind::Plus => (BinaryOperator::Add, 11, 12),
            TokenKind::Minus => (BinaryOperator::Subtract, 11, 12),
            TokenKind::Star => (BinaryOperator::Multiply, 13, 14),
            TokenKind::Slash => (BinaryOperator::Divide, 13, 14),
            TokenKind::Percent => (BinaryOperator::Remainder, 13, 14),
            _ => return None,
        };
        Some(operator)
    }

    fn expect_identifier(&mut self, expected: &str) -> Result<(), ParseError> {
        match &self.current().kind {
            TokenKind::Identifier(value) if value == expected => {
                self.advance();
                Ok(())
            }
            _ => Err(self.error(format!("expected {expected:?}"))),
        }
    }

    fn take_identifier(&mut self, description: &str) -> Result<String, ParseError> {
        match self.advance().kind.clone() {
            TokenKind::Identifier(value) => Ok(value),
            _ => Err(self.error_at_previous(format!("expected {description}"))),
        }
    }

    fn take_string(&mut self, description: &str) -> Result<String, ParseError> {
        match self.advance().kind.clone() {
            TokenKind::String(value) => Ok(value),
            _ => Err(self.error_at_previous(format!("expected {description}"))),
        }
    }

    fn take_path(&mut self, description: &str) -> Result<String, ParseError> {
        match self.advance().kind.clone() {
            TokenKind::Path(value) => Ok(value),
            _ => Err(self.error_at_previous(format!("expected {description}"))),
        }
    }

    fn expect(&mut self, expected: &TokenKind, description: &str) -> Result<(), ParseError> {
        if self.check(expected) {
            self.advance();
            Ok(())
        } else {
            Err(self.error(format!("expected {description}")))
        }
    }

    fn consume(&mut self, expected: &TokenKind) -> bool {
        if self.check(expected) {
            self.advance();
            true
        } else {
            false
        }
    }

    fn check(&self, expected: &TokenKind) -> bool {
        discriminant(&self.current().kind) == discriminant(expected)
    }

    fn check_identifier(&self, expected: &str) -> bool {
        matches!(&self.current().kind, TokenKind::Identifier(value) if value == expected)
    }

    fn current(&self) -> &Token {
        &self.tokens[self.index]
    }

    fn advance(&mut self) -> &Token {
        let index = self.index;
        if !matches!(self.tokens[index].kind, TokenKind::Eof) {
            self.index += 1;
        }
        &self.tokens[index]
    }

    fn previous_offset(&self) -> usize {
        self.tokens[self.index.saturating_sub(1)].offset
    }

    fn error(&self, message: impl Into<String>) -> ParseError {
        ParseError {
            message: message.into(),
            offset: self.current().offset,
        }
    }

    fn error_at_previous(&self, message: impl Into<String>) -> ParseError {
        ParseError {
            message: message.into(),
            offset: self.previous_offset(),
        }
    }
}

fn parse_pattern(raw: &str, offset: usize) -> Result<Vec<PatternSegment>, ParseError> {
    if !raw.starts_with('/') {
        return Err(ParseError {
            message: "match path must begin with '/'".to_owned(),
            offset,
        });
    }
    let mut recursive_wildcards = 0_usize;
    let mut pattern = Vec::new();
    for segment in raw[1..].split('/') {
        if segment.is_empty() {
            return Err(ParseError {
                message: "match path contains an empty segment".to_owned(),
                offset,
            });
        }
        let parsed = if let Some(wildcard) = segment
            .strip_prefix('{')
            .and_then(|segment| segment.strip_suffix('}'))
        {
            if let Some(name) = wildcard.strip_suffix("=**") {
                recursive_wildcards += 1;
                PatternSegment::RecursiveWildcard(name.to_owned())
            } else {
                PatternSegment::Wildcard(wildcard.to_owned())
            }
        } else {
            PatternSegment::Literal(segment.to_owned())
        };
        match &parsed {
            PatternSegment::Wildcard(name) | PatternSegment::RecursiveWildcard(name)
                if name.is_empty() =>
            {
                return Err(ParseError {
                    message: "match wildcard name cannot be empty".to_owned(),
                    offset,
                });
            }
            _ => {}
        }
        pattern.push(parsed);
    }
    if recursive_wildcards > 1 {
        return Err(ParseError {
            message: "only one recursive wildcard is permitted in a match path".to_owned(),
            offset,
        });
    }
    Ok(pattern)
}

fn parse_expression_path(raw: &str, offset: usize) -> Result<Expr, ParseError> {
    let mut parts = Vec::new();
    let mut cursor = 0_usize;
    while let Some(relative) = raw[cursor..].find("$(") {
        let start = cursor + relative;
        if start > cursor {
            parts.push(PathPart::Literal(raw[cursor..start].to_owned()));
        }
        let expression_start = start + 2;
        let mut depth = 1_usize;
        let mut expression_end = None;
        for (relative, character) in raw[expression_start..].char_indices() {
            match character {
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        expression_end = Some(expression_start + relative);
                        break;
                    }
                }
                _ => {}
            }
        }
        let expression_end = expression_end.ok_or_else(|| ParseError {
            message: "unterminated path interpolation".to_owned(),
            offset,
        })?;
        let source = &raw[expression_start..expression_end];
        let tokens = lex(source).map_err(|error| ParseError {
            message: error.message,
            offset: offset + start + error.offset,
        })?;
        let mut parser = Parser::new(tokens);
        let expression = parser.expression(0)?;
        parser.expect(&TokenKind::Eof, "end of path interpolation")?;
        parts.push(PathPart::Interpolation(expression));
        cursor = expression_end + 1;
    }
    if cursor < raw.len() {
        parts.push(PathPart::Literal(raw[cursor..].to_owned()));
    }
    Ok(Expr::Path(parts))
}

fn parse_type_name(name: &str) -> Option<TypeName> {
    match name {
        "null" => Some(TypeName::Null),
        "bool" => Some(TypeName::Bool),
        "int" => Some(TypeName::Int),
        "float" => Some(TypeName::Float),
        "number" => Some(TypeName::Number),
        "string" => Some(TypeName::String),
        "list" => Some(TypeName::List),
        "map" => Some(TypeName::Map),
        "timestamp" => Some(TypeName::Timestamp),
        "duration" => Some(TypeName::Duration),
        "path" => Some(TypeName::Path),
        "bytes" => Some(TypeName::Bytes),
        "latlng" => Some(TypeName::LatLng),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_nested_matches_functions_and_precedence() {
        let source = r"
            rules_version = '2';
            service cloud.firestore {
              match /databases/{database}/documents {
                function signedIn() { return request.auth != null; }
                match /items/{item} {
                  allow read: if signedIn() && 2 + 3 * 4 == 14;
                }
              }
            }
        ";
        let program = parse(source).expect("rules should parse");
        assert_eq!(program.match_count(), 2);
        assert_eq!(program.allow_count(), 1);
        assert_eq!(program.function_count(), 1);
    }

    #[test]
    fn rejects_two_recursive_wildcards() {
        let source = "rules_version = '2'; service cloud.firestore { match /{a=**}/{b=**} { allow read: if true; } }";
        let error = parse(source).expect_err("two recursive wildcards must fail");
        assert!(error.message.contains("only one recursive wildcard"));
    }
}
