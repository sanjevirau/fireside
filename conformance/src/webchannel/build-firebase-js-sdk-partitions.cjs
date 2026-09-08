const { createHash } = require("node:crypto");
const { readFileSync, readdirSync } = require("node:fs");
const { createRequire } = require("node:module");
const { join, resolve } = require("node:path");

const [sdkArgument, fixtureArgument] = process.argv.slice(2);
if (!sdkArgument || !fixtureArgument) {
  throw new Error("usage: build-firebase-js-sdk-partitions.cjs <sdk> <fixture>");
}

const sdkDirectory = resolve(sdkArgument);
const fixture = JSON.parse(readFileSync(resolve(fixtureArgument), "utf8"));
const sourcePlan = fixture.localEmulatorProcessPartition;
const processPlan = sourcePlan.browserProcessPlan;
if (
  processPlan.strategy !== "top-level-suite-with-immediate-child-chunks" ||
  processPlan.unscopedSuitePolicy !== "once-per-client-build" ||
  !Number.isInteger(processPlan.maximumImmediateChildrenPerProcess) ||
  processPlan.maximumImmediateChildrenPerProcess <= 0
) {
  throw new Error("unsupported frozen firebase-js-sdk browser process plan");
}

const requireFromSdk = createRequire(join(sdkDirectory, "package.json"));
const typescript = requireFromSdk("typescript");
const apiDirectory = join(
  sdkDirectory,
  "packages",
  "firestore",
  "test",
  "integration",
  "api",
);
const allTypeScriptFiles = readdirSync(apiDirectory)
  .filter((name) => name.endsWith(".ts"))
  .sort();
for (const excluded of sourcePlan.excludedSourceFiles) {
  if (!allTypeScriptFiles.includes(excluded)) {
    throw new Error(`pinned excluded source file is missing: ${excluded}`);
  }
}
const includedSourceFiles = allTypeScriptFiles.filter(
  (name) => !sourcePlan.excludedSourceFiles.includes(name),
);
const declaredSourceFiles = sourcePlan.sourcePartitions
  .flatMap(({ sourceFiles }) => sourceFiles)
  .sort();
if (
  new Set(declaredSourceFiles).size !== declaredSourceFiles.length ||
  JSON.stringify(includedSourceFiles) !== JSON.stringify(declaredSourceFiles)
) {
  throw new Error(
    "firebase-js-sdk source files do not match the frozen source partitions",
  );
}

const chunkedSources = new Set(processPlan.chunkedSourcePartitions);
const isolatedSources = new Set(
  processPlan.isolatedImmediateSuiteSourcePartitions,
);
const declaredSourceNames = new Set(
  sourcePlan.sourcePartitions.map(({ name }) => name),
);
for (const sourceName of [...chunkedSources, ...isolatedSources]) {
  if (!declaredSourceNames.has(sourceName)) {
    throw new Error(`unknown process-plan source partition: ${sourceName}`);
  }
}
for (const sourceName of chunkedSources) {
  if (isolatedSources.has(sourceName)) {
    throw new Error(`source partition has two split strategies: ${sourceName}`);
  }
}

const sourceSuites = [];
for (const sourcePartition of sourcePlan.sourcePartitions) {
  let sourceTopIndex = 0;
  const observedTitles = [];
  for (const sourceFile of sourcePartition.sourceFiles) {
    const source = readFileSync(join(apiDirectory, sourceFile), "utf8");
    const sourceFileNode = typescript.createSourceFile(
      sourceFile,
      source,
      typescript.ScriptTarget.Latest,
      true,
      typescript.ScriptKind.TS,
    );
    for (const statement of sourceFileNode.statements) {
      if (
        !typescript.isExpressionStatement(statement) ||
        !typescript.isCallExpression(statement.expression)
      ) {
        continue;
      }
      const call = statement.expression;
      const callName = normalizedCallName(call, sourceFileNode);
      const title = literalText(call.arguments[0], typescript);
      if (!/^(?:apiDescribe|describe)(?:\.|$)/u.test(callName) || !title) {
        continue;
      }
      sourceTopIndex += 1;
      observedTitles.push(title);
      const children = immediateRegistrations(
        call.arguments[1],
        sourceFileNode,
        typescript,
      );
      sourceSuites.push({
        children,
        sourcePartition: sourcePartition.name,
        sourceTopIndex,
        title,
        unscoped: /^describe(?:\.|$)/u.test(callName),
      });
    }
  }
  if (
    observedTitles.length === 0 ||
    JSON.stringify(observedTitles.slice().sort()) !==
      JSON.stringify(sourcePartition.suiteTitles.slice().sort()) ||
    sourceSuites
      .filter(({ sourcePartition: name }) => name === sourcePartition.name)
      .some(({ unscoped }) => unscoped !== (sourcePartition.unscoped === true))
  ) {
    throw new Error(
      `firebase-js-sdk suites do not match frozen partition ${sourcePartition.name}`,
    );
  }
}

const logicalPartitions = [];
for (const sourceSuite of sourceSuites) {
  const chunkSize = isolatedSources.has(sourceSuite.sourcePartition)
    ? 1
    : chunkedSources.has(sourceSuite.sourcePartition)
      ? processPlan.maximumImmediateChildrenPerProcess
      : 0;
  if (chunkSize > 0 && sourceSuite.children.length > 0) {
    for (
      let childIndex = 0;
      childIndex < sourceSuite.children.length;
      childIndex += chunkSize
    ) {
      logicalPartitions.push({
        ...sourceSuite,
        chunkIndex: Math.floor(childIndex / chunkSize) + 1,
        selectedChildren: sourceSuite.children.slice(
          childIndex,
          childIndex + chunkSize,
        ),
      });
    }
  } else {
    logicalPartitions.push({
      ...sourceSuite,
      chunkIndex: 1,
      selectedChildren: [],
    });
  }
}

const plans = {};
for (const clientPersistence of ["memory", "persistence"]) {
  const partitions = [];
  const representatives = [];
  for (const logicalPartition of logicalPartitions) {
    const outerModes = logicalPartition.unscoped
      ? [null]
      : processPlan.outerPersistenceModes[clientPersistence];
    if (!Array.isArray(outerModes) || outerModes.length === 0) {
      throw new Error(
        `missing outer persistence modes for ${clientPersistence}`,
      );
    }
    for (const outerMode of outerModes) {
      const partitionName = `${logicalPartition.sourcePartition}:${logicalPartition.sourceTopIndex}:${logicalPartition.chunkIndex}${outerMode ? `@${outerMode}` : ""}`;
      const { coverageFilter, partitionRepresentatives } = buildFilter(
        logicalPartition,
        sourceSuites,
        outerMode,
      );
      partitions.push({ partitionName, coverageFilter });
      representatives.push(
        ...partitionRepresentatives.map((testName) => ({
          partitionName,
          testName,
        })),
      );
    }
  }
  for (const representative of representatives) {
    const matchingPartitions = partitions.filter(({ coverageFilter }) =>
      new RegExp(coverageFilter, "u").test(representative.testName),
    );
    if (
      matchingPartitions.length !== 1 ||
      matchingPartitions[0].partitionName !== representative.partitionName
    ) {
      throw new Error(
        `suite is not covered exactly once: ${representative.testName}`,
      );
    }
  }
  const partitionPlanSha256 = createHash("sha256")
    .update(JSON.stringify(partitions))
    .digest("hex");
  if (
    partitions.length !==
      processPlan.expectedProcessPartitions[clientPersistence] ||
    partitionPlanSha256 !== processPlan.expectedPlanSha256[clientPersistence]
  ) {
    throw new Error(
      `${clientPersistence} process plan ${partitions.length}/${partitionPlanSha256} does not match the frozen count and digest`,
    );
  }
  plans[clientPersistence] = { partitionPlanSha256, partitions };
}

process.stdout.write(`${JSON.stringify({ plans }, null, 2)}\n`);

function immediateRegistrations(callback, sourceFileNode, ts) {
  if (
    !callback ||
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
    !ts.isBlock(callback.body)
  ) {
    return [];
  }
  const registrations = [];
  for (const statement of callback.body.statements) {
    if (
      !ts.isExpressionStatement(statement) ||
      !ts.isCallExpression(statement.expression)
    ) {
      continue;
    }
    const call = statement.expression;
    const callName = normalizedCallName(call, sourceFileNode);
    const title = literalText(call.arguments[0], ts);
    if (
      !title ||
      !/(?:^|\W)(?:apiDescribe|describe|it)(?:\.|\W|$)/u.test(callName)
    ) {
      continue;
    }
    registrations.push({
      scoped: /^apiDescribe(?:\.|$)/u.test(callName),
      title,
    });
  }
  return registrations;
}

function normalizedCallName(call, sourceFileNode) {
  return call.expression.getText(sourceFileNode).replaceAll(/\s+/gu, " ");
}

function literalText(node, ts) {
  return node && ts.isStringLiteralLike(node) ? node.text : null;
}

function buildFilter(logicalPartition, allSourceSuites, outerMode) {
  const outerScope = outerMode
    ? `\\(Persistence=${outerMode}\\) `
    : "";
  if (logicalPartition.selectedChildren.length === 0) {
    const sameScopeTitles = allSourceSuites
      .filter(({ unscoped }) => unscoped === logicalPartition.unscoped)
      .map(({ title }) => title);
    const coverageFilter = `(?:^${outerScope}${escapeRegularExpression(logicalPartition.title)}${longerTitleRejection(logicalPartition.title, sameScopeTitles)}(?= |$))`;
    return {
      coverageFilter,
      partitionRepresentatives: [
        `${outerMode ? `(Persistence=${outerMode}) ` : ""}${logicalPartition.title} representative test`,
      ],
    };
  }

  const allChildTitles = logicalPartition.children.map(({ title }) => title);
  const childAlternatives = logicalPartition.selectedChildren.map(
    ({ scoped, title }) =>
      `${scoped ? "\\(Persistence=(?:memory_lru_gc|indexeddb)\\) " : ""}${escapeRegularExpression(title)}${longerTitleRejection(title, allChildTitles)}(?= |$)`,
  );
  const coverageFilter = `(?:^${outerScope}${escapeRegularExpression(logicalPartition.title)} (?:(?:${childAlternatives.join("|")})))`;
  const outerRepresentative = outerMode
    ? `(Persistence=${outerMode}) `
    : "";
  return {
    coverageFilter,
    partitionRepresentatives: logicalPartition.selectedChildren.map(
      ({ scoped, title }) =>
        `${outerRepresentative}${logicalPartition.title} ${scoped ? "(Persistence=memory_lru_gc) " : ""}${title} representative test`,
    ),
  };
}

function longerTitleRejection(title, candidateTitles) {
  const suffixes = candidateTitles
    .filter(
      (candidate) => candidate !== title && candidate.startsWith(`${title} `),
    )
    .map((candidate) => candidate.slice(title.length + 1));
  return suffixes.length === 0
    ? ""
    : `(?! (?:${suffixes.map(escapeRegularExpression).join("|")})(?: |$))`;
}

function escapeRegularExpression(value) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
