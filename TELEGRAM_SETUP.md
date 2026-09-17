# Telegram Music Server Setup

Stream lossless and hi-res audio from a private Telegram channel into the BitChord Android app. If a track is not in your channel, BitChord falls back to YouTube Music or JioSaavn.

## Architecture

```
┌─────────────────────────────────┐
│     Telegram Private Channel    │ (FLAC storage)
└────────────────┬────────────────┘
                 │ MTProto
┌────────────────▼────────────────┐
│   Telegram Music Addon Server   │ (Node.js, GramJS, Express)
│   - /manifest.json              │
│   - /search?q=...               │
│   - /stream/:id                 │
│   - /artwork/:id                │
│   - /audio/:id (HTTP 206 range) │
└────────────────┬────────────────┘
                 │ HTTPS
┌────────────────▼────────────────┐
│      BitChord Android App       │ (Settings → Sources → Add Source)
└─────────────────────────────────┘
```

## Security

* **User session over Bot API:** Bots are capped at 20MB per file, while FLAC files are typically 25MB to 100MB+. Logging in as a user MTProto session removes that limit.
* **Account choice:** For personal daily listening, your main Telegram account works great and carries zero risk since you're just streaming one song at a time. If you plan to test heavy automated downloaders or share the server with friends, using a secondary account is a good habit.
* **Revoking access:** You can end the session anytime from your phone in Telegram Settings > Devices.

## 1. Get Telegram API credentials

1. Log in to [my.telegram.org](https://my.telegram.org) with your phone number.
2. Click **API development tools**.
3. Create an app (any title and short name work).
4. Save your `api_id` and `api_hash`.

## 2. Authenticate and create a session string

Run the login helper:

```bash
npm run login
```

Follow the prompts to enter:
1. `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` (if not already in `.env`)
2. Your phone number with country code (e.g. `+1234567890` or `+919876543210`)
3. The login code sent to your Telegram app
4. Your two-step password, if you have one enabled
5. Your channel username or ID

The script writes your credentials to `.env`.

## 3. Set up your Telegram channel
 
1. Create a channel in Telegram and select **Private Channel** (do NOT create a public channel with a `@handle`).
   * **Why Private:** Public channels are indexed by web search engines and scanned by automated record label copyright bots (IFPI, Sony, T-Series), which can lead to copyright infringement takedowns and channel bans. Private channels are not indexed and remain secure for personal cloud storage.
2. Get the numeric channel ID:
   * Forward any message from your private channel to `@userinfobot` or `@getidsbot` to retrieve the numeric ID (starts with `-100...`, e.g. `-1001234567890`).
3. Upload audio files:
   * Always upload audio as files or documents rather than compressed audio. Telegram compresses standard music uploads, which removes FLAC tags and degrades quality.
   * To keep multiple versions of the same song, add `/keep` or `#keep` in the caption, or reply to the uploaded file with `/keep` within the 15-second grace window.
   * The server indexes new files as soon as they reach the channel.

## 3.1 (Optional) Add a bot for inline buttons

Telegram user accounts cannot attach inline keyboard buttons in channels. If you want clickable square buttons (`[ 1 ]` to `[ 7 ]` and `[ ⬅️ ] [ ❌ ] [ ➡️ ]`) directly under search results:

1. Open Telegram and message [@BotFather](https://t.me/BotFather).
2. Type `/newbot` and follow the prompts to choose a name and username (for example, `MyMusicBot`).
3. Copy the HTTP API token BotFather gives you.
4. Add the token to `.env`:
   ```env
   TELEGRAM_BOT_TOKEN="1234567890:ABCdefGHIjklMNOpqrsTUVwxyz"
   ```
5. Open your channel settings, go to **Administrators** > **Add Administrator**, search for your bot username, and grant **Post Messages** and **Edit Messages** permissions.
6. When the addon runs, it will post search results using this bot and handle button clicks in the background.

## 3.2 Set @MusicsHuntersbot quality to FLAC / Hi-Res (one-time setup)

The addon downloads whatever audio quality your chat with `@MusicsHuntersbot` is currently set to. If you haven't configured it yet, it might send MP3s instead of FLAC.

1. Open a chat with [@MusicsHuntersbot](https://t.me/MusicsHuntersbot).
2. Send `/start` if you haven't yet.
3. Tap **Settings** (or send `/settings`).
4. Pick **Lossless** or **Hi-Res** (FLAC 16-bit 44.1kHz or 24-bit).
5. Telegram saves this preference for all future `/s` downloads.

> **Playlists:** `/s` downloads one song at a time. To grab an entire playlist, send the link directly to `@MusicsHuntersbot` in your private chat.

## 4. Run locally

```bash
npm start
```

Startup output looks like this:
```
Connecting to Telegram MTProto...
Connected to Telegram!
Using Telegram channel: My Music Channel
BitChord Addon server running on http://0.0.0.0:3000
Manifest URL: http://localhost:3000/manifest.json
Indexing Telegram channel...
Indexing complete! 25 track(s) ready in library.
```

Test it in your browser:
* `http://localhost:3000/manifest.json`
* `http://localhost:3000/search?q=test`

## 5. Expose over HTTPS

ExoPlayer on Android requires HTTPS.

### Option A: Render (Easiest)

Push to GitHub and connect the repository to a free Web Service on [Render](https://render.com). Set your environment variables in the Render dashboard.

### Option B: Fly.io

1. Install `flyctl`.
2. Create the app:
   ```bash
   fly launch --name my-telegram-music --no-deploy
   ```
3. Set your secrets:
   ```bash
   fly secrets set TELEGRAM_API_ID="your_api_id"
   fly secrets set TELEGRAM_API_HASH="your_api_hash"
   fly secrets set TELEGRAM_SESSION_STRING="your_session_string"
   fly secrets set TELEGRAM_CHANNEL="@your_channel_or_id"
   ```
4. Deploy:
   ```bash
   fly deploy
   ```

### Option C: Cloudflare Tunnel (Local Testing)

1. Install `cloudflared`.
2. Start the tunnel:
   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```
3. Use the generated `https://...trycloudflare.com` URL in BitChord.

## 6. Connect BitChord

1. Open **BitChord** on your phone.
2. Go to **Settings** > **Sources**.
3. Tap **Add Source** under Pluggable Sources.
4. Paste your server URL (e.g. `https://my-telegram-music.onrender.com`).
5. BitChord verifies `/manifest.json` and adds the source. When you play a track, BitChord looks for a match in your Telegram channel first.
