import type { Identity, PlayerSettings } from "@avara/shared-types";

export const DEFAULT_PLAYER_SETTINGS: PlayerSettings = {
  controlPreset: "modernized",
  sensitivity: 0.75,
  invertY: false,
  graphicsQuality: "balanced",
  showPerformanceHud: false
};

export function createGuestIdentity(displayName?: string): Identity {
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  return {
    id: `guest_${crypto.randomUUID()}`,
    displayName: displayName?.trim() || `Guest-${suffix}`,
    role: "guest",
    guest: true,
    createdAt: new Date().toISOString()
  };
}
