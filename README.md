# Seedance Studio

A local, Higgsfield-style studio for generating videos with ByteDance **Seedance**, through either BytePlus ModelArk or the ArgoLink gateway.

## Setup

```bash
cp .env.example .env.local
npm install
npm run dev                  # http://localhost:3000
```

In `.env.local`, set:

- `AUTH_SECRET`: `openssl rand -base64 32`. It encrypts users' saved API keys, so changing it invalidates them.
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`: from Google Cloud Console → APIs & Services → Credentials → *Create OAuth client ID* → *Web application*. Add `http://localhost:3000/api/auth/google/callback` as an authorized redirect URI (and your production URL's equivalent, with `APP_URL` set).
- `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` (optional): store videos in Cloudflare R2, one bucket per user. Without them, videos are kept on local disk. See [Storage](#storage).

## Accounts & keys (BYOK)

- Users sign in with Google. Sessions are random tokens in an httpOnly cookie; only their SHA-256 hash is stored.
- Each user adds their own ArgoLink and/or ModelArk key under **API keys** in the account menu. A key is checked against the provider before it's saved, then stored AES-256-GCM encrypted. The server never uses keys of its own.
- Generations and videos belong to the user who made them; every query is scoped by user.
- Data lives in `$DATA_DIR` (default `./data`): `app.db` (SQLite), plus `videos/` when R2 isn't configured.
- The first account to sign in inherits any pre-accounts history from `data/generations.json`.

| | ModelArk | ArgoLink |
|---|---|---|
| Models | Seedance 2.0, 1.0 Pro | Seedance 2.5, 2.0, 2.0 Fast, 2.0 Mini |
| Seed / watermark / fixed camera | yes | no (rejected upstream, so hidden) |
| Continue from last frame | yes | no |
| Progress % | no | yes |
| Cost estimate in UI | no | yes (from ArgoLink's per-second prices) |

## Storage

Finished videos are copied out of the provider (their URLs expire after about 24 hours) into the user's storage:

- **Cloudflare R2** (when the `R2_*` variables are set): every user gets a private bucket named `<R2_BUCKET_PREFIX>-<user id>` in your Cloudflare account. It's created at sign-in, or on the first upload if that failed. Playback and downloads redirect to a signed URL that's valid for one hour, so video bytes go straight from Cloudflare to the browser. R2 doesn't charge for egress.
- **Local disk** (default): `$DATA_DIR/videos/`.

To set up R2: Cloudflare dashboard → R2 → *Manage API tokens* → *Create Account API token* with **Admin Read & Write** (it needs to create buckets). Copy the Access Key ID, Secret Access Key and your account ID into `.env.local`. Videos that were stored locally move into the user's bucket the next time they're played.

Every stored object is indexed in the `assets` table, so per-user usage (shown in the account menu) is a `SUM(bytes)`. All buckets share your account's R2 free tier (10 GB-month, 1M writes, 10M reads); beyond that it's $0.015/GB-month.

## How it works

```
Browser ──► /api/auth/google[/callback] Google sign-in (OAuth + PKCE)
        ──► /api/me, /api/keys          current user, saved keys, active provider
        ──► /api/generations            POST: validate → create task with the user's key → save record
        ──► /api/generations/:id        GET: sync status from the provider (polled every 5s); DELETE: cancel + remove
        ──► /api/generations/:id/video  302 to a signed R2 URL (or stream from disk, with Range support)
```

- `src/lib/models.ts`: model catalog (IDs, ratios, resolutions, durations, audio/frames/reference limits). **Edit this file to add or update models.** The UI and the server validation both read from it.
- `src/lib/providers/`: one adapter per provider (`modelark.ts`, `argolink.ts`) behind a common `VideoProvider` interface. Statuses are normalized to `queued/running/succeeded/failed`. The ArgoLink adapter uploads local images through `/v1/media/uploads`, because ArgoLink only accepts HTTPS media.
- `src/lib/auth.ts`, `google.ts`, `keys.ts`, `crypto.ts`, `db.ts`: users, sessions, Google OAuth, encrypted keys, SQLite schema.
- `src/lib/store.ts`: per-user generations. Copies finished videos into storage.
- `src/lib/storage.ts`: per-user R2 buckets (S3 API via `aws4fetch`) or local disk, the `assets` index, usage and serving.
- `src/components/`: studio UI (control panel, generation feed, lightbox).

### Modes

- **Frames**: text-to-video, or image-to-video with a start frame and an optional end frame.
- **References** (Seedance 2.0): up to 9 images, 3 videos and 3 audio clips. Images are uploaded as base64; videos and audio must be public URLs.

"Continue from last frame" starts a new generation using the previous clip's final frame (`return_last_frame`) as its start frame.
