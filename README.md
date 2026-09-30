# Telegram Music Addon

Self-hosted [BitChord](https://github.com/kushagrasinghx/BitChord) addon that streams your personal FLAC, Dolby Atmos, and hi-res audio library from a private Telegram channel, using GramJS and Express.

<div align="center">
  <video src="https://github.com/user-attachments/assets/9d0392ee-9f12-4ce2-a0e1-e096690b74a8" controls="controls" width="80%"></video>
</div>

<details>
<summary align="center"><b>View Terminal Logs from Demo Video</b></summary>

```text
16:52:08 |  SEARCH  | "sexyback justin timberlake" (2 hits, 10ms) -> ID: 792
16:52:08 |  PROBE   | SexyBack (feat. Timbaland) (64 KB header read)
16:52:08 |  STREAM  | SexyBack (feat. Timbaland) • 16-bit / 44.1kHz FLAC • 26.7 MB (4:03m) -> 206 Partial
16:52:12 |  SEARCH  | "i was made for lovin you kiss" (2 hits, 5ms) -> ID: 1363
16:52:12 |  PROBE   | I Was Made For Lovin' You (64 KB header read)
16:52:12 |  BUFFER  | Prewarmed 512 KB -> ID: 1363
16:52:12 |  STREAM  | I Was Made For Lovin' You • 24-bit / 192.0kHz FLAC • 183.6 MB (4:30m) -> 206 Partial
16:52:15 | PRECACHE | Payal • 24-bit / 48.0kHz FLAC • 48.1 MB (3:47m) -> 200 OK
16:52:18 |  BUFFER  | Prewarmed 5.0 MB -> ID: 396
16:52:21 |   SEEK   | I Was Made For Lovin' You • Seeked to ~2:01m (45%) • 82.2 MB
16:52:24 |  SEARCH  | "training season dua lipa" (1 hits, 4ms) -> ID: 182
16:52:24 |  PROBE   | Training Season (64 KB header read)
16:52:24 |  STREAM  | Training Season • 24-bit / 44.1kHz FLAC • 42.9 MB (3:29m) -> 206 Partial
16:52:29 |  WEBDAV  | Forever Young • 16-bit / 44.1kHz FLAC • 23.6 MB (3:47m) -> 200 OK
```

</details>

---

## Contents

---

- **Overview:** [About](#about) · [Features](#features) · [How it works](#how-it-works)
- **Quick start:** [1-Click Installer](#1-click-installer-windows) · [Web setup](#option-a-easy-web-setup-for-git-clones-and-zip-downloads) · [Manual setup](#option-b-manual-setup-linux-vps-or-headless)
- **Configuration:** [Remote access](#networking-and-remote-access-local-hosting-only) · [URL Secret protection](#protecting-your-deployment-with-url-secret-url_secret) · [WebDAV streaming](#webdav-streaming)
- **Channel tools:** [Duplicate management](#automated-duplicate-management) · [Keeping duplicate tracks](#keeping-duplicate-songs-with-keep)
- **Reference:** [API Endpoints](#api-endpoints) · [Disclaimer](#disclaimer) · [License](#license)

---

## About

Telegram Music Addon lets you run a personal streaming backend without a dedicated storage server. It indexes audio files in your own private Telegram channel and streams them directly to BitChord on Android.

ExoPlayer connects with standard HTTP 206 range requests, reading 64 KB to 512 KB chunks on demand. Files stay in your private channel, so you avoid third-party storage fees, bandwidth quotas, and transcoding bottlenecks.

> [!NOTE]
> Keep your Telegram channel **Private**. Public channels get crawled by search engines and copyright bots.

---

## Features

- Personal Telegram channel storage with no separate storage server or fixed quotas needed. Audio is streamed directly from your private channel (bandwidth and performance depend on Telegram, your host, network conditions, and API limits).
- Direct FLAC and Dolby Atmos streaming via HTTP 206 range requests (no server-side re-encoding), with automatic spatial audio detection for E-AC-3 JOC streams in M4A containers and raw `.ec3` files
- Near instant track matching in local benchmarks (sub-200ms in-memory index lookup; actual playback start depends on your network and server speed)
- Built-in WebDAV server with HTTP 206 range streaming, instant metadata lookups, and seamless playback and seeking across WebDAV media players
- Interactive 4-step web setup wizard at `/setup` with direct channel pairing and mobile QR code connection
- Lightweight LRU memory cache: stores Gzip track metadata and active preambles in RAM (up to 1 previous, 1 current, and 4 upcoming queue tracks cached), strictly capped at ~36 MB max for low-resource VPS and cloud hosting
- ISRC lookup endpoints for exact recording code matching
- Audio deduplication: keeps the higher-quality copy when duplicates appear, with a 6-hour grace window before cleanup
- Chat cleaner that removes text chatter and media spam while preserving audio files, bot menus, and admin messages

---

## How it works

1. You upload audio (FLAC, ALAC, OPUS, WAV, MP3, M4A, AAC, or Dolby Atmos M4A/E-AC-3) to your private channel.
2. The server connects to Telegram via MTProto (GramJS) using your user session.
3. It reads file headers, pulls audio metadata, and builds an in-memory search index.
4. BitChord calls `/manifest.json`, `/search?q=...`, and `/stream/:id`.
5. ExoPlayer streams audio from `/audio/:id` via HTTP 206 range requests.

### Playback resolution flow

1. BitChord starts on YouTube Music immediately to prevent buffering pauses.
2. Simultaneously, it queries your Telegram addon and JioSaavn.
3. Priority order:
   - Track found in your Telegram channel: BitChord switches to your **Telegram FLAC / Dolby stream**.
   - Not in Telegram: upgrades to **JioSaavn (320 kbps)**.
   - Not on either: stays on **YouTube Music (160 kbps)**.

---

## Quick start

### 1-Click Installer (Windows)

For Windows users who want a single file without running any commands:

1. Download **`install.bat`** from the latest GitHub Release.
2. Double-click it.
3. The installer automatically:
   - Detects Node.js, installs it silently via Windows Package Manager or PowerShell if missing.
   - Downloads the latest addon package from GitHub.
   - Installs all dependencies.
   - Starts the server and opens `http://localhost:3000/setup` in your browser.

---

### Option A: Easy web setup (for git clones and ZIP downloads)

For users who already cloned the repo or extracted the ZIP:

1. **Start the setup wizard:**
   - **Windows:** Double-click `install.bat`, then `start.bat`
   - **Mac / Linux:** Run `npm install && npm start`
2. Your browser opens to `http://localhost:3000/setup` automatically. On first run with no configuration, the server opens it on its own. On Mac/Linux, if it does not open, navigate there manually.
3. Follow the 4 steps:
   - **Step 1 (Telegram):** Enter your Telegram `API_ID`, `API_HASH`, and phone number (from [my.telegram.org](https://my.telegram.org)).
   - **Step 2 (Verification):** Enter the 5-digit login code sent to your Telegram app (and your 2FA password if enabled).
   - **Step 3 (Storage & Network):** Connect your Telegram channel (ID, URL, or `@username`) and configure optional bot automation or Cloudflare Tunnel.
   - **Step 4 (Connect):** Copy your BitChord Addon URL (or WebDAV URL) into BitChord Settings > Sources, or scan the QR code with your phone.

---

### Option B: Manual setup (Linux VPS or headless)

For remote servers, Docker, or terminal-only setups:

1. **Clone and install:**
   ```bash
   git clone https://github.com/Imnotshashwat/Telegram-Music-Addon.git
   cd Telegram-Music-Addon
   npm install
   ```
2. **Generate your session string:**
   ```bash
   npm run login
   ```
   Follow the prompts: API ID, API hash, phone number, login code, channel handle or ID.
3. **Configure environment variables (`.env` or cloud dashboard):**
   Copy `env.example` to `.env` (or set these in your cloud provider's dashboard):
   ```env
   TELEGRAM_API_ID=1234567
   TELEGRAM_API_HASH=abcdef0123456789
   TELEGRAM_SESSION_STRING=1ApW...
   TELEGRAM_CHANNEL=-1001234567890
   URL_SECRET=yoursecret123
   ```
   `URL_SECRET` is enabled by default (auto-generated if left blank). Parameters left blank in `env.example` are unused (`PORT`, `TELEGRAM_BOT_TOKEN`, `PUBLIC_URL`).
4. **Start the server:**
   ```bash
   npm start
   ```

---

## Networking and remote access (local hosting only)

> *Tip: Cloud providers assign HTTPS automatically, so you can skip local tunnel configuration when hosting in the cloud.*

Android ExoPlayer blocks unencrypted `http://` streams. To stream from a local machine to your phone over mobile data or outside your home Wi-Fi, you need a public HTTPS address.

### 1. Automated Cloudflare Quick Tunnel

The setup wizard includes this out of the box:

- Leave **Enable Cloudflare HTTPS Tunnel** checked in Step 3.
- The server provisions an `https://*.trycloudflare.com` address automatically on startup.
- Your phone can scan the Step 4 QR code and stream anywhere over 4G/5G or remote Wi-Fi.
- On Windows, you can launch the addon anytime with `start.bat`.

### 2. Permanent HTTPS with Tailscale Funnel

For a fixed address that survives PC restarts:

1. Install [Tailscale](https://tailscale.com) on your PC and phone.
2. In your [Tailscale Admin Console](https://login.tailscale.com/admin/dns), enable HTTPS Certificates under **DNS** > **HTTPS Certificates**.
3. Run Funnel in the background:
   ```bash
   tailscale funnel --bg 3000
   ```
4. In Step 3 (Advanced Options), enter your Tailscale address under **Custom Public Domain or Host**:
   ```text
   https://your-pc-name.your-tailnet.ts.net
   ```

---

### Protecting your deployment with URL Secret (URL_SECRET)

Secures your public addon URL with a secret path token so only your authorized devices can connect. Enabled by default with automatic generation:

1. Configure in the web wizard or `.env`:
   - **Web setup:** Open **Advanced Routing > URL Secret** (leave blank to auto-generate a secure 8-character secret, or enter your own passphrase).
   - **Manual setup:** Add to `.env`:
     ```env
     URL_SECRET=yoursecret123
     ```
2. Your addon and WebDAV URLs automatically include the secret segment:
   ```text
   https://<your-domain>/yoursecret123/manifest.json
   https://<your-domain>/yoursecret123/dav
   ```
   Requests without the secret token receive HTTP `401 Unauthorized`.
3. `/ping` and `/icon.png` stay public so uptime monitors and addon icons work without the secret.

---

### Keeping it running 24/7 (cloud hosting)

Free cloud tiers (like Render) sleep after 15 minutes of inactivity. Use [UptimeRobot](https://uptimerobot.com) or [Cron-Job.org](https://cron-job.org) to ping `https://<your-host>/ping` every 5 to 10 minutes to keep it awake.

---

## WebDAV streaming

Stream your library in any WebDAV media player or mount it as a network drive (`/dav`):

- **URL:** `https://<host>/<secret>/dav` (use the WebDAV URL provided on your setup page).
- **Credentials:** No password needed with the secret path. If prompted, use username `admin` and password `<URL_SECRET>`.
- **Features:** HTTP 206 range streaming, seamless seeking, real-time WebDAV playback logging, and silenced background scan logs.
- *Note: Streaming Hi-Res FLAC across multiple devices simultaneously shares your host upload bandwidth.*

---

## Channel automation and library management

> *Tip: Setting `TELEGRAM_BOT_TOKEN` (from [@BotFather](https://t.me/BotFather)) allows duplicate notices and digests to be posted cleanly by your bot instead of your personal account.*

### Automated duplicate management

- **Quality upgrades:** When you upload a higher-quality copy of an existing track (such as 24-bit Hi-Res FLAC replacing 16-bit FLAC, or FLAC replacing MP3), the server automatically keeps the best copy and removes the lower-quality file.
- **Dolby Atmos preservation:** Stereo mixes and Dolby Atmos spatial audio tracks of the same song are both preserved automatically.
- **Grace window:** When an identical or lower-quality file is uploaded, the server waits 6 hours before deleting it.

### Keeping duplicate songs with `/keep`

- To intentionally keep multiple versions of a song (such as alternate masters, edits, or live cuts), add `/keep` to the file caption when uploading.
- You can also reply to any uploaded track or duplicate notice with `/keep` within the grace window to preserve both copies.

### User chatter auto-cleaner

- The real-time listener automatically deletes text messages, images, stickers, and spam posted by regular members in the music channel.
- Audio files, administrator announcements, system alerts, and slash commands are preserved.

---

## API Endpoints

- `/:secret/*`: All protected endpoints require the secret path token prefix (except `/ping` and `/icon.png`).
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

---

## Disclaimer

> [!IMPORTANT]
> Telegram Music Addon is a self-hosted streaming server. It does not host, provide, or distribute any audio files or copyrighted music. It only indexes and streams media stored in your own private Telegram channel.
> 
> *This is an independent open-source project and is not affiliated with, endorsed by, or associated with Telegram or BitChord.*

---

## License

[MIT](LICENSE)

