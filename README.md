# ReelFling

A Higgsfield-style studio for generating videos with ByteDance **Seedance** (through BytePlus ModelArk, the ArgoLink gateway or OpenRouter) and images with **Nano Banana** and **GPT Image** (through ArgoLink or OpenRouter). Live at https://reelfling.com. It runs entirely on Cloudflare: Workers (via [OpenNext](https://opennext.js.org/cloudflare)), D1, R2 and Access.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars   # then fill it in
npm run dev                      # http://localhost:3000, signed in as DEV_USER_EMAIL
npm run preview                  # the real Workers runtime, locally (http://localhost:8787)
```

`npm run dev` applies D1 migrations to a local database (`.wrangler/state`) first. Finished videos go to real R2, so `.dev.vars` needs R2 credentials; local buckets use the `dev` prefix.

**Config never goes in `.env*` files**: OpenNext bundles them into the deployed Worker. Non-secret settings are `vars` in `wrangler.jsonc`; secrets go in `.dev.vars` locally and `wrangler secret put` in production.

## Deploying

One-time setup (needs the Workers Paid plan, $5/month; the free plan's 10 ms CPU limit is too low for Next.js):

1. `npx wrangler login`, then `npx wrangler d1 create seedance-studio` and put the `database_id` into `wrangler.jsonc`.
2. **R2**: dashboard → R2 → *Manage API tokens* → *Create Account API token* with **Admin Read & Write** (it creates a bucket per user). Set `R2_ACCOUNT_ID` in `wrangler.jsonc`, and the keys as secrets:
   `npx wrangler secret put R2_ACCESS_KEY_ID`, `npx wrangler secret put R2_SECRET_ACCESS_KEY`.
3. `npx wrangler secret put AUTH_SECRET` with the output of `openssl rand -base64 32`. **Back it up**: it encrypts users' saved API keys, and they can't be decrypted without it.
4. `npx wrangler queues create reelfling-image-jobs` (for the Image tab).
5. `npm run deploy`. It builds, applies D1 migrations, and deploys.
6. **Cloudflare Access** (Zero Trust, free for up to 50 users): pick a team name, enable the *One-time PIN* login method, then add a *self-hosted application* for the app's domain with an *Allow* policy (e.g. emails ending in `@yourcompany.com`). Put the team domain (`https://<team>.cloudflareaccess.com`) and the application's *AUD tag* into `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` in `wrangler.jsonc`, and deploy again. Make sure the `*.workers.dev` address is covered by Access too, or turn it off.

## Tabs

- **Video**: Seedance (see below).
- **Image**: Nano Banana 2.1 and GPT Image 2.5 Sunburst through ArgoLink's or OpenRouter's images API. Jobs use the workspace's active key if it's one of those two, otherwise whichever of them has a key; each job records which one it ran on. Pick a ratio (or Auto, which matches the first reference image), resolution (1K/2K/4K), quality (GPT only) and 1–4 images; reference images come from Uploads and are mentioned as `@Image 1`. Models and prices are in `src/lib/imageModels.ts`.

- **Assets**: everything in the user's bucket in one place: generated videos and images, and uploads. Filter by type (sidebar, with counts and storage used), source (All / Generated / Uploaded), model and prompt/name; grouped by day, with bulk select, download and delete. Any asset can be sent to the Image or Video tab as a reference, generated ones included. Deleting a generated video deletes its generation; deleting a generated image removes it from its generation (which goes with its last image).

  Generated images and videos get thumbnails lazily: the first time a browser shows one without a thumbnail, it draws a small JPEG (canvas, via the bucket's CORS rule) and saves it next to the file (`/api/assets/thumb`).

  The images APIs are synchronous and can take minutes, so each generation is a background job: `POST /api/images` records it and sends it to the `reelfling-image-jobs` queue; the Worker's queue consumer (`worker.ts`, 15-minute limit) calls the provider, copies the images into the user's bucket (`images/<id>/…`) and updates the record; the page polls. Closing the tab doesn't lose anything. Jobs are claimed atomically, so a redelivered message can't bill twice, and the cron job fails any that died. Under `npm run dev` jobs run inline (there's no queue consumer).

## Teams

Everything belongs to a **workspace**: every user has a Personal one, and can create or join **teams** (switcher next to the logo). A team shares its videos, images, uploads and **API keys** (generations bill the team's provider account); each item shows who made it.

| | Owner | Admin | Member |
|---|---|---|---|
| Generate, upload, use shared assets; delete own items | ✓ | ✓ | ✓ |
| Delete anyone's items; manage team API keys; invite, remove, change roles | ✓ | ✓ (not the owner) | |
| Rename the team | ✓ | | |

- **Invites**: by email (they see a banner when they sign in) or by link (`/invite/<token>`, 14 days; only a hash is stored). Leaving or being removed keeps your work in the team.
- **Who gets in**: Cloudflare Access's policy. Anyone it lets sign in gets an account (with a Personal workspace), and invites add people to teams. Set `INVITE_ONLY=true` to also require a team invite for new accounts; others then see "You're not on a team yet".
- **Storage**: `STORAGE_QUOTA_GB` per Personal workspace; a team gets that × its members. Each workspace has its own R2 bucket (a Personal one keeps the user's existing bucket).
- **Scoping**: each request names its workspace (`x-workspace-id` header; `?ws=` on media URLs, which can't send headers) and `requireWorkspace()` checks membership and role. A tab remembers its workspace in localStorage, so two tabs can be in different workspaces.

## Accounts & keys (BYOK)

- **Sign-in** (`AUTH_MODE`): `access` (default) puts Cloudflare Access in front of the app. Access decides who gets in, and the app verifies the JWT it adds to every request (signature, issuer, audience, expiry) before trusting the email in it. `google` switches to built-in Google sign-in with cookie sessions; set `GOOGLE_CLIENT_ID` (var) and `GOOGLE_CLIENT_SECRET` (secret), with redirect URI `https://<domain>/api/auth/google/callback`.
- Accounts are keyed by email, so switching sign-in methods keeps everyone's keys and videos.
- Each workspace has its own ArgoLink, OpenRouter and/or ModelArk keys under **API keys** in the account menu (in a team, managed by owners and admins). A key is checked against the provider before it's saved, then stored AES-256-GCM encrypted. The server never uses keys of its own.
- Generations and videos belong to the user who made them; every query is scoped by user.
- D1 has point-in-time restore (Time Travel) for the last 30 days: `npx wrangler d1 time-travel`.

| | ModelArk | ArgoLink | OpenRouter |
|---|---|---|---|
| Models | Seedance 2.0, 1.0 Pro | Seedance 2.5, 2.0, 2.0 Fast, 2.0 Mini | Seedance 2.5, 2.0, 2.0 Fast, 2.0 Mini, 1.5 Pro |
| Image models | no | yes | yes (Nano Banana: one image per request, so 1–4 run in parallel) |
| Seed / watermark / fixed camera | yes | no (rejected upstream, so hidden) | seed only |
| Continue from last frame | yes | no | no |
| Progress % | no | yes | no (queued → running → done) |
| Cost in UI | no | estimate (per-second prices) | estimate (per-token prices), then the billed cost |

## Storage

Every user gets a private R2 bucket named `<R2_BUCKET_PREFIX>-<user id>` in your Cloudflare account. It's created on their first upload, or at sign-in with Google. Finished videos are copied out of the provider, whose URLs expire after about 24 hours, and streamed into the bucket rather than buffered, since Workers have 128 MB of memory. Playback and downloads redirect to a signed URL that's valid for one hour, so the bytes go straight from R2 to the browser. R2 doesn't charge for egress.

A cron trigger runs every minute and finishes generations nobody is watching (the user closed the tab): it syncs their status and copies the video into storage.

Every stored object is indexed in the `assets` table, so per-user usage (shown in the account menu) is a `SUM(bytes)`. Each user gets `STORAGE_QUOTA_GB` (default 2). When it's full, new generations are refused before they reach the provider, so nothing is charged. All buckets share your account's R2 free tier (10 GB-month, 1M writes, 10M reads); beyond that it's $0.015/GB-month.

## How it works

```
Browser ──► Cloudflare Access           sign-in (or /api/auth/google with AUTH_MODE=google)
        ──► /api/me, /api/keys          current user, saved keys, active provider, storage usage
        ──► /api/generations            POST: validate → create task with the user's key → save record
        ──► /api/generations/:id        GET: sync status from the provider (polled every 5s); DELETE: cancel + remove
        ──► /api/generations/:id/video  302 to a signed R2 URL
        ──► /api/images[/:id[/file]]    image jobs: queue, poll, view, delete
        ──► /api/assets[/file|/thumb]   all assets: list, delete, view/download, lazy thumbnails
Queue   ──► /api/images/run             one image job per message (worker.ts)
Cron    ──► /api/cron/sweep             every minute (worker.ts): finish unwatched generations, fail stuck image jobs
```

- `src/lib/models.ts`: model catalog (IDs, ratios, resolutions, durations, audio/frames/reference limits). **Edit this file to add or update models.** The UI and the server validation both read from it.
- `src/lib/providers/`: one adapter per provider (`modelark.ts`, `argolink.ts`, `openrouter.ts`) behind a common `VideoProvider` interface. Statuses are normalized to `queued/running/succeeded/failed`. The ArgoLink adapter uploads local images through `/v1/media/uploads`, because ArgoLink only accepts HTTPS media.
- `src/lib/auth.ts`, `google.ts`, `keys.ts`, `crypto.ts`: Access JWT verification / Google sessions, encrypted keys.
- `src/lib/db.ts`: the Worker env and D1 helpers. Schema: `migrations/`.
- `src/lib/store.ts`: per-user generations. Copies finished videos into storage.
- `src/lib/storage.ts`: per-user R2 buckets (S3 API via `aws4fetch`), the `assets` index, usage, quota and serving.
- `worker.ts`: Worker entry, the OpenNext app plus the cron handler. `wrangler.jsonc`: bindings, vars, cron.
- `src/components/`: studio UI (control panel, generation feed, lightbox).

### Modes

- **Frames**: text-to-video, or image-to-video with a start frame and an optional end frame.
- **References**: images, videos and audio in one box, as blocks in any order. They're mentioned in the prompt as `@Image 1`, `@Video 1`, `@Audio 1`, numbered per kind in the order shown, and the numbers follow when you reorder or remove blocks. Limits per model are in `models.ts`, and file rules in `src/lib/uploads.ts`:
  - images: JPEG/PNG up to 20 MB (other formats are converted to JPEG in the browser);
  - video: MP4/MOV up to 100 MB, 2–30 s;
  - audio: MP3/WAV up to 15 MB, 2–30 s.

#### Uploads library

Every reference is a file in the user's **Uploads** library (`uploads/` in their bucket). Files dropped into the References box are added to it; the Uploads panel lets you browse, filter, search, rename and delete them, and click to add or remove a reference. Generations use library files but don't own them, so deleting a generation keeps them.

1. The browser prepares the file: checks type, size and length, converts images to JPEG/PNG, and makes a JPEG thumbnail (images, video) or waveform peaks (audio).
2. `POST /api/uploads` checks the type, size and quota, and returns 15-minute signed PUT URLs for the file and its thumbnail. Each bucket gets a CORS rule the first time.
3. The browser PUTs them straight to R2, with a progress bar, so large files never pass through the Worker.
4. `POST /api/uploads/complete` checks what actually landed (a signed URL can't limit size), then records the name, duration, peaks and thumbnail, and counts the bytes toward the quota.
5. The generation request references files as `upload:<key>`. The server swaps those for 24-hour signed links the provider downloads from.

The app shows files through `/api/uploads/file?key=…[&thumb=1]`, which redirects to a short-lived signed URL.

"Continue from last frame" starts a new generation using the previous clip's final frame (`return_last_frame`) as its start frame.
