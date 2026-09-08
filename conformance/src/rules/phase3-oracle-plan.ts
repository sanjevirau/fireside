export const PHASE3_RULES_ORACLE_SEED = "fireside-phase-3-rules-v1";
export const PHASE3_RULES_PROJECT_ID = "fireside-conformance";
export const PHASE3_RULES_CASES_PER_BATCH = 32;
export const PHASE3_RULES_BATCHES = 32;
export const PHASE3_RULES_CASE_COUNT =
  PHASE3_RULES_CASES_PER_BATCH * PHASE3_RULES_BATCHES;

export type ExpressionCategory =
  | "literals-and-coercion"
  | "boolean-short-circuit-and-errors"
  | "numeric-arithmetic-and-comparison"
  | "string-list-map-and-map-diff"
  | "request-auth-method-time-query-resource-and-existing-resource";

export interface RulesOracleCase {
  readonly id: string;
  readonly category: ExpressionCategory;
  readonly expression: string;
  readonly request: {
    readonly auth: {
      readonly uid: string;
      readonly token: {
        readonly role: string;
        readonly score: number;
        readonly cohort: string;
      };
    };
    readonly method: "get";
    readonly path: string;
    readonly time: string;
  };
  readonly expectation: "ALLOW";
  readonly pathEncoding: "PLAIN";
  readonly expressionReportLevel: "FULL";
}

export interface RulesOracleBatch {
  readonly id: string;
  readonly source: string;
  readonly cases: readonly RulesOracleCase[];
}

interface ExpressionTemplate {
  readonly category: ExpressionCategory;
  expression(batchIndex: number): string;
}

const templates: readonly ExpressionTemplate[] = [
  literal("true"),
  literal("false"),
  literal("null == null"),
  literal("null != 0"),
  numeric((index) => `${index + 2} + 3 == ${index + 5}`),
  numeric((index) => `${index + 11} - 4 == ${index + 7}`),
  numeric((index) => `${(index % 7) + 2} * 3 == ${((index % 7) + 2) * 3}`),
  numeric((index) => `${index + 9} / 3 == ${(index + 9) / 3}`),
  numeric((index) => `${index + 10} % 7 == ${(index + 10) % 7}`),
  numeric((index) => `${index} < ${index + 1}`),
  numeric((index) => `-${index + 1} < 0`),
  booleanExpression("true && true"),
  booleanExpression("false || true"),
  booleanExpression("!false"),
  booleanExpression("false && request.auth.token.missing == 1"),
  booleanExpression("true || request.auth.token.missing == 1"),
  collection("'alpha' == 'alpha'"),
  collection("'alpha'.size() == 5"),
  collection("'alphabet'.matches('^alpha.*')"),
  collection("'MiXeD'.lower() == 'mixed'"),
  collection("'MiXeD'.upper() == 'MIXED'"),
  collection("['a', 'b', 'c'].size() == 3"),
  collection("'b' in ['a', 'b', 'c']"),
  collection("['a', 'b', 'c'].hasAll(['a', 'c'])"),
  collection("['a', 'b', 'c'].hasAny(['x', 'b'])"),
  collection("['a', 'b'].hasOnly(['b', 'a'])"),
  collection("{'a': 1, 'b': 2}.a == 1"),
  collection("{'a': 1, 'b': 2}.keys().hasAll(['a', 'b'])"),
  requestExpression("request.auth != null"),
  requestExpression((index) => `request.auth.uid == 'user-${index % 8}'`),
  requestExpression((index) =>
    `request.auth.token.score == ${(index % 11) + 1}`,
  ),
  requestExpression("request.method == 'get'"),
] as const;

function literal(expression: string): ExpressionTemplate {
  return {
    category: "literals-and-coercion",
    expression: () => expression,
  };
}

function booleanExpression(expression: string): ExpressionTemplate {
  return {
    category: "boolean-short-circuit-and-errors",
    expression: () => expression,
  };
}

function numeric(expression: (batchIndex: number) => string): ExpressionTemplate {
  return {
    category: "numeric-arithmetic-and-comparison",
    expression,
  };
}

function collection(expression: string): ExpressionTemplate {
  return {
    category: "string-list-map-and-map-diff",
    expression: () => expression,
  };
}

function requestExpression(
  expression: string | ((batchIndex: number) => string),
): ExpressionTemplate {
  return {
    category:
      "request-auth-method-time-query-resource-and-existing-resource",
    expression:
      typeof expression === "string" ? () => expression : expression,
  };
}

function caseId(batchIndex: number, templateIndex: number): string {
  const ordinal = batchIndex * PHASE3_RULES_CASES_PER_BATCH + templateIndex;
  return `case-${ordinal.toString().padStart(4, "0")}`;
}

function buildSource(cases: readonly RulesOracleCase[]): string {
  const matches = cases
    .map(
      (testCase) => `    match /phase3/${testCase.id} {
      allow get: if ${testCase.expression};
    }`,
    )
    .join("\n");
  return `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
${matches}
  }
}
`;
}

export function buildPhase3ExpressionOracleBatches(): readonly RulesOracleBatch[] {
  if (templates.length !== PHASE3_RULES_CASES_PER_BATCH) {
    throw new Error(
      `expected ${PHASE3_RULES_CASES_PER_BATCH} templates, found ${templates.length}`,
    );
  }
  return Array.from({ length: PHASE3_RULES_BATCHES }, (_, batchIndex) => {
    const cases = templates.map((template, templateIndex): RulesOracleCase => {
      const id = caseId(batchIndex, templateIndex);
      return {
        id,
        category: template.category,
        expression: template.expression(batchIndex),
        request: {
          auth: {
            uid: `user-${batchIndex % 8}`,
            token: {
              role: batchIndex % 3 === 0 ? "editor" : "reader",
              score: (batchIndex % 11) + 1,
              cohort: `cohort-${batchIndex % 4}`,
            },
          },
          method: "get",
          path: `/databases/(default)/documents/phase3/${id}`,
          time: `2026-01-${String((batchIndex % 28) + 1).padStart(2, "0")}T00:00:00Z`,
        },
        expectation: "ALLOW",
        pathEncoding: "PLAIN",
        expressionReportLevel: "FULL",
      };
    });
    return {
      id: `expression-batch-${batchIndex.toString().padStart(2, "0")}`,
      source: buildSource(cases),
      cases,
    };
  });
}
