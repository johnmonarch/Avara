import { promises as fs } from "node:fs";
import path from "node:path";

import type { LevelScene, LevelSummary, SceneNode } from "@avara/shared-types";

const CURATED_PACK_PRIORITY = [
  "avaraline-strict-mode",
  "wut",
  "single-player",
  "aa-normal",
  "the-lexicon"
];

const BUILTIN_PLACEHOLDER_SHAPES = new Set([
  "bspGrenade",
  "bspMissile",
  "bspAvaraA",
  "bspFloorFrame",
  "bspHill"
]);

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
          packSlug: entry.name,
          packTitle,
          alfPath: levelEntry.Alf,
          entryIndex: index,
          isOfficial: true,
          moderationStatus: "official",
          recommendedPlayers: [2, 8],
          levelPreviewUrl: null,
          sceneUrl: `/levels/${encodeURIComponent(levelId)}/scene`
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

  const scriptContext = await loadPackScriptContext(resolved.packDir);
  const environment = {
    skyColors: ["#9bd7ff", "#d5e7ff"],
    groundColor: "#2c3138"
  };
  const nodes: SceneNode[] = [];

  const entryFile = await resolvePackLevelFile(resolved.packDir, resolved.summary.alfPath);
  await collectSceneFromFile({
    currentFile: entryFile,
    packDir: resolved.packDir,
    levelsRoot,
    environment,
    nodes,
    context: { ...scriptContext, wallHeight: 1, wallYon: 0.01 }
  });

  return {
    id: resolved.summary.id,
    title: resolved.summary.title,
    packSlug: resolved.summary.packSlug,
    entryPath: resolved.summary.alfPath,
    environment,
    nodes
  };
}

async function collectSceneFromFile(input: {
  currentFile: string;
  packDir: string;
  levelsRoot: string;
  environment: { skyColors: string[]; groundColor: string };
  nodes: SceneNode[];
  context: ScriptContext;
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

    const node = await toSceneNode(tag, input.packDir, input.levelsRoot, input.context, input.nodes.length);
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
    case "Wall":
    case "WallDoor":
      return {
        ...common,
        type: tag.name === "WallDoor" ? "door" : "wall",
        size: {
          width: clampSize(toNumber(evaluated.w, 1)),
          height: clampSize(toNumber(evaluated.h, toNumber(context.wallHeight, 1))),
          depth: clampSize(toNumber(evaluated.d, 1))
        }
      };

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
        ...(await resolveShapeDescriptor(asString(evaluated.shape), packDir, levelsRoot, context))
      };

    case "Goody":
      return {
        ...common,
        type: "goody",
        size: { width: 1.25, height: 1.25, depth: 1.25 },
        scale: toNumber(evaluated.scale, 1),
        ...(await resolveShapeDescriptor(asString(evaluated.shape), packDir, levelsRoot, context))
      };

    case "Solid":
    case "FreeSolid":
    case "Hologram":
    case "Door":
      return {
        ...common,
        type: tag.name === "Door" ? "door" : "shape",
        size: { width: 2, height: 2, depth: 2 },
        scale: toNumber(evaluated.scale, 1),
        ...(await resolveShapeDescriptor(asString(evaluated.shape), packDir, levelsRoot, context))
      };

    case "Field":
      return {
        ...common,
        type: "field",
        size: {
          width: clampSize(toNumber(evaluated.w, 1)),
          height: clampSize(Math.max(toNumber(evaluated.deltaY, toNumber(evaluated.h, 2)), 0.1)),
          depth: clampSize(toNumber(evaluated.d, 1))
        }
      };

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
): Promise<Pick<SceneNode, "shapeAssetUrl" | "shapeId" | "shapeKey">> {
  if (!rawShape) {
    return {};
  }

  const resolved = resolveAttributeValue(rawShape, context);
  const shapeKey = typeof resolved === "string" ? resolved : rawShape;
  const shapeId = typeof resolved === "number" ? resolved : parseNumericShape(rawShape);

  if (shapeId !== null) {
    const shapeAssetUrl = await resolveShapeAssetUrl(shapeId, packDir, levelsRoot);
    return {
      shapeAssetUrl,
      shapeId,
      shapeKey: rawShape
    };
  }

  return {
    shapeKey
  };
}

async function resolveShapeAssetUrl(shapeId: number, packDir: string, levelsRoot: string): Promise<string | undefined> {
  const localPackFile = path.join(packDir, "bsps", `${shapeId}.json`);
  if (await pathExists(localPackFile)) {
    return toApiContentPath(localPackFile, levelsRoot);
  }

  const rootShapeFile = path.join(path.dirname(levelsRoot), "rsrc", "bsps", `${shapeId}.json`);
  if (await pathExists(rootShapeFile)) {
    return toApiContentPath(rootShapeFile, levelsRoot);
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

async function loadPackScriptContext(packDir: string): Promise<ScriptContext> {
  const context: ScriptContext = {};
  const scriptPath = path.join(packDir, "default.avarascript");
  if (!(await pathExists(scriptPath))) {
    return context;
  }

  const script = await fs.readFile(scriptPath, "utf8");
  for (const rawLine of script.split("\n")) {
    const line = rawLine.replace(/\/\/.*$/, "").trim();
    if (!line || !line.includes("=")) {
      continue;
    }

    const [left, right] = line.split("=").map((part) => part.trim());
    if (!left || !right) {
      continue;
    }

    context[left] = resolveAttributeValue(right, context);
  }

  return context;
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

  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
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

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function clampSize(value: number): number {
  return Math.max(Math.abs(value), 0.1);
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
