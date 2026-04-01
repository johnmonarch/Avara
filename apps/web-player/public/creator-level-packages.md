# Avara Online Creator Package Guide

This guide documents the zip format and moderation flow that the current web validator accepts.

## Package layout

Your upload must be a `.zip` with this normalized shape:

```text
level-package.zip
  manifest.json
  set.json
  /alf/*.alf
  /audio/*.ogg
  /preview/*.png
  /bsps/*.json
```

`manifest.json`, `set.json`, and at least one `alf/*.alf` file are required.

## Hard limits

- Total archive size: `64 MB`
- Per-file size: `16 MB`
- Max file count: `256`
- Max ALF object count per file: `4000`
- Allowed extensions only: `.json`, `.alf`, `.ogg`, `.png`
- Allowed top-level directories only: `alf`, `audio`, `preview`, `bsps`

Archives that escape the package root or introduce unknown top-level directories are rejected.

## `manifest.json`

The validator normalizes your manifest and requires a non-empty `title`.

Example:

```json
{
  "title": "Bwadi Remix",
  "slug": "bwadi-remix",
  "description": "A private-test variant tuned for browser rooms.",
  "version": "1.0.0",
  "compatibilityVersion": "web-mvp",
  "recommendedPlayers": [2, 8]
}
```

Notes:

- `compatibilityVersion` must be exactly `web-mvp`
- `recommendedPlayers` defaults to `[2, 8]` if omitted
- `slug` is generated automatically if omitted
- The first `preview/*.png` file becomes the preview asset if present

## `set.json`

`set.json` must expose a `LEDI` array with entries that point to ALF files included in the archive.

Example:

```json
{
  "LEDI": [
    {
      "Alf": "alf/bwadi-remix.alf",
      "Name": "Bwadi Remix",
      "Message": "Private test build"
    }
  ]
}
```

Every `Alf` path referenced here must exist in the zip.

## ALF and asset safety

The current upload pipeline rejects text content containing banned signatures such as:

- `<script`
- `javascript:`
- `eval(`
- `import(`
- `onerror=`
- `onload=`
- `process.`
- `child_process`
- `file://`

This platform does not execute arbitrary level scripts. The level parser only accepts a constrained arithmetic expression path from legacy content, and upload validation is designed to block script-like payloads and archive escapes before publication.

## Billboard ad placeholders

If you want a level-owned billboard slot, define a marker that the parser can recognize as an ad surface. The parser treats a marker as a billboard when any of the following are present:

- `kind="ad_billboard"`
- `placement="ad_billboard"`
- `slot`, `adSlot`, or `billboardSlot`

Example marker attributes:

```xml
<Marker
  kind="ad_billboard"
  slot="north-wall"
  x="12"
  y="6"
  z="-48"
  yaw="180"
  width="18"
  height="8"
/>
```

Admin campaigns can then target that slot id directly.

## Publishing states

Uploaded packages move through these states:

- `draft`
- `private_test`
- `submitted`
- `approved`
- `rejected`
- `archived`
- `official`

Community uploads can be used privately during `private_test`, but they do not appear in the public browser until promoted into a public-playable state.

## Practical workflow

1. Zip the normalized package structure.
2. Upload it through the admin panel.
3. Review validator issues and warnings.
4. Keep it in `private_test` while you verify gameplay.
5. Submit for moderation when ready.
6. Promote to `official` only after admin approval.
