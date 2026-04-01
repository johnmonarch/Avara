import { useEffect, useState, type FormEvent } from "react";

import type {
  AdCampaign,
  AdCampaignReport,
  AuditEvent,
  DashboardStats,
  LevelPackageSummary,
  LevelSummary,
  ModerationStatus,
  OpsSnapshot,
  RoomDetail,
  UploadJob,
  UploadValidationResult
} from "@avara/shared-types";

import {
  createCampaign,
  fetchAdReports,
  fetchAuditEvents,
  fetchCampaigns,
  fetchDashboard,
  fetchLevels,
  fetchOps,
  fetchPackages,
  fetchRooms,
  fetchUploadJobs,
  updateCampaign,
  updateLevelModeration,
  uploadLevelPackage
} from "./lib/api";

interface CampaignDraft {
  name: string;
  status: AdCampaign["status"];
  placementTypes: AdCampaign["placementTypes"];
  targetLevelId: string;
  slotIds: string;
  creativeUrl: string;
  destinationUrl: string;
  rotationSeconds: string;
  priority: string;
  frequencyCapPerSession: string;
}

interface UploadResult {
  job: UploadJob;
  validation: UploadValidationResult;
  package: LevelPackageSummary | null;
  levels: LevelSummary[];
}

const moderationStates: ModerationStatus[] = [
  "draft",
  "private_test",
  "submitted",
  "approved",
  "rejected",
  "archived",
  "official"
];

export function App() {
  const [dashboard, setDashboard] = useState<DashboardStats | null>(null);
  const [ops, setOps] = useState<OpsSnapshot | null>(null);
  const [levels, setLevels] = useState<LevelSummary[]>([]);
  const [packages, setPackages] = useState<LevelPackageSummary[]>([]);
  const [rooms, setRooms] = useState<RoomDetail[]>([]);
  const [campaigns, setCampaigns] = useState<AdCampaign[]>([]);
  const [reports, setReports] = useState<AdCampaignReport[]>([]);
  const [uploads, setUploads] = useState<UploadJob[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [latestUpload, setLatestUpload] = useState<UploadResult | null>(null);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadState, setUploadState] = useState<ModerationStatus>("private_test");
  const [campaignDraft, setCampaignDraft] = useState<CampaignDraft>(() => createCampaignDraft());
  const [editingCampaignId, setEditingCampaignId] = useState("");
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [savingCampaign, setSavingCampaign] = useState(false);
  const [moderatingLevelId, setModeratingLevelId] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    void loadAdminSurface();
  }, []);

  async function loadAdminSurface() {
    try {
      setLoading(true);
      setError("");
      const [nextDashboard, nextOps, nextLevels, nextPackages, nextRooms, nextCampaigns, nextReports, nextUploads, nextAuditEvents] =
        await Promise.all([
          fetchDashboard(),
          fetchOps(),
          fetchLevels(),
          fetchPackages(),
          fetchRooms(),
          fetchCampaigns(),
          fetchAdReports(),
          fetchUploadJobs(),
          fetchAuditEvents()
        ]);

      setDashboard(nextDashboard);
      setOps(nextOps);
      setLevels(nextLevels);
      setPackages(nextPackages);
      setRooms(nextRooms);
      setCampaigns(sortCampaigns(nextCampaigns));
      setReports(nextReports);
      setUploads(nextUploads);
      setAuditEvents(nextAuditEvents);
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
      setLoading(false);
    }
  }

  async function handleUploadSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!uploadFile) {
      setError("Choose a zip package to upload first");
      return;
    }

    try {
      setUploading(true);
      setError("");
      const result = await uploadLevelPackage(uploadFile, uploadState);
      setLatestUpload(result);
      await loadAdminSurface();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to upload level package");
    } finally {
      setUploading(false);
    }
  }

  async function handleModerationChange(levelId: string, moderationStatus: ModerationStatus) {
    try {
      setModeratingLevelId(levelId);
      setError("");
      const nextLevel = await updateLevelModeration(levelId, moderationStatus);
      setLevels((current) => current.map((level) => (level.id === nextLevel.id ? nextLevel : level)));
      await loadAdminSurface();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to update moderation state");
    } finally {
      setModeratingLevelId("");
    }
  }

  async function handleCampaignSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    try {
      setSavingCampaign(true);
      setError("");

      const payload = {
        name: campaignDraft.name.trim() || "New billboard campaign",
        status: campaignDraft.status,
        placementTypes: campaignDraft.placementTypes,
        targetLevelIds: campaignDraft.targetLevelId ? [campaignDraft.targetLevelId] : [],
        billboardSlotIds: parseCommaList(campaignDraft.slotIds),
        creativeUrl: campaignDraft.creativeUrl.trim(),
        destinationUrl: campaignDraft.destinationUrl.trim() || undefined,
        rotationSeconds: Number(campaignDraft.rotationSeconds || "30"),
        priority: Number(campaignDraft.priority || "1"),
        frequencyCapPerSession: Number(campaignDraft.frequencyCapPerSession || "3")
      };

      const campaign = editingCampaignId
        ? await updateCampaign(editingCampaignId, payload)
        : await createCampaign(payload);

      setCampaigns((current) => sortCampaigns(upsertCampaign(current, campaign)));
      setEditingCampaignId(campaign.id);
      setCampaignDraft(toCampaignDraft(campaign));
      await loadAdminSurface();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to save campaign");
    } finally {
      setSavingCampaign(false);
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
        <h1>Phase 4 campaign reporting, rate limiting, and service visibility.</h1>
        <p>The content pipeline remains intact, and the ad layer now exposes placement targeting, metrics, and ops health.</p>

        <div className="nav-group">
          <button>Dashboard</button>
          <button>Uploads</button>
          <button>Levels</button>
          <button>Ads</button>
          <button>Ops</button>
          <button>Audit</button>
        </div>
      </aside>

      <main className="admin-main">
        <section className="metric-grid">
          <MetricCard label="Active users" value={dashboard?.activeUsers ?? 0} />
          <MetricCard label="Active rooms" value={dashboard?.activeRooms ?? 0} />
          <MetricCard label="Official levels" value={dashboard?.importedOfficialLevels ?? 0} />
          <MetricCard label="Pending review" value={dashboard?.uploadsPendingReview ?? 0} />
          <MetricCard label="Live campaigns" value={dashboard?.adCampaignsLive ?? 0} />
          <MetricCard label="Impressions" value={dashboard?.totalAdImpressions ?? 0} />
          <MetricCard label="Clicks" value={dashboard?.totalAdClicks ?? 0} />
        </section>

        <section className="admin-card two-column">
          <div>
            <div className="section-header">
              <div>
                <span className="eyebrow">Ops</span>
                <h2>Build and service health</h2>
              </div>
              <span className="muted">{dashboard?.buildVersion ?? "unknown build"}</span>
            </div>
            <div className="campaign-list">
              {(ops?.serviceHealth ?? []).map((service) => (
                <article key={service.service} className="campaign-card">
                  <strong>{service.service}</strong>
                  <span>
                    {service.status} • {service.buildVersion}
                  </span>
                  <small>
                    uptime {service.uptimeSeconds ?? 0}s • {Object.keys(service.detail).length} health fields
                  </small>
                </article>
              ))}
            </div>
          </div>

          <div>
            <div className="section-header">
              <div>
                <span className="eyebrow">Rate limits</span>
                <h2>Abuse controls</h2>
              </div>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Bucket</th>
                  <th>Limit</th>
                  <th>Hits</th>
                  <th>Blocked</th>
                </tr>
              </thead>
              <tbody>
                {(ops?.rateLimits ?? []).map((entry) => (
                  <tr key={entry.bucket}>
                    <td>{entry.bucket}</td>
                    <td>
                      {entry.limit} / {Math.round(entry.windowMs / 1000)}s
                    </td>
                    <td>{entry.hits}</td>
                    <td>{entry.blocked}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted">
              Backup root: <code>{ops?.backupRoot ?? "n/a"}</code> • tracked archives: {ops?.uploadArchiveCount ?? 0}
            </p>
          </div>
        </section>

        <section className="admin-card upload-card">
          <div className="section-header">
            <div>
              <span className="eyebrow">Uploads</span>
              <h2>Level package intake</h2>
            </div>
            <span className="muted">{dashboard?.uploadQueueHealthy ? "Queue healthy" : "Queue degraded"}</span>
          </div>

          <form className="upload-form" onSubmit={handleUploadSubmit}>
            <label className="field">
              <span>Package zip</span>
              <input
                type="file"
                accept=".zip,application/zip"
                onChange={(event) => setUploadFile(event.target.files?.[0] ?? null)}
              />
            </label>

            <label className="field">
              <span>Initial moderation state</span>
              <select value={uploadState} onChange={(event) => setUploadState(event.target.value as ModerationStatus)}>
                <option value="private_test">Private test</option>
                <option value="submitted">Submitted for review</option>
                <option value="approved">Approved</option>
                <option value="official">Official</option>
              </select>
            </label>

            <div className="editor-actions">
              <button className="action-button" type="submit" disabled={uploading || !uploadFile}>
                {uploading ? "Uploading…" : "Upload level package"}
              </button>
              <span className="muted">
                Expected structure: <code>manifest.json</code>, <code>set.json</code>, <code>alf/</code>, optional{" "}
                <code>audio/</code> and <code>preview/</code>.
              </span>
            </div>
          </form>

          <div className="upload-summary-grid">
            <article className="summary-tile">
              <span className="muted">Selected file</span>
              <strong>{uploadFile?.name ?? "No file selected"}</strong>
              <small>{uploadFile ? `${Math.round(uploadFile.size / 1024)} KB` : "Waiting for a package zip"}</small>
            </article>
            <article className="summary-tile">
              <span className="muted">Latest upload job</span>
              <strong>{latestUpload?.job.id ?? uploads[0]?.id ?? "No uploads yet"}</strong>
              <small>{latestUpload?.job.status ?? uploads[0]?.status ?? "Idle"}</small>
            </article>
            <article className="summary-tile">
              <span className="muted">Latest package</span>
              <strong>{latestUpload?.package?.title ?? packages[0]?.title ?? "None"}</strong>
              <small>{latestUpload?.package?.moderationStatus ?? packages[0]?.moderationStatus ?? "No package"}</small>
            </article>
          </div>
        </section>

        <section className="admin-card">
          <div className="section-header">
            <div>
              <span className="eyebrow">Levels</span>
              <h2>Official and community catalog</h2>
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Pack</th>
                <th>Source</th>
                <th>Playability</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {levels.slice(0, 20).map((level) => (
                <tr key={level.id}>
                  <td>
                    <strong>{level.title}</strong>
                    <div className="muted">{level.message || "No description"}</div>
                  </td>
                  <td>
                    <div>{level.packTitle}</div>
                    <small className="muted">{level.packageId ?? "repo-import"}</small>
                  </td>
                  <td>
                    <div>{level.source}</div>
                    <small className="muted">{level.creatorName ?? "Unknown uploader"}</small>
                  </td>
                  <td>
                    <div>{level.publicPlayable ? "Public + private" : level.privatePlayable ? "Private only" : "Hidden"}</div>
                    <small className="muted">{level.uploadedAt ? formatTimestamp(level.uploadedAt) : "Legacy"}</small>
                  </td>
                  <td>
                    <select
                      value={level.moderationStatus}
                      disabled={moderatingLevelId === level.id || level.source === "official_repo"}
                      onChange={(event) => handleModerationChange(level.id, event.target.value as ModerationStatus)}
                    >
                      {moderationStates.map((state) => (
                        <option key={state} value={state}>
                          {state}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="admin-card two-column">
          <div>
            <div className="section-header">
              <div>
                <span className="eyebrow">Packages</span>
                <h2>Package registry</h2>
              </div>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Package</th>
                  <th>Source</th>
                  <th>Status</th>
                  <th>Levels</th>
                </tr>
              </thead>
              <tbody>
                {packages.slice(0, 10).map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      <strong>{entry.title}</strong>
                      <div className="muted">{entry.version}</div>
                    </td>
                    <td>{entry.source}</td>
                    <td>{entry.moderationStatus}</td>
                    <td>
                      <div>{entry.levelIds.length}</div>
                      <small className="muted">{formatTimestamp(entry.uploadedAt)}</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div>
            <div className="section-header">
              <div>
                <span className="eyebrow">Validation</span>
                <h2>Latest upload result</h2>
              </div>
            </div>
            {latestUpload ? (
              <div className={latestUpload.validation.ok ? "validation-good" : "validation-bad"}>
                <strong>{latestUpload.validation.ok ? "Package accepted" : "Package rejected"}</strong>
                <p className="muted">
                  {latestUpload.validation.fileCount ?? 0} files, {Math.round((latestUpload.validation.totalBytes ?? 0) / 1024)} KB,{" "}
                  {latestUpload.validation.archiveChecksum?.slice(0, 12) ?? "no checksum"}
                </p>
                <ul>
                  {latestUpload.validation.issues.length ? (
                    latestUpload.validation.issues.map((issue) => (
                      <li key={`${issue.path}-${issue.message}`}>
                        <strong>{issue.severity}</strong> {issue.path}: {issue.message}
                      </li>
                    ))
                  ) : (
                    <li>No validation issues.</li>
                  )}
                </ul>
              </div>
            ) : (
              <p className="muted">Upload a zip package to populate the validation and extraction result panel.</p>
            )}
          </div>
        </section>

        <section className="admin-card two-column">
          <div>
            <div className="section-header">
              <div>
                <span className="eyebrow">Uploads</span>
                <h2>Upload jobs</h2>
              </div>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Job</th>
                  <th>File</th>
                  <th>Status</th>
                  <th>Levels</th>
                </tr>
              </thead>
              <tbody>
                {uploads.slice(0, 10).map((upload) => (
                  <tr key={upload.id}>
                    <td>
                      <strong>{upload.id}</strong>
                      <div className="muted">{formatTimestamp(upload.createdAt)}</div>
                    </td>
                    <td>{upload.fileName}</td>
                    <td>{upload.status}</td>
                    <td>
                      <div>{upload.levelIds.length}</div>
                      <small className="muted">{upload.extractedPackSlug ?? "not extracted"}</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div>
            <div className="section-header">
              <div>
                <span className="eyebrow">Ads</span>
                <h2>Campaign assignment</h2>
              </div>
              <button className="action-button" disabled={savingCampaign} onClick={handleNewCampaign}>
                New campaign
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

              <div className="field">
                <span>Placements</span>
                <div className="toggle-grid">
                  {[
                    ["lobby_banner", "Lobby"],
                    ["level_loading", "Loading"],
                    ["results_banner", "Results"],
                    ["level_billboard", "Billboard"]
                  ].map(([placement, label]) => (
                    <label key={placement} className="toggle-chip">
                      <input
                        type="checkbox"
                        checked={campaignDraft.placementTypes.includes(placement as AdCampaign["placementTypes"][number])}
                        onChange={(event) =>
                          setCampaignDraft((current) => ({
                            ...current,
                            placementTypes: event.target.checked
                              ? [...current.placementTypes, placement as AdCampaign["placementTypes"][number]]
                              : current.placementTypes.filter((entry) => entry !== placement)
                          }))
                        }
                      />
                      <span>{label}</span>
                    </label>
                  ))}
                </div>
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

                <label className="field">
                  <span>Session cap</span>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={campaignDraft.frequencyCapPerSession}
                    onChange={(event) =>
                      setCampaignDraft((current) => ({ ...current, frequencyCapPerSession: event.target.value }))
                    }
                  />
                </label>
              </div>

              <div className="editor-actions">
                <button className="action-button" type="submit" disabled={savingCampaign}>
                  {savingCampaign ? "Saving…" : editingCampaignId ? "Update campaign" : "Create campaign"}
                </button>
                <span className="muted">
                  Placements can span lobby, loading, results, and level-owned billboard slots with per-session caps.
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
                    {campaign.status} • P{campaign.priority} • {campaign.rotationSeconds}s rotation • cap {campaign.frequencyCapPerSession}
                  </span>
                  <small>{campaign.placementTypes.join(", ")}</small>
                  <small>{campaign.billboardSlotIds.join(", ") || "all billboard slots"}</small>
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="admin-card">
          <div className="section-header">
            <div>
              <span className="eyebrow">Reporting</span>
              <h2>Campaign performance</h2>
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th>Campaign</th>
                <th>Impressions</th>
                <th>Clicks</th>
                <th>CTR</th>
                <th>Last event</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((report) => (
                <tr key={report.campaignId}>
                  <td>
                    <strong>{report.campaignName}</strong>
                    <div className="muted">{report.status}</div>
                  </td>
                  <td>{report.totalImpressions}</td>
                  <td>{report.totalClicks}</td>
                  <td>{(report.ctr * 100).toFixed(1)}%</td>
                  <td>{report.lastEventAt ? formatTimestamp(report.lastEventAt) : "No events yet"}</td>
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
                <span className="eyebrow">Audit</span>
                <h2>Recent admin events</h2>
              </div>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Target</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {auditEvents.slice(0, 10).map((event) => (
                  <tr key={event.id}>
                    <td>
                      <strong>{event.action}</strong>
                      <div className="muted">{event.actorDisplayName}</div>
                    </td>
                    <td>
                      <div>{event.targetType}</div>
                      <small className="muted">{event.targetId}</small>
                    </td>
                    <td>{formatTimestamp(event.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {error ? <p className="error-text">{error}</p> : null}
        {loading ? <p className="muted">Refreshing admin surface…</p> : null}
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
    placementTypes: ["level_billboard"],
    targetLevelId: levelId,
    slotIds: "",
    creativeUrl: "",
    destinationUrl: "",
    rotationSeconds: "30",
    priority: "1",
    frequencyCapPerSession: "3"
  };
}

function toCampaignDraft(campaign: AdCampaign): CampaignDraft {
  return {
    name: campaign.name,
    status: campaign.status,
    placementTypes: campaign.placementTypes,
    targetLevelId: campaign.targetLevelIds[0] ?? "",
    slotIds: campaign.billboardSlotIds.join(", "),
    creativeUrl: campaign.creativeUrl,
    destinationUrl: campaign.destinationUrl ?? "",
    rotationSeconds: String(campaign.rotationSeconds),
    priority: String(campaign.priority),
    frequencyCapPerSession: String(campaign.frequencyCapPerSession)
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

function formatTimestamp(value: string): string {
  return new Date(value).toLocaleString();
}
