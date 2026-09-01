export interface GateCommandSpecification {
  readonly arguments: readonly string[];
  readonly displayCommand: string;
  readonly executable: string;
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
