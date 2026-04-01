import { useEffect, useState, type FormEvent } from "react";

import type { AdCampaign, DashboardStats, LevelSummary, RoomDetail, UploadValidationResult } from "@avara/shared-types";

import {
  createCampaign,
  fetchCampaigns,
  fetchDashboard,
  fetchLevels,
  fetchRooms,
  updateCampaign,
  validateUploadCandidate
} from "./lib/api";

interface CampaignDraft {
  name: string;
  status: AdCampaign["status"];
  targetLevelId: string;
  slotIds: string;
  creativeUrl: string;
  destinationUrl: string;
  rotationSeconds: string;
  priority: string;
}

export function App() {
  const [dashboard, setDashboard] = useState<DashboardStats | null>(null);
  const [levels, setLevels] = useState<LevelSummary[]>([]);
  const [rooms, setRooms] = useState<RoomDetail[]>([]);
  const [campaigns, setCampaigns] = useState<AdCampaign[]>([]);
  const [validation, setValidation] = useState<UploadValidationResult | null>(null);
  const [campaignDraft, setCampaignDraft] = useState<CampaignDraft>(() => createCampaignDraft());
  const [editingCampaignId, setEditingCampaignId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void loadAdminSurface();

    async function loadAdminSurface() {
      try {
        setBusy(true);
        const [nextDashboard, nextLevels, nextRooms, nextCampaigns] = await Promise.all([
          fetchDashboard(),
          fetchLevels(),
          fetchRooms(),
          fetchCampaigns()
        ]);

        setDashboard(nextDashboard);
        setLevels(nextLevels);
        setRooms(nextRooms);
        setCampaigns(sortCampaigns(nextCampaigns));
        setCampaignDraft((current) =>
          current.targetLevelId || !nextLevels[0]
            ? current
            : {
                ...current,
                targetLevelId: nextLevels[0].id
              }
        );
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Failed to load admin surface");
      } finally {
        setBusy(false);
      }
    }
  }, []);

  async function handleValidateUpload() {
    try {
      setBusy(true);
      setError("");
      const result = await validateUploadCandidate();
      setValidation(result);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to validate upload candidate");
    } finally {
      setBusy(false);
    }
  }

  async function handleCampaignSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    try {
      setBusy(true);
      setError("");

      const payload = {
        name: campaignDraft.name.trim() || "New billboard campaign",
        status: campaignDraft.status,
        placementTypes: ["level_billboard"] as const,
        targetLevelIds: campaignDraft.targetLevelId ? [campaignDraft.targetLevelId] : [],
        billboardSlotIds: parseCommaList(campaignDraft.slotIds),
        creativeUrl: campaignDraft.creativeUrl.trim(),
        destinationUrl: campaignDraft.destinationUrl.trim() || undefined,
        rotationSeconds: Number(campaignDraft.rotationSeconds || "30"),
        priority: Number(campaignDraft.priority || "1")
      };

      const campaign = editingCampaignId
        ? await updateCampaign(editingCampaignId, payload)
        : await createCampaign(payload);

      setCampaigns((current) => sortCampaigns(upsertCampaign(current, campaign)));
      setEditingCampaignId(campaign.id);
      setCampaignDraft(toCampaignDraft(campaign));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to save campaign");
    } finally {
      setBusy(false);
    }
  }

  function handleEditCampaign(campaign: AdCampaign) {
    setEditingCampaignId(campaign.id);
    setCampaignDraft(toCampaignDraft(campaign));
  }

  function handleNewCampaign() {
    setEditingCampaignId("");
    setCampaignDraft(createCampaignDraft(levels[0]?.id ?? ""));
  }

  return (
    <div className="admin-shell">
      <aside className="admin-sidebar">
        <span className="eyebrow">Avara Web Admin</span>
        <h1>Operations, moderation, content, and ad placement.</h1>
        <p>The admin surface stays table-first and high-signal per the PRD.</p>

        <div className="nav-group">
          <button>Dashboard</button>
          <button>Levels</button>
          <button>Ads</button>
          <button>Rooms</button>
          <button>Audit</button>
        </div>
      </aside>

      <main className="admin-main">
        <section className="metric-grid">
          <MetricCard label="Active users" value={dashboard?.activeUsers ?? 0} />
          <MetricCard label="Active rooms" value={dashboard?.activeRooms ?? 0} />
          <MetricCard label="Imported levels" value={dashboard?.importedOfficialLevels ?? 0} />
          <MetricCard label="Live campaigns" value={dashboard?.adCampaignsLive ?? 0} />
        </section>

        <section className="admin-card">
          <div className="section-header">
            <div>
              <span className="eyebrow">Levels</span>
              <h2>Imported official launch catalog</h2>
            </div>
            <button className="action-button" disabled={busy} onClick={handleValidateUpload}>
              Validate sample upload
            </button>
          </div>
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Pack</th>
                <th>Status</th>
                <th>Scene</th>
              </tr>
            </thead>
            <tbody>
              {levels.slice(0, 10).map((level) => (
                <tr key={level.id}>
                  <td>
                    <strong>{level.title}</strong>
                    <div className="muted">{level.message}</div>
                  </td>
                  <td>{level.packTitle}</td>
                  <td>{level.moderationStatus}</td>
                  <td>{level.sceneUrl}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="admin-card two-column">
          <div>
            <div className="section-header">
              <div>
                <span className="eyebrow">Rooms</span>
                <h2>Live room supervision</h2>
              </div>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Room</th>
                  <th>Level</th>
                  <th>Players</th>
                  <th>Worker</th>
                </tr>
              </thead>
              <tbody>
                {rooms.map((room) => (
                  <tr key={room.id}>
                    <td>{room.name}</td>
                    <td>{room.levelTitle}</td>
                    <td>{room.players.length}</td>
                    <td>{room.gameWorkerId}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div>
            <div className="section-header">
              <div>
                <span className="eyebrow">Billboards</span>
                <h2>Campaign rotation server</h2>
              </div>
              <button className="action-button" disabled={busy} onClick={handleNewCampaign}>
                New billboard
              </button>
            </div>

            <form className="campaign-editor" onSubmit={handleCampaignSubmit}>
              <label className="field">
                <span>Name</span>
                <input
                  value={campaignDraft.name}
                  onChange={(event) => setCampaignDraft((current) => ({ ...current, name: event.target.value }))}
                />
              </label>

              <div className="field-grid">
                <label className="field">
                  <span>Status</span>
                  <select
                    value={campaignDraft.status}
                    onChange={(event) =>
                      setCampaignDraft((current) => ({
                        ...current,
                        status: event.target.value as AdCampaign["status"]
                      }))
                    }
                  >
                    <option value="draft">Draft</option>
                    <option value="live">Live</option>
                    <option value="paused">Paused</option>
                    <option value="ended">Ended</option>
                  </select>
                </label>

                <label className="field">
                  <span>Level</span>
                  <select
                    value={campaignDraft.targetLevelId}
                    onChange={(event) =>
                      setCampaignDraft((current) => ({ ...current, targetLevelId: event.target.value }))
                    }
                  >
                    <option value="">All imported levels</option>
                    {levels.slice(0, 24).map((level) => (
                      <option key={level.id} value={level.id}>
                        {level.title}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="field">
                <span>Billboard slot IDs</span>
                <input
                  placeholder="bwadi-north, bwadi-south"
                  value={campaignDraft.slotIds}
                  onChange={(event) => setCampaignDraft((current) => ({ ...current, slotIds: event.target.value }))}
                />
              </label>

              <label className="field">
                <span>Creative URL</span>
                <input
                  placeholder="https://cdn.example.com/ad.png or data:image/svg+xml,..."
                  value={campaignDraft.creativeUrl}
                  onChange={(event) =>
                    setCampaignDraft((current) => ({ ...current, creativeUrl: event.target.value }))
                  }
                />
              </label>

              <label className="field">
                <span>Destination URL</span>
                <input
                  placeholder="https://example.com/clickthrough"
                  value={campaignDraft.destinationUrl}
                  onChange={(event) =>
                    setCampaignDraft((current) => ({ ...current, destinationUrl: event.target.value }))
                  }
                />
              </label>

              <div className="field-grid">
                <label className="field">
                  <span>Rotate every seconds</span>
                  <input
                    type="number"
                    min="5"
                    step="1"
                    value={campaignDraft.rotationSeconds}
                    onChange={(event) =>
                      setCampaignDraft((current) => ({ ...current, rotationSeconds: event.target.value }))
                    }
                  />
                </label>

                <label className="field">
                  <span>Priority</span>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={campaignDraft.priority}
                    onChange={(event) => setCampaignDraft((current) => ({ ...current, priority: event.target.value }))}
                  />
                </label>
              </div>

              <div className="editor-actions">
                <button className="action-button" type="submit" disabled={busy}>
                  {busy ? "Saving…" : editingCampaignId ? "Update billboard campaign" : "Create billboard campaign"}
                </button>
                <span className="muted">
                  Level placeholders own the slot IDs. Campaigns only target those placeholders and rotation cadence.
                </span>
              </div>
            </form>

            <div className="campaign-list">
              {campaigns.map((campaign) => (
                <button
                  key={campaign.id}
                  className={campaign.id === editingCampaignId ? "campaign-card campaign-card-active" : "campaign-card"}
                  onClick={() => handleEditCampaign(campaign)}
                >
                  <strong>{campaign.name}</strong>
                  <span>
                    {campaign.status} • P{campaign.priority} • {campaign.rotationSeconds}s rotation
                  </span>
                  <small>{campaign.targetLevelIds[0] ?? "all imported levels"}</small>
                  <small>{campaign.billboardSlotIds.join(", ") || "all billboard slots"}</small>
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="admin-card">
          <div className="section-header">
            <div>
              <span className="eyebrow">Validation</span>
              <h2>Upload pipeline result</h2>
            </div>
          </div>
          {validation ? (
            <div className={validation.ok ? "validation-good" : "validation-bad"}>
              <strong>{validation.ok ? "Candidate accepted" : "Candidate rejected"}</strong>
              <ul>
                {validation.issues.map((issue) => (
                  <li key={`${issue.path}-${issue.message}`}>
                    <strong>{issue.severity}</strong> {issue.path}: {issue.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="muted">Run the sample validator to exercise the level-upload rules from the PRD.</p>
          )}
          {error ? <p className="error-text">{error}</p> : null}
        </section>
      </main>
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: number }) {
  return (
    <article className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function createCampaignDraft(levelId = ""): CampaignDraft {
  return {
    name: "",
    status: "draft",
    targetLevelId: levelId,
    slotIds: "",
    creativeUrl: "",
    destinationUrl: "",
    rotationSeconds: "30",
    priority: "1"
  };
}

function toCampaignDraft(campaign: AdCampaign): CampaignDraft {
  return {
    name: campaign.name,
    status: campaign.status,
    targetLevelId: campaign.targetLevelIds[0] ?? "",
    slotIds: campaign.billboardSlotIds.join(", "),
    creativeUrl: campaign.creativeUrl,
    destinationUrl: campaign.destinationUrl ?? "",
    rotationSeconds: String(campaign.rotationSeconds),
    priority: String(campaign.priority)
  };
}

function parseCommaList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function upsertCampaign(current: AdCampaign[], nextCampaign: AdCampaign): AdCampaign[] {
  const existingIndex = current.findIndex((campaign) => campaign.id === nextCampaign.id);
  if (existingIndex === -1) {
    return [nextCampaign, ...current];
  }

  const nextCampaigns = current.slice();
  nextCampaigns[existingIndex] = nextCampaign;
  return nextCampaigns;
}

function sortCampaigns(campaigns: AdCampaign[]): AdCampaign[] {
  return campaigns
    .slice()
    .sort((left, right) => right.priority - left.priority || left.name.localeCompare(right.name));
}
