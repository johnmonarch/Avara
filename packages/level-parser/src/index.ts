import { promises as fs } from "node:fs";
import path from "node:path";

import type { LevelScene, LevelSummary, SceneLocalBounds, SceneNode, SceneSound } from "@avara/shared-types";

const CURATED_PACK_PRIORITY = [
  "avaraline-strict-mode",
  "wut",
  "single-player",
  "aa-normal",
  "the-lexicon"
];

type ScriptContext = Record<string, number | string | boolean>;

interface LevelCatalogEntry {
  summary: LevelSummary;
  packDir: string;
}

interface RawLevelEntry {
  Alf: string;
  Name: string;
  Message?: string;
}

interface ParsedTag {
  name: string;
  attributes: Record<string, string>;
}

interface ParsedBspAsset {
  bounds?: {
    min?: [number, number, number];
    max?: [number, number, number];
  };
}

interface WallTemplate {
  position: { x: number; y: number; z: number };
  baseY: number;
  size: { width: number; height: number; depth: number };
  localBounds: SceneLocalBounds;
}

interface ParseState {
  lastWallTemplate?: WallTemplate;
}

export async function discoverLevelCatalog(levelsRoot: string): Promise<LevelSummary[]> {
  const entries = await readdirSafe(levelsRoot);
  const catalog: LevelCatalogEntry[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const packDir = path.join(levelsRoot, entry.name);
    const setPath = path.join(packDir, "set.json");
    if (!(await pathExists(setPath))) {
      continue;
    }

    const setJson = await readJsonSafe<Record<string, unknown>>(setPath);
    const levels = Array.isArray(setJson?.LEDI) ? (setJson.LEDI as RawLevelEntry[]) : [];
    const packTitle = humanizePackName(entry.name);

    levels.forEach((levelEntry, index) => {
      const levelId = createLevelId(entry.name, levelEntry.Alf);
      catalog.push({
        packDir,
        summary: {
          id: levelId,
          slug: levelId.replace(/[:/]/g, "-").toLowerCase(),
          title: levelEntry.Name,
          message: levelEntry.Message ?? "",
          source: "official_repo",
          packSlug: entry.name,
          packTitle,
          packageId: undefined,
          alfPath: levelEntry.Alf,
          entryIndex: index,
          isOfficial: true,
          moderationStatus: "official",
          recommendedPlayers: [2, 8],
          levelPreviewUrl: null,
          sceneUrl: `/levels/${encodeURIComponent(levelId)}/scene`,
          creatorName: "Avara Legacy Import",
          uploadedAt: new Date(0).toISOString(),
          publicPlayable: true,
          privatePlayable: true
        }
      });
    });
  }

  catalog.sort((left, right) => {
    const leftPriority = CURATED_PACK_PRIORITY.indexOf(left.summary.packSlug);
    const rightPriority = CURATED_PACK_PRIORITY.indexOf(right.summary.packSlug);

    if (leftPriority !== rightPriority) {
      return normalizePriority(leftPriority) - normalizePriority(rightPriority);
    }

    if (left.summary.packTitle !== right.summary.packTitle) {
      return left.summary.packTitle.localeCompare(right.summary.packTitle);
    }

    return left.summary.title.localeCompare(right.summary.title);
  });

  return catalog.map((entry) => entry.summary);
}

export async function parseLevelScene(levelsRoot: string, levelId: string): Promise<LevelScene> {
  const catalog = await buildCatalogMap(levelsRoot);
  const resolved = catalog.get(levelId);
  if (!resolved) {
    throw new Error(`Unknown level id: ${levelId}`);
  }

  const scriptContext = await loadPackScriptContext(levelsRoot, resolved.packDir);
  const environment = {
    skyColors: ["#9bd7ff", "#d5e7ff"],
    groundColor: "#2c3138"
  };
  const soundscape = {
    ambient: [] as SceneSound[]
  };
  const nodes: SceneNode[] = [];
  const context = { ...scriptContext, wallHeight: 1, wallYon: 0.01 };
  const state: ParseState = {};

  const entryFile = await resolvePackLevelFile(resolved.packDir, resolved.summary.alfPath);
  await collectSceneFromFile({
    currentFile: entryFile,
    packDir: resolved.packDir,
    levelsRoot,
    environment,
    soundscape,
    nodes,
    context,
    state
  });

  const incarnateSoundId = readIntegerSetting(context, "incarnateSound", 411);
  const blastSoundDefaultId = readIntegerSetting(context, "blastSoundDefault", 230);
  const [incarnateSoundAsset, blastSoundDefaultAsset] = await Promise.all([
    resolveSoundAsset(incarnateSoundId, resolved.packDir, levelsRoot),
    resolveSoundAsset(blastSoundDefaultId, resolved.packDir, levelsRoot)
  ]);

  return {
    id: resolved.summary.id,
    title: resolved.summary.title,
    packSlug: resolved.summary.packSlug,
    entryPath: resolved.summary.alfPath,
    environment,
    soundscape,
    settings: {
      gravity: readNumericSetting(context, "gravity", 1),
      defaultTraction: readNumericSetting(context, "defaultTraction", 0.4),
      defaultFriction: readNumericSetting(context, "defaultFriction", 0.15),
      grenadePower: readNumericSetting(context, "grenadePower", 2.25),
      missilePower: readNumericSetting(context, "missilePower", 1),
      missileTurnRate: readNumericSetting(context, "missileTurnRate", 0.025),
      missileAcceleration: readNumericSetting(context, "missileAcceleration", 0.2),
      maxStartGrenades: readIntegerSetting(context, "maxStartGrenades", 20),
      maxStartMissiles: readIntegerSetting(context, "maxStartMissiles", 10),
      maxStartBoosts: readIntegerSetting(context, "maxStartBoosts", 5),
      defaultLives: readIntegerSetting(context, "defaultLives", 3),
      incarnateSoundId,
      incarnateSoundUrl: incarnateSoundAsset?.assetUrl,
      incarnateVolume: readNumericSetting(context, "incarnateVolume", 12),
      blastSoundDefaultId,
      blastSoundDefaultUrl: blastSoundDefaultAsset?.assetUrl
    },
    nodes
  };
}

async function collectSceneFromFile(input: {
  currentFile: string;
  packDir: string;
  levelsRoot: string;
  environment: { skyColors: string[]; groundColor: string };
  soundscape: { ambient: SceneSound[] };
  nodes: SceneNode[];
  context: ScriptContext;
  state: ParseState;
  visited?: Set<string>;
}): Promise<void> {
  const visited = input.visited ?? new Set<string>();
  if (visited.has(input.currentFile)) {
    return;
  }
  visited.add(input.currentFile);

  const xml = await fs.readFile(input.currentFile, "utf8");
  const tags = extractTags(xml);

  for (const tag of tags) {
    if (tag.name === "include" && tag.attributes.alf) {
      const includeFile = path.resolve(path.dirname(input.currentFile), tag.attributes.alf);
      if (await pathExists(includeFile)) {
        await collectSceneFromFile({
          ...input,
          currentFile: includeFile,
          visited
        });
      }
      continue;
    }

    if (tag.name === "set") {
      for (const [key, value] of Object.entries(tag.attributes)) {
        input.context[key] = resolveAttributeValue(value, input.context);
      }
      continue;
    }

    if (tag.name === "SkyColor") {
      input.environment.skyColors = [
        sanitizeColor(tag.attributes.color ?? "#9bd7ff"),
        sanitizeColor(tag.attributes["color.1"] ?? tag.attributes.color ?? "#d5e7ff")
      ];
      continue;
    }

    if (tag.name === "GroundColor") {
      input.environment.groundColor = sanitizeColor(tag.attributes.color ?? "#2c3138");
      continue;
    }

    if (tag.name === "Sound") {
      const sound = await parseSceneSound(tag, input.packDir, input.levelsRoot, input.context);
      if (sound?.ambient) {
        input.soundscape.ambient.push(sound.track);
      }
      continue;
    }

    const node = await toSceneNode(tag, input.packDir, input.levelsRoot, input.context, input.state, input.nodes.length);
    if (node) {
      input.nodes.push(node);
    }
  }
}

async function toSceneNode(
  tag: ParsedTag,
  packDir: string,
  levelsRoot: string,
  context: ScriptContext,
  state: ParseState,
  index: number
): Promise<SceneNode | null> {
  const evaluated = Object.fromEntries(
    Object.entries(tag.attributes).map(([key, value]) => [key, resolveAttributeValue(value, context)])
  );

  const position = {
    x: toNumber(evaluated.cx ?? evaluated.x, 0),
    y: toNumber(evaluated.y, 0),
    z: toNumber(evaluated.cz ?? evaluated.z, 0)
  };

  const rotation = {
    pitch: toNumber(evaluated.pitch, 0),
    yaw: toNumber(evaluated.angle ?? evaluated.midYaw, 0),
    roll: toNumber(evaluated.roll, 0)
  };

  const common = {
    id: `${tag.name.toLowerCase()}-${index}`,
    actorClass: tag.name,
    position,
    rotation,
    color: sanitizeColor(asString(evaluated.color)),
    accentColor: sanitizeColor(asString(evaluated["color.1"])),
    meta: evaluated
  } satisfies Partial<SceneNode>;

  switch (tag.name) {
    case "Wall": {
      const wallTemplate = createWallTemplate(evaluated, context);
      state.lastWallTemplate = wallTemplate;
      return {
        ...common,
        type: "wall",
        position: wallTemplate.position,
        rotation: { pitch: 0, yaw: 0, roll: 0 },
        size: wallTemplate.size,
        localBounds: wallTemplate.localBounds
      };
    }

    case "WallDoor": {
      const wallTemplate = createWallTemplate(evaluated, context);
      state.lastWallTemplate = wallTemplate;
      const consumedTemplate = takeLastWallTemplate(state);
      if (!consumedTemplate) {
        return null;
      }

      return {
        ...common,
        type: "door",
        position: consumedTemplate.position,
        rotation: { pitch: 0, yaw: 0, roll: 0 },
        size: consumedTemplate.size,
        localBounds: consumedTemplate.localBounds
      };
    }

    case "Ramp":
      return {
        ...common,
        type: "ramp",
        size: {
          width: clampSize(toNumber(evaluated.w, 2)),
          height: clampSize(Math.max(toNumber(evaluated.deltaY, 1), 0.25)),
          depth: clampSize(toNumber(evaluated.d, 2))
        }
      };

    case "Incarnator":
      return {
        ...common,
        type: "spawn",
        size: { width: 2.5, height: 0.5, depth: 2.5 }
      };

    case "Teleporter":
      return {
        ...common,
        type: "teleporter",
        size: { width: 2.5, height: 0.25, depth: 2.5 },
        scale: toNumber(evaluated.scale, 1),
        ...(await resolveShapeDescriptor(asShapeToken(evaluated.shape, tag.attributes.shape), packDir, levelsRoot, context))
      };

    case "Goody":
      return {
        ...common,
        type: "goody",
        size: { width: 1.25, height: 1.25, depth: 1.25 },
        scale: toNumber(evaluated.scale, 1),
        ...(await resolveShapeDescriptor(asShapeToken(evaluated.shape, tag.attributes.shape), packDir, levelsRoot, context))
      };

    case "WallSolid": {
      const wallTemplate = createWallTemplate(evaluated, context);
      state.lastWallTemplate = wallTemplate;
      const consumedTemplate = takeLastWallTemplate(state);
      if (!consumedTemplate) {
        return null;
      }

      return {
        ...common,
        type: "shape",
        position: consumedTemplate.position,
        rotation: { pitch: 0, yaw: 0, roll: 0 },
        size: consumedTemplate.size,
        localBounds: consumedTemplate.localBounds
      };
    }

    case "Solid":
    case "FreeSolid":
    case "Hologram":
    case "Door": {
      const rawShape = asShapeToken(evaluated.shape, tag.attributes.shape);
      const scale = toNumber(evaluated.scale, 1);
      const shapeDescriptor = await resolveShapeDescriptor(
        rawShape,
        packDir,
        levelsRoot,
        context
      );
      const wallTemplate = resolveWallBackedTemplate(tag.name, rawShape, shapeDescriptor, evaluated, context, state);
      if (wallTemplate) {
        return {
          ...common,
          type: tag.name === "Door" ? "door" : "shape",
          position: wallTemplate.position,
          rotation: { pitch: 0, yaw: 0, roll: 0 },
          size: wallTemplate.size,
          localBounds: wallTemplate.localBounds,
          scale
        };
      }
      if (tag.name === "FreeSolid" && shapeDescriptor.shapeId === 0) {
        return null;
      }
      const localBounds = shapeDescriptor.localBounds
        ? scaleLocalBounds(shapeDescriptor.localBounds, scale)
        : createFallbackShapeBounds(evaluated, tag.name);

      return {
        ...common,
        type: tag.name === "Door" ? "door" : "shape",
        size: boundsToSize(localBounds),
        scale,
        ...shapeDescriptor,
        localBounds
      };
    }

    case "Field":
      {
        const rawShape = asShapeToken(evaluated.shape, tag.attributes.shape);
        const shapeDescriptor = await resolveShapeDescriptor(rawShape, packDir, levelsRoot, context);
        const wallTemplate = resolveWallBackedTemplate(tag.name, rawShape, shapeDescriptor, evaluated, context, state);
        if (wallTemplate) {
          return {
            ...common,
            type: "field",
            position: wallTemplate.position,
            rotation: { pitch: 0, yaw: 0, roll: 0 },
            size: wallTemplate.size,
            localBounds: wallTemplate.localBounds
          };
        }
        if (shapeDescriptor.shapeId === 0) {
          return null;
        }

        return {
          ...common,
          type: "field",
          size: {
            width: clampSize(toNumber(evaluated.w, 1)),
            height: clampSize(Math.max(toNumber(evaluated.deltaY, toNumber(evaluated.h, 2)), 0.1)),
            depth: clampSize(toNumber(evaluated.d, 1))
          },
          ...(shapeDescriptor.shapeAssetUrl || shapeDescriptor.shapeId !== undefined || shapeDescriptor.shapeKey
            ? shapeDescriptor
            : {})
        };
      }

    case "Marker":
      if (isAdBillboardMarker(evaluated)) {
        return {
          ...common,
          type: "ad_placeholder",
          slotId: asString(evaluated.slot ?? evaluated.adSlot ?? evaluated.id) ?? `billboard-${index}`,
          size: {
            width: clampSize(toNumber(evaluated.w, 14)),
            height: clampSize(toNumber(evaluated.h, 7)),
            depth: clampSize(toNumber(evaluated.d, 0.4))
          }
        };
      }

      return {
        ...common,
        type: "marker",
        size: { width: 1, height: 1, depth: 1 }
      };

    default:
      return null;
  }
}

async function resolveShapeDescriptor(
  rawShape: string | undefined,
  packDir: string,
  levelsRoot: string,
  context: ScriptContext
): Promise<Pick<SceneNode, "shapeAssetUrl" | "shapeId" | "shapeKey" | "localBounds">> {
  if (!rawShape) {
    return {};
  }

  const resolved = resolveAttributeValue(rawShape, context);
  const shapeKey = typeof resolved === "string" ? resolved : rawShape;
  const shapeId = typeof resolved === "number" ? resolved : parseNumericShape(typeof resolved === "string" ? resolved : rawShape);

  if (shapeId !== null) {
    const resolvedAsset = await resolveShapeAsset(shapeId, packDir, levelsRoot);
    return {
      shapeAssetUrl: resolvedAsset?.assetUrl,
      shapeId,
      shapeKey: rawShape,
      localBounds: resolvedAsset ? await readShapeBounds(resolvedAsset.filePath) : undefined
    };
  }

  return {
    shapeKey
  };
}

async function resolveShapeAsset(
  shapeId: number,
  packDir: string,
  levelsRoot: string
): Promise<{ assetUrl: string; filePath: string } | undefined> {
  const localPackFile = path.join(packDir, "bsps", `${shapeId}.json`);
  if (await pathExists(localPackFile)) {
    return {
      assetUrl: toApiContentPath(localPackFile, levelsRoot),
      filePath: localPackFile
    };
  }

  const workspaceRoot = path.dirname(levelsRoot);
  const rootShapeFile = path.join(workspaceRoot, "rsrc", "bsps", `${shapeId}.json`);
  if (await pathExists(rootShapeFile)) {
    return {
      assetUrl: toApiContentPath(rootShapeFile, levelsRoot),
      filePath: rootShapeFile
    };
  }

  for (const directory of await listSupplementalResourceBspDirectories(workspaceRoot)) {
    const nestedShapeFile = path.join(directory, `${shapeId}.json`);
    if (await pathExists(nestedShapeFile)) {
      return {
        assetUrl: toApiContentPath(nestedShapeFile, levelsRoot),
        filePath: nestedShapeFile
      };
    }
  }

  return undefined;
}

async function resolveSoundAsset(
  soundId: number,
  packDir: string,
  levelsRoot: string
): Promise<{ assetUrl: string; filePath: string } | undefined> {
  const localPackFile = path.join(packDir, "ogg", `${soundId}.ogg`);
  if (await pathExists(localPackFile)) {
    return {
      assetUrl: toApiContentPath(localPackFile, levelsRoot),
      filePath: localPackFile
    };
  }

  const workspaceRoot = path.dirname(levelsRoot);
  const rootSoundFile = path.join(workspaceRoot, "rsrc", "ogg", `${soundId}.ogg`);
  if (await pathExists(rootSoundFile)) {
    return {
      assetUrl: toApiContentPath(rootSoundFile, levelsRoot),
      filePath: rootSoundFile
    };
  }

  for (const directory of await listSupplementalResourceSoundDirectories(workspaceRoot)) {
    const nestedSoundFile = path.join(directory, `${soundId}.ogg`);
    if (await pathExists(nestedSoundFile)) {
      return {
        assetUrl: toApiContentPath(nestedSoundFile, levelsRoot),
        filePath: nestedSoundFile
      };
    }
  }

  return undefined;
}

async function buildCatalogMap(levelsRoot: string): Promise<Map<string, LevelCatalogEntry>> {
  const summaries = await discoverLevelCatalog(levelsRoot);
  const catalog = new Map<string, LevelCatalogEntry>();

  for (const summary of summaries) {
    catalog.set(summary.id, {
      summary,
      packDir: path.join(levelsRoot, summary.packSlug)
    });
  }

  return catalog;
}

const supplementalBspDirectoryCache = new Map<string, Promise<string[]>>();
const shapeBoundsCache = new Map<string, Promise<SceneLocalBounds | undefined>>();
const supplementalSoundDirectoryCache = new Map<string, Promise<string[]>>();

async function loadPackScriptContext(levelsRoot: string, packDir: string): Promise<ScriptContext> {
  const context: ScriptContext = {};
  const workspaceRoot = path.dirname(levelsRoot);
  const scriptPaths = [
    path.join(workspaceRoot, "rsrc", "default.avarascript"),
    path.join(packDir, "default.avarascript")
  ];

  for (const scriptPath of scriptPaths) {
    if (!(await pathExists(scriptPath))) {
      continue;
    }
    await mergeScriptContextFromFile(scriptPath, context);
  }

  return context;
}

async function mergeScriptContextFromFile(scriptPath: string, context: ScriptContext): Promise<void> {
  const script = await fs.readFile(scriptPath, "utf8");
  for (const rawLine of script.split("\n")) {
    const line = rawLine.replace(/\/\/.*$/, "").trim();
    if (!line || !line.includes("=")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    const left = line.slice(0, separatorIndex).trim();
    const right = line.slice(separatorIndex + 1).trim();
    if (!left || !right) {
      continue;
    }

    context[left] = resolveAttributeValue(right, context);
  }
}

async function listSupplementalResourceBspDirectories(workspaceRoot: string): Promise<string[]> {
  const cached = supplementalBspDirectoryCache.get(workspaceRoot);
  if (cached) {
    return cached;
  }

  const pending = (async () => {
    const rsrcRoot = path.join(workspaceRoot, "rsrc");
    const entries = await readdirSafe(rsrcRoot);
    const directories: string[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const bspDirectory = path.join(rsrcRoot, entry.name, "bsps");
      if (await pathExists(bspDirectory)) {
        directories.push(bspDirectory);
      }
    }

    return directories;
  })();

  supplementalBspDirectoryCache.set(workspaceRoot, pending);
  return pending;
}

async function listSupplementalResourceSoundDirectories(workspaceRoot: string): Promise<string[]> {
  const cached = supplementalSoundDirectoryCache.get(workspaceRoot);
  if (cached) {
    return cached;
  }

  const pending = (async () => {
    const rsrcRoot = path.join(workspaceRoot, "rsrc");
    const entries = await readdirSafe(rsrcRoot);
    const directories: string[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const soundDirectory = path.join(rsrcRoot, entry.name, "ogg");
      if (await pathExists(soundDirectory)) {
        directories.push(soundDirectory);
      }
    }

    return directories;
  })();

  supplementalSoundDirectoryCache.set(workspaceRoot, pending);
  return pending;
}

async function parseSceneSound(
  tag: ParsedTag,
  packDir: string,
  levelsRoot: string,
  context: ScriptContext
): Promise<{ ambient: true; track: SceneSound } | null> {
  const evaluated = Object.fromEntries(
    Object.entries(tag.attributes).map(([key, value]) => [key, resolveAttributeValue(value, context)])
  );

  if (evaluated.isAmbient !== true) {
    return null;
  }

  const soundId = typeof evaluated.sound === "number" ? evaluated.sound : parseNumericShape(asString(evaluated.sound) ?? "");
  if (!soundId || soundId <= 0) {
    return null;
  }

  const asset = await resolveSoundAsset(soundId, packDir, levelsRoot);
  return {
    ambient: true,
    track: {
      soundId,
      assetUrl: asset?.assetUrl,
      volume: readVolumeSetting(evaluated.volume, 100),
      loop: toNumber(evaluated.loopCount, -1) < 0,
      position: {
        x: toNumber(evaluated.cx ?? evaluated.x, 0),
        y: toNumber(evaluated.y, 0),
        z: toNumber(evaluated.cz ?? evaluated.z, 0)
      }
    }
  };
}

async function readShapeBounds(filePath: string): Promise<SceneLocalBounds | undefined> {
  const cached = shapeBoundsCache.get(filePath);
  if (cached) {
    return cached;
  }

  const pending = (async () => {
    const asset = await readJsonSafe<ParsedBspAsset>(filePath);
    const min = asset.bounds?.min;
    const max = asset.bounds?.max;
    if (!min || !max || min.length !== 3 || max.length !== 3) {
      return undefined;
    }

    return {
      min: { x: min[0], y: min[1], z: min[2] },
      max: { x: max[0], y: max[1], z: max[2] }
    };
  })();

  shapeBoundsCache.set(filePath, pending);
  return pending;
}

function extractTags(xml: string): ParsedTag[] {
  const tags: ParsedTag[] = [];
  const cleaned = xml.replace(/<!--[\s\S]*?-->/g, "");

  let cursor = 0;
  while (cursor < cleaned.length) {
    const start = cleaned.indexOf("<", cursor);
    if (start === -1) {
      break;
    }

    const end = findTagEnd(cleaned, start + 1);
    if (end === -1) {
      break;
    }

    const rawTag = cleaned.slice(start + 1, end).trim();
    cursor = end + 1;

    if (!rawTag || rawTag.startsWith("/") || rawTag.startsWith("!")) {
      continue;
    }

    const selfClosing = rawTag.endsWith("/");
    const content = selfClosing ? rawTag.slice(0, -1).trim() : rawTag;
    const spaceIndex = content.search(/\s/);
    const name = spaceIndex === -1 ? content : content.slice(0, spaceIndex);
    if (name === "map") {
      continue;
    }

    const attributeSource = spaceIndex === -1 ? "" : content.slice(spaceIndex + 1);
    tags.push({
      name,
      attributes: parseAttributes(attributeSource)
    });
  }

  return tags;
}

function findTagEnd(source: string, start: number): number {
  let quote: string | null = null;

  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if ((char === '"' || char === "'") && source[index - 1] !== "\\") {
      quote = quote === char ? null : char;
      continue;
    }

    if (char === ">" && !quote) {
      return index;
    }
  }

  return -1;
}

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const matcher = /([:@A-Za-z0-9_.-]+)\s*=\s*"([^"]*)"/g;

  for (const match of source.matchAll(matcher)) {
    attributes[match[1]] = match[2];
  }

  return attributes;
}

function resolveAttributeValue(value: string, context: ScriptContext): number | string | boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }

  if (trimmed.startsWith("#")) {
    return trimmed;
  }

  if (trimmed === "true") {
    return true;
  }

  if (trimmed === "false") {
    return false;
  }

  if (/^-?(?:\d+(\.\d+)?|\.\d+)$/.test(trimmed)) {
    return Number(trimmed);
  }

  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }

  if (trimmed in context) {
    return context[trimmed];
  }

  const safeExpression = /^[\w\s.+\-*/()@]+$/.test(trimmed);
  if (safeExpression) {
    try {
      return evaluateArithmeticExpression(trimmed, context);
    } catch {
      return trimmed;
    }
  }

  return trimmed;
}

function parseNumericShape(value: string): number | null {
  return /^\d+$/.test(value) ? Number(value) : null;
}

function normalizeLevelPath(levelPath: string): string {
  return levelPath.replace(/^\/+/, "");
}

async function resolvePackLevelFile(packDir: string, levelPath: string): Promise<string> {
  const normalized = normalizeLevelPath(levelPath);
  const candidates = [
    path.join(packDir, normalized),
    path.join(packDir, "alf", normalized)
  ];

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Unable to resolve ALF file ${levelPath} in ${packDir}`);
}

function createLevelId(packSlug: string, alfPath: string): string {
  return `${packSlug}:${alfPath}`;
}

function humanizePackName(slug: string): string {
  return slug
    .split(/[-._]/g)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(" ");
}

function normalizePriority(priority: number): number {
  return priority === -1 ? Number.MAX_SAFE_INTEGER : priority;
}

function toApiContentPath(filePath: string, levelsRoot: string): string {
  const workspaceRoot = path.dirname(levelsRoot);
  const relativePath = path.relative(workspaceRoot, filePath).split(path.sep).join("/");
  return `/content/${relativePath}`;
}

async function readJsonSafe<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
}

async function readdirSafe(directory: string) {
  return fs.readdir(directory, { withFileTypes: true });
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function sanitizeColor(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  return value.startsWith("#") || value.startsWith("rgb") ? value : undefined;
}

function isAdBillboardMarker(attributes: Record<string, unknown>): boolean {
  const kind = asString(attributes.kind)?.toLowerCase();
  const placement = asString(attributes.placement)?.toLowerCase();
  const slot = asString(attributes.slot ?? attributes.adSlot ?? attributes.billboardSlot);

  return kind === "ad_billboard" || placement === "ad_billboard" || Boolean(slot);
}

function toNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readVolumeSetting(value: unknown, fallback: number): number {
  const numeric = toNumber(value, fallback);
  return Math.max(0, numeric);
}

function readNumericSetting(context: ScriptContext, key: string, fallback: number): number {
  const value = context[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readIntegerSetting(context: ScriptContext, key: string, fallback: number): number {
  return Math.round(readNumericSetting(context, key, fallback));
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asShapeToken(value: unknown, fallback?: string): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return fallback ?? String(value);
  }
  return fallback;
}

function clampSize(value: number): number {
  return Math.max(Math.abs(value), 0.1);
}

function resolveWallBackedTemplate(
  actorClass: string,
  rawShape: string | undefined,
  shapeDescriptor: Pick<SceneNode, "shapeAssetUrl" | "shapeId" | "shapeKey" | "localBounds">,
  evaluated: Record<string, unknown>,
  context: ScriptContext,
  state: ParseState
): WallTemplate | undefined {
  if (actorClass === "Door" || actorClass === "Solid" || actorClass === "Hologram") {
    return undefined;
  }

  const shapeMissing = rawShape === undefined || rawShape === "";
  if (shapeMissing && (actorClass === "FreeSolid" || actorClass === "Field")) {
    const template = createWallTemplate(evaluated, context);
    state.lastWallTemplate = template;
    return takeLastWallTemplate(state);
  }

  if (shapeDescriptor.shapeId === 0 && (actorClass === "FreeSolid" || actorClass === "Field")) {
    return takeLastWallTemplate(state);
  }

  return undefined;
}

function takeLastWallTemplate(state: ParseState): WallTemplate | undefined {
  const template = state.lastWallTemplate;
  state.lastWallTemplate = undefined;
  return template;
}

function createWallTemplate(attributes: Record<string, unknown>, context: ScriptContext): WallTemplate {
  const width = clampSize(toNumber(attributes.w, 1));
  const depth = clampSize(toNumber(attributes.d, 1));
  const height = resolveWallHeight(attributes, context);
  const baseHeight = readNumericSetting(context, "baseHeight", 0);
  const wallAltitude = readNumericSetting(context, "wallAltitude", 0);
  const baseY = baseHeight + wallAltitude + toNumber(attributes.y, 0);
  const centerY = baseY + height / 2;

  return {
    position: {
      x: toNumber(attributes.x, 0),
      y: centerY,
      z: toNumber(attributes.z, 0)
    },
    baseY,
    size: {
      width,
      height,
      depth
    },
    localBounds: {
      min: {
        x: -width / 2,
        y: -height / 2,
        z: -depth / 2
      },
      max: {
        x: width / 2,
        y: height / 2,
        z: depth / 2
      }
    }
  };
}

function resolveWallHeight(attributes: Record<string, unknown>, context: ScriptContext): number {
  const explicitHeight = typeof attributes.h === "number" && Number.isFinite(attributes.h)
    ? Math.abs(attributes.h)
    : undefined;

  if (explicitHeight && explicitHeight > 0) {
    return explicitHeight;
  }

  const scriptedHeight = Math.abs(readNumericSetting(context, "wallHeight", 1));
  return scriptedHeight;
}

function scaleLocalBounds(bounds: SceneLocalBounds, scale: number): SceneLocalBounds {
  const factor = Number.isFinite(scale) ? scale : 1;
  return {
    min: {
      x: bounds.min.x * factor,
      y: bounds.min.y * factor,
      z: bounds.min.z * factor
    },
    max: {
      x: bounds.max.x * factor,
      y: bounds.max.y * factor,
      z: bounds.max.z * factor
    }
  };
}

function boundsToSize(bounds: SceneLocalBounds): { width: number; height: number; depth: number } {
  return {
    width: clampSize(bounds.max.x - bounds.min.x),
    height: clampSize(bounds.max.y - bounds.min.y),
    depth: clampSize(bounds.max.z - bounds.min.z)
  };
}

function createFallbackShapeBounds(attributes: Record<string, unknown>, actorClass: string): SceneLocalBounds {
  const width = clampSize(toNumber(attributes.w, 2));
  const height = clampSize(toNumber(attributes.h, 2));
  const depth = clampSize(toNumber(attributes.d, 2));
  const centered = actorClass === "Hologram";

  return {
    min: {
      x: -width / 2,
      y: centered ? -height / 2 : 0,
      z: -depth / 2
    },
    max: {
      x: width / 2,
      y: centered ? height / 2 : height,
      z: depth / 2
    }
  };
}

function evaluateArithmeticExpression(expression: string, context: ScriptContext): number {
  const tokens = tokenizeArithmetic(expression);
  let cursor = 0;

  const parseExpression = (): number => {
    let value = parseTerm();
    while (tokens[cursor] === "+" || tokens[cursor] === "-") {
      const operator = tokens[cursor++];
      const right = parseTerm();
      value = operator === "+" ? value + right : value - right;
    }
    return value;
  };

  const parseTerm = (): number => {
    let value = parseFactor();
    while (tokens[cursor] === "*" || tokens[cursor] === "/") {
      const operator = tokens[cursor++];
      const right = parseFactor();
      value = operator === "*" ? value * right : value / right;
    }
    return value;
  };

  const parseFactor = (): number => {
    const token = tokens[cursor++];
    if (token === undefined) {
      throw new Error("Unexpected end of arithmetic expression");
    }

    if (token === "(") {
      const value = parseExpression();
      if (tokens[cursor++] !== ")") {
        throw new Error("Expected closing parenthesis");
      }
      return value;
    }

    if (token === "-") {
      return -parseFactor();
    }

    if (/^-?\d+(\.\d+)?$/.test(token)) {
      return Number(token);
    }

    const normalized = token.replace(/^@/, "");
    const directValue = context[token] ?? context[normalized] ?? context[`@${normalized}`];
    if (typeof directValue === "number") {
      return directValue;
    }
    if (typeof directValue === "boolean") {
      return directValue ? 1 : 0;
    }

    throw new Error(`Unknown arithmetic token ${token}`);
  };

  const result = parseExpression();
  if (cursor !== tokens.length) {
    throw new Error("Unexpected trailing tokens");
  }

  return result;
}

function tokenizeArithmetic(expression: string): string[] {
  const tokens: string[] = [];
  const source = expression.trim();
  let cursor = 0;

  while (cursor < source.length) {
    const char = source[cursor];
    if (/\s/.test(char)) {
      cursor += 1;
      continue;
    }

    if ("()+-*/".includes(char)) {
      tokens.push(char);
      cursor += 1;
      continue;
    }

    const numberMatch = source.slice(cursor).match(/^\d+(\.\d+)?/);
    if (numberMatch) {
      tokens.push(numberMatch[0]);
      cursor += numberMatch[0].length;
      continue;
    }

    const identifierMatch = source.slice(cursor).match(/^@?[A-Za-z_][A-Za-z0-9_]*/);
    if (identifierMatch) {
      tokens.push(identifierMatch[0]);
      cursor += identifierMatch[0].length;
      continue;
    }

    throw new Error(`Unexpected token near ${source.slice(cursor)}`);
  }

  return tokens;
}
