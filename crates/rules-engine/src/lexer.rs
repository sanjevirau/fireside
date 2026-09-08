#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Token {
    pub(crate) kind: TokenKind,
    pub(crate) offset: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum TokenKind {
    Identifier(String),
    String(String),
    Integer(i64),
    Float(f64),
    Path(String),
    Assign,
    Equal,
    NotEqual,
    Less,
    LessEqual,
    Greater,
    GreaterEqual,
    And,
    Or,
    Plus,
    Minus,
    Star,
    Slash,
    Percent,
    Bang,
    Dot,
    Comma,
    Colon,
    Semicolon,
    LeftParen,
    RightParen,
    LeftBrace,
    RightBrace,
    LeftBracket,
    RightBracket,
    Eof,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct LexError {
    pub(crate) message: String,
    pub(crate) offset: usize,
}

pub(crate) fn lex(source: &str) -> Result<Vec<Token>, LexError> {
    Lexer::new(source).lex()
}

struct Lexer<'a> {
    source: &'a str,
    offset: usize,
    tokens: Vec<Token>,
}

impl<'a> Lexer<'a> {
    const fn new(source: &'a str) -> Self {
        Self {
            source,
            offset: 0,
            tokens: Vec::new(),
        }
    }

    fn lex(mut self) -> Result<Vec<Token>, LexError> {
        while self.offset < self.source.len() {
            self.skip_trivia()?;
            if self.offset == self.source.len() {
                break;
            }
            let start = self.offset;
            let character = self
                .current()
                .expect("offset before source end has a character");
            let kind = match character {
                '\'' | '"' => self.string(character)?,
                '0'..='9' => self.number()?,
                character if is_identifier_start(character) => self.identifier(),
                '/' if self.path_can_start() => self.path()?,
                '=' if self.consume_pair("==") => TokenKind::Equal,
                '!' if self.consume_pair("!=") => TokenKind::NotEqual,
                '<' if self.consume_pair("<=") => TokenKind::LessEqual,
                '>' if self.consume_pair(">=") => TokenKind::GreaterEqual,
                '&' if self.consume_pair("&&") => TokenKind::And,
                '|' if self.consume_pair("||") => TokenKind::Or,
                '=' => self.single(TokenKind::Assign),
                '<' => self.single(TokenKind::Less),
                '>' => self.single(TokenKind::Greater),
                '+' => self.single(TokenKind::Plus),
                '-' => self.single(TokenKind::Minus),
                '*' => self.single(TokenKind::Star),
                '/' => self.single(TokenKind::Slash),
                '%' => self.single(TokenKind::Percent),
                '!' => self.single(TokenKind::Bang),
                '.' => self.single(TokenKind::Dot),
                ',' => self.single(TokenKind::Comma),
                ':' => self.single(TokenKind::Colon),
                ';' => self.single(TokenKind::Semicolon),
                '(' => self.single(TokenKind::LeftParen),
                ')' => self.single(TokenKind::RightParen),
                '{' => self.single(TokenKind::LeftBrace),
                '}' => self.single(TokenKind::RightBrace),
                '[' => self.single(TokenKind::LeftBracket),
                ']' => self.single(TokenKind::RightBracket),
                _ => {
                    return Err(LexError {
                        message: format!("unexpected character {character:?}"),
                        offset: start,
                    });
                }
            };
            self.tokens.push(Token {
                kind,
                offset: start,
            });
        }
        self.tokens.push(Token {
            kind: TokenKind::Eof,
            offset: self.source.len(),
        });
        Ok(self.tokens)
    }

    fn skip_trivia(&mut self) -> Result<(), LexError> {
        loop {
            while self.current().is_some_and(char::is_whitespace) {
                self.advance();
            }
            if self.remaining().starts_with("//") {
                while self.current().is_some_and(|character| character != '\n') {
                    self.advance();
                }
                continue;
            }
            if self.remaining().starts_with("/*") {
                let start = self.offset;
                self.offset += 2;
                if let Some(end) = self.remaining().find("*/") {
                    self.offset += end + 2;
                    continue;
                }
                return Err(LexError {
                    message: "unterminated block comment".to_owned(),
                    offset: start,
                });
            }
            return Ok(());
        }
    }

    fn string(&mut self, quote: char) -> Result<TokenKind, LexError> {
        let start = self.offset;
        self.advance();
        let mut value = String::new();
        while let Some(character) = self.current() {
            self.advance();
            if character == quote {
                return Ok(TokenKind::String(value));
            }
            if character != '\\' {
                value.push(character);
                continue;
            }
            let escaped = self.current().ok_or_else(|| LexError {
                message: "unterminated string escape".to_owned(),
                offset: self.offset,
            })?;
            self.advance();
            value.push(match escaped {
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                '\\' => '\\',
                '\'' => '\'',
                '"' => '"',
                other => other,
            });
        }
        Err(LexError {
            message: "unterminated string literal".to_owned(),
            offset: start,
        })
    }

    fn number(&mut self) -> Result<TokenKind, LexError> {
        let start = self.offset;
        while self
            .current()
            .is_some_and(|character| character.is_ascii_digit())
        {
            self.advance();
        }
        let mut float = false;
        if self.current() == Some('.')
            && self
                .peek_after_current()
                .is_some_and(|character| character.is_ascii_digit())
        {
            float = true;
            self.advance();
            while self
                .current()
                .is_some_and(|character| character.is_ascii_digit())
            {
                self.advance();
            }
        }
        if matches!(self.current(), Some('e' | 'E')) {
            float = true;
            self.advance();
            if matches!(self.current(), Some('+' | '-')) {
                self.advance();
            }
            let exponent_start = self.offset;
            while self
                .current()
                .is_some_and(|character| character.is_ascii_digit())
            {
                self.advance();
            }
            if exponent_start == self.offset {
                return Err(LexError {
                    message: "numeric exponent has no digits".to_owned(),
                    offset: exponent_start,
                });
            }
        }
        let source = &self.source[start..self.offset];
        if float {
            source
                .parse::<f64>()
                .map(TokenKind::Float)
                .map_err(|_| LexError {
                    message: "invalid floating-point literal".to_owned(),
                    offset: start,
                })
        } else {
            source
                .parse::<i64>()
                .map(TokenKind::Integer)
                .map_err(|_| LexError {
                    message: "integer literal is out of range".to_owned(),
                    offset: start,
                })
        }
    }

    fn identifier(&mut self) -> TokenKind {
        let start = self.offset;
        self.advance();
        while self.current().is_some_and(is_identifier_continue) {
            self.advance();
        }
        TokenKind::Identifier(self.source[start..self.offset].to_owned())
    }

    fn path_can_start(&self) -> bool {
        let next = self.source[self.offset + 1..].chars().next();
        if !next.is_some_and(|character| character == '{' || is_path_character(character)) {
            return false;
        }
        let Some(previous) = self.tokens.last() else {
            return true;
        };
        if matches!(&previous.kind, TokenKind::Identifier(value) if value == "match" || value == "return")
        {
            return true;
        }
        !token_can_end_expression(&previous.kind)
    }

    fn path(&mut self) -> Result<TokenKind, LexError> {
        let start = self.offset;
        let mut interpolation_depth = 0_usize;
        let mut braces = 0_usize;
        while let Some(character) = self.current() {
            if interpolation_depth == 0 && braces == 0 {
                if character.is_whitespace()
                    || matches!(character, ';' | ',' | ')' | ']' | ':' | '&' | '|')
                {
                    break;
                }
                if matches!(character, '=' | '!' | '<' | '>') && self.offset > start {
                    break;
                }
            }
            if self.remaining().starts_with("$(") {
                interpolation_depth += 1;
                self.offset += 2;
                continue;
            }
            match character {
                '(' if interpolation_depth > 0 => interpolation_depth += 1,
                ')' if interpolation_depth > 0 => interpolation_depth -= 1,
                '{' if interpolation_depth == 0 => braces += 1,
                '}' if interpolation_depth == 0 && braces > 0 => braces -= 1,
                _ => {}
            }
            self.advance();
        }
        if interpolation_depth != 0 || braces != 0 {
            return Err(LexError {
                message: "unterminated path interpolation or wildcard".to_owned(),
                offset: start,
            });
        }
        Ok(TokenKind::Path(self.source[start..self.offset].to_owned()))
    }

    fn single(&mut self, token: TokenKind) -> TokenKind {
        self.advance();
        token
    }

    fn consume_pair(&mut self, pair: &str) -> bool {
        if self.remaining().starts_with(pair) {
            self.offset += pair.len();
            true
        } else {
            false
        }
    }

    fn current(&self) -> Option<char> {
        self.remaining().chars().next()
    }

    fn peek_after_current(&self) -> Option<char> {
        let mut characters = self.remaining().chars();
        characters.next()?;
        characters.next()
    }

    fn remaining(&self) -> &'a str {
        &self.source[self.offset..]
    }

    fn advance(&mut self) {
        if let Some(character) = self.current() {
            self.offset += character.len_utf8();
        }
    }
}

fn is_identifier_start(character: char) -> bool {
    character == '_' || character.is_ascii_alphabetic()
}

fn is_identifier_continue(character: char) -> bool {
    character == '_' || character.is_ascii_alphanumeric()
}

fn is_path_character(character: char) -> bool {
    character == '_' || character == '(' || character.is_ascii_alphanumeric()
}

fn token_can_end_expression(token: &TokenKind) -> bool {
    matches!(
        token,
        TokenKind::Identifier(_)
            | TokenKind::String(_)
            | TokenKind::Integer(_)
            | TokenKind::Float(_)
            | TokenKind::Path(_)
            | TokenKind::RightParen
            | TokenKind::RightBracket
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distinguishes_paths_from_division() {
        let tokens =
            lex("return /databases/$(database)/documents/a; 9/3 == 3;").expect("source should lex");
        assert!(matches!(tokens[1].kind, TokenKind::Path(_)));
        assert!(
            tokens
                .iter()
                .any(|token| matches!(token.kind, TokenKind::Slash))
        );
    }

    #[test]
    fn skips_both_comment_forms() {
        let tokens = lex("// line\ntrue /* block */ && false").expect("source should lex");
        assert_eq!(
            tokens
                .iter()
                .filter(|token| matches!(token.kind, TokenKind::Identifier(_)))
                .count(),
            2
        );
    }
}
