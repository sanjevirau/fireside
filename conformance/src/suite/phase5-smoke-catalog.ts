interface CatalogDocument {
  create(data: Record<string, unknown>): Promise<unknown>;
  delete(): Promise<unknown>;
  get(): Promise<{
    readonly exists: boolean;
    data(): Record<string, unknown> | undefined;
  }>;
}

export interface SmokeCatalogClient {
  collection(name: string): {
    limit(count: number): { get(): Promise<{ readonly empty: boolean }> };
  };
  doc(name: string): CatalogDocument;
}

// The cheap fixture has no premade templates. Supply the unchanged catalogue
// read workload with one owned row, outside the measured window. Never repair
// a missing catalogue in a full-data run or overwrite an existing document.
export async function preparePhase5SmokeCatalog(
  client: SmokeCatalogClient,
  smoke: boolean,
  marker: string,
): Promise<(() => Promise<void>) | null> {
  if (!smoke) return null;
  if (!/^[a-zA-Z0-9-]+$/u.test(marker)) throw new Error("Invalid smoke catalogue marker");
  if (!(await client.collection("premade-templates").limit(1).get()).empty) return null;
  const document = client.doc(`premade-templates/phase5-smoke-soak-${marker}`);
  await document.create({
    name: "Phase 5 synthetic soak catalogue entry",
    phase5SmokeSoakMarker: marker,
    tags: [],
  });
  return async () => {
    const snapshot = await document.get();
    if (snapshot.data()?.phase5SmokeSoakMarker !== marker) {
      throw new Error("Smoke catalogue cleanup refused a missing or non-owned document");
    }
    await document.delete();
    if ((await document.get()).exists) throw new Error("Smoke catalogue cleanup left its seed");
  };
}
