import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { selectBillboardAssignments, selectCampaignsForPlacement } from "@avara/ads-engine";
import { validateNormalizedPackage } from "@avara/asset-pipeline";
import { createGuestIdentity, DEFAULT_PLAYER_SETTINGS } from "@avara/auth";
import { discoverLevelCatalog, parseLevelScene } from "@avara/level-parser";
import type {
  AdCampaign,
  DashboardStats,
  Identity,
  LevelScene,
  LevelSummary,
  PlayerSettings,
  RoomDetail,
  RoomPlayer,
  RoomSummary
} from "@avara/shared-types";
import { log } from "@avara/telemetry";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, "../../..");
const levelsRoot = path.join(workspaceRoot, "levels");
const port = Number(process.env.PORT ?? "8080");
const matchmakerUrl = process.env.MATCHMAKER_URL ?? "http://127.0.0.1:8090";
const defaultGameServerUrl = process.env.GAME_SERVER_URL ?? "http://127.0.0.1:8091";
const roomPresenceGraceMs = Number(process.env.ROOM_PRESENCE_GRACE_SECONDS ?? "20") * 1000;

const catalog = await discoverLevelCatalog(levelsRoot);
const levelsById = new Map(catalog.map((level) => [level.id, level]));
const identities = new Map<string, Identity>();
const settingsByUserId = new Map<string, PlayerSettings>();
const uploadReports: Array<{ id: string; createdAt: string; ok: boolean; issues: number }> = [];

const adCampaigns: AdCampaign[] = seedCampaigns(catalog);
const rooms = new Map<string, RoomDetail>();
const sceneCache = new Map<string, Promise<LevelScene>>();
await seedRooms(catalog, rooms);

const server = createServer(async (request, response) => {
  try {
    setCorsHeaders(response);
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const pathname = decodeURIComponent(url.pathname);

    if (request.method === "GET" && pathname === "/health") {
      return sendJson(response, 200, {
        service: "api",
        status: "healthy",
        importedLevels: catalog.length,
        rooms: rooms.size
      });
    }

    if (request.method === "GET" && pathname.startsWith("/content/")) {
      return serveContentFile(pathname, response);
    }

    if (request.method === "POST" && pathname === "/auth/guest") {
      const body = await readJsonBody(request);
      const identity = createGuestIdentity(body?.displayName);
      identities.set(identity.id, identity);
      settingsByUserId.set(identity.id, DEFAULT_PLAYER_SETTINGS);
      return sendJson(response, 201, {
        identity,
        settings: DEFAULT_PLAYER_SETTINGS
      });
    }

    if (request.method === "GET" && pathname === "/me") {
      const identity = ensureIdentity(request);
      return sendJson(response, 200, {
        identity,
        settings: settingsByUserId.get(identity.id) ?? DEFAULT_PLAYER_SETTINGS
      });
    }

    if (request.method === "PATCH" && pathname === "/me/settings") {
      const identity = ensureIdentity(request);
      const body = await readJsonBody(request);
      const nextSettings = {
        ...DEFAULT_PLAYER_SETTINGS,
        ...(settingsByUserId.get(identity.id) ?? {}),
        ...(body ?? {})
      };
      settingsByUserId.set(identity.id, nextSettings);
      return sendJson(response, 200, { settings: nextSettings });
    }

    if (request.method === "GET" && pathname === "/levels") {
      return sendJson(response, 200, {
        levels: catalog,
        importedPackCount: new Set(catalog.map((level) => level.packSlug)).size
      });
    }

    if (request.method === "GET" && pathname.startsWith("/levels/") && pathname.endsWith("/scene")) {
      const levelId = decodeURIComponent(pathname.slice("/levels/".length, -"/scene".length));
      const scene = await loadLevelScene(levelId);
      const billboards = selectBillboardAssignments(scene, adCampaigns, levelId);
      return sendJson(response, 200, {
        scene,
        billboards
      });
    }

    if (request.method === "GET" && pathname.startsWith("/levels/") && pathname.endsWith("/billboards")) {
      const levelId = decodeURIComponent(pathname.slice("/levels/".length, -"/billboards".length));
      const scene = await loadLevelScene(levelId);
      const billboards = selectBillboardAssignments(scene, adCampaigns, levelId);
      return sendJson(response, 200, {
        levelId,
        billboards
      });
    }

    if (request.method === "GET" && pathname.startsWith("/levels/")) {
      const levelId = decodeURIComponent(pathname.slice("/levels/".length));
      const level = levelsById.get(levelId);
      if (!level) {
        return sendJson(response, 404, { error: "Level not found" });
      }
      return sendJson(response, 200, {
        level,
        ads: {
          lobby: selectCampaignsForPlacement(adCampaigns, levelId, "lobby_banner"),
          loading: selectCampaignsForPlacement(adCampaigns, levelId, "level_loading"),
          results: selectCampaignsForPlacement(adCampaigns, levelId, "results_banner")
        }
      });
    }

    if (request.method === "POST" && pathname === "/levels/uploads") {
      const body = await readJsonBody(request);
      const report = validateNormalizedPackage({
        manifest: body?.manifest ?? {},
        files: Array.isArray(body?.files) ? body.files : []
      });
      uploadReports.push({
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        ok: report.ok,
        issues: report.issues.length
      });
      return sendJson(response, report.ok ? 200 : 422, report);
    }

    if (request.method === "GET" && pathname === "/rooms") {
      pruneAllRooms();
      const identity = findIdentityFromRequest(request);
      return sendJson(response, 200, {
        rooms: Array.from(rooms.values())
          .filter((room) => isRoomVisibleTo(room, identity))
          .map(toRoomSummary)
      });
    }

    if (request.method === "POST" && pathname === "/rooms") {
      const identity = ensureIdentity(request);
      const body = await readJsonBody(request);
      const level = levelsById.get(body?.levelId) ?? catalog[0];
      if (!level) {
        return sendJson(response, 400, { error: "No importable levels are available" });
      }

      const room = await createRoom(identity, level, {
        name: body?.name,
        visibility: body?.visibility,
        playerCap: body?.playerCap
      });
      rooms.set(room.id, room);
      log({
        service: "api",
        level: "info",
        event: "room_created",
        payload: { roomId: room.id, levelId: room.levelId, ownerUserId: identity.id }
      });
      return sendJson(response, 201, { room });
    }

    if (request.method === "POST" && pathname === "/rooms/join-by-invite") {
      const identity = ensureIdentity(request);
      const body = await readJsonBody(request);
      const inviteCode = typeof body?.inviteCode === "string" ? body.inviteCode.trim().toUpperCase() : "";
      const room = resolveRoomByInviteCode(inviteCode);
      if (!room) {
        return sendJson(response, 404, { error: "Invite code not found" });
      }

      upsertRoomPresence(room, identity);
      await touchRoomAssignment(room);
      return sendJson(response, 200, { room });
    }

    if (request.method === "GET" && pathname.startsWith("/rooms/by-invite/")) {
      const inviteCode = decodeURIComponent(pathname.slice("/rooms/by-invite/".length)).trim().toUpperCase();
      const room = resolveRoomByInviteCode(inviteCode);
      if (!room) {
        return sendJson(response, 404, { error: "Invite code not found" });
      }

      return sendJson(response, 200, { room });
    }

    if (request.method === "GET" && pathname.startsWith("/rooms/")) {
      const roomId = decodeURIComponent(pathname.slice("/rooms/".length));
      const room = rooms.get(roomId);
      if (!room) {
        return sendJson(response, 404, { error: "Room not found" });
      }
      const identity = findIdentityFromRequest(request);
      if (!isRoomVisibleTo(room, identity)) {
        return sendJson(response, 403, { error: "Room is not visible to this user" });
      }
      return sendJson(response, 200, { room });
    }

    if (request.method === "POST" && pathname.endsWith("/join")) {
      const roomId = decodeURIComponent(pathname.slice("/rooms/".length, -"/join".length));
      const room = rooms.get(roomId);
      if (!room) {
        return sendJson(response, 404, { error: "Room not found" });
      }

      const identity = ensureIdentity(request);
      if (!isRoomJoinableBy(room, identity)) {
        return sendJson(response, 403, { error: "Room requires an invite" });
      }
      upsertRoomPresence(room, identity);
      await touchRoomAssignment(room);

      return sendJson(response, 200, { room });
    }

    if (request.method === "POST" && pathname.endsWith("/heartbeat")) {
      const roomId = decodeURIComponent(pathname.slice("/rooms/".length, -"/heartbeat".length));
      const room = rooms.get(roomId);
      if (!room) {
        return sendJson(response, 404, { error: "Room not found" });
      }

      const identity = ensureIdentity(request);
      upsertRoomPresence(room, identity);
      await touchRoomAssignment(room);
      return sendJson(response, 200, { room: toRoomSummary(room) });
    }

    if (request.method === "POST" && pathname.endsWith("/leave")) {
      const roomId = decodeURIComponent(pathname.slice("/rooms/".length, -"/leave".length));
      const room = rooms.get(roomId);
      if (!room) {
        return sendJson(response, 404, { error: "Room not found" });
      }

      const identity = ensureIdentity(request);
      room.players = room.players.filter((player) => player.id !== identity.id);
      syncRoomCounts(room);
      return sendJson(response, 200, { room });
    }

    if (request.method === "POST" && pathname.endsWith("/end")) {
      const roomId = decodeURIComponent(pathname.slice("/rooms/".length, -"/end".length));
      const room = rooms.get(roomId);
      if (!room) {
        return sendJson(response, 404, { error: "Room not found" });
      }

      const identity = ensureIdentity(request);
      if (room.ownerUserId !== identity.id) {
        return sendJson(response, 403, { error: "Only the room host can end this room" });
      }

      room.status = "ended";
      await terminateGameWorkerRoom(room);
      await releaseRoomAssignment(room.id);
      syncRoomCounts(room);
      return sendJson(response, 200, { room });
    }

    if (request.method === "POST" && pathname.startsWith("/admin/levels/") && pathname.endsWith("/approve")) {
      const levelId = decodeURIComponent(pathname.slice("/admin/levels/".length, -"/approve".length));
      const level = levelsById.get(levelId);
      if (!level) {
        return sendJson(response, 404, { error: "Level not found" });
      }
      level.moderationStatus = "approved";
      return sendJson(response, 200, { level });
    }

    if (request.method === "POST" && pathname.startsWith("/admin/levels/") && pathname.endsWith("/reject")) {
      const levelId = decodeURIComponent(pathname.slice("/admin/levels/".length, -"/reject".length));
      const level = levelsById.get(levelId);
      if (!level) {
        return sendJson(response, 404, { error: "Level not found" });
      }
      level.moderationStatus = "rejected";
      return sendJson(response, 200, { level });
    }

    if (request.method === "GET" && pathname === "/admin/dashboard") {
      const payload: DashboardStats = {
        activeUsers: identities.size || 1,
        activeRooms: rooms.size,
        matchStartsPerHour: rooms.size * 3,
        uploadQueueHealthy: uploadReports.every((report) => report.ok),
        adCampaignsLive: adCampaigns.filter((campaign) => campaign.status === "live").length,
        serverHealth: "healthy",
        importedOfficialLevels: catalog.length
      };
      return sendJson(response, 200, payload);
    }

    if (request.method === "GET" && pathname === "/admin/levels") {
      return sendJson(response, 200, {
        levels: catalog
      });
    }

    if (request.method === "GET" && pathname === "/admin/rooms") {
      pruneAllRooms();
      return sendJson(response, 200, {
        rooms: Array.from(rooms.values())
      });
    }

    if (request.method === "POST" && pathname.startsWith("/admin/rooms/") && pathname.endsWith("/terminate")) {
      const roomId = decodeURIComponent(pathname.slice("/admin/rooms/".length, -"/terminate".length));
      const room = rooms.get(roomId);
      if (!room) {
        return sendJson(response, 404, { error: "Room not found" });
      }
      room.status = "ended";
      await terminateGameWorkerRoom(room);
      await releaseRoomAssignment(room.id);
      syncRoomCounts(room);
      return sendJson(response, 200, { room });
    }

    if (request.method === "GET" && pathname === "/admin/ads/campaigns") {
      return sendJson(response, 200, { campaigns: adCampaigns });
    }

    if (request.method === "POST" && pathname === "/admin/ads/campaigns") {
      const body = await readJsonBody(request);
      const campaign: AdCampaign = {
        id: `campaign_${crypto.randomUUID()}`,
        name: body?.name ?? "New campaign",
        status: body?.status ?? "draft",
        placementTypes: normalizePlacementTypes(body?.placementTypes, ["level_billboard"]),
        targetLevelIds: normalizeStringArray(body?.targetLevelIds),
        billboardSlotIds: normalizeStringArray(body?.billboardSlotIds),
        priority: Number(body?.priority ?? 1),
        rotationSeconds: normalizeRotationSeconds(body?.rotationSeconds),
        startAt: body?.startAt ?? new Date().toISOString(),
        endAt:
          body?.endAt ??
          new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString(),
        creativeUrl: body?.creativeUrl ?? createSvgCreative("Reserve This Slot", "#143f58", "#7de2ff", "Avara Web"),
        destinationUrl: typeof body?.destinationUrl === "string" ? body.destinationUrl : undefined
      };
      adCampaigns.push(campaign);
      return sendJson(response, 201, { campaign });
    }

    if (request.method === "PATCH" && pathname.startsWith("/admin/ads/campaigns/")) {
      const campaignId = decodeURIComponent(pathname.slice("/admin/ads/campaigns/".length));
      const campaign = adCampaigns.find((candidate) => candidate.id === campaignId);
      if (!campaign) {
        return sendJson(response, 404, { error: "Campaign not found" });
      }

      const body = await readJsonBody(request);
      Object.assign(campaign, {
        ...(typeof body?.name === "string" ? { name: body.name } : {}),
        ...(typeof body?.status === "string" ? { status: body.status } : {}),
        ...(body?.placementTypes ? { placementTypes: normalizePlacementTypes(body.placementTypes, campaign.placementTypes) } : {}),
        ...(body?.targetLevelIds ? { targetLevelIds: normalizeStringArray(body.targetLevelIds) } : {}),
        ...(body?.billboardSlotIds ? { billboardSlotIds: normalizeStringArray(body.billboardSlotIds) } : {}),
        ...(body?.priority !== undefined ? { priority: Number(body.priority ?? campaign.priority) } : {}),
        ...(body?.rotationSeconds !== undefined
          ? { rotationSeconds: normalizeRotationSeconds(body.rotationSeconds) }
          : {}),
        ...(typeof body?.startAt === "string" ? { startAt: body.startAt } : {}),
        ...(typeof body?.endAt === "string" ? { endAt: body.endAt } : {}),
        ...(typeof body?.creativeUrl === "string" ? { creativeUrl: body.creativeUrl } : {}),
        ...(body?.destinationUrl !== undefined
          ? { destinationUrl: typeof body.destinationUrl === "string" ? body.destinationUrl : undefined }
          : {})
      });
      return sendJson(response, 200, { campaign });
    }

    if (request.method === "GET" && pathname === "/admin/audit") {
      return sendJson(response, 200, {
        events: uploadReports.map((report) => ({
          id: report.id,
          action: report.ok ? "level_upload_validated" : "level_upload_rejected",
          createdAt: report.createdAt,
          payload: report
        }))
      });
    }

    return sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    log({
      service: "api",
      level: "error",
      event: "request_failed",
      payload: { message: error instanceof Error ? error.message : String(error) }
    });
    return sendJson(response, 500, {
      error: error instanceof Error ? error.message : "Unknown server error"
    });
  }
});

server.listen(port, () => {
  log({
    service: "api",
    level: "info",
    event: "server_started",
    payload: {
      port,
      importedLevels: catalog.length
    }
  });
});

function ensureIdentity(request: IncomingMessage): Identity {
  const identityId = getIdentityIdFromRequest(request);

  if (identityId && identities.has(identityId)) {
    return identities.get(identityId)!;
  }

  const identity = createGuestIdentity();
  identities.set(identity.id, identity);
  settingsByUserId.set(identity.id, DEFAULT_PLAYER_SETTINGS);
  return identity;
}

function findIdentityFromRequest(request: IncomingMessage): Identity | null {
  const identityId = getIdentityIdFromRequest(request);
  if (!identityId) {
    return null;
  }

  return identities.get(identityId) ?? null;
}

async function createRoom(
  identity: Identity,
  level: LevelSummary,
  options?: { name?: string; visibility?: string; playerCap?: number }
): Promise<RoomDetail> {
  const roomId = `room_${crypto.randomUUID()}`;
  const playerCap = clampPlayerCap(options?.playerCap);
  const assignment = await assignRoomToWorker(roomId, playerCap);
  const host: RoomPlayer = {
    id: identity.id,
    displayName: identity.displayName,
    joinedAt: new Date().toISOString(),
    isHost: true,
    isGuest: identity.guest,
    lastSeenAt: new Date().toISOString(),
    connectionState: "connected"
  };

  return {
    id: roomId,
    name: options?.name?.trim() || `${level.title} Room`,
    inviteCode: roomId.slice(-6).toUpperCase(),
    invitePath: `/?invite=${encodeURIComponent(roomId.slice(-6).toUpperCase())}`,
    visibility: normalizeVisibility(options?.visibility),
    status: "waiting",
    levelId: level.id,
    levelTitle: level.title,
    playerCap,
    currentPlayers: 1,
    spectatorEnabled: true,
    friendlyFire: false,
    timeLimitMinutes: 10,
    estimatedPingMs: 32,
    createdAt: new Date().toISOString(),
    ownerUserId: identity.id,
    gameWorkerId: assignment.workerId,
    gameServerUrl: assignment.gameServerUrl,
    players: [host],
    chatEnabled: true
  };
}

function toRoomSummary(room: RoomDetail): RoomSummary {
  return {
    id: room.id,
    name: room.name,
    inviteCode: room.inviteCode,
    visibility: room.visibility,
    status: room.status,
    levelId: room.levelId,
    levelTitle: room.levelTitle,
    playerCap: room.playerCap,
    currentPlayers: room.players.length,
    spectatorEnabled: room.spectatorEnabled,
    friendlyFire: room.friendlyFire,
    timeLimitMinutes: room.timeLimitMinutes,
    estimatedPingMs: room.estimatedPingMs,
    createdAt: room.createdAt,
    ownerUserId: room.ownerUserId,
    gameWorkerId: room.gameWorkerId,
    gameServerUrl: room.gameServerUrl,
    invitePath: room.invitePath
  };
}

async function seedRooms(levels: LevelSummary[], roomMap: Map<string, RoomDetail>): Promise<void> {
  const featuredLevels = [levels[0], levels.find((level) => level.id.endsWith("bwadi.alf")) ?? levels[1]].filter(
    Boolean
  ) as LevelSummary[];
  for (const [index, level] of featuredLevels.entries()) {
    const owner = createGuestIdentity(index === 0 ? "Marshal" : "Sentinel");
    identities.set(owner.id, owner);
    settingsByUserId.set(owner.id, DEFAULT_PLAYER_SETTINGS);
    const room = await createRoom(owner, level, {
      name: index === 0 ? "Classic Rotation" : "Bwadi Practice",
      visibility: "public",
      playerCap: 8
    });
    room.status = index === 0 ? "active" : "waiting";
    room.players.push({
      id: createGuestIdentity("Spectator-1").id,
      displayName: "Scout-Unit",
      joinedAt: new Date().toISOString(),
      isHost: false,
      isGuest: true,
      lastSeenAt: new Date().toISOString(),
      connectionState: "connected"
    });
    syncRoomCounts(room);
    roomMap.set(room.id, room);
  }
}

function seedCampaigns(levels: LevelSummary[]): AdCampaign[] {
  const featuredLevelId = levels.find((level) => level.id.endsWith("bwadi.alf"))?.id ?? levels[0]?.id ?? "";
  const now = new Date();
  const nextMonth = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 30);
  return [
    {
      id: "campaign_billboard_north_1",
      name: "Ion Freight Lines",
      status: "live",
      placementTypes: ["level_billboard"],
      targetLevelIds: featuredLevelId ? [featuredLevelId] : [],
      billboardSlotIds: ["bwadi-north"],
      priority: 10,
      rotationSeconds: 12,
      startAt: now.toISOString(),
      endAt: nextMonth.toISOString(),
      creativeUrl: createSvgCreative("ION", "#123756", "#7de2ff", "Freight lines for the outer rim"),
      destinationUrl: "https://avara.invalid/campaigns/ion"
    },
    {
      id: "campaign_billboard_north_2",
      name: "Pilot's Choice Cup",
      status: "live",
      placementTypes: ["level_billboard"],
      targetLevelIds: featuredLevelId ? [featuredLevelId] : [],
      billboardSlotIds: ["bwadi-north"],
      priority: 10,
      rotationSeconds: 12,
      startAt: now.toISOString(),
      endAt: nextMonth.toISOString(),
      creativeUrl: createSvgCreative("CUP", "#593116", "#ffbe69", "Refuel before the next frag"),
      destinationUrl: "https://avara.invalid/campaigns/cup"
    },
    {
      id: "campaign_billboard_south_1",
      name: "Meridian Armor",
      status: "live",
      placementTypes: ["level_billboard"],
      targetLevelIds: featuredLevelId ? [featuredLevelId] : [],
      billboardSlotIds: ["bwadi-south"],
      priority: 9,
      rotationSeconds: 18,
      startAt: now.toISOString(),
      endAt: nextMonth.toISOString(),
      creativeUrl: createSvgCreative("MERIDIAN", "#22312b", "#87f0bf", "Hull plates built for impact"),
      destinationUrl: "https://avara.invalid/campaigns/meridian"
    },
    {
      id: "campaign_billboard_south_2",
      name: "Vector Relay",
      status: "live",
      placementTypes: ["level_billboard"],
      targetLevelIds: featuredLevelId ? [featuredLevelId] : [],
      billboardSlotIds: ["bwadi-south"],
      priority: 9,
      rotationSeconds: 18,
      startAt: now.toISOString(),
      endAt: nextMonth.toISOString(),
      creativeUrl: createSvgCreative("VECTOR", "#3b143c", "#e0a7ff", "Faster comms across contested sectors"),
      destinationUrl: "https://avara.invalid/campaigns/vector"
    }
  ];
}

function loadLevelScene(levelId: string): Promise<LevelScene> {
  const cached = sceneCache.get(levelId);
  if (cached) {
    return cached;
  }

  const nextScene = parseLevelScene(levelsRoot, levelId);
  sceneCache.set(levelId, nextScene);
  return nextScene;
}

function normalizePlacementTypes(value: unknown, fallback: AdCampaign["placementTypes"]): AdCampaign["placementTypes"] {
  const filtered = normalizeStringArray(value).filter((placement): placement is AdCampaign["placementTypes"][number] =>
    ["lobby_banner", "level_loading", "results_banner", "level_billboard"].includes(placement)
  );
  return filtered.length ? filtered : fallback;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeRotationSeconds(value: unknown): number {
  const numeric = Number(value ?? 30);
  return Number.isFinite(numeric) ? Math.max(5, Math.round(numeric)) : 30;
}

function createSvgCreative(title: string, background: string, accent: string, subtitle: string): string {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="1024" height="512" viewBox="0 0 1024 512">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${background}" />
          <stop offset="100%" stop-color="#090d14" />
        </linearGradient>
      </defs>
      <rect width="1024" height="512" rx="36" fill="url(#bg)" />
      <rect x="44" y="44" width="936" height="424" rx="28" fill="none" stroke="${accent}" stroke-width="10" />
      <circle cx="840" cy="142" r="84" fill="${accent}" fill-opacity="0.14" />
      <path d="M108 356 L394 132 L536 246 L724 118" stroke="${accent}" stroke-width="18" fill="none" stroke-linecap="round" />
      <text x="96" y="208" fill="#f5f7fb" font-family="Avenir Next, Futura, sans-serif" font-size="118" font-weight="700">${escapeXml(
        title
      )}</text>
      <text x="100" y="308" fill="${accent}" font-family="Avenir Next, Futura, sans-serif" font-size="34" letter-spacing="8">${escapeXml(
        subtitle.toUpperCase()
      )}</text>
    </svg>
  `.trim();

  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function assignRoomToWorker(roomId: string, playerCap: number) {
  try {
    return await requestJson<{ roomId: string; workerId: string; gameServerUrl: string }>(`${matchmakerUrl}/assign-room`, {
      method: "POST",
      body: JSON.stringify({ roomId, playerCap }),
      headers: {
        "Content-Type": "application/json"
      }
    });
  } catch (error) {
    log({
      service: "api",
      level: "warning",
      event: "matchmaker_assignment_failed",
      payload: { roomId, message: error instanceof Error ? error.message : String(error) }
    });
    return {
      roomId,
      workerId: "game-worker-fallback",
      gameServerUrl: defaultGameServerUrl
    };
  }
}

async function touchRoomAssignment(room: RoomSummary): Promise<void> {
  if (room.gameWorkerId === "game-worker-fallback") {
    return;
  }

  try {
    await requestJson(`${matchmakerUrl}/rooms/${encodeURIComponent(room.id)}/touch`, {
      method: "POST"
    });
  } catch {
    return;
  }
}

async function releaseRoomAssignment(roomId: string): Promise<void> {
  try {
    await requestJson(`${matchmakerUrl}/rooms/${encodeURIComponent(roomId)}/release`, {
      method: "POST"
    });
  } catch {
    return;
  }
}

async function terminateGameWorkerRoom(room: RoomSummary): Promise<void> {
  try {
    await requestJson(`${room.gameServerUrl}/rooms/${encodeURIComponent(room.id)}/terminate`, {
      method: "POST"
    });
  } catch {
    return;
  }
}

async function requestJson<T = unknown>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }

  return (await response.json()) as T;
}

async function readJsonBody(request: AsyncIterable<Buffer>): Promise<Record<string, any> | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return null;
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function serveContentFile(pathname: string, response: ServerResponse) {
  const relativePath = pathname.replace(/^\/content\//, "");
  const targetPath = path.resolve(workspaceRoot, relativePath);
  if (!targetPath.startsWith(workspaceRoot)) {
    return sendJson(response, 403, { error: "Forbidden" });
  }

  try {
    const buffer = await fs.readFile(targetPath);
    response.writeHead(200, {
      "Content-Type": guessContentType(targetPath),
      "Cache-Control": "public, max-age=3600"
    });
    response.end(buffer);
  } catch {
    return sendJson(response, 404, { error: "Asset not found" });
  }
}

function guessContentType(filePath: string): string {
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

function setCorsHeaders(response: { setHeader(name: string, value: string): void }): void {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Avara-User");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
}

function sendJson(
  response: {
    writeHead(statusCode: number, headers: Record<string, string>): void;
    end(body: string): void;
  },
  statusCode: number,
  payload: unknown
): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload, null, 2));
}

function syncRoomCounts(room: RoomDetail): void {
  pruneRoomPlayers(room);
  room.currentPlayers = room.players.length;
  if (room.currentPlayers === 0 && room.status !== "ended") {
    room.status = "waiting";
  }
}

function isRoomVisibleTo(room: RoomDetail, identity: Identity | null): boolean {
  pruneRoomPlayers(room);
  if (room.visibility === "public") {
    return true;
  }

  if (!identity) {
    return false;
  }

  if (room.ownerUserId === identity.id) {
    return true;
  }

  return room.players.some((player) => player.id === identity.id);
}

function isRoomJoinableBy(room: RoomDetail, identity: Identity): boolean {
  if (room.visibility === "public") {
    return true;
  }

  if (room.ownerUserId === identity.id) {
    return true;
  }

  return room.players.some((player) => player.id === identity.id);
}

function resolveRoomByInviteCode(inviteCode: string): RoomDetail | undefined {
  if (!inviteCode) {
    return undefined;
  }

  return Array.from(rooms.values()).find((room) => room.inviteCode === inviteCode);
}

function upsertRoomPresence(room: RoomDetail, identity: Identity): void {
  pruneRoomPlayers(room);
  const existing = room.players.find((player) => player.id === identity.id);
  if (existing) {
    existing.displayName = identity.displayName;
    existing.lastSeenAt = new Date().toISOString();
    existing.connectionState = "connected";
    syncRoomCounts(room);
    if (room.status !== "ended") {
      room.status = "active";
    }
    return;
  }

  room.players.push({
    id: identity.id,
    displayName: identity.displayName,
    joinedAt: new Date().toISOString(),
    isHost: false,
    isGuest: identity.guest,
    lastSeenAt: new Date().toISOString(),
    connectionState: "connected"
  });
  syncRoomCounts(room);
  if (room.status !== "ended") {
    room.status = "active";
  }
}

function pruneAllRooms(): void {
  for (const room of rooms.values()) {
    pruneRoomPlayers(room);
  }
}

function pruneRoomPlayers(room: RoomDetail): void {
  const cutoff = Date.now() - roomPresenceGraceMs;
  room.players = room.players.filter((player) => {
    const lastSeenAt = player.lastSeenAt ? Date.parse(player.lastSeenAt) : Date.parse(player.joinedAt);
    return Number.isFinite(lastSeenAt) ? lastSeenAt >= cutoff : true;
  });
  room.currentPlayers = room.players.length;
}

function getIdentityIdFromRequest(request: IncomingMessage): string | undefined {
  const identityId = Array.isArray(request.headers["x-avara-user"])
    ? request.headers["x-avara-user"][0]
    : request.headers["x-avara-user"];
  return typeof identityId === "string" ? identityId : undefined;
}

function clampPlayerCap(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 8;
  }

  return Math.max(1, Math.min(8, Math.floor(value)));
}

function normalizeVisibility(value: string | undefined): RoomDetail["visibility"] {
  if (value === "private" || value === "unlisted") {
    return value;
  }

  return "public";
}
