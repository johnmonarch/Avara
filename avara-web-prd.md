# PRD: Avara Web

## Document status

- **Product:** Avara Web
- **Type:** Product Requirements Document
- **Codebase reference:** `johnmonarch/Avara`
- **Primary goal:** Convert the current desktop/open source Avara codebase into a browser-playable multiplayer web game with centralized hosting, modern web UX, user-created games on a shared server, level upload tooling, and admin-controlled ad placement.

## 1. Executive summary

Avara Web is a browser-first remake/port of Avara that preserves the game's identity, mech feel, custom levels, and multiplayer depth while replacing desktop-native rendering, peer-hosted networking, and tracker-based discovery with a centralized web platform.

The product should let a player:

1. Open a URL
2. Sign in or play as guest
3. Join or create a room instantly
4. Play in-browser with sensible mouse and keyboard controls
5. Use existing and newly uploaded Avara levels
6. Create new public or private games on the same centrally hosted server

The product should let an admin:

1. Deploy the whole stack on Coolify via Docker Compose
2. Manage rooms, levels, users, ads, and server health from an admin panel
3. Upload new levels and approve or reject user-submitted levels
4. Assign ad campaigns to specific levels, packs, or placements

## 2. Product vision

Build the definitive modern home for Avara online:

- zero port forwarding
- zero tracker dependency for players
- one-click room creation
- faithful gameplay feel
- browser-native onboarding
- centralized operations and moderation
- long-term support for level creators and community-hosted content inside your infrastructure

## 3. Problem statement

The current Avara port is already modernized for desktop platforms, but it still inherits several constraints that are a poor fit for broad web adoption:

- desktop-native client requirements
- P2P-oriented networking assumptions
- manual server discovery/tracker flow
- router/port-forwarding friction
- hosting complexity for casual players
- no web-native account, room, or admin experience
- no centralized content pipeline for level publishing and moderation
- no ad management layer for specific levels or placements

These constraints raise friction for new players and make the ecosystem harder to grow, moderate, monetize, and operate.

## 4. Goals

### 4.1 Business and platform goals

- Make Avara instantly playable from a browser on desktop-class devices.
- Replace player-hosted networking with centralized, authoritative game hosting.
- Allow users to create rooms/games on the same shared server without needing to self-host.
- Add an admin panel for level management, ad targeting, moderation, and operations.
- Make deployment straightforward on Coolify using Docker Compose.
- Preserve the community value of custom levels and level packs.

### 4.2 Product goals

- Preserve the feel of classic Avara movement, aiming, weapons, and room-based multiplayer.
- Support legacy content import from the modern Avara repo as the starting content base.
- Support user-uploaded level packages through a safe, validated workflow.
- Provide a web UI for browsing rooms, creating games, selecting levels, chatting, and spectating.
- Make controls understandable for new players without ruining the original mech-style control identity.

### 4.3 Technical goals

- Achieve stable, low-latency multiplayer with a server-authoritative simulation.
- Hit a 60 FPS render target on supported desktop browsers for representative levels.
- Keep the runtime horizontally scalable enough to support many concurrent rooms.
- Share as much gameplay logic as practical between browser client and server.
- Use a 3D stack that is proven in browsers and friendly to the repo's already-modernized asset pipeline.

## 5. Non-goals for MVP

- Native mobile gameplay as a first-class input target
- Rebuilding every desktop-only utility before launch
- Full parity with every obscure legacy behavior on day one
- Open federation with third-party self-hosted servers
- User-generated scripting with unrestricted code execution
- In-browser level authoring beyond upload, validation, preview, and metadata editing
- Advanced esports features such as ranked ladders, anti-cheat at kernel level, or tournament ops

## 6. Current-state audit of the repo

The PRD should treat the current repo as a valuable source of game logic, content, and format knowledge, not as a UI or networking architecture that can simply be wrapped for the web.

### 6.1 Useful assets and technical foundations already present

- The current port already modernizes the original game for Windows, macOS, and Linux.
- The codebase is split into meaningful domains such as `net`, `gui`, `level`, `render`, `audio`, and `game`.
- The repo already contains a browser-side `editor` directory with AvaraScript parsing and Three.js-based tooling.
- The repo includes a large library of existing level packs.
- Level packaging already has recognizable modernized pieces such as `set.json`, ALF files, and OGG assets.
- The porting notes indicate that legacy shape data was triangulated into JSON and that the newer ALF format stores level data in XML.

### 6.2 Current limitations that the web product should remove

- Current online play still relies on a tracker/listing model.
- Current networking still expects direct connectivity behavior that is browser-hostile.
- Current docs require forwarding port `19567`, even for clients, because of the P2P architecture.
- Current docs also note a one-player-per-internet-connection limitation for the same external server, another sign that the architecture should not be retained for the web product.

## 7. Product strategy and recommended approach

## Recommendation

Do **not** try to ship Avara Web by embedding the current desktop app in the browser with only thin wrappers.

Instead:

1. **Extract and preserve the gameplay core** where practical
2. **Replace rendering with a browser-native renderer**
3. **Replace P2P networking with an authoritative centralized game server**
4. **Replace the desktop GUI/tracker/server windows with a web app and admin app**

### 7.1 Recommended architecture decision

**Recommended stack:**

- **Gameplay shell / UI:** React + TypeScript
- **3D gameplay renderer:** raw Three.js
- **Shared simulation/core:** extracted C++ gameplay core compiled to WebAssembly for client prediction/reuse where feasible, and native Linux build for authoritative server where feasible
- **Realtime protocol:** binary WebSocket protocol for MVP
- **Backend API:** Go or TypeScript service for auth, rooms, content, admin, ads, and metadata
- **Persistence:** PostgreSQL
- **Ephemeral state / queues / pubsub:** Redis
- **Asset storage:** S3-compatible object storage (MinIO in self-hosted mode is fine)
- **Deployment:** Docker Compose on Coolify

### 7.2 Why this is the right path

- **Three.js is the best fit** because the repo already contains browser-side Three.js tooling and the porting work already converted complex geometry into web-friendly triangulated JSON. This lowers risk versus choosing a new engine with no continuity.
- **Raw Three.js is preferred over React Three Fiber for gameplay** because the game loop, prediction, interpolation, and render-path control should stay explicit.
- **A shared core is preferred over a full clean-room rewrite** because gameplay fidelity matters, and the existing repo has already done hard work on assets, formats, and cross-platform logic.
- **Authoritative centralized hosting is required** because browser clients cannot rely on the current direct-connect assumptions, and centralized hosting also solves moderation, room creation, analytics, and ads cleanly.

## 8. Core user stories

### 8.1 Player

- As a player, I can open the game in a browser and get into a room quickly.
- As a player, I can browse public games and create a private or public room.
- As a player, I can invite friends with a direct link.
- As a player, I can rebind controls and adjust sensitivity.
- As a player, I can chat in lobby and in game.
- As a player, I can browse official and community-approved levels.

### 8.2 Room creator

- As a room creator, I can create a match on the shared server without self-hosting.
- As a room creator, I can choose level, privacy, max players, rotation, and room rules within allowed limits.
- As a room creator, I can restart, rotate level, or end the room.

### 8.3 Level creator

- As a creator, I can upload a level package for private testing.
- As a creator, I can see validation results before publishing.
- As a creator, I can submit a level for approval or keep it unlisted.

### 8.4 Platform admin

- As admin, I can upload and manage official levels.
- As admin, I can approve, reject, archive, and feature user levels.
- As admin, I can create ad campaigns and target them to specific levels or placements.
- As admin, I can view server health, room counts, upload failures, and moderation queues.

## 9. Functional requirements

## 9.1 Authentication and identity

### MVP

- Support guest play with a generated temporary identity.
- Support optional registered accounts via email magic link or OAuth.
- Store display name, settings, progression flags, created rooms, uploaded levels, and moderation status.

### Requirements

- Guest users may create/join rooms, but may have stricter upload and moderation limits.
- Registered users can upload levels, save settings, and retain creator identity.
- Admin roles must be role-based: `super_admin`, `content_admin`, `moderator`, `ops_viewer`.

## 9.2 Lobby, room browser, and game creation

### MVP

- Public room list
- Private rooms via invite code/link
- Create room modal
- Room detail screen
- Join, leave, kick, transfer host, and start controls

### Requirements

- Every room runs on the centralized infrastructure.
- No player needs to expose a router port or host a process locally.
- Room creation must be fast, ideally under 5 seconds from click to ready state.
- Users can create multiple rooms on the same overall platform, subject to quotas and capacity.

### Room settings

- Level / level rotation
- Visibility: public, private, unlisted
- Player cap: default to the current Avara-equivalent size once confirmed during implementation; admin-configurable hard cap
- Spectators on/off
- Friendly fire on/off
- Time limit
- Bots or AI, only if supported later

## 9.3 Gameplay controls and browser UX

### Mandatory control principles

- Preserve the distinct Avara mech feel, especially independent leg and head control.
- Support pointer lock for aiming.
- Make all primary controls rebindable.
- Ship at least two preset layouts: `Classic` and `Modernized`.

### Classic preset

Should stay very close to documented defaults:

- `W/S`: forward/back
- `A/D`: rotate legs left/right
- mouse: rotate head/aim
- left click: fire primary
- `Q`: missile load/ready behavior
- `E`: grenades
- `Left Shift`: booster
- `Space`: crouch/jump
- `Tab`: scout camera
- `Enter`: chat

### Modernized preset

Should preserve the mech concept but reduce learning friction:

- pointer-lock onboarding overlay
- visible reticle and leg-direction indicator
- contextual help on first play
- optional weapon HUD prompts
- optional quick weapon selection UX

### Additional requirements

- Sensitivity slider
- Invert Y toggle
- Rebindable keys/buttons
- Gamepad support after MVP
- Mobile/touch play is not required for MVP, but the site should still support lobby browsing on mobile

## 9.4 Multiplayer networking

### Design decision

Use a **centralized authoritative server model**.

### Why

- Browsers are a poor fit for the repo's current direct-connect assumptions.
- Central authority improves fairness, moderation, observability, and room creation.
- It removes NAT and port-forwarding friction.

### MVP networking requirements

- Binary WebSocket transport
- Authoritative simulation on server
- Client-side prediction for local input where feasible
- Reconciliation for player state
- Snapshot interpolation for remote actors
- Graceful reconnect flow for short disconnects

### Performance targets

- Target render: 60 FPS on supported desktop hardware
- Target server tick: 20 to 30 Hz authoritative simulation for MVP, to be validated in prototype
- Target join latency: under 10 seconds from room click to spawn on a warmed server

### Anti-abuse and fairness

- Client is never source of truth for damage, ammo, movement legality, or room state.
- Server validates loadouts, input rate, weapon timing, and level compatibility.
- Rate-limit joins, chat spam, and room creation.

## 9.5 Level system and content pipeline

### Content model

A level package should become a first-class entity with:

- metadata
- version
- creator
- preview image
- supported player counts
- pack/category tags
- moderation status
- level files
- audio assets
- optional ad-slot metadata

### Upload workflow

#### MVP package format

Support a zip upload with a normalized structure such as:

```text
level-package.zip
  manifest.json
  set.json
  /alf/*.alf
  /audio/*.ogg
  /preview/*.png
```

### Validation rules

- file size limit
- per-asset size limit
- allowed extensions only
- XML/ALF validation
- `set.json` validation
- object count / geometry / asset count limits
- banned content scanning hooks
- checksum generation
- package version compatibility check

### Publishing states

- Draft
- Private test
- Submitted for review
- Approved
- Rejected
- Archived
- Official

### Legacy compatibility requirements

- Official launch content should begin with imported existing Avara levels from the repo.
- A conversion pipeline should exist for old content where needed.
- The system should support repackaging legacy assets into the normalized web package format.

## 9.6 Ads and level-targeted placements

### Goal

Allow admin-controlled ads without making the game feel cheap or intrusive.

### MVP ad surfaces

- Lobby banner / card placement
- Level loading screen placement
- Post-match results placement
- Optional in-level billboard placement, but only where a level explicitly defines safe ad surfaces

### Rules

- No forced mid-match popups
- No audio autoplay ads
- No UI-blocking interstitials during active combat
- In-level ads only on admin-approved surfaces
- Ads must be assignable to specific levels, packs, or placement types
- Ads must have start/end dates and priority/weight

### Admin ad requirements

- Upload image creative
- Optional short muted video creative later
- Assign campaign to one or more levels
- Assign campaign to placement types
- Track impressions and clicks where relevant
- Frequency caps per session if needed
- House ads / fallback creative support

### Legacy level support note

Many existing levels will not contain explicit ad surfaces. For those, use loading, lobby, and results placements only. In-level ads should require explicit slot definitions or approved overlay behavior.

## 9.7 Admin panel

### Modules

- Dashboard
- Users
- Rooms
- Levels
- Ads
- Moderation queue
- System health
- Audit log
- Settings

### Required capabilities

#### Dashboard

- active users
- active rooms
- match starts per hour
- upload queue health
- ad campaign status
- server health summary

#### Levels

- upload package
- validate package
- preview metadata
- approve/reject/archive
- mark official/featured
- enable/disable for matchmaking

#### Ads

- create campaign
- upload creatives
- choose levels or packs
- choose placements
- start/end dates
- pause/resume
- reporting

#### Rooms

- view all live rooms
- inspect players and level
- terminate room
- lock room
- message room or users later if needed

#### Users and moderation

- suspend user
- hide level
- restrict uploads
- review reports
- inspect audit trail

## 9.8 Match persistence and analytics

### MVP

Store:

- match id
- room id
- level id
- players joined
- start/end time
- result summary
- version/build
- ad impressions by placement

### Later

- replay metadata
- kill feed history
- heatmaps
- creator analytics
- retention funnels

## 10. Technical architecture

## 10.1 High-level services

```text
[ Browser Client ]
      |
      | HTTPS / WebSocket
      v
[ Web/API Service ] ---- [ PostgreSQL ]
      |                 \
      |                  ---- [ Redis ]
      |
      +---- [ Matchmaker / Room Service ]
      |
      +---- [ Game Server Workers ]
      |
      +---- [ Asset/Content Service ] ---- [ S3/MinIO ]
      |
      +---- [ Admin Panel ]
```

## 10.2 Service responsibilities

### Browser client

- menu UI
- account UI
- room browser
- gameplay renderer
- input capture
- prediction/interpolation
- chat UI
- settings UI

### Web/API service

- auth
- profile/settings
- room metadata
- level metadata
- ad campaign metadata
- moderation APIs
- admin APIs

### Matchmaker / room service

- create room
- assign room to game worker
- allocate capacity
- reconnect routing
- room lifecycle state

### Game server worker

- authoritative simulation
- spawn/despawn
- physics/game rules
- damage/ammo/state truth
- chat relay if desired
- match end state

### Asset/content service

- package upload
- virus/malware scanning hooks
- metadata extraction
- validation
- preview generation
- versioning

## 10.3 Recommended code organization

```text
/apps
  /web-player
  /admin
  /api
  /matchmaker
  /game-server
/packages
  /shared-protocol
  /shared-types
  /shared-ui
  /level-parser
  /asset-pipeline
  /ads-engine
  /auth
  /telemetry
/infra
  docker-compose.yml
  coolify/
```

## 10.4 Shared gameplay core strategy

### Preferred path

Extract simulation-critical logic from the current C/C++ codebase into a portable core with a clear API.

This core should aim to own:

- actor state
- weapons and damage rules
- movement rules
- level parsing hooks
- deterministic or near-deterministic simulation helpers where practical

Then:

- compile to native Linux for authoritative server use
- compile to WebAssembly for client-side prediction or validation helpers where practical

### Fallback path

If the shared-core extraction proves too costly, keep authoritative logic server-side and implement a TypeScript client-side approximation for prediction only.

## 10.5 Rendering strategy

### Chosen library

**Three.js**

### Rendering requirements

- Support imported geometry and materials from the repo's existing modernized asset pipeline.
- Support dynamic actor rendering, projectiles, particles, camera modes, and HUD overlays.
- Keep UI outside the hot render path where possible.
- Support graphics quality presets.
- Support spectating and scout camera views later.

### Performance requirements

- Frustum culling where appropriate
- Asset caching
- texture and geometry budget limits
- optional instancing for repeated objects
- render metrics exposed for debugging

## 10.6 Audio strategy

- Use Web Audio API for positional and effect playback.
- Preserve the game's distinctive weapon/feedback character where assets permit.
- Audio asset pipeline should transcode or validate OGG assets for browser compatibility.
- Provide per-channel volume controls.

## 11. Data model

## 11.1 Core entities

### User

- id
- auth_type
- display_name
- role
- settings_json
- status
- created_at

### LevelPackage

- id
- slug
- title
- creator_user_id
- version
- package_storage_key
- manifest_json
- moderation_status
- is_official
- is_featured
- max_supported_players
- compatibility_version
- created_at

### Room

- id
- owner_user_id
- game_worker_id
- level_package_id
- visibility
- status
- player_cap
- spectator_enabled
- invite_code
- created_at

### Match

- id
- room_id
- level_package_id
- started_at
- ended_at
- result_json
- build_version

### AdCampaign

- id
- name
- status
- placement_types
- targeting_rules_json
- priority
- start_at
- end_at

### AdCreative

- id
- campaign_id
- type
- storage_key
- click_url
- metadata_json

### LevelAdPlacement

- id
- level_package_id
- placement_key
- placement_type
- rules_json

### AuditEvent

- id
- actor_user_id
- action
- entity_type
- entity_id
- payload_json
- created_at

## 12. API requirements

## 12.1 Public/player APIs

- `POST /auth/guest`
- `POST /auth/login`
- `GET /rooms`
- `POST /rooms`
- `GET /rooms/:id`
- `POST /rooms/:id/join`
- `POST /rooms/:id/leave`
- `GET /levels`
- `GET /levels/:id`
- `POST /levels/uploads`
- `GET /me`
- `PATCH /me/settings`

## 12.2 Admin APIs

- `GET /admin/dashboard`
- `GET /admin/levels`
- `POST /admin/levels/:id/approve`
- `POST /admin/levels/:id/reject`
- `POST /admin/ads/campaigns`
- `POST /admin/ads/creatives`
- `PATCH /admin/ads/campaigns/:id`
- `GET /admin/rooms`
- `POST /admin/rooms/:id/terminate`
- `GET /admin/audit`

## 12.3 Realtime protocol requirements

- binary packet schema versioning
- heartbeat / ping / latency reporting
- room join ack
- spawn state
- input packets
- snapshot packets
- event packets
- chat packets
- match-end packets
- reconnect token support

## 13. Deployment and infrastructure requirements

## 13.1 Docker Compose / Coolify

The project must ship with a production-ready `docker-compose.yml` compatible with Coolify.

### Required services

- `web`
- `api`
- `matchmaker`
- `game-server`
- `postgres`
- `redis`
- `minio` or equivalent object storage service

### Deployment requirements

- environment-driven config
- health checks on all stateful services
- graceful restarts for game workers
- persistent volumes for database and object storage
- one-command initial migration/seed flow
- support for scaling game-server replicas separately

## 13.2 Ops requirements

- structured logs
- metrics endpoint
- error tracking
- upload job visibility
- room lifecycle tracing
- build version visibility in admin

## 13.3 Security requirements

- signed upload URLs or guarded upload endpoints
- MIME/type validation and server-side revalidation
- virus scanning hook for uploads
- strict RBAC for admin routes
- CSP and secure headers
- rate limiting on auth, room creation, and chat
- server-side validation of all gameplay-affecting events
- audit logs for admin actions

## 14. UX requirements

## 14.1 Player UX

- Fast load to menu
- Room browser that clearly shows level, occupancy, ping estimate, and room status
- Clean onboarding for pointer lock and controls
- Playable tutorial or practice room later, but at minimum a guided first-session overlay
- Clear error states when a level is incompatible, still processing, or under moderation

## 14.2 Creator UX

- Upload wizard
- Validation report with actionable errors
- Preview metadata before publish
- Ability to keep uploads private for testing
- Creator page listing uploaded content and approval state

## 14.3 Admin UX

- Table-first, high-signal interface
- Bulk moderation actions
- Ad campaign assignment without manual database edits
- Visibility into why a level failed validation

## 15. Acceptance criteria for MVP

The MVP is successful when all of the following are true:

1. A user can open the game in a supported desktop browser and join a centralized room without port forwarding.
2. A user can create a new room on the shared server from the web UI.
3. At least a curated set of existing Avara levels from the repo can be imported and played.
4. Core gameplay controls feel recognizably like Avara.
5. The server is authoritative for movement, damage, and match state.
6. The admin can upload a level package from the browser, validate it, and publish it.
7. The admin can upload an ad creative and target it to specific levels or placements.
8. The platform can be deployed on Coolify using Docker Compose.
9. Rooms can be created by multiple users on the same platform without self-hosting or tracker usage.
10. Basic moderation, audit logging, and health visibility exist.

## 16. Milestones

## Phase 0: Discovery and architecture spike

- repo audit
- identify reusable gameplay core boundaries
- prove ALF/package parsing path
- prove Three.js rendering path with one imported level
- prove authoritative server prototype with one browser client

**Exit criteria:** one imported level renders in browser, one player can move in a server-authoritative prototype.

## Phase 1: Core gameplay web prototype

- browser client shell
- pointer lock controls
- basic HUD
- authoritative movement/combat prototype
- one official level playable

**Exit criteria:** one full match loop works for a small internal test.

## Phase 2: Room service and public web flow

- auth/guest flow
- room browser
- room creation
- invite links
- reconnect support

**Exit criteria:** external testers can create/join rooms from browser.

## Phase 3: Content pipeline and admin

- level package upload
- validation pipeline
- moderation states
- admin dashboard
- official level import workflow

**Exit criteria:** admin can manage official and community levels without CLI steps.

## Phase 4: Ads and operational hardening

- campaign management
- level-targeted ad placements
- metrics/reporting
- logging, rate limiting, backups, scaling work

**Exit criteria:** admin can assign and measure campaigns safely.

## Phase 5: Beta and polish

- performance tuning
- control presets polish
- compatibility fixes
- onboarding improvements
- creator documentation

## 17. Major risks and mitigations

| Risk | Why it matters | Mitigation |
|---|---|---|
| Shared-core extraction is harder than expected | Could stall the project early | Timebox a spike, keep fallback path where server logic is authoritative and browser prediction is lighter |
| Gameplay feel drifts from Avara | The port becomes technically functional but spiritually wrong | Build comparison harnesses, replay tests, and side-by-side behavior checks against the existing port |
| Browser networking latency feels worse than desktop | Hurts combat feel | Use authoritative snapshots, interpolation, prediction, binary packets, and keep the server regions simple at first |
| Legacy level formats are inconsistent | Community content becomes fragile | Define a normalized upload package and import existing content through a controlled pipeline |
| Ads become intrusive | Community backlash | Restrict ads to approved placements and avoid mid-match interruptions |
| User-created levels become an abuse vector | Security and moderation risk | Strong validation, file limits, moderation states, and admin review tools |

## 18. Open questions

These should be answered before implementation is locked:

1. What exact current Avara room/player cap should be treated as the default reference value?
2. Should anonymous guests be allowed to create public rooms, or only private rooms?
3. Should community levels be playable privately before moderation approval?
4. Should in-level ad surfaces exist only for newly tagged levels, or should the platform support overlay-based fallbacks?
5. How much of the current C/C++ gameplay code can realistically be shared without turning the project into a long-lived engine-port effort?
6. Is browser spectating required for MVP or beta?
7. Do you want user accounts from day one, or is guest-first acceptable for launch?

## 19. Final recommendation

The best product path is:

- preserve gameplay logic where it helps fidelity
- move rendering and UX fully into the browser
- centralize multiplayer under authoritative servers
- treat levels as moderated packages
- build ads as a content layer, not an interruption layer
- deploy the whole platform through Docker Compose on Coolify

This gives you a product that is recognizably Avara, operationally manageable, web-native, and extensible enough to support community content and monetization without preserving the parts of the old architecture that are actively working against a browser release.
