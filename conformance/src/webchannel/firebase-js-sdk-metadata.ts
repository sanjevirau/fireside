import { readFile, writeFile } from "node:fs/promises";

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
          await writeFile(path, pinnedContents, "utf8"),
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
        await writeFile(path, originalContents[index]!, "utf8"),
    ),
  );
}
