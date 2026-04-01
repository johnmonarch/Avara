import type { ControlPreset, RoomStatus } from "@avara/shared-types";

export const CONTROL_PRESETS: ControlPreset[] = [
  {
    id: "classic",
    label: "Classic",
    description: "Leg rotation on A/D, pointer lock head aim, original-feel bindings."
  },
  {
    id: "modernized",
    label: "Modernized",
    description: "Pointer-lock onboarding, stronger HUD guidance, lower learning friction."
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
