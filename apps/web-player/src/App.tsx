import { lazy, Suspense, startTransition, useEffect, useMemo, useRef, useState } from "react";

import type { ScoutCommand, SnapshotPacket } from "@avara/shared-protocol";
import type {
  AdCampaign,
  AdPlacementType,
  GraphicsQuality,
  Identity,
  LevelBillboardAssignment,
  LevelScene,
  LevelSummary,
  PlayerSettings,
  RoomSummary,
  Visibility
} from "@avara/shared-types";
import { CONTROL_PRESET_BINDINGS, CONTROL_PRESETS, GRAPHICS_QUALITY_OPTIONS } from "@avara/shared-ui";

import {
  bootstrapPrototypeRoom,
  createRoom,
  endRoom,
  ensureAdSessionId,
  ensurePlayerProfile,
  fetchLevelAds,
  fetchLevelBillboards,
  fetchLevelScene,
  fetchLevels,
  fetchPrototypeSnapshot,
  fetchRoom,
  fetchRoomByInvite,
  fetchRooms,
  heartbeatRoom,
  joinPrototypeRoom,
  joinRoom,
  joinRoomByInvite,
  leavePrototypeRoom,
  leaveRoom,
  sendPrototypeInput,
  trackAdEvent,
  updatePlayerSettings
} from "./lib/api";
import { useAvaraSoundscape } from "./lib/sound";

const LevelViewport = lazy(() => import("./components/LevelViewport"));
const reconnectStorageKey = "avara-room-reconnect";
const onboardingStorageKey = "avara-beta-onboarding-dismissed";
const defaultPlayerSettings: PlayerSettings = {
  controlPreset: "modernized",
  sensitivity: 0.75,
  invertY: false,
  graphicsQuality: "balanced",
  showPerformanceHud: false,
  hullType: "light"
};

const HULL_OPTIONS: Array<{
  id: PlayerSettings["hullType"];
  label: string;
  description: string;
}> = [
  {
    id: "light",
    label: "Light hull",
    description: "Fastest chassis with the light BSP shell, lower reserves, and the leanest weapon loadout."
  },
  {
    id: "medium",
    label: "Medium hull",
    description: "Balanced armor and reserves with the medium shell, more missiles and grenades, and a slightly taller ride."
  },
  {
    id: "heavy",
    label: "Heavy hull",
    description: "Heaviest shell with the biggest stores and tougher shot profile, trading acceleration for payload and shielding."
  }
];

interface StoredReconnectState {
  roomId: string;
  inviteCode: string;
  savedAt: number;
}

interface LevelAdsState {
  lobby: AdCampaign[];
  loading: AdCampaign[];
  results: AdCampaign[];
}

interface CompatibilityNotice {
  title: string;
  detail: string;
}

interface ViewportTelemetry {
  fps: number | null;
  pixelRatio: number;
  quality: GraphicsQuality;
  compatibilityError: string | null;
}

interface BindingMap {
  moveForwardPositive: string[];
  moveForwardNegative: string[];
  turnLeft: string[];
  turnRight: string[];
  verticalMotionKeys: string[];
  primaryFireKeys: string[];
  boostKeys: string[];
  crouchJumpKeys: string[];
  missileKeys: string[];
  grenadeKeys: string[];
  scoutViewKeys: string[];
}

export function App() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [playerSettings, setPlayerSettings] = useState<PlayerSettings>(defaultPlayerSettings);
  const [settingsDraft, setSettingsDraft] = useState<PlayerSettings>(defaultPlayerSettings);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsNotice, setSettingsNotice] = useState("");
  const [levels, setLevels] = useState<LevelSummary[]>([]);
  const [levelAds, setLevelAds] = useState<LevelAdsState>({ lobby: [], loading: [], results: [] });
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [selectedRoomId, setSelectedRoomId] = useState("");
  const [connectedRoomId, setConnectedRoomId] = useState("");
  const [activeLevelId, setActiveLevelId] = useState("");
  const [scene, setScene] = useState<LevelScene | null>(null);
  const [billboards, setBillboards] = useState<LevelBillboardAssignment[]>([]);
  const [snapshot, setSnapshot] = useState<SnapshotPacket | null>(null);
  const [localPlayerId, setLocalPlayerId] = useState("");
  const [prototypeStatus, setPrototypeStatus] = useState<"idle" | "bootstrapping" | "live">("idle");
  const [roomName, setRoomName] = useState("Browser Arena");
  const [roomVisibility, setRoomVisibility] = useState<Visibility>("public");
  const [inviteCodeInput, setInviteCodeInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const [error, setError] = useState("");
  const [documentHidden, setDocumentHidden] = useState<boolean>(typeof document !== "undefined" ? document.hidden : false);
  const [pointerLocked, setPointerLocked] = useState(false);
  const [onboardingDismissed, setOnboardingDismissed] = useState(readOnboardingDismissed);
  const [viewportTelemetry, setViewportTelemetry] = useState<ViewportTelemetry>(() => ({
    fps: null,
    pixelRatio: typeof window === "undefined" ? 1 : Math.min(window.devicePixelRatio || 1, 1.5),
    quality: defaultPlayerSettings.graphicsQuality,
    compatibilityError: null
  }));

  const keyStateRef = useRef<Record<string, boolean>>({});
  const lookStateRef = useRef({ aimYaw: 0, aimPitch: 0 });
  const stanceDeltaRef = useRef(0);
  const queuedActionRef = useRef<{
    loadMissile: boolean;
    loadGrenade: boolean;
    toggleScoutView: boolean;
    scoutCommand: ScoutCommand | null;
  }>({
    loadMissile: false,
    loadGrenade: false,
    toggleScoutView: false,
    scoutCommand: null
  });
  const fireActiveRef = useRef(false);
  const reportedAdsRef = useRef(new Set<string>());
  const visibilityRef = useRef(documentHidden);
  const settingsNoticeTimerRef = useRef<number | null>(null);
  const playerSettingsRef = useRef(playerSettings);

  useEffect(() => {
    visibilityRef.current = documentHidden;
  }, [documentHidden]);

  useEffect(() => {
    playerSettingsRef.current = playerSettings;
  }, [playerSettings]);

  const selectedRoom = useMemo(
    () => (selectedRoomId ? rooms.find((room) => room.id === selectedRoomId) ?? null : null),
    [rooms, selectedRoomId]
  );
  const connectedRoom = useMemo(
    () => (connectedRoomId ? rooms.find((room) => room.id === connectedRoomId) ?? null : null),
    [rooms, connectedRoomId]
  );
  const featuredLevel = useMemo(
    () => levels.find((level) => level.id === (selectedRoom?.levelId ?? activeLevelId)) ?? levels[0] ?? null,
    [activeLevelId, levels, selectedRoom]
  );
  const localPlayer = useMemo(
    () => snapshot?.players.find((player) => player.id === localPlayerId) ?? null,
    [localPlayerId, snapshot]
  );
  const activeLobbyCampaign = levelAds.lobby[0] ?? null;
  const activeLoadingCampaign = levelAds.loading[0] ?? null;
  const activeResultsCampaign = levelAds.results[0] ?? null;
  const shareInviteUrl = selectedRoom ? buildInviteUrl(selectedRoom.invitePath, selectedRoom.inviteCode) : "";
  const settingsDirty = useMemo(() => !playerSettingsEqual(playerSettings, settingsDraft), [playerSettings, settingsDraft]);
  const selectedBindings = useMemo(() => CONTROL_PRESET_BINDINGS[settingsDraft.controlPreset], [settingsDraft.controlPreset]);
  const compatibilityNotes = useMemo(
    () => buildCompatibilityNotes(settingsDraft, viewportTelemetry),
    [settingsDraft, viewportTelemetry]
  );
  const onboardingChecklist = useMemo(
    () => [
      {
        id: "preset",
        label: `${settingsDraft.controlPreset === "classic" ? "Classic" : "Modernized"} preset selected`,
        done: true
      },
      {
        id: "quality",
        label: `${formatGraphicsQuality(settingsDraft.graphicsQuality)} renderer profile ready`,
        done: true
      },
      {
        id: "room",
        label: connectedRoom ? `Connected to ${connectedRoom.name}` : "Join or create a room",
        done: Boolean(connectedRoom)
      },
      {
        id: "pointer-lock",
        label: pointerLocked ? "Pointer lock engaged" : "Click the arena to lock the pointer",
        done: pointerLocked
      }
    ],
    [connectedRoom, pointerLocked, settingsDraft.controlPreset, settingsDraft.graphicsQuality]
  );
  const arenaState = connectedRoom ? (localPlayer ? "ready" : "spawning") : "preview";
  const arenaActionLabel = connectedRoom
    ? undefined
    : selectedRoom
      ? "Join selected room"
      : featuredLevel
        ? "Create room and spawn Hector"
        : undefined;
  const arenaActionDetail = connectedRoom
    ? localPlayer
      ? undefined
      : `Connected to ${connectedRoom.name}. Waiting for the room worker to hand you a spawned Hector.`
    : selectedRoom
      ? `Selected room ${selectedRoom.name} is loaded, but you are still looking at a level preview. Join the room to spawn into the match.`
      : featuredLevel
        ? `You are looking at the imported ${featuredLevel.title} geometry only. Create a room first to spawn a playable Hector.`
        : "No imported level is active yet.";

  useAvaraSoundscape({
    scene,
    snapshot,
    localPlayerId,
    roomActive: Boolean(connectedRoomId),
    pointerLocked
  });

  useEffect(() => {
    if (pointerLocked && connectedRoom && !onboardingDismissed) {
      persistOnboardingDismissed(true);
      setOnboardingDismissed(true);
    }
  }, [connectedRoom, onboardingDismissed, pointerLocked]);

  useEffect(() => {
    const onVisibilityChange = () => {
      setDocumentHidden(document.hidden);
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    void bootstrap();

    async function bootstrap() {
      try {
        setBusy(true);
        ensureAdSessionId();
        const { identity: nextIdentity, settings } = await ensurePlayerProfile();
        const nextLevels = await fetchLevels();
        let nextRooms = await fetchRooms();
        let selectedId = nextRooms[0]?.id ?? "";
        let connectedId = "";
        let nextLevelId = nextRooms[0]?.levelId ?? nextLevels[0]?.id ?? "";

        const inviteCode = new URL(window.location.href).searchParams.get("invite")?.trim().toUpperCase() ?? "";
        const reconnect = readReconnectState();

        if (inviteCode) {
          try {
            const invitedRoom = await joinRoomByInvite(inviteCode);
            nextRooms = upsertRoom(nextRooms, invitedRoom);
            selectedId = invitedRoom.id;
            connectedId = invitedRoom.id;
            nextLevelId = invitedRoom.levelId;
          } catch {
            const invitedRoom = await fetchRoomByInvite(inviteCode);
            nextRooms = upsertRoom(nextRooms, invitedRoom);
            selectedId = invitedRoom.id;
            nextLevelId = invitedRoom.levelId;
            setError("Invite loaded. Join when ready.");
          }
        } else if (reconnect && Date.now() - reconnect.savedAt <= 30_000) {
          try {
            const resumedRoom = reconnect.inviteCode
              ? await joinRoomByInvite(reconnect.inviteCode)
              : await fetchRoom(reconnect.roomId);
            nextRooms = upsertRoom(nextRooms, resumedRoom);
            selectedId = resumedRoom.id;
            connectedId = resumedRoom.id;
            nextLevelId = resumedRoom.levelId;
          } catch {
            clearReconnectState();
          }
        }

        setIdentity(nextIdentity);
        setPlayerSettings(settings);
        setSettingsDraft(settings);
        setLevels(nextLevels);
        setRooms(nextRooms);
        setSelectedRoomId(selectedId);
        setConnectedRoomId(connectedId);
        setActiveLevelId(nextLevelId);
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Failed to bootstrap player");
      } finally {
        setBusy(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!identity) {
      return;
    }

    let cancelled = false;
    let timerId = 0;

    const refresh = async () => {
      try {
        const nextRooms = await fetchRooms();
        if (!cancelled) {
          setRooms((current) => mergeRooms(current, nextRooms));
        }
      } catch {
        return;
      } finally {
        if (!cancelled) {
          timerId = window.setTimeout(refresh, visibilityRef.current ? 15_000 : 5_000);
        }
      }
    };

    void refresh();
    return () => {
      cancelled = true;
      window.clearTimeout(timerId);
    };
  }, [identity?.id]);

  useEffect(() => {
    if (!selectedRoom) {
      return;
    }

    setActiveLevelId(selectedRoom.levelId);
  }, [selectedRoom]);

  useEffect(() => {
    if (!activeLevelId) {
      return;
    }

    let cancelled = false;
    setBusy(true);
    setBillboards([]);
    setLevelAds({ lobby: [], loading: [], results: [] });
    void Promise.all([fetchLevelScene(activeLevelId), fetchLevelAds(activeLevelId)])
      .then(([scenePayload, adsPayload]) => {
        if (cancelled) {
          return;
        }

        startTransition(() => {
          setScene(scenePayload.scene);
          setBillboards(scenePayload.billboards);
          setLevelAds(adsPayload.ads);
        });
      })
      .catch((nextError) => {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : "Failed to load imported scene");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setBusy(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeLevelId]);

  useEffect(() => {
    if (!activeLevelId || !scene || scene.id !== activeLevelId) {
      setBillboards([]);
      return;
    }

    const hasBillboardSlots = scene.nodes.some((node) => node.type === "ad_placeholder");
    if (!hasBillboardSlots) {
      setBillboards([]);
      return;
    }

    let cancelled = false;
    let timerId = 0;

    const refresh = async () => {
      try {
        const nextBillboards = await fetchLevelBillboards(activeLevelId);
        if (!cancelled) {
          setBillboards(nextBillboards);
        }
      } catch (nextError) {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : "Billboard refresh failed");
        }
      } finally {
        if (!cancelled) {
          timerId = window.setTimeout(refresh, visibilityRef.current ? 15_000 : 5_000);
        }
      }
    };

    void refresh();
    return () => {
      cancelled = true;
      window.clearTimeout(timerId);
    };
  }, [activeLevelId, scene]);

  useEffect(() => {
    for (const billboard of billboards) {
      if (!billboard.campaignId) {
        continue;
      }
      reportAdImpression(billboard.campaignId, "level_billboard", billboard.slotId);
    }
  }, [billboards, activeLevelId]);

  useEffect(() => {
    if (activeLobbyCampaign) {
      reportAdImpression(activeLobbyCampaign.id, "lobby_banner");
    }
  }, [activeLobbyCampaign?.id, activeLevelId]);

  useEffect(() => {
    if (busy && activeLoadingCampaign) {
      reportAdImpression(activeLoadingCampaign.id, "level_loading");
    }
  }, [busy, activeLoadingCampaign?.id, activeLevelId]);

  useEffect(() => {
    if (snapshot?.roomStatus === "ended" && activeResultsCampaign) {
      reportAdImpression(activeResultsCampaign.id, "results_banner");
    }
  }, [snapshot?.roomStatus, activeResultsCampaign?.id, activeLevelId]);

  useEffect(() => {
    const bindings = getBindingMap(playerSettings.controlPreset);
    const trackedKeys = new Set([
      ...bindings.moveForwardPositive,
      ...bindings.moveForwardNegative,
      ...bindings.turnLeft,
      ...bindings.turnRight,
      ...bindings.verticalMotionKeys,
      ...bindings.primaryFireKeys,
      ...bindings.boostKeys,
      ...bindings.crouchJumpKeys
    ]);

    const onKeyDown = (event: KeyboardEvent) => {
      if (bindings.scoutViewKeys.includes(event.code)) {
        if (!event.repeat && document.pointerLockElement && connectedRoomId) {
          queuedActionRef.current.toggleScoutView = true;
        }
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (trackedKeys.has(event.code)) {
        keyStateRef.current[event.code] = true;
        event.preventDefault();
        return;
      }

      if (event.repeat) {
        return;
      }

      if (bindings.missileKeys.includes(event.code)) {
        queuedActionRef.current.loadMissile = true;
        event.preventDefault();
      }

      if (bindings.grenadeKeys.includes(event.code)) {
        queuedActionRef.current.loadGrenade = true;
        event.preventDefault();
      }

    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (bindings.scoutViewKeys.includes(event.code)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (trackedKeys.has(event.code)) {
        keyStateRef.current[event.code] = false;
        event.preventDefault();
      }
    };

    const onMouseDown = (event: MouseEvent) => {
      if (event.button === 0 && document.pointerLockElement) {
        fireActiveRef.current = true;
        event.preventDefault();
      }
    };

    const onMouseUp = (event: MouseEvent) => {
      if (event.button === 0) {
        fireActiveRef.current = false;
      }
    };

    const onBlur = () => {
      keyStateRef.current = {};
      fireActiveRef.current = false;
      queuedActionRef.current = {
        loadMissile: false,
        loadGrenade: false,
        toggleScoutView: false,
        scoutCommand: null
      };
      stanceDeltaRef.current = 0;
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("blur", onBlur);

    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [connectedRoomId, playerSettings.controlPreset]);

  useEffect(() => {
    if (!identity || !connectedRoom || !scene || scene.id !== connectedRoom.levelId) {
      return;
    }

    let cancelled = false;
    let inputTimer = 0;
    let snapshotTimer = 0;
    let heartbeatTimer = 0;
    let suspendDisconnect = false;

    const markReconnect = () => {
      suspendDisconnect = true;
      writeReconnectState(connectedRoom);
    };

    const runInputLoop = async (room: RoomSummary, playerId: string) => {
      try {
        if (!visibilityRef.current) {
          const nextSnapshot = await sendPrototypeInput(
            room,
            playerId,
            buildCombatInput(
              keyStateRef.current,
              lookStateRef.current,
              stanceDeltaRef,
              queuedActionRef.current,
              fireActiveRef.current,
              playerSettingsRef.current
            )
          );
          if (!cancelled) {
            setSnapshot(nextSnapshot);
          }
        }
      } catch (nextError) {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : "Input loop failed");
        }
      } finally {
        if (!cancelled) {
          inputTimer = window.setTimeout(() => void runInputLoop(room, playerId), visibilityRef.current ? 250 : 50);
        }
      }
    };

    const runSnapshotLoop = async (room: RoomSummary) => {
      try {
        const nextSnapshot = await fetchPrototypeSnapshot(room);
        if (!cancelled) {
          setSnapshot(nextSnapshot);
        }
      } catch (nextError) {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : "Snapshot poll failed");
        }
      } finally {
        if (!cancelled) {
          snapshotTimer = window.setTimeout(() => void runSnapshotLoop(room), visibilityRef.current ? 900 : 120);
        }
      }
    };

    const runHeartbeatLoop = async (roomId: string) => {
      try {
        const freshRoom = await heartbeatRoom(roomId);
        if (!cancelled) {
          setRooms((current) => upsertRoom(current, freshRoom));
          writeReconnectState(freshRoom);
        }
      } catch {
        return;
      } finally {
        if (!cancelled) {
          heartbeatTimer = window.setTimeout(() => void runHeartbeatLoop(roomId), visibilityRef.current ? 12_000 : 5_000);
        }
      }
    };

    const startSession = async () => {
      try {
        setPrototypeStatus("bootstrapping");
        setError("");

        await bootstrapPrototypeRoom(connectedRoom);
        const joinedRoom = await joinRoom(connectedRoom.id);
        if (cancelled) {
          return;
        }

        setRooms((current) => upsertRoom(current, joinedRoom));
        writeReconnectState(joinedRoom);
        syncInviteQuery(joinedRoom.inviteCode);

        const joined = await joinPrototypeRoom(joinedRoom, identity, playerSettingsRef.current.hullType);
        if (cancelled) {
          return;
        }

        setLocalPlayerId(joined.playerId);
        setSnapshot(joined.snapshot);
        setPrototypeStatus("live");

        void runHeartbeatLoop(joinedRoom.id);
        void runInputLoop(joinedRoom, joined.playerId);
        void runSnapshotLoop(joinedRoom);
      } catch (nextError) {
        if (!cancelled) {
          setPrototypeStatus("idle");
          setError(nextError instanceof Error ? nextError.message : "Room session failed");
        }
      }
    };

    window.addEventListener("pagehide", markReconnect);
    window.addEventListener("beforeunload", markReconnect);
    void startSession();

    return () => {
      cancelled = true;
      window.removeEventListener("pagehide", markReconnect);
      window.removeEventListener("beforeunload", markReconnect);
      window.clearTimeout(inputTimer);
      window.clearTimeout(snapshotTimer);
      window.clearTimeout(heartbeatTimer);
      setSnapshot(null);
      setLocalPlayerId("");
      setPrototypeStatus("idle");
      queuedActionRef.current = {
        loadMissile: false,
        loadGrenade: false,
        toggleScoutView: false,
        scoutCommand: null
      };
      fireActiveRef.current = false;

      if (suspendDisconnect) {
        return;
      }

      clearReconnectState();
      syncInviteQuery();
      void leavePrototypeRoom(connectedRoom, identity.id).catch(() => undefined);
      void leaveRoom(connectedRoom.id)
        .then((room) => {
          setRooms((current) => upsertRoom(current, room));
        })
        .catch(() => undefined);
    };
  }, [connectedRoom?.id, identity?.id, scene?.id]);

  useEffect(() => {
    return () => {
      if (settingsNoticeTimerRef.current) {
        window.clearTimeout(settingsNoticeTimerRef.current);
      }
    };
  }, []);

  async function handleCreateRoom() {
    if (!featuredLevel) {
      return;
    }

    try {
      setBusy(true);
      setError("");
      const room = await createRoom(featuredLevel.id, roomName, roomVisibility);
      setRooms((current) => upsertRoom(current, room));
      setSelectedRoomId(room.id);
      setConnectedRoomId(room.id);
      setActiveLevelId(room.levelId);
      writeReconnectState(room);
      syncInviteQuery(room.inviteCode);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to create room");
    } finally {
      setBusy(false);
    }
  }

  async function handleJoinSelectedRoom() {
    if (!selectedRoom) {
      return;
    }

    try {
      setBusy(true);
      setError("");
      const room =
        selectedRoom.visibility === "public"
          ? await joinRoom(selectedRoom.id)
          : await joinRoomByInvite(selectedRoom.inviteCode);
      setRooms((current) => upsertRoom(current, room));
      setSelectedRoomId(room.id);
      setConnectedRoomId(room.id);
      setActiveLevelId(room.levelId);
      writeReconnectState(room);
      syncInviteQuery(room.inviteCode);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to join room");
    } finally {
      setBusy(false);
    }
  }

  async function handleJoinByInvite() {
    const inviteCode = inviteCodeInput.trim().toUpperCase();
    if (!inviteCode) {
      return;
    }

    try {
      setBusy(true);
      setError("");
      const room = await joinRoomByInvite(inviteCode);
      setRooms((current) => upsertRoom(current, room));
      setSelectedRoomId(room.id);
      setConnectedRoomId(room.id);
      setActiveLevelId(room.levelId);
      writeReconnectState(room);
      syncInviteQuery(room.inviteCode);
      setInviteCodeInput("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to join by invite");
    } finally {
      setBusy(false);
    }
  }

  function handleDisconnectRoom() {
    clearReconnectState();
    syncInviteQuery();
    setConnectedRoomId("");
  }

  async function handleEndRoom() {
    if (!connectedRoom || !identity || connectedRoom.ownerUserId !== identity.id) {
      return;
    }

    try {
      setBusy(true);
      setError("");
      const room = await endRoom(connectedRoom.id);
      setRooms((current) => upsertRoom(current, room));
      clearReconnectState();
      syncInviteQuery();
      setConnectedRoomId("");
      setSelectedRoomId(room.id);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to end room");
    } finally {
      setBusy(false);
    }
  }

  async function handleCopyInvite() {
    if (!shareInviteUrl) {
      return;
    }

    try {
      await navigator.clipboard.writeText(shareInviteUrl);
      setCopyStatus("Invite copied");
      window.setTimeout(() => setCopyStatus(""), 1800);
    } catch {
      setCopyStatus("Copy failed");
      window.setTimeout(() => setCopyStatus(""), 1800);
    }
  }

  async function handleSaveSettings() {
    try {
      setSettingsBusy(true);
      setSettingsNotice("");
      const nextSettings = await updatePlayerSettings(settingsDraft);
      setPlayerSettings(nextSettings);
      setSettingsDraft(nextSettings);
      setSettingsNotice("Controls and renderer profile saved.");
      if (settingsNoticeTimerRef.current) {
        window.clearTimeout(settingsNoticeTimerRef.current);
      }
      settingsNoticeTimerRef.current = window.setTimeout(() => setSettingsNotice(""), 2200);
    } catch (nextError) {
      setSettingsNotice(nextError instanceof Error ? nextError.message : "Failed to save settings");
    } finally {
      setSettingsBusy(false);
    }
  }

  function reportAdImpression(campaignId: string, placementType: AdPlacementType, slotId?: string) {
    const levelId = activeLevelId || featuredLevel?.id;
    const key = [campaignId, placementType, levelId ?? "", slotId ?? ""].join(":");
    if (reportedAdsRef.current.has(key)) {
      return;
    }
    reportedAdsRef.current.add(key);
    void trackAdEvent({
      campaignId,
      placementType,
      eventType: "impression",
      levelId,
      slotId
    }).catch(() => undefined);
  }

  function handleAdClick(campaign: AdCampaign, placementType: AdPlacementType, slotId?: string) {
    if (!campaign.destinationUrl) {
      return;
    }

    void trackAdEvent({
      campaignId: campaign.id,
      placementType,
      eventType: "click",
      levelId: activeLevelId || featuredLevel?.id,
      slotId
    }).catch(() => undefined);
    window.open(campaign.destinationUrl, "_blank", "noopener,noreferrer");
  }

  return (
    <div className="desktop-shell">
      <div className="menu-bar">
        <div className="menu-items">
          <strong>Avara Online</strong>
          <span>File</span>
          <span>Edit</span>
          <span>Rooms</span>
          <span>Pilot</span>
          <span>Help</span>
        </div>
        <div className="menu-status">
          <span>{identity?.displayName ?? "Guest"}</span>
          <span>{featuredLevel?.title ?? "No arena"}</span>
          <span>{viewportTelemetry.fps ? `${viewportTelemetry.fps} FPS` : "Sampling"}</span>
        </div>
      </div>

      <div className="app-shell">
      <main className="main-stage">
        <div className="hero-bar">
          <div className="hero-heading">
            <span className="eyebrow">Arena Window</span>
            <h2>{featuredLevel?.title ?? "Choose a room"}</h2>
            <p className="muted hero-copy">
              {connectedRoom
                ? `Connected as ${identity?.displayName ?? "guest"} in ${connectedRoom.name}. Click the arena to drive.`
                : selectedRoom
                  ? `Selected room ready: ${selectedRoom.name}. Join it, or spin up a fresh room below.`
                  : "Pick a live room or create a fresh one, then click into the arena when you are ready to drive."}
            </p>
          </div>
          <div className="hero-status">
            <span>{rooms.length} visible rooms</span>
            <span>{levels.length} imported levels</span>
            <span>Room: {connectedRoom?.name ?? selectedRoom?.name ?? "none"}</span>
            <span>Match: {snapshot?.roomStatus ?? prototypeStatus}</span>
            <span>{formatGraphicsQuality(playerSettings.graphicsQuality)}</span>
            <span>{viewportTelemetry.fps ? `${viewportTelemetry.fps} FPS` : "Sampling"}</span>
          </div>
        </div>

        <div className="control-dock">
          <div className="card dock-card launch-console">
            <div className="card-header">
              <h2>Launch Console</h2>
              <span>{selectedRoom?.name ?? featuredLevel?.title ?? "Ready"}</span>
            </div>
            <div className="launch-console-grid">
              <div className="launch-callout">
                <span className="eyebrow">{connectedRoom ? "Live room" : "Start match"}</span>
                <strong>
                  {!levels.length
                    ? "Catalog load failed"
                    : connectedRoom
                      ? `Connected to ${connectedRoom.name}`
                      : selectedRoom
                        ? `Join ${selectedRoom.name}`
                        : `Create a room on ${featuredLevel?.title ?? "the imported level set"}`}
                </strong>
                <p className="muted">
                  {!levels.length
                    ? "The browser did not get the imported level catalog from the API, so room creation is blocked until the API is reachable."
                    : connectedRoom
                      ? "Click the arena to lock the pointer. Movement starts as soon as the authoritative loop sees your input."
                      : selectedRoom
                        ? "Join the selected room, then click the arena to capture the pointer and start moving."
                        : "Create a room, then click the arena to drive. W/S move, A/D turn, click or Space fires, and Q/E load weapons."}
                </p>
                {(selectedRoom || connectedRoom) ? (
                  <div className="pilot-summary launch-room-meta">
                    <span>{(connectedRoom ?? selectedRoom)?.levelTitle}</span>
                    <span>{(connectedRoom ?? selectedRoom)?.visibility}</span>
                    <span>{(connectedRoom ?? selectedRoom)?.currentPlayers ?? 0}/{(connectedRoom ?? selectedRoom)?.playerCap ?? 8} pilots</span>
                  </div>
                ) : null}
              </div>

              <div className="launch-actions">
                {selectedRoom ? (
                  <button className="primary-button" disabled={busy || connectedRoom?.id === selectedRoom.id} onClick={handleJoinSelectedRoom}>
                    {connectedRoom?.id === selectedRoom.id ? "Connected" : busy ? "Working…" : "Join selected room"}
                  </button>
                ) : null}
                <button className="secondary-button" disabled={!featuredLevel || busy} onClick={handleCreateRoom}>
                  {busy ? "Working…" : "Quick start: create room"}
                </button>
                {shareInviteUrl ? (
                  <button className="secondary-button" onClick={handleCopyInvite}>
                    Copy invite
                  </button>
                ) : null}
                {connectedRoom ? (
                  <button className="secondary-button" onClick={handleDisconnectRoom}>
                    Disconnect
                  </button>
                ) : null}
                {selectedRoom && connectedRoom?.id === selectedRoom.id && identity?.id === selectedRoom.ownerUserId ? (
                  <button className="secondary-button" disabled={busy} onClick={handleEndRoom}>
                    End room
                  </button>
                ) : null}
              </div>
            </div>

            <div className="launch-forms">
              <div className="launch-form-group">
                <label className="field">
                  <span>Room name</span>
                  <input value={roomName} onChange={(event) => setRoomName(event.target.value)} />
                </label>
                <label className="field">
                  <span>Visibility</span>
                  <select value={roomVisibility} onChange={(event) => setRoomVisibility(event.target.value as Visibility)}>
                    <option value="public">Public room</option>
                    <option value="private">Private room</option>
                  </select>
                </label>
              </div>

              <div className="launch-form-group">
                <label className="field">
                  <span>Invite code</span>
                  <input
                    value={inviteCodeInput}
                    onChange={(event) => setInviteCodeInput(event.target.value.toUpperCase())}
                    placeholder="ABC123"
                  />
                </label>
                <button className="secondary-button" disabled={!inviteCodeInput.trim() || busy} onClick={handleJoinByInvite}>
                  Join from invite
                </button>
              </div>
            </div>

            {copyStatus ? <p className="muted">{copyStatus}</p> : null}
          </div>

          <div className="card dock-card pilot-card">
            <div className="card-header">
              <h2>Pilot</h2>
              <span>{identity?.displayName ?? "Loading guest…"}</span>
            </div>
            <div className="pilot-summary pilot-summary-tight">
              <span>{identity?.guest ? "Guest identity" : "Registered identity"}</span>
              <span>{formatGraphicsQuality(playerSettings.graphicsQuality)} renderer</span>
              <span>{viewportTelemetry.fps ? `${viewportTelemetry.fps} FPS` : "Sampling"}</span>
            </div>
            <p className="muted compact-copy">
              Controls and graphics stay saved in this browser, so you can jump back into the arena without redoing setup.
            </p>
            {!onboardingDismissed ? (
              <div className="compact-guide">
                <div className="compact-guide-list">
                  {onboardingChecklist.map((step) => (
                    <div key={step.id} className={step.done ? "checklist-item checklist-item-done" : "checklist-item"}>
                      <span>{step.done ? "Ready" : "Next"}</span>
                      <strong>{step.label}</strong>
                    </div>
                  ))}
                </div>
                <button
                  className="secondary-button"
                  onClick={() => {
                    persistOnboardingDismissed(true);
                    setOnboardingDismissed(true);
                  }}
                >
                  Dismiss guide
                </button>
              </div>
            ) : (
              <div className="compact-tip">
                <span className="eyebrow">Quick start</span>
                <strong>{pointerLocked ? "Pointer locked" : "Click the arena to lock your pointer"}</strong>
              </div>
            )}
            {activeLobbyCampaign ? (
              <div className="compact-sponsor">
                <span>{activeLobbyCampaign.name}</span>
                {activeLobbyCampaign.destinationUrl ? (
                  <button className="secondary-button" onClick={() => handleAdClick(activeLobbyCampaign, "lobby_banner")}>
                    Open sponsor
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>

          <details className="card dock-card settings-drawer">
            <summary className="details-summary">
              <span>Control Panel</span>
              <span>{settingsDirty ? "Unsaved" : "Saved"}</span>
            </summary>

            <label className="field">
              <span>Control preset</span>
              <select
                value={settingsDraft.controlPreset}
                onChange={(event) =>
                  setSettingsDraft((current) => ({
                    ...current,
                    controlPreset: event.target.value as PlayerSettings["controlPreset"]
                  }))
                }
              >
                {CONTROL_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="muted preset-copy">
              {CONTROL_PRESETS.find((preset) => preset.id === settingsDraft.controlPreset)?.description}
            </p>

            <label className="field">
              <span>Sensitivity</span>
              <input
                type="range"
                min="0.2"
                max="2"
                step="0.05"
                value={settingsDraft.sensitivity}
                onChange={(event) =>
                  setSettingsDraft((current) => ({
                    ...current,
                    sensitivity: Number(event.target.value)
                  }))
                }
              />
            </label>
            <div className="field-inline">
              <span className="muted">Current multiplier</span>
              <strong>{settingsDraft.sensitivity.toFixed(2)}x</strong>
            </div>

            <label className="toggle-field">
              <input
                type="checkbox"
                checked={settingsDraft.invertY}
                onChange={(event) =>
                  setSettingsDraft((current) => ({
                    ...current,
                    invertY: event.target.checked
                  }))
                }
              />
              <span>Invert Y axis</span>
            </label>

            <label className="field">
              <span>Graphics quality</span>
              <select
                value={settingsDraft.graphicsQuality}
                onChange={(event) =>
                  setSettingsDraft((current) => ({
                    ...current,
                    graphicsQuality: event.target.value as GraphicsQuality
                  }))
                }
              >
                {GRAPHICS_QUALITY_OPTIONS.map((quality) => (
                  <option key={quality.id} value={quality.id}>
                    {quality.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="muted preset-copy">
              {GRAPHICS_QUALITY_OPTIONS.find((quality) => quality.id === settingsDraft.graphicsQuality)?.description}
            </p>

            <label className="field">
              <span>Hull class</span>
              <select
                value={settingsDraft.hullType}
                onChange={(event) =>
                  setSettingsDraft((current) => ({
                    ...current,
                    hullType: event.target.value as PlayerSettings["hullType"]
                  }))
                }
              >
                {HULL_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="muted preset-copy">
              {HULL_OPTIONS.find((option) => option.id === settingsDraft.hullType)?.description}
            </p>

            <label className="toggle-field">
              <input
                type="checkbox"
                checked={settingsDraft.showPerformanceHud}
                onChange={(event) =>
                  setSettingsDraft((current) => ({
                    ...current,
                    showPerformanceHud: event.target.checked
                  }))
                }
              />
              <span>Show FPS and render diagnostics in match</span>
            </label>

            <div className="binding-list">
              {selectedBindings.map((binding) => (
                <div key={binding.action} className="binding-row">
                  <span>{binding.action}</span>
                  <strong>{binding.keys}</strong>
                </div>
              ))}
            </div>

            <div className="card-actions">
              <button className="primary-button" disabled={!settingsDirty || settingsBusy} onClick={handleSaveSettings}>
                {settingsBusy ? "Saving…" : "Save setup"}
              </button>
              <button className="secondary-button" disabled={!settingsDirty || settingsBusy} onClick={() => setSettingsDraft(playerSettings)}>
                Reset
              </button>
            </div>
            {settingsNotice ? <p className="muted">{settingsNotice}</p> : null}
          </details>
        </div>

        {error ? <div className="card error-card inline-error-card">{error}</div> : null}

        {busy && activeLoadingCampaign ? (
          <div className="inline-ad-card">
            <div>
              <span className="eyebrow">Loading Placement</span>
              <strong>{activeLoadingCampaign.name}</strong>
            </div>
            <img className="ad-surface ad-surface-inline" src={activeLoadingCampaign.creativeUrl} alt={activeLoadingCampaign.name} />
            {activeLoadingCampaign.destinationUrl ? (
              <button className="secondary-button" onClick={() => handleAdClick(activeLoadingCampaign, "level_loading")}>
                Open sponsor
              </button>
            ) : null}
          </div>
        ) : null}

        <Suspense fallback={<div className="viewport-shell viewport-loading">Loading Three.js viewport…</div>}>
          <LevelViewport
            scene={scene}
            billboards={billboards}
            snapshot={snapshot}
            localPlayerId={localPlayerId}
            arenaState={arenaState}
            arenaActionLabel={arenaActionLabel}
            arenaActionDetail={arenaActionDetail}
            onArenaAction={
              connectedRoom
                ? undefined
                : selectedRoom
                  ? () => {
                      void handleJoinSelectedRoom();
                    }
                  : featuredLevel
                    ? () => {
                        void handleCreateRoom();
                      }
                    : undefined
            }
            playerSettings={playerSettings}
            prototypeStatus={prototypeStatus}
            onAimChange={(aim) => {
              lookStateRef.current = aim;
            }}
            isVerticalMotionActive={() => isBindingActive(keyStateRef.current, getBindingMap(playerSettingsRef.current.controlPreset).verticalMotionKeys)}
            onStanceAdjust={(delta) => {
              stanceDeltaRef.current += delta;
            }}
            onPointerLockChange={setPointerLocked}
            onTelemetryChange={setViewportTelemetry}
          />
        </Suspense>

        {compatibilityNotes.length ? (
          <div className="notice-strip">
            {compatibilityNotes.map((note) => (
              <div key={note.title} className="notice-card">
                <strong>{note.title}</strong>
                <p>{note.detail}</p>
              </div>
            ))}
          </div>
        ) : null}
      </main>

      <aside className="panel panel-right">
        <div className="card">
          <div className="card-header">
            <h2>Room Browser</h2>
            <span>Live rooms</span>
          </div>
          <div className="room-list">
            {rooms.length ? (
              rooms.map((room) => (
                <button
                  key={room.id}
                  className={room.id === selectedRoom?.id ? "room-card room-card-active" : "room-card"}
                  onClick={() => {
                    setSelectedRoomId(room.id);
                    setActiveLevelId(room.levelId);
                  }}
                >
                  <strong>{room.name}</strong>
                  <span>{room.levelTitle}</span>
                  <small>
                    {room.currentPlayers}/{room.playerCap} pilots • {room.visibility} • {room.estimatedPingMs}ms • {room.status}
                  </small>
                  {room.id === connectedRoom?.id ? <small>Connected room</small> : null}
                </button>
              ))
            ) : (
              <div className="empty-state-card">
                <strong>No rooms visible</strong>
                <p>Use the Quick start action or the Create room panel on the left to spin up the first room.</p>
              </div>
            )}
          </div>
        </div>

        {selectedRoom ? (
          <div className="card">
            <div className="card-header">
              <h2>Selection</h2>
              <span>{selectedRoom.inviteCode}</span>
            </div>
            <div className="pilot-summary pilot-summary-tight">
              <span>{selectedRoom.levelTitle}</span>
              <span>{selectedRoom.visibility}</span>
              <span>Worker {selectedRoom.gameWorkerId}</span>
            </div>
            <p className="muted invite-preview">{shareInviteUrl || "Invite link unavailable"}</p>
          </div>
        ) : null}

        <details className="card sidebar-drawer" open>
          <summary className="details-summary">
            <span>Level Catalog</span>
            <span>{levels.length ? "Available now" : "Waiting on API"}</span>
          </summary>
          <div className="level-list">
            {levels.length ? (
              levels.slice(0, 8).map((level) => (
                <button
                  key={level.id}
                  className={level.id === activeLevelId ? "level-chip level-chip-active" : "level-chip"}
                  onClick={() => {
                    setSelectedRoomId("");
                    setActiveLevelId(level.id);
                  }}
                >
                  <strong>{level.title}</strong>
                  <span>{level.packTitle}</span>
                </button>
              ))
            ) : (
              <div className="empty-state-card">
                <strong>No imported levels available</strong>
                <p>The API did not return a catalog, so the browser cannot create or preview a level yet.</p>
              </div>
            )}
          </div>
        </details>

        {billboards.length ? (
          <details className="card sidebar-drawer">
            <summary className="details-summary">
              <span>Arena Billboards</span>
              <span>{billboards.length} active</span>
            </summary>
            <div className="pilot-summary billboard-list">
              {billboards.map((billboard) => (
                <span key={billboard.nodeId}>
                  {billboard.slotId}: {billboard.campaignName ?? "Open inventory"}
                </span>
              ))}
            </div>
          </details>
        ) : null}

        {snapshot?.roomStatus === "ended" ? (
          <div className="card">
            <div className="card-header">
              <h2>Match results</h2>
              <span>Final</span>
            </div>
            {activeResultsCampaign ? (
              <>
                <img className="ad-surface" src={activeResultsCampaign.creativeUrl} alt={activeResultsCampaign.name} />
                <p className="muted">{activeResultsCampaign.name}</p>
                {activeResultsCampaign.destinationUrl ? (
                  <button className="secondary-button" onClick={() => handleAdClick(activeResultsCampaign, "results_banner")}>
                    Open sponsor
                  </button>
                ) : null}
              </>
            ) : (
              <p className="muted">The room has ended.</p>
            )}
          </div>
        ) : null}

        <div className="card status-card">
          <div className="card-header">
            <h2>System</h2>
            <span>{compatibilityNotes.length ? "Attention" : "Healthy"}</span>
          </div>
          <div className="pilot-summary pilot-summary-tight">
            <span>Pixel ratio {viewportTelemetry.pixelRatio.toFixed(2)}</span>
            <span>{documentHidden ? "Background throttling active" : "Foreground render path"}</span>
          </div>
        </div>
      </aside>
      </div>
    </div>
  );
}

function buildCombatInput(
  keys: Record<string, boolean>,
  look: { aimYaw: number; aimPitch: number },
  stanceDeltaRef: { current: number },
  queuedActions: {
    loadMissile: boolean;
    loadGrenade: boolean;
    toggleScoutView: boolean;
    scoutCommand: ScoutCommand | null;
  },
  primaryFire: boolean,
  settings: PlayerSettings
) {
  const bindings = getBindingMap(settings.controlPreset);
  const moveForward =
    (isBindingActive(keys, bindings.moveForwardPositive) ? 1 : 0) +
    (isBindingActive(keys, bindings.moveForwardNegative) ? -1 : 0);
  const keyTurn =
    (isBindingActive(keys, bindings.turnRight) ? 1 : 0) +
    (isBindingActive(keys, bindings.turnLeft) ? -1 : 0);
  const pointerLocked = typeof document !== "undefined" && Boolean(document.pointerLockElement);
  const useMouseSteer =
    settings.controlPreset === "modernized" && pointerLocked && Math.abs(moveForward) > 0.001
      && Math.abs(look.aimYaw) > 0.0001;
  const mouseSteer = useMouseSteer ? clamp(look.aimYaw / 0.45, -1, 1) : 0;
  const payload = {
    moveForward,
    turnBody: useMouseSteer ? mouseSteer : clamp(keyTurn, -1, 1),
    aimYaw: look.aimYaw,
    aimPitch: look.aimPitch,
    stanceDelta: stanceDeltaRef.current,
    primaryFire: primaryFire || isBindingActive(keys, bindings.primaryFireKeys),
    loadMissile: queuedActions.loadMissile,
    loadGrenade: queuedActions.loadGrenade,
    boost: isBindingActive(keys, bindings.boostKeys),
    crouchJump: isBindingActive(keys, bindings.crouchJumpKeys),
    toggleScoutView: queuedActions.toggleScoutView,
    scoutCommand: queuedActions.scoutCommand
  };

  queuedActions.loadMissile = false;
  queuedActions.loadGrenade = false;
  queuedActions.toggleScoutView = false;
  queuedActions.scoutCommand = null;
  stanceDeltaRef.current = 0;
  return payload;
}

function getBindingMap(controlPreset: PlayerSettings["controlPreset"]): BindingMap {
  if (controlPreset === "classic") {
    return {
      moveForwardPositive: ["KeyW"],
      moveForwardNegative: ["KeyS"],
      turnLeft: ["KeyA"],
      turnRight: ["KeyD"],
      verticalMotionKeys: ["ControlLeft"],
      primaryFireKeys: [],
      boostKeys: ["ShiftLeft", "ShiftRight"],
      crouchJumpKeys: ["Space"],
      missileKeys: ["KeyQ"],
      grenadeKeys: ["KeyE"],
      scoutViewKeys: ["Tab"]
    };
  }

  return {
    moveForwardPositive: ["KeyW", "ArrowUp"],
    moveForwardNegative: ["KeyS", "ArrowDown"],
    turnLeft: ["KeyA", "ArrowLeft"],
    turnRight: ["KeyD", "ArrowRight"],
    verticalMotionKeys: ["ControlLeft"],
    primaryFireKeys: [],
    boostKeys: ["ShiftLeft", "ShiftRight"],
    crouchJumpKeys: ["Space"],
    missileKeys: ["KeyQ", "KeyF"],
    grenadeKeys: ["KeyE", "KeyG"],
    scoutViewKeys: ["Tab"]
  };
}

function isBindingActive(keys: Record<string, boolean>, codes: string[]): boolean {
  return codes.some((code) => Boolean(keys[code]));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function playerSettingsEqual(left: PlayerSettings, right: PlayerSettings): boolean {
  return (
    left.controlPreset === right.controlPreset &&
    left.sensitivity === right.sensitivity &&
    left.invertY === right.invertY &&
    left.graphicsQuality === right.graphicsQuality &&
    left.showPerformanceHud === right.showPerformanceHud &&
    left.hullType === right.hullType
  );
}

function buildCompatibilityNotes(settings: PlayerSettings, telemetry: ViewportTelemetry): CompatibilityNotice[] {
  const notes: CompatibilityNotice[] = [];

  if (telemetry.compatibilityError) {
    notes.push({
      title: "WebGL compatibility issue",
      detail: `${telemetry.compatibilityError} Lobby browsing still works, but active combat needs a browser with WebGL enabled.`
    });
  }

  if (typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches) {
    notes.push({
      title: "Touch devices are browse-first",
      detail: "The lobby and invite flow stay usable on mobile, but active combat is still tuned for keyboard, mouse, and pointer lock."
    });
  }

  if (typeof navigator !== "undefined" && navigator.hardwareConcurrency > 0 && navigator.hardwareConcurrency <= 4 && settings.graphicsQuality === "quality") {
    notes.push({
      title: "Quality preset may overrun thin hardware",
      detail: "This browser reports a smaller CPU budget. Balanced or Performance will usually hold steadier 60 FPS targets."
    });
  }

  if (typeof window !== "undefined" && window.devicePixelRatio > 1.8 && settings.graphicsQuality === "quality") {
    notes.push({
      title: "High-density display detected",
      detail: "Quality mode drives a sharper backbuffer on Retina-class panels. Use Balanced if frame pacing starts to dip."
    });
  }

  if (
    typeof window !== "undefined" &&
    !window.isSecureContext &&
    window.location.hostname !== "localhost" &&
    window.location.hostname !== "127.0.0.1"
  ) {
    notes.push({
      title: "Secure context recommended",
      detail: "Pointer lock and future realtime transport behave best when the deployment runs over HTTPS."
    });
  }

  return notes;
}

function formatGraphicsQuality(value: GraphicsQuality): string {
  return GRAPHICS_QUALITY_OPTIONS.find((entry) => entry.id === value)?.label ?? value;
}

function upsertRoom(current: RoomSummary[], nextRoom: RoomSummary): RoomSummary[] {
  const existingIndex = current.findIndex((room) => room.id === nextRoom.id);
  if (existingIndex === -1) {
    return [nextRoom, ...current];
  }

  const nextRooms = current.slice();
  nextRooms[existingIndex] = nextRoom;
  return nextRooms;
}

function mergeRooms(current: RoomSummary[], incoming: RoomSummary[]): RoomSummary[] {
  let nextRooms = incoming.slice();
  for (const room of current) {
    if (!nextRooms.some((candidate) => candidate.id === room.id)) {
      nextRooms = [...nextRooms, room];
    }
  }
  return nextRooms;
}

function buildInviteUrl(invitePath: string | undefined, inviteCode: string): string {
  if (typeof window === "undefined") {
    return invitePath ?? `/?invite=${encodeURIComponent(inviteCode)}`;
  }

  return `${window.location.origin}${invitePath ?? `/?invite=${encodeURIComponent(inviteCode)}`}`;
}

function syncInviteQuery(inviteCode?: string): void {
  const url = new URL(window.location.href);
  if (inviteCode) {
    url.searchParams.set("invite", inviteCode);
  } else {
    url.searchParams.delete("invite");
  }
  window.history.replaceState({}, "", url);
}

function readReconnectState(): StoredReconnectState | null {
  try {
    const raw = window.localStorage.getItem(reconnectStorageKey);
    return raw ? (JSON.parse(raw) as StoredReconnectState) : null;
  } catch {
    return null;
  }
}

function writeReconnectState(room: Pick<RoomSummary, "id" | "inviteCode">): void {
  window.localStorage.setItem(
    reconnectStorageKey,
    JSON.stringify({
      roomId: room.id,
      inviteCode: room.inviteCode,
      savedAt: Date.now()
    } satisfies StoredReconnectState)
  );
}

function clearReconnectState(): void {
  window.localStorage.removeItem(reconnectStorageKey);
}

function readOnboardingDismissed(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    return window.localStorage.getItem(onboardingStorageKey) === "1";
  } catch {
    return false;
  }
}

function persistOnboardingDismissed(value: boolean): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    if (value) {
      window.localStorage.setItem(onboardingStorageKey, "1");
    } else {
      window.localStorage.removeItem(onboardingStorageKey);
    }
  } catch {
    return;
  }
}
