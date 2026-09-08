export interface GateCommandSpecification {
  readonly arguments: readonly string[];
  readonly displayCommand: string;
  readonly executable: string;
}

export interface FrozenGateToolchain {
  readonly java: string;
  readonly node: string;
  readonly npm: string;
  readonly rust: string;
}

export interface ObservedGateToolchain {
  readonly java: string;
  readonly node: string;
  readonly npm: string;
  readonly rust: string;
}

export function assertFrozenGateToolchain(
  expected: FrozenGateToolchain,
  observed: ObservedGateToolchain,
): void {
  const mismatches: string[] = [];
  const observedJavaMajor = javaMajor(observed.java);
  const expectedJavaMajor = requiredMajor(expected.java, "Java");
  if (observedJavaMajor !== expectedJavaMajor) {
    mismatches.push(
      `java expected major ${expectedJavaMajor}, observed ${firstLine(observed.java)}`,
    );
  }

  const observedNode = observed.node.replace(/^v/u, "");
  if (observedNode !== expected.node) {
    mismatches.push(`node expected ${expected.node}, observed ${observed.node}`);
  }
  if (observed.npm !== expected.npm) {
    mismatches.push(`npm expected ${expected.npm}, observed ${observed.npm}`);
  }

  const observedRust = /^rustc\s+(\S+)/u.exec(observed.rust)?.[1];
  if (observedRust !== expected.rust) {
    mismatches.push(`rust expected ${expected.rust}, observed ${observed.rust}`);
  }

  if (mismatches.length > 0) {
    throw new Error(`frozen toolchain mismatch: ${mismatches.join("; ")}`);
  }
}

function firstLine(value: string): string {
  return value.split(/\r?\n/u, 1)[0] ?? value;
}

function javaMajor(value: string): number | undefined {
  const match = /^(?:openjdk|java)(?: version)?\s+"?(\d+)/u.exec(
    firstLine(value),
  );
  return match === null ? undefined : Number(match[1]);
}

function requiredMajor(value: string, name: string): number {
  if (!/^\d+$/u.test(value)) {
    throw new Error(`invalid frozen ${name} major: ${value}`);
  }
  return Number(value);
}

export const existingConformanceCommandSpecifications = [
  {
    arguments: ["fmt", "--all", "--", "--check"],
    displayCommand: "cargo fmt --all -- --check",
    executable: "cargo",
  },
  {
    arguments: [
      "clippy",
      "--workspace",
      "--all-targets",
      "--all-features",
      "--",
      "-D",
      "warnings",
    ],
    displayCommand:
      "cargo clippy --workspace --all-targets --all-features -- -D warnings",
    executable: "cargo",
  },
  {
    arguments: ["test", "--workspace", "--all-targets", "--all-features"],
    displayCommand: "cargo test --workspace --all-targets --all-features",
    executable: "cargo",
  },
  {
    arguments: ["run", "check", "--prefix", "conformance"],
    displayCommand: "npm run check --prefix conformance",
    executable: "npm",
  },
  {
    arguments: ["test", "--prefix", "conformance"],
    displayCommand: "npm test --prefix conformance",
    executable: "npm",
  },
  {
    arguments: ["run", "test:fireside", "--prefix", "conformance"],
    displayCommand: "npm run test:fireside --prefix conformance",
    executable: "npm",
  },
  {
    arguments: ["run", "test:fireside:disk", "--prefix", "conformance"],
    displayCommand: "npm run test:fireside:disk --prefix conformance",
    executable: "npm",
  },
  {
    arguments: ["run", "test:fireside:strict", "--prefix", "conformance"],
    displayCommand: "npm run test:fireside:strict --prefix conformance",
    executable: "npm",
  },
  {
    arguments: ["run", "test:fireside:enterprise", "--prefix", "conformance"],
    displayCommand: "npm run test:fireside:enterprise --prefix conformance",
    executable: "npm",
  },
  {
    arguments: [
      "run",
      "test:fireside:enterprise:disk",
      "--prefix",
      "conformance",
    ],
    displayCommand:
      "npm run test:fireside:enterprise:disk --prefix conformance",
    executable: "npm",
  },
  {
    arguments: [
      "run",
      "test:fireside-disk-recovery",
      "--prefix",
      "conformance",
    ],
    displayCommand:
      "npm run test:fireside-disk-recovery --prefix conformance",
    executable: "npm",
  },
  {
    arguments: ["run", "test:fireside-import", "--prefix", "conformance"],
    displayCommand: "npm run test:fireside-import --prefix conformance",
    executable: "npm",
  },
  {
    arguments: ["run", "test:official", "--prefix", "conformance"],
    displayCommand: "npm run test:official --prefix conformance",
    executable: "npm",
  },
  {
    arguments: ["run", "test:official:enterprise", "--prefix", "conformance"],
    displayCommand: "npm run test:official:enterprise --prefix conformance",
    executable: "npm",
  },
  {
    arguments: [
      "run",
      "test:official-export-import",
      "--prefix",
      "conformance",
    ],
    displayCommand:
      "npm run test:official-export-import --prefix conformance",
    executable: "npm",
  },
  {
    arguments: [
      "run",
      "test:fireside-export-java-import",
      "--prefix",
      "conformance",
    ],
    displayCommand:
      "npm run test:fireside-export-java-import --prefix conformance",
    executable: "npm",
  },
] as const satisfies readonly GateCommandSpecification[];

export const existingConformanceCommands =
  existingConformanceCommandSpecifications.map(
    ({ displayCommand }) => displayCommand,
  );
