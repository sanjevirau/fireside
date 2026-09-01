import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

interface GeneratedMetadataFile {
  readonly path: string;
  readonly pinnedContents: string;
}

export async function pinGeneratedMetadata(
  files: readonly GeneratedMetadataFile[],
): Promise<() => Promise<void>> {
  const originalContents = await Promise.all(
    files.map(async ({ path }) => await readFile(path, "utf8")),
  );

  try {
    await Promise.all(
      files.map(
        async ({ path, pinnedContents }) =>
          await writeFileAtomically(path, pinnedContents),
      ),
    );
  } catch (error) {
    await restore(files, originalContents);
    throw error;
  }

  let restored = false;
  return async () => {
    if (restored) {
      return;
    }
    restored = true;
    await restore(files, originalContents);
  };
}

async function restore(
  files: readonly GeneratedMetadataFile[],
  originalContents: readonly string[],
): Promise<void> {
  await Promise.all(
    files.map(
      async ({ path }, index) =>
        await writeFileAtomically(path, originalContents[index]!),
    ),
  );
}

async function writeFileAtomically(
  path: string,
  contents: string,
): Promise<void> {
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${String(process.pid)}.${randomUUID()}.tmp`,
  );

  try {
    await writeFile(temporaryPath, contents, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
