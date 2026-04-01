import type { UploadValidationIssue, UploadValidationResult } from "@avara/shared-types";

const ALLOWED_EXTENSIONS = new Set([".json", ".alf", ".ogg", ".png"]);
const MAX_TOTAL_SIZE_BYTES = 64 * 1024 * 1024;
const MAX_FILE_SIZE_BYTES = 16 * 1024 * 1024;

export interface PackageCandidateFile {
  path: string;
  size: number;
  mimeType?: string;
}

export interface PackageCandidate {
  manifest: Record<string, unknown>;
  files: PackageCandidateFile[];
}

export function validateNormalizedPackage(candidate: PackageCandidate): UploadValidationResult {
  const issues: UploadValidationIssue[] = [];
  const totalSize = candidate.files.reduce((sum, file) => sum + file.size, 0);

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
    const extension = file.path.slice(file.path.lastIndexOf("."));
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      issues.push({
        path: file.path,
        message: `Unsupported extension ${extension || "(none)"}`,
        severity: "error"
      });
    }

    if (file.size > MAX_FILE_SIZE_BYTES) {
      issues.push({
        path: file.path,
        message: `File exceeds ${MAX_FILE_SIZE_BYTES / (1024 * 1024)} MB limit`,
        severity: "error"
      });
    }
  }

  const normalizedManifest = {
    ...candidate.manifest,
    compatibilityVersion: candidate.manifest.compatibilityVersion ?? "web-mvp",
    uploadedAt: new Date().toISOString()
  };

  return {
    ok: issues.every((issue) => issue.severity !== "error"),
    normalizedManifest,
    issues
  };
}
