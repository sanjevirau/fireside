export const serializationProject = "demo-fireside-map-serialization";
export const serializationRepeats = 8;
export const serializationCases = [
  { id: "flat", fields: { zulu: "last", alpha: "first", middle: true, number: 42, nullable: null } },
  { id: "nested", fields: {
    zulu: { third: 3, first: 1, second: 2 },
    array: [{ z: "z", a: "a", m: "m" }, { nested: { right: false, left: true } }],
    emptyMap: {}, emptyArray: [], alpha: "unchanged",
  } },
  { id: "unicode", fields: {
    "漢字": "資料", "😀": "emoji", "é": "accent", "10": "ten", "2": "two",
    mixed: { "🧪": "实验", latin: "Café", "日本語": "値" },
  } },
  { id: "deck-shaped", fields: {
    themeId: "theme", slideOrder: ["slide-one"], name: "Synthetic deck",
    footerData: { type: "plain", data: [] }, primaryBrandingData: { logo: null, brandColor: ["112233", "445566"] },
    secondaryBrandingData: {}, defaultBrandingData: {}, enableFooter: false,
    currentSelectedHeaderId: "header", currentSelectedFooterId: "footer", headerAlignment: "left",
    fontPairData: { body: "Inter", heading: "Inter" }, recentCustomColors: [], _usedCustomImages: [],
    presentationFolderId: null, contentRev: 1, updatedAt: 2, createdAt: 1,
  } },
] as const;

export const serializationOperations = [
  "sdk-get", "grpc-get", "grpc-list", "grpc-query", "rest-get", "browser-long-poll", "browser-streaming",
] as const;

export interface SerializationObservation {
  readonly id: string;
  readonly operation: typeof serializationOperations[number];
  readonly reads: readonly string[];
}

// JSON object order is not a semantic value comparison. Keep the exact JSON
// separately to detect response-order instability without calling it data loss.
export function canonicalJson(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, field]) => [key, sort(field)]));
    }
    return input;
  };
  return JSON.stringify(sort(value));
}
