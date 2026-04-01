export type UserRole =
  | "guest"
  | "registered"
  | "super_admin"
  | "content_admin"
  | "moderator"
  | "ops_viewer";

export type Visibility = "public" | "private" | "unlisted";
export type RoomStatus = "warming" | "waiting" | "active" | "ended";
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

export interface PlayerSettings {
  controlPreset: ControlPreset["id"];
  sensitivity: number;
  invertY: boolean;
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
  packSlug: string;
  packTitle: string;
  alfPath: string;
  entryIndex: number;
  isOfficial: boolean;
  moderationStatus: ModerationStatus;
  recommendedPlayers: [number, number];
  levelPreviewUrl: string | null;
  sceneUrl: string;
}

export interface SceneEnvironment {
  skyColors: string[];
  groundColor: string;
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
  nodes: SceneNode[];
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
  adCampaignsLive: number;
  serverHealth: "healthy" | "degraded" | "offline";
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
}
