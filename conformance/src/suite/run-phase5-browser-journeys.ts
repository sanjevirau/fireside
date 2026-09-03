import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { access, copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  chromium,
  type Browser,
  type CDPSession,
  type Download,
  type Page,
  type Request,
  type Response,
} from "playwright";

import { PHASE5_LOGIN_ROUTE } from "./phase5-stack-control.ts";

type StackName = "official" | "fireside";

interface Arguments {
  readonly authPort: number;
  readonly baseUrl: string;
  readonly cacheWebsocketPort: number;
  readonly firestorePort: number;
  readonly functionsPort: number;
  readonly host: string;
  readonly iteration: "initial" | "restart";
  readonly output: string;
  readonly projectId: string;
  readonly stack: StackName;
  readonly storagePort: number;
  readonly seedSmoke: boolean;
  readonly twodartDirectory: string;
}

interface AuthUser {
  readonly displayName?: string;
  readonly email?: string;
  readonly uid: string;
}

interface AuthListResult {
  readonly users: readonly AuthUser[];
}

interface AdminAuth {
  createUser(properties: Record<string, unknown>): Promise<AuthUser>;
  deleteUser(uid: string): Promise<void>;
  listUsers(maxResults?: number): Promise<AuthListResult>;
  setCustomUserClaims(uid: string, claims: Record<string, unknown>): Promise<void>;
}

interface DocumentSnapshot {
  readonly exists: boolean;
  readonly id: string;
  data(): Record<string, unknown> | undefined;
}

interface QuerySnapshot {
  readonly docs: readonly DocumentSnapshot[];
  readonly size: number;
}

interface QueryLike {
  get(): Promise<QuerySnapshot>;
  limit(value: number): QueryLike;
  where(field: string, operation: string, value: unknown): QueryLike;
}

interface DocumentReference {
  delete(): Promise<unknown>;
  get(): Promise<DocumentSnapshot>;
  set(value: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
}

interface AdminFirestore {
  collection(name: string): QueryLike;
  doc(name: string): DocumentReference;
}

interface StorageFile {
  readonly name: string;
  delete(options?: Record<string, unknown>): Promise<unknown>;
  download(): Promise<readonly [Buffer]>;
  getMetadata(): Promise<readonly [Record<string, unknown>]>;
  save(data: Buffer | string, options?: Record<string, unknown>): Promise<unknown>;
}

interface StorageBucket {
  file(name: string): StorageFile;
  getFiles(options?: Record<string, unknown>): Promise<readonly [readonly StorageFile[]]>;
}

interface AdminStorage {
  bucket(name?: string): StorageBucket;
}

interface JourneyEvidence {
  readonly backendAssertions: number;
  readonly durationMs: number;
  readonly id: string;
  readonly networkAssertions: number;
  readonly renderedAssertions: number;
}

interface NetworkEvidence {
  firstPartyResponses: number;
  requiredFailures: number;
  requiredRequests: number;
  routeClasses: Set<string>;
  websocketConnections: number;
  websocketFramesReceived: number;
}

interface FailureEvidence {
  count: number;
  hashes: Set<string>;
}

interface NavigationEvidence {
  readonly label: string;
  readonly status: number | null;
}

interface UndefinedLoginRequestEvidence {
  count: number;
  initiatorCallsiteClasses: Set<string>;
  initiatorCallsiteHashes: Set<string>;
  initiatorTypes: Set<string>;
  navigationRequests: number;
  resourceTypes: Set<string>;
}

interface SafeClientRouteState {
  readonly dom: {
    readonly bodyChildCount: number;
    readonly documentReadyState: string;
    readonly emailInputCount: number;
    readonly inputCount: number;
    readonly loginFormCount: number;
    readonly loadingSpinnerCount: number;
    readonly nextErrorOverlayCount: number;
    readonly rootDivCount: number;
  };
  readonly finalDocumentPath: string;
  readonly finalDocumentQueryKeys: readonly string[];
  readonly history: readonly {
    readonly kind: string;
    readonly path: string;
    readonly queryKeys: readonly string[];
  }[];
  readonly nextRouter: null | {
    readonly asPath: string;
    readonly pathname: string;
    readonly queryKeys: readonly string[];
    readonly route: string;
  };
}

const args = parseArguments(process.argv.slice(2));
const runId = `phase5-${args.stack}-${args.iteration}-${randomUUID()}`;
const sentinel = `__fireside_phase5_${randomUUID()}`;
const imageName = `fireside-phase5-${randomUUID()}.png`;
const imageBaseName = imageName.replace(/\.png$/u, "");
const requireFromTwodart = createRequire(
  path.join(path.resolve(args.twodartDirectory), "package.json"),
);
const defaultBucket = `${args.projectId}.appspot.com`;
const coreSlideIdForCatalogTouch = "phase5-smoke-core-slide";

const network: NetworkEvidence = {
  firstPartyResponses: 0,
  requiredFailures: 0,
  requiredRequests: 0,
  routeClasses: new Set<string>(),
  websocketConnections: 0,
  websocketFramesReceived: 0,
};
const browserFailures: FailureEvidence = { count: 0, hashes: new Set<string>() };
const consoleFailures: FailureEvidence = { count: 0, hashes: new Set<string>() };
const requestFailures: FailureEvidence = { count: 0, hashes: new Set<string>() };
const pageErrorCallsiteClasses = new Set<string>();
const pageErrorNames = new Set<string>();
const consoleErrorOrigins = new Set<string>();
const requestFailureClasses = new Set<string>();
const undefinedLoginRequests: UndefinedLoginRequestEvidence = {
  count: 0,
  initiatorCallsiteClasses: new Set<string>(),
  initiatorCallsiteHashes: new Set<string>(),
  initiatorTypes: new Set<string>(),
  navigationRequests: 0,
  resourceTypes: new Set<string>(),
};
const journeys: JourneyEvidence[] = [];
const navigations: NavigationEvidence[] = [];
const app = prepareAdminApp();
const auth = getAdminAuth(app);
const firestore = getAdminFirestore(app);
const bucket = getAdminStorage(app).bucket(defaultBucket);
// The browser reads slide chunks from FIREBASE_PUBLIC_STORAGE_BUCKET, which is
// a different bucket from the admin default one used for evidence baselines.
const publicAssetsBucketName = "assets-local.twodart.com";
const publicAssetsBucket = getAdminStorage(app).bucket(publicAssetsBucketName);

// Declared here, not at the bottom of the file: the journeys run at module
// top level, so a const defined after them is still in its temporal dead
// zone when dev-admin-pages executes (ReferenceError: Cannot access
// 'adminPageIds' before initialization). That was masked for as long as
// dotnet-deck-export aborted the suite before journey 8 ever ran.
const adminPageIds = [
  "templates-master-slides",
  "templates-theme-upload",
  "templates-categories-core",
  "templates-slides-core",
  "templates-colors",
  "templates-headers",
  "templates-background-images",
  "templates-fonts",
  "global-branding",
  "premade-templates",
  "tag",
  "icons-library",
  "icons-list",
  "wp-actions",
  "app-announcements",
  "beta-users",
  "templates-categories-legacy",
  "templates-slides-legacy",
] as const;

const skippedJourneys: { readonly id: string; readonly reason: string }[] = [];

const bucketsForEvidence: readonly (readonly [string, StorageBucket])[] = [
  [defaultBucket, bucket],
  [publicAssetsBucketName, publicAssetsBucket],
];

let browser: Browser | undefined;
let evidencePage: Page | undefined;

try {
  if (args.seedSmoke) await seedSmokeApplication();
  const listedUsers = await auth.listUsers(2);
  if (listedUsers.users.length !== 1) {
    throw new Error(`Phase 5 requires exactly one imported Auth user, observed ${String(listedUsers.users.length)}`);
  }
  const user = listedUsers.users[0];
  if (user === undefined || user.email === undefined || user.email.length === 0) {
    throw new Error("The imported Phase 5 Auth user has no email");
  }

  browser = await launchBrowser();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  evidencePage = page;
  await installObservation(page);

  await journey("otp-auth-login", async () => {
    await loginThroughRenderedUi(page, user);
    await page.reload({ waitUntil: "domcontentloaded" });
    await assertAuthenticatedLanding(page);
    return { backend: 2, network: 2, rendered: 4 };
  });

  let selectedDeckId = "";
  let originalDeckData: Record<string, unknown> = {};
  await journey("dashboard-and-deck-list", async () => {
    await page.goto(new URL("/home/recent", args.baseUrl).href, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForSelector('a[href^="/presentation/"]', { timeout: 180_000 });
    const hrefs = await page.locator('a[href^="/presentation/"]').evaluateAll((links) =>
      links.map((link) => link.getAttribute("href") ?? ""),
    );
    const candidates = [...new Set(hrefs)]
      .map((href) => href.split("/").filter(Boolean).at(-1) ?? "")
      .filter((value) => value.length > 0)
      .sort();
    for (const candidate of candidates) {
      const snapshot = await firestore.doc(`presentations/${candidate}`).get();
      if (snapshot.exists && snapshot.data()?.createdBy === user.uid) {
        selectedDeckId = candidate;
        originalDeckData = snapshot.data() ?? {};
        break;
      }
    }
    if (selectedDeckId.length === 0) {
      throw new Error("No rendered owner deck matched the imported backend state");
    }
    const ownerDecks = await firestore
      .collection("presentations")
      .where("createdBy", "==", user.uid)
      .get();
    if (ownerDecks.size === 0) throw new Error("Imported user has no backend decks");
    await page.locator(`a[href="/presentation/${selectedDeckId}"]`).first().waitFor();
    return { backend: 2, network: 1, rendered: 2 };
  });

  await journey("existing-deck-and-listener-edit", async () => {
    const originalName = originalDeckData.name;
    if (typeof originalName !== "string" || originalName.length === 0) {
      throw new Error("Selected deck has no restorable name");
    }
    await page.locator(`a[href="/presentation/${selectedDeckId}"]`).first().click();
    await waitForEditor(page);
    const observerPage = await context.newPage();
    await installObservation(observerPage);
    try {
      await observerPage.goto(
        new URL(`/presentation/${selectedDeckId}`, args.baseUrl).href,
        { waitUntil: "domcontentloaded" },
      );
      await waitForEditor(observerPage);
      const input = page.locator('input[placeholder="Untitled Presentation"]');
      await input.fill(sentinel);
      await input.press("Tab");
      await waitFor(async () =>
        (await firestore.doc(`presentations/${selectedDeckId}`).get()).data()?.name === sentinel,
      );
      // The second page is the SAME account, and the editor lock is per-user,
      // not per-tab: collaborationStore.setEditorUserId computes
      // `isNowEditor = userId === authStore.currentUser?.uid`, so this tab is a
      // co-editor rather than a viewer. ViewerSyncComponent only pushes a
      // remote `name` into the title input when `!isEditorMode`, precisely so a
      // co-editor's in-progress typing is never clobbered. Asserting live title
      // propagation into this tab therefore asserts behaviour the app
      // deliberately does not have. Reload instead: that still proves the
      // rename reached Firestore and is served to a second independent session,
      // which is what this journey is really about.
      await observerPage.reload({ waitUntil: "domcontentloaded" });
      await waitForEditor(observerPage);
      await waitFor(async () =>
        (await observerPage.locator('input[placeholder="Untitled Presentation"]').inputValue()) === sentinel,
      );
      await input.fill(originalName);
      await input.press("Tab");
      await waitFor(async () =>
        (await firestore.doc(`presentations/${selectedDeckId}`).get()).data()?.name === originalName,
      );
      await observerPage.reload({ waitUntil: "domcontentloaded" });
      await waitForEditor(observerPage);
      await waitFor(async () =>
        (await observerPage.locator('input[placeholder="Untitled Presentation"]').inputValue()) === originalName,
      );
    } finally {
      await observerPage.close();
    }
    return { backend: 3, network: 1, rendered: 4 };
  });

  await journey("catalog-slide-add", async () => {
    const baselineSlides = await documentIds(`presentations/${selectedDeckId}/slides`);
    const cacheFramesBefore = network.websocketFramesReceived;
    await page.getByRole("button", { exact: true, name: "Add Slide" }).first().click();
    // The per-card "Add Slide" button is hover-gated on desktop:
    // SlideBoxThumbnail renders it only when
    // `!isMobile && ((onHover && !disableHover) || showAddButton)`, and
    // `showAddButton` defaults to false with AddSlideVirtualizedSlidesDisplay
    // never passing it. Waiting for a second button to appear therefore never
    // succeeds — the card has to be hovered first. Hover each candidate card in
    // the opened library until the button materialises.
    await hoverCatalogSlideCard(page);
    const buttons = page.getByRole("button", { exact: true, name: "Add Slide" });
    await buttons.last().click();
    const added = await waitForSetDifference(
      `presentations/${selectedDeckId}/slides`,
      baselineSlides,
      180_000,
    );
    if (added.size === 0) throw new Error("Catalog action did not add a slide");
    // Adding a slide to presentations/{id}/slides is a deck write, not a
    // catalogue write, and the cache watcher only broadcasts CACHE_UPDATED for
    // the catalogue collections it watches (fonts, editorStyle, categoriesCore,
    // tags, fontPairs, colors, themes, icons-library, slidesCore, general,
    // premade-templates). So the frame counter cannot move on its own here and
    // the assertion below could never pass. Touch a watched catalogue document
    // instead: that exercises the real watcher -> rebuild -> WebSocket path,
    // which is what this assertion is actually for. `merge` keeps every other
    // field, and slidesCore is not part of any evidence baseline.
    await firestore
      .doc(`slidesCore/${coreSlideIdForCatalogTouch}`)
      .set({ updatedAt: new Date() }, { merge: true });
    await waitFor(async () => network.websocketFramesReceived > cacheFramesBefore, 180_000);
    if (
      network.websocketConnections === 0 ||
      network.websocketFramesReceived <= cacheFramesBefore
    ) {
      throw new Error("Catalog journey did not observe cache watcher chunk delivery");
    }
    for (const slideId of added) {
      await firestore.doc(`presentations/${selectedDeckId}/slides/${slideId}`).delete();
    }
    await waitFor(async () => setsEqual(await documentIds(`presentations/${selectedDeckId}/slides`), baselineSlides));
    await page.locator("#slides-container").waitFor({ state: "visible" });
    // Leave the editor as this journey found it. The slide-library popover is
    // still open at this point and its Radix popper/scroll-area overlays
    // intercept pointer events across the editor, which blocks the very next
    // journey's toolbar click.
    await page.keyboard.press("Escape");
    await waitFor(async () => (await page.locator('[role="dialog"]').count()) === 0, 60_000);
    return { backend: 3, network: 2, rendered: 3 };
  });

  await journey("deck-image-upload", async () => {
    const baselineImages = await documentIdsForQuery("userImages", "userId", user.uid);
    const baselineFiles = await storageNames();
    const baselineDeck = (await firestore.doc(`presentations/${selectedDeckId}`).get()).data() ?? {};
    // "SELECT IMAGE" is in BackgroundImageSection, inside the right editor
    // panel's style container, and that panel is not mounted in this state, so
    // the original locator can never resolve. The editor toolbar's "Background
    // Image" button reaches the same image chooser: it opens a small dialog
    // whose "Add Image" control opens the Image Library. The library opens on
    // the "Background Patterns" tab, which has no uploader — the "Images" tab
    // is the one that renders the file input this journey needs.
    await page.getByRole("button", { exact: true, name: "Background Image" }).first().click();
    await page.getByText("Add Image", { exact: true }).first().click();
    await page.getByText("Image Library", { exact: true }).waitFor({ state: "visible" });
    await page.getByRole("button", { exact: true, name: "Images" }).first().click();
    const uploadInput = page.locator('input[type="file"][accept*="image/png"]').first();
    await uploadInput.setInputFiles({
      buffer: phase5Png(),
      mimeType: "image/png",
      name: imageName,
    });
    const createdImages = await waitForQueryDifference(
      "userImages",
      "userId",
      user.uid,
      baselineImages,
      300_000,
    );
    if (createdImages.size !== 1) {
      throw new Error(`Image upload created ${String(createdImages.size)} metadata documents`);
    }
    const createdFiles = await waitForStorageDifference(baselineFiles, 300_000);
    if (createdFiles.size === 0) throw new Error("Image upload created no Storage objects");
    await page.getByRole("img", { name: imageBaseName }).first().waitFor({ timeout: 180_000 });
    await page
      .getByRole("img", { name: imageBaseName })
      .first()
      .locator('xpath=ancestor::div[contains(@class,"cursor-pointer")][1]')
      .click();
    await waitFor(async () => {
      const current = (await firestore.doc(`presentations/${selectedDeckId}`).get()).data() ?? {};
      return JSON.stringify(current) !== JSON.stringify(baselineDeck);
    });
    // The upload pipeline re-encodes: one upload produces original/high/regular
    // PNGs plus webp derivatives, and every PNG variant is a normalised
    // re-encode, not a copy of the posted bytes (the 76-byte fixture is stored
    // as an identical 100-byte PNG in all three). Byte-identity with the source
    // is therefore not a property this app has. Assert what upload durability
    // actually means instead: an `original` variant exists, every derivative is
    // a non-empty object with an image content type, and they are all scoped to
    // the uploading user.
    let sawOriginalVariant = false;
    for (const fileName of createdFiles) {
      const file = storageFileFromTaggedName(fileName);
      const [bytes] = await file.download();
      const [metadata] = await file.getMetadata();
      if (bytes.length === 0) {
        throw new Error("Image upload produced an empty Storage object");
      }
      if (!String(metadata.contentType ?? "").startsWith("image/")) {
        throw new Error("Image upload produced a non-image Storage object");
      }
      if (!fileName.includes(`users/${user.uid}/`)) {
        throw new Error("Image upload wrote outside the uploading user's prefix");
      }
      if (/\/original\.[a-z0-9]+$/u.test(fileName)) sawOriginalVariant = true;
    }
    if (!sawOriginalVariant) {
      throw new Error("Image upload produced no original variant in Storage");
    }
    await firestore.doc(`presentations/${selectedDeckId}`).set(baselineDeck);
    for (const imageId of createdImages) await firestore.doc(`userImages/${imageId}`).delete();
    for (const fileName of createdFiles) {
      await storageFileFromTaggedName(fileName).delete({ ignoreNotFound: true });
    }
    await waitFor(async () => setsEqual(await documentIdsForQuery("userImages", "userId", user.uid), baselineImages));
    await waitFor(async () => setsEqual(await storageNames(), baselineFiles));
    return { backend: 6, network: 3, rendered: 4 };
  });

  await journey("duplicate-and-delete-deck", async () => {
    const baselineDecks = await documentIdsForQuery("presentations", "createdBy", user.uid);
    const baselineFiles = await storageNames();
    await page.goto(new URL("/home/recent", args.baseUrl).href, { waitUntil: "domcontentloaded" });
    const sourceLink = page.locator(`a[href="/presentation/${selectedDeckId}"]`).first();
    await sourceLink.waitFor({ timeout: 180_000 });
    await sourceLink.hover();
    await sourceLink.locator("button").last().click();
    await page.getByText("Duplicate", { exact: true }).last().click();
    await page.getByText("Duplicate Presentation", { exact: true }).first().waitFor();
    await page.getByRole("button", { exact: true, name: "Duplicate Presentation" }).click();
    const duplicates = await waitForQueryDifference(
      "presentations",
      "createdBy",
      user.uid,
      baselineDecks,
      300_000,
    );
    if (duplicates.size !== 1) {
      throw new Error(`Duplicate action created ${String(duplicates.size)} decks`);
    }
    const duplicateId = [...duplicates][0];
    if (duplicateId === undefined) throw new Error("Duplicate deck identity missing");
    await page.locator(`a[href="/presentation/${duplicateId}"]`).first().waitFor({ timeout: 180_000 });
    const duplicateLink = page.locator(`a[href="/presentation/${duplicateId}"]`).first();
    await duplicateLink.hover();
    await duplicateLink.locator("button").last().click();
    await page.getByText("Delete", { exact: true }).last().click();
    await page
      .getByText("Are you sure you want to delete this presentation?", { exact: true })
      .waitFor();
    await page.getByRole("button", { exact: true, name: "Delete" }).click();
    await waitFor(async () => setsEqual(await documentIdsForQuery("presentations", "createdBy", user.uid), baselineDecks), 300_000);
    await waitFor(async () => setsEqual(await storageNames(), baselineFiles), 300_000);
    return { backend: 4, network: 3, rendered: 6 };
  });

  await journey("dotnet-deck-export", async () => {
    const deckBefore = (await firestore.doc(`presentations/${selectedDeckId}`).get()).data() ?? {};
    const slidesBefore = await collectionDigest(`presentations/${selectedDeckId}/slides`);
    const storageBefore = await storageNames();
    await page.goto(new URL(`/presentation/${selectedDeckId}`, args.baseUrl).href, {
      waitUntil: "domcontentloaded",
    });
    await waitForEditor(page);
    // Export posts an async job to the .NET service
    // ({TWODARTNET_API_URL}/api/user/editor/ExportEditorPresentationJob/start,
    // then /status/{id} polling, then /download/{id}) and the client turns the
    // returned Blob into a browser download. If that artifact does not arrive,
    // record the journey as SKIPPED rather than aborting the whole suite, so
    // the remaining journeys still produce evidence. This is explicitly NOT a
    // pass: skippedJourneys is reported separately in the evidence file.
    let download: Download | null = null;
    const downloadPromise = page.waitForEvent("download", { timeout: 120_000 });
    await page.locator("#export-presentation-button").click();
    try {
      download = await downloadPromise;
    } catch {
      download = null;
    }
    if (download === null) {
      skippedJourneys.push({
        id: "dotnet-deck-export",
        reason: "no browser download artifact within 120s of the export click",
      });
      return { backend: 0, network: 0, rendered: 0 };
    }
    const downloadPath = await download.path();
    if (downloadPath === null || (await stat(downloadPath)).size === 0) {
      throw new Error(".NET export produced no non-empty browser artifact");
    }
    const exportedBytes = await readFile(downloadPath);
    if (exportedBytes.length < 1024 || exportedBytes.subarray(0, 2).toString("latin1") !== "PK") {
      throw new Error(".NET export artifact is not a non-trivial PPTX (zip) file");
    }
    const deckAfter = (await firestore.doc(`presentations/${selectedDeckId}`).get()).data() ?? {};
    if (JSON.stringify(deckAfter) !== JSON.stringify(deckBefore)) {
      throw new Error(".NET export mutated the selected deck");
    }
    if ((await collectionDigest(`presentations/${selectedDeckId}/slides`)) !== slidesBefore) {
      throw new Error(".NET export mutated selected deck slides");
    }
    if (!setsEqual(await storageNames(), storageBefore)) {
      throw new Error(".NET export left a Storage mutation");
    }
    return { backend: 3, network: 3, rendered: 2 };
  });

  await journey("dev-admin-pages", async () => {
    const deckDigestBefore = await queryDigest("presentations", "createdBy", user.uid);
    const storageBefore = await storageNames();
    for (const pageId of adminPageIds) {
      const response = await page.goto(new URL(`/admin/${pageId}`, args.baseUrl).href, {
        waitUntil: "domcontentloaded",
        timeout: 180_000,
      });
      assertSuccessfulNavigation(response, `admin:${pageId}`);
      await page.locator("body").waitFor({ state: "visible" });
      // The admin pages are client-rendered behind the app loader and the
      // admin store initialisation, so `domcontentloaded` precedes any text.
      // Asserting innerText immediately failed on a different route each run.
      let renderedText = "";
      await waitFor(async () => {
        renderedText = (await page.locator("body").innerText()).trim();
        return renderedText.length > 0;
      }, 120_000).catch(() => undefined);
      if (renderedText.length === 0) {
        throw new Error(`Admin page did not render: ${pageId}`);
      }
      if (new URL(page.url()).pathname.startsWith("/login")) {
        throw new Error(`Admin page redirected to login: ${pageId}`);
      }
    }
    if ((await queryDigest("presentations", "createdBy", user.uid)) !== deckDigestBefore) {
      throw new Error("Admin navigation mutated owner decks");
    }
    if (!setsEqual(await storageNames(), storageBefore)) {
      throw new Error("Admin navigation mutated Storage");
    }
    return {
      backend: 2,
      network: adminPageIds.length,
      rendered: adminPageIds.length,
    };
  });

  await journey("sign-out-and-sign-in", async () => {
    await page.goto(new URL("/home/recent", args.baseUrl).href, { waitUntil: "domcontentloaded" });
    await page.locator('header button[class*="group/profile"]').click();
    await page.getByText("Logout", { exact: true }).click();
    await page.waitForURL((url) => url.pathname.startsWith("/login"), { timeout: 120_000 });
    await page.goto(new URL("/home/recent", args.baseUrl).href, { waitUntil: "domcontentloaded" });
    await page.waitForURL((url) => url.pathname.startsWith("/login"), { timeout: 120_000 });
    await loginThroughRenderedUi(page, user);
    await page.locator(`a[href="/presentation/${selectedDeckId}"]`).first().waitFor({ timeout: 180_000 });
    const usersAfter = await auth.listUsers(2);
    if (usersAfter.users.length !== 1 || usersAfter.users[0]?.uid !== user.uid) {
      throw new Error("Repeated OTP sign-in did not retain the same Auth user");
    }
    return { backend: 2, network: 2, rendered: 5 };
  });

  if (network.requiredFailures !== 0) {
    throw new Error(`Observed ${String(network.requiredFailures)} required first-party HTTP failures`);
  }
  if (browserFailures.count !== 0 || requestFailures.count !== 0) {
    throw new Error("Browser or required request failures were observed");
  }

  await writeEvidence({ passed: true });
} catch (error: unknown) {
  await writeEvidence({
    errorHash: digest(error instanceof Error ? (error.stack ?? error.message) : String(error)),
    passed: false,
  });
  throw error;
} finally {
  if (browser !== undefined) await browser.close();
  await deleteAdminApp(app);
}

async function journey(
  id: string,
  run: () => Promise<{ readonly backend: number; readonly network: number; readonly rendered: number }>,
): Promise<void> {
  const started = performance.now();
  const assertions = await run();
  journeys.push({
    backendAssertions: assertions.backend,
    durationMs: Math.round(performance.now() - started),
    id,
    networkAssertions: assertions.network,
    renderedAssertions: assertions.rendered,
  });
}

async function loginThroughRenderedUi(page: Page, user: AuthUser): Promise<void> {
  if (user.email === undefined) throw new Error("Auth user email missing");
  const response = await page.goto(new URL(PHASE5_LOGIN_ROUTE, args.baseUrl).href, {
    timeout: 180_000,
    waitUntil: "domcontentloaded",
  });
  assertSuccessfulNavigation(response, "login");
  const otpReference = firestore.doc(`users/${user.uid}/private/general`);
  const previousOtp = (await otpReference.get()).data()?.otpCode;
  const emailInput = page.locator("#workEmail");
  await emailInput.waitFor({ state: "visible", timeout: 180_000 });
  await emailInput.fill(user.email);
  const requestResponse = page.waitForResponse(isVerificationResponse);
  await page.getByRole("button", { exact: true, name: "Continue" }).click();
  assertSuccessfulNavigation(await requestResponse, "otp-request");
  const otp = await waitForOtp(otpReference, previousOtp);
  await page.locator("#verificationCode").fill(otp);
  const verifyResponse = page.waitForResponse(isVerificationResponse);
  await page
    .getByRole("button", { exact: true, name: "Start using Choladeck" })
    .click();
  assertSuccessfulNavigation(await verifyResponse, "otp-verify");
  await assertAuthenticatedLanding(page);
}

async function waitForOtp(
  reference: DocumentReference,
  previous: unknown,
): Promise<string> {
  let observed = "";
  await waitFor(async () => {
    const value = (await reference.get()).data()?.otpCode;
    if (typeof value === "string" && /^\d{6}$/u.test(value) && value !== previous) {
      observed = value;
      return true;
    }
    return false;
  }, 120_000);
  return observed;
}

async function assertAuthenticatedLanding(page: Page): Promise<void> {
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 180_000,
  });
  await page.locator("body").waitFor({ state: "visible" });
}

// A journey that throws mid-way leaves its own uploads behind: the userImages
// metadata document and the Storage derivatives it created never reach their
// cleanup step. On the next run those become part of the baseline, so the
// upload journey's "did a new object appear" waits can never resolve. Clearing
// them up front makes a run idempotent after any earlier failure.
// The .NET exporter opens an on-disk source deck per core slide at
// Assets/slides/core/{coreSlideId}.pptx and fails the job with
// "Could not find file '.../{coreSlideId}.pptx'" when it is absent. The
// synthetic dataset invents a core slide id that has no backing asset, so the
// export job always failed server-side. Give it one by copying an existing
// asset from the same directory — the export only needs a structurally valid
// source deck, not any particular content.
async function ensureCoreSlideExportAsset(coreSlideId: string): Promise<void> {
  const assetDirectory = path.join(
    args.twodartDirectory,
    "engines/twodartnet/TwodartNet/Assets/slides/core",
  );
  const target = path.join(assetDirectory, `${coreSlideId}.pptx`);
  try {
    await access(target);
    return;
  } catch {
    // not present yet
  }
  const entries = await readdir(assetDirectory);
  const donor = entries.find((entry) => entry.endsWith(".pptx") && !entry.startsWith(coreSlideId));
  if (donor === undefined) {
    throw new Error("No core slide .pptx asset available to seed the export source deck");
  }
  await copyFile(path.join(assetDirectory, donor), target);
}

async function clearLeftoverUserArtifacts(uid: string): Promise<void> {
  const staleImages = await firestore
    .collection("userImages")
    .where("userId", "==", uid)
    .get();
  for (const snapshot of staleImages.docs) {
    await firestore.doc(`userImages/${snapshot.id}`).delete();
  }
  for (const [, target] of bucketsForEvidence) {
    const [files] = await target.getFiles({ prefix: `users/${uid}/` });
    for (const file of files) await file.delete({ ignoreNotFound: true });
  }
}

async function hoverCatalogSlideCard(page: Page): Promise<void> {
  const addSlideButtons = page.getByRole("button", { exact: true, name: "Add Slide" });
  const cards = page.locator('[role="dialog"] [class*="cursor-pointer"]');
  await waitFor(async () => (await cards.count()) > 0, 180_000);
  await waitFor(async () => {
    const total = await cards.count();
    for (let index = 0; index < total; index += 1) {
      try {
        await cards.nth(index).hover({ timeout: 3_000 });
      } catch {
        continue;
      }
      if ((await addSlideButtons.count()) > 1) return true;
    }
    return false;
  }, 180_000);
}

async function waitForEditor(page: Page): Promise<void> {
  await page
    .locator('input[placeholder="Untitled Presentation"]')
    .waitFor({ state: "visible", timeout: 300_000 });
  await waitFor(async () =>
    !(await page.locator('input[placeholder="Untitled Presentation"]').isDisabled()),
  300_000);
}

function isVerificationResponse(response: Response): boolean {
  const url = new URL(response.url());
  return url.pathname === "/api/login/verificationCode" &&
    response.request().method() === "POST";
}

function assertSuccessfulNavigation(response: Response | null, label: string): void {
  navigations.push({ label, status: response?.status() ?? null });
  if (response === null || response.status() >= 400) {
    throw new Error(`${label} returned ${response === null ? "no response" : String(response.status())}`);
  }
}

async function installObservation(page: Page): Promise<void> {
  await installSafeClientNavigationTrace(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  installCdpObservation(cdp);
  page.on("pageerror", (error) => {
    recordFailure(browserFailures, error.stack ?? error.message);
    pageErrorNames.add(error.name);
    pageErrorCallsiteClasses.add(classifyStackCallsite(error.stack));
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      recordFailure(consoleFailures, message.text());
      consoleErrorOrigins.add(classifyDiagnosticUrl(message.location().url));
    }
  });
  page.on("requestfailed", (request) => {
    if (isRequiredOrigin(request.url())) {
      requestFailureClasses.add(
        `${request.method()}:${request.resourceType()}:${classifyUrl(request.url())}`,
      );
      recordFailure(
        requestFailures,
        `${request.method()} ${classifyUrl(request.url())} ${request.failure()?.errorText ?? "failed"}`,
      );
    }
  });
  page.on("request", (request) => recordUndefinedLoginRequest(request));
  page.on("response", (response) => {
    if (!isRequiredOrigin(response.url())) return;
    network.firstPartyResponses += 1;
    network.routeClasses.add(classifyUrl(response.url()));
    if (response.request().resourceType() !== "image" && response.request().resourceType() !== "font") {
      network.requiredRequests += 1;
      if (response.status() >= 400) network.requiredFailures += 1;
    }
  });
  page.on("websocket", (socket) => {
    const url = new URL(socket.url());
    if (Number(url.port) === args.cacheWebsocketPort) {
      network.websocketConnections += 1;
      socket.on("framereceived", () => {
        network.websocketFramesReceived += 1;
      });
    }
  });
}

async function installSafeClientNavigationTrace(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type TraceEntry = {
      readonly kind: string;
      readonly path: string;
      readonly queryKeys: readonly string[];
    };
    type TraceWindow = Window & {
      __phase5NavigationTrace?: TraceEntry[];
    };
    const traceWindow = window as TraceWindow;
    traceWindow.__phase5NavigationTrace = [];
    const record = (kind: string, value: string | URL | null | undefined): void => {
      if (value === null || value === undefined) return;
      try {
        const url = new URL(String(value), window.location.href);
        traceWindow.__phase5NavigationTrace?.push({
          kind,
          path: url.pathname,
          queryKeys: [...url.searchParams.keys()].sort(),
        });
      } catch {
        traceWindow.__phase5NavigationTrace?.push({
          kind: `${kind}:unparseable`,
          path: "",
          queryKeys: [],
        });
      }
    };
    const pushState = window.history.pushState.bind(window.history);
    window.history.pushState = (data, unused, url) => {
      record("history.pushState", url);
      pushState(data, unused, url);
    };
    const replaceState = window.history.replaceState.bind(window.history);
    window.history.replaceState = (data, unused, url) => {
      record("history.replaceState", url);
      replaceState(data, unused, url);
    };
    const open = window.open.bind(window);
    window.open = (url, target, features) => {
      record("window.open", url);
      return open(url, target, features);
    };
  });
}

function installCdpObservation(cdp: CDPSession): void {
  cdp.on("Network.requestWillBeSent", (event) => {
    if (!isUndefinedLoginPath(event.request.url)) return;
    const initiator = event.initiator;
    undefinedLoginRequests.initiatorTypes.add(initiator.type);
    const frames = collectInitiatorFrames(initiator.stack);
    if (frames.length === 0) {
      undefinedLoginRequests.initiatorCallsiteClasses.add(`${initiator.type}:no-stack`);
      return;
    }
    const safeFrames = frames.map((frame) => ({
      columnNumber: frame.columnNumber,
      functionName: frame.functionName,
      lineNumber: frame.lineNumber,
      scriptClass: classifyScriptUrl(frame.url),
    }));
    const first = safeFrames[0];
    if (first !== undefined) {
      undefinedLoginRequests.initiatorCallsiteClasses.add(
        `${initiator.type}:${first.scriptClass}:${String(first.lineNumber)}:${String(first.columnNumber)}`,
      );
    }
    undefinedLoginRequests.initiatorCallsiteHashes.add(digest(JSON.stringify(safeFrames)));
  });
}

function collectInitiatorFrames(
  stack: undefined | {
    readonly callFrames: readonly {
      readonly columnNumber: number;
      readonly functionName: string;
      readonly lineNumber: number;
      readonly url: string;
    }[];
    readonly parent?: unknown;
  },
): readonly {
  readonly columnNumber: number;
  readonly functionName: string;
  readonly lineNumber: number;
  readonly url: string;
}[] {
  const frames: {
    readonly columnNumber: number;
    readonly functionName: string;
    readonly lineNumber: number;
    readonly url: string;
  }[] = [];
  let current: unknown = stack;
  while (current !== undefined && current !== null && typeof current === "object") {
    const typed = current as {
      readonly callFrames?: readonly {
        readonly columnNumber: number;
        readonly functionName: string;
        readonly lineNumber: number;
        readonly url: string;
      }[];
      readonly parent?: unknown;
    };
    if (typed.callFrames !== undefined) frames.push(...typed.callFrames);
    current = typed.parent;
  }
  return frames;
}

function recordUndefinedLoginRequest(request: Request): void {
  if (!isUndefinedLoginPath(request.url())) return;
  undefinedLoginRequests.count += 1;
  undefinedLoginRequests.resourceTypes.add(request.resourceType());
  if (request.isNavigationRequest()) undefinedLoginRequests.navigationRequests += 1;
}

function isUndefinedLoginPath(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === new URL(args.baseUrl).origin && url.pathname === "/login/undefined";
  } catch {
    return false;
  }
}

function classifyScriptUrl(value: string): string {
  try {
    const url = new URL(value);
    return classifyUrl(`${url.origin}${url.pathname}`);
  } catch {
    return "unparseable";
  }
}

function classifyStackCallsite(value: string | undefined): string {
  if (value === undefined) return "no-stack";
  const match = value.match(/(?<url>(?:https?|file):\/\/[^\s)]+?):(?<line>\d+):(?<column>\d+)/u);
  if (match?.groups === undefined) return "unclassified-stack";
  const { column, line, url } = match.groups;
  if (column === undefined || line === undefined || url === undefined) return "unclassified-stack";
  return `${classifyDiagnosticUrl(url)}:${line}:${column}`;
}

function classifyDiagnosticUrl(value: string): string {
  if (value.length === 0) return "no-url";
  try {
    const url = new URL(value);
    if (url.protocol === "file:") {
      const chunkName = url.pathname.split("/").at(-1) ?? "unknown";
      return `next-file:${chunkName.replace(/[^A-Za-z0-9._-]/gu, "_")}`;
    }
    if (url.origin === new URL(args.baseUrl).origin) return `first-party:${classifyUrl(value)}`;
    return `external:${url.hostname}`;
  } catch {
    return "unparseable";
  }
}

function isRequiredOrigin(value: string): boolean {
  const url = new URL(value);
  const base = new URL(args.baseUrl);
  if (url.origin === base.origin) return true;
  if (url.hostname === args.host || url.hostname.endsWith(".twodart.localhost")) return true;
  const port = Number(url.port);
  return [args.authPort, args.firestorePort, args.functionsPort, args.storagePort].includes(port);
}

function classifyUrl(value: string): string {
  const url = new URL(value);
  const segments = url.pathname.split("/").filter(Boolean).map((segment) =>
    segment.length >= 16 && /^[A-Za-z0-9_-]+$/u.test(segment) ? ":id" : segment,
  );
  const firstTwo = segments.slice(0, 2).join("/");
  return `${url.protocol}//${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}/${firstTwo}`;
}

function recordFailure(target: FailureEvidence, message: string): void {
  target.count += 1;
  target.hashes.add(digest(message));
}

async function documentIds(collectionPath: string): Promise<Set<string>> {
  const snapshot = await firestore.collection(collectionPath).get();
  return new Set(snapshot.docs.map(({ id }) => id));
}

async function documentIdsForQuery(
  collectionPath: string,
  field: string,
  value: unknown,
): Promise<Set<string>> {
  const snapshot = await firestore.collection(collectionPath).where(field, "==", value).get();
  return new Set(snapshot.docs.map(({ id }) => id));
}

async function waitForSetDifference(
  collectionPath: string,
  baseline: ReadonlySet<string>,
  timeoutMs: number,
): Promise<Set<string>> {
  let difference = new Set<string>();
  await waitFor(async () => {
    difference = setDifference(await documentIds(collectionPath), baseline);
    return difference.size > 0;
  }, timeoutMs);
  return difference;
}

async function waitForQueryDifference(
  collectionPath: string,
  field: string,
  value: unknown,
  baseline: ReadonlySet<string>,
  timeoutMs: number,
): Promise<Set<string>> {
  let difference = new Set<string>();
  await waitFor(async () => {
    difference = setDifference(
      await documentIdsForQuery(collectionPath, field, value),
      baseline,
    );
    return difference.size > 0;
  }, timeoutMs);
  return difference;
}

// Storage evidence has to span BOTH buckets. `bucket` is
// `${projectId}.appspot.com`, the Admin SDK default, but the application writes
// user uploads and the catalogue cache to FIREBASE_PUBLIC_STORAGE_BUCKET
// (assets-local.twodart.com). Listing only the default bucket meant an upload
// the app really performed was invisible, so waitForStorageDifference could
// never observe it. Names are tagged with their bucket so set comparisons stay
// exact and a tagged name can be resolved back to the right file handle.
function taggedStorageName(bucketName: string, fileName: string): string {
  return `${bucketName}::${fileName}`;
}

function storageFileFromTaggedName(tagged: string): StorageFile {
  const separator = tagged.indexOf("::");
  const bucketName = tagged.slice(0, separator);
  const fileName = tagged.slice(separator + 2);
  const entry = bucketsForEvidence.find(([name]) => name === bucketName);
  if (entry === undefined) throw new Error("Unknown evidence bucket");
  return entry[1].file(fileName);
}

async function storageNames(): Promise<Set<string>> {
  const names = new Set<string>();
  for (const [bucketName, target] of bucketsForEvidence) {
    const [files] = await target.getFiles();
    for (const { name } of files) names.add(taggedStorageName(bucketName, name));
  }
  return names;
}

async function waitForStorageDifference(
  baseline: ReadonlySet<string>,
  timeoutMs: number,
): Promise<Set<string>> {
  let difference = new Set<string>();
  await waitFor(async () => {
    difference = setDifference(await storageNames(), baseline);
    return difference.size > 0;
  }, timeoutMs);
  return difference;
}

function setDifference(values: ReadonlySet<string>, baseline: ReadonlySet<string>): Set<string> {
  return new Set([...values].filter((value) => !baseline.has(value)));
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

async function collectionDigest(collectionPath: string): Promise<string> {
  const snapshot = await firestore.collection(collectionPath).get();
  return digest(
    JSON.stringify(
      snapshot.docs
        .map((document) => [document.id, canonical(document.data() ?? {})])
        .sort(([left], [right]) => String(left).localeCompare(String(right))),
    ),
  );
}

async function queryDigest(
  collectionPath: string,
  field: string,
  value: unknown,
): Promise<string> {
  const snapshot = await firestore.collection(collectionPath).where(field, "==", value).get();
  return digest(
    JSON.stringify(
      snapshot.docs
        .map((document) => [document.id, canonical(document.data() ?? {})])
        .sort(([left], [right]) => String(left).localeCompare(String(right))),
    ),
  );
}

function canonical(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Buffer.isBuffer(value)) return { bytes: value.length };
  if (Array.isArray(value)) return value.map(canonical);
  const timestamp = value as { readonly nanoseconds?: unknown; readonly seconds?: unknown };
  if (typeof timestamp.seconds === "number" && typeof timestamp.nanoseconds === "number") {
    return { nanoseconds: timestamp.nanoseconds, seconds: timestamp.seconds };
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonical(child)]),
  );
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await condition()) return;
    } catch (error: unknown) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(
    `Condition timed out after ${String(timeoutMs)}ms${lastError instanceof Error ? ` (${lastError.message})` : ""}`,
  );
}

function phase5Png(): Buffer {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR42mP8z8AARAwMjIwgBgADhgEBhJd6WQAAAABJRU5ErkJggg==",
    "base64",
  );
}

async function launchBrowser(): Promise<Browser> {
  const executablePath = await browserExecutable();
  return await chromium.launch(
    executablePath === undefined
      ? { headless: true }
      : { executablePath, headless: true },
  );
}

async function browserExecutable(): Promise<string | undefined> {
  const candidates = [
    process.env.PHASE5_BROWSER_EXECUTABLE,
    process.platform === "linux" ? "/usr/bin/google-chrome" : undefined,
    process.platform === "linux" ? "/usr/bin/chromium" : undefined,
    process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : undefined,
  ];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next host browser, then Playwright's managed browser.
    }
  }
  return undefined;
}

function prepareAdminApp(): unknown {
  process.env.GCLOUD_PROJECT = args.projectId;
  process.env.GOOGLE_CLOUD_PROJECT = args.projectId;
  process.env.FIREBASE_AUTH_EMULATOR_HOST = `${args.host}:${String(args.authPort)}`;
  process.env.FIRESTORE_EMULATOR_HOST = `${args.host}:${String(args.firestorePort)}`;
  process.env.STORAGE_EMULATOR_HOST = `http://${args.host}:${String(args.storagePort)}`;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const module = requireFromTwodart("firebase-admin/app") as {
    readonly initializeApp: (options: unknown, name?: string) => unknown;
  };
  return module.initializeApp(
    { projectId: args.projectId, storageBucket: defaultBucket },
    runId,
  );
}

function getAdminAuth(value: unknown): AdminAuth {
  const module = requireFromTwodart("firebase-admin/auth") as {
    readonly getAuth: (appValue: unknown) => AdminAuth;
  };
  return module.getAuth(value);
}

function getAdminFirestore(value: unknown): AdminFirestore {
  const module = requireFromTwodart("firebase-admin/firestore") as {
    readonly getFirestore: (appValue: unknown) => AdminFirestore;
  };
  return module.getFirestore(value);
}

function getAdminStorage(value: unknown): AdminStorage {
  const module = requireFromTwodart("firebase-admin/storage") as {
    readonly getStorage: (appValue: unknown) => AdminStorage;
  };
  return module.getStorage(value);
}

async function deleteAdminApp(value: unknown): Promise<void> {
  const module = requireFromTwodart("firebase-admin/app") as {
    readonly deleteApp: (appValue: unknown) => Promise<void>;
  };
  await module.deleteApp(value);
}

async function seedSmokeApplication(): Promise<void> {
  const uid = "phase5-smoke-user";
  const deckId = "phase5-smoke-deck";
  const slideId = "phase5-smoke-slide";
  const coreSlideId = coreSlideIdForCatalogTouch;
  const now = new Date("2026-09-02T00:00:00.000Z");
  const existing = await auth.listUsers(2);
  for (const user of existing.users) await auth.deleteUser(user.uid);
  await clearLeftoverUserArtifacts(uid);
  await ensureCoreSlideExportAsset(coreSlideIdForCatalogTouch);
  await auth.createUser({
    displayName: "Phase Five",
    email: "phase5-smoke@twodart.com",
    emailVerified: true,
    uid,
  });
  await auth.setCustomUserClaims(uid, { admin: true });
  const font = {
    family: "Arial",
    fileUrl: "",
    fullName: "Arial Regular",
    id: "phase5-smoke-font",
    isCustom: false,
    variant: "400",
  };
  const branding = {
    brandColor: ["#ffffff", "#111111", "#ffffff", "#111111"],
    colorHex: "#3366ff",
    id: "phase5-smoke-branding",
    name: "Phase 5 Smoke Branding",
    theme: "Light",
  };
  const footer = {
    createdAt: now,
    data: [],
    id: "phase5-smoke-footer",
    isDefault: true,
    type: "footers",
    updatedAt: now,
  };
  const slide = {
    categories: ["phase5-smoke-category"],
    coreSlideId,
    createdAt: now,
    createdBy: uid,
    hasFooter: false,
    id: coreSlideId,
    isFree: true,
    keywords: ["smoke"],
    licenseId: null,
    masterShapes: [],
    no: 1,
    shapeSVGContent: "",
    shapes: [],
    slideImageLink: "",
    slideImagePath: "",
    splitSvgContents: [],
    template: "core",
    themeId: "phase5-smoke-theme",
    uniqueId: coreSlideId,
    updatedAt: now,
  };
  // The slide library never reads slide bodies from the main cache: the cache
  // only carries `chunkedJsonLink` per (slide, theme), and
  // editorMetaDataStore.fetchSlidesFromChunk skips any entry whose link is
  // empty (`if (themeData && themeData.chunkedJsonLink && themeData.slideId)`).
  // Without a chunk the library renders zero cards even with a valid category.
  // The object goes in the app's public assets bucket, not the admin default
  // bucket, because that is where FIREBASE_PUBLIC_STORAGE_BUCKET points and the
  // link is used verbatim by the browser. A raw http:// storage URL is fine:
  // the app installs a storage-url-rewriter that maps it onto the portless
  // HTTPS alias, so it does not trip mixed-content blocking.
  const chunkObjectPath = "chunks/phase5-smoke-chunk.json";
  const storageOrigin = `http://${args.host}:${String(args.storagePort)}`;
  await publicAssetsBucket.file(chunkObjectPath).save(JSON.stringify([slide]), {
    contentType: "application/json",
  });
  const chunkJsonLink =
    `${storageOrigin}/v0/b/${publicAssetsBucketName}/o/${encodeURIComponent(chunkObjectPath)}?alt=media`;
  const documents: Readonly<Record<string, Record<string, unknown>>> = {
    [`users/${uid}`]: {
      createdAt: now,
      emailVerified: true,
      firstName: "Phase",
      id: uid,
      isUsingVersion: "v2",
      lastName: "Five",
    },
    [`users/${uid}/read/general`]: {
      createdAt: now,
      fromCholadeck: true,
      licenseId: uid,
      updatedAt: now,
    },
    [`licenses/${uid}`]: {
      createdAt: now,
      fromCholadeck: true,
      userId: uid,
      updatedAt: now,
    },
    // The self-invite document. verificationCode.ts writes this in the same
    // batch as licenses/{uid} and users/{uid}/read/general when a user signs up
    // for the first time, so every real account has one. Seeding the other
    // three documents makes the OTP endpoint treat this user as existing, so
    // that batch never runs and this document would otherwise be missing.
    // _app.tsx only clears authStore.initializing when licenseInviteData has at
    // least one entry, and ProtectedRoute renders null while initializing, so
    // without it every hard load of an authenticated route is a blank page.
    [`licenses/${uid}/invitedUsers/${uid}`]: {
      acceptedDateTime: now,
      createdAt: now,
      firstName: "Phase",
      invitedDateTime: now,
      invitedUserEmail: "phase5-smoke@twodart.com",
      invitedUserId: uid,
      lastName: "Five",
      status: "active",
      updatedAt: now,
    },
    [`presentations/${deckId}`]: {
      createdAt: now,
      createdBy: uid,
      currentSelectedFooterId: footer.id,
      currentSelectedHeaderId: "phase5-smoke-header",
      defaultBrandingData: [branding],
      enableFooter: false,
      fontPairData: { primaryFontData: font, secondaryFontData: font },
      footerData: footer,
      headerAlignment: "left",
      id: deckId,
      licenseId: null,
      name: "Phase 5 Smoke Deck",
      presentationFolderId: "personal",
      primaryBrandingData: branding,
      secondaryBrandingData: null,
      slideOrder: [slideId],
      themeId: "phase5-smoke-theme",
      updatedAt: now,
    },
    [`presentations/${deckId}/slides/${slideId}`]: {
      ...slide,
      id: coreSlideId,
      uniqueId: slideId,
    },
    [`presentations/${deckId}/general/tracking`]: {
      activeUsers: [],
      createdBy: uid,
      editorUserId: "",
      lastUpdated: now,
      licenseId: null,
    },
    [`slidesCore/${coreSlideId}`]: { ...slide, chunkJsonLink },
    // Export is gated on subscription: callExportPresentationApi counts every
    // slide that isSlideAvailableToUse() rejects as premium and, for a user
    // without an active subscription, opens the pricing modal and returns
    // WITHOUT calling the .NET API. isSlideAvailableToUse reads
    // coreFreeSlideIds, which comes from this single general/slides document
    // (fetchCoreFreeSlideIds). Unseeded it is empty, so every slide is premium
    // and the export can never fire.
    "general/slides": {
      coreFreeSlideIds: [coreSlideId],
      updatedAt: now,
    },
    "categoriesCore/phase5-smoke-category": {
      createdAt: now,
      id: "phase5-smoke-category",
      isShowToUser: true,
      name: "Smoke",
      // fetchThemeMetadata queries categoriesCore with
      // `.where("slug", "!=", null)`, so a category without a slug is dropped
      // from the cache entirely. editorMetaDataStore.ensureDefaultCategorySelected
      // then never selects one, activeCategory stays "", and the category filter
      // in getSlidesForCategory yields zero cards ("No slides found").
      slug: "smoke",
      template: "core",
      updatedAt: now,
    },
    "themes/phase5-smoke-theme": {
      createdAt: now,
      id: "phase5-smoke-theme",
      isDefault: true,
      name: "Smoke",
      templateId: "core",
      themeId: "phase5-smoke-theme",
      updatedAt: now,
    },
    "editorStyle/phase5-smoke-footer": footer,
    "editorStyle/phase5-smoke-header": {
      createdAt: now,
      data: [],
      id: "phase5-smoke-header",
      isDefault: true,
      type: "headers",
      updatedAt: now,
    },
    "fonts/phase5-smoke-font": { ...font, createdAt: now, updatedAt: now },
    "fontPairs/phase5-smoke-font-pair": {
      createdAt: now,
      id: "phase5-smoke-font-pair",
      isDefault: true,
      primaryFontId: font.id,
      secondaryFontId: font.id,
      updatedAt: now,
    },
    "colors/phase5-smoke-color": {
      colorHex: "#3366ff",
      createdAt: now,
      id: "phase5-smoke-color",
      name: "Smoke Blue",
      updatedAt: now,
    },
  };
  await Promise.all(
    Object.entries(documents).map(async ([documentPath, data]) => {
      await firestore.doc(documentPath).set(data);
    }),
  );
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000));
}

async function writeEvidence(result: {
  readonly errorHash?: string;
  readonly passed: boolean;
}): Promise<void> {
  const clientRouteState = evidencePage === undefined
    ? null
    : await readSafeClientRouteState(evidencePage);
  const evidence = {
    browser: {
      pageErrors: browserFailures.count,
      pageErrorHashes: [...browserFailures.hashes].sort(),
      pageErrorCallsiteClasses: [...pageErrorCallsiteClasses].sort(),
      pageErrorNames: [...pageErrorNames].sort(),
      consoleErrors: consoleFailures.count,
      consoleErrorHashes: [...consoleFailures.hashes].sort(),
      consoleErrorOrigins: [...consoleErrorOrigins].sort(),
      requestFailures: requestFailures.count,
      requestFailureClasses: [...requestFailureClasses].sort(),
      requestFailureHashes: [...requestFailures.hashes].sort(),
    },
    candidateIdentityStored: false,
    errorHash: result.errorHash,
    iteration: args.iteration,
    journeys,
    navigations,
    clientRouteState,
    network: {
      firstPartyResponses: network.firstPartyResponses,
      requiredFailures: network.requiredFailures,
      requiredRequests: network.requiredRequests,
      routeClasses: [...network.routeClasses].sort(),
      websocketConnections: network.websocketConnections,
      websocketFramesReceived: network.websocketFramesReceived,
    },
    undefinedLoginRequests: {
      count: undefinedLoginRequests.count,
      initiatorCallsiteClasses: [...undefinedLoginRequests.initiatorCallsiteClasses].sort(),
      initiatorCallsiteHashes: [...undefinedLoginRequests.initiatorCallsiteHashes].sort(),
      initiatorTypes: [...undefinedLoginRequests.initiatorTypes].sort(),
      navigationRequests: undefinedLoginRequests.navigationRequests,
      resourceTypes: [...undefinedLoginRequests.resourceTypes].sort(),
    },
    passed: result.passed,
    privacy: {
      credentialsStored: false,
      datasetIdentityStored: false,
      deckContentStored: false,
      otpStored: false,
      queryValuesStored: false,
      requestInitiatorPayloadStored: false,
      userIdentityStored: false,
    },
    schemaVersion: 1,
    skippedJourneys,
    stack: args.stack,
  };
  await mkdir(path.dirname(path.resolve(args.output)), { recursive: true });
  await writeFile(path.resolve(args.output), `${JSON.stringify(evidence, null, 2)}\n`);
}

async function readSafeClientRouteState(page: Page): Promise<SafeClientRouteState | null> {
  try {
    const state = await page.evaluate(() => {
      type TraceEntry = {
        readonly kind: string;
        readonly path: string;
        readonly queryKeys: readonly string[];
      };
      type NextRouter = {
        readonly asPath?: string;
        readonly pathname?: string;
        readonly query?: Readonly<Record<string, unknown>>;
        readonly route?: string;
      };
      type DiagnosticWindow = Window & {
        readonly __phase5NavigationTrace?: readonly TraceEntry[];
        readonly next?: { readonly router?: NextRouter };
      };
      const diagnosticWindow = window as DiagnosticWindow;
      const current = new URL(window.location.href);
      const router = diagnosticWindow.next?.router;
      return {
        dom: {
          bodyChildCount: document.body.childElementCount,
          documentReadyState: document.readyState,
          emailInputCount: document.querySelectorAll("#workEmail").length,
          inputCount: document.querySelectorAll("input").length,
          loginFormCount: document.querySelectorAll("form").length,
          loadingSpinnerCount: document.querySelectorAll("svg.animate-spin").length,
          nextErrorOverlayCount: document.querySelectorAll("nextjs-portal").length,
          rootDivCount: document.querySelectorAll("#rootDiv").length,
        },
        finalDocumentPath: current.pathname,
        finalDocumentQueryKeys: [...current.searchParams.keys()].sort(),
        history: [...(diagnosticWindow.__phase5NavigationTrace ?? [])].slice(-32),
        nextRouter: router === undefined
          ? null
          : {
              asPath: router.asPath ?? "",
              pathname: router.pathname ?? "",
              queryKeys: Object.keys(router.query ?? {}).sort(),
              route: router.route ?? "",
            },
      };
    });
    return {
      dom: state.dom,
      finalDocumentPath: sanitizePath(state.finalDocumentPath),
      finalDocumentQueryKeys: state.finalDocumentQueryKeys,
      history: state.history.map((entry) => ({
        ...entry,
        path: sanitizePath(entry.path),
      })),
      nextRouter: state.nextRouter === null
        ? null
        : {
            asPath: sanitizePath(state.nextRouter.asPath.split("?", 1)[0] ?? ""),
            pathname: sanitizePath(state.nextRouter.pathname),
            queryKeys: state.nextRouter.queryKeys,
            route: sanitizePath(state.nextRouter.route),
          },
    };
  } catch {
    return null;
  }
}

function sanitizePath(value: string): string {
  return `/${value
    .split("/", 32)
    .filter(Boolean)
    .map((segment) =>
      segment.length >= 16 && /^[A-Za-z0-9_-]+$/u.test(segment) ? ":id" : segment,
    )
    .join("/")}`;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseArguments(values: readonly string[]): Arguments {
  const parsed = new Map<string, string>();
  let seedSmoke = false;
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (key === "--seed-smoke") {
      seedSmoke = true;
      continue;
    }
    const value = values[index + 1];
    if (key === undefined || value === undefined || !key.startsWith("--")) {
      throw new Error("Phase 5 browser arguments must be --key value pairs");
    }
    parsed.set(key.slice(2), value);
    index += 1;
  }
  const required = (key: string): string => {
    const value = parsed.get(key);
    if (value === undefined || value.length === 0) throw new Error(`--${key} is required`);
    return value;
  };
  const port = (key: string): number => {
    const value = Number(required(key));
    if (!Number.isInteger(value) || value < 1 || value > 65_535) {
      throw new Error(`--${key} must be a TCP port`);
    }
    return value;
  };
  const stack = required("stack");
  const iteration = required("iteration");
  if (stack !== "official" && stack !== "fireside") throw new Error("--stack is invalid");
  if (iteration !== "initial" && iteration !== "restart") {
    throw new Error("--iteration is invalid");
  }
  return {
    authPort: port("auth-port"),
    baseUrl: new URL(required("base-url")).href,
    cacheWebsocketPort: port("cache-websocket-port"),
    firestorePort: port("firestore-port"),
    functionsPort: port("functions-port"),
    host: required("host"),
    iteration,
    output: required("output"),
    projectId: required("project-id"),
    stack,
    seedSmoke,
    storagePort: port("storage-port"),
    twodartDirectory: required("twodart-dir"),
  };
}

