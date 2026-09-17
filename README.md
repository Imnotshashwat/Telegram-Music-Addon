# Telegram Music Addon

Self-hosted [BitChord](https://github.com/kushagrasinghx/BitChord) addon for streaming personal FLAC and hi-res audio from Telegram using GramJS and Express. Built for personal use.

BitChord searches this server whenever a track is requested. If the track is present in your Telegram channel, BitChord streams the original FLAC/ALAC file directly to ExoPlayer. If not, it falls back to Jio Saavan/YouTube Music.

## Features

- **Direct FLAC streaming**: Streams audio over HTTP 206 range requests without re-encoding.
- **In-memory indexing**: Maintains track metadata in memory to keep search latency under 5ms.
- **Title and artist matching**: Normalizes song titles and splits multi-artist tags to match queries from YouTube Music.
- **Quality deduplication**: Keeps track of bit depth, sample rate, and container formats, silently retaining higher-quality copies when duplicates are added without cluttering the channel.
- **`/keep` protection flag**: Add `/keep` or `#keep` in an audio caption to bypass deduplication and preserve multiple editions or cuts of the same song.
- **Interactive 7-track search**: Type `/s <name>` or `/song <name>` to browse 7 results per page with duration highlights, inline buttons `[ 1 ]`..`[ 7 ]`, and live paging (`[ ⬅️ ] [ ❌ ] [ ➡️ ]`).
- **User chatter auto-cleaner**: Purges casual chat, photos, stickers, and spam sent by regular users while keeping audio files, bot menus, and slash commands safe.
- **Silent operation**: Cleanup and quality upgrades happen in the background without channel spam.

## Why Telegram instead of Google Drive

Using a Telegram channel as your music vault gives you several practical benefits over Google Drive:

- **Free storage without account caps**: Google Drive limits free accounts to 15 GB shared across Drive, Gmail, and Google Photos. Lossless CD and 24-bit Hi-Res FLAC files run 30 MB to 100 MB each, so a 15 GB tier fills up after 200 to 300 songs. Telegram provides cloud storage across channels with no total account cap, letting you store thousands of FLAC tracks without monthly fees. Individual files can be up to 2 GB (4 GB with Telegram Premium).
- **No daily download quotas**: Google Drive flags frequent streaming and seeking with "Download quota exceeded for this file", locking playback for up to 24 hours. Telegram MTProto has no daily download quotas on your channel files.
- **Low-latency byte-range streaming (RFC 7233)**: Telegram's MTProto protocol pulls exact 64KB to 512KB slices on demand (`client.iterDownload`). This gives ExoPlayer fast seeking without OAuth2 token refreshes or redirect delays.
- **In-channel bot downloads**: You can search and download tracks via `@MusicsHuntersbot` directly in your channel without running local download scripts.

> [!WARNING]
> **Keep your channel Private:** Always set your storage channel to **Private** (using an invite link or numeric channel ID, not a public `@username`). Public channels are indexed by search engines and monitored by automated record label copyright bots, which can lead to copyright takedowns. Private channels are not indexed and remain safe for personal storage.

## Channel commands and music search

### Song Search and Downloads (`/s` or `/song`)
The addon listens for `/s` or `/song` commands in your channel and downloads tracks in lossless FLAC:

- **Interactive 7-Track Search:** Send `/s <song name>` or `/song <song name>` (for example, `/s brown rang`). TeleMusic searches Deezer through `@MusicsHuntersbot`:
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
  - **Highlighted Durations:** Track durations appear in monospace code bubbles so they are easy to distinguish from song titles.
  - **Inline Buttons (`TELEGRAM_BOT_TOKEN`):** If a bot token is configured, TeleMusic adds square buttons `[ 1 ]` to `[ 7 ]` and navigation buttons `[ ⬅️ ] [ ❌ ] [ ➡️ ]` under the message.
  - **Live Paging:** Tapping `➡️` or `⬅️` sends a click to `@MusicsHuntersbot` in the background, loads the next 7 tracks (like tracks 8 to 14 on page 2), and updates the message in place.
  - **Direct Download:** Tapping any number button (or typing `/1` to `/14`) downloads that track in lossless FLAC directly to your channel.
- **Direct Option Selection:** Skip the search menu by adding the number directly: `/s Kesariya 2` or `/song Kesariya 2`.
- **Direct Link Downloads:** Paste streaming links directly: `/s https://open.spotify.com/track/...` or Deezer, Tidal, or Qobuz URLs. TeleMusic downloads the track in original FLAC.

### Setting Up Inline Buttons with a Personal Bot
Telegram user accounts cannot post messages with inline keyboard buttons into channels. Connecting a personal bot lets TeleMusic attach clickable buttons under search results:

1. Open Telegram and message [@BotFather](https://t.me/BotFather).
2. Send `/newbot`, name your bot (for example, `MyMusicBot`), and give it a unique username ending in `bot` (for example, `my_music_vault_bot`).
3. Copy the HTTP API token BotFather gives you.
4. Add the token to your `.env` file (and in your cloud environment variables):
   ```env
   TELEGRAM_BOT_TOKEN="1234567890:ABCdefGHIjklMNOpqrsTUVwxyz"
   ```
5. Open your private music channel settings, go to **Administrators** > **Add Administrator**, search for your bot username, and turn on **Post Messages** and **Edit Messages** permissions.
6. Start the server (`npm start`). TeleMusic will now post search menus with inline buttons and process callback clicks.

### `/keep` Caption Flag
If you want to keep multiple versions of a song (such as a 16-bit FLAC alongside a 320kbps MP3 or a radio edit), include `/keep`, `#keep`, or `/ig` in the caption when uploading. The deduplication check will skip the file and keep both copies.

### User Chatter Auto-Cleaner
The channel listener removes casual chat messages, photos, stickers, GIFs, regular videos, and spam links sent by regular users.
- **Bot and System Immunity:** Messages from bots, menus with buttons, channel admin posts, system status updates, slash commands (`/`), and audio files are never deleted.

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
