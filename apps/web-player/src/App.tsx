import { lazy, Suspense, startTransition, useEffect, useMemo, useRef, useState } from "react";

import type { SnapshotPacket } from "@avara/shared-protocol";
import type {
  Identity,
  LevelBillboardAssignment,
  LevelScene,
  LevelSummary,
  RoomSummary,
  Visibility
} from "@avara/shared-types";
import { CONTROL_PRESETS } from "@avara/shared-ui";

import {
  bootstrapPrototypeRoom,
  createRoom,
  endRoom,
  ensureGuestIdentity,
  fetchLevels,
  fetchLevelBillboards,
  fetchLevelScene,
  fetchPrototypeSnapshot,
  fetchRoom,
  fetchRoomByInvite,
  fetchRooms,
  heartbeatRoom,
  joinRoom,
  joinRoomByInvite,
  joinPrototypeRoom,
  leaveRoom,
  leavePrototypeRoom,
  sendPrototypeInput
} from "./lib/api";

const LevelViewport = lazy(() => import("./components/LevelViewport"));
const reconnectStorageKey = "avara-room-reconnect";

interface StoredReconnectState {
  roomId: string;
  inviteCode: string;
  savedAt: number;
}

export function App() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [levels, setLevels] = useState<LevelSummary[]>([]);
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

  const keyStateRef = useRef<Record<string, boolean>>({});
  const lookStateRef = useRef({ aimYaw: 0, aimPitch: 0 });
  const queuedActionRef = useRef({ loadMissile: false, loadGrenade: false });
  const fireActiveRef = useRef(false);

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
  const shareInviteUrl = selectedRoom ? buildInviteUrl(selectedRoom.invitePath, selectedRoom.inviteCode) : "";

  useEffect(() => {
    void bootstrap();

    async function bootstrap() {
      try {
        setBusy(true);
        const nextIdentity = await ensureGuestIdentity();
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
    const refresh = async () => {
      try {
        const nextRooms = await fetchRooms();
        if (!cancelled) {
          setRooms((current) => mergeRooms(current, nextRooms));
        }
      } catch {
        return;
      }
    };

    void refresh();
    const intervalId = window.setInterval(() => {
      void refresh();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
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
    void fetchLevelScene(activeLevelId)
      .then((payload) => {
        if (cancelled) {
          return;
        }

        startTransition(() => {
          setScene(payload.scene);
          setBillboards(payload.billboards);
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
    const intervalId = window.setInterval(() => {
      void fetchLevelBillboards(activeLevelId)
        .then((nextBillboards) => {
          if (!cancelled) {
            setBillboards(nextBillboards);
          }
        })
        .catch((nextError) => {
          if (!cancelled) {
            setError(nextError instanceof Error ? nextError.message : "Billboard refresh failed");
          }
        });
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [activeLevelId, scene]);

  useEffect(() => {
    const trackedKeys = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "ShiftLeft", "ShiftRight", "Space"]);

    const onKeyDown = (event: KeyboardEvent) => {
      if (trackedKeys.has(event.code)) {
        keyStateRef.current[event.code] = true;
        event.preventDefault();
        return;
      }

      if (event.repeat) {
        return;
      }

      if (event.code === "KeyQ") {
        queuedActionRef.current.loadMissile = true;
        event.preventDefault();
      }

      if (event.code === "KeyE") {
        queuedActionRef.current.loadGrenade = true;
        event.preventDefault();
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
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
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("blur", onBlur);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  useEffect(() => {
    if (!identity || !connectedRoom || !scene || scene.id !== connectedRoom.levelId) {
      return;
    }

    let cancelled = false;
    let inputInterval = 0;
    let snapshotInterval = 0;
    let heartbeatInterval = 0;
    let suspendDisconnect = false;

    const markReconnect = () => {
      suspendDisconnect = true;
      writeReconnectState(connectedRoom);
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

        const joined = await joinPrototypeRoom(joinedRoom, identity);
        if (cancelled) {
          return;
        }

        setLocalPlayerId(joined.playerId);
        setSnapshot(joined.snapshot);
        setPrototypeStatus("live");

        heartbeatInterval = window.setInterval(async () => {
          try {
            const freshRoom = await heartbeatRoom(joinedRoom.id);
            if (!cancelled) {
              setRooms((current) => upsertRoom(current, freshRoom));
              writeReconnectState(freshRoom);
            }
          } catch {
            return;
          }
        }, 5000);

        inputInterval = window.setInterval(async () => {
          try {
            const nextSnapshot = await sendPrototypeInput(
              joinedRoom,
              joined.playerId,
              buildCombatInput(
                keyStateRef.current,
                lookStateRef.current,
                queuedActionRef.current,
                fireActiveRef.current
              )
            );
            if (!cancelled) {
              setSnapshot(nextSnapshot);
            }
          } catch (nextError) {
            if (!cancelled) {
              setError(nextError instanceof Error ? nextError.message : "Input loop failed");
            }
          }
        }, 50);

        snapshotInterval = window.setInterval(async () => {
          try {
            const nextSnapshot = await fetchPrototypeSnapshot(joinedRoom);
            if (!cancelled) {
              setSnapshot(nextSnapshot);
            }
          } catch (nextError) {
            if (!cancelled) {
              setError(nextError instanceof Error ? nextError.message : "Snapshot poll failed");
            }
          }
        }, 120);
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
      window.clearInterval(inputInterval);
      window.clearInterval(snapshotInterval);
      window.clearInterval(heartbeatInterval);
      setSnapshot(null);
      setLocalPlayerId("");
      setPrototypeStatus("idle");
      queuedActionRef.current = { loadMissile: false, loadGrenade: false };
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

  return (
    <div className="app-shell">
      <aside className="panel panel-left">
        <div className="brand-block">
          <span className="eyebrow">Avara Web</span>
          <h1>Centralized rooms, invite links, and reconnect on imported classic levels.</h1>
          <p>
            Phase 2 separates room browsing from room connection, adds invite-driven join flow, and keeps a short reconnect
            window so a refresh does not immediately throw you out of the match.
          </p>
        </div>

        <div className="card">
          <div className="card-header">
            <h2>Identity</h2>
            <span>{identity?.displayName ?? "Loading guest…"}</span>
          </div>
          <p>Guest-first onboarding remains intact. Rooms now route through the room service and assigned worker path.</p>
        </div>

        <div className="card">
          <div className="card-header">
            <h2>Create room</h2>
            <span>{featuredLevel?.title ?? "No level selected"}</span>
          </div>
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
          <p>Public rooms appear in the browser. Private rooms stay link-driven, but guests can still host them.</p>
          <button className="primary-button" disabled={!featuredLevel || busy} onClick={handleCreateRoom}>
            {busy ? "Working…" : "Create centralized room"}
          </button>
        </div>

        <div className="card">
          <div className="card-header">
            <h2>Invite link</h2>
            <span>Join by code</span>
          </div>
          <label className="field">
            <span>Invite code</span>
            <input
              value={inviteCodeInput}
              onChange={(event) => setInviteCodeInput(event.target.value.toUpperCase())}
              placeholder="ABC123"
            />
          </label>
          <button className="primary-button" disabled={!inviteCodeInput.trim() || busy} onClick={handleJoinByInvite}>
            Join from invite
          </button>
        </div>

        <div className="card">
          <div className="card-header">
            <h2>Controls</h2>
            <span>Playable now</span>
          </div>
          <div className="preset-list">
            {CONTROL_PRESETS.map((preset) => (
              <div key={preset.id} className="preset">
                <strong>{preset.label}</strong>
                <p>{preset.description}</p>
              </div>
            ))}
          </div>
        </div>
      </aside>

      <main className="main-stage">
        <div className="hero-bar">
          <div>
            <span className="eyebrow">Official Level</span>
            <h2>{featuredLevel?.title ?? "Select a room"}</h2>
          </div>
          <div className="hero-status">
            <span>{rooms.length} visible rooms</span>
            <span>{levels.length} imported levels</span>
            <span>Room: {connectedRoom?.name ?? selectedRoom?.name ?? "none"}</span>
            <span>Match: {snapshot?.roomStatus ?? prototypeStatus}</span>
          </div>
        </div>

        <Suspense fallback={<div className="viewport-shell viewport-loading">Loading Three.js viewport…</div>}>
          <LevelViewport
            scene={scene}
            billboards={billboards}
            snapshot={snapshot}
            localPlayerId={localPlayerId}
            prototypeStatus={prototypeStatus}
            onAimChange={(aim) => {
              lookStateRef.current = aim;
            }}
          />
        </Suspense>
      </main>

      <aside className="panel panel-right">
        <div className="card">
          <div className="card-header">
            <h2>Room browser</h2>
            <span>Centralized infrastructure</span>
          </div>
          <div className="room-list">
            {rooms.map((room) => (
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
            ))}
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h2>Room detail</h2>
            <span>{selectedRoom ? selectedRoom.inviteCode : "Select a room"}</span>
          </div>
          {selectedRoom ? (
            <>
              <div className="pilot-summary">
                <span>{selectedRoom.levelTitle}</span>
                <span>{selectedRoom.visibility}</span>
                <span>Worker {selectedRoom.gameWorkerId}</span>
              </div>
              <div className="room-actions">
                <button className="primary-button" disabled={busy || connectedRoom?.id === selectedRoom.id} onClick={handleJoinSelectedRoom}>
                  {connectedRoom?.id === selectedRoom.id ? "Connected" : "Join room"}
                </button>
                <button className="secondary-button" disabled={!shareInviteUrl} onClick={handleCopyInvite}>
                  Copy invite
                </button>
                {connectedRoom?.id === selectedRoom.id ? (
                  <button className="secondary-button" onClick={handleDisconnectRoom}>
                    Disconnect
                  </button>
                ) : null}
                {connectedRoom?.id === selectedRoom.id && identity?.id === selectedRoom.ownerUserId ? (
                  <button className="secondary-button" disabled={busy} onClick={handleEndRoom}>
                    End room
                  </button>
                ) : null}
              </div>
              <p className="muted invite-preview">{shareInviteUrl || "Invite link unavailable"}</p>
              {copyStatus ? <p className="muted">{copyStatus}</p> : null}
            </>
          ) : (
            <p className="muted">Select a room to inspect it before joining.</p>
          )}
        </div>

        <div className="card">
          <div className="card-header">
            <h2>Billboard server</h2>
            <span>{billboards.length} slots</span>
          </div>
          {billboards.length ? (
            <div className="pilot-summary">
              {billboards.map((billboard) => (
                <span key={billboard.nodeId}>
                  {billboard.slotId}: {billboard.campaignName ?? "Open inventory"}
                </span>
              ))}
            </div>
          ) : (
            <p className="muted">Level-owned billboard placeholders will show their current campaign rotation here.</p>
          )}
        </div>

        <div className="card">
          <div className="card-header">
            <h2>Phase 2 flow</h2>
            <span>Invite + reconnect</span>
          </div>
          <p>
            Browsing a room no longer forces an immediate join. Connect deliberately, share the invite code, and refresh
            within the reconnect window to resume the same room session.
          </p>
          {localPlayer ? (
            <div className="pilot-summary">
              <strong>{localPlayer.displayName}</strong>
              <span>{localPlayer.kills} frags / {localPlayer.deaths} deaths</span>
              <span>{localPlayer.health} hull</span>
            </div>
          ) : (
            <p className="muted">Join a room to receive a live authoritative pilot state.</p>
          )}
        </div>

        <div className="card">
          <div className="card-header">
            <h2>Imported catalog</h2>
            <span>Official launch seed</span>
          </div>
          <div className="level-list">
            {levels.slice(0, 10).map((level) => (
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
            ))}
          </div>
        </div>

        {error ? <div className="card error-card">{error}</div> : null}
      </aside>
    </div>
  );
}

function buildCombatInput(
  keys: Record<string, boolean>,
  look: { aimYaw: number; aimPitch: number },
  queuedActions: { loadMissile: boolean; loadGrenade: boolean },
  primaryFire: boolean
) {
  const payload = {
    moveForward: (keys.KeyW ? 1 : 0) + (keys.KeyS ? -1 : 0),
    turnBody: (keys.KeyD ? 1 : 0) + (keys.KeyA ? -1 : 0),
    aimYaw: look.aimYaw,
    aimPitch: look.aimPitch,
    primaryFire: primaryFire || Boolean(keys.Space),
    loadMissile: queuedActions.loadMissile,
    loadGrenade: queuedActions.loadGrenade,
    boost: Boolean(keys.ShiftLeft || keys.ShiftRight),
    crouchJump: false
  };

  queuedActions.loadMissile = false;
  queuedActions.loadGrenade = false;
  return payload;
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
