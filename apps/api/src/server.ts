import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { selectBillboardAssignments, selectCampaignsForPlacement } from "@avara/ads-engine";
import { prepareUploadedPackage, validateNormalizedPackage, writePreparedPackage } from "@avara/asset-pipeline";
import { createGuestIdentity, DEFAULT_PLAYER_SETTINGS } from "@avara/auth";
import { discoverLevelCatalog, parseLevelScene } from "@avara/level-parser";
import type {
  AdCampaign,
  AdCampaignReport,
  AdEventType,
  AdPlacementType,
  AuditEvent,
  DashboardStats,
  Identity,
  LevelPackageSummary,
  LevelScene,
  LevelSummary,
  ModerationStatus,
  OpsSnapshot,
  PlayerSettings,
  RateLimitSummary,
  RoomDetail,
  RoomPlayer,
  RoomSummary,
  ServiceHealthSnapshot,
  ServiceStatus,
  UploadJob
} from "@avara/shared-types";
import { log } from "@avara/telemetry";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, "../../..");
const levelsRoot = path.join(workspaceRoot, "levels");
const storageRoot = path.join(workspaceRoot, ".avara-storage");
const uploadArchiveRoot = path.join(storageRoot, "uploads");
const port = Number(process.env.PORT ?? "8080");
const matchmakerUrl = process.env.MATCHMAKER_URL ?? "http://127.0.0.1:8090";
const defaultGameServerUrl = process.env.GAME_SERVER_URL ?? "http://127.0.0.1:8091";
const roomPresenceGraceMs = Number(process.env.ROOM_PRESENCE_GRACE_SECONDS ?? "20") * 1000;
const buildVersion = process.env.BUILD_VERSION ?? "dev-local";
const startedAtIso = new Date().toISOString();

interface CampaignMetricsState {
  campaignId: string;
  campaignName: string;
  status: AdCampaign["status"];
  totalImpressions: number;
  totalClicks: number;
  uniqueSessions: Set<string>;
  lastEventAt: string | null;
  placementReports: Map<AdPlacementType, { impressions: number; clicks: number }>;
  levelReports: Map<string, { impressions: number; clicks: number }>;
}

interface RateLimitWindow {
  resetAt: number;
  count: number;
}

interface RateLimitState {
  bucket: string;
  limit: number;
  windowMs: number;
  hits: number;
  blocked: number;
  lastTriggeredAt: string | null;
  entries: Map<string, RateLimitWindow>;
}

let catalog = (await discoverLevelCatalog(levelsRoot)).map(hydrateOfficialLevelSummary);
const levelsById = new Map(catalog.map((level) => [level.id, level]));
const identities = new Map<string, Identity>();
const settingsByUserId = new Map<string, PlayerSettings>();
const levelPackages = new Map<string, LevelPackageSummary>();
const packageIdsByLevelId = new Map<string, string>();
const uploadJobs = new Map<string, UploadJob>();
const auditEvents: AuditEvent[] = [];
seedOfficialLevelPackages(catalog, levelPackages, packageIdsByLevelId);

const adCampaigns: AdCampaign[] = seedCampaigns(catalog);
const rooms = new Map<string, RoomDetail>();
const sceneCache = new Map<string, Promise<LevelScene>>();
const adReports = new Map<string, CampaignMetricsState>();
const adSessionCounts = new Map<string, number>();
const rateLimits = new Map<string, RateLimitState>();
const requestCounts = new Map<string, number>();
let totalAdImpressions = 0;
let totalAdClicks = 0;
let roomCreateCount = 0;
let roomEndCount = 0;
let inviteJoinCount = 0;
let reconnectCount = 0;
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
    recordRequestMetric(request.method ?? "GET", pathname);

    if (request.method === "GET" && pathname === "/health") {
      return sendJson(response, 200, {
        service: "api",
        status: "healthy",
        buildVersion,
        uptimeSeconds: getUptimeSeconds(),
        importedLevels: catalog.length,
        rooms: rooms.size,
        adImpressions: totalAdImpressions,
        adClicks: totalAdClicks
      });
    }

    if (request.method === "GET" && pathname === "/metrics") {
      return sendMetrics(response);
    }

    if (request.method === "GET" && pathname.startsWith("/content/")) {
      return serveContentFile(pathname, response);
    }

    if (request.method === "POST" && pathname === "/auth/guest") {
      const guestLimit = enforceRateLimit(request, "auth_guest", 6, 60_000);
      if (!guestLimit.allowed) {
        return sendJson(response, 429, { error: "Guest identity rate limit exceeded. Try again shortly." });
      }
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
        levels: catalog.filter(isLevelVisibleInBrowserCatalog),
        importedPackCount: new Set(catalog.map((level) => level.packSlug)).size
      });
    }

    if (request.method === "GET" && pathname.startsWith("/levels/") && pathname.endsWith("/scene")) {
      const levelId = decodeURIComponent(pathname.slice("/levels/".length, -"/scene".length));
      const scene = await loadLevelScene(levelId);
      const sessionId = normalizeSessionId(url.searchParams.get("session"));
      const billboards = selectBillboardAssignments(scene, filterCampaignsForSession(adCampaigns, sessionId, levelId, "level_billboard"), levelId);
      return sendJson(response, 200, {
        scene,
        billboards
      });
    }

    if (request.method === "GET" && pathname.startsWith("/levels/") && pathname.endsWith("/billboards")) {
      const levelId = decodeURIComponent(pathname.slice("/levels/".length, -"/billboards".length));
      const scene = await loadLevelScene(levelId);
      const sessionId = normalizeSessionId(url.searchParams.get("session"));
      const billboards = selectBillboardAssignments(scene, filterCampaignsForSession(adCampaigns, sessionId, levelId, "level_billboard"), levelId);
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
      const sessionId = normalizeSessionId(url.searchParams.get("session"));
      return sendJson(response, 200, {
        level,
        ads: {
          lobby: selectCampaignsForPlacement(filterCampaignsForSession(adCampaigns, sessionId, levelId, "lobby_banner"), levelId, "lobby_banner"),
          loading: selectCampaignsForPlacement(filterCampaignsForSession(adCampaigns, sessionId, levelId, "level_loading"), levelId, "level_loading"),
          results: selectCampaignsForPlacement(filterCampaignsForSession(adCampaigns, sessionId, levelId, "results_banner"), levelId, "results_banner")
        }
      });
    }

    if (request.method === "POST" && pathname === "/levels/uploads") {
      const uploadLimit = enforceRateLimit(request, "level_upload", 8, 60_000);
      if (!uploadLimit.allowed) {
        return sendJson(response, 429, { error: "Upload rate limit exceeded. Try again shortly." });
      }
      const contentType = getHeaderValue(request, "content-type") ?? "";
      if (contentType.includes("application/json")) {
        const body = await readJsonBody(request);
        const report = validateNormalizedPackage({
          manifest: body?.manifest ?? {},
          files: Array.isArray(body?.files) ? body.files : []
        });
        const job = registerLegacyValidationJob(report, Number(body?.byteSize ?? 0));
        return sendJson(response, report.ok ? 200 : 422, { job, validation: report });
      }

      const archive = await readBinaryBody(request);
      const fileName = sanitizeUploadFileName(getHeaderValue(request, "x-avara-filename") ?? "level-package.zip");
      const requestedState = normalizeUploadModerationState(getHeaderValue(request, "x-avara-level-state"));
      const prepared = prepareUploadedPackage(fileName, archive);
      const uploadedAt = new Date().toISOString();
      const jobId = `upload_${crypto.randomUUID()}`;
      const job: UploadJob = {
        id: jobId,
        fileName,
        packageId: null,
        status: prepared.validation.ok ? "validated" : "failed",
        moderationStatus: prepared.validation.ok ? requestedState : null,
        createdAt: uploadedAt,
        completedAt: uploadedAt,
        byteSize: archive.length,
        archiveChecksum: prepared.archiveChecksum,
        extractedPackSlug: null,
        levelIds: [],
        normalizedManifest: prepared.validation.normalizedManifest,
        issues: prepared.validation.issues
      };

      uploadJobs.set(job.id, job);
      recordAuditEvent({
        action: "level_upload_received",
        actorDisplayName: "Admin panel",
        actorUserId: null,
        targetType: "upload_job",
        targetId: job.id,
        payload: {
          fileName,
          byteSize: archive.length,
          requestedState
        }
      });

      if (!prepared.validation.ok || !prepared.normalizedManifest || !prepared.suggestedPackSlug) {
        recordAuditEvent({
          action: "level_upload_failed",
          actorDisplayName: "Admin panel",
          actorUserId: null,
          targetType: "upload_job",
          targetId: job.id,
          payload: {
            fileName,
            issues: prepared.validation.issues.length
          }
        });
        return sendJson(response, 422, {
          job,
          validation: prepared.validation,
          package: null,
          levels: []
        });
      }

      const packageId = `package_${crypto.randomUUID()}`;
      const packSlug = createUploadedPackSlug(prepared.suggestedPackSlug, packageId);
      const packRoot = path.join(levelsRoot, packSlug);
      const archiveRelativePath = path.join(".avara-storage", "uploads", `${packageId}.zip`);
      const archiveAbsolutePath = path.join(workspaceRoot, archiveRelativePath);
      await fs.mkdir(uploadArchiveRoot, { recursive: true });
      await fs.writeFile(archiveAbsolutePath, archive);
      await writePreparedPackage(packRoot, prepared);

      const levels = buildUploadedLevelsFromPackage({
        packSlug,
        packageId,
        moderationStatus: requestedState,
        manifest: prepared.normalizedManifest,
        levelEntries: prepared.levelEntries,
        previewPath: prepared.previewPath,
        uploadedAt
      });
      const levelPackage = createUploadedLevelPackage({
        packageId,
        packSlug,
        uploadedAt,
        uploadedBy: "Admin panel",
        moderationStatus: requestedState,
        archiveRelativePath,
        previewPath: prepared.previewPath,
        validation: prepared.validation,
        levelIds: levels.map((level) => level.id)
      });

      job.packageId = packageId;
      job.extractedPackSlug = packSlug;
      job.levelIds = levelPackage.levelIds;
      job.status = isPublishedState(requestedState) ? "published" : "validated";

      levelPackages.set(levelPackage.id, levelPackage);
      for (const level of levels) {
        upsertLevel(level);
        packageIdsByLevelId.set(level.id, packageId);
      }

      recordAuditEvent({
        action: "level_upload_validated",
        actorDisplayName: "Admin panel",
        actorUserId: null,
        targetType: "level_package",
        targetId: levelPackage.id,
        payload: {
          fileName,
          packSlug,
          moderationStatus: requestedState,
          levelCount: levels.length
        }
      });

      return sendJson(response, 201, {
        job,
        validation: prepared.validation,
        package: levelPackage,
        levels
      });
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
      const roomLimit = enforceRateLimit(request, "room_create", 10, 60_000);
      if (!roomLimit.allowed) {
        return sendJson(response, 429, { error: "Room creation rate limit exceeded. Try again shortly." });
      }
      const identity = ensureIdentity(request);
      const body = await readJsonBody(request);
      const requestedVisibility = normalizeVisibility(body?.visibility);
      const level = levelsById.get(body?.levelId) ?? catalog.find(isLevelVisibleInBrowserCatalog);
      if (!level) {
        return sendJson(response, 400, { error: "No importable levels are available" });
      }

      if (!canCreateRoomForLevel(level, requestedVisibility)) {
        return sendJson(response, 403, {
          error: "This level can only be used in private or unlisted rooms until moderation approves it"
        });
      }

      const room = await createRoom(identity, level, {
        name: body?.name,
        visibility: requestedVisibility,
        playerCap: body?.playerCap
      });
      rooms.set(room.id, room);
      roomCreateCount += 1;
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

      const wasPresent = room.players.some((player) => player.id === identity.id);
      upsertRoomPresence(room, identity);
      await touchRoomAssignment(room);
      inviteJoinCount += 1;
      if (wasPresent) {
        reconnectCount += 1;
      }
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
      const wasPresent = room.players.some((player) => player.id === identity.id);
      upsertRoomPresence(room, identity);
      await touchRoomAssignment(room);
      if (wasPresent) {
        reconnectCount += 1;
      }

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
      roomEndCount += 1;
      return sendJson(response, 200, { room });
    }

    if (request.method === "PATCH" && pathname.startsWith("/admin/levels/") && pathname.endsWith("/moderation")) {
      const levelId = decodeURIComponent(pathname.slice("/admin/levels/".length, -"/moderation".length));
      const level = levelsById.get(levelId);
      if (!level) {
        return sendJson(response, 404, { error: "Level not found" });
      }

      const body = await readJsonBody(request);
      const nextState = normalizeModerationStatus(body?.moderationStatus);
      applyModerationStateToLevel(level, nextState);
      recordAuditEvent({
        action: "level_moderation_updated",
        actorDisplayName: "Admin panel",
        actorUserId: null,
        targetType: "level",
        targetId: level.id,
        payload: {
          moderationStatus: nextState,
          packageId: level.packageId ?? null
        }
      });
      return sendJson(response, 200, { level });
    }

    if (request.method === "GET" && pathname === "/admin/dashboard") {
      const payload: DashboardStats = {
        activeUsers: identities.size || 1,
        activeRooms: rooms.size,
        matchStartsPerHour: rooms.size * 3,
        uploadQueueHealthy: Array.from(uploadJobs.values()).every((job) => job.status !== "failed"),
        uploadsPendingReview: catalog.filter(
          (level) => level.moderationStatus === "submitted" || level.moderationStatus === "private_test"
        ).length,
        adCampaignsLive: adCampaigns.filter((campaign) => campaign.status === "live").length,
        totalAdImpressions,
        totalAdClicks,
        buildVersion,
        serverHealth: "healthy",
        importedOfficialLevels: catalog.filter((level) => level.isOfficial).length
      };
      return sendJson(response, 200, payload);
    }

    if (request.method === "GET" && pathname === "/admin/levels") {
      return sendJson(response, 200, {
        levels: sortLevels(catalog)
      });
    }

    if (request.method === "GET" && pathname === "/admin/uploads") {
      return sendJson(response, 200, {
        uploads: Array.from(uploadJobs.values()).sort(
          (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)
        )
      });
    }

    if (request.method === "GET" && pathname === "/admin/packages") {
      return sendJson(response, 200, {
        packages: Array.from(levelPackages.values()).sort(
          (left, right) => Date.parse(right.uploadedAt) - Date.parse(left.uploadedAt)
        )
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
      roomEndCount += 1;
      recordAuditEvent({
        action: "room_terminated",
        actorDisplayName: "Admin panel",
        actorUserId: null,
        targetType: "room",
        targetId: room.id,
        payload: {
          roomName: room.name,
          levelId: room.levelId
        }
      });
      return sendJson(response, 200, { room });
    }

    if (request.method === "GET" && pathname === "/admin/ads/campaigns") {
      return sendJson(response, 200, { campaigns: adCampaigns });
    }

    if (request.method === "GET" && pathname === "/admin/ads/reports") {
      return sendJson(response, 200, {
        reports: buildAdReports()
      });
    }

    if (request.method === "GET" && pathname === "/admin/ops") {
      return sendJson(response, 200, await buildOpsSnapshot());
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
        frequencyCapPerSession: normalizeFrequencyCap(body?.frequencyCapPerSession),
        startAt: body?.startAt ?? new Date().toISOString(),
        endAt:
          body?.endAt ??
          new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString(),
        creativeUrl: body?.creativeUrl ?? createSvgCreative("Reserve This Slot", "#143f58", "#7de2ff", "Avara Web"),
        destinationUrl: typeof body?.destinationUrl === "string" ? body.destinationUrl : undefined
      };
      adCampaigns.push(campaign);
      recordAuditEvent({
        action: "campaign_created",
        actorDisplayName: "Admin panel",
        actorUserId: null,
        targetType: "campaign",
        targetId: campaign.id,
        payload: {
          name: campaign.name,
          status: campaign.status
        }
      });
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
        ...(body?.frequencyCapPerSession !== undefined
          ? { frequencyCapPerSession: normalizeFrequencyCap(body.frequencyCapPerSession) }
          : {}),
        ...(typeof body?.startAt === "string" ? { startAt: body.startAt } : {}),
        ...(typeof body?.endAt === "string" ? { endAt: body.endAt } : {}),
        ...(typeof body?.creativeUrl === "string" ? { creativeUrl: body.creativeUrl } : {}),
        ...(body?.destinationUrl !== undefined
          ? { destinationUrl: typeof body.destinationUrl === "string" ? body.destinationUrl : undefined }
          : {})
      });
      recordAuditEvent({
        action: "campaign_updated",
        actorDisplayName: "Admin panel",
        actorUserId: null,
        targetType: "campaign",
        targetId: campaign.id,
        payload: {
          name: campaign.name,
          status: campaign.status
        }
      });
      return sendJson(response, 200, { campaign });
    }

    if (request.method === "POST" && pathname === "/ads/events") {
      const adLimit = enforceRateLimit(request, "ads_event", 120, 60_000);
      if (!adLimit.allowed) {
        return sendJson(response, 429, { error: "Ad event rate limit exceeded. Try again shortly." });
      }

      const body = await readJsonBody(request);
      const campaignId = typeof body?.campaignId === "string" ? body.campaignId : "";
      const placementType = normalizePlacementType(body?.placementType);
      const eventType = normalizeAdEventType(body?.eventType);
      const sessionId = normalizeSessionId(body?.sessionId);
      const levelId = typeof body?.levelId === "string" ? body.levelId : undefined;
      const slotId = typeof body?.slotId === "string" ? body.slotId : undefined;
      if (!campaignId || !placementType || !eventType || !sessionId) {
        return sendJson(response, 400, { error: "campaignId, placementType, eventType, and sessionId are required" });
      }

      const campaign = adCampaigns.find((candidate) => candidate.id === campaignId);
      if (!campaign) {
        return sendJson(response, 404, { error: "Campaign not found" });
      }
      if (!campaign.placementTypes.includes(placementType)) {
        return sendJson(response, 409, { error: "Campaign is not assigned to this placement" });
      }
      if (levelId && campaign.targetLevelIds.length > 0 && !campaign.targetLevelIds.includes(levelId)) {
        return sendJson(response, 409, { error: "Campaign is not assigned to this level" });
      }

      const impressionKey = createSessionAdKey(sessionId, campaignId, placementType, levelId, undefined);
      if (eventType === "impression") {
        const priorCount = adSessionCounts.get(impressionKey) ?? 0;
        if (priorCount >= campaign.frequencyCapPerSession) {
          return sendJson(response, 200, { accepted: false, reason: "frequency_capped" });
        }
        adSessionCounts.set(impressionKey, priorCount + 1);
      }

      recordAdEvent({
        campaign,
        eventType,
        placementType,
        sessionId,
        levelId,
        slotId
      });
      return sendJson(response, 202, { accepted: true });
    }

    if (request.method === "GET" && pathname === "/admin/audit") {
      return sendJson(response, 200, {
        events: auditEvents
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
      frequencyCapPerSession: 3,
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
      frequencyCapPerSession: 3,
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
      frequencyCapPerSession: 3,
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
      frequencyCapPerSession: 3,
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

function filterCampaignsForSession(
  campaigns: AdCampaign[],
  sessionId: string | null,
  levelId: string,
  placementType: AdPlacementType
): AdCampaign[] {
  if (!sessionId) {
    return campaigns;
  }

  return campaigns.filter((campaign) => {
    const key = createSessionAdKey(sessionId, campaign.id, placementType, levelId, undefined);
    return (adSessionCounts.get(key) ?? 0) < campaign.frequencyCapPerSession;
  });
}

function recordAdEvent(input: {
  campaign: AdCampaign;
  eventType: AdEventType;
  placementType: AdPlacementType;
  sessionId: string;
  levelId?: string;
  slotId?: string;
}): void {
  const state = getOrCreateCampaignMetrics(input.campaign);
  const placement = state.placementReports.get(input.placementType) ?? { impressions: 0, clicks: 0 };
  const levelKey = input.levelId ?? "__unknown__";
  const level = state.levelReports.get(levelKey) ?? { impressions: 0, clicks: 0 };

  if (input.eventType === "impression") {
    state.totalImpressions += 1;
    totalAdImpressions += 1;
    placement.impressions += 1;
    level.impressions += 1;
  } else {
    state.totalClicks += 1;
    totalAdClicks += 1;
    placement.clicks += 1;
    level.clicks += 1;
  }

  state.uniqueSessions.add(input.sessionId);
  state.lastEventAt = new Date().toISOString();
  state.status = input.campaign.status;
  state.campaignName = input.campaign.name;
  state.placementReports.set(input.placementType, placement);
  state.levelReports.set(levelKey, level);

  log({
    service: "api",
    level: "info",
    event: "ad_event_recorded",
    payload: {
      campaignId: input.campaign.id,
      eventType: input.eventType,
      placementType: input.placementType,
      levelId: input.levelId ?? null,
      slotId: input.slotId ?? null
    }
  });
}

function getOrCreateCampaignMetrics(campaign: AdCampaign): CampaignMetricsState {
  const existing = adReports.get(campaign.id);
  if (existing) {
    return existing;
  }

  const created: CampaignMetricsState = {
    campaignId: campaign.id,
    campaignName: campaign.name,
    status: campaign.status,
    totalImpressions: 0,
    totalClicks: 0,
    uniqueSessions: new Set<string>(),
    lastEventAt: null,
    placementReports: new Map(),
    levelReports: new Map()
  };
  adReports.set(campaign.id, created);
  return created;
}

function buildAdReports(): AdCampaignReport[] {
  for (const campaign of adCampaigns) {
    const state = getOrCreateCampaignMetrics(campaign);
    state.campaignName = campaign.name;
    state.status = campaign.status;
  }

  return Array.from(adReports.values())
    .map((state) => ({
      campaignId: state.campaignId,
      campaignName: state.campaignName,
      status: state.status,
      totalImpressions: state.totalImpressions,
      totalClicks: state.totalClicks,
      uniqueSessions: state.uniqueSessions.size,
      ctr: state.totalImpressions > 0 ? state.totalClicks / state.totalImpressions : 0,
      lastEventAt: state.lastEventAt,
      placementReports: Array.from(state.placementReports.entries()).map(([placementType, metrics]) => ({
        placementType,
        impressions: metrics.impressions,
        clicks: metrics.clicks
      })),
      levelReports: Array.from(state.levelReports.entries()).map(([reportedLevelId, metrics]) => ({
        levelId: reportedLevelId,
        impressions: metrics.impressions,
        clicks: metrics.clicks
      }))
    }))
    .sort((left, right) => right.totalImpressions - left.totalImpressions || left.campaignName.localeCompare(right.campaignName));
}

async function buildOpsSnapshot(): Promise<OpsSnapshot> {
  const [matchmakerHealth, gameServerHealth] = await Promise.all([
    fetchServiceHealth("matchmaker", matchmakerUrl),
    fetchServiceHealth("game-server", defaultGameServerUrl)
  ]);

  const selfHealth: ServiceHealthSnapshot = {
    service: "api",
    status: "healthy",
    buildVersion,
    uptimeSeconds: getUptimeSeconds(),
    detail: {
      rooms: rooms.size,
      uploads: uploadJobs.size,
      campaigns: adCampaigns.length
    }
  };

  return {
    buildVersion,
    startedAt: startedAtIso,
    serviceHealth: [selfHealth, matchmakerHealth, gameServerHealth],
    rateLimits: buildRateLimitSummaries(),
    roomLifecycle: {
      created: roomCreateCount,
      ended: roomEndCount,
      inviteJoins: inviteJoinCount,
      reconnects: reconnectCount,
      active: rooms.size
    },
    adTotals: {
      impressions: totalAdImpressions,
      clicks: totalAdClicks,
      trackedCampaigns: adReports.size
    },
    backupRoot: uploadArchiveRoot,
    uploadArchiveCount: Array.from(levelPackages.values()).filter((entry) => entry.storagePath).length
  };
}

async function fetchServiceHealth(service: string, baseUrl: string): Promise<ServiceHealthSnapshot> {
  try {
    const payload = await requestJson<Record<string, unknown>>(`${baseUrl}/health`);
    const status = normalizeServiceStatus(payload.status);
    return {
      service,
      status,
      buildVersion: typeof payload.buildVersion === "string" ? payload.buildVersion : "unknown",
      uptimeSeconds: typeof payload.uptimeSeconds === "number" ? payload.uptimeSeconds : null,
      detail: payload
    };
  } catch (error) {
    return {
      service,
      status: "offline",
      buildVersion: "unreachable",
      uptimeSeconds: null,
      detail: {
        error: error instanceof Error ? error.message : String(error),
        target: baseUrl
      }
    };
  }
}

function normalizeServiceStatus(value: unknown): ServiceStatus {
  return value === "healthy" || value === "degraded" || value === "offline" ? value : "degraded";
}

function buildRateLimitSummaries(): RateLimitSummary[] {
  return Array.from(rateLimits.values())
    .map((state) => ({
      bucket: state.bucket,
      limit: state.limit,
      windowMs: state.windowMs,
      hits: state.hits,
      blocked: state.blocked,
      lastTriggeredAt: state.lastTriggeredAt
    }))
    .sort((left, right) => right.blocked - left.blocked || left.bucket.localeCompare(right.bucket));
}

function enforceRateLimit(
  request: IncomingMessage,
  bucket: string,
  limit: number,
  windowMs: number
): { allowed: boolean; remaining: number } {
  const key = getRateLimitKey(request, bucket);
  let state = rateLimits.get(bucket);
  if (!state) {
    state = {
      bucket,
      limit,
      windowMs,
      hits: 0,
      blocked: 0,
      lastTriggeredAt: null,
      entries: new Map()
    };
    rateLimits.set(bucket, state);
  }

  const now = Date.now();
  const window = state.entries.get(key);
  if (!window || window.resetAt <= now) {
    state.entries.set(key, {
      resetAt: now + windowMs,
      count: 1
    });
    state.hits += 1;
    return { allowed: true, remaining: limit - 1 };
  }

  if (window.count >= limit) {
    state.blocked += 1;
    state.lastTriggeredAt = new Date().toISOString();
    log({
      service: "api",
      level: "warn",
      event: "rate_limit_triggered",
      payload: { bucket, key }
    });
    return { allowed: false, remaining: 0 };
  }

  window.count += 1;
  state.hits += 1;
  return { allowed: true, remaining: Math.max(0, limit - window.count) };
}

function getRateLimitKey(request: IncomingMessage, bucket: string): string {
  const identityId = getIdentityIdFromRequest(request);
  const forwardedFor = getHeaderValue(request, "x-forwarded-for");
  const remoteAddress = request.socket.remoteAddress ?? "unknown";
  return `${bucket}:${identityId ?? forwardedFor ?? remoteAddress}`;
}

function recordRequestMetric(method: string, pathname: string): void {
  const normalizedPath = pathname.replace(/\/rooms\/[^/]+/g, "/rooms/:id").replace(/\/levels\/[^/]+/g, "/levels/:id");
  const key = `${method} ${normalizedPath}`;
  requestCounts.set(key, (requestCounts.get(key) ?? 0) + 1);
}

function getUptimeSeconds(): number {
  return Math.max(0, Math.round((Date.now() - Date.parse(startedAtIso)) / 1000));
}

function createSessionAdKey(
  sessionId: string,
  campaignId: string,
  placementType: AdPlacementType,
  levelId?: string,
  slotId?: string
): string {
  return [sessionId, campaignId, placementType, levelId ?? "", slotId ?? ""].join(":");
}

function seedOfficialLevelPackages(
  levels: LevelSummary[],
  packages: Map<string, LevelPackageSummary>,
  packageIndex: Map<string, string>
): void {
  const byPack = new Map<string, LevelSummary[]>();
  for (const level of levels) {
    const current = byPack.get(level.packSlug) ?? [];
    current.push(level);
    byPack.set(level.packSlug, current);
  }

  for (const [packSlug, packLevels] of byPack.entries()) {
    const packageId = `package_official_${packSlug}`;
    const uploadedAt = new Date(0).toISOString();
    const levelPackage: LevelPackageSummary = {
      id: packageId,
      slug: packSlug,
      title: packLevels[0]?.packTitle ?? packSlug,
      source: "official_repo",
      moderationStatus: "official",
      version: "repo-import",
      uploaderDisplayName: "Repo import",
      uploadedAt,
      checksum: `repo:${packSlug}`,
      fileCount: packLevels.length,
      levelIds: packLevels.map((level) => level.id),
      storagePath: null,
      previewAssetUrl: packLevels.find((level) => level.levelPreviewUrl)?.levelPreviewUrl ?? null
    };
    packages.set(packageId, levelPackage);
    for (const level of packLevels) {
      level.packageId = packageId;
      packageIndex.set(level.id, packageId);
      levelsById.set(level.id, level);
    }
  }
}

function hydrateOfficialLevelSummary(level: LevelSummary): LevelSummary {
  return {
    ...level,
    source: level.source ?? "official_repo",
    packageId: level.packageId,
    creatorName: level.creatorName ?? "Avara Legacy Import",
    uploadedAt: level.uploadedAt ?? new Date(0).toISOString(),
    publicPlayable: level.publicPlayable ?? true,
    privatePlayable: level.privatePlayable ?? true
  };
}

function createUploadedLevelPackage(input: {
  packageId: string;
  packSlug: string;
  uploadedAt: string;
  uploadedBy: string;
  moderationStatus: ModerationStatus;
  archiveRelativePath: string;
  previewPath: string | null;
  validation: ReturnType<typeof prepareUploadedPackage>["validation"];
  levelIds: string[];
}): LevelPackageSummary {
  return {
    id: input.packageId,
    slug: input.packSlug,
    title: String(input.validation.normalizedManifest?.title ?? input.packSlug),
    source: input.moderationStatus === "official" ? "promoted_upload" : "community_upload",
    moderationStatus: input.moderationStatus,
    version: String(input.validation.normalizedManifest?.version ?? "1.0.0"),
    uploaderDisplayName: input.uploadedBy,
    uploadedAt: input.uploadedAt,
    checksum: input.validation.archiveChecksum ?? input.packageId,
    fileCount: input.validation.fileCount ?? 0,
    levelIds: input.levelIds,
    storagePath: input.archiveRelativePath,
    previewAssetUrl: input.previewPath ? toContentPath(path.join(levelsRoot, input.packSlug, input.previewPath)) : null
  };
}

function buildUploadedLevelsFromPackage(input: {
  packSlug: string;
  packageId: string;
  moderationStatus: ModerationStatus;
  manifest: Record<string, unknown>;
  levelEntries: Array<{ alfPath: string; title: string; message: string }>;
  previewPath: string | null;
  uploadedAt: string;
}): LevelSummary[] {
  const packTitle = String(input.manifest.title ?? input.packSlug);
  const recommendedPlayers = Array.isArray(input.manifest.recommendedPlayers)
    ? (input.manifest.recommendedPlayers as [number, number])
    : [2, 8];
  const previewUrl = input.previewPath ? toContentPath(path.join(levelsRoot, input.packSlug, input.previewPath)) : null;

  return input.levelEntries.map((entry, index) => ({
    id: `${input.packSlug}:${entry.alfPath}`,
    slug: `${input.packSlug}-${entry.alfPath}`.replace(/[:/]/g, "-").toLowerCase(),
    title: entry.title,
    message: entry.message,
    source: input.moderationStatus === "official" ? "promoted_upload" : "community_upload",
    packSlug: input.packSlug,
    packTitle,
    packageId: input.packageId,
    alfPath: entry.alfPath,
    entryIndex: index,
    isOfficial: input.moderationStatus === "official",
    moderationStatus: input.moderationStatus,
    recommendedPlayers,
    levelPreviewUrl: previewUrl,
    sceneUrl: `/levels/${encodeURIComponent(`${input.packSlug}:${entry.alfPath}`)}/scene`,
    creatorName: "Admin panel",
    uploadedAt: input.uploadedAt,
    publicPlayable: isPublishedState(input.moderationStatus),
    privatePlayable: input.moderationStatus !== "archived" && input.moderationStatus !== "rejected"
  }));
}

function upsertLevel(level: LevelSummary): void {
  levelsById.set(level.id, level);
  const existingIndex = catalog.findIndex((entry) => entry.id === level.id);
  if (existingIndex === -1) {
    catalog.push(level);
  } else {
    catalog[existingIndex] = level;
  }
  catalog = sortLevels(catalog);
  sceneCache.delete(level.id);
}

function sortLevels(levels: LevelSummary[]): LevelSummary[] {
  return levels
    .slice()
    .sort((left, right) => {
      if (left.isOfficial !== right.isOfficial) {
        return left.isOfficial ? -1 : 1;
      }
      if (left.packTitle !== right.packTitle) {
        return left.packTitle.localeCompare(right.packTitle);
      }
      return left.title.localeCompare(right.title);
    });
}

function isLevelVisibleInBrowserCatalog(level: LevelSummary): boolean {
  return level.moderationStatus !== "rejected" && level.moderationStatus !== "archived";
}

function canCreateRoomForLevel(level: LevelSummary, visibility: RoomDetail["visibility"]): boolean {
  if (!level.privatePlayable) {
    return false;
  }
  if (visibility === "public") {
    return level.publicPlayable;
  }
  return true;
}

function isPublishedState(state: ModerationStatus): boolean {
  return state === "approved" || state === "official";
}

function applyModerationStateToLevel(level: LevelSummary, moderationStatus: ModerationStatus): void {
  level.moderationStatus = moderationStatus;
  level.isOfficial = moderationStatus === "official";
  level.source = moderationStatus === "official" ? "promoted_upload" : level.source === "official_repo" ? "official_repo" : "community_upload";
  level.publicPlayable = isPublishedState(moderationStatus) || moderationStatus === "official";
  level.privatePlayable = moderationStatus !== "archived" && moderationStatus !== "rejected";

  const packageId = level.packageId ?? packageIdsByLevelId.get(level.id);
  if (!packageId) {
    upsertLevel(level);
    return;
  }

  const pack = levelPackages.get(packageId);
  if (pack) {
    pack.moderationStatus = moderationStatus;
    pack.source = moderationStatus === "official" ? "promoted_upload" : pack.source === "official_repo" ? "official_repo" : "community_upload";
  }

  for (const candidate of catalog) {
    if (candidate.packageId === packageId) {
      candidate.moderationStatus = moderationStatus;
      candidate.isOfficial = moderationStatus === "official";
      candidate.source =
        moderationStatus === "official"
          ? "promoted_upload"
          : candidate.source === "official_repo"
            ? "official_repo"
            : "community_upload";
      candidate.publicPlayable = isPublishedState(moderationStatus) || moderationStatus === "official";
      candidate.privatePlayable = moderationStatus !== "archived" && moderationStatus !== "rejected";
      levelsById.set(candidate.id, candidate);
    }
  }

  catalog = sortLevels(catalog);
}

function normalizeModerationStatus(value: unknown): ModerationStatus {
  if (
    value === "draft" ||
    value === "private_test" ||
    value === "submitted" ||
    value === "approved" ||
    value === "rejected" ||
    value === "archived" ||
    value === "official"
  ) {
    return value;
  }

  return "submitted";
}

function normalizeUploadModerationState(value: string | undefined): ModerationStatus {
  const next = normalizeModerationStatus(value);
  return next === "draft" ? "private_test" : next;
}

function registerLegacyValidationJob(validation: ReturnType<typeof validateNormalizedPackage>, byteSize: number): UploadJob {
  const job: UploadJob = {
    id: `upload_${crypto.randomUUID()}`,
    fileName: "normalized-package.json",
    packageId: null,
    status: validation.ok ? "validated" : "failed",
    moderationStatus: null,
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    byteSize,
    archiveChecksum: null,
    extractedPackSlug: null,
    levelIds: [],
    normalizedManifest: validation.normalizedManifest,
    issues: validation.issues
  };
  uploadJobs.set(job.id, job);
  recordAuditEvent({
    action: validation.ok ? "level_upload_validated" : "level_upload_failed",
    actorDisplayName: "Admin panel",
    actorUserId: null,
    targetType: "upload_job",
    targetId: job.id,
    payload: {
      mode: "legacy_json_validation",
      issues: validation.issues.length
    }
  });
  return job;
}

function createUploadedPackSlug(suggestedPackSlug: string, packageId: string): string {
  return `_uploaded-${suggestedPackSlug}-${packageId.slice(-6).toLowerCase()}`;
}

function recordAuditEvent(input: Omit<AuditEvent, "id" | "createdAt">): void {
  auditEvents.unshift({
    ...input,
    id: `audit_${crypto.randomUUID()}`,
    createdAt: new Date().toISOString()
  });
  if (auditEvents.length > 200) {
    auditEvents.length = 200;
  }
}

function toContentPath(filePath: string): string {
  const relativePath = path.relative(workspaceRoot, filePath).split(path.sep).join("/");
  return `/content/${relativePath}`;
}

function normalizePlacementTypes(value: unknown, fallback: AdCampaign["placementTypes"]): AdCampaign["placementTypes"] {
  const filtered = normalizeStringArray(value).filter((placement): placement is AdCampaign["placementTypes"][number] =>
    ["lobby_banner", "level_loading", "results_banner", "level_billboard"].includes(placement)
  );
  return filtered.length ? filtered : fallback;
}

function normalizePlacementType(value: unknown): AdPlacementType | null {
  return value === "lobby_banner" || value === "level_loading" || value === "results_banner" || value === "level_billboard"
    ? value
    : null;
}

function normalizeAdEventType(value: unknown): AdEventType | null {
  return value === "impression" || value === "click" ? value : null;
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

function normalizeFrequencyCap(value: unknown): number {
  const numeric = Number(value ?? 3);
  return Number.isFinite(numeric) ? Math.max(1, Math.min(12, Math.round(numeric))) : 3;
}

function normalizeSessionId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length >= 6 ? trimmed.slice(0, 128) : null;
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
      level: "warn",
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

async function readBinaryBody(request: AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function getHeaderValue(request: IncomingMessage, name: string): string | undefined {
  const header = request.headers[name.toLowerCase()];
  if (Array.isArray(header)) {
    return header[0];
  }
  return typeof header === "string" ? header : undefined;
}

function sanitizeUploadFileName(value: string): string {
  const trimmed = path.basename(value.trim() || "level-package.zip");
  return trimmed.toLowerCase().endsWith(".zip") ? trimmed : `${trimmed}.zip`;
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
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Avara-User, X-Avara-Filename, X-Avara-Level-State");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
}

function sendMetrics(response: ServerResponse): void {
  const lines = [
    "# HELP avara_api_build_info Build information for the API service",
    `avara_api_build_info{version="${escapeMetricsLabel(buildVersion)}"} 1`,
    "# HELP avara_api_active_rooms Current active room count",
    `avara_api_active_rooms ${rooms.size}`,
    "# HELP avara_api_levels_total Total imported level count",
    `avara_api_levels_total ${catalog.length}`,
    "# HELP avara_api_upload_jobs_total Total upload jobs tracked",
    `avara_api_upload_jobs_total ${uploadJobs.size}`,
    "# HELP avara_api_ad_impressions_total Total ad impressions recorded",
    `avara_api_ad_impressions_total ${totalAdImpressions}`,
    "# HELP avara_api_ad_clicks_total Total ad clicks recorded",
    `avara_api_ad_clicks_total ${totalAdClicks}`,
    "# HELP avara_api_rate_limit_rejections_total Total blocked requests by rate limiting",
    `avara_api_rate_limit_rejections_total ${Array.from(rateLimits.values()).reduce((sum, state) => sum + state.blocked, 0)}`,
    "# HELP avara_api_request_total Total API requests by route",
    ...Array.from(requestCounts.entries()).map(
      ([key, count]) => `avara_api_request_total{route="${escapeMetricsLabel(key)}"} ${count}`
    )
  ];

  response.writeHead(200, {
    "Content-Type": "text/plain; version=0.0.4; charset=utf-8"
  });
  response.end(`${lines.join("\n")}\n`);
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

function escapeMetricsLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
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
