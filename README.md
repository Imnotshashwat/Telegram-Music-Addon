# Telegram Music Addon

Self-hosted [BitChord](https://github.com/kushagrasinghx/BitChord) addon for streaming personal FLAC and hi-res audio from Telegram using GramJS and Express. Built for personal use.

BitChord searches this server whenever a track is requested. If the track is present in your Telegram channel, BitChord streams the original FLAC/ALAC file directly to ExoPlayer. If not, it falls back to Jio Saavan/YouTube Music.

## Features

- **Direct FLAC streaming**: Streams audio over HTTP 206 range requests without re-encoding.
- **In-memory indexing**: Maintains track metadata in memory to keep search latency under 5ms.
- **Title and artist matching**: Normalizes song titles and splits multi-artist tags to match queries from YouTube Music.
- **Quality deduplication**: Keeps track of bit depth, sample rate, and container formats, silently retaining higher-quality copies when duplicates are added without cluttering the channel.
- **Automated bot downloads**: Includes a `/song` command to fetch tracks via Apple Music and music downloader bots directly into your channel.
- **Silent operation**: Automatic cleanup and quality upgrades happen 100% silently in the background with zero channel spam.

## How it works

1. You upload audio files (FLAC, ALAC, WAV, MP3, M4A) to a Telegram channel.
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
- A dedicated Telegram channel (public or private) for storing audio files

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
