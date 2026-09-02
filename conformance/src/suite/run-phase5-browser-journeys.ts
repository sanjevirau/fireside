import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { access, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { chromium, type Browser, type Page, type Response } from "playwright";

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
  listUsers(maxResults?: number): Promise<AuthListResult>;
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

const args = parseArguments(process.argv.slice(2));
const runId = `phase5-${args.stack}-${args.iteration}-${randomUUID()}`;
const sentinel = `__fireside_phase5_${randomUUID()}`;
const imageName = `fireside-phase5-${randomUUID()}.png`;
const imageBaseName = imageName.replace(/\.png$/u, "");
const requireFromTwodart = createRequire(
  path.join(path.resolve(args.twodartDirectory), "package.json"),
);
const defaultBucket = `${args.projectId}.appspot.com`;
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
const journeys: JourneyEvidence[] = [];
const navigations: NavigationEvidence[] = [];
const app = prepareAdminApp();
const auth = getAdminAuth(app);
const firestore = getAdminFirestore(app);
const bucket = getAdminStorage(app).bucket(defaultBucket);
let browser: Browser | undefined;

try {
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
  installObservation(page);

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
    installObservation(observerPage);
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
      await observerPage
        .locator('input[placeholder="Untitled Presentation"]')
        .waitFor({ state: "visible" });
      await waitFor(async () =>
        (await observerPage.locator('input[placeholder="Untitled Presentation"]').inputValue()) === sentinel,
      );
      await input.fill(originalName);
      await input.press("Tab");
      await waitFor(async () =>
        (await firestore.doc(`presentations/${selectedDeckId}`).get()).data()?.name === originalName,
      );
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
    await waitFor(async () =>
      (await page.getByRole("button", { exact: true, name: "Add Slide" }).count()) > 1,
    );
    const buttons = page.getByRole("button", { exact: true, name: "Add Slide" });
    await buttons.last().click();
    const added = await waitForSetDifference(
      `presentations/${selectedDeckId}/slides`,
      baselineSlides,
      180_000,
    );
    if (added.size === 0) throw new Error("Catalog action did not add a slide");
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
    return { backend: 3, network: 2, rendered: 3 };
  });

  await journey("deck-image-upload", async () => {
    const baselineImages = await documentIdsForQuery("userImages", "userId", user.uid);
    const baselineFiles = await storageNames();
    const baselineDeck = (await firestore.doc(`presentations/${selectedDeckId}`).get()).data() ?? {};
    const selectImage = page.getByText("SELECT IMAGE", { exact: true }).first();
    await selectImage.scrollIntoViewIfNeeded();
    await selectImage.click();
    await page.getByText("Image Library", { exact: true }).waitFor({ state: "visible" });
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
    let exactByteMatch = false;
    for (const fileName of createdFiles) {
      const file = bucket.file(fileName);
      const [bytes] = await file.download();
      await file.getMetadata();
      if (bytes.equals(phase5Png())) exactByteMatch = true;
    }
    if (!exactByteMatch) throw new Error("No uploaded Storage object matched the synthetic PNG bytes");
    await firestore.doc(`presentations/${selectedDeckId}`).set(baselineDeck);
    for (const imageId of createdImages) await firestore.doc(`userImages/${imageId}`).delete();
    for (const fileName of createdFiles) await bucket.file(fileName).delete({ ignoreNotFound: true });
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
    const downloadPromise = page.waitForEvent("download", { timeout: 600_000 });
    await page.locator("#export-presentation-button").click();
    const download = await downloadPromise;
    const downloadPath = await download.path();
    if (downloadPath === null || (await stat(downloadPath)).size === 0) {
      throw new Error(".NET export produced no non-empty browser artifact");
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
      if ((await page.locator("body").innerText()).trim().length === 0) {
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

function installObservation(page: Page): void {
  page.on("pageerror", (error) => recordFailure(browserFailures, error.stack ?? error.message));
  page.on("console", (message) => {
    if (message.type() === "error") recordFailure(consoleFailures, message.text());
  });
  page.on("requestfailed", (request) => {
    if (isRequiredOrigin(request.url())) {
      recordFailure(
        requestFailures,
        `${request.method()} ${classifyUrl(request.url())} ${request.failure()?.errorText ?? "failed"}`,
      );
    }
  });
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

async function storageNames(): Promise<Set<string>> {
  const [files] = await bucket.getFiles();
  return new Set(files.map(({ name }) => name));
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

async function writeEvidence(result: {
  readonly errorHash?: string;
  readonly passed: boolean;
}): Promise<void> {
  const evidence = {
    browser: {
      pageErrors: browserFailures.count,
      pageErrorHashes: [...browserFailures.hashes].sort(),
      consoleErrors: consoleFailures.count,
      consoleErrorHashes: [...consoleFailures.hashes].sort(),
      requestFailures: requestFailures.count,
      requestFailureHashes: [...requestFailures.hashes].sort(),
    },
    candidateIdentityStored: false,
    errorHash: result.errorHash,
    iteration: args.iteration,
    journeys,
    navigations,
    network: {
      firstPartyResponses: network.firstPartyResponses,
      requiredFailures: network.requiredFailures,
      requiredRequests: network.requiredRequests,
      routeClasses: [...network.routeClasses].sort(),
      websocketConnections: network.websocketConnections,
      websocketFramesReceived: network.websocketFramesReceived,
    },
    passed: result.passed,
    privacy: {
      credentialsStored: false,
      datasetIdentityStored: false,
      deckContentStored: false,
      otpStored: false,
      userIdentityStored: false,
    },
    schemaVersion: 1,
    stack: args.stack,
  };
  await mkdir(path.dirname(path.resolve(args.output)), { recursive: true });
  await writeFile(path.resolve(args.output), `${JSON.stringify(evidence, null, 2)}\n`);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseArguments(values: readonly string[]): Arguments {
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (key === undefined || value === undefined || !key.startsWith("--")) {
      throw new Error("Phase 5 browser arguments must be --key value pairs");
    }
    parsed.set(key.slice(2), value);
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
    storagePort: port("storage-port"),
    twodartDirectory: required("twodart-dir"),
  };
}

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
