//! Bounded, opt-in observations of the evaluator's actual allow decisions.

/// Maximum retained allow outcomes per operation. Further outcomes are counted,
/// not retained; tracing never changes the expression or document-access budget.
pub const MAXIMUM_TRACE_OUTCOMES: usize = 1_000;

/// Location of an allow declaration in the immutable source used to evaluate it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AllowLocation {
    /// One-based source line, as used by the Requests UI.
    pub line: usize,
    /// Zero-based UTF-8 byte offset of `allow`. This is an internal source offset,
    /// not a claim about the coverage protocol's expression offsets.
    pub byte_offset: usize,
}

/// Result of one executed allow condition, before combining the final verdict.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AllowDecision {
    /// Condition evaluated to true.
    Allow,
    /// Condition evaluated to false.
    Deny,
    /// Evaluation failed or returned a non-boolean value.
    Error,
}

/// One observed allow condition. No documents, credentials or error strings are
/// copied into this record; the request's original verdict retains its error.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AllowOutcome {
    /// Declaration executed by the evaluator.
    pub location: AllowLocation,
    /// Actual condition result, including an error masked by a later allow.
    pub decision: AllowDecision,
}

/// Bounded per-operation trace. Repeated locations are intentional, for example
/// when a query proves multiple alternative branches. Unvisited rules are absent.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct EvaluationTrace {
    outcomes: Vec<AllowOutcome>,
    omitted_outcomes: usize,
}

impl EvaluationTrace {
    /// Executed conditions in evaluation order, up to the retention cap.
    #[must_use]
    pub fn outcomes(&self) -> &[AllowOutcome] {
        &self.outcomes
    }

    /// Number of executed conditions omitted after the retention cap.
    #[must_use]
    pub const fn omitted_outcomes(&self) -> usize {
        self.omitted_outcomes
    }

    pub(crate) fn record(&mut self, location: AllowLocation, decision: AllowDecision) {
        if self.outcomes.len() == MAXIMUM_TRACE_OUTCOMES {
            self.omitted_outcomes = self.omitted_outcomes.saturating_add(1);
        } else {
            // Grow on demand, but never reserve past the declared maximum.
            if self.outcomes.len() == self.outcomes.capacity() {
                let next = (self.outcomes.len().max(4) * 2).min(MAXIMUM_TRACE_OUTCOMES);
                self.outcomes.reserve_exact(next - self.outcomes.len());
            }
            self.outcomes.push(AllowOutcome { location, decision });
        }
    }
}
