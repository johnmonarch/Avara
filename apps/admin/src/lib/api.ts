import type { AdCampaign, DashboardStats, LevelSummary, RoomDetail, UploadValidationResult } from "@avara/shared-types";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8080";

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

export async function validateUploadCandidate(): Promise<UploadValidationResult> {
  return apiRequest<UploadValidationResult>("/levels/uploads", {
    method: "POST",
    body: JSON.stringify({
      manifest: {
        title: "Browser Upload Candidate",
        version: "1.0.0"
      },
      files: [
        { path: "manifest.json", size: 812 },
        { path: "set.json", size: 3120 },
        { path: "alf/arena.alf", size: 18560 },
        { path: "audio/intro.ogg", size: 264000 }
      ]
    })
  });
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
    throw new Error(`Admin API request failed with status ${response.status}`);
  }

  return (await response.json()) as T;
}
