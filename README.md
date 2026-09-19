# Telegram Music Addon

Self-hosted [BitChord](https://github.com/kushagrasinghx/BitChord) addon for streaming personal FLAC, Dolby Atmos, and hi-res audio from Telegram using GramJS and Express. Built for personal use.

BitChord searches this server whenever a track is requested. If the track is present in your Telegram channel, BitChord streams the original FLAC, ALAC, or Dolby Atmos file directly to ExoPlayer. If not, it falls back to Jio Saavan/YouTube Music.

## Features

- **Free storage & no quotas**: Unlimited audio storage with zero daily bandwidth limits or playback throttling.
- **Direct FLAC and Dolby Atmos streaming**: HTTP 206 range requests pull 64KB to 512KB slices on demand for instant ExoPlayer seeking without re-encoding.
- **Dolby Atmos spatial audio**: Streams immersive E-AC-3 JOC audio in MP4 containers with automatic tag detection and `?atmos=auto` preference support.
- **Interactive `/s` search**: Search Deezer with `/s <name>` to browse 7 tracks per page, navigate with inline buttons, and download FLACs directly. For full playlists, paste the link in your private chat with `@MusicsHuntersbot`.
- **In-memory indexing**: Keeps library metadata in RAM for sub-5ms search response.
- **Title & artist matching**: Normalizes titles and composer duos to match BitChord and YouTube Music queries.
- **ISRC matching**: Direct lookup by recording code for exact track identification.
- **Quality deduplication**: Automatically keeps higher-quality audio files when duplicates appear while preserving Dolby Atmos mixes alongside stereo lossless copies (exempt files with `/keep`).
- **User chatter auto-cleaner**: Automatically removes casual chat and spam from regular users while keeping audio files, bot menus, commands, and admin broadcast posts safe.

> [!NOTE]
> Keep your channel **Private**. Public channels get indexed by search engines and scanned by copyright bots.  
> Private = safe for personal storage.

## Channel commands and music search

### Song search and downloads

The addon listens for `/s`, `/song`, `#s`, and `#song` commands in your channel and downloads tracks in lossless FLAC:

- Interactive 7-track search: Send `/s <song name>` or `#s <song name>` (for example, `/s brown rang`). The addon queries Deezer through `@MusicsHuntersbot`:
  ```text
  🎧 Search Results for: "brown rang" [Deezer FLAC]

  1. Boogaloo Joe Jones - Brown Bag (5:07)
  2. Nizi19 - Browning (1:45)
  3. Van Morrison - Brown-Eyed Girl (3:03)
  4. The King's Noyse - Browning (4:45)
  5. Jean-Claude Vannier - Browning (3:14)
  6. ...
  7. ...
  ```
  - Inline buttons: If you configure a bot token, the addon adds buttons `[ 1 ]` to `[ 7 ]` and navigation buttons `[ ⬅️ ] [ ❌ ] [ ➡️ ]` under the message. See [TELEGRAM_SETUP.md](TELEGRAM_SETUP.md#31-optional-add-a-bot-for-inline-buttons) to set this up.
  - Page navigation: Tapping `➡️` or `⬅️` loads the next or previous set of tracks and updates the message in place.
  - Track download: Tapping a number button (or typing `/1` to `/14`) downloads that track directly into your channel.
- Direct link downloads: Paste streaming links directly, such as `/s https://open.spotify.com/track/...` or Deezer, Tidal, and Qobuz URLs.

### Keeping duplicate songs

If you want to keep multiple versions of a track (such as a 16-bit FLAC alongside a 24-bit copy or a radio edit), you have two options:
- In the file caption: Add `/keep`, `#keep`, or `/ig` to the caption when uploading.
- During the 15-second grace window: When an upload or `/s` download matches a track already in your library, the server holds the file for 15 seconds before deleting it. Reply to the file message with `/keep` or `#keep` (or send `/keep` in the channel) to keep both copies.

### User chatter auto-cleaner

The channel listener deletes casual chat, photos, stickers, GIFs, and spam sent by regular members to keep the music feed clean.
- Bot and system immunity: Messages from bots, menus with buttons, channel admin posts, system status updates, slash commands, and audio files are never deleted.

## How it works

1. You upload audio files (FLAC, ALAC, WAV, MP3, M4A, or Dolby Atmos MP4/EAC3) to a private Telegram channel.
2. The server authenticates with Telegram via MTProto (GramJS) using a user session, bypassing standard bot file size limits.
3. The server extracts audio metadata (title, artist, album, bit depth, sample rate) and builds a local index.
4. BitChord queries `/manifest.json`, `/search?q=...`, `/isrc/:code`, and `/stream/:id` using its pluggable source protocol.
5. BitChord's ExoPlayer streams audio directly through the `/audio/:id` endpoint.

### Exactly What Happens When You Tap a Song:

1. **Instant Playback (0 to 300ms):**  
   BitChord starts playing from **YouTube Music immediately** so you hear audio without any buffering delay.
2. **Parallel Background Race (Simultaneous):**  
   In the background, BitChord fires queries to **both** your Telegram Addon and JioSaavn at the exact same time.
3. **Quality Upgrade Hierarchy:**  
   * **Telegram FLAC (Lossless / 24-bit)** has the highest priority.
   * If the song is in your Telegram vault, BitChord skips JioSaavn and upgrades directly to **Telegram FLAC**.
   * If the song is not in Telegram, it upgrades to **JioSaavn (320 kbps)**.
   * If it's not on JioSaavn either, it stays on **YouTube Music (160 kbps)**.

> [!NOTE]
> If your cloud host was asleep (cold start) and takes a few seconds to wake up, JioSaavn might upgrade first for a second, then Telegram FLAC takes over as soon as the server responds. Keep the server awake with a free pinger (see Step 5 below) to eliminate this delay completely.

## Quick start

### 1. Prerequisites

- Node.js 18+
- Telegram account with `API_ID` and `API_HASH` from [my.telegram.org](https://my.telegram.org)
- A dedicated **private** Telegram channel for storing audio files

### 2. Setup and authentication

Clone the repository and install dependencies:

```bash
git clone https://github.com/Imnotshashwat/Telegram-Music-Addon.git
cd Telegram-Music-Addon
npm install
```

Generate your session string and `.env` file:

```bash
npm run login
```

The interactive prompt will request your API ID, API hash, phone number, login code, and channel handle or numeric ID.

> [!TIP]
> For architecture diagrams, tips on keeping your session private, finding numeric channel IDs, or running via Fly.io / Cloudflare Tunnels, see [TELEGRAM_SETUP.md](TELEGRAM_SETUP.md).

### 3. Start the server

```bash
npm start
```

Default local port is `3000`. Test the manifest in a browser:

```
http://localhost:3000/manifest.json
```

### 4. Deploy to the cloud

Because Android ExoPlayer blocks non-HTTPS streams by default, deploy the server to a host with an HTTPS URL (such as Render, Fly.io, or through a Cloudflare tunnel).

Set the following environment variables in your deployment dashboard:

| Variable | Description |
|---|---|
| `TELEGRAM_API_ID` | Numeric Telegram API ID |
| `TELEGRAM_API_HASH` | Telegram API hash string |
| `TELEGRAM_SESSION_STRING` | Generated MTProto session string from `npm run login` |
| `TELEGRAM_CHANNEL` | Channel username (e.g. `@my_vault`) or numeric ID (e.g. `-1001234567890`) |
| `PORT` | Web server port (defaults to `3000` or assigned by host) |
| `ENABLE_CHANNEL_NOTIFICATIONS` | *(Optional)* Set to `true` if you want cleanup summary notifications posted to your channel (default: `false` / 100% silent) |
| `TELEGRAM_BOT_TOKEN` | *(Optional)* Bot token from @BotFather to enable real square UI buttons `[ 1️⃣ ] [ 2️⃣ ] [ 3️⃣ ] [ 4️⃣ ] [ 5️⃣ ]` under `/s` results. If not set, the addon renders direct clickable `/1` to `/5` command links with zero setup required. |

### 5. Keeping It Running 24/7 (Preventing Cold Starts)

If hosting on a free provider that sleeps after inactivity (like Render's free tier):
* Use a free uptime monitor such as [UptimeRobot](https://uptimerobot.com) or [Cron-Job.org](https://cron-job.org).
* Set an HTTP monitor pointing to your health endpoint:
  ```
  https://<your-service-name>.onrender.com/ping
  ```
* Set the interval to **every 10 minutes**.
* This keeps the server constantly awake, eliminating sleep latency and ensuring sub-5ms search responses so Telegram FLAC always wins the upgrade race instantly.

### 6. Add to BitChord

1. Open BitChord on your Android device.
2. Navigate to **Settings** > **Sources**.
3. Tap **Add Source** and paste your deployment URL (e.g. `https://<your-service-name>.onrender.com`).
4. BitChord validates the manifest. When you play tracks, BitChord will check your Telegram channel first.

## API Endpoints

- `GET /manifest.json`: Addon metadata and supported capabilities.
- `GET /search?q=:query&atmos=auto`: Sub-5ms in-memory search across indexed tracks with optional Dolby Atmos prioritization.
- `GET /isrc/:code`: Exact track match by ISRC recording code (BitChord).
- `GET /resolve-isrc?isrc=:code`: Exact track match by ISRC recording code (Eclipse Music).
- `GET /stream/:id`: Stream metadata (FLAC or E-AC-3 JOC MP4) and direct audio playback URL.
- `GET /audio/:id`: HTTP 206 range-enabled audio streaming.
- `GET /artwork/:id`: Embedded album artwork images.
- `GET /icon.png`: Lossless addon badge served for BitChord source lists.
- `GET /notifications/status`: Check deduplication status and active notification mode (`silent` or `active`).
- `GET /notifications/flush`: Manually trigger library cleanup digest flush.
- `GET /debug/requests`: Live log buffer of the last 50 incoming requests.
- `GET /ping`: Uptime monitor heartbeat.

## License

This project is licensed under the [MIT License](LICENSE).
