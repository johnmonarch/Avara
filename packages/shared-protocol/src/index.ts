import type { RoomStatus } from "@avara/shared-types";

export const PROTOCOL_VERSION = 1;

export type WeaponLoad = "cannon" | "missile" | "grenade";
export type ProjectileKind = "plasma" | "missile" | "grenade";
export type PickupKind = "missiles" | "grenades" | "mixed";
export type ScoutCommand = "follow" | "lead" | "left" | "right" | "up" | "down";
export type MatchEventType =
  | "spawn"
  | "damage"
  | "pickup"
  | "frag"
  | "respawn"
  | "weapon_load"
  | "match_end";

export interface HandshakePacket {
  type: "handshake";
  protocolVersion: number;
  roomId: string;
  playerId: string;
  reconnectToken?: string;
}

export interface InputPacket {
  type: "input";
  sequence: number;
  moveForward: number;
  turnBody: number;
  aimYaw: number;
  aimPitch: number;
  stanceDelta?: number;
  primaryFire: boolean;
  loadMissile: boolean;
  loadGrenade: boolean;
  boost: boolean;
  crouchJump: boolean;
  toggleScoutView?: boolean;
  scoutCommand?: ScoutCommand | null;
}

export interface SnapshotPlayerState {
  id: string;
  displayName: string;
  x: number;
  y: number;
  z: number;
  vx?: number;
  vy?: number;
  vz?: number;
  bodyYaw: number;
  turretYaw: number;
  turretPitch: number;
  leftMotor?: number;
  rightMotor?: number;
  crouch?: number;
  stance?: number;
  health: number;
  alive: boolean;
  kills: number;
  deaths: number;
  missileAmmo: number;
  grenadeAmmo: number;
  boostsRemaining: number;
  weaponLoad: WeaponLoad;
  energy?: number;
  shields?: number;
  gunEnergyLeft?: number;
  gunEnergyRight?: number;
  fullGunEnergy?: number;
  activeGunEnergy?: number;
  respawnSeconds: number;
  shapeId?: number;
  shapeKey?: string;
  shapeAssetUrl?: string;
  scale?: number;
  rideHeight?: number;
  color?: string;
  accentColor?: string;
  targetLocked?: boolean;
  scoutView?: boolean;
  scoutId?: string;
  legs?: [SnapshotWalkerLegState, SnapshotWalkerLegState];
}

export interface SnapshotWalkerLegState {
  x: number;
  y: number;
  whereX: number;
  whereY: number;
  whereZ: number;
  touching: boolean;
  highAngle?: number;
  lowAngle?: number;
}

export interface SnapshotScoutState {
  id: string;
  ownerPlayerId: string;
  x: number;
  y: number;
  z: number;
  heading: number;
  health: number;
  active: boolean;
  action: ScoutCommand | "inactive";
  shapeId?: number;
  shapeKey?: string;
  shapeAssetUrl?: string;
  scale?: number;
  color?: string;
  accentColor?: string;
}

export interface SnapshotProjectileState {
  id: string;
  ownerId: string;
  kind: ProjectileKind;
  x: number;
  y: number;
  z: number;
  yaw?: number;
  pitch?: number;
  roll?: number;
  shapeId?: number;
  shapeKey?: string;
  shapeAssetUrl?: string;
  scale?: number;
  color?: string;
  accentColor?: string;
}

export interface SnapshotFragmentState {
  id: string;
  x: number;
  y: number;
  z: number;
  yaw?: number;
  pitch?: number;
  roll?: number;
  shapeId?: number;
  shapeKey?: string;
  shapeAssetUrl?: string;
  scale?: number;
  color?: string;
  accentColor?: string;
}

export interface SnapshotPickupState {
  id: string;
  kind: PickupKind;
  x: number;
  y: number;
  z: number;
  available: boolean;
  respawnSeconds: number;
  shapeId?: number;
  shapeKey?: string;
  shapeAssetUrl?: string;
  scale?: number;
  color?: string;
  accentColor?: string;
}

export interface MatchEventState {
  id: string;
  tick: number;
  event: MatchEventType;
  actorPlayerId?: string;
  targetPlayerId?: string;
  message: string;
}

export interface SnapshotPacket {
  type: "snapshot";
  tick: number;
  roomId: string;
  roomStatus: RoomStatus;
  players: SnapshotPlayerState[];
  scouts: SnapshotScoutState[];
  projectiles: SnapshotProjectileState[];
  fragments: SnapshotFragmentState[];
  pickups: SnapshotPickupState[];
  events: MatchEventState[];
  remainingSeconds: number;
  fragLimit: number;
  winnerPlayerId?: string;
}

export interface EventPacket {
  type: "event";
  event: MatchEventType;
  payload: Record<string, unknown>;
}

export interface ChatPacket {
  type: "chat";
  roomId: string;
  playerId: string;
  message: string;
}

export type RealtimePacket =
  | HandshakePacket
  | InputPacket
  | SnapshotPacket
  | EventPacket
  | ChatPacket;
