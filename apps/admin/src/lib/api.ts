import type {
  AdCampaign,
  AdCampaignReport,
  AuditEvent,
  DashboardStats,
  LevelPackageSummary,
  LevelSummary,
  ModerationStatus,
  OpsSnapshot,
  RoomDetail,
  UploadJob,
  UploadValidationResult
} from "@avara/shared-types";

const API_BASE_URL = resolveApiBaseUrl(import.meta.env.VITE_API_BASE_URL);

export async function fetchDashboard(): Promise<DashboardStats> {
  return apiRequest<DashboardStats>("/admin/dashboard");
}

export async function fetchLevels(): Promise<LevelSummary[]> {
  const payload = await apiRequest<{ levels: LevelSummary[] }>("/admin/levels");
  return payload.levels;
}

export async function fetchRooms(): Promise<RoomDetail[]> {
  const payload = await apiRequest<{ rooms: RoomDetail[] }>("/admin/rooms");
  return payload.rooms;
}

export async function fetchCampaigns(): Promise<AdCampaign[]> {
  const payload = await apiRequest<{ campaigns: AdCampaign[] }>("/admin/ads/campaigns");
  return payload.campaigns;
}

export async function fetchAdReports(): Promise<AdCampaignReport[]> {
  const payload = await apiRequest<{ reports: AdCampaignReport[] }>("/admin/ads/reports");
  return payload.reports;
}

export async function fetchOps(): Promise<OpsSnapshot> {
  return apiRequest<OpsSnapshot>("/admin/ops");
}

export async function fetchUploadJobs(): Promise<UploadJob[]> {
  const payload = await apiRequest<{ uploads: UploadJob[] }>("/admin/uploads");
  return payload.uploads;
}

export async function fetchAuditEvents(): Promise<AuditEvent[]> {
  const payload = await apiRequest<{ events: AuditEvent[] }>("/admin/audit");
  return payload.events;
}

export async function fetchPackages(): Promise<LevelPackageSummary[]> {
  const payload = await apiRequest<{ packages: LevelPackageSummary[] }>("/admin/packages");
  return payload.packages;
}

export async function createCampaign(payload: Partial<AdCampaign>): Promise<AdCampaign> {
  const response = await apiRequest<{ campaign: AdCampaign }>("/admin/ads/campaigns", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  return response.campaign;
}

export async function updateCampaign(campaignId: string, payload: Partial<AdCampaign>): Promise<AdCampaign> {
  const response = await apiRequest<{ campaign: AdCampaign }>(`/admin/ads/campaigns/${encodeURIComponent(campaignId)}`, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
  return response.campaign;
}

export async function uploadLevelPackage(
  file: File,
  moderationStatus: ModerationStatus
): Promise<{
  job: UploadJob;
  validation: UploadValidationResult;
  package: LevelPackageSummary | null;
  levels: LevelSummary[];
}> {
  const response = await fetch(`${API_BASE_URL}/levels/uploads`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Avara-Filename": file.name,
      "X-Avara-Level-State": moderationStatus
    },
    body: file
  });

  if (!response.ok && response.status !== 422) {
    const message = await readErrorMessage(response);
    throw new Error(message);
  }

  return (await response.json()) as {
    job: UploadJob;
    validation: UploadValidationResult;
    package: LevelPackageSummary | null;
    levels: LevelSummary[];
  };
}

export async function updateLevelModeration(levelId: string, moderationStatus: ModerationStatus): Promise<LevelSummary> {
  const payload = await apiRequest<{ level: LevelSummary }>(`/admin/levels/${encodeURIComponent(levelId)}/moderation`, {
    method: "PATCH",
    body: JSON.stringify({ moderationStatus })
  });
  return payload.level;
}

async function apiRequest<T>(pathname: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers ?? {});
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`${API_BASE_URL}${pathname}`, {
    ...init,
    headers
  });

  if (!response.ok) {
    const message = await readErrorMessage(response);
    throw new Error(message);
  }

  return (await response.json()) as T;
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: string };
    return payload.error ?? `Admin API request failed with status ${response.status}`;
  } catch {
    try {
      const text = (await response.clone().text()).trim();
      return text ? `Admin API request failed with status ${response.status}: ${text}` : `Admin API request failed with status ${response.status}`;
    } catch {
      return `Admin API request failed with status ${response.status}`;
    }
  }
}

function resolveApiBaseUrl(configuredUrl: string | undefined): string {
  const browserUrl = typeof window === "undefined" ? null : new URL(window.location.href);
  const browserHost = browserUrl?.hostname ?? "";
  const browserIsLocal = browserHost === "localhost" || browserHost === "127.0.0.1" || browserHost === "::1";

  if (configuredUrl) {
    try {
      const parsed = new URL(configuredUrl);
      const configuredIsLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
      if (!configuredIsLocal || browserIsLocal || !browserUrl) {
        return configuredUrl;
      }
    } catch {
      return configuredUrl;
    }
  }

  if (browserUrl && !browserIsLocal) {
    const labels = browserUrl.hostname.split(".");
    const baseHost = labels.length > 2 && ["api", "game", "admin", "play", "web"].includes(labels[0])
      ? labels.slice(1).join(".")
      : browserUrl.hostname;
    return `${browserUrl.protocol}//api.${baseHost}`;
  }

  return configuredUrl ?? "http://localhost:8080";
}
