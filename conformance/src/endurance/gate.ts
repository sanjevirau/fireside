export class GateFailure extends Error {
  constructor(stage: string, evidence: Record<string, unknown>) {
    super(`Phase 1 gate failed at ${stage}: ${JSON.stringify(evidence)}`);
    this.name = "GateFailure";
  }
}

export function requireGate(
  passed: boolean,
  stage: string,
  evidence: Record<string, unknown>,
): void {
  if (!passed) {
    throw new GateFailure(stage, evidence);
  }
}
