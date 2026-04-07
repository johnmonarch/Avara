import { useEffect, useRef } from "react";

import type { SnapshotPacket, SnapshotPlayerState, SnapshotProjectileState } from "@avara/shared-protocol";
import type { LevelScene, SceneSound } from "@avara/shared-types";

import { resolveApiAssetUrl } from "./api";

const ROOT_SOUND_CONTENT_PREFIX = "/content/rsrc/ogg";
const DEFAULT_SHOT_SOUND_ID = 200;
const DEFAULT_WEAPON_LOOP_SOUND_ID = 201;
const DEFAULT_PICKUP_SOUND_ID = 250;
const DEFAULT_TELEPORT_SOUND_ID = 410;
const DEFAULT_INCARNATE_SOUND_ID = 411;
const DEFAULT_MISSILE_BLAST_SOUND_ID = 230;
const DEFAULT_GRENADE_BLAST_SOUND_ID = 231;
const DEFAULT_GROUND_STEP_SOUND_ID = 160;

interface AvaraSoundscapeInput {
  scene: LevelScene | null;
  snapshot: SnapshotPacket | null;
  localPlayerId: string;
  roomActive: boolean;
  pointerLocked: boolean;
}

interface Vector3Like {
  x: number;
  y: number;
  z: number;
}

interface ProjectileLoop {
  audio: HTMLAudioElement;
  projectileId: string;
  kind: SnapshotProjectileState["kind"];
  x: number;
  y: number;
  z: number;
}

class AvaraSoundRuntime {
  private unlocked = false;
  private roomActive = false;
  private scene: LevelScene | null = null;
  private ambientTracks = new Map<string, HTMLAudioElement>();
  private projectileLoops = new Map<string, ProjectileLoop>();
  private oneShotPools = new Map<string, HTMLAudioElement[]>();
  private oneShotThrottle = new Map<string, number>();
  private processedEventIds = new Set<string>();
  private previousSnapshot: SnapshotPacket | null = null;

  unlock(): void {
    if (this.unlocked) {
      return;
    }

    this.unlocked = true;
    this.syncAmbient();
  }

  sync(input: AvaraSoundscapeInput): void {
    this.scene = input.scene;
    this.roomActive = input.roomActive;

    if (input.pointerLocked) {
      this.unlock();
    }

    this.syncAmbient();

    if (!input.snapshot || !input.localPlayerId) {
      this.previousSnapshot = null;
      this.stopProjectileLoops();
      return;
    }

    const localPlayer = input.snapshot.players.find((player) => player.id === input.localPlayerId) ?? null;
    this.processEvents(input.snapshot, input.localPlayerId);
    this.processFootsteps(input.snapshot, localPlayer);
    this.processProjectiles(input.snapshot, localPlayer);
    this.processTransportHeuristic(input.snapshot, input.localPlayerId);
    this.previousSnapshot = input.snapshot;
  }

  dispose(): void {
    this.stopProjectileLoops();
    for (const audio of this.ambientTracks.values()) {
      safeStop(audio);
    }
    this.ambientTracks.clear();
    for (const pool of this.oneShotPools.values()) {
      for (const audio of pool) {
        safeStop(audio);
      }
    }
    this.oneShotPools.clear();
    this.oneShotThrottle.clear();
    this.previousSnapshot = null;
  }

  private syncAmbient(): void {
    const desiredTracks = this.unlocked && this.roomActive ? this.scene?.soundscape.ambient ?? [] : [];
    const liveKeys = new Set(desiredTracks.map((track) => trackKey(track)));

    for (const [key, audio] of this.ambientTracks.entries()) {
      if (!liveKeys.has(key)) {
        safeStop(audio);
        this.ambientTracks.delete(key);
      }
    }

    for (const track of desiredTracks) {
      const key = trackKey(track);
      let audio = this.ambientTracks.get(key);
      if (!audio) {
        audio = createLoopAudio(track.soundId, track.assetUrl, normalizeAmbientVolume(track.volume));
        this.ambientTracks.set(key, audio);
      }
      audio.volume = normalizeAmbientVolume(track.volume);
      void safePlay(audio);
    }
  }

  private processEvents(snapshot: SnapshotPacket, localPlayerId: string): void {
    for (const event of snapshot.events) {
      if (this.processedEventIds.has(event.id)) {
        continue;
      }
      this.processedEventIds.add(event.id);
      if (this.processedEventIds.size > 256) {
        const retained = Array.from(this.processedEventIds).slice(-128);
        this.processedEventIds = new Set(retained);
      }

      if ((event.event === "spawn" || event.event === "respawn") && event.actorPlayerId === localPlayerId) {
        const incarnateSoundId = this.scene?.settings.incarnateSoundId ?? DEFAULT_INCARNATE_SOUND_ID;
        const incarnateSoundUrl = this.scene?.settings.incarnateSoundUrl;
        const incarnateVolume = normalizeIncarnateVolume(this.scene?.settings.incarnateVolume ?? 12);
        this.playOneShot(incarnateSoundId, incarnateSoundUrl, incarnateVolume);
        continue;
      }

      if (event.event === "pickup" && event.actorPlayerId === localPlayerId) {
        this.playOneShot(DEFAULT_PICKUP_SOUND_ID, undefined, 0.38);
      }
    }
  }

  private processProjectiles(snapshot: SnapshotPacket, localPlayer: SnapshotPlayerState | null): void {
    const previousProjectiles = new Map((this.previousSnapshot?.projectiles ?? []).map((projectile) => [projectile.id, projectile]));
    const liveProjectileIds = new Set<string>();

    for (const projectile of snapshot.projectiles) {
      liveProjectileIds.add(projectile.id);
      if (!previousProjectiles.has(projectile.id)) {
        if (projectile.kind === "plasma") {
          this.playOneShot(
            DEFAULT_SHOT_SOUND_ID,
            undefined,
            spatialVolume(localPlayer, projectile, 0.34)
          );
        } else {
          this.startProjectileLoop(projectile, localPlayer);
        }
      } else if (projectile.kind !== "plasma") {
        this.updateProjectileLoop(projectile, localPlayer);
      }
    }

    for (const previousProjectile of previousProjectiles.values()) {
      if (liveProjectileIds.has(previousProjectile.id)) {
        continue;
      }

      this.stopProjectileLoop(previousProjectile.id);
      if (previousProjectile.kind === "plasma") {
        continue;
      }

      this.playOneShot(
        previousProjectile.kind === "grenade"
          ? DEFAULT_GRENADE_BLAST_SOUND_ID
          : this.scene?.settings.blastSoundDefaultId ?? DEFAULT_MISSILE_BLAST_SOUND_ID,
        previousProjectile.kind === "grenade"
          ? undefined
          : this.scene?.settings.blastSoundDefaultUrl,
        spatialVolume(localPlayer, previousProjectile, 0.55)
      );
    }
  }

  private processFootsteps(snapshot: SnapshotPacket, localPlayer: SnapshotPlayerState | null): void {
    const previousPlayers = new Map((this.previousSnapshot?.players ?? []).map((player) => [player.id, player]));
    const groundStepSoundId = this.scene?.settings.groundStepSoundId ?? DEFAULT_GROUND_STEP_SOUND_ID;
    const groundStepSoundUrl = this.scene?.settings.groundStepSoundUrl;

    for (const player of snapshot.players) {
      if (!player.alive || !player.legs?.length) {
        continue;
      }

      const previousPlayer = previousPlayers.get(player.id);
      for (let index = 0; index < player.legs.length; index += 1) {
        const leg = player.legs[index];
        const previousLeg = previousPlayer?.legs?.[index];
        if (!leg || !leg.touching) {
          continue;
        }

        const newlyTouching = previousLeg ? !previousLeg.touching : false;
        const landingDrop = Math.max(0, (previousLeg?.whereY ?? leg.whereY) - leg.whereY);
        const impact = landingDrop + Math.hypot(player.vx ?? 0, player.vz ?? 0) + Math.abs(player.vy ?? 0) * 0.35;
        if (!newlyTouching && impact < 0.12) {
          continue;
        }

        this.playOneShot(
          groundStepSoundId,
          groundStepSoundUrl,
          spatialVolume(localPlayer, { x: leg.whereX, y: leg.whereY, z: leg.whereZ }, clamp(0.12 + impact * 0.22, 0.08, 0.42)),
          `step:${player.id}:${index}`,
          110
        );
      }
    }
  }

  private processTransportHeuristic(snapshot: SnapshotPacket, localPlayerId: string): void {
    if (!this.scene?.nodes.some((node) => node.type === "teleporter")) {
      return;
    }

    const previousPlayer = this.previousSnapshot?.players.find((player) => player.id === localPlayerId) ?? null;
    const nextPlayer = snapshot.players.find((player) => player.id === localPlayerId) ?? null;
    if (!previousPlayer || !nextPlayer || !previousPlayer.alive || !nextPlayer.alive) {
      return;
    }

    const displacement = distanceBetween(previousPlayer, nextPlayer);
    if (displacement < 14) {
      return;
    }

    const previousNearTeleporter = this.scene.nodes.some(
      (node) => node.type === "teleporter" && distanceBetween(node.position, previousPlayer) < 10
    );
    const nextNearTeleporter = this.scene.nodes.some(
      (node) => node.type === "teleporter" && distanceBetween(node.position, nextPlayer) < 10
    );
    if (!previousNearTeleporter && !nextNearTeleporter) {
      return;
    }

    const teleporterSoundId = resolveNearestTeleporterSound(this.scene, previousPlayer, nextPlayer);
    this.playOneShot(teleporterSoundId, undefined, 0.48);
  }

  private startProjectileLoop(projectile: SnapshotProjectileState, localPlayer: SnapshotPlayerState | null): void {
    if (!this.unlocked || this.projectileLoops.has(projectile.id)) {
      this.updateProjectileLoop(projectile, localPlayer);
      return;
    }

    const audio = createLoopAudio(DEFAULT_WEAPON_LOOP_SOUND_ID, undefined, spatialVolume(localPlayer, projectile, 0.22));
    const loop: ProjectileLoop = {
      audio,
      projectileId: projectile.id,
      kind: projectile.kind,
      x: projectile.x,
      y: projectile.y,
      z: projectile.z
    };
    this.projectileLoops.set(projectile.id, loop);
    void safePlay(audio);
  }

  private updateProjectileLoop(projectile: SnapshotProjectileState, localPlayer: SnapshotPlayerState | null): void {
    const loop = this.projectileLoops.get(projectile.id);
    if (!loop) {
      return;
    }

    loop.x = projectile.x;
    loop.y = projectile.y;
    loop.z = projectile.z;
    loop.audio.volume = spatialVolume(localPlayer, projectile, 0.22);
  }

  private stopProjectileLoop(projectileId: string): void {
    const loop = this.projectileLoops.get(projectileId);
    if (!loop) {
      return;
    }

    safeStop(loop.audio);
    this.projectileLoops.delete(projectileId);
  }

  private stopProjectileLoops(): void {
    for (const loop of this.projectileLoops.values()) {
      safeStop(loop.audio);
    }
    this.projectileLoops.clear();
  }

  private playOneShot(
    soundId: number,
    assetUrl: string | undefined,
    volume: number,
    throttleKey?: string,
    throttleMs = 0
  ): void {
    if (!this.unlocked || volume <= 0.001) {
      return;
    }

    const now = performance.now();
    if (throttleKey) {
      const previous = this.oneShotThrottle.get(throttleKey) ?? 0;
      if ((now - previous) < throttleMs) {
        return;
      }
      this.oneShotThrottle.set(throttleKey, now);
      if (this.oneShotThrottle.size > 256) {
        const retained = Array.from(this.oneShotThrottle.entries()).slice(-128);
        this.oneShotThrottle = new Map(retained);
      }
    }

    const poolKey = `${soundId}:${assetUrl ?? "builtin"}`;
    let pool = this.oneShotPools.get(poolKey);
    if (!pool) {
      pool = [];
      this.oneShotPools.set(poolKey, pool);
    }

    let audio = pool.find((candidate) => candidate.paused || candidate.ended);
    if (!audio) {
      if (pool.length >= 6) {
        return;
      }
      audio = new Audio(resolveSoundUrl(soundId, assetUrl));
      audio.preload = "auto";
      pool.push(audio);
    }

    audio.volume = clamp(volume, 0, 1);
    try {
      audio.currentTime = 0;
    } catch {
      return;
    }
    void safePlay(audio);
  }
}

export function useAvaraSoundscape(input: AvaraSoundscapeInput): void {
  const runtimeRef = useRef<AvaraSoundRuntime | null>(null);

  if (!runtimeRef.current && typeof window !== "undefined") {
    runtimeRef.current = new AvaraSoundRuntime();
  }

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) {
      return;
    }

    const unlock = () => runtime.unlock();
    document.addEventListener("pointerdown", unlock, true);
    document.addEventListener("keydown", unlock, true);

    return () => {
      document.removeEventListener("pointerdown", unlock, true);
      document.removeEventListener("keydown", unlock, true);
      runtime.dispose();
    };
  }, []);

  useEffect(() => {
    runtimeRef.current?.sync(input);
  }, [input]);
}

function createLoopAudio(soundId: number, assetUrl: string | undefined, volume: number): HTMLAudioElement {
  const audio = new Audio(resolveSoundUrl(soundId, assetUrl));
  audio.preload = "auto";
  audio.loop = true;
  audio.volume = clamp(volume, 0, 1);
  return audio;
}

function resolveSoundUrl(soundId: number, assetUrl?: string): string {
  return resolveApiAssetUrl(assetUrl ?? `${ROOT_SOUND_CONTENT_PREFIX}/${soundId}.ogg`);
}

function trackKey(track: SceneSound): string {
  return `${track.soundId}:${track.assetUrl ?? "builtin"}:${track.position?.x ?? 0}:${track.position?.z ?? 0}`;
}

function safePlay(audio: HTMLAudioElement): Promise<void> {
  return audio.play().then(() => undefined).catch(() => undefined);
}

function safeStop(audio: HTMLAudioElement): void {
  audio.pause();
  audio.currentTime = 0;
}

function normalizeAmbientVolume(volume: number): number {
  return clamp((volume / 100) * 0.32, 0, 0.45);
}

function normalizeIncarnateVolume(volume: number): number {
  return clamp(volume / 15, 0, 0.9);
}

function spatialVolume(listener: SnapshotPlayerState | null, source: Vector3Like, base: number): number {
  if (!listener) {
    return base;
  }

  const distance = distanceBetween(listener, source);
  const normalized = 1 / (1 + ((distance / 18) ** 2));
  return clamp(base * normalized, 0, 1);
}

function distanceBetween(left: Vector3Like, right: Vector3Like): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function resolveNearestTeleporterSound(scene: LevelScene, previousPlayer: Vector3Like, nextPlayer: Vector3Like): number {
  let closestSoundId = DEFAULT_TELEPORT_SOUND_ID;
  let closestDistance = Number.POSITIVE_INFINITY;

  for (const node of scene.nodes) {
    if (node.type !== "teleporter") {
      continue;
    }

    const nodeSoundId = typeof node.meta?.sound === "number" && node.meta.sound > 0
      ? node.meta.sound
      : DEFAULT_TELEPORT_SOUND_ID;
    const distance = Math.min(distanceBetween(node.position, previousPlayer), distanceBetween(node.position, nextPlayer));
    if (distance < closestDistance) {
      closestDistance = distance;
      closestSoundId = nodeSoundId;
    }
  }

  return closestSoundId;
}
