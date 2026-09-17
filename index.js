require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const bigInt = require('big-integer');
const { TelegramClient, utils } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram/tl');
const { NewMessage } = require('telegram/events');
const mm = require('music-metadata');
const {
  handleSongCommand,
  hasActivePicker,
  isPickerMenu,
  handlePickerChoice,
  cancelPicker,
  navigateBotPicker,
} = require('./downloader');

const app = express();
app.set('trust proxy', true);
app.use(cors());

function cleanEnv(val) {
  if (!val) return '';
  let s = String(val).trim();
  // Strip any wrapping quotes
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

const API_ID = parseInt(cleanEnv(process.env.TELEGRAM_API_ID), 10);
const API_HASH = cleanEnv(process.env.TELEGRAM_API_HASH);
let SESSION_STRING = cleanEnv(process.env.TELEGRAM_SESSION_STRING);
const CHANNEL = cleanEnv(process.env.TELEGRAM_CHANNEL);
const PORT = process.env.PORT || 3000;
const CACHE_FILE = path.join(__dirname, 'tracks_cache.json');

// GramJS StringSession requires the session string to begin with the version character "1"
if (SESSION_STRING && SESSION_STRING[0] !== '1') {
  const oneIdx = SESSION_STRING.indexOf('1');
  if (oneIdx !== -1) {
    SESSION_STRING = SESSION_STRING.slice(oneIdx);
  }
}

if (!API_ID || !API_HASH || !SESSION_STRING || !CHANNEL) {
  console.error('----------------------------------------------------------------');
  console.error('ERROR: Missing required environment variable in .env:');
  if (!API_ID) console.error('  - TELEGRAM_API_ID is missing');
  if (!API_HASH) console.error('  - TELEGRAM_API_HASH is missing');
  if (!SESSION_STRING) console.error('  - TELEGRAM_SESSION_STRING is missing (run "npm run login" first)');
  if (!CHANNEL) console.error('  - TELEGRAM_CHANNEL is missing (set your channel @name or ID)');
  console.error('----------------------------------------------------------------');
  process.exit(1);
}

const AUDIO_EXTENSIONS = ['flac', 'mp3', 'm4a', 'aac', 'wav', 'ogg', 'opus', 'alac'];
const EXT_TO_FORMAT = {
  flac: 'flac',
  mp3: 'mp3',
  m4a: 'm4a',
  aac: 'aac',
  wav: 'wav',
  ogg: 'ogg',
  opus: 'opus',
  alac: 'alac',
};

function isAudioDocument(doc) {
  if (!doc) return false;
  const mime = (doc.mimeType || '').toLowerCase();
  const fileNameAttr = doc.attributes?.find((a) => a.className === 'DocumentAttributeFilename');
  const fileName = fileNameAttr?.fileName || '';
  const ext = fileName.split('.').pop()?.toLowerCase() || '';

  const isAudioMime = mime.startsWith('audio/') || mime === 'application/ogg' || mime === 'application/x-flac';
  const isAudioExt = AUDIO_EXTENSIONS.includes(ext);
  const isAudioAttr = doc.attributes?.some((a) => a.className === 'DocumentAttributeAudio');

  return Boolean(isAudioMime || isAudioExt || isAudioAttr);
}

// Known composer duos that are hyphenated in FLAC tags but separated with & or comma on YouTube Music / BitChord
const COMPOSER_DUOS = [
  [/vishal[-\s–—]+shekhar/gi, 'Vishal & Shekhar'],
  [/sachin[-\s–—]+jigar/gi, 'Sachin & Jigar'],
  [/salim[-\s–—]+sulaiman/gi, 'Salim & Sulaiman'],
  [/shankar[-\s–—]+ehsaan[-\s–—]+loy/gi, 'Shankar & Ehsaan & Loy'],
  [/ajay[-\s–—]+atul/gi, 'Ajay & Atul'],
  [/sajid[-\s–—]+wajid/gi, 'Sajid & Wajid'],
  [/nadeem[-\s–—]+shravan/gi, 'Nadeem & Shravan'],
  [/jatin[-\s–—]+lalit/gi, 'Jatin & Lalit'],
  [/anand[-\s–—]+milind/gi, 'Anand & Milind'],
  [/laxmikant[-\s–—]+pyarelal/gi, 'Laxmikant & Pyarelal'],
  [/kalyanji[-\s–—]+anandji/gi, 'Kalyanji & Anandji'],
  [/shiv[-\s–—]+hari/gi, 'Shiv & Hari'],
  [/raam[-\s–—]+laxman/gi, 'Raam & Laxman'],
];

function formatArtistForClient(artistStr) {
  if (!artistStr || artistStr.trim().toLowerCase() === 'unknown artist') return 'Unknown Artist';
  let formatted = artistStr;
  for (const [pattern, replacement] of COMPOSER_DUOS) {
    formatted = formatted.replace(pattern, replacement);
  }
  // Also normalize generic " - " (space-dash-space) used to separate multiple artists in tags
  formatted = formatted.replace(/\s+[-–—]+\s+/g, ', ');
  return formatted.trim();
}

const client = new TelegramClient(new StringSession(SESSION_STRING), API_ID, API_HASH, {
  connectionRetries: 5,
});

let channelEntity = null;
let trackIndex = [];
let lastIndexed = 0;

// In-memory media cache: maps track ID string -> Telegram msg.media object
// Eliminates the redundant 1-2 second client.getMessages() round-trip on every seek
const mediaCache = new Map();

// Fast-Start buffer cache: maps track ID -> first 512KB of audio bytes (served from RAM for instant ExoPlayer start)
// 15 tracks × 512KB ≈ 7.6MB RAM – well within Render's 512MB free tier limit.
const fastStartCache = new Map();
const FAST_START_BYTES = 512 * 1024; // 512 KB – covers ~3-4 seconds of lossless FLAC audio

// In-memory request log ring buffer (keeps last 50 requests for production debugging)
const recentRequests = [];
function recordRequest(entry) {
  recentRequests.unshift(entry);
  if (recentRequests.length > 50) recentRequests.pop();
}

// Helper: load cached tracks from disk
function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = fs.readFileSync(CACHE_FILE, 'utf-8');
      trackIndex = JSON.parse(data);
      for (const t of trackIndex) {
        if (t.artist) t.artist = formatArtistForClient(t.artist);
      }
      console.log(`Loaded ${trackIndex.length} track(s) from local cache (${CACHE_FILE}).`);
    }
  } catch (err) {
    console.warn(`Could not load cache: ${err.message}`);
  }
}

// Helper: save cached tracks to disk
function saveCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(trackIndex, null, 2), 'utf-8');
  } catch (err) {
    console.warn(`Could not save cache: ${err.message}`);
  }
}

// Retrieve the Telegram msg.media object from RAM cache, or fetch once if not yet cached
async function getMediaForTrack(trackId) {
  const key = String(trackId);
  if (mediaCache.has(key)) {
    return mediaCache.get(key);
  }
  try {
    const messages = await client.getMessages(channelEntity, { ids: [parseInt(trackId, 10)] });
    if (messages && messages[0] && messages[0].media) {
      mediaCache.set(key, messages[0].media);
      return messages[0].media;
    }
  } catch (err) {
    console.error(`Failed to fetch media for track ${trackId}:`, err.message);
  }
  return null;
}

function extFromName(name) {
  const match = (name || '').match(/\.([a-zA-Z0-9]+)$/);
  return match ? match[1].toLowerCase() : '';
}

function getFileNameFromMessage(msg) {
  const attrs = msg.media?.document?.attributes || [];
  const fileNameAttr = attrs.find((a) => a instanceof Api.DocumentAttributeFilename || a.fileName);
  return fileNameAttr ? fileNameAttr.fileName : `file_${msg.id}`;
}

function getAudioAttr(msg) {
  const attrs = msg.media?.document?.attributes || [];
  return attrs.find((a) => a instanceof Api.DocumentAttributeAudio || (a.duration !== undefined && !a.w));
}

function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.get('host') || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

// Fetch a small chunk (128KB) of audio file to parse deep metadata (sample rate, bit depth, tags)
// without downloading the entire 50MB+ FLAC file.
async function getHeaderChunk(media, maxBytes = 128 * 1024) {
  const chunks = [];
  let downloaded = 0;
  try {
    const iter = client.iterDownload({
      file: media,
      offset: bigInt(0),
      requestSize: 64 * 1024,
    });
    for await (const chunk of iter) {
      chunks.push(chunk);
      downloaded += chunk.length;
      if (downloaded >= maxBytes) {
        iter.left = 0;
        await iter.close();
        break;
      }
    }
    return Buffer.concat(chunks).slice(0, maxBytes);
  } catch (err) {
    return null;
  }
}

// Pre-warm the fast-start buffer for a single track:
// Downloads the first FAST_START_BYTES of audio from Telegram and stores it in RAM.
// This lets ExoPlayer start playing within 0.3s (served from RAM) while the rest
// of the FLAC streams live from Telegram in the background.
async function prewarmFastStart(trackId, media) {
  if (fastStartCache.has(trackId)) return; // Already cached
  const chunks = [];
  let downloaded = 0;
  try {
    const iter = client.iterDownload({
      file: media,
      offset: bigInt(0),
      requestSize: 512 * 1024,
    });
    for await (const chunk of iter) {
      chunks.push(chunk);
      downloaded += chunk.length;
      if (downloaded >= FAST_START_BYTES) {
        iter.left = 0;
        await iter.close();
        break;
      }
    }
    const buf = Buffer.concat(chunks).slice(0, FAST_START_BYTES);
    if (buf.length > 0) {
      fastStartCache.set(trackId, buf);
      console.log(`[FastStart] Pre-warmed ${buf.length} bytes for track ${trackId}`);
    }
  } catch (err) {
    // Non-fatal: if pre-warm fails, streaming falls back to live MTProto normally
    console.warn(`[FastStart] Pre-warm failed for track ${trackId}: ${err.message}`);
  }
}

// Pre-warm all currently indexed tracks in the background (one at a time to avoid flooding MTProto)
async function prewarmAllTracks() {
  console.log(`[FastStart] Starting pre-warm for ${trackIndex.length} track(s)...`);
  for (const track of trackIndex) {
    if (fastStartCache.has(track.id)) continue;
    const media = mediaCache.get(track.id);
    if (!media) continue;
    await prewarmFastStart(track.id, media);
    // Small gap between downloads to avoid rate-limiting Telegram MTProto
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`[FastStart] Pre-warm complete! ${fastStartCache.size}/${trackIndex.length} track(s) cached in RAM.`);
}

async function parseTrackMessage(msg) {
  if (!msg.media || !msg.media.document) return null;

  // Cache media object in memory
  mediaCache.set(String(msg.id), msg.media);

  const doc = msg.media.document;
  const fileName = getFileNameFromMessage(msg);
  const ext = extFromName(fileName);
  const audioAttr = getAudioAttr(msg);

  // If extension is known audio OR document has audio attribute
  const isAudio = AUDIO_EXTENSIONS.includes(ext) || Boolean(audioAttr);
  if (!isAudio) return null;

  const resolvedExt = ext || 'mp3';
  const fallbackTitle = fileName.replace(/\.[^.]+$/, '');
  const sizeBytes = Number(doc.size) || 0;
  const hasArtwork = Boolean(doc.thumbs && doc.thumbs.length > 0);

  // Initial metadata from Telegram's instant attributes (zero network bytes!)
  let title = (audioAttr && audioAttr.title) ? audioAttr.title.trim() : fallbackTitle;
  let artist = (audioAttr && audioAttr.performer) ? audioAttr.performer.trim() : 'Unknown Artist';
  let duration = (audioAttr && audioAttr.duration) ? Math.round(audioAttr.duration) : undefined;
  let album = undefined;
  let sampleRate = undefined;
  let bitDepth = undefined;
  let isrc = undefined;

  // Inspect the first 128KB only if title or performer are missing from Telegram audio attributes
  const shouldSniffTags = (!audioAttr || !audioAttr.title || !audioAttr.performer) && sizeBytes > 0;
  let parsedCodec = null;
  if (shouldSniffTags) {
    try {
      const headerBuf = await getHeaderChunk(msg.media, Math.min(128 * 1024, sizeBytes));
      if (headerBuf && headerBuf.length > 0) {
        const parsed = await mm.parseBuffer(headerBuf, undefined, {
          duration: false,
          size: sizeBytes,
        });
        if (parsed.common) {
          if (parsed.common.title) title = parsed.common.title;
          if (parsed.common.artists && parsed.common.artists.length > 0) {
            artist = parsed.common.artists.join(', ');
          } else if (parsed.common.artist) {
            artist = parsed.common.artist;
          }
          if (parsed.common.album) album = parsed.common.album;
          if (parsed.common.isrc && parsed.common.isrc.length > 0) isrc = parsed.common.isrc[0];
        }
        if (parsed.format) {
          parsedCodec = parsed.format.codec;
          if (parsed.format.sampleRate) sampleRate = parsed.format.sampleRate;
          if (parsed.format.bitsPerSample) bitDepth = parsed.format.bitsPerSample;
          if (!duration && parsed.format.duration) duration = Math.round(parsed.format.duration);
        }
      }
    } catch (e) {
      // Non-fatal, keep attributes extracted from Telegram
    }
  }

  // Quality badge text & format resolution
  let formatName = EXT_TO_FORMAT[resolvedExt] || resolvedExt;
  let rawKbps = 0;
  if (sizeBytes && duration) {
    rawKbps = Math.round((sizeBytes * 8) / (duration * 1000));
  }

  // Detect ALAC in .m4a containers (Apple Music delivers ALAC in .m4a)
  if (formatName === 'm4a' && (parsedCodec === 'ALAC' || rawKbps > 500)) {
    formatName = 'alac';
    if (!bitDepth) bitDepth = rawKbps > 2000 ? 24 : 16;
    if (!sampleRate) sampleRate = 48000;
  }

  let qualityText = formatName.toUpperCase();
  if (bitDepth && sampleRate) {
    qualityText = `${bitDepth}-bit / ${(sampleRate / 1000).toFixed(1)}kHz ${formatName.toUpperCase()}`;
  } else if (['flac', 'wav', 'alac'].includes(formatName)) {
    qualityText = `16-bit / 44.1kHz ${formatName.toUpperCase()} Lossless`;
  } else {
    qualityText = `${formatName.toUpperCase()} (${Math.min(rawKbps || 320, 320)}kbps)`;
  }

  const msgText = (msg.message || msg.text || '').toLowerCase();
  const keep = msgText.includes('/keep') || msgText.includes('/ig') || msgText.includes('#keep');

  return {
    id: String(msg.id),
    title: title || fallbackTitle,
    artist: formatArtistForClient(artist || 'Unknown Artist'),
    album: album || undefined,
    duration: duration || undefined,
    format: formatName,
    sampleRate,
    bitDepth,
    quality: qualityText,
    isrc,
    hasArtwork,
    sizeBytes,
    mimeType: doc.mimeType || 'audio/mpeg',
    keep: keep ? true : undefined,
  };
}

// ── Smart Audio Quality Deduplication & Channel Notifications ──────────────

function getQualityScore(track) {
  const fmt = (track.format || '').toLowerCase();
  const isLossless = ['flac', 'wav', 'alac'].includes(fmt);
  if (isLossless) {
    const bits = track.bitDepth || 16;
    const rate = track.sampleRate || 44100;
    // Lossless base score is 1,000,000 + (bitDepth * sampleRate)
    // 24-bit / 192kHz = 5,608,000
    // 24-bit / 96kHz  = 3,304,000
    // 24-bit / 48kHz  = 2,152,000
    // 24-bit / 44.1kHz = 2,058,400
    // 16-bit / 44.1kHz = 1,705,600
    return 1000000 + (bits * rate);
  }

  // Lossy formats (opus, aac, m4a, mp3, ogg)
  let rawKbps = 320;
  if (track.sizeBytes && track.duration) {
    rawKbps = Math.round((track.sizeBytes * 8) / (track.duration * 1000));
  }

  // Codec efficiency multiplier for fair quality comparison:
  // Opus is modern and outperforms MP3 at lower bitrates (160kbps Opus ~ 320kbps MP3)
  // AAC / M4A has higher coding efficiency than MP3 (256kbps AAC ~ 320kbps MP3)
  let multiplier = 1.0;
  if (fmt === 'opus') multiplier = 1.5;
  else if (fmt === 'aac' || fmt === 'm4a') multiplier = 1.25;

  return Math.round(rawKbps * multiplier);
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function describeTrackQuality(track) {
  const fmt = (track.format || 'mp3').toUpperCase();
  if (track.bitDepth && track.sampleRate) {
    return `${track.bitDepth}-bit / ${(track.sampleRate / 1000).toFixed(1)}kHz ${fmt}`;
  }
  if (['FLAC', 'WAV', 'ALAC'].includes(fmt)) {
    return `16-bit / 44.1kHz ${fmt} (Lossless)`;
  }
  let kbps = 320;
  if (track.sizeBytes && track.duration) {
    kbps = Math.round((track.sizeBytes * 8) / (track.duration * 1000));
  }
  return `${fmt} (~${kbps}kbps)`;
}

function normalizeTitle(t) {
  if (!t) return '';
  return t
    .toLowerCase()
    .replace(/\((?:from|official|audio|video|lyrics|full song|remastered|hd|hq|club mix|feat\.?|ft\.?|radio edit|clean|explicit).*?\)/gi, '')
    .replace(/\[(?:from|official|audio|video|lyrics|full song|remastered|hd|hq|club mix|feat\.?|ft\.?|radio edit|clean|explicit).*?\]/gi, '')
    .replace(/\s*[-–—]\s*(?:radio edit|original mix|single|clean|explicit|from\s+.*?)$/gi, '')
    .replace(/[^\w\s]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function getCoreTitle(str) {
  if (!str) return '';
  // If title has "Artist - SongName", take the right side
  if (str.includes(' - ') || str.includes(' – ') || str.includes(' — ')) {
    const parts = str.split(/\s+[-–—]+\s+/);
    return normalizeTitle(parts[parts.length - 1]);
  }
  return normalizeTitle(str);
}

function normalizeArtist(a) {
  if (!a || a.toLowerCase() === 'unknown artist') return '';
  return a
    .toLowerCase()
    .replace(/[^\w\s]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isDuplicate(a, b) {
  if (a.id === b.id) return false;

  // Duration safeguard: if both tracks have known duration, allow up to 15s tolerance
  if (a.duration && b.duration && Math.abs(a.duration - b.duration) > 15) {
    return false;
  }

  const titleA = normalizeTitle(a.title);
  const titleB = normalizeTitle(b.title);
  const coreA = getCoreTitle(a.title);
  const coreB = getCoreTitle(b.title);

  if (!titleA || !titleB) return false;

  const titlesMatch = (titleA === titleB || coreA === coreB || titleA === coreB || coreA === titleB);
  if (titlesMatch) {
    const artistA = normalizeArtist(a.artist);
    const artistB = normalizeArtist(b.artist);
    if (artistA && artistB) {
      const wordsA = artistA.split(' ').filter((w) => w.length >= 2);
      const wordsB = artistB.split(' ').filter((w) => w.length >= 2);
      const hasCommonArtist = wordsA.some((w) => artistB.includes(w)) || wordsB.some((w) => artistA.includes(w));
      if (hasCommonArtist) return true;

      // When core title matches and duration is close (<= 6s), it's the same song
      if (a.duration && b.duration && Math.abs(a.duration - b.duration) <= 6) {
        return true;
      }
      return false;
    }
    return true;
  }

  return false;
}

// ── Silent Deduplication & Optional Notifications ───────────────────────────
// By default, duplicate cleanup and quality upgrades are 100% silent (no spam in channel).
// Set ENABLE_CHANNEL_NOTIFICATIONS=true in .env / Render if you want digest messages posted.
const ENABLE_CHANNEL_NOTIFICATIONS = process.env.ENABLE_CHANNEL_NOTIFICATIONS === 'true';

const NOTIF_STATE_FILE = path.join(__dirname, 'notification_state.json');
const DIGEST_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const RETENTION_MS = 12 * 60 * 60 * 1000; // 12 hours

let notifState = {
  pending: [],
  sentDigests: [],
  lastDigestSent: 0,
};

function loadNotificationState() {
  try {
    if (fs.existsSync(NOTIF_STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(NOTIF_STATE_FILE, 'utf-8'));
      if (data && Array.isArray(data.pending)) notifState.pending = data.pending;
      if (data && Array.isArray(data.sentDigests)) notifState.sentDigests = data.sentDigests;
      if (data && typeof data.lastDigestSent === 'number') notifState.lastDigestSent = data.lastDigestSent;
      console.log(`[NotificationState] Loaded: ${notifState.pending.length} pending, ${notifState.sentDigests.length} sent digest(s)`);
    }
  } catch (err) {
    console.warn('[NotificationState] Failed to load state:', err.message);
  }
}

function saveNotificationState() {
  try {
    fs.writeFileSync(NOTIF_STATE_FILE, JSON.stringify(notifState, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[NotificationState] Failed to save state:', err.message);
  }
}

function queueDuplicateNotification(item) {
  notifState.pending.push({
    timestamp: Date.now(),
    ...item,
  });
  saveNotificationState();
  console.log(`[Notification Queue] Queued notification for "${item.title}". Total pending: ${notifState.pending.length}`);
}

async function cleanupExpiredDigests() {
  if (!channelEntity || !notifState.sentDigests.length) return;
  const now = Date.now();
  const surviving = [];
  let changed = false;
  for (const digest of notifState.sentDigests) {
    if (now - digest.timestamp >= RETENTION_MS) {
      console.log(`[AutoDelete] Deleting 12h-old digest message ID: ${digest.id}`);
      await deleteTelegramMessage(digest.id);
      changed = true;
    } else {
      surviving.push(digest);
    }
  }
  if (changed) {
    notifState.sentDigests = surviving;
    saveNotificationState();
  }
}

async function flushDigestNotifications() {
  if (!channelEntity) {
    console.warn('[Digest] Channel entity not initialized yet, skipping digest.');
    return { sent: false, reason: 'Channel not ready' };
  }

  // 1. Purge expired digest messages (> 12 hours old) from Telegram channel
  await cleanupExpiredDigests();

  // If notifications are disabled (silent mode), keep library clean without posting to channel
  if (!ENABLE_CHANNEL_NOTIFICATIONS) {
    const cleared = notifState.pending.length;
    if (cleared > 0) {
      console.log(`[Silent Mode] Cleared ${cleared} duplicate notification(s) without posting to channel.`);
      notifState.pending = [];
      saveNotificationState();
    }
    return { sent: false, reason: 'Channel notifications disabled (silent mode)', cleared };
  }

  // 2. If no pending notifications, nothing to send
  if (notifState.pending.length === 0) {
    console.log('[Digest] No pending notifications to flush.');
    return { sent: false, reason: 'Queue empty', purgedExpired: notifState.sentDigests.length };
  }

  // 3. Format consolidated digest message
  const items = [...notifState.pending];
  const maxDisplay = 15;
  const displayed = items.slice(0, maxDisplay);
  const remainingCount = items.length - displayed.length;

  let text = `🧹 <b>Library Cleanup Digest (30m Summary)</b>\n\n`;
  for (const item of displayed) {
    let actionLabel = 'Duplicate Removed';
    if (item.action === 'upgrade') {
      actionLabel = 'Quality Upgrade (Better FLAC kept)';
    } else if (item.reason === 'lower_quality') {
      actionLabel = 'Lower Quality (Better version already in library)';
    } else if (item.reason === 'identical' || item.reason === 'identical_duplicate') {
      actionLabel = 'Identical Duplicate (Exact match already present)';
    } else if (item.action === 'cleanup') {
      actionLabel = item.reason === 'lower_quality' ? 'Lower Quality Removed' : 'Identical Duplicate Cleaned';
    }

    text += `• <b>${item.title}</b> — <i>${item.artist}</i>\n`;
    text += `  ✅ Kept: ${item.keptQuality} [${item.keptSize}]\n`;
    text += `  ❌ Deleted: ${item.deletedQuality} [${item.deletedSize}]\n`;
    text += `  <i>Reason: ${actionLabel}</i>\n\n`;
  }

  if (remainingCount > 0) {
    text += `<i>... and ${remainingCount} more track(s) cleaned.</i>\n\n`;
  }

  text += `📊 <b>Total:</b> ${items.length} duplicate(s) cleaned.\n`;
  text += `⏳ <i>This notification automatically deletes after 12 hours.</i>`;

  const now = Date.now();
  try {
    const sent = await client.sendMessage(channelEntity, { message: text, parseMode: 'html' });
    if (sent && sent.id) {
      notifState.sentDigests.push({
        id: sent.id,
        timestamp: now,
        count: items.length,
      });
      notifState.pending = [];
      notifState.lastDigestSent = now;
      saveNotificationState();
      console.log(`[Digest Sent] Sent digest message ID: ${sent.id} with ${items.length} items.`);
      return { sent: true, messageId: sent.id, count: items.length };
    }
  } catch (err) {
    console.error('[Digest Error] Failed to send digest:', err.message);
    return { sent: false, error: err.message };
  }

  return { sent: false };
}

function checkDigestSchedule() {
  const now = Date.now();
  if (now - notifState.lastDigestSent >= DIGEST_INTERVAL_MS) {
    flushDigestNotifications().catch((e) => console.error('[Digest Scheduler Error]:', e.message));
  } else {
    cleanupExpiredDigests().catch((e) => console.error('[AutoDelete Error]:', e.message));
  }
}

async function sendChannelNotification(text) {
  try {
    if (channelEntity) {
      await client.sendMessage(channelEntity, { message: text });
      console.log('[Channel Notification Sent]');
    }
  } catch (err) {
    console.warn('[Channel Notification Error]:', err.message);
  }
}

// Pending duplicate deletions: maps messageId (string) -> { timer, track, existingDup, reason }
// Gives user a 15-second grace window to reply with /keep if they want to preserve the duplicate
const pendingDeletions = new Map();
const DUPLICATE_GRACE_PERIOD_MS = 15000; // 15 seconds

function cancelPendingDeletion(messageId) {
  const key = String(messageId);
  if (pendingDeletions.has(key)) {
    const pending = pendingDeletions.get(key);
    clearTimeout(pending.timer);
    pendingDeletions.delete(key);
    if (pending.noticeMsgId && channelEntity) {
      deleteTelegramMessages([pending.noticeMsgId]).catch(() => {});
    }
    console.log(`[Keep Flag] Cancelled pending deletion for message ID: ${key}`);
    return pending;
  }
  return null;
}

async function deleteTelegramMessages(messageIds) {
  try {
    if (!channelEntity || !Array.isArray(messageIds) || messageIds.length === 0) return false;
    const ids = messageIds
      .map((id) => (typeof id === 'number' ? id : parseInt(id, 10)))
      .filter((id) => typeof id === 'number' && !isNaN(id) && id > 0);

    if (ids.length === 0) return false;

    await client.deleteMessages(channelEntity, ids, { revoke: true });
    console.log(`[Deleted Telegram Messages] IDs: ${ids.join(', ')}`);
    return true;
  } catch (err) {
    console.warn(`[Delete Messages Error] IDs ${JSON.stringify(messageIds)}:`, err.message);
    // Fallback: try deleting individually if batch failed
    for (const rawId of messageIds) {
      const singleId = typeof rawId === 'number' ? rawId : parseInt(rawId, 10);
      if (singleId && !isNaN(singleId) && singleId > 0) {
        await client.deleteMessages(channelEntity, [singleId], { revoke: true }).catch((e) => {
          console.warn(`[Delete Message Fallback Error] ID ${singleId}:`, e.message);
        });
      }
    }
  }
  return false;
}

async function deleteTelegramMessage(messageId) {
  return deleteTelegramMessages([messageId]);
}

async function processTrackUpload(newTrack) {
  // If track is explicitly flagged to keep, index it and skip duplicate deletion
  if (newTrack.keep) {
    trackIndex.unshift(newTrack);
    saveCache();
    console.log(`[Keep Flag] Track "${newTrack.title}" marked with /keep. Preserving without deduplication.`);
    return newTrack;
  }

  const existingDup = trackIndex.find((t) => !t.keep && isDuplicate(t, newTrack));
  if (!existingDup) {
    trackIndex.unshift(newTrack);
    saveCache();
    console.log(`Auto-indexed new track: "${newTrack.title}" by "${newTrack.artist}" (${describeTrackQuality(newTrack)})`);
    return newTrack;
  }

  const scoreNew = getQualityScore(newTrack);
  const scoreOld = getQualityScore(existingDup);

  console.log(`Duplicate detected for "${newTrack.title}"! Incoming score: ${scoreNew}, Existing score: ${scoreOld}`);

  if (scoreNew > scoreOld) {
    // Incoming track is HIGHER quality (e.g. 24/192 replacing 16/44.1, or FLAC replacing MP3)
    console.log(`Upgrading "${newTrack.title}" from ${describeTrackQuality(existingDup)} to ${describeTrackQuality(newTrack)}`);

    await deleteTelegramMessage(existingDup.id);

    const oldIdx = trackIndex.findIndex((t) => t.id === existingDup.id);
    if (oldIdx >= 0) {
      trackIndex.splice(oldIdx, 1);
    }
    trackIndex.unshift(newTrack);
    saveCache();

    queueDuplicateNotification({
      action: 'upgrade',
      title: newTrack.title,
      artist: newTrack.artist,
      keptQuality: describeTrackQuality(newTrack),
      keptSize: formatBytes(newTrack.sizeBytes),
      deletedQuality: describeTrackQuality(existingDup),
      deletedSize: formatBytes(existingDup.sizeBytes),
    });

    return newTrack;
  } else {
    // Incoming track is LOWER or EQUAL quality: schedule deletion with 15s grace window!
    const isLower = scoreNew < scoreOld;
    const reason = isLower ? 'lower_quality' : 'identical';
    console.log(`Scheduling duplicate deletion for "${newTrack.title}" (ID: ${newTrack.id}) in ${DUPLICATE_GRACE_PERIOD_MS / 1000}s. Reply with /keep to preserve it.`);

    let noticeMsg = null;
    if (channelEntity) {
      const noticeText = isLower
        ? `**Duplicate detected:** Lower quality (${describeTrackQuality(newTrack)}) than existing copy (${describeTrackQuality(existingDup)}). Deleting in 15s... (Send \`/keep\` to save)`
        : `**Duplicate detected:** Identical copy already in library. Deleting in 15s... (Send \`/keep\` to save)`;

      noticeMsg = await client.sendMessage(channelEntity, {
        message: noticeText,
        replyTo: parseInt(newTrack.id, 10),
      }).catch(() => null);
    }

    const timer = setTimeout(async () => {
      pendingDeletions.delete(String(newTrack.id));
      console.log(`[Grace Period Expired] Deleting duplicate track: "${newTrack.title}" (ID: ${newTrack.id})`);
      const msgsToDelete = [newTrack.id];
      if (noticeMsg && noticeMsg.id) msgsToDelete.push(noticeMsg.id);
      await deleteTelegramMessages(msgsToDelete);

      queueDuplicateNotification({
        action: 'discard',
        reason,
        title: newTrack.title,
        artist: newTrack.artist,
        keptQuality: describeTrackQuality(existingDup),
        keptSize: formatBytes(existingDup.sizeBytes),
        deletedQuality: describeTrackQuality(newTrack),
        deletedSize: formatBytes(newTrack.sizeBytes),
      });
    }, DUPLICATE_GRACE_PERIOD_MS);

    pendingDeletions.set(String(newTrack.id), {
      timer,
      track: newTrack,
      existingDup,
      reason,
      noticeMsgId: noticeMsg?.id || null,
    });

    return {
      discarded: true,
      reason,
      keptQuality: describeTrackQuality(existingDup),
      deletedQuality: describeTrackQuality(newTrack),
    };
  }
}

async function deduplicateEntireLibrary() {
  console.log('Scanning library for duplicates...');
  const removed = [];
  const sorted = [...trackIndex].sort((a, b) => getQualityScore(b) - getQualityScore(a));
  const kept = [];

  for (const track of sorted) {
    // Never auto-delete tracks flagged with keep
    if (track.keep) {
      kept.push(track);
      continue;
    }

    const dup = kept.find((k) => !k.keep && isDuplicate(k, track));
    if (!dup) {
      kept.push(track);
    } else {
      console.log(`Removing duplicate: "${track.title}" (ID: ${track.id}) in favor of (ID: ${dup.id})`);
      await deleteTelegramMessage(track.id);
      removed.push({ deleted: track, kept: dup });

      const isLower = getQualityScore(track) < getQualityScore(dup);
      queueDuplicateNotification({
        action: 'cleanup',
        reason: isLower ? 'lower_quality' : 'identical',
        title: dup.title,
        artist: dup.artist,
        keptQuality: describeTrackQuality(dup),
        keptSize: formatBytes(dup.sizeBytes),
        deletedQuality: describeTrackQuality(track),
        deletedSize: formatBytes(track.sizeBytes),
      });
    }
  }

  if (removed.length > 0) {
    trackIndex = kept;
    saveCache();
    console.log(`Deduplication complete! Removed ${removed.length} duplicate(s).`);
    await flushDigestNotifications();
  } else {
    console.log('Deduplication check: Library is 100% clean, no duplicates found.');
  }

  await cleanupOrphanedDuplicateNotices().catch(() => {});

  return { checked: sorted.length, duplicatesRemoved: removed.length, removed };
}

async function buildTrackIndex() {
  console.log('Indexing Telegram channel (adaptive full history scan)...');
  try {
    const newIndex = [];
    const seenIds = new Set();
    let batchCount = 0;

    // GramJS iterMessages streams through channel history from newest to oldest.
    // Specifying limit: 5000 with waitTime: 0 guarantees full fast iteration without GramJS timeout warnings.
    for await (const msg of client.iterMessages(channelEntity, { limit: 5000, waitTime: 0 })) {
      const msgIdStr = String(msg.id);
      if (seenIds.has(msgIdStr)) continue;
      seenIds.add(msgIdStr);

      // Fast check: If message has no document or is not an audio file, skip immediately
      const doc = msg.media?.document;
      if (!doc || !isAudioDocument(doc)) {
        continue;
      }

      // Always cache media object for instant seeking
      mediaCache.set(msgIdStr, msg.media);

      // Check if we already have this message ID cached with full metadata
      const existing = trackIndex.find((t) => t.id === msgIdStr);
      if (existing) {
        if (!existing.sizeBytes && doc.size) {
          existing.sizeBytes = Number(doc.size);
        }
        newIndex.push(existing);
      } else {
        const parsed = await parseTrackMessage(msg);
        if (parsed) {
          newIndex.push(parsed);
        }
      }

      batchCount++;
      if (batchCount % 50 === 0) {
        trackIndex = [...newIndex];
        console.log(`[Indexer] Indexed ${newIndex.length} audio tracks... (latest msg ID: ${msgIdStr})`);
      }
    }

    trackIndex = newIndex;
    lastIndexed = Date.now();
    saveCache();
    console.log(`Adaptive indexing complete! Scanned ${batchCount} total messages. ${trackIndex.length} track(s) ready in library.`);
    await deduplicateEntireLibrary();
  } catch (err) {
    console.error('Error during adaptive track indexing:', err.message);
  }
}

function findTrack(id) {
  return trackIndex.find((t) => t.id === id);
}

// ── BitChord / Stremio Addon Endpoints ─────────────────────────────────────

// Manifest: BitChord queries this to verify addon id, name, and capabilities
app.get('/manifest.json', (req, res) => {
  res.json({
    id: 'com.personal.telegrammusic',
    name: 'Telegram Music',
    version: `1.9.1 • ${trackIndex.length} songs`,
    description: 'Personal hi-res, lossless, and high-quality music library streamed directly from Telegram',
    resources: ['search', 'stream'],
    types: ['track'],
    contentType: 'music',
  });
});

// Deduplication trigger endpoint: triggers on-demand library scan and cleaning
app.get('/deduplicate', async (req, res) => {
  try {
    const result = await deduplicateEntireLibrary();
    res.json({
      status: 'ok',
      checkedTracks: result.checked,
      duplicatesRemoved: result.duplicatesRemoved,
      details: result.removed.map((r) => ({
        track: r.kept.title,
        artist: r.kept.artist,
        kept: describeTrackQuality(r.kept),
        deleted: describeTrackQuality(r.deleted),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Notification status endpoint: check queued duplicate notifications and digest history
app.get('/notifications/status', (req, res) => {
  const now = Date.now();
  const nextDueMs = Math.max(0, DIGEST_INTERVAL_MS - (now - notifState.lastDigestSent));
  res.json({
    status: 'ok',
    channelNotificationsEnabled: ENABLE_CHANNEL_NOTIFICATIONS,
    mode: ENABLE_CHANNEL_NOTIFICATIONS ? 'active' : 'silent',
    pendingCount: notifState.pending.length,
    pending: notifState.pending,
    sentDigestsCount: notifState.sentDigests.length,
    sentDigests: notifState.sentDigests,
    lastDigestSent: notifState.lastDigestSent ? new Date(notifState.lastDigestSent).toISOString() : 'never',
    nextDigestDueInMinutes: Math.round(nextDueMs / 60000),
  });
});

// Manual digest trigger: flush pending duplicate/deleted notifications to Telegram channel now
app.get('/notifications/flush', async (req, res) => {
  try {
    const result = await flushDigestNotifications();
    res.json({
      status: 'ok',
      result,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const ARTIST_SEPARATORS_REGEX = /\s*(?:[,&/;·|]|\band\b|\bx\b|\bvs\.?\b|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b|\bwith\b)\s*/i;
const BRACKETED_REGEX = /[([][^()[\]]*[)\]]/g;
const NOISE_WORDS_REGEX = /\b(?:official|video|audio|lyrics|lyric|lyrical|song|songs|full|hd|hq|4k|mp3|flac|ost|soundtrack|remaster|remastered)\b/gi;

function extractCoreTitle(title) {
  if (!title) return '';
  let clean = title.toLowerCase();
  clean = clean.replace(BRACKETED_REGEX, ' ');
  clean = clean.replace(NOISE_WORDS_REGEX, ' ');
  clean = clean.replace(/[^a-z0-9\s]/g, ' ');
  return clean.replace(/\s+/g, ' ').trim();
}

function parseArtistTokens(artistStr) {
  if (!artistStr) return [];
  const parts = artistStr.toLowerCase().split(ARTIST_SEPARATORS_REGEX);
  const result = [];
  for (const p of parts) {
    const words = p.replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1);
    if (words.length > 0) {
      result.push(words);
    }
  }
  return result;
}

function runOf(outer, inner) {
  if (!inner.length || inner.length > outer.length) return false;
  for (let i = 0; i <= outer.length - inner.length; i++) {
    let match = true;
    for (let j = 0; j < inner.length; j++) {
      if (outer[i + j] !== inner[j]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

function sameArtist(aWords, bWords) {
  return runOf(aWords, bWords) || runOf(bWords, aWords);
}

function sharesArtist(queryArtistStr, trackArtistStr) {
  const queryArtists = parseArtistTokens(queryArtistStr);
  const trackArtists = parseArtistTokens(trackArtistStr);
  if (queryArtists.length === 0 || trackArtists.length === 0) return false;

  return queryArtists.some((q) => trackArtists.some((t) => sameArtist(q, t)));
}

function scoreTrackMatch(track, query) {
  if (!query) return 100;
  const qClean = query.toLowerCase().trim();
  const trackTitleCore = extractCoreTitle(track.title);
  const trackArtist = (track.artist || '').toLowerCase();
  const trackAlbum = (track.album || '').toLowerCase();

  // Fast direct match
  const fullText = `${track.title} ${track.artist} ${track.album || ''}`.toLowerCase();
  if (fullText.includes(qClean)) return 180;

  const queryCore = extractCoreTitle(qClean);

  // 1. Exact Core Title Match
  if (queryCore === trackTitleCore) {
    return 100;
  }

  // 2. Query begins with Track Core Title (e.g. "party on my mind pritam")
  if (queryCore.startsWith(trackTitleCore) || trackTitleCore.startsWith(queryCore)) {
    const extraWords = queryCore.replace(trackTitleCore, '').trim();
    if (!extraWords) {
      return 100;
    }
    // Check if extra words match any artist using BitChord's sameArtist/runOf
    if (sharesArtist(extraWords, track.artist)) {
      return 150; // Exact title + verified shared artist = Top Match!
    }
    // Check if extra words match album
    if (trackAlbum && trackAlbum.includes(extraWords)) {
      return 120;
    }
    // Title matched, but extra words are present (e.g. composer, record label, video tags).
    // Return 85 so BitChord receives the candidate and its client-side TrackMatcher validates duration/artist.
    return 85;
  }

  // 3. Token-based fallback matching
  const queryTokens = qClean.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 1);
  const titleTokens = trackTitleCore.split(/\s+/).filter(Boolean);
  const allTrackTokens = new Set([
    ...titleTokens,
    ...trackArtist.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean),
    ...trackAlbum.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean),
  ]);

  const allTitleMatched = titleTokens.length > 0 && titleTokens.every((tw) => queryTokens.includes(tw));
  if (allTitleMatched) {
    const hasArtistToken = queryTokens.some((qw) => !titleTokens.includes(qw) && allTrackTokens.has(qw));
    return hasArtistToken ? 140 : 90;
  }

  const matchCount = queryTokens.filter((t) => allTrackTokens.has(t)).length;
  const ratio = matchCount / queryTokens.length;
  if (ratio >= 0.6) {
    return Math.round(ratio * 80);
  }

  return 0;
}

async function onTrackForwarded(msg) {
  try {
    const track = await parseTrackMessage(msg);
    if (track) {
      const processed = await processTrackUpload(track);
      if (processed && processed.discarded) {
        return processed;
      }
      console.log(`[AutoIndex] Successfully indexed newly uploaded track: "${track.title}" (ID: ${track.id})`);
      return { indexed: true, track: processed };
    }
  } catch (err) {
    console.warn('[AutoIndex] Error indexing forwarded track:', err.message);
  }
  return null;
}

// Search: BitChord calls /search?q=... to find tracks (100% in-memory for instant < 5ms response!)
app.get('/search', async (req, res) => {
  const startTime = Date.now();
  try {
    // Refresh index periodically in background (every 30 minutes)
    if (Date.now() - lastIndexed > 30 * 60 * 1000) {
      buildTrackIndex().catch((e) => console.error('Background index error:', e.message));
    }

    const q = (req.query.q || '').toLowerCase().trim();
    const base = getBaseUrl(req);

    let matches = trackIndex;
    if (q) {
      matches = trackIndex
        .map((t) => ({ track: t, score: scoreTrackMatch(t, q) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((item) => item.track);
    }

    const elapsed = Date.now() - startTime;
    recordRequest({
      timestamp: new Date().toISOString(),
      type: 'search',
      query: req.query.q || '',
      tier: req.query.quality || 'NONE',
      resultsCount: matches.length,
      topResult: matches[0] ? `${matches[0].title} - ${matches[0].artist} (${matches[0].duration}s)` : null,
      elapsedMs: elapsed,
    });

    res.json({
      tracks: matches.slice(0, 60).map((t) => ({
        id: t.id,
        title: t.title,
        artist: formatArtistForClient(t.artist),
        album: t.album || '',
        duration: t.duration,
        format: t.format,
        audioQuality: t.quality || 'lossless',
        artworkURL: t.hasArtwork ? `${base}/artwork/${t.id}` : undefined,
        albumArtworkURL: t.hasArtwork ? `${base}/artwork/${t.id}` : undefined,
        streamURL: `${base}/audio/${t.id}`,
        isrc: t.isrc,
      })),
    });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Stream info: BitChord queries this for stream metadata and direct playback URL
app.get('/stream/:id', (req, res) => {
  const track = findTrack(req.params.id);
  const base = getBaseUrl(req);

  recordRequest({
    timestamp: new Date().toISOString(),
    type: 'stream',
    id: req.params.id,
    track: track ? `${track.title} - ${track.artist}` : 'NOT_FOUND',
    quality: track ? track.quality : 'UNKNOWN',
    tier: req.query.quality || 'NONE',
  });

  res.json({
    url: `${base}/audio/${req.params.id}`,
    format: track ? track.format : 'flac',
    codec: track ? track.format : 'flac',
    container: track ? track.format : 'flac',
    manifest: 'none',
    encrypted: false,
    sampleRate: track ? track.sampleRate : undefined,
    bitDepth: track ? track.bitDepth : undefined,
    quality: track ? track.quality : undefined,
    streamQuality: track ? track.quality : undefined,
  });
});

// Artwork thumbnail endpoint: serves album cover directly to BitChord
app.get('/artwork/:id', async (req, res) => {
  try {
    const track = findTrack(req.params.id);
    if (!track) return res.status(404).send('Track not found');

    const media = await getMediaForTrack(req.params.id);
    if (!media || !media.document) return res.status(404).send('Media not found');

    const doc = media.document;
    const thumbs = doc.thumbs || [];
    if (!thumbs.length) return res.status(404).send('No artwork thumbnail');

    // 1. Instant response if stripped photo is available (0ms network request)
    const stripped = thumbs.find((t) => t instanceof Api.PhotoStrippedSize);
    if (stripped) {
      const jpg = utils.strippedPhotoToJpg(stripped.bytes);
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.send(jpg);
    }

    // 2. Download thumbnail via GramJS
    const thumbBuf = await client.downloadMedia(media, { thumb: 0 });
    if (!thumbBuf || thumbBuf.length === 0) {
      return res.status(404).send('No artwork thumbnail');
    }

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(thumbBuf);
  } catch (err) {
    console.error('Artwork fetch error:', err.message);
    res.status(404).send('Artwork not available');
  }
});

// Audio streaming: BitChord streams audio bytes with HTTP 206 Range support,
// instant seeking via in-memory media caching, backpressure control, and immediate abort on client skip/seek.
app.get('/audio/:id', async (req, res) => {
  const reqStart = Date.now();
  let isConnectionClosed = false;
  let iterator = null;

  req.on('close', () => {
    isConnectionClosed = true;
    if (iterator) {
      iterator.left = 0;
      if (typeof iterator.close === 'function') {
        iterator.close().catch(() => {});
      }
    }
  });

  try {
    const track = findTrack(req.params.id);
    if (!track) return res.status(404).send('Track not found');

    // 0ms lookup from in-memory media cache (avoids Telegram API network call!)
    const media = await getMediaForTrack(req.params.id);
    if (!media) return res.status(404).send('Media not found');

    if (isConnectionClosed) return;

    // Bulletproof totalSize: fallback to media.document.size, never allow NaN
    const totalSize = Number(track.sizeBytes) || Number(media.document?.size) || 0;
    if (!totalSize || isNaN(totalSize)) {
      console.error(`Invalid totalSize for track ${req.params.id}`);
      return res.status(500).send('Unable to determine audio file size');
    }
    if (!track.sizeBytes) {
      track.sizeBytes = totalSize;
    }

    let start = 0;
    let end = totalSize - 1;
    let isRange = false;

    const range = req.headers.range;
    if (range) {
      const match = range.match(/bytes=(\d*)-(\d*)/);
      if (match) {
        if (match[1] === '' && match[2] !== '') {
          // Suffix range: bytes=-500 (request last 500 bytes)
          const suffix = parseInt(match[2], 10);
          start = Math.max(0, totalSize - suffix);
          end = totalSize - 1;
          isRange = true;
        } else if (match[1] !== '') {
          start = parseInt(match[1], 10);
          end = match[2] !== '' ? parseInt(match[2], 10) : totalSize - 1;
          isRange = true;
        }
      }
    }

    if (isRange && (start >= totalSize || start > end)) {
      res.setHeader('Content-Range', `bytes */${totalSize}`);
      return res.status(416).end();
    }

    // Strictly clamp boundaries to valid byte positions
    start = Math.max(0, Math.min(start, totalSize - 1));
    end = Math.max(start, Math.min(end, totalSize - 1));
    const bytesNeeded = end - start + 1;

    recordRequest({
      timestamp: new Date().toISOString(),
      type: 'audio',
      id: req.params.id,
      range: range || 'none',
      bytes: `${start}-${end}/${totalSize}`,
      bytesNeeded,
      track: `${track.title} - ${track.artist}`,
    });

    res.status(isRange ? 206 : 200);
    res.setHeader('Content-Type', track.mimeType || (track.format === 'flac' ? 'audio/flac' : 'application/octet-stream'));
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Keep-Alive', 'timeout=30, max=100');
    res.setHeader('Content-Length', bytesNeeded);
    if (isRange) {
      res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
    }

    // Dynamic MTProto block size:
    // For small probes (<= 128KB), use 64KB/128KB to respond in sub-100ms without socket congestion.
    // For normal/large streaming, use 512KB for maximum line-rate throughput.
    // Must be a multiple of 4096 (MIN_CHUNK_SIZE) between 64KB and 512KB.
    const dynamicBlockSize = Math.min(
      512 * 1024,
      Math.max(64 * 1024, Math.ceil(bytesNeeded / 4096) * 4096)
    );

    // Stream directly from Telegram MTProto from the requested byte offset.
    let bytesSent = 0;

    iterator = client.iterDownload({
      file: media,
      offset: bigInt(start),
      requestSize: dynamicBlockSize,
    });

    for await (const chunk of iterator) {
      if (isConnectionClosed || res.writableEnded || res.destroyed) {
        iterator.left = 0;
        await iterator.close().catch(() => {});
        break;
      }

      let toSend = chunk;
      let shouldBreak = false;

      if (bytesSent + chunk.length > bytesNeeded) {
        toSend = chunk.slice(0, bytesNeeded - bytesSent);
        shouldBreak = true;
      }

      bytesSent += toSend.length;
      if (bytesSent >= bytesNeeded) {
        shouldBreak = true;
      }

      // Handle backpressure: pause pulling chunks if client network buffer is full
      const canContinue = res.write(toSend);
      if (!canContinue && !res.writableEnded && !res.destroyed && !isConnectionClosed) {
        await new Promise((resolve) => {
          const onDrain = () => {
            req.removeListener('close', onClose);
            resolve();
          };
          const onClose = () => {
            res.removeListener('drain', onDrain);
            resolve();
          };
          res.once('drain', onDrain);
          req.once('close', onClose);
        });
      }

      if (shouldBreak || isConnectionClosed) {
        iterator.left = 0;
        await iterator.close().catch(() => {});
        break;
      }
    }

    if (!res.writableEnded && !isConnectionClosed) {
      res.end();
    }
  } catch (err) {
    if (!isConnectionClosed && !res.destroyed) {
      console.error(`Audio stream error for track ${req.params.id}:`, err.message);
      if (!res.headersSent) res.status(500).send(err.message);
      else res.end();
    }
  }
});

// Manual refresh endpoint
app.get('/refresh', async (req, res) => {
  try {
    await buildTrackIndex();
    res.json({ ok: true, count: trackIndex.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lightweight ping for uptime monitors / keep-alive pingers
app.get('/ping', (req, res) => {
  res.send('pong');
});

// Live debug endpoint: returns the last 50 incoming requests and their responses
app.get('/debug/requests', (req, res) => {
  res.json({
    status: 'ok',
    totalTrackCount: trackIndex.length,
    recordedRequestsCount: recentRequests.length,
    requests: recentRequests,
  });
});

// Fast-Start cache inspection endpoint
app.get('/debug/faststart', (req, res) => {
  const entries = trackIndex.map((t) => ({
    id: t.id,
    title: t.title,
    artist: t.artist,
    cached: fastStartCache.has(t.id),
    cachedBytes: fastStartCache.has(t.id) ? fastStartCache.get(t.id).length : 0,
  }));
  res.json({
    fastStartCacheSize: fastStartCache.size,
    totalTracks: trackIndex.length,
    cachedBytes: FAST_START_BYTES,
    tracks: entries,
  });
});

// Status / Health endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    version: '1.9.1',
    app: 'BitChord Telegram Music Addon',
    tracksCount: trackIndex.length,
    manifest: `${getBaseUrl(req)}/manifest.json`,
  });
});

// ── Server & Telegram Initialization ──────────────────────────────────────

async function resolveChannel() {
  console.log(`Resolving channel "${CHANNEL}"...`);
  // Calling getDialogs populates Telegram entity cache with access hashes for private channels
  const dialogs = await client.getDialogs({ limit: 100 });
  const cleanInput = CHANNEL.trim();
  const stripped = cleanInput.replace(/^-100/, '').replace(/^@/, '').toLowerCase();

  for (const d of dialogs) {
    const entity = d.entity;
    if (!entity) continue;
    const entityId = entity.id ? entity.id.toString() : '';
    const username = (entity.username || '').toLowerCase();
    const title = (entity.title || '').toLowerCase();

    if (
      entityId === cleanInput ||
      `-100${entityId}` === cleanInput ||
      entityId === stripped ||
      (username && username === stripped) ||
      title === cleanInput.toLowerCase()
    ) {
      console.log(`Successfully matched channel dialog: "${entity.title || entity.username}" (ID: ${entityId})`);
      return entity;
    }
  }

  // Fallback to direct resolution
  return await client.getEntity(cleanInput);
}

const SYSTEM_PREFIXES = ['Searching for', '🎧', '🔍', '⏳', '🚀', '✅', '❌', 'ℹ️', '🧹', '⚠️', 'Duplicate detected', '**Duplicate detected'];

async function cleanupOrphanedDuplicateNotices() {
  if (!channelEntity) return;
  try {
    const recent = await client.getMessages(channelEntity, { limit: 50 });
    const toDelete = [];
    const now = Math.floor(Date.now() / 1000);
    for (const msg of recent) {
      const text = msg.message || msg.text || '';
      if (text.includes('Duplicate detected:') && (text.includes('Deleting in 15s') || text.includes('Send /keep to save'))) {
        const msgAgeSec = now - (msg.date || 0);
        if (msgAgeSec > 20) {
          toDelete.push(msg.id);
        }
      }
    }
    if (toDelete.length > 0) {
      console.log(`[Cleanup] Found ${toDelete.length} orphaned duplicate warning notice(s). Deleting...`);
      await deleteTelegramMessages(toDelete);
    }
  } catch (err) {
    console.warn('[Cleanup Error]:', err.message);
  }
}

async function isFromBot(msg) {
  if (!msg) return false;
  try {
    if (msg.viaBotId) return true;
    if (msg.replyMarkup) return true; // Only bots can attach replyMarkup (inline buttons) in Telegram
    if (msg.sender?.bot) return true;

    const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
    const botId = token ? token.split(':')[0] : null;
    if (botId) {
      if (msg.fromId && utils.getPeerId(msg.fromId).toString() === botId) return true;
      if (msg.senderId && msg.senderId.toString() === botId) return true;
    }

    if (typeof msg.getSender === 'function') {
      const sender = await msg.getSender();
      if (sender?.bot) return true;
      if (botId && sender?.id?.toString() === botId) return true;
    }
  } catch (_) {}
  return false;
}

async function startBotCallbackPoller(botToken) {
  let offset = 0;
  console.log('[Bot Poller] Active for real inline buttons.');
  while (true) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/getUpdates?offset=${offset}&timeout=25&allowed_updates=["callback_query"]`);
      const data = await res.json();
      if (data.ok && data.result) {
        for (const update of data.result) {
          offset = update.update_id + 1;
          const cq = update.callback_query;
          if (!cq || !cq.data) continue;

          fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: cq.id })
          }).catch(() => {});

          if (cq.data === 'cancel') {
            await cancelPicker(client, channelEntity);
          } else if (cq.data === 'bot_next') {
            await navigateBotPicker(client, channelEntity, '➡️');
          } else if (cq.data === 'bot_prev') {
            await navigateBotPicker(client, channelEntity, '⬅️');
          } else {
            const opt = parseInt(cq.data, 10);
            if (!isNaN(opt)) {
              await handlePickerChoice(client, channelEntity, opt, onTrackForwarded);
            }
          }
        }
      }
    } catch (_) {
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

(async () => {
  try {
    loadCache();
    loadNotificationState();
    console.log('Connecting to Telegram MTProto...');
    await client.connect();
    console.log('Connected to Telegram!');

    channelEntity = await resolveChannel();
    console.log(`Using Telegram channel: ${channelEntity.title || channelEntity.username || CHANNEL}`);
    await cleanupOrphanedDuplicateNotices();

    const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
    if (BOT_TOKEN) {
      startBotCallbackPoller(BOT_TOKEN);
    }

    // Set up real-time listener for /s commands, picker choices, audio uploads, and auto-purge cleaner
    client.addEventHandler(async (event) => {
      try {
        const message = event.message;
        if (!message) return;

        const isMusicChannel = channelEntity && message.peerId && (utils.getPeerId(message.peerId).toString() === utils.getPeerId(channelEntity).toString());
        const isSelfChat = message.isPrivate; // e.g. Saved Messages
        const trimmedText = (message.text || message.message || '').trim();

        // 1. Check for /s, /song, #s, #song commands
        if (/^[#/](?:song|s)(?:\s+.*)?$/i.test(trimmedText)) {
          if (isMusicChannel || isSelfChat) {
            console.log(`[Song Command] Detected: "${trimmedText}" (msg ID: ${message.id})`);
            handleSongCommand(client, channelEntity, trimmedText, message.id, onTrackForwarded).catch((err) => {
              console.error('[Song Command Error]:', err.message);
            });
            return;
          }
        }

        // 2. Check for interactive picker choice (/1, /2, /8, /15, etc.)
        const pickerMatch = trimmedText.match(/^\/(\d+)$/);
        if (pickerMatch && hasActivePicker(channelEntity)) {
          if (isMusicChannel || isSelfChat) {
            const choice = parseInt(pickerMatch[1], 10);
            client.deleteMessages(channelEntity, [message.id], { revoke: true }).catch(() => {});
            handlePickerChoice(client, channelEntity, choice, onTrackForwarded).catch((err) => {
              console.error('[Picker Choice Error]:', err.message);
            });
            return;
          }
        }

        // 3. Check for /next, /prev navigation commands
        if ((trimmedText === '/next' || trimmedText === '/more' || trimmedText === '➡️') && hasActivePicker(channelEntity)) {
          if (isMusicChannel || isSelfChat) {
            client.deleteMessages(channelEntity, [message.id], { revoke: true }).catch(() => {});
            navigateBotPicker(client, channelEntity, '➡️').catch(() => {});
            return;
          }
        }

        if ((trimmedText === '/prev' || trimmedText === '⬅️') && hasActivePicker(channelEntity)) {
          if (isMusicChannel || isSelfChat) {
            client.deleteMessages(channelEntity, [message.id], { revoke: true }).catch(() => {});
            navigateBotPicker(client, channelEntity, '⬅️').catch(() => {});
            return;
          }
        }

        // 4. Check for /cancel command
        if (trimmedText === '/cancel' && hasActivePicker(channelEntity)) {
          if (isMusicChannel || isSelfChat) {
            client.deleteMessages(channelEntity, [message.id], { revoke: true }).catch(() => {});
            cancelPicker(client, channelEntity).catch(() => {});
            return;
          }
        }

        // 5. Check for /keep, #keep, /ig, #ig command (can be a reply to an audio message or standalone)
        if (/^[#/](?:keep|ig)(?:\s+.*)?$/i.test(trimmedText)) {
          if (isMusicChannel) {
            let targetKey = null;
            const repliedId = message.replyTo?.replyToMsgId || message.replyToMsgId ? String(message.replyTo?.replyToMsgId || message.replyToMsgId) : null;

            if (repliedId) {
              // Check if user replied directly to the audio track
              if (pendingDeletions.has(repliedId)) {
                targetKey = repliedId;
              } else {
                // Check if user replied to the notice warning message
                for (const [trackId, info] of pendingDeletions.entries()) {
                  if (info.noticeMsgId && String(info.noticeMsgId) === repliedId) {
                    targetKey = trackId;
                    break;
                  }
                }
              }
            }

            // Standalone: if user sent /keep or #keep without replying, pick the latest pending duplicate
            if (!targetKey && pendingDeletions.size > 0) {
              const allKeys = Array.from(pendingDeletions.keys());
              targetKey = allKeys[allKeys.length - 1];
            }

            if (targetKey && pendingDeletions.has(targetKey)) {
              const cancelled = cancelPendingDeletion(targetKey);
              if (cancelled && cancelled.track) {
                cancelled.track.keep = true;
                trackIndex.unshift(cancelled.track);
                saveCache();
                console.log(`[Keep Flag] Preserved duplicate track "${cancelled.track.title}" (msg ID: ${targetKey}) via keep command.`);
                const confirmMsg = await client.sendMessage(channelEntity, {
                  message: `✅ **Preserved:** "${cancelled.track.title}" will be kept in your library.`
                }).catch(() => null);
                if (confirmMsg) {
                  setTimeout(() => {
                    client.deleteMessages(channelEntity, [confirmMsg.id, message.id], { revoke: true }).catch(() => {});
                  }, 12000);
                }
              }
            } else {
              // Delete unrecognized keep command after 4 seconds
              setTimeout(() => {
                client.deleteMessages(channelEntity, [message.id], { revoke: true }).catch(() => {});
              }, 4000);
            }
            return;
          }
        }

        // 6. Check for incoming audio file upload
        const doc = message.media?.document;
        if (doc && isAudioDocument(doc)) {
          if (!isMusicChannel) return;

          console.log(`Detected new audio upload in channel (msg ID: ${message.id}), processing track...`);
          const track = await parseTrackMessage(message);
          if (track) {
            await processTrackUpload(track);
          }
          return;
        }

        // 5. Auto-purge channel cleaner: delete any incoming non-music chatter/spam from users
        if (isMusicChannel && !message.out && !message.post) {
          const isCommand = trimmedText.startsWith('/');
          const hasButtons = Boolean(message.replyMarkup);
          const isBotSender = await isFromBot(message);
          const isSystemText = SYSTEM_PREFIXES.some(p => trimmedText.startsWith(p));
          const isPicker = isPickerMenu(channelEntity, message.id);

          if (!isCommand && !hasButtons && !isBotSender && !isSystemText && !isPicker) {
            console.log(`[Channel Cleaner] Auto-purging user non-music message (msg ID: ${message.id}): "${trimmedText.slice(0, 30)}"`);
            client.deleteMessages(channelEntity, [message.id], { revoke: true }).catch(() => {});
          }
        }
      } catch (err) {
        console.warn('Real-time event error:', err.message);
      }
    }, new NewMessage({}));

    // Start 30-minute digest and 12-hour auto-deletion interval checker (checks every 5 minutes)
    setInterval(checkDigestSchedule, 5 * 60 * 1000);

    app.listen(PORT, '0.0.0.0', async () => {
      console.log(`BitChord Addon server running on http://0.0.0.0:${PORT}`);
      console.log(`Manifest URL: http://localhost:${PORT}/manifest.json`);
      try {
        await buildTrackIndex();
        checkDigestSchedule();
      } catch (err) {
        console.error('Initial indexing error:', err.message);
      }
    });
  } catch (err) {
    console.error('Fatal startup error:', err);
    process.exit(1);
  }
})();
