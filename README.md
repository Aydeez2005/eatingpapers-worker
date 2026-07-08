# eatingpapers-worker

Background worker for the Eatingpapers platform. Extracts audio from YouTube
(yt-dlp + ffmpeg, 128kbps MP3, ID3 chapters), uploads to Supabase Storage, and
publishes episodes to Buzzsprout. Exposes an SSE HTTP API consumed by the
Next.js platform.

Runs as a long-lived container (not serverless) because a single job can take
several minutes. Deployed on Render from this repo's `Dockerfile`.

## Endpoints

- `GET  /health` — liveness probe
- `POST /extract` — `{ youtube_url }` → SSE, returns hosted `audio_url` +
  `cover_url` + metadata + chapters
- `POST /publish` — `{ audio_url, title, description, artwork_url? }` → SSE,
  uploads to Buzzsprout as a draft, returns the episode id

All endpoints except `/health` require `Authorization: Bearer $WORKER_SECRET`.

## Environment

Set these as service env vars (see `.env.example`):

| Var | Purpose |
|-----|---------|
| `WORKER_SECRET` | Shared bearer token the platform authenticates with |
| `BUZZSPROUT_API_TOKEN` | Buzzsprout API token |
| `BUZZSPROUT_PODCAST_ID` | Buzzsprout show id |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role key (storage uploads) |
| `YT_COOKIES_FILE` | Path to the YouTube cookies file (see below) |
| `PORT` | Provided by the host; defaults to 3333 locally |

## YouTube cookies

yt-dlp needs a Netscape-format `cookies.txt` to avoid 403s. It is **not** in
this repo. On Render, add it as a **Secret File** named `cookies.txt` (mounted
at `/etc/secrets/cookies.txt`) and set `YT_COOKIES_FILE=/etc/secrets/cookies.txt`.
Cookies expire periodically and must be re-exported.

## Local dev

```
cp .env.example .env   # fill in values
npm install
npm run dev
```
