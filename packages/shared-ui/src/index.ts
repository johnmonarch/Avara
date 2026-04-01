import type { ControlPreset, GraphicsQuality, RoomStatus } from "@avara/shared-types";

export const CONTROL_PRESETS: ControlPreset[] = [
  {
    id: "classic",
    label: "Classic",
    description: "Stay close to the documented Mac-era layout with W/S drive, A/D leg rotation, mouse aim, and mouse fire."
  },
  {
    id: "modernized",
    label: "Modernized",
    description: "Keep the mech feel but add extra key aliases, contextual prompts, and lower-friction first-play guidance."
  }
];

export interface ControlBindingHint {
  action: string;
  keys: string;
}

export const CONTROL_PRESET_BINDINGS: Record<ControlPreset["id"], ControlBindingHint[]> = {
  classic: [
    { action: "Drive", keys: "W / S" },
    { action: "Rotate legs", keys: "A / D" },
    { action: "Aim turret", keys: "Mouse" },
    { action: "Primary fire", keys: "Left click" },
    { action: "Load missile", keys: "Q" },
    { action: "Load grenade", keys: "E" },
    { action: "Booster", keys: "Left Shift" },
    { action: "Crouch / jump", keys: "Space" }
  ],
  modernized: [
    { action: "Drive", keys: "W / S or Up / Down" },
    { action: "Rotate legs", keys: "A / D or Left / Right" },
    { action: "Aim turret", keys: "Mouse" },
    { action: "Primary fire", keys: "Left click or Space" },
    { action: "Load missile", keys: "Q or F" },
    { action: "Load grenade", keys: "E or G" },
    { action: "Booster", keys: "Left Shift" },
    { action: "Context help", keys: "On-screen HUD" }
  ]
};

export const GRAPHICS_QUALITY_OPTIONS: Array<{
  id: GraphicsQuality;
  label: string;
  description: string;
}> = [
  {
    id: "performance",
    label: "Performance",
    description: "Clamp pixel density and disable antialiasing for slower laptops or integrated GPUs."
  },
  {
    id: "balanced",
    label: "Balanced",
    description: "Default desktop profile with moderate pixel density and stable 60 FPS targets."
  },
  {
    id: "quality",
    label: "Quality",
    description: "Push sharper output on stronger GPUs at a higher rendering cost."
  }
];

export function formatRoomStatus(status: RoomStatus): string {
  switch (status) {
    case "warming":
      return "Warming";
    case "waiting":
      return "Waiting";
    case "active":
      return "Active";
    case "ended":
      return "Ended";
  }
}
