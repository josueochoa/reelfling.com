# Seedance Studio

A local, Higgsfield-style studio for generating videos with ByteDance **Seedance**, through either BytePlus ModelArk or the ArgoLink gateway.

## Setup

```bash
cp .env.example .env.local   # add ARGOLINK_API_KEY or ARK_API_KEY
npm install
npm run dev                  # http://localhost:3000
```

`VIDEO_PROVIDER` (`argolink` | `modelark`) picks the provider; the UI only offers that provider's models. API keys never leave the server.

| | ModelArk | ArgoLink |
|---|---|---|
| Models | Seedance 2.0, 1.0 Pro | Seedance 2.5, 2.0, 2.0 Fast, 2.0 Mini |
| Seed / watermark / fixed camera | yes | no (rejected upstream, so hidden) |
| Continue from last frame | yes | no |
| Progress % | no | yes |
| Cost estimate in UI | no | yes (from ArgoLink's per-second prices) |

## How it works

```
Browser ──► /api/generations            POST: validate → create ModelArk task → save record
        ──► /api/generations/:id        GET: sync status from ModelArk (polled every 4s); DELETE: cancel + remove
        ──► /api/generations/:id/video  stream the cached MP4 (Range support)
```

- `src/lib/models.ts`: model catalog (IDs, ratios, resolutions, durations, audio/frames/reference limits). **Edit this file to add or update models.** The UI and the server validation both read from it.
- `src/lib/providers/`: one adapter per provider (`modelark.ts`, `argolink.ts`) behind a common `VideoProvider` interface. Statuses are normalized to `queued/running/succeeded/failed`. The ArgoLink adapter uploads local images through `/v1/media/uploads`, because ArgoLink only accepts HTTPS media.
- `src/lib/store.ts`: JSON-file store in `./data/`. Finished videos are downloaded to `./data/videos/` because ModelArk's URLs expire after about 24 hours.
- `src/components/`: studio UI (control panel, generation feed, lightbox).

### Modes

- **Frames**: text-to-video, or image-to-video with a start frame and an optional end frame.
- **References** (Seedance 2.0): up to 9 images, 3 videos and 3 audio clips. Images are uploaded as base64; videos and audio must be public URLs.

"Continue from last frame" starts a new generation using the previous clip's final frame (`return_last_frame`) as its start frame.
