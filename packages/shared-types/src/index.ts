export type UserRole =
  | "guest"
  | "registered"
  | "super_admin"
  | "content_admin"
  | "moderator"
  | "ops_viewer";

export type Visibility = "public" | "private" | "unlisted";
export type RoomStatus = "warming" | "waiting" | "active" | "ended";
export type LevelSource = "official_repo" | "community_upload" | "promoted_upload";
export type ModerationStatus =
  | "draft"
  | "private_test"
  | "submitted"
  | "approved"
  | "rejected"
  | "archived"
  | "official";

export type AdPlacementType =
  | "lobby_banner"
  | "level_loading"
  | "results_banner"
  | "level_billboard";

export type AdEventType = "impression" | "click";
export type ServiceStatus = "healthy" | "degraded" | "offline";

export interface Identity {
  id: string;
  displayName: string;
  role: UserRole;
  guest: boolean;
  createdAt: string;
}

export interface ControlPreset {
  id: "classic" | "modernized";
  label: string;
  description: string;
}

export type GraphicsQuality = "performance" | "balanced" | "quality";

export interface PlayerSettings {
  controlPreset: ControlPreset["id"];
  sensitivity: number;
  invertY: boolean;
  graphicsQuality: GraphicsQuality;
  showPerformanceHud: boolean;
}

export interface RoomPlayer {
  id: string;
  displayName: string;
  joinedAt: string;
  isHost: boolean;
  isGuest: boolean;
  lastSeenAt?: string;
  connectionState?: "connected" | "reconnecting";
}

export interface LevelSummary {
  id: string;
  slug: string;
  title: string;
  message: string;
  source: LevelSource;
  packSlug: string;
  packTitle: string;
  packageId?: string;
  alfPath: string;
  entryIndex: number;
  isOfficial: boolean;
  moderationStatus: ModerationStatus;
  recommendedPlayers: [number, number];
  levelPreviewUrl: string | null;
  sceneUrl: string;
  creatorName?: string;
  uploadedAt?: string;
  publicPlayable: boolean;
  privatePlayable: boolean;
}

export interface SceneEnvironment {
  skyColors: string[];
  groundColor: string;
}

export interface SceneSound {
  soundId: number;
  assetUrl?: string;
  volume: number;
  loop: boolean;
  position?: { x: number; y: number; z: number };
}

export interface SceneSoundscape {
  ambient: SceneSound[];
}

export interface SceneLocalBounds {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

export type SceneNodeType =
  | "wall"
  | "ramp"
  | "shape"
  | "spawn"
  | "teleporter"
  | "goody"
  | "field"
  | "door"
  | "marker"
  | "ad_placeholder";

export interface SceneNode {
  id: string;
  type: SceneNodeType;
  actorClass: string;
  position: { x: number; y: number; z: number };
  size?: { width: number; height: number; depth: number };
  rotation?: { pitch: number; yaw: number; roll: number };
  scale?: number;
  localBounds?: SceneLocalBounds;
  color?: string;
  accentColor?: string;
  shapeId?: number;
  shapeKey?: string;
  shapeAssetUrl?: string;
  slotId?: string;
  meta?: Record<string, unknown>;
}

export interface LevelScene {
  id: string;
  title: string;
  packSlug: string;
  entryPath: string;
  environment: SceneEnvironment;
  soundscape: SceneSoundscape;
  settings: LevelSimulationSettings;
  nodes: SceneNode[];
}

export interface HullSimulationSettings {
  resourceId: number;
  shapeId: number;
  maxMissiles: number;
  maxGrenades: number;
  maxBoosters: number;
  mass: number;
  energyRatio: number;
  energyChargeRatio: number;
  shieldsRatio: number;
  shieldsChargeRatio: number;
  minShotRatio: number;
  maxShotRatio: number;
  shotChargeRatio: number;
  rideHeight: number;
  accelerationRatio: number;
  jumpPowerRatio: number;
}

export interface LevelSimulationSettings {
  gravity: number;
  defaultTraction: number;
  defaultFriction: number;
  grenadePower: number;
  missilePower: number;
  missileTurnRate: number;
  missileAcceleration: number;
  maxStartGrenades: number;
  maxStartMissiles: number;
  maxStartBoosts: number;
  defaultLives: number;
  incarnateSoundId: number;
  incarnateSoundUrl?: string;
  incarnateVolume: number;
  blastSoundDefaultId: number;
  blastSoundDefaultUrl?: string;
  defaultHull: HullSimulationSettings;
}

export interface RoomSummary {
  id: string;
  name: string;
  inviteCode: string;
  invitePath?: string;
  visibility: Visibility;
  status: RoomStatus;
  levelId: string;
  levelTitle: string;
  playerCap: number;
  currentPlayers: number;
  spectatorEnabled: boolean;
  friendlyFire: boolean;
  timeLimitMinutes: number;
  estimatedPingMs: number;
  createdAt: string;
  ownerUserId: string;
  gameWorkerId: string;
  gameServerUrl: string;
}

export interface RoomDetail extends RoomSummary {
  players: RoomPlayer[];
  chatEnabled: boolean;
}

export interface DashboardStats {
  activeUsers: number;
  activeRooms: number;
  matchStartsPerHour: number;
  uploadQueueHealthy: boolean;
  uploadsPendingReview: number;
  adCampaignsLive: number;
  totalAdImpressions: number;
  totalAdClicks: number;
  buildVersion: string;
  serverHealth: ServiceStatus;
  importedOfficialLevels: number;
}

export interface AdCampaign {
  id: string;
  name: string;
  status: "draft" | "live" | "paused" | "ended";
  placementTypes: AdPlacementType[];
  targetLevelIds: string[];
  billboardSlotIds: string[];
  priority: number;
  rotationSeconds: number;
  frequencyCapPerSession: number;
  startAt: string;
  endAt: string;
  creativeUrl: string;
  destinationUrl?: string;
}

export interface LevelBillboardAssignment {
  nodeId: string;
  slotId: string;
  campaignId: string | null;
  campaignName: string | null;
  creativeUrl: string | null;
  destinationUrl: string | null;
  rotationSeconds: number;
}

export interface UploadValidationIssue {
  path: string;
  message: string;
  severity: "error" | "warning";
}

export interface UploadValidationResult {
  ok: boolean;
  normalizedManifest: Record<string, unknown> | null;
  issues: UploadValidationIssue[];
  archiveChecksum?: string;
  fileCount?: number;
  totalBytes?: number;
  suggestedPackSlug?: string | null;
  previewPath?: string | null;
  levelEntries?: Array<{
    alfPath: string;
    title: string;
    message: string;
  }>;
}

export interface UploadJob {
  id: string;
  fileName: string;
  packageId: string | null;
  status: "processing" | "validated" | "failed" | "published";
  moderationStatus: ModerationStatus | null;
  createdAt: string;
  completedAt: string | null;
  byteSize: number;
  archiveChecksum: string | null;
  extractedPackSlug: string | null;
  levelIds: string[];
  normalizedManifest: Record<string, unknown> | null;
  issues: UploadValidationIssue[];
}

export interface LevelPackageSummary {
  id: string;
  slug: string;
  title: string;
  source: LevelSource;
  moderationStatus: ModerationStatus;
  version: string;
  uploaderDisplayName: string;
  uploadedAt: string;
  checksum: string;
  fileCount: number;
  levelIds: string[];
  storagePath: string | null;
  previewAssetUrl: string | null;
}

export interface AuditEvent {
  id: string;
  action: string;
  actorDisplayName: string;
  actorUserId: string | null;
  targetType: "upload_job" | "level" | "level_package" | "campaign" | "room";
  targetId: string;
  createdAt: string;
  payload: Record<string, unknown>;
}

export interface AdPlacementReport {
  placementType: AdPlacementType;
  impressions: number;
  clicks: number;
}

export interface AdLevelReport {
  levelId: string;
  impressions: number;
  clicks: number;
}

export interface AdCampaignReport {
  campaignId: string;
  campaignName: string;
  status: AdCampaign["status"];
  totalImpressions: number;
  totalClicks: number;
  uniqueSessions: number;
  ctr: number;
  lastEventAt: string | null;
  placementReports: AdPlacementReport[];
  levelReports: AdLevelReport[];
}

export interface ServiceHealthSnapshot {
  service: string;
  status: ServiceStatus;
  buildVersion: string;
  uptimeSeconds: number | null;
  detail: Record<string, unknown>;
}

export interface RateLimitSummary {
  bucket: string;
  limit: number;
  windowMs: number;
  hits: number;
  blocked: number;
  lastTriggeredAt: string | null;
}

export interface OpsSnapshot {
  buildVersion: string;
  startedAt: string;
  serviceHealth: ServiceHealthSnapshot[];
  rateLimits: RateLimitSummary[];
  roomLifecycle: {
    created: number;
    ended: number;
    inviteJoins: number;
    reconnects: number;
    active: number;
  };
  adTotals: {
    impressions: number;
    clicks: number;
    trackedCampaigns: number;
  };
  backupRoot: string;
  uploadArchiveCount: number;
}
