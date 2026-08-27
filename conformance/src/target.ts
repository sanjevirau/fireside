import { Firestore } from "@google-cloud/firestore";

export const TARGET_NAMES = ["cloud", "java", "fireside"] as const;

export type TargetName = (typeof TARGET_NAMES)[number];

export interface TargetConfiguration {
  readonly name: TargetName;
  readonly projectId: string;
  readonly host?: string;
}

export function resolveTarget(
  environment: NodeJS.ProcessEnv,
): TargetConfiguration {
  const name = parseTargetName(environment.CONFORMANCE_TARGET);

  if (name === "cloud") {
    return resolveCloudTarget(environment);
  }

  const host = environment.FIRESTORE_EMULATOR_HOST;
  if (host === undefined || host.length === 0) {
    throw new Error(`${name} target requires FIRESTORE_EMULATOR_HOST`);
  }

  return {
    name,
    projectId: environment.GCLOUD_PROJECT ?? `demo-fireside-${name}`,
    host,
  };
}

export function createFirestore(
  configuration: TargetConfiguration,
): Firestore {
  if (configuration.host === undefined) {
    return new Firestore({ projectId: configuration.projectId });
  }

  return new Firestore({
    projectId: configuration.projectId,
    host: configuration.host,
    ssl: false,
  });
}

function parseTargetName(value: string | undefined): TargetName {
  if (value === undefined) {
    throw new Error(
      `CONFORMANCE_TARGET is required (${TARGET_NAMES.join(", ")})`,
    );
  }

  if (TARGET_NAMES.some((name) => name === value)) {
    return value as TargetName;
  }

  throw new Error(`unsupported CONFORMANCE_TARGET: ${value}`);
}

function resolveCloudTarget(
  environment: NodeJS.ProcessEnv,
): TargetConfiguration {
  const projectId = environment.CONFORMANCE_CLOUD_PROJECT;
  const allowlistedProject = environment.CONFORMANCE_CLOUD_ALLOWLIST;

  if (projectId === undefined || projectId.length === 0) {
    throw new Error("cloud target requires CONFORMANCE_CLOUD_PROJECT");
  }

  if (allowlistedProject === undefined || projectId !== allowlistedProject) {
    throw new Error(
      "cloud project must exactly match CONFORMANCE_CLOUD_ALLOWLIST",
    );
  }

  if (projectId.startsWith("demo-")) {
    throw new Error("cloud target cannot use an emulator-only demo project ID");
  }

  if (environment.FIRESTORE_EMULATOR_HOST !== undefined) {
    throw new Error("cloud target refuses FIRESTORE_EMULATOR_HOST");
  }

  return { name: "cloud", projectId };
}
