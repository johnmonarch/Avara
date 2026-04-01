import type { AdCampaign, AdPlacementType, LevelBillboardAssignment, LevelScene } from "@avara/shared-types";

export function selectCampaignsForPlacement(
  campaigns: AdCampaign[],
  levelId: string,
  placementType: AdPlacementType,
  nowIso = new Date().toISOString()
): AdCampaign[] {
  return campaigns
    .filter((campaign) => isCampaignActiveForPlacement(campaign, levelId, placementType, nowIso))
    .sort((left, right) => right.priority - left.priority);
}

export function selectBillboardAssignments(
  scene: LevelScene,
  campaigns: AdCampaign[],
  levelId: string,
  nowIso = new Date().toISOString()
): LevelBillboardAssignment[] {
  const placeholders = scene.nodes.filter(
    (node) => node.type === "ad_placeholder" && typeof node.slotId === "string" && node.slotId.length > 0
  );
  const nowSeconds = Math.floor(Date.parse(nowIso) / 1000);

  return placeholders.map((node) => {
    const eligible = campaigns
      .filter((campaign) => isCampaignActiveForPlacement(campaign, levelId, "level_billboard", nowIso))
      .filter((campaign) => campaign.billboardSlotIds.length === 0 || campaign.billboardSlotIds.includes(node.slotId!))
      .sort((left, right) => right.priority - left.priority);

    const topPriority = eligible[0]?.priority ?? null;
    const rotationPool = topPriority === null ? [] : eligible.filter((campaign) => campaign.priority === topPriority);
    const rotationSeconds =
      rotationPool.length > 0
        ? Math.max(5, ...rotationPool.map((campaign) => normalizeRotationSeconds(campaign.rotationSeconds)))
        : 30;
    const selected =
      rotationPool.length > 0
        ? rotationPool[(Math.floor(nowSeconds / rotationSeconds) + hashKey(`${levelId}:${node.slotId}`)) % rotationPool.length]
        : null;

    return {
      nodeId: node.id,
      slotId: node.slotId!,
      campaignId: selected?.id ?? null,
      campaignName: selected?.name ?? null,
      creativeUrl: selected?.creativeUrl ?? null,
      destinationUrl: selected?.destinationUrl ?? null,
      rotationSeconds
    };
  });
}

function isCampaignActiveForPlacement(
  campaign: AdCampaign,
  levelId: string,
  placementType: AdPlacementType,
  nowIso: string
): boolean {
  return (
    campaign.status === "live" &&
    campaign.placementTypes.includes(placementType) &&
    (campaign.targetLevelIds.length === 0 || campaign.targetLevelIds.includes(levelId)) &&
    campaign.startAt <= nowIso &&
    campaign.endAt >= nowIso
  );
}

function normalizeRotationSeconds(value: number): number {
  return Number.isFinite(value) ? Math.max(5, Math.floor(value)) : 30;
}

function hashKey(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}
