# Telegram Music Addon

Self-hosted [BitChord](https://github.com/kushagrasinghx/BitChord) addon for streaming personal FLAC and hi-res audio from Telegram using GramJS and Express. Built for personal use.

BitChord searches this server whenever a track is requested. If the track is present in your Telegram channel, BitChord streams the original FLAC/ALAC file directly to ExoPlayer. If not, it falls back to Jio Saavan/YouTube Music.

## Features

- **Direct FLAC streaming**: Streams audio over HTTP 206 range requests without re-encoding.
- **In-memory indexing**: Maintains track metadata in memory to keep search latency under 5ms.
- **Title and artist matching**: Normalizes song titles and splits multi-artist tags to match queries from YouTube Music.
- **Quality deduplication**: Keeps track of bit depth, sample rate, and container formats, silently retaining higher-quality copies when duplicates are added without cluttering the channel.
- **`/keep` protection flag**: Add `/keep` or `#keep` in an audio caption to bypass deduplication and preserve multiple editions or cuts of the same song.
- **Interactive 5-option song search**: Type `/song <name>` in your channel to browse the top 5 results from downloader bots, then tap `/1` through `/5` to download directly in lossless FLAC.
- **Automatic channel cleaner**: Auto-purges incoming text chat, photos, stickers, and spam from the channel while keeping audio files and slash commands.
- **Silent operation**: Automatic cleanup and quality upgrades happen silently in the background with zero channel spam.

## Why Telegram instead of Google Drive

Using Telegram channels as a cloud music vault offers distinct advantages over Google Drive for personal streaming:

- **Uncapped storage for free**: Google Drive limits free accounts to 15 GB total across Drive, Gmail, and Google Photos. Lossless CD and 24-bit Hi-Res FLAC tracks typically run 30 MB to 100 MB each, meaning a 15 GB tier fills up in roughly 200 to 300 songs. Telegram provides free cloud storage across channels with no total account cap, letting you store thousands of FLAC tracks without monthly subscription fees. Individual files can be up to 2 GB (4 GB with Telegram Premium).
- **No daily download quotas or 24-hour bans**: Google Drive regularly flags frequent streaming and seeking with "Download quota exceeded for this file", locking playback for up to 24 hours. Telegram MTProto imposes no daily download quotas on your personal channel files.
- **Low-latency byte-range streaming (RFC 7233)**: Telegram's MTProto protocol allows pulling exact 64KB to 512KB slices on demand (`client.iterDownload`). This gives Android ExoPlayer instant seeking response without the overhead of OAuth2 token refreshes and REST redirects.
- **Direct in-chat bot automation**: Telegram allows interacting with music search bots (`@MusicsHuntersbot` and `@applemusicdw_bot`) directly within the channel, downloading tracks into your vault without running separate local download scripts.

> [!WARNING]
> **Keep your channel Private:** Always set your storage channel type to **Private** (accessed via numeric channel ID or invite link, not a public `@username`). Public channels are indexed by global search engines and monitored by automated record label crawlers (IFPI, Sony, T-Series), which can trigger copyright takedown bans. Private channels are not indexed and function safely as personal cloud storage.

## Channel commands and music search

### `/song` Downloader
The addon monitors your music channel for `/song` commands and downloads tracks directly into your vault:

- **Interactive Search with Pagination (10 Results):** Type `/song <song name>` (e.g. `/song brown rang`). TeleMusic queries `@MusicsHuntersbot` (Deezer/Qobuz FLAC) with relevance verification and Apple Music fallback (`@applemusicdw_bot`).
  - **With Bot Token (`TELEGRAM_BOT_TOKEN`):** Displays real Telegram inline UI buttons `[ 1️⃣ ] [ 2️⃣ ] [ 3️⃣ ] [ 4️⃣ ] [ 5️⃣ ]`, `[ ➡️ Next (6-10) ]`, `[ 🔄 Switch Catalog ]`, and `[ ❌ Cancel ]` directly under the message. Tapping Next flips in-place to options 6–10.
  - **Without Bot Token (Default):** Displays direct command links (`/1` through `/10`), plus `/next`, `/prev`, `/switch`, and `/cancel`.
- **One-Tap Catalog Switch:** If Deezer results don't have what you want, tap `[ 🔄 Try Apple Music ALAC ]` (or send `/switch`) to search Apple Music's 100M+ lossless library. No links needed—TeleMusic queries Apple's catalog API automatically.
- **Direct Option Selection:** Skip the menu by specifying the number directly: `/song Kesariya 2`.
- **Direct Link Downloads:** Paste streaming links directly: `/song https://open.spotify.com/track/...` or Apple Music / Deezer / Tidal URLs. TeleMusic downloads the exact track in Studio Lossless.

### `/keep` Caption Flag
If you intentionally want to keep multiple versions of a song (for example, a 16-bit FLAC alongside a 320kbps MP3 or a specific radio edit), include `/keep`, `#keep`, or `/ig` in the caption when uploading. The deduplication engine recognizes this tag and preserves both files permanently.

### Automatic Channel Cleaner
The channel listener automatically purges non-music clutter (casual text chat, photos, stickers, GIFs, regular videos, and spam links) to keep the music library clean. Audio files and commands beginning with `/` are preserved.

## How it works

1. You upload audio files (FLAC, ALAC, WAV, MP3, M4A) to a private Telegram channel.
2. The server authenticates with Telegram via MTProto (GramJS) using a user session, bypassing standard bot file size limits.
3. The server extracts audio metadata (title, artist, album, bit depth, sample rate) and builds a local index.
4. BitChord queries `/manifest.json`, `/search?q=...`, and `/stream/:id` using its pluggable source protocol.
5. BitChord's ExoPlayer streams audio directly through the `/audio/:id` endpoint.

### Exactly What Happens When You Tap a Song:

1. **Instant Playback (0–300ms):**  
   BitChord starts playing from **YouTube Music immediately** so you hear audio without any buffering delay.
2. **Parallel Background Race (Simultaneous):**  
   In the background, BitChord fires queries to **both** your Telegram Addon and JioSaavn at the exact same time.
3. **Quality Upgrade Hierarchy:**  
   * **Telegram FLAC (Lossless / 24-bit)** has the highest priority.
   * If the song is in your Telegram vault, BitChord skips JioSaavn and upgrades directly to **Telegram FLAC**.
   * If the song is not in Telegram, it upgrades to **JioSaavn (320 kbps)**.
   * If it's not on JioSaavn either, it stays on **YouTube Music (160 kbps)**.

> [!NOTE]
> If your cloud host was asleep (cold start) and takes a few seconds to wake up, JioSaavn might upgrade first for a second, then Telegram FLAC will seamlessly take over as soon as the server responds. Keep the server awake with a free pinger (see Step 5 below) to eliminate this delay completely.

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
| `TELEGRAM_BOT_TOKEN` | *(Optional)* Bot token from @BotFather to enable real square UI buttons `[ 1️⃣ ] [ 2️⃣ ] [ 3️⃣ ] [ 4️⃣ ] [ 5️⃣ ]` under `/song` results. If not set, the addon renders direct clickable `/1`–`/5` command links with zero setup required. |

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
- `GET /search?q=:query`: Sub-5ms in-memory search across indexed tracks.
- `GET /stream/:id`: Stream metadata and direct audio playback URL.
- `GET /audio/:id`: HTTP 206 range-enabled audio streaming.
- `GET /artwork/:id`: Embedded album artwork images.
- `GET /notifications/status`: Check deduplication status and active notification mode (`silent` or `active`).
- `GET /notifications/flush`: Manually trigger library cleanup digest flush.
- `GET /debug/requests`: Live log buffer of the last 50 incoming requests.
- `GET /ping`: Uptime monitor heartbeat.

## License

This project is licensed under the [MIT License](LICENSE).
