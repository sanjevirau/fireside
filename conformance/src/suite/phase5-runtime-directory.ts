import { createHash } from "node:crypto";
import { mkdir, statfs } from "node:fs/promises";
import path from "node:path";

export const PHASE5_MAX_UNIX_SOCKET_PATH_BYTES = 107;
export const PHASE5_FUNCTIONS_SOCKET_SUFFIX =
  `/fire_emu_${"0".repeat(16)}.sock`;

export interface Phase5RuntimeFilesystemEvidence {
  readonly availableBytes: number;
  readonly maximumUnixSocketPathBytes: number;
  readonly minimumAvailableBytes: number;
  readonly passed: true;
  readonly root: string;
  readonly socketSuffixBytes: number;
  readonly totalBytes: number;
}

export function phase5RuntimeDirectory(
  runtimeRoot: string,
  outputDirectory: string,
  label: string,
): string {
  if (!path.isAbsolute(runtimeRoot)) {
    throw new Error("Phase 5 runtime root must be absolute");
  }
  if (!/^[a-z0-9-]+$/u.test(label)) {
    throw new Error(`Invalid Phase 5 runtime label: ${label}`);
  }
  const attempt = createHash("sha256")
    .update(path.resolve(outputDirectory))
    .digest("hex")
    .slice(0, 16);
  const directory = path.join(path.resolve(runtimeRoot), `p5-${attempt}`, label);
  const socketPathBytes = Buffer.byteLength(
    `${directory}${PHASE5_FUNCTIONS_SOCKET_SUFFIX}`,
  );
  if (socketPathBytes > PHASE5_MAX_UNIX_SOCKET_PATH_BYTES) {
    throw new Error(
      `Phase 5 runtime leaves insufficient Functions socket headroom: ${String(socketPathBytes)} bytes`,
    );
  }
  return directory;
}

export async function preparePhase5RuntimeRoot(
  runtimeRoot: string,
  minimumAvailableBytes: number,
): Promise<Phase5RuntimeFilesystemEvidence> {
  if (!path.isAbsolute(runtimeRoot)) {
    throw new Error("Phase 5 runtime root must be absolute");
  }
  const root = path.resolve(runtimeRoot);
  await mkdir(root, { recursive: true });
  const filesystem = await statfs(root);
  const availableBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
  const totalBytes = Number(filesystem.blocks) * Number(filesystem.bsize);
  if (availableBytes < minimumAvailableBytes) {
    throw new Error(
      `Phase 5 runtime filesystem has ${String(availableBytes)} available bytes; ` +
        `${String(minimumAvailableBytes)} required`,
    );
  }
  return {
    availableBytes,
    maximumUnixSocketPathBytes: PHASE5_MAX_UNIX_SOCKET_PATH_BYTES,
    minimumAvailableBytes,
    passed: true,
    root,
    socketSuffixBytes: Buffer.byteLength(PHASE5_FUNCTIONS_SOCKET_SUFFIX),
    totalBytes,
  };
}
