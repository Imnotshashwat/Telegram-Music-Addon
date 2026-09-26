# Telegram Music Addon

Self-hosted [BitChord](https://github.com/kushagrasinghx/BitChord) addon that streams your personal FLAC, Dolby Atmos, and hi-res audio library from a private Telegram channel using GramJS and Express.

---

## Contents

- **Overview:** [About](#about) · [Features](#features) · [How it works](#how-it-works)
- **Channel tools:** [Music search (/s)](#song-search-and-downloads) · [Keeping duplicate tracks](#keeping-duplicate-songs) · [Chat cleaner](#user-chatter-auto-cleaner)
- **Quick start:** [Prerequisites](#1-prerequisites) · [Authentication](#2-setup-and-authentication) · [Local run](#3-start-the-server) · [Cloud deploy](#4-deploy-to-the-cloud)
- **Configuration:** [Environment variables](#4-deploy-to-the-cloud) · [URL_SECRET protection](#protecting-your-public-deployment-with-url_secret-optional) · [24/7 uptime](#5-keeping-it-running-247-preventing-cold-starts) · [Add to BitChord](#6-add-to-bitchord)
- **Reference:** [API Endpoints](#api-endpoints)

---

## About

Telegram Music Addon lets you run a personal streaming backend without dedicated storage servers. It indexes audio files saved in your own private Telegram channel and streams them directly to BitChord on Android.

ExoPlayer connects to the server with standard HTTP 206 range requests, reading 64KB to 512KB chunks on demand. Since files remain in your private channel, you do not hit third-party cloud storage fees, bandwidth quotas, or transcoding bottlenecks.

## Features

- **Personal channel storage:** Store your music library in your own private channel with no fixed bandwidth quotas.
- **Direct FLAC and Dolby Atmos streaming:** Range requests pull raw slices on demand for instant seeking without server-side re-encoding.
- **Queue-aware preamble cache:** Stores the initial 512KB of active and queued tracks in memory, letting playback start in under 10ms from RAM.
- **Spatial audio detection:** Recognizes E-AC-3 JOC streams in M4A audio containers (and raw `.ec3` files) and responds to `?atmos=auto` requests.
- **Channel `/s` search:** Run `/s <query>` to search Deezer through `@MusicsHuntersbot`, page through results, and download tracks with one tap.
- **In-memory search index:** Retains track metadata in RAM for rapid search resolution.
- **Flexible title and artist matching:** Cleans up soundtrack tags, parentheticals, and multi-artist credits to match BitChord queries accurately.
- **ISRC matching:** Direct lookup endpoints support exact recording code queries.
- **Audio deduplication:** Automatically keeps higher-bitrate or higher-sample-rate copies when duplicate files appear, while keeping separate Dolby Atmos mixes.
- **Chat cleaner:** Removes regular text messages and media chatter while preserving audio uploads, bot menus, and admin announcements.

> [!NOTE]
> Keep your Telegram channel **Private**. Public channels get crawled by search engines and copyright bots.

## Channel commands and music search

### Song search and downloads

Send `/s`, `/song`, `#s`, or `#song` in your channel to find and download lossless FLAC files:

- **Interactive search:** Send `/s <song name>` (for example `/s brown rang`) to fetch Deezer results:
  ```text
  🎧 Search Results for: "brown rang" [Deezer FLAC]

  1. Boogaloo Joe Jones - Brown Bag (5:07)
  2. Nizi19 - Browning (1:45)
  3. Van Morrison - Brown-Eyed Girl (3:03)
  4. The King's Noyse - Browning (4:45)
  5. Jean-Claude Vannier - Browning (3:14)
  ```
  - **Inline buttons:** If you supply a bot token, the addon attaches square buttons `[ 1 ]` to `[ 7 ]` and page controls `[ ⬅️ ] [ ❌ ] [ ➡️ ]`. Check [TELEGRAM_SETUP.md](TELEGRAM_SETUP.md#31-optional-add-a-bot-for-inline-buttons) for details.
  - **Pagination:** Tapping `➡️` or `⬅️` flips pages in place without sending new messages.
  - **Download:** Tap a number button or type `/1` through `/14` to pull the file into your channel.
- **Direct links:** Paste Spotify, Deezer, Tidal, or Qobuz track links directly with `/s <url>`.

### Keeping duplicate songs

If you want to keep two different versions of a song (such as a 16-bit FLAC alongside a 24-bit master or an acoustic version):
- **File caption:** Include `/keep`, `#keep`, or `/ig` in the caption when uploading.
- **Grace window:** When a new file matches an existing track, the server pauses for 30 seconds before cleaning the duplicate. Reply to that file with `/keep` to save both copies.
- **Bot notifications:** When `TELEGRAM_BOT_TOKEN` is set, duplicate warnings and cleanup digests are posted by your bot so your personal account stays silent.

### User chatter auto-cleaner

The channel listener discards text, images, stickers, and spam from regular chat members to prevent channel clutter.
- **Immunity:** Audio files, bot button menus, admin announcements, system alerts, and slash commands are preserved.

## How it works

1. You upload audio tracks (FLAC, ALAC, WAV, MP3, M4A, or Dolby Atmos M4A/EAC3) to your private channel.
2. The server signs into Telegram through MTProto (GramJS) with your user session, avoiding bot API upload restrictions.
3. The server scans file headers, extracts audio metadata, and populates the in-memory search index.
4. BitChord calls `/manifest.json`, `/search?q=...`, and `/stream/:id`.
5. ExoPlayer streams audio chunks straight from `/audio/:id`.

### Playback resolution flow

1. **Immediate start:** BitChord starts playing from YouTube Music right away to prevent buffering pauses.
2. **Parallel query:** Simultaneously, BitChord queries your Telegram addon and JioSaavn.
3. **Upgrade priority:**
   - If present in your Telegram vault, BitChord switches immediately to your **Telegram FLAC / Dolby stream**.
   - If absent from Telegram, it upgrades to **JioSaavn (320 kbps)**.
   - If unavailable on both, playback continues on **YouTube Music (160 kbps)**.

> [!NOTE]
> If your cloud container was idling on a cold start, keep it active with an automated ping check (Step 5 below) so Telegram FLAC always answers immediately.

## Quick start

### 1. Prerequisites

- Node.js 18+
- Telegram account with `API_ID` and `API_HASH` from [my.telegram.org](https://my.telegram.org)
- A private Telegram channel dedicated to your music

### 2. Setup and authentication

Clone the repository and install dependencies:

```bash
git clone https://github.com/Imnotshashwat/Telegram-Music-Addon.git
cd Telegram-Music-Addon
npm install
```

Generate your session string:

```bash
npm run login
```

Follow the prompts for your API ID, API hash, phone number, login code, and channel handle or ID.

> [!TIP]
> For architecture notes, numeric channel ID lookups, or container setups, see [TELEGRAM_SETUP.md](TELEGRAM_SETUP.md).

### 3. Start the server

```bash
npm start
```

The server listens on port `3000` by default. Check the manifest in your browser:

```text
http://localhost:3000/manifest.json
```

#### Local PC to phone setup (Cloudflare Tunnel)
Android prevents cleartext `http://` streams across local network addresses. If you run the addon on your desktop and want to stream to your phone, expose an HTTPS link using Cloudflare:

```bash
cloudflared tunnel --url http://localhost:3000
```

Use the output `https://<subdomain>.trycloudflare.com` URL inside BitChord.

### 4. Deploy to the cloud

Because Android ExoPlayer expects HTTPS endpoints, host the addon on a provider with SSL support (Render, Fly.io, or through Cloudflare).

Set these environment variables in your hosting settings:

| Variable | Description |
|---|---|
| `TELEGRAM_API_ID` | Numeric Telegram API ID |
| `TELEGRAM_API_HASH` | Telegram API hash string |
| `TELEGRAM_SESSION_STRING` | User session string generated by `npm run login` |
| `TELEGRAM_CHANNEL` | Channel handle (e.g. `@my_vault`) or numeric ID (e.g. `-1001234567890`) |
| `PORT` | HTTP port (default `3000` or host provided) |
| `ENABLE_CHANNEL_NOTIFICATIONS` | Set to `true` to post deduplication digests to your channel (default: `false`) |
| `TELEGRAM_BOT_TOKEN` | Optional bot token to display inline buttons under `/s` results and route automated channel notifications/deletions through your bot |
| `TELEDRIVE_CHANNEL` | Optional source channel handle or ID to auto-sync audio files uploaded via TeleDrive |
| `URL_SECRET` | Optional token path prefix to restrict public access to your own devices |

#### Protecting your public deployment with URL_SECRET (optional)

When hosting Telegram Music Addon on a public URL, automated bots or strangers could find your domain and stream files through your Telegram account. Setting a secret path token locks the server so only your devices can access it.

1. **Set the secret:**
   - In `.env`: add `URL_SECRET=mysecret123`
   - In cloud dashboards: add `URL_SECRET` to your environment variables
2. **Connect inside BitChord:**
   Append the token to your manifest address:
   ```text
   https://<your-domain>/mysecret123/manifest.json
   ```
   BitChord remembers the path prefix and includes it on subsequent stream and search requests. Calls missing the token receive a `401 Unauthorized`.
3. **Uptime checks remain available:**
   The `/ping` and `/icon.png` routes remain public so monitoring tools can ping the server without exposing your token.

### 5. Keeping it running 24/7 (Preventing cold starts)

Free cloud containers often spin down after idle periods. You can keep the service responsive using free tools like [UptimeRobot](https://uptimerobot.com) or [Cron-Job.org](https://cron-job.org):
- Configure an HTTP monitor targeting your health check:
  ```text
  https://<your-service-name>.onrender.com/ping
  ```
- Set the check interval to **every 10 minutes**.
- This avoids cold-boot delays and ensures Telegram FLAC resolves immediately.

### 6. Add to BitChord

1. Open BitChord on Android.
2. Go to **Settings** > **Sources**.
3. Tap **Add Source** and paste your URL (e.g. `https://<your-service-name>.onrender.com`).
4. BitChord validates your manifest and queries your vault whenever you play tracks.

## API Endpoints

When `URL_SECRET` is active, all routes except `/ping` and `/icon.png` require the secret prefix (e.g. `/:secret/manifest.json`).

- `GET /manifest.json`: Addon manifest and capabilities.
- `GET /search?q=:query&atmos=auto`: Fast in-memory track search with Atmos preference.
- `GET /isrc/:code`: Exact track match by ISRC recording code (BitChord).
- `GET /resolve-isrc?isrc=:code`: Exact track match by ISRC recording code (Eclipse Music).
- `GET /stream/:id`: Stream descriptors (FLAC or E-AC-3 JOC M4A) and media URL.
- `GET /audio/:id`: HTTP 206 range-enabled audio streaming.
- `GET /artwork/:id`: Album art extracts.
- `GET /icon.png`: Addon logo for BitChord source listings (public).
- `GET /notifications/status`: Deduplication state and notification settings.
- `GET /notifications/flush`: Triggers an immediate cleanup summary flush.
- `GET /debug/requests`: Ring buffer of the last 50 incoming requests.
- `GET /debug/faststart`: Current statistics for the 10-track preamble cache.
- `GET /ping`: Public health check for uptime monitors.
