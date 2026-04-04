import type { ScoutCommand, SnapshotPacket } from "@avara/shared-protocol";
import type {
  AdCampaign,
  AdEventType,
  AdPlacementType,
  Identity,
  LevelBillboardAssignment,
  LevelScene,
  LevelSummary,
  PlayerSettings,
  RoomDetail,
  RoomSummary,
  Visibility
} from "@avara/shared-types";

const API_BASE_URL = resolveServiceUrl(import.meta.env.VITE_API_BASE_URL, "api", "http://localhost:8080");
const GAME_SERVER_URL = resolveServiceUrl(import.meta.env.VITE_GAME_SERVER_URL, "game", "http://localhost:8091");
const identityStorageKey = "avara-web-player-id";
const adSessionStorageKey = "avara-web-player-ad-session";

export interface PrototypeInputState {
  moveForward: number;
  turnBody: number;
  aimYaw: number;
  aimPitch: number;
  primaryFire: boolean;
  loadMissile: boolean;
  loadGrenade: boolean;
  boost: boolean;
  crouchJump: boolean;
  toggleScoutView?: boolean;
  scoutCommand?: ScoutCommand | null;
}

export async function ensurePlayerProfile(): Promise<{ identity: Identity; settings: PlayerSettings }> {
  const identityId = window.localStorage.getItem(identityStorageKey);
  if (identityId) {
    const current = await apiRequest<{ identity: Identity; settings: PlayerSettings }>("/me", {
      headers: {
        "X-Avara-User": identityId
      }
    });

    window.localStorage.setItem(identityStorageKey, current.identity.id);
    return current;
  }

  const created = await apiRequest<{ identity: Identity; settings: PlayerSettings }>("/auth/guest", {
    method: "POST",
    body: JSON.stringify({})
  });

  window.localStorage.setItem(identityStorageKey, created.identity.id);
  return created;
}

export async function updatePlayerSettings(settings: Partial<PlayerSettings>): Promise<PlayerSettings> {
  const payload = await apiRequest<{ settings: PlayerSettings }>("/me/settings", {
    method: "PATCH",
    body: JSON.stringify(settings),
    headers: identityHeaders()
  });
  return payload.settings;
}

export async function fetchLevels(): Promise<LevelSummary[]> {
  const payload = await apiRequest<{ levels: LevelSummary[] }>("/levels");
  return payload.levels;
}

export async function fetchRooms(): Promise<RoomSummary[]> {
  const payload = await apiRequest<{ rooms: RoomSummary[] }>("/rooms", {
    headers: identityHeaders()
  });
  return payload.rooms.map(normalizeRoomUrl);
}

export async function fetchRoom(roomId: string): Promise<RoomDetail> {
  const payload = await apiRequest<{ room: RoomDetail }>(`/rooms/${encodeURIComponent(roomId)}`, {
    headers: identityHeaders()
  });
  return normalizeRoomUrl(payload.room);
}

export async function fetchRoomByInvite(inviteCode: string): Promise<RoomDetail> {
  const payload = await apiRequest<{ room: RoomDetail }>(`/rooms/by-invite/${encodeURIComponent(inviteCode)}`, {
    headers: identityHeaders()
  });
  return normalizeRoomUrl(payload.room);
}

export async function fetchLevelScene(levelId: string): Promise<{ scene: LevelScene; billboards: LevelBillboardAssignment[] }> {
  const sessionId = ensureAdSessionId();
  return apiRequest<{ scene: LevelScene; billboards: LevelBillboardAssignment[] }>(
    `/levels/${encodeURIComponent(levelId)}/scene?session=${encodeURIComponent(sessionId)}`
  );
}

export async function fetchLevelBillboards(levelId: string): Promise<LevelBillboardAssignment[]> {
  const sessionId = ensureAdSessionId();
  const payload = await apiRequest<{ levelId: string; billboards: LevelBillboardAssignment[] }>(
    `/levels/${encodeURIComponent(levelId)}/billboards?session=${encodeURIComponent(sessionId)}`
  );
  return payload.billboards;
}

export async function fetchLevelAds(levelId: string): Promise<{
  level: LevelSummary;
  ads: {
    lobby: AdCampaign[];
    loading: AdCampaign[];
    results: AdCampaign[];
  };
}> {
  const sessionId = ensureAdSessionId();
  return apiRequest<{
    level: LevelSummary;
    ads: {
      lobby: AdCampaign[];
      loading: AdCampaign[];
      results: AdCampaign[];
    };
  }>(`/levels/${encodeURIComponent(levelId)}?session=${encodeURIComponent(sessionId)}`);
}

export async function createRoom(levelId: string, name: string, visibility: Visibility): Promise<RoomDetail> {
  const payload = await apiRequest<{ room: RoomDetail }>("/rooms", {
    method: "POST",
    body: JSON.stringify({ levelId, name, visibility, playerCap: 8 }),
    headers: identityHeaders()
  });

  return normalizeRoomUrl(payload.room);
}

export async function joinRoom(roomId: string): Promise<RoomDetail> {
  const payload = await apiRequest<{ room: RoomDetail }>(`/rooms/${encodeURIComponent(roomId)}/join`, {
    method: "POST",
    body: JSON.stringify({}),
    headers: identityHeaders()
  });

  return normalizeRoomUrl(payload.room);
}

export async function joinRoomByInvite(inviteCode: string): Promise<RoomDetail> {
  const payload = await apiRequest<{ room: RoomDetail }>("/rooms/join-by-invite", {
    method: "POST",
    body: JSON.stringify({ inviteCode }),
    headers: identityHeaders()
  });

  return normalizeRoomUrl(payload.room);
}

export async function leaveRoom(roomId: string): Promise<RoomDetail> {
  const payload = await apiRequest<{ room: RoomDetail }>(`/rooms/${encodeURIComponent(roomId)}/leave`, {
    method: "POST",
    body: JSON.stringify({}),
    headers: identityHeaders()
  });

  return normalizeRoomUrl(payload.room);
}

export async function heartbeatRoom(roomId: string): Promise<RoomSummary> {
  const payload = await apiRequest<{ room: RoomSummary }>(`/rooms/${encodeURIComponent(roomId)}/heartbeat`, {
    method: "POST",
    body: JSON.stringify({}),
    headers: identityHeaders()
  });

  return normalizeRoomUrl(payload.room);
}

export async function endRoom(roomId: string): Promise<RoomDetail> {
  const payload = await apiRequest<{ room: RoomDetail }>(`/rooms/${encodeURIComponent(roomId)}/end`, {
    method: "POST",
    body: JSON.stringify({}),
    headers: identityHeaders()
  });

  return normalizeRoomUrl(payload.room);
}

export async function bootstrapPrototypeRoom(room: Pick<RoomSummary, "id" | "levelId" | "playerCap" | "gameServerUrl">): Promise<void> {
  await gameRequest(room.gameServerUrl, "/rooms/bootstrap", {
    method: "POST",
    body: JSON.stringify({
      roomId: room.id,
      levelId: room.levelId,
      maxPlayers: room.playerCap
    })
  });
}

export async function joinPrototypeRoom(
  room: Pick<RoomSummary, "id" | "gameServerUrl">,
  identity: Identity
): Promise<{ playerId: string; snapshot: SnapshotPacket }> {
  return gameRequest<{ playerId: string; snapshot: SnapshotPacket }>(room.gameServerUrl, `/rooms/${encodeURIComponent(room.id)}/join`, {
    method: "POST",
    body: JSON.stringify({
      playerId: identity.id,
      displayName: identity.displayName
    })
  });
}

export async function leavePrototypeRoom(room: Pick<RoomSummary, "id" | "gameServerUrl">, playerId: string): Promise<void> {
  await gameRequest(room.gameServerUrl, `/rooms/${encodeURIComponent(room.id)}/leave`, {
    method: "POST",
    body: JSON.stringify({ playerId })
  });
}

export async function sendPrototypeInput(
  room: Pick<RoomSummary, "id" | "gameServerUrl">,
  playerId: string,
  input: PrototypeInputState
): Promise<SnapshotPacket> {
  return gameRequest<SnapshotPacket>(room.gameServerUrl, `/rooms/${encodeURIComponent(room.id)}/input`, {
    method: "POST",
    body: JSON.stringify({
      playerId,
      ...input
    })
  });
}

export async function fetchPrototypeSnapshot(room: Pick<RoomSummary, "id" | "gameServerUrl">): Promise<SnapshotPacket> {
  return gameRequest<SnapshotPacket>(room.gameServerUrl, `/rooms/${encodeURIComponent(room.id)}/snapshot`);
}

export function resolveApiAssetUrl(assetUrl: string): string {
  if (!assetUrl) {
    return assetUrl;
  }

  try {
    const parsed = new URL(assetUrl);
    if (typeof window !== "undefined" && !isLocalHost(window.location.hostname) && isLocalHost(parsed.hostname)) {
      const apiBase = new URL(API_BASE_URL);
      parsed.protocol = apiBase.protocol;
      parsed.host = apiBase.host;
    }
    return parsed.toString();
  } catch {
    if (assetUrl.startsWith("/")) {
      return `${API_BASE_URL}${assetUrl}`;
    }
    return assetUrl;
  }
}

export async function trackAdEvent(input: {
  campaignId: string;
  placementType: AdPlacementType;
  eventType: AdEventType;
  levelId?: string;
  slotId?: string;
}): Promise<void> {
  await apiRequest("/ads/events", {
    method: "POST",
    body: JSON.stringify({
      ...input,
      sessionId: ensureAdSessionId()
    })
  });
}

export function ensureAdSessionId(): string {
  const existing = window.localStorage.getItem(adSessionStorageKey);
  if (existing) {
    return existing;
  }

  const created = `ad-session-${crypto.randomUUID()}`;
  window.localStorage.setItem(adSessionStorageKey, created);
  return created;
}

function identityHeaders(): Record<string, string> {
  const identityId = window.localStorage.getItem(identityStorageKey);
  return identityId ? { "X-Avara-User": identityId } : {};
}

async function apiRequest<T>(pathname: string, init: RequestInit = {}): Promise<T> {
  return jsonRequest<T>(`${API_BASE_URL}${pathname}`, init);
}

async function gameRequest<T>(baseUrl: string | undefined, pathname: string, init: RequestInit = {}): Promise<T> {
  const resolvedBaseUrl = resolveServiceUrl(baseUrl, "game", "http://localhost:8091");
  return jsonRequest<T>(`${resolvedBaseUrl}${pathname}`, init);
}

async function jsonRequest<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers ?? {});
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers
    });
  } catch {
    const target = new URL(url);
    throw new Error(`Cannot reach ${target.host}. Check that the service is deployed and the Coolify domain is routing correctly.`);
  }

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, url));
  }

  return (await response.json()) as T;
}

async function readErrorMessage(response: Response, url: string): Promise<string> {
  const target = new URL(url);

  try {
    const payload = (await response.json()) as { error?: string };
    if (payload.error) {
      return payload.error;
    }
  } catch {
    try {
      const text = (await response.clone().text()).trim();
      if (text) {
        return `${target.host} returned ${response.status}: ${text}`;
      }
    } catch {
      // Ignore body parsing errors and fall back to a status message.
    }
  }

  return `Request to ${target.host} failed with status ${response.status}.`;
}

function resolveServiceUrl(configuredUrl: string | undefined, service: "api" | "game", localFallback: string): string {
  const browserUrl = typeof window === "undefined" ? null : new URL(window.location.href);
  const browserHost = browserUrl?.hostname ?? "";
  const browserIsLocal = isLocalHost(browserHost);

  if (configuredUrl) {
    try {
      const parsed = new URL(configuredUrl);
      if (!isLocalHost(parsed.hostname) || browserIsLocal || !browserUrl) {
        return configuredUrl;
      }
    } catch {
      return configuredUrl;
    }
  }

  if (browserUrl && !browserIsLocal) {
    const baseHost = getBaseHost(browserUrl.hostname);
    return `${browserUrl.protocol}//${service}.${baseHost}`;
  }

  return configuredUrl ?? localFallback;
}

function normalizeRoomUrl<T extends { gameServerUrl: string }>(room: T): T {
  return {
    ...room,
    gameServerUrl: resolveServiceUrl(room.gameServerUrl, "game", "http://localhost:8091")
  };
}

function getBaseHost(hostname: string): string {
  const labels = hostname.split(".");
  if (labels.length > 2 && ["api", "game", "admin", "play", "web"].includes(labels[0])) {
    return labels.slice(1).join(".");
  }

  return hostname;
}

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}
