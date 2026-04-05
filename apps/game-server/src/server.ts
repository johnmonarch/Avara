import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseLevelScene } from "@avara/level-parser";
import {
  buildCollisionTriangleBuffer,
  findRayDistanceNative,
  findSegmentImpactNative,
  nativeCoreAvailable
} from "../../../packages/native-core/index.js";
import type {
  MatchEventState,
  PickupKind,
  ProjectileKind,
  ScoutCommand,
  SnapshotPacket,
  SnapshotPickupState,
  SnapshotPlayerState,
  SnapshotScoutState,
  SnapshotProjectileState,
  WeaponLoad
} from "@avara/shared-protocol";
import type { HullSimulationSettings, LevelScene, LevelSimulationSettings, SceneNode } from "@avara/shared-types";
import { PROTOCOL_VERSION } from "@avara/shared-protocol";
import { log } from "@avara/telemetry";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, "../../..");
const levelsRoot = path.join(workspaceRoot, "levels");

const port = Number(process.env.PORT ?? "8091");
const tickRate = Number(process.env.TICK_RATE ?? "20");
const host = process.env.HOST ?? "0.0.0.0";
const matchSeconds = Number(process.env.MATCH_SECONDS ?? "180");
const fragLimit = Number(process.env.FRAG_LIMIT ?? "5");
const respawnSeconds = Number(process.env.RESPAWN_SECONDS ?? "3");
const pickupRespawnSeconds = Number(process.env.PICKUP_RESPAWN_SECONDS ?? "12");
const disconnectGraceSeconds = Number(process.env.DISCONNECT_GRACE_SECONDS ?? "20");
const buildVersion = process.env.BUILD_VERSION ?? "dev-local";
const startedAt = Date.now();

const PLAYER_RADIUS = 1.2;
const PLAYER_HIT_CENTER_Y = 2.1;
const PLAYER_HIT_RADIUS = 1.8;
const MAX_STEP_HEIGHT = 1.4;
const RESPAWN_TICKS = tickRate * respawnSeconds;
const PICKUP_RESPAWN_TICKS = tickRate * pickupRespawnSeconds;
const DISCONNECT_GRACE_TICKS = tickRate * disconnectGraceSeconds;
const CLASSIC_FRAME_SECONDS = 0.064;
const ROOT_BSP_CONTENT_PREFIX = "/content/rsrc/bsps";
const PLAYER_PLASMA_SPEED = 6;
const PLAYER_PLASMA_LIFETIME_CLASSIC_FRAMES = 25;
const PLAYER_PLASMA_RANGE = PLAYER_PLASMA_SPEED * PLAYER_PLASMA_LIFETIME_CLASSIC_FRAMES;
const PLAYER_PLASMA_COLLISION_RADIUS = 0.2;
const MISSILE_COLLISION_RADIUS = 0.55;
const GRENADE_COLLISION_RADIUS = 0.55;
const HECTOR_MAX_SHIELDS = 3;
const HECTOR_MAX_ENERGY = 5;
const HECTOR_FULL_GUN_ENERGY = 0.8;
const HECTOR_ACTIVE_GUN_ENERGY = 0.25;
const HECTOR_CLASSIC_GENERATOR_POWER = 0.03;
const HECTOR_CLASSIC_SHIELD_REGEN = 0.03;
const HECTOR_CLASSIC_GUN_RECHARGE = 0.035;
const HECTOR_CLASSIC_MOTOR_FRICTION = 0.75;
const HECTOR_CLASSIC_ACCELERATION = 0.25;
const HECTOR_CLASSIC_MOVEMENT_FRICTION = 0.01;
const HECTOR_TURNING_EFFECT = (3.5 * Math.PI) / 180;
const HECTOR_BASE_MASS = 165;
const HECTOR_JUMP_BASE_POWER = 0.7;
const HECTOR_MIN_HEAD_HEIGHT = 0.9;
const HECTOR_MAX_HEAD_HEIGHT = 1.75;
const HECTOR_BEST_SPEED_HEIGHT = 1.7;
const HECTOR_DEFAULT_STANCE = HECTOR_BEST_SPEED_HEIGHT;
const HECTOR_GRAVITY = 0.12;
const HECTOR_LEG_SPACE_ABS = 0.6;
const HECTOR_LEG_SCAN_HEIGHT = 0.2;
const HECTOR_CONTACT_HEIGHT = 0.1;
const PLAYER_COLLISION_TOP_PADDING = 0.45;
const PLAYER_COLLISION_SAMPLE_PADDING = 0.12;
const BOOST_LENGTH_CLASSIC_FRAMES = 16 * 5;
const MINI_BOOST_CLASSIC_FRAMES = 32;
const MISSILE_LOAD_CLASSIC_FRAMES = 4;
const GRENADE_LOAD_CLASSIC_FRAMES = 3;
const MISSILE_HOST_GRACE_CLASSIC_FRAMES = 5;
const MISSILE_LIFETIME_CLASSIC_FRAMES = 100;
const GRENADE_LIFETIME_CLASSIC_FRAMES = 100;
const GRENADE_FRICTION = 0.99;
const SMART_MISSILE_FRICTION = 0.05;
const SMART_MISSILE_TARGET_RANGE = 160;
const SMART_MISSILE_EXPLODE_RANGE = 2;
const PLASMA_SPIN_RADIANS = (17 * Math.PI) / 180;
const SCOUT_TURN_SPEED = 0.3944;
const SCOUT_SHIELD = 10;
const SCOUT_FRICTION = 0.96;
const SCOUT_ACCELERATION = 0.05;
const SCOUT_SPEED = 0.1;
const SCOUT_HEIGHT = 5;
const SCOUT_CLOSE_RADIUS = 5;
const SCOUT_VERY_CLOSE = 3;
const SCOUT_FOLLOW_RADIUS = 10;
const SCOUT_SPAWN_PLATFORM = 1.5;
const SCOUT_COLLISION_RADIUS = 1.2;
const GUN_MOUNT_OFFSET_X = 0.25;
const GUN_MOUNT_OFFSET_Y = 0;
const GUN_MOUNT_OFFSET_Z = 0.75;
const SMART_MISSILE_MOUNT_OFFSET = { x: 0, y: 0.45, z: 0.6 };
const GRENADE_MOUNT_OFFSET = { x: 0, y: -0.2, z: 0.95 };
const WALKER_AIM_YAW_LIMIT = (120 * Math.PI) / 180;
const WALKER_AIM_PITCH_MIN = (-30 * Math.PI) / 180;
const WALKER_AIM_PITCH_MAX = (30 * Math.PI) / 180;
const DEFAULT_HECTOR_HULL = {
  resourceId: 128,
  shapeId: 215,
  shapeKey: "bspAvaraLight",
  shapeAssetUrl: `${ROOT_BSP_CONTENT_PREFIX}/215.json`,
  rideHeight: 0.2500038147554742,
  maxMissiles: 3,
  maxGrenades: 6,
  maxBoosters: 3,
  mass: 140,
  energyRatio: 0.9000076295109484,
  energyChargeRatio: 1.0500038147554742,
  shieldsRatio: 0.9000076295109484,
  shieldsChargeRatio: 1.0500038147554742,
  minShotRatio: 1,
  maxShotRatio: 0.9000076295109484,
  shotChargeRatio: 1.0500038147554742,
  accelerationRatio: 1,
  jumpPowerRatio: 1
};
const BSP_PLASMA = {
  shapeId: 203,
  shapeKey: "bspPlayerMissile",
  shapeAssetUrl: `${ROOT_BSP_CONTENT_PREFIX}/203.json`
};
const BSP_MISSILE = {
  shapeId: 802,
  shapeKey: "bspMissile",
  shapeAssetUrl: `${ROOT_BSP_CONTENT_PREFIX}/802.json`
};
const BSP_GRENADE = {
  shapeId: 820,
  shapeKey: "bspGrenade",
  shapeAssetUrl: `${ROOT_BSP_CONTENT_PREFIX}/820.json`
};
const BSP_SCOUT = {
  shapeId: 220,
  shapeKey: "bspScout",
  shapeAssetUrl: `${ROOT_BSP_CONTENT_PREFIX}/220.json`
};

interface SpawnPoint {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

interface RoomBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

interface RectSurface {
  id: string;
  x: number;
  z: number;
  width: number;
  depth: number;
  yaw: number;
  baseY: number;
  topY: number;
}

interface RampSurface {
  id: string;
  x: number;
  z: number;
  width: number;
  depth: number;
  yaw: number;
  baseY: number;
  height: number;
}

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

interface CollisionAabb {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

interface CollisionTriangle {
  a: Vec3;
  b: Vec3;
  c: Vec3;
  bounds: CollisionAabb;
}

interface CollisionMesh {
  id: string;
  bounds: CollisionAabb;
  triangles: CollisionTriangle[];
}

interface BspCollisionAsset {
  points: [number, number, number][];
  polys: Array<{ normal: number; tris: number[] }>;
  normals?: [number, number, number][];
  bounds?: {
    min?: [number, number, number];
    max?: [number, number, number];
  };
}

interface PickupState {
  id: string;
  kind: PickupKind;
  x: number;
  y: number;
  z: number;
  shapeId?: number;
  shapeKey?: string;
  shapeAssetUrl?: string;
  scale?: number;
  color?: string;
  accentColor?: string;
  missiles: number;
  grenades: number;
  available: boolean;
  respawnAtTick: number;
}

interface ProjectileState {
  id: string;
  ownerId: string;
  ownerName: string;
  kind: ProjectileKind;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  remainingTicks: number;
  directDamage: number;
  blastPower: number;
  gravity: number;
  friction: number;
  collisionRadius: number;
  yaw: number;
  pitch: number;
  roll: number;
  spin: number;
  turnRate: number;
  thrust: number;
  targetPlayerId?: string;
  hostGraceTicks: number;
  shapeId: number;
  shapeKey: string;
  shapeAssetUrl: string;
  scale: number;
}

interface PlayerInputState {
  moveForward: number;
  turnBody: number;
  aimYaw: number;
  aimPitch: number;
  stanceDelta: number;
  primaryFire: boolean;
  loadMissile: boolean;
  loadGrenade: boolean;
  boost: boolean;
  crouchJump: boolean;
  toggleScoutView?: boolean;
  scoutCommand?: ScoutCommand | null;
}

interface ScoutState {
  id: string;
  ownerPlayerId: string;
  ownerName: string;
  x: number;
  y: number;
  z: number;
  targetX: number;
  targetY: number;
  targetZ: number;
  vx: number;
  vy: number;
  vz: number;
  heading: number;
  health: number;
  action: ScoutCommand | "inactive";
  nextRotateFlag: boolean;
}

interface WalkerLegState {
  x: number;
  y: number;
  whereX: number;
  whereY: number;
  whereZ: number;
  touching: boolean;
}

interface PlayerState {
  id: string;
  displayName: string;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  leftMotor: number;
  rightMotor: number;
  bodyYaw: number;
  turretYaw: number;
  turretPitch: number;
  health: number;
  shields: number;
  energy: number;
  gunEnergyLeft: number;
  gunEnergyRight: number;
  alive: boolean;
  kills: number;
  deaths: number;
  missileAmmo: number;
  grenadeAmmo: number;
  boostsRemaining: number;
  weaponLoad: WeaponLoad;
  respawnAtTick: number;
  nextFireTick: number;
  nextMissileLoadTick: number;
  nextGrenadeLoadTick: number;
  boostEndTick: number;
  jumpPressed: boolean;
  jumpReleased: boolean;
  boostPressed: boolean;
  crouch: number;
  stance: number;
  jumpFlag: boolean;
  tractionFlag: boolean;
  oldTractionFlag: boolean;
  scoutView: boolean;
  scoutId?: string;
  lastSeenTick: number;
  mass: number;
  baseMass: number;
  maxAcceleration: number;
  jumpBasePower: number;
  maxEnergy: number;
  maxShields: number;
  fullGunEnergy: number;
  activeGunEnergy: number;
  classicGeneratorPower: number;
  classicShieldRegen: number;
  classicGunRecharge: number;
  missileLimit: number;
  grenadeLimit: number;
  boosterLimit: number;
  rideHeight: number;
  hullShapeId: number;
  hullShapeKey?: string;
  hullShapeAssetUrl?: string;
  didBump: boolean;
  supportTraction: number;
  supportFriction: number;
  distance: number;
  headChange: number;
  targetHeight: number;
  absAvgSpeed: number;
  legPhase: number;
  speedLimit: number;
  legs: [WalkerLegState, WalkerLegState];
  input: PlayerInputState;
}

interface RoomState {
  id: string;
  levelId: string;
  levelTitle: string;
  maxPlayers: number;
  spawnPoints: SpawnPoint[];
  bounds: RoomBounds;
  blockers: RectSurface[];
  ramps: RampSurface[];
  collisionMeshes: CollisionMesh[];
  collisionTriangleBuffer: Float64Array;
  pickups: PickupState[];
  projectiles: ProjectileState[];
  players: Map<string, PlayerState>;
  scouts: Map<string, ScoutState>;
  settings: LevelSimulationSettings;
  nextSpawnIndex: number;
  tick: number;
  status: "waiting" | "active" | "ended";
  fragLimit: number;
  matchDurationTicks: number;
  startedAtTick: number | null;
  winnerPlayerId?: string;
  events: MatchEventState[];
}

const rooms = new Map<string, RoomState>();
const requestCounts = new Map<string, number>();
const collisionAssetCache = new Map<string, Promise<CollisionTriangle[]>>();

setInterval(() => {
  const dt = 1 / tickRate;

  for (const room of rooms.values()) {
    room.tick += 1;

    if (room.status === "waiting") {
      if (room.players.size > 0) {
        room.status = "active";
        room.startedAtTick = room.tick;
      }
      continue;
    }

    if (room.status === "ended") {
      continue;
    }

    expireDisconnectedPlayers(room);
    processRespawns(room);
    simulatePlayers(room, dt);
    simulateScouts(room, dt);
    processPickups(room);
    simulateProjectiles(room, dt);
    maybeCompleteMatchOnTime(room);
  }
}, 1000 / tickRate);

createServer(async (request, response) => {
  try {
    setCorsHeaders(response);
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    recordRequestMetric(request.method ?? "GET", url.pathname);

    if (request.method === "GET" && url.pathname === "/health") {
      return sendJson(response, 200, {
        service: "game-server",
        status: "healthy",
        buildVersion,
        uptimeSeconds: getUptimeSeconds(),
        protocolVersion: PROTOCOL_VERSION,
        rooms: rooms.size,
        nativeCoreAvailable
      });
    }

    if (request.method === "GET" && url.pathname === "/metrics") {
      return sendMetrics(response);
    }

    if (request.method === "POST" && url.pathname === "/rooms/bootstrap") {
      const body = await readJsonBody(request);
      const roomId = asString(body?.roomId) ?? `room_${crypto.randomUUID()}`;
      const levelId = asString(body?.levelId);
      if (!levelId) {
        return sendJson(response, 400, { error: "levelId is required" });
      }

      const existing = rooms.get(roomId);
      if (existing) {
        return sendJson(response, 200, {
          roomId,
          protocolVersion: PROTOCOL_VERSION,
          status: existing.status,
          levelTitle: existing.levelTitle
        });
      }

      const scene = await parseLevelScene(levelsRoot, levelId);
      const room = await createRoomState(roomId, scene, clamp(asNumber(body?.maxPlayers) ?? 8, 1, 8));
      rooms.set(roomId, room);
      return sendJson(response, 201, {
        roomId,
        protocolVersion: PROTOCOL_VERSION,
        status: room.status,
        levelTitle: room.levelTitle
      });
    }

    if (request.method === "POST" && url.pathname.startsWith("/rooms/") && url.pathname.endsWith("/join")) {
      const roomId = decodeURIComponent(url.pathname.slice("/rooms/".length, -"/join".length));
      const room = rooms.get(roomId);
      if (!room) {
        return sendJson(response, 404, { error: "Room not found" });
      }
      if (room.status === "ended") {
        return sendJson(response, 409, { error: "Match has ended" });
      }

      const body = await readJsonBody(request);
      const playerId = asString(body?.playerId) ?? `player_${crypto.randomUUID()}`;
      const displayName = asString(body?.displayName) ?? "Guest";

      let player = room.players.get(playerId);
      if (!player) {
        if (room.players.size >= room.maxPlayers) {
          return sendJson(response, 409, { error: "Room is full" });
        }

        player = spawnFreshPlayer(room, playerId, displayName);
        room.players.set(playerId, player);
        addEvent(room, {
          event: "spawn",
          actorPlayerId: player.id,
          message: `${player.displayName} entered the arena`
        });
      }
      player.displayName = displayName;
      player.lastSeenTick = room.tick;
      if (player.scoutId) {
        const scout = room.scouts.get(player.scoutId);
        if (scout) {
          scout.ownerName = displayName;
        }
      }

      if (room.status === "waiting" && room.players.size > 0) {
        room.status = "active";
        room.startedAtTick = room.tick;
      }

      return sendJson(response, 200, {
        playerId,
        snapshot: buildSnapshot(room)
      });
    }

    if (request.method === "POST" && url.pathname.startsWith("/rooms/") && url.pathname.endsWith("/leave")) {
      const roomId = decodeURIComponent(url.pathname.slice("/rooms/".length, -"/leave".length));
      const room = rooms.get(roomId);
      if (!room) {
        return sendJson(response, 404, { error: "Room not found" });
      }

      const body = await readJsonBody(request);
      const playerId = asString(body?.playerId);
      if (playerId) {
        removeScoutForPlayer(room, playerId);
        room.players.delete(playerId);
      }

      if (!room.players.size && room.status === "active") {
        room.status = "waiting";
        room.startedAtTick = null;
      }

      return sendJson(response, 200, {
        roomId,
        snapshot: buildSnapshot(room)
      });
    }

    if (request.method === "POST" && url.pathname.startsWith("/rooms/") && url.pathname.endsWith("/input")) {
      const roomId = decodeURIComponent(url.pathname.slice("/rooms/".length, -"/input".length));
      const room = rooms.get(roomId);
      if (!room) {
        return sendJson(response, 404, { error: "Room not found" });
      }

      const body = await readJsonBody(request);
      const playerId = asString(body?.playerId);
      if (!playerId) {
        return sendJson(response, 400, { error: "playerId is required" });
      }

      const player = room.players.get(playerId);
      if (!player) {
        return sendJson(response, 404, { error: "Player not found" });
      }

      const nextInput: PlayerInputState = {
        moveForward: clamp(asNumber(body?.moveForward) ?? 0, -1, 1),
        turnBody: clamp(asNumber(body?.turnBody) ?? 0, -1, 1),
        aimYaw: clamp(asNumber(body?.aimYaw) ?? 0, -1.2, 1.2),
        aimPitch: clamp(asNumber(body?.aimPitch) ?? 0, -0.8, 0.5),
        stanceDelta: clamp(asNumber(body?.stanceDelta) ?? 0, -0.25, 0.25),
        primaryFire: Boolean(body?.primaryFire),
        loadMissile: Boolean(body?.loadMissile),
        loadGrenade: Boolean(body?.loadGrenade),
        boost: Boolean(body?.boost),
        crouchJump: Boolean(body?.crouchJump),
        toggleScoutView: Boolean(body?.toggleScoutView),
        scoutCommand: normalizeScoutCommand(body?.scoutCommand)
      };

      if (room.status === "active" && player.alive) {
        if (nextInput.loadMissile && !player.input.loadMissile) {
          loadWeapon(room, player, "missile");
        }
        if (nextInput.loadGrenade && !player.input.loadGrenade) {
          loadWeapon(room, player, "grenade");
        }
        if (nextInput.primaryFire && !player.input.primaryFire) {
          fireWeapon(room, player);
        }
        if (nextInput.toggleScoutView) {
          toggleScoutView(room, player);
        }
        if (nextInput.scoutCommand) {
          issueScoutCommand(room, player, nextInput.scoutCommand);
        }
      }

      player.jumpPressed ||= nextInput.crouchJump && !player.input.crouchJump;
      player.jumpReleased ||= !nextInput.crouchJump && player.input.crouchJump;
      player.boostPressed ||= nextInput.boost && !player.input.boost;
      player.input = nextInput;
      player.lastSeenTick = room.tick;
      return sendJson(response, 200, buildSnapshot(room));
    }

    if (request.method === "POST" && url.pathname.startsWith("/rooms/") && url.pathname.endsWith("/terminate")) {
      const roomId = decodeURIComponent(url.pathname.slice("/rooms/".length, -"/terminate".length));
      const room = rooms.get(roomId);
      if (!room) {
        return sendJson(response, 404, { error: "Room not found" });
      }

      endMatch(room, undefined, "Room ended by host");
      rooms.delete(roomId);
      return sendJson(response, 200, {
        roomId,
        terminated: true
      });
    }

    if (request.method === "GET" && url.pathname.startsWith("/rooms/") && url.pathname.endsWith("/snapshot")) {
      const roomId = decodeURIComponent(url.pathname.slice("/rooms/".length, -"/snapshot".length));
      const room = rooms.get(roomId);
      if (!room) {
        return sendJson(response, 404, { error: "Room not found" });
      }

      return sendJson(response, 200, buildSnapshot(room));
    }

    return sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    log({
      service: "game-server",
      level: "error",
      event: "request_failed",
      payload: { message: error instanceof Error ? error.message : String(error) }
    });
    return sendJson(response, 500, {
      error: error instanceof Error ? error.message : "Unknown server error"
    });
  }
}).listen(port, host, () => {
  log({
    service: "game-server",
    level: "info",
    event: "server_started",
    payload: { host, port, tickRate, protocolVersion: PROTOCOL_VERSION, buildVersion }
  });
});

async function createRoomState(roomId: string, scene: LevelScene, maxPlayers: number): Promise<RoomState> {
  const blockers = deriveBlockers(scene.nodes);
  const ramps = deriveRamps(scene.nodes);
  const bounds = deriveBounds(scene.nodes, blockers, ramps);
  const collisionMeshes = await deriveCollisionMeshes(scene.nodes);
  const collisionTriangleBuffer = buildCollisionTriangleBuffer(collisionMeshes);
  return {
    id: roomId,
    levelId: scene.id,
    levelTitle: scene.title,
    maxPlayers,
    spawnPoints: deriveSpawnPoints(scene.nodes),
    bounds,
    blockers,
    ramps,
    collisionMeshes,
    collisionTriangleBuffer,
    pickups: derivePickups(scene.nodes),
    projectiles: [],
    players: new Map(),
    scouts: new Map(),
    settings: scene.settings,
    nextSpawnIndex: 0,
    tick: 0,
    status: "waiting",
    fragLimit,
    matchDurationTicks: matchSeconds * tickRate,
    startedAtTick: null,
    events: []
  };
}

function getRoomHullSettings(settings: LevelSimulationSettings): HullSimulationSettings {
  return settings.defaultHull ?? DEFAULT_HECTOR_HULL;
}

function getHullShapeKey(shapeId: number): string | undefined {
  switch (shapeId) {
    case 215:
      return "bspAvaraLight";
    case 216:
      return "bspAvaraMedium";
    case 217:
      return "bspAvaraHeavy";
    default:
      return undefined;
  }
}

function getHullShapeAssetUrl(shapeId: number): string {
  return `${ROOT_BSP_CONTENT_PREFIX}/${shapeId}.json`;
}

function getPlayerTotalMass(player: PlayerState): number {
  return player.mass + (player.boostsRemaining * 4) + player.grenadeAmmo + player.missileAmmo;
}

function simulatePlayers(room: RoomState, dt: number): void {
  const fpsScale = dt / CLASSIC_FRAME_SECONDS;

  for (const player of room.players.values()) {
    if (!player.alive) {
      continue;
    }

    const floor = sampleFloorHeight(room, player.x, player.z, player.y);
    const grounded = (player.tractionFlag || player.y <= floor + 0.08) && player.vy <= 0.1;
    if (grounded && !player.oldTractionFlag) {
      player.jumpFlag = false;
    }
    player.oldTractionFlag = grounded;
    player.tractionFlag = grounded;

    if (player.boostPressed && player.boostsRemaining > 0 && room.tick >= player.boostEndTick) {
      player.boostsRemaining -= 1;
      player.boostEndTick = room.tick + framesFromClassic(BOOST_LENGTH_CLASSIC_FRAMES, fpsScale);
    }
    player.boostPressed = false;

    if (Math.abs(player.input.stanceDelta) > 0.000001) {
      player.stance = clamp(player.stance + player.input.stanceDelta, HECTOR_MIN_HEAD_HEIGHT, HECTOR_MAX_HEAD_HEIGHT);
    }

    simulateWalkerJump(room, player, fpsScale);
    simulateWalkerMotors(room, player, fpsScale);
    simulateWalkerVertical(room, player, fpsScale);

    player.turretYaw = normalizeAngle(player.bodyYaw + clamp(player.input.aimYaw, -WALKER_AIM_YAW_LIMIT, WALKER_AIM_YAW_LIMIT));
    player.turretPitch = clamp(player.input.aimPitch, WALKER_AIM_PITCH_MIN, WALKER_AIM_PITCH_MAX);

    const targetX = player.x + fpsCoefficient2(player.vx, fpsScale);
    const targetY = player.y + fpsCoefficient2(player.vy, fpsScale);
    const targetZ = player.z + fpsCoefficient2(player.vz, fpsScale);
    const resolved = resolveMovement(room, player, targetX, targetY, targetZ);
    player.didBump = resolved.bumped || !resolved.moved;
    player.x = resolved.x;
    player.y = resolved.y;
    player.z = resolved.z;

    if (resolved.landed) {
      if (player.vy < 0) {
        player.vy = 0;
      }
      player.jumpFlag = false;
      player.tractionFlag = true;
      player.oldTractionFlag = true;
    }

    updateWalkerLegContacts(room, player, fpsScale);
    updateWalkerSupportFromFeet(room, player);
    if (player.speedLimit < 0) {
      player.speedLimit -= (player.stance - player.crouch) / 2;
      if (player.vy < player.speedLimit) {
        player.vy = player.speedLimit;
      }
    }

    rechargePlayerSystems(player, room, fpsScale);
  }
}

function simulateScouts(room: RoomState, dt: number): void {
  const fpsScale = dt / CLASSIC_FRAME_SECONDS;

  for (const scout of room.scouts.values()) {
    const owner = room.players.get(scout.ownerPlayerId);
    if (!owner?.alive) {
      removeScout(room, scout, false);
      continue;
    }

    const oldX = scout.x;
    const oldY = scout.y;
    const oldZ = scout.z;
    const oldHeading = scout.heading;

    if (scout.nextRotateFlag) {
      scout.heading = normalizeAngle(scout.heading + fpsCoefficient2(SCOUT_TURN_SPEED, fpsScale));
    }

    const scoutBaseHeight = getScoutBaseHeight(owner);
    let distance = 0;

    switch (scout.action) {
      case "follow":
        setScoutTargetAroundPlayer(scout, owner, scoutBaseHeight, "follow");
        distance = moveScoutToTarget(scout, fpsScale);
        break;
      case "lead":
        setScoutTargetAroundPlayer(scout, owner, scoutBaseHeight, "lead");
        distance = moveScoutToTarget(scout, fpsScale);
        break;
      case "left":
        setScoutTargetAroundPlayer(scout, owner, scoutBaseHeight, "left");
        distance = moveScoutToTarget(scout, fpsScale);
        break;
      case "right":
        setScoutTargetAroundPlayer(scout, owner, scoutBaseHeight, "right");
        distance = moveScoutToTarget(scout, fpsScale);
        break;
      case "up":
        distance = moveScoutToTarget(scout, fpsScale);
        break;
      case "down": {
        const baseHeight = owner.y + scoutBaseHeight;
        const horizontalDistance = Math.hypot(scout.x - owner.x, scout.z - owner.z);

        if (horizontalDistance < SCOUT_CLOSE_RADIUS) {
          if (horizontalDistance < SCOUT_VERY_CLOSE && baseHeight > scout.y) {
            scout.targetX = scout.x;
            scout.targetY = scout.y;
            scout.targetZ = scout.z;
            distance = Math.max(0, scout.y - baseHeight + horizontalDistance);
            moveScoutToTarget(scout, fpsScale);
          } else {
            scout.targetX = owner.x;
            scout.targetY = baseHeight;
            scout.targetZ = owner.z;
            distance = moveScoutToTarget(scout, fpsScale);
          }
        } else {
          scout.targetX = owner.x;
          scout.targetY = owner.y + scoutBaseHeight + SCOUT_HEIGHT;
          scout.targetZ = owner.z;
          distance = moveScoutToTarget(scout, fpsScale);
        }

        if (scout.y <= baseHeight + 0.2 && distance <= SCOUT_SPEED) {
          removeScout(room, scout, true);
          continue;
        }
        break;
      }
      case "inactive":
      default:
        break;
    }

    const blockerHit = findBlockerImpact(
      room,
      SCOUT_COLLISION_RADIUS,
      { x: oldX, y: oldY, z: oldZ },
      { x: scout.x, y: scout.y, z: scout.z }
    );
    const terrainHit = findTerrainImpact(
      room,
      SCOUT_COLLISION_RADIUS,
      { x: oldX, y: oldY, z: oldZ },
      { x: scout.x, y: scout.y, z: scout.z }
    );

    if (blockerHit || terrainHit) {
      scout.x = oldX;
      scout.y = oldY;
      scout.z = oldZ;
      scout.heading = oldHeading;
      scout.nextRotateFlag = false;
    } else {
      scout.nextRotateFlag = true;
      scout.x = clamp(scout.x, room.bounds.minX, room.bounds.maxX);
      scout.z = clamp(scout.z, room.bounds.minZ, room.bounds.maxZ);
      scout.y = Math.max(sampleFloorHeight(room, scout.x, scout.z, scout.y) + 0.2, scout.y);
    }
  }
}

function moveScoutToTarget(scout: ScoutState, fpsScale: number): number {
  const deltaX = scout.targetX - scout.x;
  const deltaY = scout.targetY - scout.y;
  const deltaZ = scout.targetZ - scout.z;
  const distance = Math.hypot(deltaX, deltaY, deltaZ);
  let courseX = 0;
  let courseY = 0;
  let courseZ = 0;

  if (distance < fpsCoefficient2(SCOUT_SPEED, fpsScale)) {
    courseX = -scout.vx / 2;
    courseY = -scout.vy / 2;
    courseZ = -scout.vz / 2;
  } else {
    let correctedX = deltaX - scout.vx * 5;
    let correctedY = deltaY - scout.vy * 5;
    let correctedZ = deltaZ - scout.vz * 5;
    const correctedLength = Math.hypot(correctedX, correctedY, correctedZ) || 1;
    correctedX /= correctedLength;
    correctedY /= correctedLength;
    correctedZ /= correctedLength;
    courseX = correctedX * SCOUT_ACCELERATION;
    courseY = correctedY * SCOUT_ACCELERATION;
    courseZ = correctedZ * SCOUT_ACCELERATION;
  }

  const scoutResponse = fpsCoefficients(SCOUT_FRICTION, SCOUT_FRICTION, fpsScale);
  scout.vx = scout.vx * scoutResponse.coeff1 + courseX * scoutResponse.coeff2;
  scout.vy = scout.vy * scoutResponse.coeff1 + courseY * scoutResponse.coeff2;
  scout.vz = scout.vz * scoutResponse.coeff1 + courseZ * scoutResponse.coeff2;

  scout.x += fpsCoefficient2(scout.vx, fpsScale);
  scout.y += fpsCoefficient2(scout.vy, fpsScale);
  scout.z += fpsCoefficient2(scout.vz, fpsScale);

  return distance;
}

function setScoutTargetAroundPlayer(
  scout: ScoutState,
  player: PlayerState,
  scoutBaseHeight: number,
  mode: Exclude<ScoutCommand, "up" | "down">
): void {
  scout.targetX = player.x;
  scout.targetY = player.y + scoutBaseHeight + SCOUT_HEIGHT;
  scout.targetZ = player.z;

  if (mode === "follow") {
    scout.targetX -= Math.sin(player.bodyYaw) * SCOUT_FOLLOW_RADIUS;
    scout.targetZ -= Math.cos(player.bodyYaw) * SCOUT_FOLLOW_RADIUS;
    return;
  }
  if (mode === "lead") {
    scout.targetX += Math.sin(player.bodyYaw) * (SCOUT_FOLLOW_RADIUS + 5);
    scout.targetZ += Math.cos(player.bodyYaw) * (SCOUT_FOLLOW_RADIUS + 5);
    return;
  }
  if (mode === "left") {
    scout.targetX += Math.cos(player.bodyYaw) * SCOUT_FOLLOW_RADIUS;
    scout.targetZ -= Math.sin(player.bodyYaw) * SCOUT_FOLLOW_RADIUS;
    return;
  }

  scout.targetX -= Math.cos(player.bodyYaw) * SCOUT_FOLLOW_RADIUS;
  scout.targetZ += Math.sin(player.bodyYaw) * SCOUT_FOLLOW_RADIUS;
}

function simulateWalkerJump(room: RoomState, player: PlayerState, fpsScale: number): void {
  const crouchTarget = Math.max(0, player.stance - HECTOR_MIN_HEAD_HEIGHT);

  if (player.jumpPressed) {
    const blend = blendLinear(player.crouch, crouchTarget, fpsCoefficients((1 - 1 / 8), 1 / 8, fpsScale));
    player.crouch = blend;
  } else if (player.input.crouchJump) {
    const blend = blendLinear(player.crouch, crouchTarget, fpsCoefficients((1 - 1 / 4), 1 / 4, fpsScale));
    player.crouch = blend;
  } else {
    if (player.jumpReleased) {
      player.crouch *= 0.5;
    } else {
      player.crouch *= fpsCoefficient1(0.5, fpsScale);
    }
  }

  if (player.jumpReleased && player.tractionFlag && !player.jumpFlag) {
    player.vy *= 0.5;
    player.vy += ((player.crouch * 0.5) + player.jumpBasePower) * (player.baseMass / Math.max(1, getPlayerTotalMass(player)));
    player.vy -= fpsOffset(HECTOR_GRAVITY * room.settings.gravity, fpsScale);
    player.jumpFlag = true;
  }

  player.jumpPressed = false;
  player.jumpReleased = false;
}

function simulateWalkerMotors(room: RoomState, player: PlayerState, fpsScale: number): void {
  const elevation = player.stance - player.crouch;
  const classicMotorFriction = HECTOR_CLASSIC_MOTOR_FRICTION - Math.abs(elevation - HECTOR_BEST_SPEED_HEIGHT) / 4;
  const massRatio = player.baseMass / Math.max(1, getPlayerTotalMass(player));
  const classicMotorAcceleration = player.maxAcceleration * massRatio * massRatio;
  const motorResponse = fpsCoefficients(
    classicMotorFriction,
    classicMotorFriction * classicMotorAcceleration,
    fpsScale,
    true
  );

  player.leftMotor *= motorResponse.coeff1;
  player.rightMotor *= motorResponse.coeff1;

  let motionFlags = 0;
  if (player.input.moveForward > 0.5) {
    motionFlags |= 1 + 2;
  }
  if (player.input.moveForward < -0.5) {
    motionFlags |= 4 + 8;
  }
  if (player.input.turnBody < -0.5) {
    motionFlags |= 2 + 4;
  }
  if (player.input.turnBody > 0.5) {
    motionFlags |= 1 + 8;
  }

  if (motionFlags & 1) {
    if (player.leftMotor <= 0) {
      player.leftMotor += motorResponse.offset;
    }
    player.leftMotor += motorResponse.coeff2;
  }
  if (motionFlags & 2) {
    if (player.rightMotor <= 0) {
      player.rightMotor += motorResponse.offset;
    }
    player.rightMotor += motorResponse.coeff2;
  }
  if (motionFlags & 4) {
    if (player.leftMotor >= 0) {
      player.leftMotor -= motorResponse.offset;
    }
    player.leftMotor -= motorResponse.coeff2;
  }
  if (motionFlags & 8) {
    if (player.rightMotor >= 0) {
      player.rightMotor -= motorResponse.offset;
    }
    player.rightMotor -= motorResponse.coeff2;
  }

  const distance = (player.leftMotor + player.rightMotor) / 2;
  const headChange = fpsCoefficient2((player.rightMotor - player.leftMotor) * HECTOR_TURNING_EFFECT, fpsScale);
  player.distance = distance;
  player.headChange = Math.abs(headChange) < 0.00005 ? 0 : headChange;
  const averageHeading = player.bodyYaw + headChange / 2;
  const motorDirX = Math.sin(averageHeading) * distance;
  const motorDirZ = Math.cos(averageHeading) * distance;
  const supportTraction = player.supportTraction;
  const supportFriction = player.supportFriction;
  const slideX = motorDirX - player.vx;
  const slideZ = motorDirZ - player.vz;
  const slideLength = Math.hypot(slideX, slideZ);

  const movementBlend = slideLength < supportTraction
    ? fpsCoefficients(0.25, 0.75, fpsScale)
    : fpsCoefficients(1 - supportFriction, supportFriction, fpsScale);

  player.vx = player.vx * movementBlend.coeff1 + motorDirX * movementBlend.coeff2;
  player.vz = player.vz * movementBlend.coeff1 + motorDirZ * movementBlend.coeff2;

  const slowdown = 1 - fpsCoefficient1(
    clamp(1 - (HECTOR_CLASSIC_MOVEMENT_FRICTION * Math.hypot(player.vx, player.vy, player.vz)), 0, 1),
    fpsScale
  );
  player.vx -= slowdown * player.vx;
  player.vy -= slowdown * player.vy;
  player.vz -= slowdown * player.vz;

  player.bodyYaw = normalizeAngle(player.bodyYaw + headChange);
}

function simulateWalkerVertical(room: RoomState, player: PlayerState, fpsScale: number): void {
  const adjustedGravity = HECTOR_GRAVITY * room.settings.gravity;
  let bounceTarget = player.absAvgSpeed * ((0.25 * Math.PI) - (positiveModulo(player.legPhase, Math.PI) / 4));
  if (bounceTarget > 0) {
    bounceTarget = -bounceTarget;
  }
  bounceTarget += player.targetHeight;

  const extraHeight = bounceTarget + (adjustedGravity * 2);
  if (!player.jumpFlag && player.y < extraHeight) {
    const bounceBlend = fpsCoefficients(0.5, 0.5, fpsScale);
    player.vy = (player.vy * bounceBlend.coeff1) + ((bounceTarget - player.y - adjustedGravity) * bounceBlend.coeff2);
  } else {
    player.vy -= fpsCoefficient2(adjustedGravity, fpsScale);
  }

  if (player.vy < 0) {
    player.jumpFlag = false;
  }
}

function rechargePlayerSystems(player: PlayerState, room: RoomState, fpsScale: number): void {
  const generatorPower = fpsCoefficient2(player.classicGeneratorPower, fpsScale);
  const shieldRegen = fpsCoefficient2(player.classicShieldRegen, fpsScale);
  const chargeGunPerFrame = fpsCoefficient2(player.classicGunRecharge, fpsScale);
  const boosting = player.boostEndTick > room.tick;

  if (player.shields < player.maxShields) {
    const regenRate = player.maxEnergy > 0 ? (shieldRegen * player.energy) / player.maxEnergy : 0;
    if (boosting) {
      player.shields += shieldRegen;
    }
    player.shields += regenRate / 8;
    if (player.shields > player.maxShields) {
      player.shields = player.maxShields;
    }
    player.energy -= regenRate;
  }

  const charge = player.maxEnergy > 0 ? ((player.energy + generatorPower) * chargeGunPerFrame) / player.maxEnergy : 0;
  if (player.gunEnergyLeft < player.fullGunEnergy) {
    player.energy -= charge;
    player.gunEnergyLeft += player.gunEnergyLeft > player.activeGunEnergy ? charge * 0.85 : charge * 1.05;
    player.gunEnergyLeft = Math.min(player.fullGunEnergy, player.gunEnergyLeft);
  }
  if (player.gunEnergyRight < player.fullGunEnergy) {
    player.energy -= charge;
    player.gunEnergyRight += player.gunEnergyRight > player.activeGunEnergy ? charge * 0.85 : charge * 1.05;
    player.gunEnergyRight = Math.min(player.fullGunEnergy, player.gunEnergyRight);
  }

  if (player.energy < player.maxEnergy) {
    player.energy += generatorPower;
    if (boosting) {
      player.energy += 4 * generatorPower;
    }
  }

  player.energy = clamp(player.energy, 0, player.maxEnergy);
}

function resolveMovement(room: RoomState, player: PlayerState, targetX: number, targetY: number, targetZ: number) {
  const both = resolvePosition(room, player, targetX, targetY, targetZ);
  if (both) {
    return { ...both, moved: true, bumped: false };
  }

  const slideX = resolvePosition(room, player, targetX, targetY, player.z);
  if (slideX) {
    return { ...slideX, moved: true, bumped: true };
  }

  const slideZ = resolvePosition(room, player, player.x, targetY, targetZ);
  if (slideZ) {
    return { ...slideZ, moved: true, bumped: true };
  }

  const lateralPush = resolveBumpPush(room, player, targetY);
  if (lateralPush) {
    return { ...lateralPush, moved: true, bumped: true };
  }

  const floor = sampleFloorHeight(room, player.x, player.z, player.y);
  const landed = targetY <= floor + 0.01;
  return { x: player.x, y: landed ? floor : player.y, z: player.z, landed, moved: false, bumped: true };
}

function resolveBumpPush(room: RoomState, player: PlayerState, targetY: number) {
  const offsetDistance = fpsCoefficient2(1 / 16, tickDeltaScale());
  const pushMagnitude = fpsCoefficient2(1 / 8, tickDeltaScale());
  const leftX = Math.cos(player.bodyYaw) * offsetDistance;
  const leftZ = Math.sin(player.bodyYaw) * offsetDistance;

  const left = resolvePosition(room, player, player.x + leftX, targetY, player.z - leftZ);
  if (left) {
    player.vx -= Math.cos(player.bodyYaw) * pushMagnitude;
    player.vz += Math.sin(player.bodyYaw) * pushMagnitude;
    return left;
  }

  const right = resolvePosition(room, player, player.x - leftX, targetY, player.z + leftZ);
  if (right) {
    player.vx += Math.cos(player.bodyYaw) * pushMagnitude;
    player.vz -= Math.sin(player.bodyYaw) * pushMagnitude;
    return right;
  }

  return null;
}

function resolvePosition(room: RoomState, player: PlayerState, x: number, targetY: number, z: number) {
  const floor = sampleFloorHeight(room, x, z, Math.max(player.y, targetY));
  if (floor - player.y > MAX_STEP_HEIGHT && targetY <= floor + 0.01) {
    return null;
  }
  const landed = targetY <= floor + 0.01;
  const resolvedY = landed || floor > targetY
    ? (floor - targetY <= MAX_STEP_HEIGHT + 0.05 ? floor : targetY)
    : targetY;
  if (isBlocked(room, player, { x: player.x, y: player.y, z: player.z }, { x, y: resolvedY, z })) {
    return null;
  }

  return {
    x: clamp(x, room.bounds.minX, room.bounds.maxX),
    y: resolvedY,
    z: clamp(z, room.bounds.minZ, room.bounds.maxZ),
    landed
  };
}

function updateWalkerLegContacts(room: RoomState, player: PlayerState, fpsScale: number): void {
  player.speedLimit = player.vy;
  player.tractionFlag = false;
  player.targetHeight = 0;

  const elevation = Math.max(HECTOR_MIN_HEAD_HEIGHT, player.stance - player.crouch);
  const legSpeeds = computeWalkerLegSpeeds(player);
  player.absAvgSpeed = Math.abs(legSpeeds[0]) + Math.abs(legSpeeds[1]);

  const phaseChange = player.absAvgSpeed > 0.000001
    ? (Math.sqrt(player.absAvgSpeed) * 0.91) / Math.max(elevation, 0.000001)
    : 0;
  player.legPhase += fpsCoefficient2(phaseChange / 10, fpsScale);

  let legPhase = player.legPhase;
  const sinHeading = Math.sin(player.bodyYaw);
  const cosHeading = Math.cos(player.bodyYaw);

  for (let index = 0; index < 2; index += 1) {
    const leg = player.legs[index];
    const legSpeed = legSpeeds[index];

    leg.x -= legSpeed / 4;

    let moveRadius = phaseChange ? (legSpeed / phaseChange) : legSpeed;
    const targetX = -Math.cos(legPhase) * moveRadius;
    moveRadius = Math.abs(moveRadius);
    const targetY = player.y - (elevation / 16) + (Math.sin(legPhase) * moveRadius);

    const tempX = index === 0 ? HECTOR_LEG_SPACE_ABS : -HECTOR_LEG_SPACE_ABS;
    const tempZ = (targetX + leg.x) / 2;
    const worldX = player.x + (tempZ * sinHeading) - (tempX * cosHeading);
    const worldZ = player.z + (tempZ * cosHeading) + (tempX * sinHeading);
    const footScanHeight = player.y + HECTOR_LEG_SCAN_HEIGHT + (elevation / 2);
    const contactY = sampleFloorHeight(room, worldX, worldZ, footScanHeight);

    if ((contactY - player.y) < -player.speedLimit) {
      player.speedLimit = -(contactY - player.y) * fpsScale;
    }

    if (contactY > player.targetHeight) {
      player.targetHeight = contactY;
    }
    if (contactY + HECTOR_CONTACT_HEIGHT >= player.y) {
      player.tractionFlag = true;
    }

    leg.y += player.y;
    leg.y = (targetY + leg.y) / 2;

    if (leg.y > contactY) {
      leg.x = (targetX + leg.x) / 2;
      leg.touching = false;
    } else {
      const absSpeed = Math.abs(legSpeed);
      leg.x = (targetX - absSpeed + leg.x) / 2;
      leg.y = contactY;
      leg.touching = true;
    }

    leg.whereX = worldX;
    leg.whereY = contactY;
    leg.whereZ = worldZ;
    leg.y -= player.y;

    legPhase += Math.PI;
  }
}

function updateWalkerSupportFromFeet(room: RoomState, player: PlayerState): void {
  let traction = 0;
  let friction = 0;
  let contacts = 0;

  for (const leg of player.legs) {
    if (!leg.touching) {
      continue;
    }
    traction += room.settings.defaultTraction;
    friction += room.settings.defaultFriction;
    contacts += 1;
  }

  if (contacts > 0) {
    player.supportTraction = traction / contacts;
    player.supportFriction = friction / contacts;
    return;
  }

  player.supportTraction = 0;
  player.supportFriction = player.didBump ? 0.05 : 0.005;
}

function computeWalkerLegSpeeds(player: PlayerState): [number, number] {
  const temp = (HECTOR_LEG_SPACE_ABS * 18) * player.headChange;
  return [player.distance - temp, player.distance + temp];
}

function sampleFloorHeight(room: RoomState, x: number, z: number, currentY: number): number {
  let floor = 0;
  const meshFloor = sampleMeshFloorHeight(room, x, z, currentY);
  if (meshFloor !== null) {
    floor = Math.max(floor, meshFloor);
  }

  for (const blocker of room.blockers) {
    if (pointInRotatedRect(x, z, blocker.x, blocker.z, blocker.width / 2, blocker.depth / 2, blocker.yaw)) {
      if (blocker.topY <= currentY + MAX_STEP_HEIGHT + 0.05) {
        floor = Math.max(floor, blocker.topY);
      }
    }
  }

  for (const ramp of room.ramps) {
    const rampHeight = sampleRampHeight(ramp, x, z);
    if (rampHeight !== null && rampHeight <= currentY + MAX_STEP_HEIGHT + 0.05) {
      floor = Math.max(floor, rampHeight);
    }
  }

  return floor;
}

function sampleMeshFloorHeight(room: RoomState, x: number, z: number, currentY: number): number | null {
  if (!room.collisionMeshes.length) {
    return null;
  }

  const origin = { x, y: currentY + MAX_STEP_HEIGHT + 0.05, z };
  const target = { x, y: origin.y - 128, z };
  let bestFloor: number | null = null;
  const segmentBounds = pointPairBounds(origin, target);

  for (const mesh of room.collisionMeshes) {
    if (!aabbOverlaps(segmentBounds, mesh.bounds)) {
      continue;
    }

    for (const triangle of mesh.triangles) {
      if (!aabbOverlaps(segmentBounds, triangle.bounds)) {
        continue;
      }

      const normal = triangleNormal(triangle);
      if (normal.y < 0.2) {
        continue;
      }

      const t = segmentTriangleIntersectionT(origin, target, triangle.a, triangle.b, triangle.c);
      if (t === null) {
        continue;
      }

      const point = lerpPoint3(origin, target, t);
      if (point.y > currentY + MAX_STEP_HEIGHT + 0.05) {
        continue;
      }

      if (bestFloor === null || point.y > bestFloor) {
        bestFloor = point.y;
      }
    }
  }

  return bestFloor;
}

function sampleRampHeight(ramp: RampSurface, x: number, z: number): number | null {
  const local = toLocalPoint(x, z, ramp.x, ramp.z, ramp.yaw);
  if (Math.abs(local.x) > ramp.width / 2 || Math.abs(local.z) > ramp.depth / 2) {
    return null;
  }

  const progress = clamp((local.z + ramp.depth / 2) / ramp.depth, 0, 1);
  return ramp.baseY + ramp.height * progress;
}

function isBlocked(
  room: RoomState,
  player: PlayerState,
  start: { x: number; y: number; z: number },
  end: { x: number; y: number; z: number }
): boolean {
  const collisionHeight = getPlayerCollisionHeight(player);
  const collisionTop = end.y + collisionHeight;

  for (const blocker of room.blockers) {
    if (!blockerOverlapsMovement(start.x, start.z, end.x, end.z, blocker, PLAYER_RADIUS)) {
      continue;
    }

    if (rangesOverlap(end.y + 0.05, collisionTop, blocker.baseY, blocker.topY)) {
      return true;
    }
  }

  return playerHitsCollisionMesh(room, start, end, collisionHeight);
}

function playerHitsCollisionMesh(
  room: RoomState,
  start: { x: number; y: number; z: number },
  end: { x: number; y: number; z: number },
  collisionHeight: number
): boolean {
  if (!room.collisionMeshes.length) {
    return false;
  }

  const heightSamples = [
    end.y + PLAYER_COLLISION_SAMPLE_PADDING,
    end.y + (collisionHeight / 2),
    end.y + Math.max(PLAYER_COLLISION_SAMPLE_PADDING, collisionHeight - PLAYER_COLLISION_SAMPLE_PADDING)
  ];
  const radialOffsets = [
    { x: 0, z: 0 },
    { x: PLAYER_RADIUS, z: 0 },
    { x: -PLAYER_RADIUS, z: 0 },
    { x: 0, z: PLAYER_RADIUS },
    { x: 0, z: -PLAYER_RADIUS },
    { x: PLAYER_RADIUS * 0.7071, z: PLAYER_RADIUS * 0.7071 },
    { x: -PLAYER_RADIUS * 0.7071, z: PLAYER_RADIUS * 0.7071 },
    { x: PLAYER_RADIUS * 0.7071, z: -PLAYER_RADIUS * 0.7071 },
    { x: -PLAYER_RADIUS * 0.7071, z: -PLAYER_RADIUS * 0.7071 }
  ];

  for (const height of heightSamples) {
    const relativeHeight = height - end.y;
    for (const offset of radialOffsets) {
      const sampleStart = {
        x: start.x + offset.x,
        y: start.y + relativeHeight,
        z: start.z + offset.z
      };
      const sampleEnd = {
        x: end.x + offset.x,
        y: height,
        z: end.z + offset.z
      };

      if (nativeCoreAvailable && room.collisionTriangleBuffer.length) {
        if (findSegmentImpactNative(room.collisionTriangleBuffer, sampleStart, sampleEnd, 0)) {
          return true;
        }
        continue;
      }

      if (findCollisionMeshImpact(room, sampleStart, sampleEnd, 0)) {
        return true;
      }
    }
  }

  return false;
}

function getPlayerCollisionHeight(player: PlayerState): number {
  return Math.max(
    HECTOR_MIN_HEAD_HEIGHT + player.rideHeight,
    (player.stance - player.crouch) + player.rideHeight + PLAYER_COLLISION_TOP_PADDING
  );
}

function blockerOverlapsMovement(
  startX: number,
  startZ: number,
  endX: number,
  endZ: number,
  blocker: Pick<RectSurface, "x" | "z" | "width" | "depth" | "yaw">,
  padding: number
): boolean {
  if (pointInRotatedRect(startX, startZ, blocker.x, blocker.z, blocker.width / 2 + padding, blocker.depth / 2 + padding, blocker.yaw)) {
    return true;
  }
  if (pointInRotatedRect(endX, endZ, blocker.x, blocker.z, blocker.width / 2 + padding, blocker.depth / 2 + padding, blocker.yaw)) {
    return true;
  }

  const deltaX = endX - startX;
  const deltaZ = endZ - startZ;
  const distance = Math.hypot(deltaX, deltaZ);
  if (distance <= 0.000001) {
    return false;
  }

  const hit = rayIntersectRotatedRect(startX, startZ, deltaX / distance, deltaZ / distance, blocker, padding);
  return hit !== null && hit <= distance;
}

function rangesOverlap(minA: number, maxA: number, minB: number, maxB: number): boolean {
  return minA <= maxB && maxA >= minB;
}

function processRespawns(room: RoomState): void {
  for (const player of room.players.values()) {
    if (player.alive || room.tick < player.respawnAtTick) {
      continue;
    }

    const respawned = spawnFreshPlayer(room, player.id, player.displayName, {
      kills: player.kills,
      deaths: player.deaths
    });
    room.players.set(player.id, respawned);
    addEvent(room, {
      event: "respawn",
      actorPlayerId: player.id,
      message: `${player.displayName} respawned`
    });
  }
}

function toggleScoutView(room: RoomState, player: PlayerState): void {
  if (!player.scoutView && (!player.scoutId || !room.scouts.has(player.scoutId))) {
    issueScoutCommand(room, player, "follow");
  }

  player.scoutView = !player.scoutView;

  if (player.scoutView && (!player.scoutId || !room.scouts.has(player.scoutId))) {
    player.scoutView = false;
  }
}

function issueScoutCommand(room: RoomState, player: PlayerState, command: ScoutCommand): void {
  const existingScout = player.scoutId ? room.scouts.get(player.scoutId) : undefined;
  if (!existingScout) {
    if (command === "down") {
      return;
    }

    const spawnedScout = spawnScout(room, player, command);
    if (spawnedScout) {
      room.scouts.set(spawnedScout.id, spawnedScout);
      player.scoutId = spawnedScout.id;
    }
    return;
  }

  existingScout.action = command;
}

function spawnScout(room: RoomState, player: PlayerState, command: ScoutCommand): ScoutState | null {
  const scoutBaseHeight = getScoutBaseHeight(player);
  const spawnY = player.y + scoutBaseHeight;
  const spawnState: ScoutState = {
    id: `scout_${crypto.randomUUID()}`,
    ownerPlayerId: player.id,
    ownerName: player.displayName,
    x: player.x,
    y: spawnY,
    z: player.z,
    targetX: player.x,
    targetY: player.y + scoutBaseHeight + SCOUT_HEIGHT,
    targetZ: player.z,
    vx: player.vx,
    vy: player.vy,
    vz: player.vz,
    heading: 0,
    health: SCOUT_SHIELD,
    action: command,
    nextRotateFlag: true
  };

  const spawnBlocked = findBlockerImpact(
    room,
    SCOUT_COLLISION_RADIUS,
    { x: spawnState.x, y: spawnState.y, z: spawnState.z },
    { x: spawnState.x, y: spawnState.y, z: spawnState.z }
  );
  if (spawnBlocked) {
    return null;
  }

  return spawnState;
}

function removeScoutForPlayer(room: RoomState, playerId: string): void {
  for (const scout of room.scouts.values()) {
    if (scout.ownerPlayerId === playerId) {
      removeScout(room, scout, false);
      break;
    }
  }
}

function removeScout(room: RoomState, scout: ScoutState, forceViewOff: boolean): void {
  room.scouts.delete(scout.id);
  const owner = room.players.get(scout.ownerPlayerId);
  if (!owner) {
    return;
  }

  if (owner.scoutId === scout.id) {
    owner.scoutId = undefined;
  }
  if (forceViewOff || owner.scoutView) {
    owner.scoutView = false;
  }
}

function getScoutBaseHeight(player: PlayerState): number {
  return (player.stance || HECTOR_DEFAULT_STANCE) + SCOUT_SPAWN_PLATFORM;
}

function expireDisconnectedPlayers(room: RoomState): void {
  for (const [playerId, player] of room.players.entries()) {
    if (room.tick - player.lastSeenTick <= DISCONNECT_GRACE_TICKS) {
      continue;
    }

    removeScoutForPlayer(room, playerId);
    room.players.delete(playerId);
    addEvent(room, {
      event: "respawn",
      actorPlayerId: playerId,
      message: `${player.displayName} disconnected`
    });
  }

  if (!room.players.size && room.status === "active") {
    room.status = "waiting";
    room.startedAtTick = null;
  }
}

function processPickups(room: RoomState): void {
  for (const pickup of room.pickups) {
    if (!pickup.available) {
      if (room.tick >= pickup.respawnAtTick) {
        pickup.available = true;
      }
      continue;
    }

    for (const player of room.players.values()) {
      if (!player.alive) {
        continue;
      }

      const distance = Math.hypot(player.x - pickup.x, player.z - pickup.z);
      if (distance > 2.5 || Math.abs(player.y - pickup.y) > 2.6) {
        continue;
      }

      const beforeMissiles = player.missileAmmo;
      const beforeGrenades = player.grenadeAmmo;
      player.missileAmmo = clamp(player.missileAmmo + pickup.missiles, 0, player.missileLimit);
      player.grenadeAmmo = clamp(player.grenadeAmmo + pickup.grenades, 0, player.grenadeLimit);
      if (player.weaponLoad === "cannon") {
        if (pickup.kind === "missiles" && player.missileAmmo > beforeMissiles) {
          player.weaponLoad = "missile";
        }
        if (pickup.kind === "grenades" && player.grenadeAmmo > beforeGrenades) {
          player.weaponLoad = "grenade";
        }
      }

      pickup.available = false;
      pickup.respawnAtTick = room.tick + PICKUP_RESPAWN_TICKS;
      addEvent(room, {
        event: "pickup",
        actorPlayerId: player.id,
        message: `${player.displayName} collected ${describePickup(pickup)}`
      });
      break;
    }
  }
}

function fireWeapon(room: RoomState, player: PlayerState): void {
  if (!player.alive || room.tick < player.nextFireTick || room.status !== "active") {
    return;
  }

  switch (player.weaponLoad) {
    case "missile":
      player.weaponLoad = "cannon";
      player.nextFireTick = room.tick + framesFromClassic(1, tickDeltaScale());
      spawnProjectile(room, player, "missile");
      return;
    case "grenade":
      player.weaponLoad = "cannon";
      player.nextFireTick = room.tick + framesFromClassic(1, tickDeltaScale());
      spawnProjectile(room, player, "grenade");
      return;
    default:
      break;
  }

  const gunIndex = player.gunEnergyLeft < player.gunEnergyRight ? "right" : "left";
  const availableEnergy = gunIndex === "left" ? player.gunEnergyLeft : player.gunEnergyRight;
  if (availableEnergy < player.activeGunEnergy) {
    return;
  }

  if (gunIndex === "left") {
    player.gunEnergyLeft = 0;
  } else {
    player.gunEnergyRight = 0;
  }

  player.weaponLoad = "cannon";
  player.nextFireTick = room.tick + framesFromClassic(1, tickDeltaScale());
  spawnProjectile(room, player, "plasma", availableEnergy, gunIndex === "left");
}

function loadWeapon(room: RoomState, player: PlayerState, weapon: Exclude<WeaponLoad, "cannon">): void {
  if (!player.alive) {
    return;
  }

  if (weapon === "missile" && (player.missileAmmo <= 0 || room.tick < player.nextMissileLoadTick)) {
    return;
  }
  if (weapon === "grenade" && (player.grenadeAmmo <= 0 || room.tick < player.nextGrenadeLoadTick)) {
    return;
  }
  if (player.weaponLoad === weapon) {
    return;
  }

  if (player.weaponLoad === "missile") {
    player.missileAmmo = Math.min(player.missileLimit, player.missileAmmo + 1);
  }
  if (player.weaponLoad === "grenade") {
    player.grenadeAmmo = Math.min(player.grenadeLimit, player.grenadeAmmo + 1);
  }

  if (weapon === "missile") {
    player.missileAmmo -= 1;
    player.nextMissileLoadTick = room.tick + framesFromClassic(MISSILE_LOAD_CLASSIC_FRAMES, tickDeltaScale());
  } else {
    player.grenadeAmmo -= 1;
    player.nextGrenadeLoadTick = room.tick + framesFromClassic(GRENADE_LOAD_CLASSIC_FRAMES, tickDeltaScale());
  }
  player.weaponLoad = weapon;
  addEvent(room, {
    event: "weapon_load",
    actorPlayerId: player.id,
    message: `${player.displayName} loaded ${weapon}`
  });
}

function spawnProjectile(
  room: RoomState,
  player: PlayerState,
  kind: ProjectileKind,
  energy = 0,
  leftGun = false
): void {
  const fpsScale = tickDeltaScale();
  const forward = directionFromYawPitch(player.turretYaw, player.turretPitch);
  const up = upVectorFromYawPitch(player.turretYaw, player.turretPitch);
  const right = rightVectorFromYawPitch(player.turretYaw, player.turretPitch);
  const isGrenade = kind === "grenade";
  const isMissile = kind === "missile";
  const isPlasma = kind === "plasma";
  const shape = isPlasma ? BSP_PLASMA : isMissile ? BSP_MISSILE : BSP_GRENADE;
  const mountOffset = isPlasma
    ? { x: leftGun ? GUN_MOUNT_OFFSET_X : -GUN_MOUNT_OFFSET_X, y: GUN_MOUNT_OFFSET_Y, z: GUN_MOUNT_OFFSET_Z }
    : isMissile
      ? SMART_MISSILE_MOUNT_OFFSET
      : GRENADE_MOUNT_OFFSET;
  const launchOrigin = computeProjectileMountOrigin(player, mountOffset, forward, up, right, isPlasma);
  const initialVelocity = isGrenade
    ? {
        x: player.vx + up.x + 2 * forward.x,
        y: player.vy + up.y + 2 * forward.y,
        z: player.vz + up.z + 2 * forward.z - fpsOffset(HECTOR_GRAVITY * room.settings.gravity, fpsScale)
      }
    : isMissile
      ? {
          x: player.vx,
          y: player.vy,
          z: player.vz
        }
      : {
          x: player.vx + forward.x * PLAYER_PLASMA_SPEED,
          y: player.vy + forward.y * PLAYER_PLASMA_SPEED,
          z: player.vz + forward.z * PLAYER_PLASMA_SPEED
        };

  room.projectiles.push({
    id: `projectile_${crypto.randomUUID()}`,
    ownerId: player.id,
    ownerName: player.displayName,
    kind,
    x: launchOrigin.x,
    y: launchOrigin.y,
    z: launchOrigin.z,
    vx: initialVelocity.x,
    vy: initialVelocity.y,
    vz: initialVelocity.z,
    remainingTicks: framesFromClassic(
      isPlasma
        ? PLAYER_PLASMA_LIFETIME_CLASSIC_FRAMES
        : isMissile
          ? MISSILE_LIFETIME_CLASSIC_FRAMES
          : GRENADE_LIFETIME_CLASSIC_FRAMES,
      fpsScale
    ),
    directDamage: isPlasma ? energy : 0,
    blastPower: isMissile ? room.settings.missilePower : isGrenade ? room.settings.grenadePower : 0,
    gravity: isGrenade ? fpsCoefficient2(HECTOR_GRAVITY * room.settings.gravity, fpsScale) : 0,
    friction: isGrenade ? fpsCoefficient1(GRENADE_FRICTION, fpsScale) : 1,
    collisionRadius: isPlasma ? PLAYER_PLASMA_COLLISION_RADIUS : isMissile ? MISSILE_COLLISION_RADIUS : GRENADE_COLLISION_RADIUS,
    yaw: player.turretYaw,
    pitch: player.turretPitch,
    roll: 0,
    spin: isPlasma ? (leftGun ? PLASMA_SPIN_RADIANS : -PLASMA_SPIN_RADIANS) : 0,
    turnRate: isMissile ? room.settings.missileTurnRate * Math.PI * 2 : 0,
    thrust: isMissile ? room.settings.missileAcceleration : 0,
    targetPlayerId: isMissile ? acquireMissileTarget(room, player, forward) : undefined,
    hostGraceTicks: isPlasma ? 0 : framesFromClassic(MISSILE_HOST_GRACE_CLASSIC_FRAMES, fpsScale),
    shapeId: shape.shapeId,
    shapeKey: shape.shapeKey,
    shapeAssetUrl: shape.shapeAssetUrl,
    scale: 1
  });
}

function simulateProjectiles(room: RoomState, _dt: number): void {
  const fpsScale = tickDeltaScale();
  const survivors: ProjectileState[] = [];

  for (const projectile of room.projectiles) {
    const start = { x: projectile.x, y: projectile.y, z: projectile.z };

    if (projectile.kind === "missile") {
      steerSmartMissile(room, projectile, fpsScale);
    } else if (projectile.kind === "grenade") {
      projectile.vx *= projectile.friction;
      projectile.vy = projectile.vy * projectile.friction - projectile.gravity;
      projectile.vz *= projectile.friction;
    }

    projectile.hostGraceTicks = Math.max(0, projectile.hostGraceTicks - 1);
    const end = {
      x: start.x + fpsCoefficient2(projectile.vx, fpsScale),
      y: start.y + fpsCoefficient2(projectile.vy, fpsScale),
      z: start.z + fpsCoefficient2(projectile.vz, fpsScale)
    };
    projectile.roll += fpsCoefficient2(projectile.spin, fpsScale);
    projectile.remainingTicks -= 1;

    const impact = findProjectileImpact(room, projectile, start, end);
    if (impact) {
      projectile.x = impact.x;
      projectile.y = impact.y;
      projectile.z = impact.z;
      if (impact.player && projectile.kind === "plasma" && projectile.directDamage > 0) {
        applyDamage(
          room,
          impact.player,
          shieldUnitsToHealth(projectile.directDamage, impact.player.maxShields),
          room.players.get(projectile.ownerId) ?? null
        );
      } else if (impact.scout && projectile.kind === "plasma" && projectile.directDamage > 0) {
        applyScoutDamage(
          room,
          impact.scout,
          shieldUnitsToHealth(projectile.directDamage, SCOUT_SHIELD),
          room.players.get(projectile.ownerId) ?? null
        );
      } else if (projectile.kind !== "plasma") {
        explodeProjectile(room, projectile);
      }
      continue;
    }

    projectile.x = end.x;
    projectile.y = end.y;
    projectile.z = end.z;
    projectile.yaw = Math.atan2(projectile.vz, projectile.vx);
    projectile.pitch = Math.atan2(projectile.vy, Math.hypot(projectile.vx, projectile.vz) || 1);

    const expired = projectile.remainingTicks <= 0 || projectileOutsideBounds(room, projectile);
    if (expired) {
      if (projectile.kind !== "plasma") {
        explodeProjectile(room, projectile);
      }
      continue;
    }

    survivors.push(projectile);
  }

  room.projectiles = survivors;
}

function acquireMissileTarget(room: RoomState, player: PlayerState, forward: { x: number; y: number; z: number }): string | undefined {
  const target = findTargetInCone(
    room,
    { x: player.x, y: player.y + PLAYER_HIT_CENTER_Y, z: player.z },
    forward,
    player.id
  );
  return target?.id;
}

function steerSmartMissile(room: RoomState, projectile: ProjectileState, fpsScale: number): void {
  let target = projectile.targetPlayerId ? room.players.get(projectile.targetPlayerId) : undefined;
  if (!target?.alive) {
    target = findTargetInCone(
      room,
      { x: projectile.x, y: projectile.y, z: projectile.z },
      directionFromYawPitch(projectile.yaw, projectile.pitch),
      projectile.ownerId
    );
    projectile.targetPlayerId = target?.id;
  }

  let targetYaw = projectile.yaw;
  let targetPitch = projectile.pitch;
  let thrust = projectile.thrust;

  if (target?.alive) {
    const toTarget = {
      x: target.x - projectile.x - projectile.vx * 2,
      y: target.y + PLAYER_HIT_CENTER_Y - projectile.y - projectile.vy * 2,
      z: target.z - projectile.z - projectile.vz * 2
    };
    const distance = Math.hypot(toTarget.x, toTarget.y, toTarget.z);
    if (
      distance <= SMART_MISSILE_TARGET_RANGE
      && !rayBlocked(
        room,
        { x: projectile.x, y: projectile.y, z: projectile.z },
        { x: target.x, y: target.y + PLAYER_HIT_CENTER_Y, z: target.z }
      )
    ) {
      targetYaw = Math.atan2(toTarget.z, toTarget.x);
      targetPitch = Math.atan2(toTarget.y, Math.hypot(toTarget.x, toTarget.z) || 1);
      if (distance < SMART_MISSILE_EXPLODE_RANGE) {
        projectile.remainingTicks = 0;
      }
      if (distance < 8) {
        thrust *= distance / 8;
      }
    } else {
      projectile.targetPlayerId = undefined;
    }
  }

  const turnStep = fpsCoefficient2(projectile.turnRate, fpsScale);
  projectile.yaw = moveAngleTowards(projectile.yaw, targetYaw, turnStep);
  projectile.pitch = moveScalarTowards(projectile.pitch, targetPitch, turnStep);

  const accel = directionFromYawPitch(projectile.yaw, projectile.pitch);
  const speedLength = Math.hypot(projectile.vx, projectile.vy, projectile.vz);
  const speedDotAccel = speedLength > 0.0001
    ? Math.abs((projectile.vx * accel.x + projectile.vy * accel.y + projectile.vz * accel.z) / speedLength)
    : 1;
  const friction = SMART_MISSILE_FRICTION + ((1 - speedDotAccel) / 8);

  projectile.vx += thrust * accel.x - projectile.vx * friction;
  projectile.vy += thrust * accel.y - projectile.vy * friction;
  projectile.vz += thrust * accel.z - projectile.vz * friction;
}

function findProjectileImpact(
  room: RoomState,
  projectile: ProjectileState,
  start: { x: number; y: number; z: number },
  end: { x: number; y: number; z: number }
): { x: number; y: number; z: number; player?: PlayerState; scout?: ScoutState } | null {
  let bestT = Number.POSITIVE_INFINITY;
  let best: { x: number; y: number; z: number; player?: PlayerState; scout?: ScoutState } | null = null;

  const blockerHit = findBlockerImpact(room, projectile.collisionRadius, start, end);
  if (blockerHit && blockerHit.t < bestT) {
    bestT = blockerHit.t;
    best = blockerHit.point;
  }

  const terrainHit = findTerrainImpact(room, projectile.collisionRadius, start, end);
  if (terrainHit && terrainHit.t < bestT) {
    bestT = terrainHit.t;
    best = terrainHit.point;
  }

  const playerHit = findPlayerImpact(room, projectile, start, end);
  if (playerHit && playerHit.t < bestT) {
    bestT = playerHit.t;
    best = playerHit.point;
  }

  const scoutHit = findScoutImpact(room, projectile, start, end);
  if (scoutHit && scoutHit.t < bestT) {
    bestT = scoutHit.t;
    best = scoutHit.point;
  }

  return best;
}

function findBlockerImpact(
  room: RoomState,
  radius: number,
  start: { x: number; y: number; z: number },
  end: { x: number; y: number; z: number }
): { t: number; point: { x: number; y: number; z: number } } | null {
  if (nativeCoreAvailable && room.collisionTriangleBuffer.length) {
    const nativeHit = findSegmentImpactNative(room.collisionTriangleBuffer, start, end, radius);
    if (nativeHit) {
      return {
        t: nativeHit.t,
        point: {
          x: nativeHit.x,
          y: nativeHit.y,
          z: nativeHit.z
        }
      };
    }
  }

  const meshHit = findCollisionMeshImpact(room, start, end, radius);
  if (meshHit) {
    return meshHit;
  }

  let best: { t: number; point: { x: number; y: number; z: number } } | null = null;

  for (const blocker of room.blockers) {
    const localStart = toLocalPoint(start.x, start.z, blocker.x, blocker.z, blocker.yaw);
    const localEnd = toLocalPoint(end.x, end.z, blocker.x, blocker.z, blocker.yaw);
    const hitT = segmentAabbIntersectionT(
      { x: localStart.x, y: start.y, z: localStart.z },
      { x: localEnd.x, y: end.y, z: localEnd.z },
      {
        minX: -(blocker.width / 2) - radius,
        maxX: blocker.width / 2 + radius,
        minY: blocker.baseY - radius,
        maxY: blocker.topY + radius,
        minZ: -(blocker.depth / 2) - radius,
        maxZ: blocker.depth / 2 + radius
      }
    );

    if (hitT === null) {
      continue;
    }

    const point = lerpPoint3(start, end, hitT);
    if (!best || hitT < best.t) {
      best = { t: hitT, point };
    }
  }

  return best;
}

function findTerrainImpact(
  room: RoomState,
  radius: number,
  start: { x: number; y: number; z: number },
  end: { x: number; y: number; z: number }
): { t: number; point: { x: number; y: number; z: number } } | null {
  const samples = 12;
  let previous = { t: 0, point: start };

  for (let index = 1; index <= samples; index += 1) {
    const t = index / samples;
    const point = lerpPoint3(start, end, t);
    const floor = sampleFloorHeight(room, point.x, point.z, point.y);
    if (point.y <= floor + radius) {
      let low = previous.t;
      let high = t;

      for (let iteration = 0; iteration < 6; iteration += 1) {
        const mid = (low + high) / 2;
        const midPoint = lerpPoint3(start, end, mid);
        const midFloor = sampleFloorHeight(room, midPoint.x, midPoint.z, midPoint.y);
        if (midPoint.y <= midFloor + radius) {
          high = mid;
        } else {
          low = mid;
        }
      }

      const hitPoint = lerpPoint3(start, end, high);
      const hitFloor = sampleFloorHeight(room, hitPoint.x, hitPoint.z, hitPoint.y);
      return {
        t: high,
        point: {
          x: hitPoint.x,
          y: hitFloor + radius,
          z: hitPoint.z
        }
      };
    }
    previous = { t, point };
  }

  return null;
}

function findPlayerImpact(
  room: RoomState,
  projectile: ProjectileState,
  start: { x: number; y: number; z: number },
  end: { x: number; y: number; z: number }
): { t: number; point: { x: number; y: number; z: number; player?: PlayerState } } | null {
  let best: { t: number; point: { x: number; y: number; z: number; player?: PlayerState } } | null = null;

  for (const player of room.players.values()) {
    if (!player.alive) {
      continue;
    }
    if (player.id === projectile.ownerId) {
      if (projectile.kind === "plasma") {
        continue;
      }
      if (projectile.hostGraceTicks > 0) {
        continue;
      }
    }

    const t = segmentSphereIntersectionT(
      start,
      end,
      { x: player.x, y: player.y + PLAYER_HIT_CENTER_Y, z: player.z },
      PLAYER_HIT_RADIUS + projectile.collisionRadius
    );

    if (t === null) {
      continue;
    }

    const point = lerpPoint3(start, end, t);
    if (!best || t < best.t) {
      best = {
        t,
        point: {
          x: point.x,
          y: point.y,
          z: point.z,
          player
        }
      };
    }
  }

  return best;
}

function findScoutImpact(
  room: RoomState,
  projectile: ProjectileState,
  start: { x: number; y: number; z: number },
  end: { x: number; y: number; z: number }
): { t: number; point: { x: number; y: number; z: number; scout?: ScoutState } } | null {
  let best: { t: number; point: { x: number; y: number; z: number; scout?: ScoutState } } | null = null;

  for (const scout of room.scouts.values()) {
    if (scout.ownerPlayerId === projectile.ownerId) {
      if (projectile.kind === "plasma") {
        continue;
      }
      if (projectile.hostGraceTicks > 0) {
        continue;
      }
    }

    const t = segmentSphereIntersectionT(
      start,
      end,
      { x: scout.x, y: scout.y, z: scout.z },
      SCOUT_COLLISION_RADIUS + projectile.collisionRadius
    );

    if (t === null) {
      continue;
    }

    const point = lerpPoint3(start, end, t);
    if (!best || t < best.t) {
      best = {
        t,
        point: {
          x: point.x,
          y: point.y,
          z: point.z,
          scout
        }
      };
    }
  }

  return best;
}

function findTargetInCone(
  room: RoomState,
  origin: { x: number; y: number; z: number },
  forward: { x: number; y: number; z: number },
  ownerId: string
): PlayerState | undefined {
  let best: { player: PlayerState; score: number } | undefined;

  for (const candidate of room.players.values()) {
    if (!candidate.alive || candidate.id === ownerId) {
      continue;
    }

    const dx = candidate.x - origin.x;
    const dy = (candidate.y + PLAYER_HIT_CENTER_Y) - origin.y;
    const dz = candidate.z - origin.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance <= 0.0001 || distance > SMART_MISSILE_TARGET_RANGE) {
      continue;
    }

    const dirX = dx / distance;
    const dirY = dy / distance;
    const dirZ = dz / distance;
    const alignment = dirX * forward.x + dirY * forward.y + dirZ * forward.z;
    if (alignment < 0.72) {
      continue;
    }
    if (
      rayBlocked(
        room,
        origin,
        { x: candidate.x, y: candidate.y + PLAYER_HIT_CENTER_Y, z: candidate.z }
      )
    ) {
      continue;
    }

    const score = alignment * 1000 - distance;
    if (!best || score > best.score) {
      best = { player: candidate, score };
    }
  }

  return best?.player;
}

function findTargetAlongRay(
  room: RoomState,
  origin: Vec3,
  forward: Vec3,
  ownerId: string,
  maxDistance: number
): PlayerState | undefined {
  const end = {
    x: origin.x + forward.x * maxDistance,
    y: origin.y + forward.y * maxDistance,
    z: origin.z + forward.z * maxDistance
  };
  const obstacleDistance = nearestObstacleRayDistance(room, origin, end) ?? maxDistance;
  let bestTarget: PlayerState | undefined;
  let bestDistance = Math.min(maxDistance, obstacleDistance);

  for (const candidate of room.players.values()) {
    if (!candidate.alive || candidate.id === ownerId) {
      continue;
    }

    const targetCenter = {
      x: candidate.x,
      y: candidate.y + PLAYER_HIT_CENTER_Y,
      z: candidate.z
    };
    const t = segmentSphereIntersectionT(origin, end, targetCenter, PLAYER_HIT_RADIUS);
    if (t === null) {
      continue;
    }

    const distance = maxDistance * t;
    if (distance > bestDistance) {
      continue;
    }

    bestDistance = distance;
    bestTarget = candidate;
  }

  return bestTarget;
}

function computePlayerTargetLock(room: RoomState, player: PlayerState): boolean {
  if (!player.alive) {
    return false;
  }

  const forward = directionFromYawPitch(player.turretYaw, player.turretPitch);
  const up = upVectorFromYawPitch(player.turretYaw, player.turretPitch);
  const right = rightVectorFromYawPitch(player.turretYaw, player.turretPitch);

  if (player.weaponLoad === "missile") {
    const missileOrigin = computeProjectileMountOrigin(
      player,
      SMART_MISSILE_MOUNT_OFFSET,
      forward,
      up,
      right,
      false
    );
    return Boolean(findTargetAlongRay(room, missileOrigin, forward, player.id, SMART_MISSILE_TARGET_RANGE));
  }

  const leftGunOrigin = computeProjectileMountOrigin(
    player,
    { x: -GUN_MOUNT_OFFSET_X, y: GUN_MOUNT_OFFSET_Y, z: GUN_MOUNT_OFFSET_Z },
    forward,
    up,
    right,
    false
  );
  if (findTargetAlongRay(room, leftGunOrigin, forward, player.id, PLAYER_PLASMA_RANGE)) {
    return true;
  }

  const rightGunOrigin = computeProjectileMountOrigin(
    player,
    { x: GUN_MOUNT_OFFSET_X, y: GUN_MOUNT_OFFSET_Y, z: GUN_MOUNT_OFFSET_Z },
    forward,
    up,
    right,
    false
  );
  return Boolean(findTargetAlongRay(room, rightGunOrigin, forward, player.id, PLAYER_PLASMA_RANGE));
}

function rayBlocked(room: RoomState, origin: Vec3, target: Vec3): boolean {
  const distance = distanceBetween(origin, target);
  if (distance <= 0.000001) {
    return false;
  }

  const blockedDistance = nearestObstacleRayDistance(room, origin, target);
  return blockedDistance !== null && blockedDistance < distance;
}

function explodeProjectile(room: RoomState, projectile: ProjectileState): void {
  const owner = room.players.get(projectile.ownerId);
  const blastRadius = Math.sqrt(Math.max(projectile.blastPower, 0) * 64);
  for (const player of room.players.values()) {
    if (!player.alive) {
      continue;
    }

    const distance = Math.max(1, Math.hypot(player.x - projectile.x, player.y - projectile.y, player.z - projectile.z) - PLAYER_RADIUS);
    if (distance > blastRadius) {
      continue;
    }

    const blastEnergy = projectile.blastPower / (distance * distance);
    if (blastEnergy > 1 / 64) {
      applyDamage(room, player, shieldUnitsToHealth(blastEnergy, player.maxShields), owner ?? null);
    }
  }

  for (const scout of room.scouts.values()) {
    const distance = Math.max(1, Math.hypot(scout.x - projectile.x, scout.y - projectile.y, scout.z - projectile.z) - SCOUT_COLLISION_RADIUS);
    if (distance > blastRadius) {
      continue;
    }

    const blastEnergy = projectile.blastPower / (distance * distance);
    if (blastEnergy > 1 / 64) {
      applyScoutDamage(room, scout, shieldUnitsToHealth(blastEnergy, SCOUT_SHIELD), owner ?? null);
    }
  }
}

function applyScoutDamage(room: RoomState, target: ScoutState, amount: number, attacker: PlayerState | null): void {
  if (amount <= 0) {
    return;
  }

  target.health = Math.max(0, target.health - amount);
  addEvent(room, {
    event: "damage",
    actorPlayerId: attacker?.id,
    targetPlayerId: target.ownerPlayerId,
    message: attacker
      ? `${attacker.displayName} hit ${target.ownerName}'s scout for ${amount}`
      : `${target.ownerName}'s scout took ${amount} damage`
  });

  if (target.health > 0) {
    return;
  }

  addEvent(room, {
    event: "damage",
    actorPlayerId: attacker?.id,
    targetPlayerId: target.ownerPlayerId,
    message: attacker
      ? `${attacker.displayName} destroyed ${target.ownerName}'s scout`
      : `${target.ownerName}'s scout was destroyed`
  });
  removeScout(room, target, true);
}

function applyDamage(room: RoomState, target: PlayerState, amount: number, attacker: PlayerState | null): void {
  if (!target.alive || amount <= 0 || room.status === "ended") {
    return;
  }

  target.health = Math.max(0, target.health - amount);
  target.shields = healthToShieldUnits(target.health, target.maxShields);
  addEvent(room, {
    event: "damage",
    actorPlayerId: attacker?.id,
    targetPlayerId: target.id,
    message: attacker ? `${attacker.displayName} hit ${target.displayName} for ${amount}` : `${target.displayName} took ${amount} damage`
  });

  if (target.health > 0) {
    return;
  }

  target.alive = false;
  target.deaths += 1;
  target.weaponLoad = "cannon";
  target.respawnAtTick = room.tick + RESPAWN_TICKS;
  target.input = emptyInput();
  removeScoutForPlayer(room, target.id);

  if (attacker && attacker.id !== target.id) {
    attacker.kills += 1;
  }

  addEvent(room, {
    event: "frag",
    actorPlayerId: attacker?.id,
    targetPlayerId: target.id,
    message: attacker && attacker.id !== target.id
      ? `${attacker.displayName} fragged ${target.displayName}`
      : `${target.displayName} self-destructed`
  });

  if (attacker && attacker.id !== target.id && attacker.kills >= room.fragLimit) {
    endMatch(room, attacker.id, `${attacker.displayName} reached the frag limit`);
  }
}

function maybeCompleteMatchOnTime(room: RoomState): void {
  if (room.startedAtTick === null) {
    return;
  }

  const elapsed = room.tick - room.startedAtTick;
  if (elapsed < room.matchDurationTicks) {
    return;
  }

  const ranking = Array.from(room.players.values()).sort((left, right) => {
    if (left.kills !== right.kills) {
      return right.kills - left.kills;
    }
    return left.deaths - right.deaths;
  });
  const winner = ranking[0];
  endMatch(room, winner?.id, winner ? `${winner.displayName} wins on time` : "Match ended");
}

function endMatch(room: RoomState, winnerPlayerId: string | undefined, message: string): void {
  if (room.status === "ended") {
    return;
  }

  room.status = "ended";
  room.winnerPlayerId = winnerPlayerId;
  room.projectiles = [];
  room.scouts.clear();
  for (const player of room.players.values()) {
    player.scoutView = false;
    player.scoutId = undefined;
    player.input = emptyInput();
  }
  addEvent(room, {
    event: "match_end",
    actorPlayerId: winnerPlayerId,
    message
  });
}

function buildSnapshot(room: RoomState): SnapshotPacket {
  return {
    type: "snapshot",
    tick: room.tick,
    roomId: room.id,
    roomStatus: room.status,
    players: Array.from(room.players.values()).map(toSnapshotPlayer(room)),
    scouts: Array.from(room.scouts.values()).map(toSnapshotScout),
    projectiles: room.projectiles.map(toSnapshotProjectile),
    pickups: room.pickups.map(toSnapshotPickup(room)),
    events: room.events.slice(-8),
    remainingSeconds: getRemainingSeconds(room),
    fragLimit: room.fragLimit,
    winnerPlayerId: room.winnerPlayerId
  };
}

function toSnapshotPlayer(room: RoomState) {
  return (player: PlayerState): SnapshotPlayerState => ({
    id: player.id,
    displayName: player.displayName,
    x: player.x,
    y: player.y,
    z: player.z,
    vx: player.vx,
    vy: player.vy,
    vz: player.vz,
    bodyYaw: player.bodyYaw,
    turretYaw: player.turretYaw,
    turretPitch: player.turretPitch,
    leftMotor: player.leftMotor,
    rightMotor: player.rightMotor,
    crouch: player.crouch,
    stance: player.stance,
    health: player.health,
    alive: player.alive,
    kills: player.kills,
    deaths: player.deaths,
    missileAmmo: player.missileAmmo,
    grenadeAmmo: player.grenadeAmmo,
    boostsRemaining: player.boostsRemaining,
    weaponLoad: player.weaponLoad,
    energy: player.energy,
    shields: player.shields,
    gunEnergyLeft: player.gunEnergyLeft,
    gunEnergyRight: player.gunEnergyRight,
    targetLocked: computePlayerTargetLock(room, player),
    respawnSeconds: player.alive ? 0 : Math.max(0, Math.ceil((player.respawnAtTick - room.tick) / tickRate)),
    scoutView: player.scoutView,
    scoutId: player.scoutId,
    shapeId: player.hullShapeId,
    shapeKey: player.hullShapeKey,
    shapeAssetUrl: player.hullShapeAssetUrl,
    rideHeight: player.rideHeight
  });
}

function toSnapshotScout(scout: ScoutState): SnapshotScoutState {
  return {
    id: scout.id,
    ownerPlayerId: scout.ownerPlayerId,
    x: scout.x,
    y: scout.y,
    z: scout.z,
    heading: scout.heading,
    health: scout.health,
    active: scout.action !== "inactive",
    action: scout.action,
    ...BSP_SCOUT
  };
}

function toSnapshotProjectile(projectile: ProjectileState): SnapshotProjectileState {
  return {
    id: projectile.id,
    ownerId: projectile.ownerId,
    kind: projectile.kind,
    x: projectile.x,
    y: projectile.y,
    z: projectile.z,
    yaw: projectile.yaw,
    pitch: projectile.pitch,
    roll: projectile.roll,
    shapeId: projectile.shapeId,
    shapeKey: projectile.shapeKey,
    shapeAssetUrl: projectile.shapeAssetUrl,
    scale: projectile.scale
  };
}

function toSnapshotPickup(room: RoomState) {
  return (pickup: PickupState): SnapshotPickupState => ({
    id: pickup.id,
    kind: pickup.kind,
    x: pickup.x,
    y: pickup.y,
    z: pickup.z,
    available: pickup.available,
    respawnSeconds: pickup.available ? 0 : Math.max(0, Math.ceil((pickup.respawnAtTick - room.tick) / tickRate)),
    shapeId: pickup.shapeId,
    shapeKey: pickup.shapeKey,
    shapeAssetUrl: pickup.shapeAssetUrl,
    scale: pickup.scale,
    color: pickup.color,
    accentColor: pickup.accentColor
  });
}

function spawnFreshPlayer(
  room: RoomState,
  playerId: string,
  displayName: string,
  carry?: Pick<PlayerState, "kills" | "deaths">
): PlayerState {
  const spawn = room.spawnPoints[room.nextSpawnIndex % room.spawnPoints.length];
  room.nextSpawnIndex += 1;
  const groundedY = sampleFloorHeight(room, spawn.x, spawn.z, spawn.y);
  const hull = getRoomHullSettings(room.settings);
  const missileLimit = Math.min(room.settings.maxStartMissiles, hull.maxMissiles);
  const grenadeLimit = Math.min(room.settings.maxStartGrenades, hull.maxGrenades);
  const boosterLimit = Math.min(room.settings.maxStartBoosts, hull.maxBoosters);
  const maxEnergy = HECTOR_MAX_ENERGY * hull.energyRatio;
  const maxShields = HECTOR_MAX_SHIELDS * hull.shieldsRatio;
  const fullGunEnergy = HECTOR_FULL_GUN_ENERGY * hull.maxShotRatio;
  const activeGunEnergy = HECTOR_ACTIVE_GUN_ENERGY * hull.minShotRatio;
  const hullShapeId = hull.shapeId;

  const player: PlayerState = {
    id: playerId,
    displayName,
    x: spawn.x,
    y: groundedY,
    z: spawn.z,
    vx: 0,
    vy: 0,
    vz: 0,
    leftMotor: 0,
    rightMotor: 0,
    bodyYaw: spawn.yaw,
    turretYaw: spawn.yaw,
    turretPitch: 0,
    health: 100,
    shields: maxShields,
    energy: maxEnergy,
    gunEnergyLeft: fullGunEnergy,
    gunEnergyRight: fullGunEnergy,
    alive: true,
    kills: carry?.kills ?? 0,
    deaths: carry?.deaths ?? 0,
    missileAmmo: missileLimit,
    grenadeAmmo: grenadeLimit,
    boostsRemaining: boosterLimit,
    weaponLoad: "cannon",
    respawnAtTick: 0,
    nextFireTick: room.tick + framesFromClassic(1, tickDeltaScale()),
    nextMissileLoadTick: room.tick,
    nextGrenadeLoadTick: room.tick,
    boostEndTick: room.tick,
    jumpPressed: false,
    jumpReleased: false,
    boostPressed: false,
    crouch: 0,
    stance: HECTOR_DEFAULT_STANCE,
    jumpFlag: false,
    tractionFlag: true,
    oldTractionFlag: true,
    scoutView: false,
    scoutId: undefined,
    lastSeenTick: room.tick,
    mass: hull.mass,
    baseMass: HECTOR_BASE_MASS,
    maxAcceleration: HECTOR_CLASSIC_ACCELERATION * hull.accelerationRatio,
    jumpBasePower: HECTOR_JUMP_BASE_POWER * hull.jumpPowerRatio,
    maxEnergy,
    maxShields,
    fullGunEnergy,
    activeGunEnergy,
    classicGeneratorPower: HECTOR_CLASSIC_GENERATOR_POWER * hull.energyChargeRatio,
    classicShieldRegen: HECTOR_CLASSIC_SHIELD_REGEN * hull.shieldsChargeRatio,
    classicGunRecharge: HECTOR_CLASSIC_GUN_RECHARGE * hull.shotChargeRatio,
    missileLimit,
    grenadeLimit,
    boosterLimit,
    rideHeight: hull.rideHeight,
    hullShapeId,
    hullShapeKey: getHullShapeKey(hullShapeId),
    hullShapeAssetUrl: getHullShapeAssetUrl(hullShapeId),
    didBump: false,
    supportTraction: room.settings.defaultTraction,
    supportFriction: room.settings.defaultFriction,
    distance: 0,
    headChange: 0,
    targetHeight: groundedY,
    absAvgSpeed: 0,
    legPhase: 0,
    speedLimit: 0,
    legs: [
      { x: 0, y: 0, whereX: spawn.x, whereY: groundedY, whereZ: spawn.z, touching: true },
      { x: 0, y: 0, whereX: spawn.x, whereY: groundedY, whereZ: spawn.z, touching: true }
    ],
    input: emptyInput()
  };

  updateWalkerLegContacts(room, player, tickDeltaScale());
  updateWalkerSupportFromFeet(room, player);
  return player;
}

function deriveSpawnPoints(nodes: SceneNode[]): SpawnPoint[] {
  const spawns = nodes
    .filter((node) => node.type === "spawn")
    .map((node) => ({
      x: node.position.x,
      y: node.position.y,
      z: node.position.z,
      yaw: toRadians(node.rotation?.yaw ?? 0)
    }));

  return spawns.length ? spawns : [{ x: 0, y: 0, z: 0, yaw: 0 }];
}

function deriveBlockers(nodes: SceneNode[]): RectSurface[] {
  const wallBlockers = nodes
    .filter((node) => node.type === "wall" || node.type === "door")
    .map((node) => deriveWallOrDoorBlocker(node))
    .filter((blocker): blocker is RectSurface => blocker !== null);

  const shapeBlockers = nodes
    .filter((node) => node.type === "shape" && nodeHasCollision(node))
    .map(deriveShapeBlocker)
    .filter((blocker): blocker is RectSurface => blocker !== null);

  return [...wallBlockers, ...shapeBlockers];
}

function deriveRamps(nodes: SceneNode[]): RampSurface[] {
  return nodes
    .filter((node) => node.type === "ramp")
    .map((node) => ({
      id: node.id,
      x: node.position.x,
      z: node.position.z,
      width: node.size?.width ?? 2,
      depth: node.size?.depth ?? 2,
      yaw: toRadians(node.rotation?.yaw ?? 0),
      baseY: node.position.y,
      height: node.size?.height ?? 1
    }));
}

function nodeHasCollision(node: SceneNode): boolean {
  if (node.actorClass === "Hologram") {
    return false;
  }

  return node.actorClass === "Solid" || node.actorClass === "FreeSolid";
}

function deriveWallOrDoorBlocker(node: SceneNode): RectSurface | null {
  if (node.localBounds) {
    return deriveBlockerFromLocalBounds(node, node.localBounds);
  }

  return {
    id: node.id,
    x: node.position.x,
    z: node.position.z,
    width: node.size?.width ?? 2,
    depth: node.size?.depth ?? 2,
    yaw: toRadians(node.rotation?.yaw ?? 0),
    baseY: node.position.y,
    topY: node.position.y + (node.size?.height ?? 2)
  };
}

function deriveShapeBlocker(node: SceneNode): RectSurface | null {
  const rawBounds = node.localBounds ?? createLocalBoundsFromSize(node.size);
  if (!rawBounds) {
    return null;
  }

  return deriveBlockerFromLocalBounds(node, rawBounds);
}

function deriveBlockerFromLocalBounds(
  node: Pick<SceneNode, "id" | "position" | "rotation">,
  rawBounds: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }
): RectSurface {
  const roll = toRadians(node.rotation?.roll ?? 0);
  const pitch = toRadians(node.rotation?.pitch ?? 0);
  const yaw = toRadians(node.rotation?.yaw ?? 0);
  const orientedBounds = reorientLocalBounds(rawBounds, roll, pitch);
  const centerLocalX = (orientedBounds.minX + orientedBounds.maxX) / 2;
  const centerLocalZ = (orientedBounds.minZ + orientedBounds.maxZ) / 2;
  const centerOffset = rotateVector(centerLocalX, centerLocalZ, yaw);

  return {
    id: node.id,
    x: node.position.x + centerOffset.x,
    z: node.position.z + centerOffset.z,
    width: Math.max(orientedBounds.maxX - orientedBounds.minX, 0.1),
    depth: Math.max(orientedBounds.maxZ - orientedBounds.minZ, 0.1),
    yaw,
    baseY: node.position.y + orientedBounds.minY,
    topY: node.position.y + orientedBounds.maxY
  };
}

function createLocalBoundsFromSize(
  size: SceneNode["size"]
): { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null {
  if (!size) {
    return null;
  }

  return {
    min: {
      x: -(size.width / 2),
      y: 0,
      z: -(size.depth / 2)
    },
    max: {
      x: size.width / 2,
      y: size.height,
      z: size.depth / 2
    }
  };
}

function reorientLocalBounds(
  bounds: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } },
  roll: number,
  pitch: number
) {
  const corners = [
    { x: bounds.min.x, y: bounds.min.y, z: bounds.min.z },
    { x: bounds.min.x, y: bounds.min.y, z: bounds.max.z },
    { x: bounds.min.x, y: bounds.max.y, z: bounds.min.z },
    { x: bounds.min.x, y: bounds.max.y, z: bounds.max.z },
    { x: bounds.max.x, y: bounds.min.y, z: bounds.min.z },
    { x: bounds.max.x, y: bounds.min.y, z: bounds.max.z },
    { x: bounds.max.x, y: bounds.max.y, z: bounds.min.z },
    { x: bounds.max.x, y: bounds.max.y, z: bounds.max.z }
  ].map((corner) => rotatePointRollPitch(corner, roll, pitch));

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (const corner of corners) {
    minX = Math.min(minX, corner.x);
    minY = Math.min(minY, corner.y);
    minZ = Math.min(minZ, corner.z);
    maxX = Math.max(maxX, corner.x);
    maxY = Math.max(maxY, corner.y);
    maxZ = Math.max(maxZ, corner.z);
  }

  return { minX, minY, minZ, maxX, maxY, maxZ };
}

function rotatePointRollPitch(
  point: { x: number; y: number; z: number },
  roll: number,
  pitch: number
) {
  const rollCos = Math.cos(roll);
  const rollSin = Math.sin(roll);
  const rolled = {
    x: point.x * rollCos - point.y * rollSin,
    y: point.x * rollSin + point.y * rollCos,
    z: point.z
  };

  const pitchCos = Math.cos(pitch);
  const pitchSin = Math.sin(pitch);
  return {
    x: rolled.x,
    y: rolled.y * pitchCos - rolled.z * pitchSin,
    z: rolled.y * pitchSin + rolled.z * pitchCos
  };
}

function derivePickups(nodes: SceneNode[]): PickupState[] {
  return nodes
    .filter((node) => node.type === "goody")
    .map((node) => {
      const missiles = clamp(asNumber(node.meta?.missiles) ?? 0, 0, 8);
      const grenades = clamp(asNumber(node.meta?.grenades) ?? 0, 0, 12);
      const kind: PickupKind = missiles > 0 && grenades > 0
        ? "mixed"
        : missiles > 0
          ? "missiles"
          : "grenades";

      return {
        id: node.id,
        kind,
        x: node.position.x,
        y: node.position.y,
        z: node.position.z,
        shapeId: node.shapeId,
        shapeKey: node.shapeKey,
        shapeAssetUrl: node.shapeAssetUrl,
        scale: node.scale,
        color: node.color,
        accentColor: node.accentColor,
        missiles,
        grenades,
        available: true,
        respawnAtTick: 0
      };
    });
}

function deriveBounds(nodes: SceneNode[], blockers: RectSurface[], ramps: RampSurface[]): RoomBounds {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (const node of nodes) {
    const halfWidth = (node.size?.width ?? 2) / 2;
    const halfDepth = (node.size?.depth ?? 2) / 2;
    minX = Math.min(minX, node.position.x - halfWidth);
    maxX = Math.max(maxX, node.position.x + halfWidth);
    minZ = Math.min(minZ, node.position.z - halfDepth);
    maxZ = Math.max(maxZ, node.position.z + halfDepth);
  }

  for (const blocker of blockers) {
    const halfWidth = blocker.width / 2;
    const halfDepth = blocker.depth / 2;
    const footprint = [
      rotateVector(-halfWidth, -halfDepth, blocker.yaw),
      rotateVector(-halfWidth, halfDepth, blocker.yaw),
      rotateVector(halfWidth, -halfDepth, blocker.yaw),
      rotateVector(halfWidth, halfDepth, blocker.yaw)
    ];

    for (const corner of footprint) {
      minX = Math.min(minX, blocker.x + corner.x);
      maxX = Math.max(maxX, blocker.x + corner.x);
      minZ = Math.min(minZ, blocker.z + corner.z);
      maxZ = Math.max(maxZ, blocker.z + corner.z);
    }
  }

  for (const ramp of ramps) {
    const halfWidth = ramp.width / 2;
    const halfDepth = ramp.depth / 2;
    const footprint = [
      rotateVector(-halfWidth, -halfDepth, ramp.yaw),
      rotateVector(-halfWidth, halfDepth, ramp.yaw),
      rotateVector(halfWidth, -halfDepth, ramp.yaw),
      rotateVector(halfWidth, halfDepth, ramp.yaw)
    ];

    for (const corner of footprint) {
      minX = Math.min(minX, ramp.x + corner.x);
      maxX = Math.max(maxX, ramp.x + corner.x);
      minZ = Math.min(minZ, ramp.z + corner.z);
      maxZ = Math.max(maxZ, ramp.z + corner.z);
    }
  }

  return {
    minX: Number.isFinite(minX) ? minX - 8 : -120,
    maxX: Number.isFinite(maxX) ? maxX + 8 : 120,
    minZ: Number.isFinite(minZ) ? minZ - 8 : -120,
    maxZ: Number.isFinite(maxZ) ? maxZ + 8 : 120
  };
}

async function deriveCollisionMeshes(nodes: SceneNode[]): Promise<CollisionMesh[]> {
  const meshes = await Promise.all(
    nodes
      .filter((node) => node.type === "wall" || node.type === "door" || (node.type === "shape" && nodeHasCollision(node)))
      .map((node) => deriveCollisionMesh(node))
  );

  return meshes.filter((mesh): mesh is CollisionMesh => mesh !== null);
}

async function deriveCollisionMesh(node: SceneNode): Promise<CollisionMesh | null> {
  if (node.shapeAssetUrl) {
    const assetTriangles = await loadCollisionAsset(node.shapeAssetUrl);
    if (assetTriangles.length) {
      const scale = Number.isFinite(node.scale) ? (node.scale ?? 1) : 1;
      const triangles = assetTriangles.map((triangle) => transformCollisionTriangle(node, triangle, scale));
      return {
        id: node.id,
        triangles,
        bounds: mergeTriangleBounds(triangles)
      };
    }
  }

  const localBounds = node.localBounds ?? createLocalBoundsFromSize(node.size);
  if (!localBounds) {
    return null;
  }

  const triangles = buildBoxCollisionTriangles(node, localBounds);
  return {
    id: node.id,
    triangles,
    bounds: mergeTriangleBounds(triangles)
  };
}

function projectileOutsideBounds(room: RoomState, projectile: ProjectileState): boolean {
  return projectile.x < room.bounds.minX
    || projectile.x > room.bounds.maxX
    || projectile.z < room.bounds.minZ
    || projectile.z > room.bounds.maxZ;
}

function nearestObstacleRayDistance(room: RoomState, origin: Vec3, target: Vec3): number | null {
  if (nativeCoreAvailable && room.collisionTriangleBuffer.length) {
    const nativeDistance = findRayDistanceNative(room.collisionTriangleBuffer, origin, target);
    if (typeof nativeDistance === "number") {
      return nativeDistance;
    }
  }

  const meshHit = findCollisionMeshImpact(room, origin, target, 0);
  if (meshHit) {
    return distanceBetween(origin, meshHit.point);
  }

  const dirX = target.x - origin.x;
  const dirZ = target.z - origin.z;
  const maxDistance = Math.hypot(dirX, dirZ);
  if (maxDistance <= 0.000001) {
    return null;
  }

  const normalizedX = dirX / maxDistance;
  const normalizedZ = dirZ / maxDistance;
  let nearest: number | null = null;

  for (const blocker of room.blockers) {
    const hit = rayIntersectRotatedRect(origin.x, origin.z, normalizedX, normalizedZ, blocker, 0.2);
    if (hit === null || hit > maxDistance) {
      continue;
    }
    if (nearest === null || hit < nearest) {
      nearest = hit;
    }
  }

  return nearest;
}

function rayIntersectRotatedRect(
  originX: number,
  originZ: number,
  dirX: number,
  dirZ: number,
  rect: Pick<RectSurface, "x" | "z" | "width" | "depth" | "yaw">,
  padding: number
): number | null {
  const origin = toLocalPoint(originX, originZ, rect.x, rect.z, rect.yaw);
  const direction = rotateVector(dirX, dirZ, -rect.yaw);
  const halfWidth = rect.width / 2 + padding;
  const halfDepth = rect.depth / 2 + padding;

  let tMin = -Infinity;
  let tMax = Infinity;

  for (const axis of [
    { origin: origin.x, direction: direction.x, min: -halfWidth, max: halfWidth },
    { origin: origin.z, direction: direction.z, min: -halfDepth, max: halfDepth }
  ]) {
    if (Math.abs(axis.direction) < 0.000001) {
      if (axis.origin < axis.min || axis.origin > axis.max) {
        return null;
      }
      continue;
    }

    const left = (axis.min - axis.origin) / axis.direction;
    const right = (axis.max - axis.origin) / axis.direction;
    const axisMin = Math.min(left, right);
    const axisMax = Math.max(left, right);
    tMin = Math.max(tMin, axisMin);
    tMax = Math.min(tMax, axisMax);

    if (tMin > tMax) {
      return null;
    }
  }

  if (tMax < 0) {
    return null;
  }

  return Math.max(0, tMin);
}

function pointInRotatedRect(
  x: number,
  z: number,
  centerX: number,
  centerZ: number,
  halfWidth: number,
  halfDepth: number,
  yaw: number
): boolean {
  const local = toLocalPoint(x, z, centerX, centerZ, yaw);
  return Math.abs(local.x) <= halfWidth && Math.abs(local.z) <= halfDepth;
}

function toLocalPoint(x: number, z: number, centerX: number, centerZ: number, yaw: number) {
  const translatedX = x - centerX;
  const translatedZ = z - centerZ;
  return rotateVector(translatedX, translatedZ, -yaw);
}

function rotateVector(x: number, z: number, yaw: number) {
  const cosine = Math.cos(yaw);
  const sine = Math.sin(yaw);
  return {
    x: x * cosine - z * sine,
    z: x * sine + z * cosine
  };
}

function getRemainingSeconds(room: RoomState): number {
  if (room.status === "waiting" || room.startedAtTick === null) {
    return matchSeconds;
  }

  const remainingTicks = Math.max(0, room.matchDurationTicks - (room.tick - room.startedAtTick));
  return Math.ceil(remainingTicks / tickRate);
}

function addEvent(
  room: RoomState,
  event: Omit<MatchEventState, "id" | "tick">
): void {
  room.events.push({
    id: `event_${room.tick}_${room.events.length}`,
    tick: room.tick,
    ...event
  });

  if (room.events.length > 24) {
    room.events.splice(0, room.events.length - 24);
  }
}

function describePickup(pickup: PickupState): string {
  if (pickup.kind === "mixed") {
    return "a mixed cache";
  }
  if (pickup.kind === "missiles") {
    return "a missile pack";
  }
  return "a grenade pack";
}

function emptyInput(): PlayerInputState {
  return {
    moveForward: 0,
    turnBody: 0,
    aimYaw: 0,
    aimPitch: 0,
    stanceDelta: 0,
    primaryFire: false,
    loadMissile: false,
    loadGrenade: false,
    boost: false,
    crouchJump: false,
    toggleScoutView: false,
    scoutCommand: null
  };
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

function sendJson(
  response: {
    writeHead(statusCode: number, headers: Record<string, string>): void;
    end(body: string): void;
  },
  statusCode: number,
  payload: unknown
): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  });
  response.end(JSON.stringify(payload, null, 2));
}

function sendMetrics(
  response: {
    writeHead(statusCode: number, headers: Record<string, string>): void;
    end(body: string): void;
  }
): void {
  const lines = [
    "# HELP avara_game_server_build_info Build information for the game server",
    `avara_game_server_build_info{version="${escapeMetricsLabel(buildVersion)}"} 1`,
    "# HELP avara_game_server_rooms_total Current game worker room count",
    `avara_game_server_rooms_total ${rooms.size}`,
    "# HELP avara_game_server_players_total Current connected player count",
    `avara_game_server_players_total ${Array.from(rooms.values()).reduce((sum, room) => sum + room.players.size, 0)}`,
    "# HELP avara_game_server_request_total Total requests by route",
    ...Array.from(requestCounts.entries()).map(
      ([route, count]) => `avara_game_server_request_total{route="${escapeMetricsLabel(route)}"} ${count}`
    )
  ];

  response.writeHead(200, {
    "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  });
  response.end(`${lines.join("\n")}\n`);
}

function setCorsHeaders(response: { setHeader(name: string, value: string): void }): void {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
}

function recordRequestMetric(method: string, pathname: string): void {
  const normalized = pathname.replace(/\/rooms\/[^/]+/g, "/rooms/:id");
  const key = `${method} ${normalized}`;
  requestCounts.set(key, (requestCounts.get(key) ?? 0) + 1);
}

function getUptimeSeconds(): number {
  return Math.max(0, Math.round((Date.now() - startedAt) / 1000));
}

function escapeMetricsLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function tickDeltaScale(): number {
  return (1 / tickRate) / CLASSIC_FRAME_SECONDS;
}

function fpsCoefficient1(classicCoeff1: number, fpsScale: number): number {
  return Math.pow(classicCoeff1, fpsScale);
}

function fpsCoefficient2(classicCoeff2: number, fpsScale: number): number {
  return classicCoeff2 * fpsScale;
}

function fpsOffset(classicCoeff2: number, fpsScale: number): number {
  return 0.5 * ((1 / fpsScale) - 1) * fpsCoefficient2(classicCoeff2, fpsScale);
}

function fpsCoefficients(classicCoeff1: number, classicCoeff2: number, fpsScale: number, includeOffset = false) {
  const coeff1 = fpsCoefficient1(classicCoeff1, fpsScale);
  const coeff2 = Math.abs(1 - classicCoeff1) > 0.001
    ? classicCoeff2 * ((1 - coeff1) / (1 - classicCoeff1))
    : fpsCoefficient2(classicCoeff2, fpsScale);

  return {
    coeff1,
    coeff2,
    offset: includeOffset && Math.abs(classicCoeff1) > 0.000001 ? fpsOffset(classicCoeff2, fpsScale) / classicCoeff1 : 0
  };
}

function framesFromClassic(classicFrames: number, fpsScale: number): number {
  return Math.max(1, Math.round(classicFrames / fpsScale));
}

function blendLinear(current: number, target: number, blend: { coeff1: number; coeff2: number }) {
  return current * blend.coeff1 + target * blend.coeff2;
}

function positiveModulo(value: number, mod: number): number {
  return ((value % mod) + mod) % mod;
}

function directionFromYawPitch(yaw: number, pitch: number) {
  const cosPitch = Math.cos(pitch);
  return {
    x: Math.cos(yaw) * cosPitch,
    y: Math.sin(pitch),
    z: Math.sin(yaw) * cosPitch
  };
}

function upVectorFromYawPitch(yaw: number, pitch: number) {
  return {
    x: -Math.cos(yaw) * Math.sin(pitch),
    y: Math.cos(pitch),
    z: -Math.sin(yaw) * Math.sin(pitch)
  };
}

function rightVectorFromYawPitch(yaw: number, pitch: number) {
  const forward = directionFromYawPitch(yaw, pitch);
  const up = upVectorFromYawPitch(yaw, pitch);
  const right = {
    x: forward.y * up.z - forward.z * up.y,
    y: forward.z * up.x - forward.x * up.z,
    z: forward.x * up.y - forward.y * up.x
  };
  const length = Math.hypot(right.x, right.y, right.z) || 1;
  return {
    x: right.x / length,
    y: right.y / length,
    z: right.z / length
  };
}

function computeProjectileMountOrigin(
  player: PlayerState,
  offset: { x: number; y: number; z: number },
  forward: { x: number; y: number; z: number },
  up: { x: number; y: number; z: number },
  right: { x: number; y: number; z: number },
  includePlayerSpeed: boolean
) {
  return {
    x: player.x + (includePlayerSpeed ? player.vx : 0) + right.x * offset.x + up.x * offset.y + forward.x * offset.z,
    y: player.y + PLAYER_HIT_CENTER_Y + (includePlayerSpeed ? player.vy : 0) + right.y * offset.x + up.y * offset.y + forward.y * offset.z,
    z: player.z + (includePlayerSpeed ? player.vz : 0) + right.z * offset.x + up.z * offset.y + forward.z * offset.z
  };
}

function lerpPoint3(
  start: { x: number; y: number; z: number },
  end: { x: number; y: number; z: number },
  t: number
) {
  return {
    x: start.x + (end.x - start.x) * t,
    y: start.y + (end.y - start.y) * t,
    z: start.z + (end.z - start.z) * t
  };
}

async function loadCollisionAsset(assetUrl: string): Promise<CollisionTriangle[]> {
  const cached = collisionAssetCache.get(assetUrl);
  if (cached) {
    return cached;
  }

  const pending = (async () => {
    const filePath = resolveContentAssetFilePath(assetUrl);
    if (!filePath) {
      return [];
    }

    const data = JSON.parse(await fs.readFile(filePath, "utf8")) as BspCollisionAsset;
    if (!Array.isArray(data.points) || !Array.isArray(data.polys)) {
      return [];
    }

    const triangles: CollisionTriangle[] = [];
    for (const poly of data.polys) {
      if (!Array.isArray(poly?.tris)) {
        continue;
      }

      for (let index = 0; index + 2 < poly.tris.length; index += 3) {
        const a = data.points[poly.tris[index]];
        const b = data.points[poly.tris[index + 1]];
        const c = data.points[poly.tris[index + 2]];
        if (!a || !b || !c) {
          continue;
        }

        triangles.push(createCollisionTriangle(
          { x: a[0], y: a[1], z: a[2] },
          { x: b[0], y: b[1], z: b[2] },
          { x: c[0], y: c[1], z: c[2] }
        ));
      }
    }

    return triangles;
  })();

  collisionAssetCache.set(assetUrl, pending);

  try {
    return await pending;
  } catch (error) {
    collisionAssetCache.delete(assetUrl);
    throw error;
  }
}

function resolveContentAssetFilePath(assetUrl: string): string | null {
  if (!assetUrl.startsWith("/content/")) {
    return null;
  }

  const relativePath = assetUrl.slice("/content/".length);
  return path.join(workspaceRoot, ...relativePath.split("/"));
}

function transformCollisionTriangle(node: SceneNode, triangle: CollisionTriangle, scale: number): CollisionTriangle {
  return createCollisionTriangle(
    transformNodeLocalPoint(node, triangle.a, scale),
    transformNodeLocalPoint(node, triangle.b, scale),
    transformNodeLocalPoint(node, triangle.c, scale)
  );
}

function buildBoxCollisionTriangles(node: SceneNode, bounds: NonNullable<SceneNode["localBounds"]>): CollisionTriangle[] {
  const corners = [
    { x: bounds.min.x, y: bounds.min.y, z: bounds.min.z },
    { x: bounds.max.x, y: bounds.min.y, z: bounds.min.z },
    { x: bounds.max.x, y: bounds.max.y, z: bounds.min.z },
    { x: bounds.min.x, y: bounds.max.y, z: bounds.min.z },
    { x: bounds.min.x, y: bounds.min.y, z: bounds.max.z },
    { x: bounds.max.x, y: bounds.min.y, z: bounds.max.z },
    { x: bounds.max.x, y: bounds.max.y, z: bounds.max.z },
    { x: bounds.min.x, y: bounds.max.y, z: bounds.max.z }
  ].map((corner) => transformNodeLocalPoint(node, corner, 1));

  return [
    [0, 1, 2], [0, 2, 3],
    [4, 6, 5], [4, 7, 6],
    [0, 4, 5], [0, 5, 1],
    [3, 2, 6], [3, 6, 7],
    [1, 5, 6], [1, 6, 2],
    [0, 3, 7], [0, 7, 4]
  ].map(([a, b, c]) => createCollisionTriangle(corners[a], corners[b], corners[c]));
}

function transformNodeLocalPoint(node: SceneNode, point: Vec3, scale: number): Vec3 {
  const scaled = {
    x: point.x * scale,
    y: point.y * scale,
    z: point.z * scale
  };
  const rotated = rotatePointEulerXYZ(
    scaled,
    toRadians(node.rotation?.pitch ?? 0),
    toRadians(node.rotation?.yaw ?? 0),
    toRadians(node.rotation?.roll ?? 0)
  );

  return {
    x: node.position.x + rotated.x,
    y: node.position.y + rotated.y,
    z: node.position.z + rotated.z
  };
}

function rotatePointEulerXYZ(point: Vec3, pitch: number, yaw: number, roll: number): Vec3 {
  const pitchCos = Math.cos(pitch);
  const pitchSin = Math.sin(pitch);
  const afterPitch = {
    x: point.x,
    y: point.y * pitchCos - point.z * pitchSin,
    z: point.y * pitchSin + point.z * pitchCos
  };

  const yawCos = Math.cos(yaw);
  const yawSin = Math.sin(yaw);
  const afterYaw = {
    x: afterPitch.x * yawCos + afterPitch.z * yawSin,
    y: afterPitch.y,
    z: -afterPitch.x * yawSin + afterPitch.z * yawCos
  };

  const rollCos = Math.cos(roll);
  const rollSin = Math.sin(roll);
  return {
    x: afterYaw.x * rollCos - afterYaw.y * rollSin,
    y: afterYaw.x * rollSin + afterYaw.y * rollCos,
    z: afterYaw.z
  };
}

function mergeTriangleBounds(triangles: CollisionTriangle[]): CollisionAabb {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (const triangle of triangles) {
    minX = Math.min(minX, triangle.bounds.minX);
    minY = Math.min(minY, triangle.bounds.minY);
    minZ = Math.min(minZ, triangle.bounds.minZ);
    maxX = Math.max(maxX, triangle.bounds.maxX);
    maxY = Math.max(maxY, triangle.bounds.maxY);
    maxZ = Math.max(maxZ, triangle.bounds.maxZ);
  }

  return { minX, minY, minZ, maxX, maxY, maxZ };
}

function createCollisionTriangle(a: Vec3, b: Vec3, c: Vec3): CollisionTriangle {
  return {
    a,
    b,
    c,
    bounds: {
      minX: Math.min(a.x, b.x, c.x),
      minY: Math.min(a.y, b.y, c.y),
      minZ: Math.min(a.z, b.z, c.z),
      maxX: Math.max(a.x, b.x, c.x),
      maxY: Math.max(a.y, b.y, c.y),
      maxZ: Math.max(a.z, b.z, c.z)
    }
  };
}

function findCollisionMeshImpact(
  room: RoomState,
  start: Vec3,
  end: Vec3,
  radius: number
): { t: number; point: Vec3 } | null {
  let best: { t: number; point: Vec3 } | null = null;
  const segmentBounds = expandAabb(pointPairBounds(start, end), radius);

  for (const mesh of room.collisionMeshes) {
    if (!aabbOverlaps(segmentBounds, expandAabb(mesh.bounds, radius))) {
      continue;
    }

    for (const triangle of mesh.triangles) {
      if (!aabbOverlaps(segmentBounds, expandAabb(triangle.bounds, radius))) {
        continue;
      }

      const t = segmentTriangleIntersectionT(start, end, triangle.a, triangle.b, triangle.c);
      if (t === null) {
        continue;
      }

      if (!best || t < best.t) {
        best = {
          t,
          point: lerpPoint3(start, end, t)
        };
      }
    }
  }

  return best;
}

function pointPairBounds(start: Vec3, end: Vec3): CollisionAabb {
  return {
    minX: Math.min(start.x, end.x),
    minY: Math.min(start.y, end.y),
    minZ: Math.min(start.z, end.z),
    maxX: Math.max(start.x, end.x),
    maxY: Math.max(start.y, end.y),
    maxZ: Math.max(start.z, end.z)
  };
}

function expandAabb(bounds: CollisionAabb, padding: number): CollisionAabb {
  return {
    minX: bounds.minX - padding,
    minY: bounds.minY - padding,
    minZ: bounds.minZ - padding,
    maxX: bounds.maxX + padding,
    maxY: bounds.maxY + padding,
    maxZ: bounds.maxZ + padding
  };
}

function aabbOverlaps(left: CollisionAabb, right: CollisionAabb): boolean {
  return left.minX <= right.maxX
    && left.maxX >= right.minX
    && left.minY <= right.maxY
    && left.maxY >= right.minY
    && left.minZ <= right.maxZ
    && left.maxZ >= right.minZ;
}

function segmentTriangleIntersectionT(start: Vec3, end: Vec3, a: Vec3, b: Vec3, c: Vec3): number | null {
  const direction = subtractVec3(end, start);
  const edge1 = subtractVec3(b, a);
  const edge2 = subtractVec3(c, a);
  const pvec = crossVec3(direction, edge2);
  const determinant = dotVec3(edge1, pvec);
  if (Math.abs(determinant) < 0.000001) {
    return null;
  }

  const inverseDeterminant = 1 / determinant;
  const tvec = subtractVec3(start, a);
  const u = dotVec3(tvec, pvec) * inverseDeterminant;
  if (u < 0 || u > 1) {
    return null;
  }

  const qvec = crossVec3(tvec, edge1);
  const v = dotVec3(direction, qvec) * inverseDeterminant;
  if (v < 0 || u + v > 1) {
    return null;
  }

  const t = dotVec3(edge2, qvec) * inverseDeterminant;
  return t >= 0 && t <= 1 ? t : null;
}

function segmentAabbIntersectionT(
  start: { x: number; y: number; z: number },
  end: { x: number; y: number; z: number },
  box: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }
): number | null {
  const delta = {
    x: end.x - start.x,
    y: end.y - start.y,
    z: end.z - start.z
  };

  let tMin = 0;
  let tMax = 1;

  for (const axis of [
    { origin: start.x, delta: delta.x, min: box.minX, max: box.maxX },
    { origin: start.y, delta: delta.y, min: box.minY, max: box.maxY },
    { origin: start.z, delta: delta.z, min: box.minZ, max: box.maxZ }
  ]) {
    if (Math.abs(axis.delta) < 0.000001) {
      if (axis.origin < axis.min || axis.origin > axis.max) {
        return null;
      }
      continue;
    }

    const inv = 1 / axis.delta;
    const entry = (axis.min - axis.origin) * inv;
    const exit = (axis.max - axis.origin) * inv;
    const axisMin = Math.min(entry, exit);
    const axisMax = Math.max(entry, exit);
    tMin = Math.max(tMin, axisMin);
    tMax = Math.min(tMax, axisMax);

    if (tMin > tMax) {
      return null;
    }
  }

  return tMin >= 0 && tMin <= 1 ? tMin : null;
}

function segmentSphereIntersectionT(
  start: { x: number; y: number; z: number },
  end: { x: number; y: number; z: number },
  center: { x: number; y: number; z: number },
  radius: number
): number | null {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dz = end.z - start.z;
  const ox = start.x - center.x;
  const oy = start.y - center.y;
  const oz = start.z - center.z;

  const a = dx * dx + dy * dy + dz * dz;
  const b = 2 * (ox * dx + oy * dy + oz * dz);
  const c = ox * ox + oy * oy + oz * oz - radius * radius;

  if (a <= 0.000001) {
    return c <= 0 ? 0 : null;
  }

  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) {
    return null;
  }

  const root = Math.sqrt(discriminant);
  const t1 = (-b - root) / (2 * a);
  const t2 = (-b + root) / (2 * a);
  if (t1 >= 0 && t1 <= 1) {
    return t1;
  }
  if (t2 >= 0 && t2 <= 1) {
    return t2;
  }
  return null;
}

function subtractVec3(left: Vec3, right: Vec3): Vec3 {
  return {
    x: left.x - right.x,
    y: left.y - right.y,
    z: left.z - right.z
  };
}

function crossVec3(left: Vec3, right: Vec3): Vec3 {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x
  };
}

function dotVec3(left: Vec3, right: Vec3): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function distanceBetween(left: Vec3, right: Vec3): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function triangleNormal(triangle: CollisionTriangle): Vec3 {
  const edge1 = subtractVec3(triangle.b, triangle.a);
  const edge2 = subtractVec3(triangle.c, triangle.a);
  const normal = crossVec3(edge1, edge2);
  const length = Math.hypot(normal.x, normal.y, normal.z);
  if (length <= 0.000001) {
    return { x: 0, y: 0, z: 0 };
  }
  return {
    x: normal.x / length,
    y: normal.y / length,
    z: normal.z / length
  };
}

function moveAngleTowards(current: number, target: number, maxDelta: number): number {
  const delta = normalizeAngle(target - current);
  if (Math.abs(delta) <= maxDelta) {
    return normalizeAngle(target);
  }
  return normalizeAngle(current + Math.sign(delta) * maxDelta);
}

function moveScalarTowards(current: number, target: number, maxDelta: number): number {
  const delta = target - current;
  if (Math.abs(delta) <= maxDelta) {
    return target;
  }
  return current + Math.sign(delta) * maxDelta;
}

function shieldUnitsToHealth(units: number, maxShields = HECTOR_MAX_SHIELDS): number {
  return Math.max(0, Math.round((units / Math.max(0.0001, maxShields)) * 100));
}

function healthToShieldUnits(health: number, maxShields = HECTOR_MAX_SHIELDS): number {
  return maxShields * (health / 100);
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function normalizeScoutCommand(value: unknown): ScoutCommand | null {
  switch (value) {
    case "follow":
    case "lead":
    case "left":
    case "right":
    case "up":
    case "down":
      return value;
    default:
      return null;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function normalizeAngle(value: number): number {
  let angle = value;
  while (angle <= -Math.PI) {
    angle += Math.PI * 2;
  }
  while (angle > Math.PI) {
    angle -= Math.PI * 2;
  }
  return angle;
}
