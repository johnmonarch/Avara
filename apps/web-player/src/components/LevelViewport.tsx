import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

import type {
  SnapshotScoutState,
  SnapshotPacket,
  SnapshotPickupState,
  SnapshotPlayerState,
  SnapshotProjectileState
} from "@avara/shared-protocol";
import type { GraphicsQuality, LevelBillboardAssignment, LevelScene, PlayerSettings, SceneNode } from "@avara/shared-types";
import { CONTROL_PRESET_BINDINGS } from "@avara/shared-ui";
import { resolveApiAssetUrl } from "../lib/api";

interface LevelViewportProps {
  scene: LevelScene | null;
  billboards: LevelBillboardAssignment[];
  snapshot: SnapshotPacket | null;
  localPlayerId?: string;
  arenaState?: "preview" | "spawning" | "ready";
  arenaActionLabel?: string;
  arenaActionDetail?: string;
  onArenaAction?: () => void;
  playerSettings: PlayerSettings;
  prototypeStatus: "idle" | "bootstrapping" | "live";
  onAimChange?: (aim: { aimYaw: number; aimPitch: number }) => void;
  onPointerLockChange?: (locked: boolean) => void;
  onTelemetryChange?: (input: {
    fps: number | null;
    pixelRatio: number;
    quality: GraphicsQuality;
    compatibilityError: string | null;
  }) => void;
}

interface BspShapeData {
  points: [number, number, number][];
  normals: [number, number, number][];
  polys: Array<{ normal: number; tris: number[]; mat?: number }>;
  materials?: Array<{ base?: string; spec?: string }>;
}

interface BspRenderableData {
  groups: Array<{
    geometry: THREE.BufferGeometry;
    baseToken?: string;
    baseColor?: string;
  }>;
}

interface MarkerPalette {
  marker0: string;
  marker1: string;
  marker2: string;
  marker3: string;
  fallback: string;
}

const shapeCache = new Map<string, Promise<THREE.BufferGeometry>>();
const shapeRenderableCache = new Map<string, Promise<BspRenderableData>>();
const resolvedRenderableCache = new Map<string, BspRenderableData>();
const billboardTextureCache = new Map<string, Promise<THREE.Texture>>();
const ROOT_BSP_CONTENT_PREFIX = "/content/rsrc/bsps";
const LIVE_ASSET_URLS = {
  scout: `${ROOT_BSP_CONTENT_PREFIX}/220.json`,
  hector: `${ROOT_BSP_CONTENT_PREFIX}/215.json`,
  hectorHead: `${ROOT_BSP_CONTENT_PREFIX}/210.json`,
  hectorLegHigh: `${ROOT_BSP_CONTENT_PREFIX}/211.json`,
  hectorLegLow: `${ROOT_BSP_CONTENT_PREFIX}/212.json`,
  plasma: `${ROOT_BSP_CONTENT_PREFIX}/203.json`,
  missile: `${ROOT_BSP_CONTENT_PREFIX}/802.json`,
  grenade: `${ROOT_BSP_CONTENT_PREFIX}/820.json`
} as const;
const PRELOAD_ASSET_URLS = Object.values(LIVE_ASSET_URLS);
const SCOUT_CAMERA_OFFSET = 0.1;
const HECTOR_LEG_SPACE = 0.6;
const HECTOR_LEG_HIGH_LENGTH = 0.905;
const HECTOR_LEG_LOW_LENGTH = 1.15;
const HECTOR_VIEWPORT_HEIGHT = 0.35;
const HECTOR_DEFAULT_STANCE = 1.7;
const HECTOR_DEFAULT_RIDE_HEIGHT = 0.2500038147554742;
const VIEW_OFFSET_Y = -0.25;
const GUN_MOUNT_OFFSET_X = 0.25;
const GUN_MOUNT_OFFSET_Y = 0;
const GUN_MOUNT_OFFSET_Z = 0.75;
const SMART_MISSILE_MOUNT_OFFSET = { x: 0, y: 0.45, z: 0.6 };
const GRENADE_MOUNT_OFFSET = { x: 0, y: -0.2, z: 0.95 };
const SMART_MISSILE_TARGET_RANGE = 160;
const BSP_FORWARD_YAW_OFFSET = -Math.PI / 2;
const FIRST_PERSON_HULL_OFFSET = { x: 0, y: -0.28, z: 0.54 };

export default function LevelViewport({
  scene,
  billboards,
  snapshot,
  localPlayerId,
  arenaState = "preview",
  arenaActionLabel,
  arenaActionDetail,
  onArenaAction,
  playerSettings,
  prototypeStatus,
  onAimChange,
  onPointerLockChange,
  onTelemetryChange
}: LevelViewportProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const pointerLockTargetRef = useRef<HTMLCanvasElement | null>(null);
  const [pointerLocked, setPointerLocked] = useState(false);
  const [renderStats, setRenderStats] = useState({
    nodes: 0,
    meshes: 0,
    fps: null as number | null,
    pixelRatio: 1,
    compatibilityError: null as string | null
  });
  const heading = useRef({ yaw: Math.PI / 2, pitch: -0.14 });
  const snapshotRef = useRef<SnapshotPacket | null>(snapshot);
  const localPlayerIdRef = useRef(localPlayerId);
  const aimCallbackRef = useRef(onAimChange);
  const billboardRef = useRef<LevelBillboardAssignment[]>(billboards);
  const boundPlayerIdRef = useRef("");
  const settingsRef = useRef(playerSettings);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  useEffect(() => {
    localPlayerIdRef.current = localPlayerId;
  }, [localPlayerId]);

  useEffect(() => {
    aimCallbackRef.current = onAimChange;
  }, [onAimChange]);

  useEffect(() => {
    billboardRef.current = billboards;
  }, [billboards]);

  useEffect(() => {
    settingsRef.current = playerSettings;
  }, [playerSettings]);

  useEffect(() => {
    onPointerLockChange?.(pointerLocked);
  }, [onPointerLockChange, pointerLocked]);

  useEffect(() => {
    onTelemetryChange?.({
      fps: renderStats.fps,
      pixelRatio: renderStats.pixelRatio,
      quality: playerSettings.graphicsQuality,
      compatibilityError: renderStats.compatibilityError
    });
  }, [onTelemetryChange, playerSettings.graphicsQuality, renderStats.compatibilityError, renderStats.fps, renderStats.pixelRatio]);

  const spawnAnchor = useMemo(() => {
    const spawn = scene?.nodes.find((node) => node.type === "spawn") ?? scene?.nodes[0];
    return spawn?.position ?? { x: 0, y: 0, z: 0 };
  }, [scene]);

  const localPlayer = useMemo(
    () => snapshot?.players.find((player) => player.id === localPlayerId) ?? null,
    [localPlayerId, snapshot]
  );
  const localScout = useMemo(
    () => {
      if (!snapshot || !localPlayer) {
        return null;
      }
      return snapshot.scouts.find((scout) => scout.ownerPlayerId === localPlayer.id) ?? null;
    },
    [localPlayer, snapshot]
  );

  const leaderboard = useMemo(
    () =>
      (snapshot?.players ?? []).slice().sort((left, right) => {
        if (left.kills !== right.kills) {
          return right.kills - left.kills;
        }
        return left.deaths - right.deaths;
      }),
    [snapshot]
  );

  const legHeadingDegrees = localPlayer
    ? Math.round((normalizeAngle(localPlayer.turretYaw - localPlayer.bodyYaw) * 180) / Math.PI)
    : 0;

  const reticleState = useMemo(() => {
    if (!snapshot || !localPlayer?.alive) {
      return "neutral";
    }

    if (typeof localPlayer.targetLocked === "boolean") {
      return localPlayer.targetLocked ? "locked" : "neutral";
    }

    const origin = {
      x: localPlayer.x,
      y: localPlayer.y + getPlayerViewTargetHeight(localPlayer) + VIEW_OFFSET_Y,
      z: localPlayer.z
    };
    const forward = directionFromYawPitch(localPlayer.turretYaw, localPlayer.turretPitch);
    let bestAlignment = -1;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const candidate of snapshot.players) {
      if (!candidate.alive || candidate.id === localPlayer.id) {
        continue;
      }

      const dx = candidate.x - origin.x;
      const dy = candidate.y + 2.1 - origin.y;
      const dz = candidate.z - origin.z;
      const distance = Math.hypot(dx, dy, dz);
      if (distance <= 0.0001 || distance > SMART_MISSILE_TARGET_RANGE) {
        continue;
      }

      const dirX = dx / distance;
      const dirY = dy / distance;
      const dirZ = dz / distance;
      const alignment = dirX * forward.x + dirY * forward.y + dirZ * forward.z;
      if (alignment > bestAlignment || (alignment === bestAlignment && distance < bestDistance)) {
        bestAlignment = alignment;
        bestDistance = distance;
      }
    }

    if (localPlayer.weaponLoad === "missile") {
      return bestAlignment >= 0.72 ? "locked" : "neutral";
    }

    return bestAlignment >= 0.97 ? "locked" : "neutral";
  }, [localPlayer, snapshot]);

  const presetPrompts = CONTROL_PRESET_BINDINGS[playerSettings.controlPreset];

  useEffect(() => {
    if (!localPlayer) {
      boundPlayerIdRef.current = "";
      return;
    }

    if (boundPlayerIdRef.current === localPlayer.id) {
      return;
    }

    heading.current = {
      yaw: localPlayer.turretYaw,
      pitch: -0.14
    };
    boundPlayerIdRef.current = localPlayer.id;
  }, [localPlayer]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || !scene) {
      return;
    }

    let cancelled = false;
    let animationHandle = 0;

    const profile = getRenderProfile(playerSettings.graphicsQuality);
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: profile.antialias,
        alpha: true,
        powerPreference: "high-performance"
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Renderer initialization failed";
      setRenderStats((current) => ({
        ...current,
        compatibilityError: message
      }));
      return;
    }

    const pixelRatio = Math.min(window.devicePixelRatio || 1, profile.pixelRatioCap);
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);
    pointerLockTargetRef.current = renderer.domElement;
    setRenderStats((current) => ({
      ...current,
      pixelRatio,
      compatibilityError: null
    }));

    const threeScene = new THREE.Scene();
    threeScene.background = new THREE.Color(scene.environment.skyColors[0] ?? "#9bd7ff");
    threeScene.fog = new THREE.Fog(scene.environment.skyColors[1] ?? "#dbe8ff", 140, profile.fogFar);

    const camera = new THREE.PerspectiveCamera(64, mount.clientWidth / mount.clientHeight, 0.03, 1000);
    threeScene.add(camera);

    const ambient = new THREE.HemisphereLight(
      new THREE.Color(scene.environment.skyColors[0] ?? "#9bd7ff"),
      new THREE.Color(scene.environment.groundColor ?? "#2c3138"),
      1.24
    );
    threeScene.add(ambient);

    const sun = new THREE.DirectionalLight("#f8fbff", 1.2);
    sun.position.set(40, 84, 18);
    threeScene.add(sun);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 400),
      new THREE.MeshStandardMaterial({
        color: scene.environment.groundColor ?? "#2c3138",
        roughness: 0.95,
        metalness: 0.05
      })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    threeScene.add(ground);

    const sceneRoot = new THREE.Group();
    threeScene.add(sceneRoot);

    const billboardLayer = new THREE.Group();
    const pickupLayer = new THREE.Group();
    const projectileLayer = new THREE.Group();
    const scoutLayer = new THREE.Group();
    const playerLayer = new THREE.Group();
    threeScene.add(billboardLayer, pickupLayer, projectileLayer, scoutLayer, playerLayer);
    const cockpitRig = createFirstPersonCockpitRig();
    camera.add(cockpitRig);

    const billboardNodes = scene.nodes.filter((node) => node.type === "ad_placeholder" && node.slotId);
    const billboardMeshes = new Map<string, THREE.Group>();
    const pickupMeshes = new Map<string, THREE.Object3D>();
    const projectileMeshes = new Map<string, THREE.Object3D>();
    const scoutMeshes = new Map<string, THREE.Object3D>();
    const playerMeshes = new Map<string, THREE.Object3D>();

    void Promise.all(
      PRELOAD_ASSET_URLS.flatMap((url) => [loadBspGeometry(url), loadBspRenderable(url)])
    ).catch(() => undefined);

    void populateScene(sceneRoot, scene.nodes).then((meshCount) => {
      if (!cancelled) {
        setRenderStats((current) => ({
          ...current,
          nodes: scene.nodes.length,
          meshes: meshCount
        }));
      }
    });

    const onResize = () => {
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
    };

    const onPointerLockChangeInternal = () => {
      setPointerLocked(document.pointerLockElement === renderer.domElement);
    };

    const onMouseMove = (event: MouseEvent) => {
      if (document.pointerLockElement !== renderer.domElement) {
        return;
      }

      const yawScale = 0.0024 * settingsRef.current.sensitivity;
      const pitchScale = 0.0017 * settingsRef.current.sensitivity;
      const pitchDirection = settingsRef.current.invertY ? 1 : -1;

      heading.current.yaw -= event.movementX * yawScale;
      heading.current.pitch = THREE.MathUtils.clamp(
        heading.current.pitch + event.movementY * pitchScale * pitchDirection,
        -0.55,
        0.32
      );
    };

    const onClick = () => {
      renderer.domElement.requestPointerLock();
    };

    window.addEventListener("resize", onResize);
    document.addEventListener("pointerlockchange", onPointerLockChangeInternal);
    document.addEventListener("mousemove", onMouseMove);
    renderer.domElement.addEventListener("click", onClick);

    let sampleStart = performance.now();
    let lastFrameAt = sampleStart;
    let framesSinceSample = 0;

    const animate = () => {
      if (cancelled) {
        return;
      }

      animationHandle = requestAnimationFrame(animate);
      if (document.hidden) {
        return;
      }

      const currentSnapshot = snapshotRef.current;
      const now = performance.now();
      const frameDelta = Math.min(0.05, Math.max(0.001, (now - lastFrameAt) / 1000));
      lastFrameAt = now;

      syncBillboardMeshes(billboardLayer, billboardMeshes, billboardNodes, billboardRef.current);
      syncPickupMeshes(pickupLayer, pickupMeshes, currentSnapshot?.pickups ?? []);
      syncProjectileMeshes(projectileLayer, projectileMeshes, currentSnapshot?.projectiles ?? []);
      syncScoutMeshes(scoutLayer, scoutMeshes, currentSnapshot?.scouts ?? [], localPlayerIdRef.current);
      syncPlayerMeshes(playerLayer, playerMeshes, currentSnapshot?.players ?? [], localPlayerIdRef.current);
      smoothDynamicObjects(playerMeshes, frameDelta);
      smoothDynamicObjects(scoutMeshes, frameDelta);
      smoothDynamicObjects(projectileMeshes, frameDelta, 0.82);

      const liveLocalPlayer = currentSnapshot?.players.find((player) => player.id === localPlayerIdRef.current) ?? null;
      const liveLocalScout = currentSnapshot?.scouts.find((scout) => scout.ownerPlayerId === localPlayerIdRef.current) ?? null;
      if (liveLocalPlayer) {
        const yawError = normalizeAngle(liveLocalPlayer.turretYaw - heading.current.yaw);
        const yawCatchup = document.pointerLockElement === renderer.domElement ? 0.22 : 0.46;
        heading.current.yaw = normalizeAngle(heading.current.yaw + yawError * yawCatchup);
      }
      if (liveLocalPlayer && aimCallbackRef.current) {
        aimCallbackRef.current({
          aimYaw: THREE.MathUtils.clamp(normalizeAngle(heading.current.yaw - liveLocalPlayer.bodyYaw), -1.2, 1.2),
          aimPitch: THREE.MathUtils.clamp(heading.current.pitch, -0.8, 0.5)
        });
      }

      const localPlayerObject = localPlayerIdRef.current ? playerMeshes.get(localPlayerIdRef.current) ?? null : null;
      const localScoutObject = liveLocalScout ? scoutMeshes.get(liveLocalScout.id) ?? null : null;
      const focus = localPlayerObject
        ? { x: localPlayerObject.position.x, y: localPlayerObject.position.y, z: localPlayerObject.position.z }
        : liveLocalPlayer
          ? { x: liveLocalPlayer.x, y: liveLocalPlayer.y, z: liveLocalPlayer.z }
          : spawnAnchor;
      const scoutViewActive = Boolean(liveLocalPlayer?.alive && liveLocalPlayer?.scoutView && liveLocalScout?.active);

      if (localPlayerObject) {
        localPlayerObject.visible = Boolean(liveLocalPlayer?.alive && scoutViewActive);
      }

      updateFirstPersonCockpitRig(cockpitRig, liveLocalPlayer, scoutViewActive);

      if (scoutViewActive && liveLocalPlayer && liveLocalScout) {
        const scoutOrigin = localScoutObject
          ? localScoutObject.position
          : new THREE.Vector3(liveLocalScout.x, liveLocalScout.y, liveLocalScout.z);
        camera.position.set(
          scoutOrigin.x + SCOUT_CAMERA_OFFSET,
          scoutOrigin.y + SCOUT_CAMERA_OFFSET,
          scoutOrigin.z
        );
        camera.lookAt(
          focus.x,
          focus.y + getPlayerViewTargetHeight(liveLocalPlayer),
          focus.z
        );
      } else if (liveLocalPlayer?.alive) {
        const hullObject = localPlayerObject?.getObjectByName("walker-hull") ?? null;
        const cameraOrigin = hullObject
          ? hullObject.getWorldPosition(new THREE.Vector3()).add(
              new THREE.Vector3(0, VIEW_OFFSET_Y, 0).applyQuaternion(
                hullObject.getWorldQuaternion(new THREE.Quaternion())
              )
            )
          : new THREE.Vector3(
              focus.x,
              focus.y + getPlayerViewTargetHeight(liveLocalPlayer) + VIEW_OFFSET_Y,
              focus.z
            );
        const viewDirection = directionFromYawPitch(heading.current.yaw, heading.current.pitch);
        camera.position.copy(cameraOrigin);
        camera.lookAt(
          cameraOrigin.x + viewDirection.x * 12,
          cameraOrigin.y + viewDirection.y * 12,
          cameraOrigin.z + viewDirection.z * 12
        );
      } else {
        const chaseDistance = liveLocalPlayer?.alive ? 7.25 : 20;
        const cameraHeight = liveLocalPlayer?.alive ? 3.4 : 10.5;
        const lookDistance = liveLocalPlayer?.alive ? 5.8 : 10;
        camera.position.set(
          focus.x - Math.cos(heading.current.yaw) * chaseDistance,
          focus.y + cameraHeight - heading.current.pitch * (liveLocalPlayer?.alive ? 2.5 : 8),
          focus.z - Math.sin(heading.current.yaw) * chaseDistance
        );
        camera.lookAt(
          focus.x + Math.cos(heading.current.yaw) * lookDistance,
          focus.y + (liveLocalPlayer?.alive ? 1.85 : 3.4) + heading.current.pitch * (liveLocalPlayer?.alive ? 2.4 : 5),
          focus.z + Math.sin(heading.current.yaw) * lookDistance
        );
      }

      renderer.render(threeScene, camera);

      framesSinceSample += 1;
      if (now - sampleStart >= 500) {
        const nextFps = Math.round((framesSinceSample * 1000) / (now - sampleStart));
        framesSinceSample = 0;
        sampleStart = now;
        setRenderStats((current) =>
          current.fps === nextFps
            ? current
            : {
                ...current,
                fps: nextFps
              }
        );
      }
    };

    animationHandle = requestAnimationFrame(animate);

    return () => {
      cancelled = true;
      pointerLockTargetRef.current = null;
      window.removeEventListener("resize", onResize);
      document.removeEventListener("pointerlockchange", onPointerLockChangeInternal);
      document.removeEventListener("mousemove", onMouseMove);
      renderer.domElement.removeEventListener("click", onClick);
      cancelAnimationFrame(animationHandle);
      renderer.dispose();
      mount.innerHTML = "";
    };
  }, [playerSettings.graphicsQuality, scene, spawnAnchor]);

  if (!scene) {
    return <div className="viewport-empty">Select a room or level to load imported geometry.</div>;
  }

  if (renderStats.compatibilityError) {
    return (
      <div className="viewport-shell viewport-empty">
        Renderer unavailable: {renderStats.compatibilityError}
      </div>
    );
  }

  function requestPointerLock() {
    if (arenaState !== "ready") {
      return;
    }
    pointerLockTargetRef.current?.requestPointerLock();
  }

  return (
    <div className="viewport-shell" onClick={!pointerLocked && arenaState === "ready" ? requestPointerLock : undefined}>
      <div className="viewport-canvas" ref={mountRef} />

      {arenaState !== "ready" ? (
        <div className="pointer-lock-overlay" role="status" aria-live="polite">
          <div className="pointer-lock-card">
            <span className="eyebrow">{arenaState === "spawning" ? "Joining Arena" : "Arena Preview"}</span>
            <h3>{arenaState === "spawning" ? "Spawning Hector…" : "Spawn Hector to drive"}</h3>
            <p>
              {arenaActionDetail
                ?? (arenaState === "spawning"
                  ? "The room is connecting and the authoritative server is spawning your mech."
                  : "Choose or create a room first. The current view is only the imported level preview." )}
            </p>
            {onArenaAction && arenaActionLabel ? (
              <button className="primary-button" onClick={onArenaAction}>
                {arenaActionLabel}
              </button>
            ) : null}
          </div>
        </div>
      ) : !pointerLocked ? (
        <div
          className="pointer-lock-overlay"
          role="button"
          tabIndex={0}
          onClick={requestPointerLock}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              requestPointerLock();
            }
          }}
        >
          <div className="pointer-lock-card">
            <span className="eyebrow">{playerSettings.controlPreset === "classic" ? "Classic Controls" : "Modernized Controls"}</span>
            <h3>Click the arena to lock your pointer</h3>
            <p>
              {playerSettings.controlPreset === "classic"
                ? "Drive with W/S, rotate the chassis with A/D, aim with the mouse, fire with left click, and keep crouch or jump on Space."
                : "Drive with W/S or arrows, rotate the chassis with A/D or arrows, fire with left click, hold Space to crouch, and release it to jump."}
            </p>
          </div>
        </div>
      ) : null}

      {pointerLocked ? (
        <div className={`reticle reticle-${reticleState}`} aria-hidden="true">
          <span className="reticle-bracket reticle-bracket-left"><span /></span>
          <span className="reticle-bracket reticle-bracket-right"><span /></span>
        </div>
      ) : null}

      <div className="viewport-hud viewport-hud-top">
        <div className="hud-pill">Imported scene: {scene.title}</div>
        <div className="hud-pill">Actors: {renderStats.nodes}</div>
        <div className="hud-pill">
          Billboards: {billboards.filter((billboard) => billboard.campaignId).length}/{billboards.length}
        </div>
        <div className="hud-pill">Players: {snapshot?.players.length ?? 0}</div>
        <div className="hud-pill">Scouts: {snapshot?.scouts.length ?? 0}</div>
        <div className="hud-pill">Match: {snapshot?.roomStatus ?? prototypeStatus}</div>
        <div className="hud-pill">Render: {playerSettings.graphicsQuality}</div>
        {snapshot ? <div className="hud-pill">{snapshot.remainingSeconds}s left</div> : null}
        {localPlayer?.scoutView ? <div className="hud-pill">Scout view</div> : null}
        {playerSettings.showPerformanceHud ? (
          <>
            <div className="hud-pill">FPS: {renderStats.fps ?? "…"}</div>
            <div className="hud-pill">Scale: {renderStats.pixelRatio.toFixed(2)}x</div>
          </>
        ) : null}
      </div>

      {localPlayer ? (
        <div className="combat-hud">
          <div className="hud-panel">
            <div className="hud-row">
              <span>Hull</span>
              <strong>{localPlayer.health}</strong>
            </div>
            <div className="health-bar">
              <span style={{ width: `${Math.max(0, Math.min(100, localPlayer.health))}%` }} />
            </div>
            <div className="ammo-strip">
              <span>Load: {localPlayer.weaponLoad}</span>
              <span>Missiles {localPlayer.missileAmmo}</span>
              <span>Grenades {localPlayer.grenadeAmmo}</span>
            </div>
            <div className="hud-row">
              <span>Leg direction</span>
              <strong>{legHeadingDegrees >= 0 ? `+${legHeadingDegrees}` : legHeadingDegrees}°</strong>
            </div>
            <div className="heading-indicator">
              <span
                className="heading-indicator-fill"
                style={{
                  left: `${50 + Math.max(-45, Math.min(45, legHeadingDegrees))}%`
                }}
              />
            </div>
            <div className="hud-row">
              <span>Score</span>
              <strong>
                {localPlayer.kills} / {localPlayer.deaths}
              </strong>
            </div>
            {localScout ? (
              <div className="hud-row">
                <span>Scout</span>
                <strong>{localScout.health}</strong>
              </div>
            ) : null}
            {!localPlayer.alive ? (
              <div className="respawn-banner">Respawning in {localPlayer.respawnSeconds}s</div>
            ) : null}
          </div>

          <div className="hud-panel scoreboard">
            <div className="hud-row">
              <span>Frag limit</span>
              <strong>{snapshot?.fragLimit ?? 0}</strong>
            </div>
            {leaderboard.slice(0, 4).map((player) => (
              <div key={player.id} className={player.id === localPlayerId ? "score-row score-row-local" : "score-row"}>
                <span>{player.displayName}</span>
                <strong>{player.kills}</strong>
              </div>
            ))}
            {playerSettings.controlPreset === "modernized" ? (
              <div className="prompt-strip">
                {presetPrompts.slice(0, 4).map((prompt) => (
                  <span key={prompt.action}>
                    {prompt.action}: {prompt.keys}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {snapshot?.events.length ? (
        <div className="event-feed">
          {snapshot.events.slice(-4).map((event) => (
            <div key={event.id} className="event-line">
              {event.message}
            </div>
          ))}
        </div>
      ) : null}

      {snapshot?.roomStatus === "ended" ? (
        <div className="match-banner">
          {snapshot.winnerPlayerId === localPlayerId ? "Victory" : "Match complete"}
        </div>
      ) : null}
    </div>
  );
}

function getRenderProfile(quality: GraphicsQuality): { antialias: boolean; pixelRatioCap: number; fogFar: number } {
  switch (quality) {
    case "performance":
      return {
        antialias: false,
        pixelRatioCap: 1,
        fogFar: 260
      };
    case "quality":
      return {
        antialias: true,
        pixelRatioCap: 2,
        fogFar: 360
      };
    case "balanced":
    default:
      return {
        antialias: true,
        pixelRatioCap: 1.5,
        fogFar: 320
      };
  }
}

async function populateScene(root: THREE.Group, nodes: SceneNode[]): Promise<number> {
  let meshCount = 0;

  for (const node of nodes) {
    const object = await createObjectForNode(node);
    root.add(object);
    meshCount += countMeshes(object);
  }

  return meshCount;
}

async function createObjectForNode(node: SceneNode): Promise<THREE.Object3D> {
  const material = new THREE.MeshStandardMaterial({
    color: node.color ?? inferColor(node),
    emissive: node.type === "teleporter" ? new THREE.Color(node.color ?? "#68d7ff") : new THREE.Color("#000000"),
    emissiveIntensity: node.type === "teleporter" ? 0.35 : 0
  });

  let mesh: THREE.Object3D;

  try {
    if (node.shapeAssetUrl) {
      const geometry = await loadBspGeometry(node.shapeAssetUrl);
      mesh = new THREE.Mesh(geometry, material);
      const scale = node.scale ?? 1;
      mesh.scale.setScalar(scale);
    } else {
      mesh = createFallbackMesh(node, material);
    }
  } catch {
    mesh = createFallbackMesh(node, material);
  }

  mesh.position.set(node.position.x, node.position.y, node.position.z);
  mesh.rotation.set(
    THREE.MathUtils.degToRad(node.rotation?.pitch ?? 0),
    THREE.MathUtils.degToRad(node.rotation?.yaw ?? 0),
    THREE.MathUtils.degToRad(node.rotation?.roll ?? 0)
  );

  return mesh;
}

function createFallbackMesh(node: SceneNode, material: THREE.MeshStandardMaterial): THREE.Object3D {
  const size = node.size ?? { width: 2, height: 2, depth: 2 };

  if (node.type === "teleporter") {
    return new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.24, 12, 32), material);
  }

  if (node.type === "spawn") {
    return new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 0.5, 24), material);
  }

  if (node.type === "goody") {
    return new THREE.Mesh(new THREE.IcosahedronGeometry(0.9, 0), material);
  }

  if (node.type === "ramp") {
    const shape = new THREE.Shape();
    shape.moveTo(-size.width / 2, 0);
    shape.lineTo(size.width / 2, 0);
    shape.lineTo(size.width / 2, size.height);
    shape.lineTo(-size.width / 2, 0);
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: size.depth,
      bevelEnabled: false
    });
    geometry.center();
    return new THREE.Mesh(geometry, material);
  }

  if (node.type === "field") {
    const fieldMaterial = material.clone();
    fieldMaterial.transparent = true;
    fieldMaterial.opacity = 0.28;
    return new THREE.Mesh(new THREE.BoxGeometry(size.width, size.height, size.depth), fieldMaterial);
  }

  if (node.type === "ad_placeholder") {
    return createBillboardPlaceholder(node, material);
  }

  return new THREE.Mesh(new THREE.BoxGeometry(size.width, size.height, size.depth), material);
}

async function loadBspGeometry(url: string): Promise<THREE.BufferGeometry> {
  const cached = shapeCache.get(url);
  if (cached) {
    return cached;
  }

  const pending = (async () => {
    const response = await fetch(resolveApiAssetUrl(url));
    if (!response.ok) {
      throw new Error(`Failed to load BSP ${url}: ${response.status}`);
    }

    const data = (await response.json()) as BspShapeData;
    const positions: number[] = [];
    const normals: number[] = [];

    for (const poly of data.polys) {
      for (let index = 0; index < poly.tris.length; index += 1) {
        const point = data.points[poly.tris[index]];
        const normal = data.normals[poly.normal] ?? [0, 1, 0];
        positions.push(point[0], point[1], point[2]);
        normals.push(normal[0], normal[1], normal[2]);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();
    return geometry;
  })();

  shapeCache.set(url, pending);

  try {
    return await pending;
  } catch (error) {
    shapeCache.delete(url);
    throw error;
  }
}

async function loadBspRenderable(url: string): Promise<BspRenderableData> {
  const cached = shapeRenderableCache.get(url);
  if (cached) {
    return cached;
  }

  const pending = (async () => {
    const response = await fetch(resolveApiAssetUrl(url));
    if (!response.ok) {
      throw new Error(`Failed to load BSP ${url}: ${response.status}`);
    }

    const data = (await response.json()) as BspShapeData;
    const groups = new Map<number, { positions: number[]; normals: number[] }>();

    for (const poly of data.polys) {
      const group = groups.get(poly.mat ?? 0) ?? { positions: [], normals: [] };
      groups.set(poly.mat ?? 0, group);
      for (let index = 0; index < poly.tris.length; index += 1) {
        const point = data.points[poly.tris[index]];
        const normal = data.normals[poly.normal] ?? [0, 1, 0];
        group.positions.push(point[0], point[1], point[2]);
        group.normals.push(normal[0], normal[1], normal[2]);
      }
    }

    const renderable: BspRenderableData = {
      groups: Array.from(groups.entries()).map(([matIndex, group]) => {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.Float32BufferAttribute(group.positions, 3));
        geometry.setAttribute("normal", new THREE.Float32BufferAttribute(group.normals, 3));
        geometry.computeBoundingSphere();
        geometry.computeBoundingBox();
        return {
          geometry,
          baseToken: extractMarkerIndex(data.materials?.[matIndex]?.base),
          baseColor: parseBspBaseColor(data.materials?.[matIndex]?.base)
        };
      })
    };
    resolvedRenderableCache.set(url, renderable);
    return renderable;
  })();

  shapeRenderableCache.set(url, pending);

  try {
    return await pending;
  } catch (error) {
    shapeRenderableCache.delete(url);
    resolvedRenderableCache.delete(url);
    throw error;
  }
}

function parseBspBaseColor(token: string | undefined): string | undefined {
  if (!token) {
    return undefined;
  }
  if (token.startsWith("#")) {
    return token;
  }
  return undefined;
}

function extractMarkerIndex(token: string | undefined): string | undefined {
  if (!token) {
    return undefined;
  }

  const match = token.trim().match(/^marker\((\d)\)$/i);
  return match ? `marker${match[1]}` : undefined;
}

function darkenHex(color: string, factor: number): string {
  const normalized = color.startsWith("#") ? color.slice(1) : color;
  if (normalized.length !== 6) {
    return color;
  }

  const channel = (offset: number) =>
    Math.max(0, Math.min(255, Math.round(parseInt(normalized.slice(offset, offset + 2), 16) * (1 - factor))));

  return `#${channel(0).toString(16).padStart(2, "0")}${channel(2).toString(16).padStart(2, "0")}${channel(4)
    .toString(16)
    .padStart(2, "0")}`;
}

function inferColor(node: SceneNode): string {
  switch (node.type) {
    case "spawn":
      return "#ffd36b";
    case "teleporter":
      return "#67d5ff";
    case "goody":
      return "#fff0aa";
    case "field":
      return "#5bc9a4";
    default:
      return "#7f95a7";
  }
}

function countMeshes(object: THREE.Object3D): number {
  let total = 0;
  object.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      total += 1;
    }
  });
  return total;
}

function syncPlayerMeshes(
  layer: THREE.Group,
  cache: Map<string, THREE.Object3D>,
  players: SnapshotPlayerState[],
  localPlayerId?: string
): void {
  const liveIds = new Set(players.map((player) => player.id));

  for (const player of players) {
    let object = cache.get(player.id);
    if (!object) {
      object = createPlayerMarker(player, player.id === localPlayerId);
      cache.set(player.id, object);
      layer.add(object);
    }

    object.visible = player.alive;
    queueObjectTransform(object, player.x, player.y, player.z, player.bodyYaw);
    updatePlayerMarker(object, player);
  }

  for (const [playerId, object] of cache.entries()) {
    if (!liveIds.has(playerId)) {
      layer.remove(object);
      cache.delete(playerId);
    }
  }
}

function syncScoutMeshes(
  layer: THREE.Group,
  cache: Map<string, THREE.Object3D>,
  scouts: SnapshotScoutState[],
  localPlayerId?: string
): void {
  const liveIds = new Set(scouts.map((scout) => scout.id));

  for (const scout of scouts) {
    let object = cache.get(scout.id);
    if (!object) {
      object = createScoutMarker(scout, scout.ownerPlayerId === localPlayerId);
      cache.set(scout.id, object);
      layer.add(object);
    }

    object.visible = scout.active;
    queueObjectTransform(object, scout.x, scout.y, scout.z, scout.heading);
  }

  for (const [scoutId, object] of cache.entries()) {
    if (!liveIds.has(scoutId)) {
      layer.remove(object);
      cache.delete(scoutId);
    }
  }
}

function createScoutMarker(scout: SnapshotScoutState, isLocalOwner: boolean): THREE.Object3D {
  const root = createDynamicAssetMarker({
    shapeAssetUrl: scout.shapeAssetUrl ?? LIVE_ASSET_URLS.scout,
    scale: scout.scale ?? 1,
    material: new THREE.MeshStandardMaterial({
      color: scout.color ?? (isLocalOwner ? "#84b7ff" : "#6f6f7d"),
      emissive: scout.accentColor ?? (isLocalOwner ? "#d1e4ff" : "#a8a7bf"),
      emissiveIntensity: 0.12,
      metalness: 0.1,
      roughness: 0.45
    }),
    fallback: () =>
      new THREE.Mesh(
        new THREE.SphereGeometry(0.8, 16, 16),
        new THREE.MeshStandardMaterial({
          color: isLocalOwner ? "#84b7ff" : "#8e8d98",
          emissive: isLocalOwner ? "#c7dbff" : "#b9b7cf",
          emissiveIntensity: 0.18,
          metalness: 0.1,
          roughness: 0.38
        })
      )
  });
  root.userData.baseYawOffset = BSP_FORWARD_YAW_OFFSET;
  root.rotation.order = "YXZ";
  return root;
}

function queueObjectTransform(object: THREE.Object3D, x: number, y: number, z: number, yaw: number): void {
  const targetYaw = yaw + (object.userData.baseYawOffset ?? 0);
  if (object.userData.initializedTransform !== true) {
    object.position.set(x, y, z);
    object.rotation.y = targetYaw;
    object.userData.initializedTransform = true;
  }

  object.userData.targetX = x;
  object.userData.targetY = y;
  object.userData.targetZ = z;
  object.userData.targetYaw = targetYaw;
}

function smoothDynamicObjects(
  cache: Map<string, THREE.Object3D>,
  frameDelta: number,
  responsiveness = 0.72
): void {
  const blend = 1 - Math.pow(1 - responsiveness, Math.min(3, frameDelta * 60));
  for (const object of cache.values()) {
    const targetX = object.userData.targetX;
    const targetY = object.userData.targetY;
    const targetZ = object.userData.targetZ;
    if (typeof targetX === "number" && typeof targetY === "number" && typeof targetZ === "number") {
      object.position.lerp(new THREE.Vector3(targetX, targetY, targetZ), blend);
    }

    if (typeof object.userData.targetYaw === "number") {
      object.rotation.y = normalizeAngle(
        object.rotation.y + normalizeAngle(object.userData.targetYaw - object.rotation.y) * blend
      );
    }
    if (typeof object.userData.targetPitch === "number") {
      object.rotation.x += (object.userData.targetPitch - object.rotation.x) * blend;
    }
    if (typeof object.userData.targetRoll === "number") {
      object.rotation.z += (object.userData.targetRoll - object.rotation.z) * blend;
    }
  }
}

function createPlayerMarker(player: SnapshotPlayerState, isLocal: boolean): THREE.Object3D {
  if (isWalkerAssemblyPlayer(player)) {
    return createWalkerAssemblyMarker(player, isLocal);
  }

  const root = createDynamicAssetMarker({
    shapeAssetUrl: player.shapeAssetUrl ?? LIVE_ASSET_URLS.hector,
    scale: player.scale ?? 1,
    grounded: true,
    material: new THREE.MeshStandardMaterial({
      color: player.color ?? (isLocal ? "#ffd879" : "#7dbbff"),
      metalness: 0.16,
      roughness: 0.62
    }),
    fallback: () => createFallbackPlayerMarker(isLocal)
  });
  root.userData.baseYawOffset = BSP_FORWARD_YAW_OFFSET;
  root.rotation.order = "YXZ";
  return root;
}

function isWalkerAssemblyPlayer(player: SnapshotPlayerState): boolean {
  return player.shapeKey === "bspAvaraA"
    || player.shapeId === 102
    || player.shapeId === 210
    || player.shapeId === 215
    || player.shapeId === 216
    || player.shapeId === 217
    || player.shapeAssetUrl === LIVE_ASSET_URLS.hector;
}

function updatePlayerMarker(object: THREE.Object3D, player: SnapshotPlayerState): void {
  if (object.userData.playerVisualKind === "walker") {
    updateWalkerAssemblyPose(object as THREE.Group, player);
    return;
  }

  const turret = object.getObjectByName("turret");
  if (turret) {
    turret.rotation.y = player.turretYaw - player.bodyYaw;
  }

  const barrel = object.getObjectByName("barrel");
  if (barrel) {
    barrel.rotation.x = -player.turretPitch;
  }
}

function createWalkerAssemblyMarker(player: SnapshotPlayerState, isLocal: boolean): THREE.Group {
  const root = new THREE.Group();
  root.userData.playerVisualKind = "walker";
  root.userData.walkerPhase = 0;
  root.userData.walkerPhaseAt = performance.now();
  root.userData.baseYawOffset = BSP_FORWARD_YAW_OFFSET;
  root.rotation.order = "YXZ";

  const palette = createWalkerPalette(player, isLocal);
  const rig = new THREE.Group();
  rig.name = "walker-rig";
  root.add(rig);

  const hullPivot = new THREE.Group();
  hullPivot.name = "walker-hull";
  rig.add(hullPivot);
  attachBspRenderable(hullPivot, player.shapeAssetUrl ?? LIVE_ASSET_URLS.hector, palette);

  const leftUpper = new THREE.Group();
  leftUpper.name = "walker-left-upper";
  rig.add(leftUpper);
  attachBspRenderable(leftUpper, LIVE_ASSET_URLS.hectorLegHigh, palette);

  const rightUpper = new THREE.Group();
  rightUpper.name = "walker-right-upper";
  rig.add(rightUpper);
  attachBspRenderable(rightUpper, LIVE_ASSET_URLS.hectorLegHigh, palette, {
    preRotateY: Math.PI
  });

    const leftLower = new THREE.Group();
    leftLower.name = "walker-left-lower";
    leftUpper.add(leftLower);
    attachBspRenderable(leftLower, LIVE_ASSET_URLS.hectorLegLow, palette);

  const rightLower = new THREE.Group();
  rightLower.name = "walker-right-lower";
    rightUpper.add(rightLower);
    attachBspRenderable(rightLower, LIVE_ASSET_URLS.hectorLegLow, palette, {
      preRotateY: Math.PI
    });

  const loadedMissile = new THREE.Group();
  loadedMissile.name = "walker-loaded-missile";
  loadedMissile.position.set(
    SMART_MISSILE_MOUNT_OFFSET.x,
    SMART_MISSILE_MOUNT_OFFSET.y,
    SMART_MISSILE_MOUNT_OFFSET.z
  );
  hullPivot.add(loadedMissile);
  attachBspRenderable(loadedMissile, LIVE_ASSET_URLS.missile, createProjectilePalette("missile"));

  const loadedGrenade = new THREE.Group();
  loadedGrenade.name = "walker-loaded-grenade";
  loadedGrenade.position.set(
    GRENADE_MOUNT_OFFSET.x,
    GRENADE_MOUNT_OFFSET.y,
    GRENADE_MOUNT_OFFSET.z
  );
  hullPivot.add(loadedGrenade);
  attachBspRenderable(loadedGrenade, LIVE_ASSET_URLS.grenade, createProjectilePalette("grenade"));

  updateWalkerAssemblyPose(root, player);
  return root;
}

function updateWalkerAssemblyPose(root: THREE.Group, player: SnapshotPlayerState): void {
  const now = performance.now();
  const previousSample = typeof root.userData.walkerPhaseAt === "number" ? root.userData.walkerPhaseAt : now;
  const elapsedSeconds = Math.min(0.05, Math.max(0.001, (now - previousSample) / 1000));
  root.userData.walkerPhaseAt = now;

  const leftMotor = player.leftMotor ?? 0;
  const rightMotor = player.rightMotor ?? 0;
  const gaitMagnitude = Math.min(1, (Math.abs(leftMotor) + Math.abs(rightMotor)) / 0.3);
  const direction = leftMotor + rightMotor >= 0 ? 1 : -1;
  const phaseAdvance = gaitMagnitude * 5.5 * elapsedSeconds * direction;
  const nextPhase = (Number(root.userData.walkerPhase) || 0) + phaseAdvance;
  root.userData.walkerPhase = nextPhase;

  const elevation = player.stance ?? HECTOR_DEFAULT_STANCE;
  const crouch = player.crouch ?? 0;
  const hipHeight = Math.max(0.95, elevation - crouch);
  const yawDelta = normalizeAngle(player.turretYaw - player.bodyYaw);
  const rideHeight = player.rideHeight ?? HECTOR_DEFAULT_RIDE_HEIGHT;

  const hull = root.getObjectByName("walker-hull");
  if (hull) {
    hull.position.set(0, hipHeight + rideHeight, 0);
    hull.rotation.order = "YXZ";
    hull.rotation.set(-player.turretPitch, yawDelta, -yawDelta / 6);
  }

  const loadedMissile = root.getObjectByName("walker-loaded-missile");
  if (loadedMissile) {
    loadedMissile.visible = player.weaponLoad === "missile";
  }

  const loadedGrenade = root.getObjectByName("walker-loaded-grenade");
  if (loadedGrenade) {
    loadedGrenade.visible = player.weaponLoad === "grenade";
  }

  const turnBias = Math.max(-0.35, Math.min(0.35, (rightMotor - leftMotor) / 0.18));
  const strideReach = 0.26 + gaitMagnitude * 0.34;
  const footLift = 0.08 + gaitMagnitude * 0.22;

  const leftPose = solveWalkerLegPose(hipHeight, strideReach * Math.sin(nextPhase) - turnBias * 0.1, footLift * Math.max(0, Math.sin(nextPhase)));
  const rightPose = solveWalkerLegPose(
    hipHeight,
    strideReach * Math.sin(nextPhase + Math.PI) + turnBias * 0.1,
    footLift * Math.max(0, Math.sin(nextPhase + Math.PI))
  );

  const leftUpper = root.getObjectByName("walker-left-upper");
  if (leftUpper) {
    leftUpper.position.set(HECTOR_LEG_SPACE, hipHeight, 0);
    leftUpper.rotation.set(leftPose.upperAngle, 0, 0);
  }

  const rightUpper = root.getObjectByName("walker-right-upper");
  if (rightUpper) {
    rightUpper.position.set(-HECTOR_LEG_SPACE, hipHeight, 0);
    rightUpper.rotation.set(rightPose.upperAngle, 0, 0);
  }

  const leftLower = root.getObjectByName("walker-left-lower");
  if (leftLower) {
    leftLower.position.set(0, -HECTOR_LEG_HIGH_LENGTH, 0);
    leftLower.rotation.set(-leftPose.lowerAngle, 0, 0);
  }

  const rightLower = root.getObjectByName("walker-right-lower");
  if (rightLower) {
    rightLower.position.set(0, -HECTOR_LEG_HIGH_LENGTH, 0);
    rightLower.rotation.set(-rightPose.lowerAngle, 0, 0);
  }

  const rig = root.getObjectByName("walker-rig") as THREE.Group | undefined;
  if (rig) {
    rig.position.y = 0;
    root.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(rig);
    const localMin = root.worldToLocal(bounds.min.clone()).y;
    rig.position.y = Number.isFinite(localMin) ? -localMin : 0;
  }
}

function createFirstPersonCockpitRig(): THREE.Group {
  const root = new THREE.Group();
  root.name = "first-person-cockpit";
  root.visible = false;
  root.rotation.y = BSP_FORWARD_YAW_OFFSET;

  const hull = new THREE.Group();
  hull.name = "first-person-hull";
  hull.position.set(FIRST_PERSON_HULL_OFFSET.x, FIRST_PERSON_HULL_OFFSET.y, FIRST_PERSON_HULL_OFFSET.z);
  root.add(hull);

  const hullPalette: MarkerPalette = {
    marker0: "#7a5c25",
    marker1: "#5b4521",
    marker2: "#a7d8ff",
    marker3: "#161616",
    fallback: "#7a5c25"
  };
  attachBspRenderable(hull, LIVE_ASSET_URLS.hector, hullPalette);

  const loadedMissile = new THREE.Group();
  loadedMissile.name = "first-person-loaded-missile";
  loadedMissile.position.set(
    SMART_MISSILE_MOUNT_OFFSET.x,
    SMART_MISSILE_MOUNT_OFFSET.y,
    SMART_MISSILE_MOUNT_OFFSET.z
  );
  hull.add(loadedMissile);
  attachBspRenderable(loadedMissile, LIVE_ASSET_URLS.missile, createProjectilePalette("missile"));

  const loadedGrenade = new THREE.Group();
  loadedGrenade.name = "first-person-loaded-grenade";
  loadedGrenade.position.set(
    GRENADE_MOUNT_OFFSET.x,
    GRENADE_MOUNT_OFFSET.y,
    GRENADE_MOUNT_OFFSET.z
  );
  hull.add(loadedGrenade);
  attachBspRenderable(loadedGrenade, LIVE_ASSET_URLS.grenade, createProjectilePalette("grenade"));

  return root;
}

function updateFirstPersonCockpitRig(
  root: THREE.Group,
  player: SnapshotPlayerState | null,
  scoutViewActive: boolean
): void {
  const active = Boolean(player?.alive && !scoutViewActive);
  root.visible = active;
  if (!active || !player) {
    return;
  }

  const hull = root.getObjectByName("first-person-hull");
  if (hull) {
    hull.position.set(FIRST_PERSON_HULL_OFFSET.x, FIRST_PERSON_HULL_OFFSET.y, FIRST_PERSON_HULL_OFFSET.z);
  }

  const loadedMissile = root.getObjectByName("first-person-loaded-missile");
  if (loadedMissile) {
    loadedMissile.visible = player.weaponLoad === "missile";
  }

  const loadedGrenade = root.getObjectByName("first-person-loaded-grenade");
  if (loadedGrenade) {
    loadedGrenade.visible = player.weaponLoad === "grenade";
  }
}

function getPlayerViewTargetHeight(player: SnapshotPlayerState): number {
  return Math.max(1.85, (player.stance ?? HECTOR_DEFAULT_STANCE) + HECTOR_VIEWPORT_HEIGHT);
}

function solveWalkerLegPose(hipHeight: number, forwardOffset: number, lift: number): { upperAngle: number; lowerAngle: number } {
  const clampedTargetY = -(Math.max(0.25, hipHeight - lift));
  const distance = Math.min(
    HECTOR_LEG_HIGH_LENGTH + HECTOR_LEG_LOW_LENGTH - 0.001,
    Math.max(0.1, Math.hypot(forwardOffset, clampedTargetY))
  );
  const kneeInterior = Math.acos(
    THREE.MathUtils.clamp(
      (HECTOR_LEG_HIGH_LENGTH ** 2 + HECTOR_LEG_LOW_LENGTH ** 2 - distance ** 2)
      / (2 * HECTOR_LEG_HIGH_LENGTH * HECTOR_LEG_LOW_LENGTH),
      -1,
      1
    )
  );
  const upperReach = Math.acos(
    THREE.MathUtils.clamp(
      (HECTOR_LEG_HIGH_LENGTH ** 2 + distance ** 2 - HECTOR_LEG_LOW_LENGTH ** 2)
      / (2 * HECTOR_LEG_HIGH_LENGTH * distance),
      -1,
      1
    )
  );
  const upperAngle = Math.atan2(forwardOffset, -clampedTargetY) - upperReach;
  const lowerAngle = Math.PI - kneeInterior;
  return { upperAngle, lowerAngle };
}

function createWalkerPalette(player: SnapshotPlayerState, isLocal: boolean): MarkerPalette {
  const hullColor = player.color ?? (isLocal ? "#7a5c25" : "#6f88b6");
  return {
    marker0: hullColor,
    marker1: player.accentColor ?? darkenHex(hullColor, 0.08),
    marker2: isLocal ? "#a7d8ff" : "#d2e4ff",
    marker3: "#161616",
    fallback: hullColor
  };
}

function createProjectilePalette(kind: SnapshotProjectileState["kind"]): MarkerPalette {
  if (kind === "plasma") {
    return {
      marker0: "#ff4a3a",
      marker1: "#ff9b72",
      marker2: "#ffceb6",
      marker3: "#6a1208",
      fallback: "#ff4a3a"
    };
  }

  if (kind === "missile") {
    return {
      marker0: "#2b3acc",
      marker1: "#dccf92",
      marker2: "#8f9cff",
      marker3: "#121525",
      fallback: "#2b3acc"
    };
  }

  return {
    marker0: "#d8d542",
    marker1: "#fff5aa",
    marker2: "#ffd973",
    marker3: "#302a11",
    fallback: "#d8d542"
  };
}

function resolveRenderableColor(
  baseToken: string | undefined,
  baseColor: string | undefined,
  palette: MarkerPalette
): string {
  if (baseColor) {
    return baseColor;
  }

  switch (baseToken) {
    case "marker0":
      return palette.marker0;
    case "marker1":
      return palette.marker1;
    case "marker2":
      return palette.marker2;
    case "marker3":
      return palette.marker3;
    default:
      return palette.fallback;
  }
}

function attachBspRenderable(
  root: THREE.Group,
  url: string,
  palette: MarkerPalette,
  options?: { preRotateY?: number }
): void {
  void loadBspRenderable(url)
    .then((renderable) => {
      const group = new THREE.Group();
      if (options?.preRotateY) {
        group.rotation.y = options.preRotateY;
      }

      for (const part of renderable.groups) {
        const color = resolveRenderableColor(part.baseToken, part.baseColor, palette);
        const mesh = new THREE.Mesh(
          part.geometry,
          new THREE.MeshStandardMaterial({
            color,
            metalness: 0.14,
            roughness: 0.66
          })
        );
        group.add(mesh);
      }

      root.add(group);
    })
    .catch(() => undefined);
}

function attachBspMesh(
  root: THREE.Group,
  url: string,
  material: THREE.MeshStandardMaterial,
  options?: { preRotateY?: number }
): void {
  void loadBspGeometry(url)
    .then((geometry) => {
      const mesh = new THREE.Mesh(geometry, material);
      if (options?.preRotateY) {
        mesh.rotation.y = options.preRotateY;
      }
      root.add(mesh);
    })
    .catch(() => undefined);
}

function createFallbackPlayerMarker(isLocal: boolean): THREE.Object3D {
  const root = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(1.15, 1.45, 2.4, 10),
    new THREE.MeshStandardMaterial({ color: isLocal ? "#ffd879" : "#7dbbff", metalness: 0.2, roughness: 0.65 })
  );
  body.position.y = 1.2;
  root.add(body);

  const turret = new THREE.Group();
  turret.name = "turret";
  turret.position.y = 2.1;

  const turretBody = new THREE.Mesh(
    new THREE.BoxGeometry(1.2, 0.45, 1.6),
    new THREE.MeshStandardMaterial({ color: isLocal ? "#fff1be" : "#b6d5ff", metalness: 0.12, roughness: 0.5 })
  );
  const barrel = new THREE.Mesh(
    new THREE.BoxGeometry(0.18, 0.18, 1.7),
    new THREE.MeshStandardMaterial({ color: "#202734", metalness: 0.05, roughness: 0.8 })
  );
  barrel.name = "barrel";
  barrel.position.z = 1.05;
  turret.add(turretBody, barrel);
  root.add(turret);

  return root;
}

function syncProjectileMeshes(
  layer: THREE.Group,
  cache: Map<string, THREE.Object3D>,
  projectiles: SnapshotProjectileState[]
): void {
  const liveIds = new Set(projectiles.map((projectile) => projectile.id));

  for (const projectile of projectiles) {
    let object = cache.get(projectile.id);
    if (!object) {
      object = createProjectileMarker(projectile);
      cache.set(projectile.id, object);
      layer.add(object);
    }

    queueObjectTransform(object, projectile.x, projectile.y, projectile.z, projectile.yaw ?? 0);
    object.userData.targetPitch = -(projectile.pitch ?? 0);
    object.userData.targetRoll = projectile.roll ?? 0;
  }

  for (const [projectileId, object] of cache.entries()) {
    if (!liveIds.has(projectileId)) {
      layer.remove(object);
      cache.delete(projectileId);
    }
  }
}

function createProjectileMarker(projectile: SnapshotProjectileState): THREE.Object3D {
  const shapeAssetUrl = projectile.shapeAssetUrl
    ?? (projectile.kind === "plasma"
      ? LIVE_ASSET_URLS.plasma
      : projectile.kind === "missile"
        ? LIVE_ASSET_URLS.missile
        : LIVE_ASSET_URLS.grenade);
  return createExactProjectileMarker(shapeAssetUrl, projectile);
}

function createExactProjectileMarker(shapeAssetUrl: string, projectile: SnapshotProjectileState): THREE.Object3D {
  const fallback = createFallbackProjectileMarker(projectile.kind);
  const root = new THREE.Group();
  root.userData.baseYawOffset = BSP_FORWARD_YAW_OFFSET;
  root.rotation.order = "YXZ";
  root.add(fallback);

  const resolved = resolvedRenderableCache.get(shapeAssetUrl);
  if (resolved) {
    root.clear();
    root.add(buildRenderableGroup(resolved, projectile.kind, projectile.scale ?? 1));
    return root;
  }

  void loadBspRenderable(shapeAssetUrl)
    .then((renderable) => {
      root.clear();
      root.add(buildRenderableGroup(renderable, projectile.kind, projectile.scale ?? 1));
    })
    .catch(() => {
      root.clear();
      root.add(fallback);
    });

  return root;
}

function buildRenderableGroup(
  renderable: BspRenderableData,
  kind: SnapshotProjectileState["kind"],
  scale: number
): THREE.Group {
  const group = new THREE.Group();
  const palette = createProjectilePalette(kind);

  for (const part of renderable.groups) {
    const color = resolveRenderableColor(part.baseToken, part.baseColor, palette);
    const material = new THREE.MeshStandardMaterial({
      color,
      emissive: kind === "plasma" ? color : darkenHex(color, 0.2),
      emissiveIntensity: kind === "plasma" ? 0.55 : kind === "missile" ? 0.18 : 0.12,
      metalness: 0.06,
      roughness: kind === "plasma" ? 0.2 : 0.42
    });
    const mesh = new THREE.Mesh(part.geometry, material);
    mesh.scale.setScalar(scale);
    group.add(mesh);
  }

  return group;
}

function createFallbackProjectileMarker(kind: SnapshotProjectileState["kind"]): THREE.Object3D {
  if (kind === "plasma") {
    const root = new THREE.Group();
    const bodyMaterial = new THREE.MeshStandardMaterial({
      color: "#ff513d",
      emissive: "#ff2a1a",
      emissiveIntensity: 0.7,
      metalness: 0.02,
      roughness: 0.25
    });
    const finMaterial = new THREE.MeshStandardMaterial({
      color: "#ffb07a",
      emissive: "#ff4f25",
      emissiveIntensity: 0.45,
      metalness: 0.02,
      roughness: 0.28
    });

    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.72, 8), bodyMaterial);
    shaft.rotation.x = Math.PI / 2;
    root.add(shaft);

    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.36, 8), bodyMaterial);
    nose.rotation.x = -Math.PI / 2;
    nose.position.z = 0.5;
    root.add(nose);

    const leftFin = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.05, 0.2), finMaterial);
    leftFin.position.set(0, 0.08, -0.14);
    const rightFin = leftFin.clone();
    rightFin.position.y = -0.08;
    root.add(leftFin, rightFin);
    return root;
  }

  return new THREE.Mesh(
    new THREE.SphereGeometry(kind === "missile" ? 0.4 : 0.55, 12, 12),
    new THREE.MeshStandardMaterial({
      color: kind === "missile" ? "#ff9b67" : "#79ffad",
      emissive: kind === "missile" ? "#ff6a36" : "#3acc72",
      emissiveIntensity: 0.4
    })
  );
}

function syncPickupMeshes(
  layer: THREE.Group,
  cache: Map<string, THREE.Object3D>,
  pickups: SnapshotPickupState[]
): void {
  const liveIds = new Set(pickups.map((pickup) => pickup.id));

  for (const pickup of pickups) {
    let object = cache.get(pickup.id);
    if (!object) {
      object = createPickupMarker(pickup);
      cache.set(pickup.id, object);
      layer.add(object);
    }

    object.position.set(pickup.x, pickup.y, pickup.z);
    object.visible = pickup.available;
  }

  for (const [pickupId, object] of cache.entries()) {
    if (!liveIds.has(pickupId)) {
      layer.remove(object);
      cache.delete(pickupId);
    }
  }
}

function createPickupMarker(pickup: SnapshotPickupState): THREE.Object3D {
  const color = pickup.color ?? (pickup.kind === "missiles" ? "#ff8e74" : pickup.kind === "grenades" ? "#7effd0" : "#ffe66d");
  return createDynamicAssetMarker({
    shapeAssetUrl: pickup.shapeAssetUrl,
    scale: pickup.scale ?? 1,
    material: new THREE.MeshStandardMaterial({
      color,
      emissive: pickup.accentColor ?? color,
      emissiveIntensity: 0.18,
      metalness: 0.08,
      roughness: 0.35
    }),
    fallback: () => createFallbackPickupMarker(pickup.kind)
  });
}

function createFallbackPickupMarker(kind: SnapshotPickupState["kind"]): THREE.Object3D {
  const color = kind === "missiles" ? "#ff8e74" : kind === "grenades" ? "#7effd0" : "#ffe66d";
  return new THREE.Mesh(
    new THREE.OctahedronGeometry(0.9, 0),
    new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.3,
      metalness: 0.08,
      roughness: 0.35
    })
  );
}

function createDynamicAssetMarker(input: {
  shapeAssetUrl?: string;
  scale?: number;
  grounded?: boolean;
  material: THREE.MeshStandardMaterial;
  fallback: () => THREE.Object3D;
}): THREE.Object3D {
  const root = new THREE.Group();
  const fallback = input.fallback();
  root.add(fallback);

  if (!input.shapeAssetUrl) {
    return root;
  }

  void loadBspGeometry(input.shapeAssetUrl)
    .then((geometry) => {
      root.clear();
      const mesh = new THREE.Mesh(geometry, input.material);
      const scale = input.scale ?? 1;
      mesh.scale.setScalar(scale);
      if (input.grounded && geometry.boundingBox) {
        mesh.position.y = -geometry.boundingBox.min.y * scale;
      }
      root.add(mesh);
    })
    .catch(() => {
      root.clear();
      root.add(fallback);
    });

  return root;
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

function createBillboardPlaceholder(node: SceneNode, material: THREE.MeshStandardMaterial): THREE.Object3D {
  const size = node.size ?? { width: 14, height: 7, depth: 0.4 };
  const root = new THREE.Group();

  const frameMaterial = material.clone();
  frameMaterial.color = new THREE.Color(node.color ?? "#183446");
  frameMaterial.metalness = 0.14;
  frameMaterial.roughness = 0.72;

  const board = new THREE.Mesh(new THREE.BoxGeometry(size.width, size.height, size.depth), frameMaterial);
  root.add(board);

  const braceMaterial = new THREE.MeshStandardMaterial({ color: node.accentColor ?? "#7de2ff", roughness: 0.8 });
  const postLeft = new THREE.Mesh(new THREE.BoxGeometry(0.28, size.height + 1.8, 0.28), braceMaterial);
  const postRight = new THREE.Mesh(new THREE.BoxGeometry(0.28, size.height + 1.8, 0.28), braceMaterial);
  postLeft.position.set(-(size.width / 2) + 0.35, -0.9, 0);
  postRight.position.set((size.width / 2) - 0.35, -0.9, 0);
  root.add(postLeft, postRight);

  return root;
}

function syncBillboardMeshes(
  layer: THREE.Group,
  cache: Map<string, THREE.Group>,
  nodes: SceneNode[],
  assignments: LevelBillboardAssignment[]
): void {
  const assignmentByNodeId = new Map(assignments.map((assignment) => [assignment.nodeId, assignment]));
  const liveIds = new Set(nodes.map((node) => node.id));

  for (const node of nodes) {
    let object = cache.get(node.id);
    if (!object) {
      object = createBillboardSurface(node);
      cache.set(node.id, object);
      layer.add(object);
    }

    const assignment = assignmentByNodeId.get(node.id) ?? {
      nodeId: node.id,
      slotId: node.slotId ?? node.id,
      campaignId: null,
      campaignName: null,
      creativeUrl: null,
      destinationUrl: null,
      rotationSeconds: 30
    };
    object.position.copy(computeBillboardPosition(node));
    object.rotation.set(
      THREE.MathUtils.degToRad(node.rotation?.pitch ?? 0),
      THREE.MathUtils.degToRad(node.rotation?.yaw ?? 0),
      THREE.MathUtils.degToRad(node.rotation?.roll ?? 0)
    );

    const assignmentKey = [
      assignment.campaignId ?? "open",
      assignment.creativeUrl ?? assignment.slotId,
      assignment.campaignName ?? "",
      assignment.rotationSeconds
    ].join(":");
    if (object.userData.assignmentKey !== assignmentKey) {
      object.userData.assignmentKey = assignmentKey;
      void updateBillboardSurface(object, node, assignment);
    }
  }

  for (const [nodeId, object] of cache.entries()) {
    if (!liveIds.has(nodeId)) {
      layer.remove(object);
      cache.delete(nodeId);
    }
  }
}

function createBillboardSurface(node: SceneNode): THREE.Group {
  const size = node.size ?? { width: 14, height: 7, depth: 0.4 };
  const root = new THREE.Group();
  const surface = new THREE.Mesh(
    new THREE.PlaneGeometry(size.width * 0.9, size.height * 0.82),
    new THREE.MeshStandardMaterial({
      color: "#1a2430",
      emissive: "#101821",
      emissiveIntensity: 0.15,
      side: THREE.DoubleSide,
      roughness: 0.9,
      metalness: 0.05
    })
  );
  surface.name = "surface";
  root.add(surface);
  return root;
}

async function updateBillboardSurface(
  root: THREE.Group,
  node: SceneNode,
  assignment: LevelBillboardAssignment
): Promise<void> {
  const surface = root.getObjectByName("surface");
  if (!(surface instanceof THREE.Mesh) || !(surface.material instanceof THREE.MeshStandardMaterial)) {
    return;
  }

  const texture = await loadBillboardTexture(assignment);
  surface.material.map = texture;
  surface.material.needsUpdate = true;

  const size = node.size ?? { width: 14, height: 7, depth: 0.4 };
  surface.position.set(0, 0, size.depth / 2 + 0.03);
}

async function loadBillboardTexture(assignment: LevelBillboardAssignment): Promise<THREE.Texture> {
  const cacheKey = assignment.creativeUrl ?? `fallback:${assignment.slotId}:${assignment.campaignName ?? "open"}`;
  const cached = billboardTextureCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const nextTexture = (async () => {
    if (assignment.creativeUrl) {
      try {
        const loader = new THREE.TextureLoader();
        loader.setCrossOrigin("anonymous");
        const texture = await loader.loadAsync(assignment.creativeUrl);
        texture.colorSpace = THREE.SRGBColorSpace;
        return texture;
      } catch {
        return createBillboardFallbackTexture(assignment);
      }
    }

    return createBillboardFallbackTexture(assignment);
  })();

  billboardTextureCache.set(cacheKey, nextTexture);
  return nextTexture;
}

function createBillboardFallbackTexture(assignment: LevelBillboardAssignment): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 512;
  const context = canvas.getContext("2d");
  if (!context) {
    const texture = new THREE.Texture();
    texture.needsUpdate = true;
    return texture;
  }

  const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
  gradient.addColorStop(0, "#143f58");
  gradient.addColorStop(1, "#0a1118");
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = "#7de2ff";
  context.lineWidth = 12;
  context.strokeRect(36, 36, canvas.width - 72, canvas.height - 72);

  context.fillStyle = "#f5f7fb";
  context.font = '700 104px "Avenir Next", "Futura", sans-serif';
  context.fillText(assignment.campaignName ?? "AVAILABLE", 84, 220);

  context.fillStyle = "#7de2ff";
  context.font = '500 34px "Avenir Next", "Futura", sans-serif';
  context.fillText(`Slot ${assignment.slotId}`, 88, 292);
  context.fillText(`Rotate every ${assignment.rotationSeconds}s`, 88, 340);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}

function computeBillboardPosition(node: SceneNode): THREE.Vector3 {
  const size = node.size ?? { width: 14, height: 7, depth: 0.4 };
  const yaw = THREE.MathUtils.degToRad(node.rotation?.yaw ?? 0);
  const normalX = Math.sin(yaw);
  const normalZ = Math.cos(yaw);

  return new THREE.Vector3(
    node.position.x + normalX * (size.depth / 2 + 0.04),
    node.position.y,
    node.position.z + normalZ * (size.depth / 2 + 0.04)
  );
}
