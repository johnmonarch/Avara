import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

import type { UploadValidationIssue, UploadValidationResult } from "@avara/shared-types";

const ALLOWED_EXTENSIONS = new Set([".json", ".alf", ".ogg", ".png"]);
const ALLOWED_TOP_LEVEL_DIRECTORIES = new Set(["alf", "audio", "preview", "bsps"]);
const TEXT_EXTENSIONS = new Set([".json", ".alf"]);
const IGNORED_ARCHIVE_PREFIXES = ["__MACOSX/", ".DS_Store"];
const MAX_TOTAL_SIZE_BYTES = 64 * 1024 * 1024;
const MAX_FILE_SIZE_BYTES = 16 * 1024 * 1024;
const MAX_FILE_COUNT = 256;
const MAX_OBJECT_COUNT = 4000;
const MAX_ASSET_COUNT = 128;
const SUPPORTED_COMPATIBILITY_VERSION = "web-mvp";
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;

export interface PackageCandidateFile {
  path: string;
  size: number;
  mimeType?: string;
}

export interface PackageCandidate {
  manifest: Record<string, unknown>;
  files: PackageCandidateFile[];
}

export interface ParsedArchiveFile extends PackageCandidateFile {
  checksum: string;
  contents: Buffer;
  textContent?: string;
}

export interface PreparedUploadPackage {
  validation: UploadValidationResult;
  archiveChecksum: string;
  files: ParsedArchiveFile[];
  suggestedPackSlug: string | null;
  previewPath: string | null;
  normalizedManifest: Record<string, unknown> | null;
  levelEntries: Array<{
    alfPath: string;
    title: string;
    message: string;
  }>;
}

interface ZipEntryMetadata {
  path: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

interface ParsedSetEntry {
  Alf: string;
  Name: string;
  Message?: string;
}

export function validateNormalizedPackage(candidate: PackageCandidate): UploadValidationResult {
  const issues: UploadValidationIssue[] = [];
  const totalSize = candidate.files.reduce((sum, file) => sum + file.size, 0);

  if (candidate.files.length > MAX_FILE_COUNT) {
    issues.push({
      path: "/",
      message: `Package exceeds ${MAX_FILE_COUNT} file limit`,
      severity: "error"
    });
  }

  if (totalSize > MAX_TOTAL_SIZE_BYTES) {
    issues.push({
      path: "/",
      message: `Package exceeds ${MAX_TOTAL_SIZE_BYTES / (1024 * 1024)} MB limit`,
      severity: "error"
    });
  }

  const requiredFiles = {
    manifest: candidate.files.some((file) => file.path === "manifest.json"),
    set: candidate.files.some((file) => file.path === "set.json"),
    alf: candidate.files.some((file) => file.path.startsWith("alf/") && file.path.endsWith(".alf"))
  };

  if (!requiredFiles.manifest) {
    issues.push({ path: "manifest.json", message: "Missing manifest.json", severity: "error" });
  }
  if (!requiredFiles.set) {
    issues.push({ path: "set.json", message: "Missing set.json", severity: "error" });
  }
  if (!requiredFiles.alf) {
    issues.push({ path: "alf/", message: "At least one .alf file is required", severity: "error" });
  }

  for (const file of candidate.files) {
    validateArchivePath(file.path, issues);
    validateFileExtension(file.path, file.size, issues);
  }

  const normalizedManifest = {
    ...candidate.manifest,
    compatibilityVersion: candidate.manifest.compatibilityVersion ?? SUPPORTED_COMPATIBILITY_VERSION,
    uploadedAt: new Date().toISOString()
  };

  return {
    ok: issues.every((issue) => issue.severity !== "error"),
    normalizedManifest,
    issues,
    fileCount: candidate.files.length,
    totalBytes: totalSize
  };
}

export function prepareUploadedPackage(fileName: string, archive: Buffer): PreparedUploadPackage {
  const issues: UploadValidationIssue[] = [];
  const archiveChecksum = createChecksum(archive);
  let files: ParsedArchiveFile[] = [];

  try {
    files = parseZipArchive(archive);
  } catch (error) {
    issues.push({
      path: fileName || "/",
      message: error instanceof Error ? error.message : "Unable to parse zip archive",
      severity: "error"
    });
  }

  const filteredFiles = files.filter((file) => !shouldIgnoreArchivePath(file.path));
  const manifestFile = filteredFiles.find((file) => file.path === "manifest.json");
  const setFile = filteredFiles.find((file) => file.path === "set.json");
  const alfFiles = filteredFiles.filter((file) => file.path.startsWith("alf/") && file.path.endsWith(".alf"));
  const previewPath = filteredFiles.find((file) => file.path.startsWith("preview/") && file.path.endsWith(".png"))?.path ?? null;
  const totalBytes = filteredFiles.reduce((sum, file) => sum + file.size, 0);

  const baseValidation = validateNormalizedPackage({
    manifest: parseJsonFile(manifestFile, issues, "manifest.json") ?? {},
    files: filteredFiles.map((file) => ({
      path: file.path,
      size: file.size,
      mimeType: file.mimeType
    }))
  });
  issues.push(...baseValidation.issues);

  const manifestJson = baseValidation.normalizedManifest ?? {};
  const setJson = parseJsonFile<Record<string, unknown>>(setFile, issues, "set.json");
  const setEntries = parseSetEntries(setJson, issues);
  const normalizedManifest = normalizeManifest(manifestJson, setEntries, previewPath, issues);
  const levelEntries = setEntries.map((entry) => ({
    alfPath: normalizeArchivePath(entry.Alf),
    title: entry.Name.trim(),
    message: (entry.Message ?? "").trim()
  }));

  let totalObjectCount = 0;
  for (const alfFile of alfFiles) {
    const text = alfFile.textContent ?? "";
    const objectCount = countSceneObjects(text);
    totalObjectCount += objectCount;

    if (!looksLikeAlf(text)) {
      issues.push({
        path: alfFile.path,
        message: "ALF file is not parseable as expected XML-like map content",
        severity: "error"
      });
    }

    if (objectCount > MAX_OBJECT_COUNT) {
      issues.push({
        path: alfFile.path,
        message: `ALF object count ${objectCount} exceeds limit ${MAX_OBJECT_COUNT}`,
        severity: "error"
      });
    }

    scanTextContent(alfFile.path, text, issues);
  }

  if (filteredFiles.length > MAX_FILE_COUNT) {
    issues.push({
      path: "/",
      message: `Package contains ${filteredFiles.length} files, above ${MAX_FILE_COUNT} limit`,
      severity: "error"
    });
  }

  if (alfFiles.length > MAX_ASSET_COUNT) {
    issues.push({
      path: "alf/",
      message: `Package contains too many ALF files (${alfFiles.length})`,
      severity: "error"
    });
  }

  if (totalObjectCount > MAX_OBJECT_COUNT * Math.max(1, alfFiles.length)) {
    issues.push({
      path: "alf/",
      message: "Combined geometry count is too large for the shared server limits",
      severity: "error"
    });
  }

  if (setEntries.length === 0) {
    issues.push({
      path: "set.json",
      message: "set.json does not define any level entries",
      severity: "error"
    });
  }

  for (const entry of levelEntries) {
    if (!filteredFiles.some((file) => file.path === normalizeArchivePath(entry.alfPath))) {
      issues.push({
        path: entry.alfPath,
        message: "Level entry references an ALF file that is missing from the archive",
        severity: "error"
      });
    }
  }

  if (manifestFile?.textContent) {
    scanTextContent("manifest.json", manifestFile.textContent, issues);
  }
  if (setFile?.textContent) {
    scanTextContent("set.json", setFile.textContent, issues);
  }

  const suggestedPackSlug = normalizedManifest ? createPackSlug(normalizedManifest.slug ?? normalizedManifest.title ?? fileName) : null;

  return {
    validation: {
      ok: issues.every((issue) => issue.severity !== "error"),
      normalizedManifest,
      issues: uniqueIssues(issues),
      archiveChecksum,
      fileCount: filteredFiles.length,
      totalBytes,
      suggestedPackSlug,
      previewPath,
      levelEntries
    },
    archiveChecksum,
    files: filteredFiles,
    suggestedPackSlug,
    previewPath,
    normalizedManifest,
    levelEntries
  };
}

export async function writePreparedPackage(packRoot: string, prepared: PreparedUploadPackage): Promise<void> {
  await fs.mkdir(packRoot, { recursive: true });

  for (const file of prepared.files) {
    const targetPath = path.join(packRoot, file.path);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, file.contents);
  }
}

function parseZipArchive(buffer: Buffer): ParsedArchiveFile[] {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (eocdOffset === -1) {
    throw new Error("Zip archive does not contain a valid end-of-central-directory record");
  }

  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  const entries: ParsedArchiveFile[] = [];

  let cursor = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(cursor) !== ZIP_CENTRAL_SIGNATURE) {
      throw new Error("Zip central directory is corrupted");
    }

    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const fileNameLength = buffer.readUInt16LE(cursor + 28);
    const extraFieldLength = buffer.readUInt16LE(cursor + 30);
    const fileCommentLength = buffer.readUInt16LE(cursor + 32);
    const compressionMethod = buffer.readUInt16LE(cursor + 10);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const rawPath = buffer.toString("utf8", cursor + 46, cursor + 46 + fileNameLength);

    const metadata: ZipEntryMetadata = {
      path: normalizeArchivePath(rawPath),
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset
    };

    cursor += 46 + fileNameLength + extraFieldLength + fileCommentLength;

    if (!metadata.path || metadata.path.endsWith("/")) {
      continue;
    }

    const contents = extractZipEntry(buffer, metadata);
    entries.push({
      path: metadata.path,
      size: contents.length,
      mimeType: guessMimeType(metadata.path),
      checksum: createChecksum(contents),
      contents,
      textContent: TEXT_EXTENSIONS.has(path.extname(metadata.path)) ? contents.toString("utf8") : undefined
    });
  }

  return entries;
}

function extractZipEntry(buffer: Buffer, entry: ZipEntryMetadata): Buffer {
  if (buffer.readUInt32LE(entry.localHeaderOffset) !== ZIP_LOCAL_SIGNATURE) {
    throw new Error(`Zip local header is corrupted for ${entry.path}`);
  }

  const fileNameLength = buffer.readUInt16LE(entry.localHeaderOffset + 26);
  const extraFieldLength = buffer.readUInt16LE(entry.localHeaderOffset + 28);
  const dataOffset = entry.localHeaderOffset + 30 + fileNameLength + extraFieldLength;
  const compressed = buffer.subarray(dataOffset, dataOffset + entry.compressedSize);

  if (entry.compressionMethod === 0) {
    return Buffer.from(compressed);
  }

  if (entry.compressionMethod === 8) {
    const inflated = inflateRawSync(compressed);
    if (inflated.length !== entry.uncompressedSize) {
      throw new Error(`Zip entry ${entry.path} inflated to an unexpected size`);
    }
    return inflated;
  }

  throw new Error(`Zip entry ${entry.path} uses unsupported compression method ${entry.compressionMethod}`);
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const searchStart = Math.max(0, buffer.length - 65_557);
  for (let index = buffer.length - 22; index >= searchStart; index -= 1) {
    if (buffer.readUInt32LE(index) === ZIP_EOCD_SIGNATURE) {
      return index;
    }
  }

  return -1;
}

function parseJsonFile<T>(file: ParsedArchiveFile | undefined, issues: UploadValidationIssue[], label: string): T | null {
  if (!file?.textContent) {
    return null;
  }

  try {
    return JSON.parse(file.textContent) as T;
  } catch {
    issues.push({
      path: label,
      message: `${label} is not valid JSON`,
      severity: "error"
    });
    return null;
  }
}

function parseSetEntries(setJson: Record<string, unknown> | null, issues: UploadValidationIssue[]): ParsedSetEntry[] {
  if (!setJson) {
    return [];
  }

  if (!Array.isArray(setJson.LEDI)) {
    issues.push({
      path: "set.json",
      message: "set.json must contain a LEDI array of level entries",
      severity: "error"
    });
    return [];
  }

  const entries: ParsedSetEntry[] = [];
  for (const entry of setJson.LEDI) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.Alf !== "string" ||
      typeof entry.Name !== "string"
    ) {
      issues.push({
        path: "set.json",
        message: "Each LEDI entry must contain string Alf and Name fields",
        severity: "error"
      });
      continue;
    }

    entries.push({
      Alf: entry.Alf,
      Name: entry.Name,
      Message: typeof entry.Message === "string" ? entry.Message : undefined
    });
  }

  return entries;
}

function normalizeManifest(
  manifest: Record<string, unknown>,
  setEntries: ParsedSetEntry[],
  previewPath: string | null,
  issues: UploadValidationIssue[]
): Record<string, unknown> | null {
  const title = typeof manifest.title === "string" ? manifest.title.trim() : "";
  if (!title) {
    issues.push({
      path: "manifest.json",
      message: "manifest.json must declare a non-empty title",
      severity: "error"
    });
  }

  const version = typeof manifest.version === "string" && manifest.version.trim() ? manifest.version.trim() : "1.0.0";
  const compatibilityVersion =
    typeof manifest.compatibilityVersion === "string" && manifest.compatibilityVersion.trim()
      ? manifest.compatibilityVersion.trim()
      : SUPPORTED_COMPATIBILITY_VERSION;
  if (compatibilityVersion !== SUPPORTED_COMPATIBILITY_VERSION) {
    issues.push({
      path: "manifest.json",
      message: `compatibilityVersion must be ${SUPPORTED_COMPATIBILITY_VERSION}`,
      severity: "error"
    });
  }

  const recommendedPlayers = normalizeRecommendedPlayers(manifest.recommendedPlayers);
  const normalized = {
    ...manifest,
    title,
    slug: typeof manifest.slug === "string" ? manifest.slug.trim() : createPackSlug(title || setEntries[0]?.Name || "upload"),
    description: typeof manifest.description === "string" ? manifest.description.trim() : "",
    version,
    compatibilityVersion,
    recommendedPlayers,
    previewPath,
    uploadedAt: new Date().toISOString()
  };

  return title ? normalized : null;
}

function normalizeRecommendedPlayers(value: unknown): [number, number] {
  if (
    Array.isArray(value) &&
    value.length === 2 &&
    Number.isFinite(Number(value[0])) &&
    Number.isFinite(Number(value[1]))
  ) {
    return [Math.max(1, Number(value[0])), Math.max(1, Number(value[1]))];
  }

  return [2, 8];
}

function scanTextContent(filePath: string, text: string, issues: UploadValidationIssue[]): void {
  const lower = text.toLowerCase();
  const bannedPatterns = [
    "<script",
    "javascript:",
    "eval(",
    "import(",
    "onerror=",
    "onload=",
    "process.",
    "child_process",
    "file://"
  ];

  for (const pattern of bannedPatterns) {
    if (lower.includes(pattern)) {
      issues.push({
        path: filePath,
        message: `Banned content signature detected (${pattern})`,
        severity: "error"
      });
    }
  }
}

function validateArchivePath(filePath: string, issues: UploadValidationIssue[]): void {
  if (!filePath) {
    issues.push({
      path: "/",
      message: "Archive contains an empty file path",
      severity: "error"
    });
    return;
  }

  if (filePath.startsWith("../") || filePath.includes("/../")) {
    issues.push({
      path: filePath,
      message: "Archive path escapes the package root",
      severity: "error"
    });
  }

  const segments = filePath.split("/");
  if (segments.length > 1 && !ALLOWED_TOP_LEVEL_DIRECTORIES.has(segments[0]) && segments[0] !== "manifest.json" && segments[0] !== "set.json") {
    issues.push({
      path: filePath,
      message: `Top-level directory ${segments[0]} is not allowed`,
      severity: "error"
    });
  }
}

function validateFileExtension(filePath: string, size: number, issues: UploadValidationIssue[]): void {
  const extension = path.extname(filePath).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    issues.push({
      path: filePath,
      message: `Unsupported extension ${extension || "(none)"}`,
      severity: "error"
    });
  }

  if (size > MAX_FILE_SIZE_BYTES) {
    issues.push({
      path: filePath,
      message: `File exceeds ${MAX_FILE_SIZE_BYTES / (1024 * 1024)} MB limit`,
      severity: "error"
    });
  }
}

function normalizeArchivePath(rawPath: string): string {
  const normalized = rawPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const safe = path.posix.normalize(normalized);
  if (!safe || safe === "." || safe.startsWith("../")) {
    throw new Error(`Archive contains invalid path ${rawPath}`);
  }
  return safe;
}

function shouldIgnoreArchivePath(filePath: string): boolean {
  return IGNORED_ARCHIVE_PREFIXES.some((prefix) => filePath === prefix || filePath.startsWith(prefix));
}

function createChecksum(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function guessMimeType(filePath: string): string {
  if (filePath.endsWith(".json")) {
    return "application/json";
  }
  if (filePath.endsWith(".png")) {
    return "image/png";
  }
  if (filePath.endsWith(".ogg")) {
    return "audio/ogg";
  }
  if (filePath.endsWith(".alf")) {
    return "application/xml";
  }
  return "application/octet-stream";
}

function looksLikeAlf(value: string): boolean {
  return value.includes("<") && value.includes(">") && /<(map|set|include|Wall|Ramp|Incarnator|Door|Marker)\b/.test(value);
}

function countSceneObjects(value: string): number {
  return Array.from(
    value.matchAll(/<(Wall|WallDoor|Ramp|Incarnator|Teleporter|Goody|Solid|FreeSolid|Hologram|Door|Field|Marker)\b/g)
  ).length;
}

function createPackSlug(source: string): string {
  return source
    .toLowerCase()
    .replace(/\.zip$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "upload";
}

function uniqueIssues(issues: UploadValidationIssue[]): UploadValidationIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.severity}:${issue.path}:${issue.message}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
