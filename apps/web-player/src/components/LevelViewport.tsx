import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

import type {
  SnapshotPacket,
  SnapshotPickupState,
  SnapshotPlayerState,
  SnapshotProjectileState
} from "@avara/shared-protocol";
import type { GraphicsQuality, LevelBillboardAssignment, LevelScene, PlayerSettings, SceneNode } from "@avara/shared-types";
import { CONTROL_PRESET_BINDINGS } from "@avara/shared-ui";

interface LevelViewportProps {
  scene: LevelScene | null;
  billboards: LevelBillboardAssignment[];
  snapshot: SnapshotPacket | null;
  localPlayerId?: string;
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
  polys: Array<{ normal: number; tris: number[] }>;
}

const shapeCache = new Map<string, THREE.BufferGeometry>();
const billboardTextureCache = new Map<string, Promise<THREE.Texture>>();

export default function LevelViewport({
  scene,
  billboards,
  snapshot,
  localPlayerId,
  playerSettings,
  prototypeStatus,
  onAimChange,
  onPointerLockChange,
  onTelemetryChange
}: LevelViewportProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
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
    setRenderStats((current) => ({
      ...current,
      pixelRatio,
      compatibilityError: null
    }));

    const threeScene = new THREE.Scene();
    threeScene.background = new THREE.Color(scene.environment.skyColors[0] ?? "#9bd7ff");
    threeScene.fog = new THREE.Fog(scene.environment.skyColors[1] ?? "#dbe8ff", 140, profile.fogFar);

    const camera = new THREE.PerspectiveCamera(72, mount.clientWidth / mount.clientHeight, 0.1, 1000);

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
    const playerLayer = new THREE.Group();
    threeScene.add(billboardLayer, pickupLayer, projectileLayer, playerLayer);

    const billboardNodes = scene.nodes.filter((node) => node.type === "ad_placeholder" && node.slotId);
    const billboardMeshes = new Map<string, THREE.Group>();
    const pickupMeshes = new Map<string, THREE.Object3D>();
    const projectileMeshes = new Map<string, THREE.Object3D>();
    const playerMeshes = new Map<string, THREE.Object3D>();

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
      syncBillboardMeshes(billboardLayer, billboardMeshes, billboardNodes, billboardRef.current);
      syncPickupMeshes(pickupLayer, pickupMeshes, currentSnapshot?.pickups ?? []);
      syncProjectileMeshes(projectileLayer, projectileMeshes, currentSnapshot?.projectiles ?? []);
      syncPlayerMeshes(playerLayer, playerMeshes, currentSnapshot?.players ?? [], localPlayerIdRef.current);

      const liveLocalPlayer = currentSnapshot?.players.find((player) => player.id === localPlayerIdRef.current) ?? null;
      if (liveLocalPlayer && aimCallbackRef.current) {
        aimCallbackRef.current({
          aimYaw: THREE.MathUtils.clamp(normalizeAngle(heading.current.yaw - liveLocalPlayer.bodyYaw), -1.2, 1.2),
          aimPitch: THREE.MathUtils.clamp(heading.current.pitch, -0.8, 0.5)
        });
      }

      const focus = liveLocalPlayer
        ? { x: liveLocalPlayer.x, y: liveLocalPlayer.y, z: liveLocalPlayer.z }
        : spawnAnchor;

      const chaseDistance = liveLocalPlayer?.alive ? 18 : 22;
      const cameraHeight = liveLocalPlayer?.alive ? 8.5 : 11;
      camera.position.set(
        focus.x - Math.cos(heading.current.yaw) * chaseDistance,
        focus.y + cameraHeight - heading.current.pitch * 8,
        focus.z - Math.sin(heading.current.yaw) * chaseDistance
      );
      camera.lookAt(
        focus.x + Math.cos(heading.current.yaw) * 10,
        focus.y + 3.4 + heading.current.pitch * 5,
        focus.z + Math.sin(heading.current.yaw) * 10
      );

      renderer.render(threeScene, camera);

      framesSinceSample += 1;
      const now = performance.now();
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

  return (
    <div className="viewport-shell">
      <div className="viewport-canvas" ref={mountRef} />

      {!pointerLocked ? (
        <div className="pointer-lock-overlay">
          <div className="pointer-lock-card">
            <span className="eyebrow">{playerSettings.controlPreset === "classic" ? "Classic Controls" : "Modernized Controls"}</span>
            <h3>Click the arena to lock your pointer</h3>
            <p>
              {playerSettings.controlPreset === "classic"
                ? "Drive with W/S, rotate the chassis with A/D, aim with the mouse, fire with left click, and keep crouch or jump on Space."
                : "Drive with W/S or arrows, rotate the chassis with A/D or arrows, fire with click or Space, and use F/G aliases for weapon loads."}
            </p>
          </div>
        </div>
      ) : null}

      {pointerLocked ? <div className="reticle" aria-hidden="true" /> : null}

      <div className="viewport-hud viewport-hud-top">
        <div className="hud-pill">Imported scene: {scene.title}</div>
        <div className="hud-pill">Actors: {renderStats.nodes}</div>
        <div className="hud-pill">
          Billboards: {billboards.filter((billboard) => billboard.campaignId).length}/{billboards.length}
        </div>
        <div className="hud-pill">Players: {snapshot?.players.length ?? 0}</div>
        <div className="hud-pill">Match: {snapshot?.roomStatus ?? prototypeStatus}</div>
        <div className="hud-pill">Render: {playerSettings.graphicsQuality}</div>
        {snapshot ? <div className="hud-pill">{snapshot.remainingSeconds}s left</div> : null}
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

  const response = await fetch(url);
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
  shapeCache.set(url, geometry);
  return geometry;
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
      object = createPlayerMarker(player.id === localPlayerId);
      cache.set(player.id, object);
      layer.add(object);
    }

    object.visible = player.alive;
    object.position.set(player.x, player.y, player.z);
    object.rotation.y = player.bodyYaw;

    const turret = object.getObjectByName("turret");
    if (turret) {
      turret.rotation.y = player.turretYaw - player.bodyYaw;
    }

    const barrel = object.getObjectByName("barrel");
    if (barrel) {
      barrel.rotation.x = -player.turretPitch;
    }
  }

  for (const [playerId, object] of cache.entries()) {
    if (!liveIds.has(playerId)) {
      layer.remove(object);
      cache.delete(playerId);
    }
  }
}

function createPlayerMarker(isLocal: boolean): THREE.Object3D {
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
      object = createProjectileMarker(projectile.kind);
      cache.set(projectile.id, object);
      layer.add(object);
    }

    object.position.set(projectile.x, projectile.y, projectile.z);
  }

  for (const [projectileId, object] of cache.entries()) {
    if (!liveIds.has(projectileId)) {
      layer.remove(object);
      cache.delete(projectileId);
    }
  }
}

function createProjectileMarker(kind: SnapshotProjectileState["kind"]): THREE.Object3D {
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
      object = createPickupMarker(pickup.kind);
      cache.set(pickup.id, object);
      layer.add(object);
    }

    object.position.set(pickup.x, pickup.y + 0.8, pickup.z);
    object.visible = pickup.available;
  }

  for (const [pickupId, object] of cache.entries()) {
    if (!liveIds.has(pickupId)) {
      layer.remove(object);
      cache.delete(pickupId);
    }
  }
}

function createPickupMarker(kind: SnapshotPickupState["kind"]): THREE.Object3D {
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
