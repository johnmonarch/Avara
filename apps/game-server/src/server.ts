import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseLevelScene } from "@avara/level-parser";
import type {
  MatchEventState,
  PickupKind,
  ProjectileKind,
  SnapshotPacket,
  SnapshotPickupState,
  SnapshotPlayerState,
  SnapshotProjectileState,
  WeaponLoad
} from "@avara/shared-protocol";
import type { LevelScene, SceneNode } from "@avara/shared-types";
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
const MAX_STEP_HEIGHT = 1.4;
const RESPAWN_TICKS = tickRate * respawnSeconds;
const PICKUP_RESPAWN_TICKS = tickRate * pickupRespawnSeconds;
const DISCONNECT_GRACE_TICKS = tickRate * disconnectGraceSeconds;

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

interface PickupState {
  id: string;
  kind: PickupKind;
  x: number;
  y: number;
  z: number;
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
  radius: number;
  damage: number;
  remainingTicks: number;
}

interface PlayerInputState {
  moveForward: number;
  turnBody: number;
  aimYaw: number;
  aimPitch: number;
  primaryFire: boolean;
  loadMissile: boolean;
  loadGrenade: boolean;
  boost: boolean;
  crouchJump: boolean;
}

interface PlayerState {
  id: string;
  displayName: string;
  x: number;
  y: number;
  z: number;
  bodyYaw: number;
  turretYaw: number;
  turretPitch: number;
  health: number;
  alive: boolean;
  kills: number;
  deaths: number;
  missileAmmo: number;
  grenadeAmmo: number;
  weaponLoad: WeaponLoad;
  respawnAtTick: number;
  nextFireTick: number;
  lastSeenTick: number;
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
  pickups: PickupState[];
  projectiles: ProjectileState[];
  players: Map<string, PlayerState>;
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
        rooms: rooms.size
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
      const room = createRoomState(roomId, scene, clamp(asNumber(body?.maxPlayers) ?? 8, 1, 8));
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
        primaryFire: Boolean(body?.primaryFire),
        loadMissile: Boolean(body?.loadMissile),
        loadGrenade: Boolean(body?.loadGrenade),
        boost: Boolean(body?.boost),
        crouchJump: Boolean(body?.crouchJump)
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
      }

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

function createRoomState(roomId: string, scene: LevelScene, maxPlayers: number): RoomState {
  const bounds = deriveBounds(scene.nodes);
  return {
    id: roomId,
    levelId: scene.id,
    levelTitle: scene.title,
    maxPlayers,
    spawnPoints: deriveSpawnPoints(scene.nodes),
    bounds,
    blockers: deriveBlockers(scene.nodes),
    ramps: deriveRamps(scene.nodes),
    pickups: derivePickups(scene.nodes),
    projectiles: [],
    players: new Map(),
    nextSpawnIndex: 0,
    tick: 0,
    status: "waiting",
    fragLimit,
    matchDurationTicks: matchSeconds * tickRate,
    startedAtTick: null,
    events: []
  };
}

function simulatePlayers(room: RoomState, dt: number): void {
  for (const player of room.players.values()) {
    if (!player.alive) {
      continue;
    }

    player.bodyYaw = normalizeAngle(player.bodyYaw + player.input.turnBody * 1.9 * dt);
    player.turretYaw = normalizeAngle(player.bodyYaw + player.input.aimYaw);
    player.turretPitch = clamp(player.input.aimPitch, -0.8, 0.5);

    const speed = player.input.boost ? 10 : 6.2;
    const moveDistance = player.input.moveForward * speed * dt;
    if (Math.abs(moveDistance) > 0.0001) {
      const targetX = player.x + Math.cos(player.bodyYaw) * moveDistance;
      const targetZ = player.z + Math.sin(player.bodyYaw) * moveDistance;
      const resolved = resolveMovement(room, player, targetX, targetZ);
      player.x = resolved.x;
      player.y = resolved.y;
      player.z = resolved.z;
    } else {
      player.y = sampleFloorHeight(room, player.x, player.z, player.y);
    }
  }
}

function resolveMovement(room: RoomState, player: PlayerState, targetX: number, targetZ: number) {
  const both = resolvePosition(room, player, targetX, targetZ);
  if (both) {
    return both;
  }

  const slideX = resolvePosition(room, player, targetX, player.z);
  if (slideX) {
    return slideX;
  }

  const slideZ = resolvePosition(room, player, player.x, targetZ);
  if (slideZ) {
    return slideZ;
  }

  return { x: player.x, y: sampleFloorHeight(room, player.x, player.z, player.y), z: player.z };
}

function resolvePosition(room: RoomState, player: PlayerState, x: number, z: number) {
  const floor = sampleFloorHeight(room, x, z, player.y);
  if (floor - player.y > MAX_STEP_HEIGHT) {
    return null;
  }
  if (isBlocked(room, x, z, floor)) {
    return null;
  }

  return { x: clamp(x, room.bounds.minX, room.bounds.maxX), y: floor, z: clamp(z, room.bounds.minZ, room.bounds.maxZ) };
}

function sampleFloorHeight(room: RoomState, x: number, z: number, currentY: number): number {
  let floor = 0;

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

function sampleRampHeight(ramp: RampSurface, x: number, z: number): number | null {
  const local = toLocalPoint(x, z, ramp.x, ramp.z, ramp.yaw);
  if (Math.abs(local.x) > ramp.width / 2 || Math.abs(local.z) > ramp.depth / 2) {
    return null;
  }

  const progress = clamp((local.z + ramp.depth / 2) / ramp.depth, 0, 1);
  return ramp.baseY + ramp.height * progress;
}

function isBlocked(room: RoomState, x: number, z: number, floor: number): boolean {
  for (const blocker of room.blockers) {
    if (!pointInRotatedRect(x, z, blocker.x, blocker.z, blocker.width / 2 + PLAYER_RADIUS, blocker.depth / 2 + PLAYER_RADIUS, blocker.yaw)) {
      continue;
    }

    if (blocker.topY > floor + 0.35) {
      return true;
    }
  }

  return false;
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

function expireDisconnectedPlayers(room: RoomState): void {
  for (const [playerId, player] of room.players.entries()) {
    if (room.tick - player.lastSeenTick <= DISCONNECT_GRACE_TICKS) {
      continue;
    }

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
      player.missileAmmo = clamp(player.missileAmmo + pickup.missiles, 0, 8);
      player.grenadeAmmo = clamp(player.grenadeAmmo + pickup.grenades, 0, 12);
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
      if (player.missileAmmo > 0) {
        player.missileAmmo -= 1;
        player.weaponLoad = "cannon";
        player.nextFireTick = room.tick + 12;
        spawnProjectile(room, player, "missile");
        return;
      }
      break;
    case "grenade":
      if (player.grenadeAmmo > 0) {
        player.grenadeAmmo -= 1;
        player.weaponLoad = "cannon";
        player.nextFireTick = room.tick + 14;
        spawnProjectile(room, player, "grenade");
        return;
      }
      break;
    default:
      break;
  }

  player.weaponLoad = "cannon";
  player.nextFireTick = room.tick + 4;
  fireCannon(room, player);
}

function loadWeapon(room: RoomState, player: PlayerState, weapon: Exclude<WeaponLoad, "cannon">): void {
  if (!player.alive) {
    return;
  }

  if (weapon === "missile" && player.missileAmmo <= 0) {
    return;
  }
  if (weapon === "grenade" && player.grenadeAmmo <= 0) {
    return;
  }
  if (player.weaponLoad === weapon) {
    return;
  }

  player.weaponLoad = weapon;
  addEvent(room, {
    event: "weapon_load",
    actorPlayerId: player.id,
    message: `${player.displayName} loaded ${weapon}`
  });
}

function fireCannon(room: RoomState, player: PlayerState): void {
  const dirX = Math.cos(player.turretYaw);
  const dirZ = Math.sin(player.turretYaw);
  const blockedDistance = nearestObstacleRayDistance(room, player.x, player.z, dirX, dirZ, 72);

  let bestTarget: { player: PlayerState; distance: number } | null = null;
  for (const candidate of room.players.values()) {
    if (candidate.id === player.id || !candidate.alive) {
      continue;
    }

    const dx = candidate.x - player.x;
    const dz = candidate.z - player.z;
    const forward = dx * dirX + dz * dirZ;
    if (forward <= 0 || forward > 72) {
      continue;
    }

    const lateral = Math.abs(-dirZ * dx + dirX * dz);
    if (lateral > PLAYER_RADIUS + 0.85) {
      continue;
    }
    if (Math.abs(candidate.y - player.y) > 4.5) {
      continue;
    }
    if (blockedDistance !== null && blockedDistance < forward) {
      continue;
    }
    if (!bestTarget || forward < bestTarget.distance) {
      bestTarget = { player: candidate, distance: forward };
    }
  }

  if (bestTarget) {
    applyDamage(room, bestTarget.player, 24, player);
  }
}

function spawnProjectile(room: RoomState, player: PlayerState, kind: ProjectileKind): void {
  const speed = kind === "missile" ? 26 : 16;
  const dirX = Math.cos(player.turretYaw);
  const dirZ = Math.sin(player.turretYaw);
  room.projectiles.push({
    id: `projectile_${crypto.randomUUID()}`,
    ownerId: player.id,
    ownerName: player.displayName,
    kind,
    x: player.x + dirX * 2.2,
    y: player.y + 2.1,
    z: player.z + dirZ * 2.2,
    vx: dirX * speed,
    vy: 0,
    vz: dirZ * speed,
    radius: kind === "missile" ? 8.5 : 10,
    damage: kind === "missile" ? 54 : 38,
    remainingTicks: kind === "missile" ? tickRate * 2 : Math.round(tickRate * 1.35)
  });
}

function simulateProjectiles(room: RoomState, dt: number): void {
  const survivors: ProjectileState[] = [];

  for (const projectile of room.projectiles) {
    projectile.x += projectile.vx * dt;
    projectile.y += projectile.vy * dt;
    projectile.z += projectile.vz * dt;
    projectile.remainingTicks -= 1;

    let exploded = projectile.remainingTicks <= 0 || projectileOutsideBounds(room, projectile);
    if (!exploded && projectileHitsGeometry(room, projectile)) {
      exploded = true;
    }

    if (!exploded) {
      for (const player of room.players.values()) {
        if (!player.alive || player.id === projectile.ownerId) {
          continue;
        }
        const distance = Math.hypot(player.x - projectile.x, player.z - projectile.z);
        if (distance <= PLAYER_RADIUS + 0.9 && Math.abs(player.y - projectile.y) <= 4.5) {
          exploded = true;
          break;
        }
      }
    }

    if (exploded) {
      explodeProjectile(room, projectile);
      continue;
    }

    survivors.push(projectile);
  }

  room.projectiles = survivors;
}

function explodeProjectile(room: RoomState, projectile: ProjectileState): void {
  const owner = room.players.get(projectile.ownerId);
  for (const player of room.players.values()) {
    if (!player.alive) {
      continue;
    }

    const distance = Math.hypot(player.x - projectile.x, player.z - projectile.z);
    if (distance > projectile.radius || Math.abs(player.y - projectile.y) > 5.5) {
      continue;
    }

    const scaledDamage = Math.round(projectile.damage * (1 - distance / projectile.radius));
    if (scaledDamage > 0) {
      applyDamage(room, player, scaledDamage, owner ?? null);
    }
  }
}

function applyDamage(room: RoomState, target: PlayerState, amount: number, attacker: PlayerState | null): void {
  if (!target.alive || amount <= 0 || room.status === "ended") {
    return;
  }

  target.health = Math.max(0, target.health - amount);
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
  for (const player of room.players.values()) {
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
    bodyYaw: player.bodyYaw,
    turretYaw: player.turretYaw,
    turretPitch: player.turretPitch,
    health: player.health,
    alive: player.alive,
    kills: player.kills,
    deaths: player.deaths,
    missileAmmo: player.missileAmmo,
    grenadeAmmo: player.grenadeAmmo,
    weaponLoad: player.weaponLoad,
    respawnSeconds: player.alive ? 0 : Math.max(0, Math.ceil((player.respawnAtTick - room.tick) / tickRate))
  });
}

function toSnapshotProjectile(projectile: ProjectileState): SnapshotProjectileState {
  return {
    id: projectile.id,
    ownerId: projectile.ownerId,
    kind: projectile.kind,
    x: projectile.x,
    y: projectile.y,
    z: projectile.z
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
    respawnSeconds: pickup.available ? 0 : Math.max(0, Math.ceil((pickup.respawnAtTick - room.tick) / tickRate))
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

  return {
    id: playerId,
    displayName,
    x: spawn.x,
    y: groundedY,
    z: spawn.z,
    bodyYaw: spawn.yaw,
    turretYaw: spawn.yaw,
    turretPitch: 0,
    health: 100,
    alive: true,
    kills: carry?.kills ?? 0,
    deaths: carry?.deaths ?? 0,
    missileAmmo: 2,
    grenadeAmmo: 2,
    weaponLoad: "cannon",
    respawnAtTick: 0,
    nextFireTick: room.tick + 5,
    lastSeenTick: room.tick,
    input: emptyInput()
  };
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
  return nodes
    .filter((node) => node.type === "wall" || node.type === "door")
    .map((node) => ({
      id: node.id,
      x: node.position.x,
      z: node.position.z,
      width: node.size?.width ?? 2,
      depth: node.size?.depth ?? 2,
      yaw: toRadians(node.rotation?.yaw ?? 0),
      baseY: node.position.y,
      topY: node.position.y + (node.size?.height ?? 2)
    }));
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
        missiles,
        grenades,
        available: true,
        respawnAtTick: 0
      };
    });
}

function deriveBounds(nodes: SceneNode[]): RoomBounds {
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

  return {
    minX: Number.isFinite(minX) ? minX - 8 : -120,
    maxX: Number.isFinite(maxX) ? maxX + 8 : 120,
    minZ: Number.isFinite(minZ) ? minZ - 8 : -120,
    maxZ: Number.isFinite(maxZ) ? maxZ + 8 : 120
  };
}

function projectileHitsGeometry(room: RoomState, projectile: ProjectileState): boolean {
  for (const blocker of room.blockers) {
    if (!pointInRotatedRect(projectile.x, projectile.z, blocker.x, blocker.z, blocker.width / 2, blocker.depth / 2, blocker.yaw)) {
      continue;
    }
    if (projectile.y <= blocker.topY + 1.5) {
      return true;
    }
  }
  return false;
}

function projectileOutsideBounds(room: RoomState, projectile: ProjectileState): boolean {
  return projectile.x < room.bounds.minX
    || projectile.x > room.bounds.maxX
    || projectile.z < room.bounds.minZ
    || projectile.z > room.bounds.maxZ;
}

function nearestObstacleRayDistance(
  room: RoomState,
  originX: number,
  originZ: number,
  dirX: number,
  dirZ: number,
  maxDistance: number
): number | null {
  let nearest: number | null = null;

  for (const blocker of room.blockers) {
    const hit = rayIntersectRotatedRect(originX, originZ, dirX, dirZ, blocker, 0.2);
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
    primaryFire: false,
    loadMissile: false,
    loadGrenade: false,
    boost: false,
    crouchJump: false
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

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
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
