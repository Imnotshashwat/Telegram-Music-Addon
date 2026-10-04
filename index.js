require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const pkg = require('./package.json');
const bigInt = require('big-integer');
const { TelegramClient, utils } = require('telegram');
const { Logger } = require('telegram/extensions');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram/tl');
const { NewMessage } = require('telegram/events');
const mm = require('music-metadata');
const setupApi = require('./setup-api');
const tunnel = require('./tunnel');

setupApi.setGetActiveClient(() => client);
setupApi.setGetTracksCount(() => trackIndex.length);

const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.use('/public', express.static(path.join(__dirname, 'public'), { etag: false, maxAge: 0 }));
app.use('/api/setup', setupApi.router);
app.get('/setup', (req, res) => res.sendFile(path.join(__dirname, 'public', 'setup.html')));

// WebDAV protocol discovery: intercept OPTIONS /dav before CORS ends with 204
app.use((req, res, next) => {
  if (req.method === 'OPTIONS' && (req.path.includes('/dav') || req.url.includes('/dav'))) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS, PROPFIND');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('DAV', '1, 2');
    res.setHeader('MS-Author-Via', 'DAV');
    res.setHeader('Allow', 'OPTIONS, GET, HEAD, PROPFIND');
    return res.status(200).end();
  }
  next();
});

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
// Optional local TeleDrive synchronization module (gitignored)
let teledrive = null;
try {
  teledrive = require('./teledrive');
} catch (e) {
  // Optional local module
}
const PORT = process.env.PORT || 3000;
function getUrlSecret() {
  return cleanEnv(process.env.URL_SECRET || process.env.ACCESS_TOKEN);
}
const CACHE_FILE = path.join(__dirname, 'tracks_cache.json');
const CACHE_FILE_GZ = path.join(__dirname, 'tracks_cache.json.gz');
const CACHE_FILE_BAK = path.join(__dirname, 'tracks_cache.json.gz.bak');
const CACHE_FILE_TMP = path.join(__dirname, 'tracks_cache.json.gz.tmp');

// GramJS StringSession requires the session string to begin with the version character "1"
if (SESSION_STRING && SESSION_STRING[0] !== '1') {
  const oneIdx = SESSION_STRING.indexOf('1');
  if (oneIdx !== -1) {
    SESSION_STRING = SESSION_STRING.slice(oneIdx);
  }
}

const AUDIO_EXTENSIONS = ['flac', 'mp3', 'm4a', 'aac', 'wav', 'ogg', 'opus', 'alac', 'ec3', 'eac3'];
const EXT_TO_FORMAT = {
  flac: 'flac',
  mp3: 'mp3',
  m4a: 'm4a',
  aac: 'aac',
  wav: 'wav',
  ogg: 'ogg',
  opus: 'opus',
  alac: 'alac',
  ec3: 'eac3',
  eac3: 'eac3',
};

const ATMOS_REGEX = /\b(atmos|dolby\s*atmos|eac3[-\s]?joc|eac3|ec3|e-ac-3|spatial\s*audio)\b|\[atmos\]|\(atmos\)/i;

function isAudioDocument(doc) {
  if (!doc) return false;
  const mime = (doc.mimeType || '').toLowerCase();
  const fileNameAttr = doc.attributes?.find((a) => a.className === 'DocumentAttributeFilename');
  const fileName = fileNameAttr?.fileName || '';
  const ext = fileName.split('.').pop()?.toLowerCase() || '';

  // Never treat video containers as audio documents
  if (mime.startsWith('video/') || ['mp4', 'mkv', 'avi', 'mov', 'webm', 'flv'].includes(ext)) {
    return false;
  }

  const isAudioMime = mime.startsWith('audio/') || mime === 'application/ogg' || mime === 'application/x-flac';
  const isAudioExt = AUDIO_EXTENSIONS.includes(ext);
  const isAudioAttr = doc.attributes?.some((a) => a.className === 'DocumentAttributeAudio');

  return Boolean(isAudioMime || isAudioExt || isAudioAttr);
}

// Known composer duos that are hyphenated in tags but separated on streaming services
const COMPOSER_DUOS = [
  [/vishal[-\s\u2013\u2014]+shekhar/gi, 'Vishal & Shekhar'],
  [/sachin[-\s\u2013\u2014]+jigar/gi, 'Sachin & Jigar'],
  [/salim[-\s\u2013\u2014]+sulaiman/gi, 'Salim & Sulaiman'],
  [/shankar[-\s\u2013\u2014]+ehsaan[-\s\u2013\u2014]+loy/gi, 'Shankar & Ehsaan & Loy'],
  [/ajay[-\s\u2013\u2014]+atul/gi, 'Ajay & Atul'],
  [/sajid[-\s\u2013\u2014]+wajid/gi, 'Sajid & Wajid'],
  [/nadeem[-\s\u2013\u2014]+shravan/gi, 'Nadeem & Shravan'],
  [/jatin[-\s\u2013\u2014]+lalit/gi, 'Jatin & Lalit'],
  [/anand[-\s\u2013\u2014]+milind/gi, 'Anand & Milind'],
  [/laxmikant[-\s\u2013\u2014]+pyarelal/gi, 'Laxmikant & Pyarelal'],
  [/kalyanji[-\s\u2013\u2014]+anandji/gi, 'Kalyanji & Anandji'],
  [/shiv[-\s\u2013\u2014]+hari/gi, 'Shiv & Hari'],
  [/raam[-\s\u2013\u2014]+laxman/gi, 'Raam & Laxman'],
];

function formatArtistForClient(artistStr) {
  if (!artistStr || artistStr.trim().toLowerCase() === 'unknown artist') return 'Unknown Artist';
  let formatted = artistStr;
  for (const [pattern, replacement] of COMPOSER_DUOS) {
    formatted = formatted.replace(pattern, replacement);
  }
  formatted = formatted.replace(/\s+[-\u2013\u2014]+\s+/g, ', ');
  return formatted.trim();
}

let client = null;
if (API_ID && API_HASH) {
  client = new TelegramClient(new StringSession(SESSION_STRING || ''), API_ID, API_HASH, {
    connectionRetries: 10,
    autoReconnect: true,
    useWSS: process.env.USE_WSS !== 'false',
    baseLogger: new Logger('none'),
  });
  client.setLogLevel('none');
}

let channelEntity = null;
let isTelegramReady = false;
let trackIndex = [];
let lastIndexed = 0;

// ── Lightweight O(1) LRU Cache (Zero External Dependencies) ─────────────
class SimpleLRU {
  constructor(maxSize) {
    this.maxSize = maxSize;
    this.map = new Map();
  }
  get(key) {
    const k = String(key);
    if (!this.map.has(k)) return undefined;
    const val = this.map.get(k);
    this.map.delete(k);
    this.map.set(k, val);
    return val;
  }
  set(key, val) {
    const k = String(key);
    if (this.map.has(k)) {
      this.map.delete(k);
    } else if (this.map.size >= this.maxSize) {
      const oldestKey = this.map.keys().next().value;
      this.map.delete(oldestKey);
    }
    this.map.set(k, val);
  }
  has(key) {
    return this.map.has(String(key));
  }
  delete(key) {
    return this.map.delete(String(key));
  }
  clear() {
    this.map.clear();
  }
  get size() {
    return this.map.size;
  }
  keys() {
    return Array.from(this.map.keys());
  }
}

const mediaCache = new SimpleLRU(10000);

function updateMediaCacheCapacity() {
  const dynamicCap = Math.max(10000, Math.ceil(trackIndex.length * 1.5));
  if (mediaCache.maxSize !== dynamicCap) {
    mediaCache.maxSize = dynamicCap;
  }
}
const fastStartCache = new SimpleLRU(6);
const FAST_START_BYTES = 6 * 1024 * 1024; // Exactly 12 blocks of 512KB (6.0 MB)

// LRU cache for audio headers and tag slices (128KB - 256KB, up to 150 tracks)
const tagSliceCache = new SimpleLRU(150);

const recentRequests = [];
function recordRequest(entry) {
  recentRequests.unshift(entry);
  if (recentRequests.length > 50) recentRequests.pop();
}

let currentlyPlayingTrackId = null;
let lastPlaybackLogTime = 0;
let lastSeekLogTime = 0;
let lastSeekStart = 0;
let lastServedAudioTrackId = null;
let lastLogWasBlank = false;

const origStderrWrite = process.stderr.write;
process.stderr.write = function (chunk, ...args) {
  const str = chunk ? chunk.toString() : '';
  if (str.includes('TimeoutNegativeWarning') || str.includes('Timeout duration was set to 1') || str.includes('localstorage-file')) return true;
  return origStderrWrite.apply(process.stderr, [chunk, ...args]);
};

const BOLD   = '\x1b[1m';
const DIM    = '\x1b[2m';
const ITALIC = '\x1b[3m';
const RESET  = '\x1b[0m';

let isStartupComplete = false;
let hasInsertedStartupGap = false;

function printCliSeparator() {}

function centerText(text, width = 10) {
  const len = text.length;
  if (len >= width) return text;
  const leftPadding = Math.floor((width - len) / 2);
  const rightPadding = width - len - leftPadding;
  return ' '.repeat(leftPadding) + text + ' '.repeat(rightPadding);
}

function getCliTag(tag) {
  const centeredTag = centerText(tag.toUpperCase(), 10);
  return `${DIM}|${RESET}${BOLD}${centeredTag}${RESET}${DIM}|${RESET}`;
}

function logCli(tag, msg) {
  const upperTag = tag.toUpperCase();
  if (isStartupComplete && !hasInsertedStartupGap && ['SEARCH', 'STREAM', 'PRECACHE', 'BUFFER', 'SEEK', 'PROBE', 'WEBDAV'].includes(upperTag)) {
    hasInsertedStartupGap = true;
    console.log('');
  }
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const timeStr = `${DIM}${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${RESET}`;
  console.log(`${timeStr} ${getCliTag(tag)} ${msg}`);
  if (upperTag === 'LIBRARY') {
    hasInsertedStartupGap = false;
  }
  lastLogWasBlank = false;
}

if (teledrive && typeof teledrive.setLogCli === 'function') {
  teledrive.setLogCli(logCli);
}

function loadCache() {
  try {
    let rawData = null;
    let source = '';

    if (fs.existsSync(CACHE_FILE_GZ)) {
      try {
        const buffer = fs.readFileSync(CACHE_FILE_GZ);
        rawData = zlib.gunzipSync(buffer).toString('utf-8');
        source = 'primary compressed cache';
      } catch (err) {
        console.warn('Primary compressed cache unreadable, attempting backup...');
      }
    }

    if (!rawData && fs.existsSync(CACHE_FILE_BAK)) {
      try {
        const buffer = fs.readFileSync(CACHE_FILE_BAK);
        rawData = zlib.gunzipSync(buffer).toString('utf-8');
        source = 'backup compressed cache';
      } catch (err) {
        console.warn('Backup compressed cache unreadable...');
      }
    }

    if (!rawData && fs.existsSync(CACHE_FILE)) {
      try {
        rawData = fs.readFileSync(CACHE_FILE, 'utf-8');
        source = 'legacy json cache';
      } catch (err) {
        console.warn('Legacy JSON cache unreadable...');
      }
    }

    if (rawData) {
      const rawTracks = JSON.parse(rawData);
      const seenIds = new Set();
      trackIndex = [];
      for (const t of rawTracks) {
        const idStr = String(t.id);
        if (seenIds.has(idStr)) continue;
        seenIds.add(idStr);
        if (t.artist) t.artist = formatArtistForClient(t.artist);
        if (t.format === 'eac3-joc' || t.quality === 'Dolby Atmos' || ATMOS_REGEX.test(t.title || '') || ATMOS_REGEX.test(t.fileName || '')) {
          t.isAtmos = true;
          t.format = 'eac3-joc';
          t.audioModes = ['DOLBY_ATMOS'];
          t.audioMode = 'DOLBY_ATMOS';
        }
        indexTrackKeywords(t);
        trackIndex.push(t);
      }
      logCli('CACHE', `Loaded ${BOLD}${trackIndex.length}${RESET} tracks from ${source}`);
      updateMediaCacheCapacity();
      rebuildWebDavFileMap();

      // Auto-migrate legacy JSON to atomic Gzip if GZ missing
      if (!fs.existsSync(CACHE_FILE_GZ)) {
        saveCache();
      }
    }
  } catch (err) {
    console.warn(`Could not load cache: ${err.message}`);
  }
}

// Helper: save cached tracks to disk using Atomic Gzip write
function saveCache() {
  try {
    const jsonString = JSON.stringify(trackIndex);
    const compressed = zlib.gzipSync(Buffer.from(jsonString));

    if (fs.existsSync(CACHE_FILE_GZ)) {
      try {
        fs.copyFileSync(CACHE_FILE_GZ, CACHE_FILE_BAK);
      } catch (_) {}
    }

    fs.writeFileSync(CACHE_FILE_TMP, compressed);
    fs.renameSync(CACHE_FILE_TMP, CACHE_FILE_GZ);
  } catch (err) {
    console.warn(`Could not save cache: ${err.message}`);
  }
}

function isFileReferenceError(err) {
  if (!err) return false;
  const msg = String(err.message || err.errorMessage || err);
  return msg.includes('FILE_REFERENCE') || msg.includes('FILEREF');
}

function formatTrackDuration(sec) {
  const s = Math.round(Number(sec) || 0);
  if (!s || s <= 0) return '';
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${rem.toString().padStart(2, '0')}m`;
}

// Retrieve the Telegram msg.media object from RAM cache, or fetch once if not yet cached
async function getMediaForTrack(trackId, forceRefresh = false) {
  const key = String(trackId);
  if (!forceRefresh && mediaCache.has(key)) {
    return mediaCache.get(key);
  }
  try {
    const messages = await client.getMessages(channelEntity, { ids: [parseInt(trackId, 10)] });
    const targetMsg = messages && messages.find((m) => m && String(m.id) === key);
    if (targetMsg && targetMsg.media) {
      mediaCache.set(key, targetMsg.media);
      return targetMsg.media;
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
  const prefix = req.secretPrefix ? `/${req.secretPrefix}` : '';
  const configuredPublic = (process.env.PUBLIC_URL || process.env.CUSTOM_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (configuredPublic) {
    return `${configuredPublic}${prefix}`;
  }

  const tunnelUrl = typeof tunnel !== 'undefined' && tunnel && typeof tunnel.getTunnelUrl === 'function' ? tunnel.getTunnelUrl() : null;
  const forwardedHost = req.headers['x-forwarded-host'];
  const reqHost = req.get('host') || `localhost:${PORT}`;
  const host = forwardedHost || reqHost;
  const isLocalHost = host.startsWith('localhost') || host.startsWith('127.0.0.1') || host.startsWith('0.0.0.0');

  if (!isLocalHost) {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    return `${proto}://${host}${prefix}`;
  }

  if (tunnelUrl) {
    return `${tunnelUrl.replace(/\/+$/, '')}${prefix}`;
  }

  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  return `${proto}://${host}${prefix}`;
}

async function getMediaChunk(media, offset = 0, maxBytes = 128 * 1024) {
  const chunks = [];
  let downloaded = 0;
  const blockSize = 64 * 1024;
  const alignedOffset = Math.floor(offset / blockSize) * blockSize;
  let skipBytes = offset - alignedOffset;
  const totalToFetch = skipBytes + maxBytes;

  try {
    const iter = client.iterDownload({
      file: media,
      offset: bigInt(alignedOffset),
      requestSize: blockSize,
    });
    for await (const chunk of iter) {
      chunks.push(chunk);
      downloaded += chunk.length;
      if (downloaded >= totalToFetch) {
        iter.left = 0;
        await iter.close().catch(() => {});
        break;
      }
    }
    const combined = Buffer.concat(chunks);
    return combined.slice(skipBytes, skipBytes + maxBytes);
  } catch (_) {
    return null;
  }
}

function getHeaderChunk(media, maxBytes = 128 * 1024) {
  return getMediaChunk(media, 0, maxBytes);
}

function hasEac3SyncWords(buf) {
  if (!buf || buf.length < 200) return false;
  for (let i = 0; i < buf.length - 200; i++) {
    if (buf[i] === 0x0b && buf[i + 1] === 0x77) {
      const strmtyp = (buf[i + 2] >> 6) & 0x03;
      if (strmtyp <= 2) {
        const frmsiz = ((buf[i + 2] & 0x07) << 8) | buf[i + 3];
        const frameBytes = (frmsiz + 1) * 2;
        if (frameBytes >= 96 && frameBytes <= 4096 && (i + frameBytes + 1) < buf.length) {
          if (buf[i + frameBytes] === 0x0b && buf[i + frameBytes + 1] === 0x77) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

function parseMp4Duration(buf) {
  if (!buf || buf.length < 32) return undefined;
  const idx = buf.indexOf('mvhd');
  if (idx === -1 || idx + 24 > buf.length) return undefined;
  try {
    const version = buf.readUInt8(idx + 4);
    let timescale, durationVal;
    if (version === 0 && idx + 24 <= buf.length) {
      timescale = buf.readUInt32BE(idx + 16);
      durationVal = buf.readUInt32BE(idx + 20);
    } else if (version === 1 && idx + 36 <= buf.length) {
      timescale = buf.readUInt32BE(idx + 24);
      durationVal = Number(buf.readBigUInt64BE(idx + 28));
    }
    if (timescale && durationVal) {
      const sec = Math.round(durationVal / timescale);
      if (sec > 0 && sec < 86400) return sec;
    }
  } catch (_) {}
  return undefined;
}

const inFlightPrewarms = new Set();
const inFlightPrewarmIters = new Map();

async function prewarmTrackPreamble(trackId, media, title) {
  const idStr = String(trackId);
  const existing = fastStartCache.get(idStr);
  if (existing && existing.length >= FAST_START_BYTES) return;
  if (inFlightPrewarms.has(idStr)) return;
  inFlightPrewarms.add(idStr);

  try {
    let targetMedia = media || await getMediaForTrack(idStr);
    if (!targetMedia) return;

    let hasRefreshed = false;
    while (true) {
      const iter = client.iterDownload({
        file: targetMedia,
        offset: bigInt(0),
        requestSize: 512 * 1024,
      });
      inFlightPrewarmIters.set(idStr, iter);

      try {
        const preambleChunks = [];
        let bytesCollected = 0;
        for await (const chunk of iter) {
          if (!inFlightPrewarmIters.has(idStr)) {
            iter.left = 0;
            await iter.close().catch(() => {});
            break;
          }
          const needed = FAST_START_BYTES - bytesCollected;
          preambleChunks.push(chunk.slice(0, needed));
          bytesCollected += Math.min(chunk.length, needed);
          if (bytesCollected >= FAST_START_BYTES) {
            break;
          }
        }
        if (preambleChunks.length > 0) {
          const preamble = Buffer.concat(preambleChunks);
          fastStartCache.set(idStr, preamble);
          tagSliceCache.set(idStr, preamble.slice(0, Math.min(preamble.length, 256 * 1024)));
          if (bytesCollected >= FAST_START_BYTES || !iter.left) {
            const sizeFormatted = preamble.length >= 1024 * 1024
              ? `${(preamble.length / (1024 * 1024)).toFixed(1)} MB`
              : `${Math.round(preamble.length / 1024)} KB`;
            logCli('BUFFER', `Prewarmed ${BOLD}${sizeFormatted}${RESET} -> ID: ${BOLD}${idStr}${RESET}`);
          }
        }
        iter.left = 0;
        await iter.close().catch(() => {});
        break;
      } catch (err) {
        if (!hasRefreshed && isFileReferenceError(err)) {
          hasRefreshed = true;
          console.warn(`[FileRef] Pre-warm file reference expired for track ${idStr}. Refreshing...`);
          const freshMedia = await getMediaForTrack(idStr, true);
          if (freshMedia) {
            targetMedia = freshMedia;
            continue;
          }
        }
        throw err;
      }
    }
  } catch (err) {
    if (inFlightPrewarmIters.has(idStr)) {
      console.warn(`[FastStart] Pre-warm skipped for track ${idStr}: ${err.message}`);
    }
  } finally {
    inFlightPrewarmIters.delete(idStr);
    inFlightPrewarms.delete(idStr);
  }
}

async function parseTrackMessage(msg, cacheMedia = true) {
  if (!msg.media || !msg.media.document) return null;

  // Strictly only cache media belonging to the Music Library channel
  if (cacheMedia && channelEntity && msg.peerId && utils.getPeerId(msg.peerId).toString() === utils.getPeerId(channelEntity).toString()) {
    mediaCache.set(String(msg.id), msg.media);
  }

  const doc = msg.media.document;
  const fileName = getFileNameFromMessage(msg);
  const ext = extFromName(fileName);
  const audioAttr = getAudioAttr(msg);

  const isAudio = AUDIO_EXTENSIONS.includes(ext) || Boolean(audioAttr);
  if (!isAudio) return null;

  const resolvedExt = ext || 'mp3';
  const fallbackTitle = fileName.replace(/\.[^.]+$/, '');
  const sizeBytes = Number(doc.size) || 0;
  const hasArtwork = Boolean(doc.thumbs && doc.thumbs.length > 0);

  let title = (audioAttr && audioAttr.title) ? audioAttr.title.trim() : fallbackTitle;
  let artist = (audioAttr && audioAttr.performer) ? audioAttr.performer.trim() : 'Unknown Artist';
  let duration = (audioAttr && audioAttr.duration) ? Math.round(audioAttr.duration) : undefined;
  let album = undefined;
  let sampleRate = undefined;
  let bitDepth = undefined;
  let isrc = undefined;
  let bitrate = undefined;

  const isMp4Container = ext === 'm4a' || ext === 'mp4';
  const shouldSniffTags = (isMp4Container || !audioAttr || !audioAttr.title || !audioAttr.performer || !isrc) && sizeBytes > 0;
  let parsedCodec = null;
  let hasEc3Atom = false;
  let hasAlacAtom = false;
  if (shouldSniffTags) {
    try {
      const headerBuf = await getHeaderChunk(msg.media, Math.min(128 * 1024, sizeBytes));
      if (headerBuf && headerBuf.length > 0) {
        if (isMp4Container) {
          const headerStr = headerBuf.toString('latin1');
          if (headerStr.includes('ec-3') || headerStr.includes('dec3') || headerStr.includes('damf') || headerStr.includes('SpatialAudio')) {
            hasEc3Atom = true;
          } else if (headerStr.includes('alac')) {
            hasAlacAtom = true;
          }

          if (!hasEc3Atom && hasEac3SyncWords(headerBuf)) {
            hasEc3Atom = true;
          }

          if (!duration) {
            const mvhdDur = parseMp4Duration(headerBuf);
            if (mvhdDur) duration = mvhdDur;
          }

          // If moov atom was not in the first 128KB, probe the last 128KB where moov sits in non-faststart MP4s
          if ((!hasEc3Atom || !duration) && sizeBytes > 128 * 1024 && !headerStr.includes('moov')) {
            const tailBytes = Math.min(128 * 1024, sizeBytes);
            const tailBuf = await getMediaChunk(msg.media, sizeBytes - tailBytes, tailBytes);
            if (tailBuf && tailBuf.length > 0) {
              const tailStr = tailBuf.toString('latin1');
              if (tailStr.includes('ec-3') || tailStr.includes('dec3') || tailStr.includes('damf') || tailStr.includes('SpatialAudio')) {
                hasEc3Atom = true;
              } else if (tailStr.includes('alac')) {
                hasAlacAtom = true;
              }
              if (!duration) {
                const tailDur = parseMp4Duration(tailBuf);
                if (tailDur) duration = tailDur;
              }
            }
          }
        }
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
          if (parsed.common.isrc && parsed.common.isrc.length > 0) isrc = parsed.common.isrc[0].trim().toUpperCase();
        }
        if (parsed.format) {
          parsedCodec = parsed.format.codec;
          if (parsed.format.sampleRate) sampleRate = parsed.format.sampleRate;
          if (parsed.format.bitsPerSample) bitDepth = parsed.format.bitsPerSample;
          if (!duration && parsed.format.duration) duration = Math.round(parsed.format.duration);
          if (parsed.format.bitrate) bitrate = Math.round(parsed.format.bitrate / 1000);
        }
      }
    } catch (_) {}
  }

  // Cross-reference duration from existing copy in library if still unknown
  if (!duration) {
    const existingMatch = trackIndex.find((t) => t.duration && (
      (isrc && t.isrc && t.isrc === isrc) ||
      (t.title && title && normalizeTitle(t.title) === normalizeTitle(title))
    ));
    if (existingMatch && existingMatch.duration) {
      duration = existingMatch.duration;
    }
  }

  const msgText = (msg.message || msg.text || '');
  let rawKbps = 0;
  if (sizeBytes && duration) {
    rawKbps = Math.round((sizeBytes * 8) / (duration * 1000));
  }

  const isAtmos = Boolean(
    hasEc3Atom ||
    ATMOS_REGEX.test(fileName) ||
    ATMOS_REGEX.test(msgText) ||
    ATMOS_REGEX.test(title) ||
    (parsedCodec && ATMOS_REGEX.test(parsedCodec)) ||
    ext === 'ec3' ||
    ext === 'eac3' ||
    (isMp4Container && rawKbps >= 650 && rawKbps <= 950 && !hasAlacAtom)
  );

  let formatName = EXT_TO_FORMAT[resolvedExt] || resolvedExt;
  if (isAtmos) {
    formatName = 'eac3-joc';
    if (!sampleRate) sampleRate = 48000;
    if (!bitDepth) bitDepth = 16;
  } else if (formatName === 'm4a' && (hasAlacAtom || parsedCodec === 'ALAC' || rawKbps > 500 || bitDepth === 16 || bitDepth === 24)) {
    formatName = 'alac';
    if (!bitDepth) bitDepth = rawKbps > 2000 ? 24 : 16;
    if (!sampleRate) sampleRate = 48000;
  }

  let qualityText = formatName.toUpperCase();
  if (isAtmos) {
    qualityText = 'Dolby Atmos';
  } else if (bitDepth && sampleRate) {
    qualityText = `${bitDepth}-bit / ${(sampleRate / 1000).toFixed(1)}kHz ${formatName.toUpperCase()}`;
  } else if (['flac', 'wav', 'alac'].includes(formatName)) {
    qualityText = `16-bit / 44.1kHz ${formatName.toUpperCase()} Lossless`;
  } else {
    qualityText = `${formatName.toUpperCase()} (${rawKbps || 320}kbps)`;
  }

  const keep = msgText.toLowerCase().includes('/keep') || msgText.toLowerCase().includes('/ig') || msgText.toLowerCase().includes('#keep');

  return {
    id: String(msg.id),
    title: title || fallbackTitle,
    artist: formatArtistForClient(artist || 'Unknown Artist'),
    album: album || undefined,
    duration: duration || undefined,
    format: formatName,
    sampleRate,
    bitDepth,
    bitrate,
    quality: qualityText,
    isrc,
    hasArtwork,
    sizeBytes,
    mimeType: isAtmos ? 'audio/mp4' : (doc.mimeType || 'audio/mpeg'),
    isAtmos: isAtmos || undefined,
    audioModes: isAtmos ? ['DOLBY_ATMOS'] : undefined,
    audioMode: isAtmos ? 'DOLBY_ATMOS' : undefined,
    keep: keep ? true : undefined,
  };
}

function getQualityScore(track) {
  if (track.isAtmos || track.format === 'eac3-joc' || track.quality === 'Dolby Atmos') {
    return 9000000 + (track.sizeBytes || 0);
  }

  const fmt = (track.format || '').toLowerCase();
  if (['flac', 'wav', 'alac'].includes(fmt)) {
    const bits = track.bitDepth || 16;
    const rate = track.sampleRate || 44100;
    return 1000000 + (bits * rate);
  }

  let rawKbps = 320;
  if (track.bitrate) {
    rawKbps = track.bitrate;
  } else if (track.sizeBytes && track.duration) {
    rawKbps = Math.round((track.sizeBytes * 8) / (track.duration * 1000));
    // Hard cap fallback calculation to prevent massive artwork from inflating lossy scores
    if (fmt === 'mp3' && rawKbps > 320) rawKbps = 320;
    if ((fmt === 'aac' || fmt === 'm4a' || fmt === 'opus') && rawKbps > 500) rawKbps = 500;
  }

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
  if (track.isAtmos || track.format === 'eac3-joc' || track.quality === 'Dolby Atmos') {
    return 'Dolby Atmos';
  }
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
    .replace(/\((?:from|official|audio|video|lyrics|full song|remastered|hd|hq|club mix|feat\.?|ft\.?|radio edit|clean|explicit|atmos|dolby\s*atmos).*?\)/gi, '')
    .replace(/\[(?:from|official|audio|video|lyrics|full song|remastered|hd|hq|club mix|feat\.?|ft\.?|radio edit|clean|explicit|atmos|dolby\s*atmos).*?\]/gi, '')
    .replace(/\s*[-\u2013\u2014]\s*(?:radio edit|original mix|single|clean|explicit|atmos|dolby\s*atmos|new version|version|lofi|remix|acoustic|live|slowed|reverb|edit|revisited|unplugged|from\s+.*?)$/gi, '')
    .replace(/[^\w\s]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function getCoreTitle(str) {
  if (!str) return '';
  if (str.includes(' - ') || str.includes(' \u2013 ') || str.includes(' \u2014 ')) {
    const parts = str.split(/\s+[-\u2013\u2014]+\s+/);
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

function extractVersionTag(title) {
  if (!title) return '';
  const match = title.match(/[\(\[\{](?:version|remix|acoustic|instrumental|lofi|jhankar|slowed|reverb|live|female|male|unplugged|radio edit|original mix|extended mix|club mix|revisited|soundtrack|ost).*?[\)\]\}]|[-\u2013\u2014]\s*(?:version|remix|acoustic|instrumental|lofi|jhankar|slowed|reverb|live|female|male|unplugged|radio edit|original mix|extended mix|club mix|revisited|soundtrack|ost)$/i);
  return match ? match[0].toLowerCase().replace(/[^\w]/g, '') : '';
}

function isDuplicate(a, b) {
  if (a.id === b.id) return false;

  // Preserve both Dolby Atmos and stereo mixes
  const isAtmosA = Boolean(a.isAtmos || a.format === 'eac3-joc' || a.quality === 'Dolby Atmos');
  const isAtmosB = Boolean(b.isAtmos || b.format === 'eac3-joc' || b.quality === 'Dolby Atmos');
  if (isAtmosA !== isAtmosB) {
    return false;
  }

  // Exact ISRC match: identical master recording
  if (a.isrc && b.isrc && String(a.isrc).trim().toUpperCase() === String(b.isrc).trim().toUpperCase()) {
    return true;
  }

  // Preserve distinct musical arrangements (Remixes, Acoustic, Instrumental, Live, etc.)
  const tagA = extractVersionTag(a.title);
  const tagB = extractVersionTag(b.title);
  if (tagA !== tagB) {
    return false;
  }

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

      if (a.duration && b.duration && Math.abs(a.duration - b.duration) <= 6) {
        return true;
      }
      return false;
    }
    return true;
  }

  return false;
}

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
      if (notifState.pending.length > 0 || notifState.sentDigests.length > 0) {
        logCli('DIGEST', `Restored ${BOLD}${notifState.pending.length}${RESET} pending notifications, ${BOLD}${notifState.sentDigests.length}${RESET} active digest(s)`);
      }
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

    text += `• <b>${item.title}</b>: <i>${item.artist}</i>\n`;
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
    const sent = await sendChannelMessage(text, { parseMode: 'html' });
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

/**
 * Sends a notification message to the music channel.
 * Prefers the Telegram Bot API so notices appear from @losslessfinderbot.
 * Falls back to the user client (MTProto) if no bot token is configured or if the bot API fails.
 */
async function sendChannelMessage(text, options = {}) {
  const token = cleanEnv(process.env.TELEGRAM_BOT_TOKEN);
  let tgChatId = cleanEnv(process.env.TELEGRAM_CHANNEL);

  if (channelEntity) {
    try {
      const rawPeerId = utils.getPeerId(channelEntity).toString();
      tgChatId = rawPeerId.startsWith('-100') ? rawPeerId : `-100${rawPeerId}`;
    } catch (_) {}
  }

  if (token && tgChatId) {
    try {
      const payload = {
        chat_id: tgChatId,
        text: text,
      };

      if (options.parseMode) {
        payload.parse_mode = options.parseMode.toLowerCase() === 'html' ? 'HTML' : 'Markdown';
      }
      if (options.replyTo) {
        payload.reply_to_message_id = parseInt(options.replyTo, 10);
      }

      let res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      let data = await res.json();
      if (!data.ok && payload.reply_to_message_id) {
        // Broadcast channel or chat may reject reply_to_message_id; retry without it
        delete payload.reply_to_message_id;
        res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        data = await res.json();
      }

      if (data.ok && data.result) {
        return {
          id: data.result.message_id,
          date: data.result.date,
          text: data.result.text,
        };
      }
      console.warn('[Bot Notification] Bot API returned error, falling back to client:', data.description);
    } catch (err) {
      console.warn('[Bot Notification] Bot API request failed, falling back to client:', err.message);
    }
  }

  // Fallback: user MTProto client
  if (channelEntity) {
    try {
      const gramOptions = { message: text };
      if (options.parseMode) gramOptions.parseMode = options.parseMode;
      if (options.replyTo) gramOptions.replyTo = parseInt(options.replyTo, 10);
      try {
        return await client.sendMessage(channelEntity, gramOptions);
      } catch (gramErr) {
        if (gramOptions.replyTo) {
          delete gramOptions.replyTo;
          return await client.sendMessage(channelEntity, gramOptions);
        }
        throw gramErr;
      }
    } catch (err) {
      console.warn('[Channel Notification Error]:', err.message);
      return null;
    }
  }

  return null;
}

async function sendChannelNotification(text) {
  try {
    const sent = await sendChannelMessage(text);
    if (sent) console.log('[Channel Notification Sent]');
    return sent;
  } catch (err) {
    console.warn('[Channel Notification Error]:', err.message);
  }
}

// Pending duplicate deletions: maps messageId (string) -> { timer, track, existingDup, reason }
// Gives user a 6-hour grace window to reply with /keep if they want to preserve the duplicate
const pendingDeletions = new Map();
const DUPLICATE_GRACE_PERIOD_MS = 6 * 60 * 60 * 1000; // 6 hours

function cancelPendingDeletion(messageId) {
  const key = String(messageId);
  if (pendingDeletions.has(key)) {
    const pending = pendingDeletions.get(key);
    clearTimeout(pending.timer);
    pendingDeletions.delete(key);
    if (pending.noticeMsgId && channelEntity) {
      deleteMessageViaBot(pending.noticeMsgId).catch(() => {});
      deleteTelegramMessages([pending.noticeMsgId]).catch(() => {});
    }
    console.log(`[Keep Flag] Cancelled pending deletion for message ID: ${key}`);
    return pending;
  }
  return null;
}

async function deleteMessageViaBot(msgId) {
  const token = cleanEnv(process.env.TELEGRAM_BOT_TOKEN);
  let tgChatId = cleanEnv(process.env.TELEGRAM_CHANNEL);
  if (channelEntity) {
    try {
      const rawPeerId = utils.getPeerId(channelEntity).toString();
      tgChatId = rawPeerId.startsWith('-100') ? rawPeerId : `-100${rawPeerId}`;
    } catch (_) {}
  }
  if (token && tgChatId && msgId) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: tgChatId, message_id: parseInt(msgId, 10) }),
      });
      const data = await res.json();
      if (!data.ok) {
        console.warn(`[Bot Delete Warning] Message ${msgId}: ${data.description || 'Bad Request'}`);
      }
      return Boolean(data.ok && data.result);
    } catch (err) {
      console.warn(`[Bot Delete Error] Message ${msgId}:`, err.message);
    }
  }
  return false;
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
    // Fallback: try deleting individually with bot deleteMessage secondary fallback
    for (const rawId of messageIds) {
      const singleId = typeof rawId === 'number' ? rawId : parseInt(rawId, 10);
      if (singleId && !isNaN(singleId) && singleId > 0) {
        await client.deleteMessages(channelEntity, [singleId], { revoke: true }).catch(async (e) => {
          console.warn(`[Delete Message Fallback Error] ID ${singleId}:`, e.message);
          await deleteMessageViaBot(singleId);
        });
      }
    }
  }
  return false;
}

async function deleteTelegramMessage(messageId) {
  return deleteTelegramMessages([messageId]);
}

let uploadBatch = [];
let uploadBatchTimer = null;

function flushUploadBatch() {
  if (uploadBatch.length === 0) return;
  for (const t of uploadBatch) {
    const spec = t.isAtmos ? 'Dolby Atmos' : (t.quality || describeTrackQuality(t) || t.format);
    logCli('INDEX', `${ITALIC}${t.title}${RESET} • ${BOLD}${t.artist}${RESET} • ${BOLD}${spec}${RESET}`);
  }
  uploadBatch = [];
  uploadBatchTimer = null;
}

function queueUploadedTrackLog(track) {
  uploadBatch.push(track);
  if (uploadBatchTimer) clearTimeout(uploadBatchTimer);
  uploadBatchTimer = setTimeout(flushUploadBatch, 1500);
}

async function processTrackUpload(newTrack) {
  if (!newTrack || !newTrack.id) return null;

  // Prevent duplicate processing if this exact Telegram message is already indexed or pending deletion
  if (trackIndex.some((t) => String(t.id) === String(newTrack.id)) || pendingDeletions.has(String(newTrack.id))) {
    return null;
  }

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
    queueUploadedTrackLog(newTrack);
    return newTrack;
  }

  const scoreNew = getQualityScore(newTrack);
  const scoreOld = getQualityScore(existingDup);

  if (scoreNew > scoreOld) {
    // Incoming track is HIGHER quality (e.g. 24/192 replacing 16/44.1, or FLAC replacing MP3)
    logCli('DUPLICATE', `${ITALIC}${newTrack.title}${RESET} -> Upgraded from ${describeTrackQuality(existingDup)} to ${BOLD}${describeTrackQuality(newTrack)}${RESET} (Replacing ID: ${existingDup.id})`);

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
    // Incoming track is LOWER or EQUAL quality: schedule deletion with grace window!
    const isLower = scoreNew < scoreOld;
    const reason = isLower ? 'lower_quality' : 'identical';
    const graceHours = Math.round(DUPLICATE_GRACE_PERIOD_MS / (60 * 60 * 1000));
    const graceText = graceHours >= 1 ? `${graceHours} hours` : `${Math.round(DUPLICATE_GRACE_PERIOD_MS / 1000)}s`;
    logCli('DUPLICATE', `${ITALIC}${newTrack.title}${RESET} (ID: ${BOLD}${newTrack.id}${RESET}) -> ${reason === 'lower_quality' ? 'Lower quality copy' : 'Identical copy'} (Deleting in ${graceText}, send /keep to save)`);

    pendingDeletions.set(String(newTrack.id), {
      timer: null,
      track: newTrack,
      existingDup,
      reason,
      noticeMsgId: null,
    });

    let noticeMsg = null;
    if (channelEntity) {
      const noticeText = isLower
        ? `<b>Duplicate detected:</b> Lower quality (${describeTrackQuality(newTrack)}) than existing copy (${describeTrackQuality(existingDup)}). Deleting in ${graceText}... (Send <code>/keep</code> to save)`
        : `<b>Duplicate detected:</b> Identical copy already in library. Deleting in ${graceText}... (Send <code>/keep</code> to save)`;

      noticeMsg = await sendChannelMessage(noticeText, {
        parseMode: 'html',
        replyTo: parseInt(newTrack.id, 10),
      }).catch(() => null);
    }

    const timer = setTimeout(async () => {
      pendingDeletions.delete(String(newTrack.id));
      logCli('DUPLICATE', `${ITALIC}${newTrack.title}${RESET} (ID: ${BOLD}${newTrack.id}${RESET}) -> Grace period expired, deleted from channel`);
      const msgsToDelete = [newTrack.id];
      if (noticeMsg && noticeMsg.id) {
        deleteMessageViaBot(noticeMsg.id).catch(() => {});
        msgsToDelete.push(noticeMsg.id);
      }
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

    const record = pendingDeletions.get(String(newTrack.id));
    if (record) {
      record.timer = timer;
      record.noticeMsgId = noticeMsg?.id || null;
    }

    return {
      discarded: true,
      reason,
      keptQuality: describeTrackQuality(existingDup),
      deletedQuality: describeTrackQuality(newTrack),
    };
  }
}

async function deduplicateEntireLibrary() {
  const removed = [];
  const sorted = [...trackIndex].sort((a, b) => {
    const scoreDiff = getQualityScore(b) - getQualityScore(a);
    if (scoreDiff !== 0) return scoreDiff;
    // Tie-breaker: keep the one with slightly larger file size (often means better metadata/art)
    const sizeDiff = (b.sizeBytes || 0) - (a.sizeBytes || 0);
    if (sizeDiff !== 0) return sizeDiff;
    // Final tie-breaker: keep the oldest track
    return parseInt(a.id, 10) - parseInt(b.id, 10);
  });
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
      logCli('DUPLICATE', `${ITALIC}${track.title}${RESET} (ID: ${BOLD}${track.id}${RESET}) -> Removed duplicate in favor of ID: ${BOLD}${dup.id}${RESET}`);
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
    logCli('LIBRARY', `Indexing complete: ${BOLD}${trackIndex.length}${RESET} tracks loaded ${DIM}• Removed ${removed.length} duplicates${RESET}`);
    await flushDigestNotifications();
  } else {
    logCli('LIBRARY', `Indexing complete: ${BOLD}${trackIndex.length}${RESET} tracks loaded ${DIM}• Deduplication 100% clean${RESET}`);
  }

  await cleanupOrphanedDuplicateNotices().catch(() => {});

  return { checked: trackIndex.length, duplicatesRemoved: removed.length, removed };
}

let isIndexing = false;

async function buildTrackIndex() {
  if (isIndexing) return;
  isIndexing = true;
  fastStartCache.clear();
  try {
    const newIndex = [];
    const seenIds = new Set();
    let batchCount = 0;

    for await (const msg of client.iterMessages(channelEntity, { limit: 5000, waitTime: 0 })) {
      const msgIdStr = String(msg.id);
      if (seenIds.has(msgIdStr)) continue;
      seenIds.add(msgIdStr);

      const doc = msg.media?.document;
      if (!doc || !isAudioDocument(doc)) {
        continue;
      }

      mediaCache.set(msgIdStr, msg.media);

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
    }

    trackIndex = newIndex;
    updateMediaCacheCapacity();
    lastIndexed = Date.now();
    saveCache();
    await deduplicateEntireLibrary();
    rebuildWebDavFileMap();
  } catch (err) {
    console.error('Error during track indexing:', err.message);
  } finally {
    isIndexing = false;
  }
}

function findTrack(id) {
  return trackIndex.find((t) => t.id === id);
}

// ── Optional Secret URL Path Protection ────────────────────────────────────
app.use((req, res, next) => {
  const currentSecret = getUrlSecret();

  // Exempt setup routes, static assets, health monitoring, and icon
  if (
    req.path.startsWith('/setup') ||
    req.path.startsWith('/public') ||
    req.path.startsWith('/api/setup') ||
    req.path === '/ping' ||
    req.path === '/icon.png' ||
    req.path === '/favicon.ico'
  ) {
    return next();
  }

  // If no secret is configured, allow all traffic directly
  if (!currentSecret) {
    return next();
  }

  const prefix = `/${currentSecret}`;
  const encodedPrefix = `/${encodeURIComponent(currentSecret)}`;
  const matchedPrefix =
    req.url === prefix || req.url.startsWith(`${prefix}/`) || req.url.startsWith(`${prefix}?`)
      ? prefix
      : req.url === encodedPrefix || req.url.startsWith(`${encodedPrefix}/`) || req.url.startsWith(`${encodedPrefix}?`)
      ? encodedPrefix
      : null;

  if (matchedPrefix) {
    req.secretPrefix = currentSecret;
    let newUrl = req.url.slice(matchedPrefix.length);
    if (!newUrl.startsWith('/')) {
      newUrl = '/' + newUrl;
    }
    req.url = newUrl;
    req._parsedUrl = undefined;
    return next();
  }

  // Also support secret via query param or authorization header (Bearer or Basic)
  if (
    req.query.secret === currentSecret ||
    req.headers['x-secret-token'] === currentSecret ||
    req.headers.authorization === `Bearer ${currentSecret}`
  ) {
    req.secretPrefix = currentSecret;
    return next();
  }

  if (req.headers.authorization && req.headers.authorization.startsWith('Basic ')) {
    try {
      const credentials = Buffer.from(req.headers.authorization.slice(6), 'base64').toString('utf8');
      const [user, pass] = credentials.split(':');
      if (user === currentSecret || pass === currentSecret) {
        req.secretPrefix = '';
        return next();
      }
    } catch (_) {}
  }

  // For WebDAV clients accessing /dav without credentials, challenge with Basic Auth
  const isWebDavPath = req.url === '/dav' || req.url.startsWith('/dav/') || req.url.startsWith('/dav?');
  if (isWebDavPath) {
    res.setHeader('WWW-Authenticate', 'Basic realm="TeleMusic WebDAV"');
    return res.status(401).send('Unauthorized: WebDAV requires authentication');
  }

  console.warn(`[Security] Blocked unauthorized request to ${req.originalUrl || req.url} from ${req.ip}`);
  return res.status(401).json({
    error: 'Unauthorized: invalid or missing secret path',
    message: 'This Telegram Music Addon instance requires a valid secret URL prefix (e.g. /:secret/manifest.json)',
  });
});

// ── BitChord / Stremio Addon Endpoints ─────────────────────────────────────

// Addon Icon: BitChord fetches this badge to display in the Sources settings list
app.get('/icon.png', (req, res) => {
  const iconPath = path.resolve(__dirname, 'icon.png');
  if (fs.existsSync(iconPath)) {
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.sendFile(iconPath);
  }
  res.status(404).send('Icon not found');
});

// Favicon: Serve icon.png for browsers requesting /favicon.ico
app.get('/favicon.ico', (req, res) => {
  const iconPath = path.resolve(__dirname, 'icon.png');
  if (fs.existsSync(iconPath)) {
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.sendFile(iconPath);
  }
  res.status(404).end();
});

// Mobile Install Page: Clean landing page for mobile scanning
app.get('/install', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'install.html'));
});

// Manifest: BitChord queries this to verify addon id, name, and capabilities
app.get('/manifest.json', (req, res) => {
  const base = getBaseUrl(req);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=600');
  res.json({
    id: 'com.personal.telegrammusic',
    name: 'Telegram Music Addon',
    version: `${pkg.version} • ${trackIndex.length} songs`,
    description: 'Personal hi-res, lossless, and high-quality music library streamed directly from Telegram',
    icon: `${base}/icon.png`,
    canServeLossless: true,
    canServeDolbyAtmos: true,
    resources: ['search', 'stream', 'isrc'],
    types: ['track'],
    contentType: 'music',
    settings: [
      {
        key: 'quality',
        type: 'select',
        default: 'lossless',
        options: [
          { label: 'Lossless (FLAC/ALAC)', value: 'lossless' },
          { label: 'High (320kbps MP3)', value: 'high' },
          { label: 'Low (Data Saver)', value: 'low' },
        ],
      },
      {
        key: 'atmos',
        type: 'select',
        default: 'auto',
        options: [
          { label: 'Dolby Atmos (Spatial Audio)', value: 'auto' },
          { label: 'Stereo Only', value: 'off' },
        ],
      },
    ],
    endpoints: {
      search: `${base}/search?q={query}`,
      isrc: `${base}/isrc/{isrc}`,
      stream: `${base}/stream/{id}`,
      audio: `${base}/audio/{id}`,
    },
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

// Clean lossy tracks endpoint: purges lossy MP3/M4A/Opus tracks under threshold (default 10MB)
app.all('/clean-lossy', async (req, res) => {
  try {
    const maxSizeMb = Number(req.query.maxSizeMb) || 10;
    const confirm = req.query.confirm === 'true';

    const targets = trackIndex.filter((t) => {
      if (t.keep) return false;
      const isAtmos = Boolean(t.isAtmos || t.format === 'eac3-joc' || t.quality === 'Dolby Atmos');
      const fmt = (t.format || '').toLowerCase();
      const sizeMb = (t.sizeBytes || 0) / (1024 * 1024);
      return !isAtmos && !['flac', 'alac', 'wav'].includes(fmt) && sizeMb <= maxSizeMb;
    });

    if (!confirm) {
      return res.json({
        dryRun: true,
        count: targets.length,
        message: 'Pass ?confirm=true to permanently delete these messages from Telegram and remove from library.',
        tracks: targets.map((t) => ({
          id: t.id,
          title: t.title,
          artist: t.artist,
          format: t.format,
          sizeMb: ((t.sizeBytes || 0) / (1024 * 1024)).toFixed(2),
        })),
      });
    }

    const idsToDelete = targets.map((t) => t.id);
    if (idsToDelete.length > 0) {
      console.log(`[Clean Lossy] Deleting ${idsToDelete.length} lossy tracks from Telegram channel...`);
      // Delete in batches of 50 to respect Telegram bulk deletion limits
      for (let i = 0; i < idsToDelete.length; i += 50) {
        const batch = idsToDelete.slice(i, i + 50);
        await deleteTelegramMessages(batch);
      }

      const targetIdSet = new Set(idsToDelete.map(String));
      trackIndex = trackIndex.filter((t) => !targetIdSet.has(String(t.id)));
      for (const id of idsToDelete) {
        mediaCache.delete(id);
        fastStartCache.delete(id);
      }
      saveCache();
      updateMediaCacheCapacity();
      console.log(`[Clean Lossy] Successfully deleted ${idsToDelete.length} lossy tracks.`);
    }

    res.json({
      success: true,
      deletedCount: idsToDelete.length,
      deletedTracks: targets.map((t) => ({
        id: t.id,
        title: t.title,
        artist: t.artist,
        format: t.format,
        sizeMb: ((t.sizeBytes || 0) / (1024 * 1024)).toFixed(2),
      })),
    });
  } catch (err) {
    console.error('Clean lossy error:', err);
    res.status(500).json({ error: err.message });
  }
});

const ARTIST_SEPARATORS_REGEX = /\s*(?:[,&/;·|]|\band\b|\bx\b|\bvs\.?\b|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b|\bwith\b)\s*/i;
const BRACKETED_REGEX = /[([][^()[\]]*[)\]]/g;
const NOISE_WORDS_REGEX = /\b(?:official|video|audio|lyrics|lyric|lyrical|song|songs|full|hd|hq|4k|mp3|flac|ost|soundtrack|remaster|remastered|atmos|dolby)\b/gi;
const VERSION_SUFFIX_REGEX = /\s+[-\u2013\u2014]+\s+(?:new version|version|lofi|remix|acoustic|live|slowed|reverb|edit|revisited|unplugged|original mix|extended mix|deluxe).*$/gi;

function extractCoreTitle(title) {
  if (!title) return '';
  let clean = title.toLowerCase();
  clean = clean.replace(BRACKETED_REGEX, ' ');
  clean = clean.replace(NOISE_WORDS_REGEX, ' ');
  clean = clean.replace(VERSION_SUFFIX_REGEX, ' ');
  clean = clean.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  return clean.replace(/\s+/g, ' ').trim();
}

function indexTrackKeywords(t) {
  if (!t) return t;
  const words = new Set();
  const rawWordsList = [];
  const addWords = (str) => {
    if (!str) return;
    const tokens = String(str).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    for (const tok of tokens) {
      words.add(tok);
      rawWordsList.push(tok);
    }
  };

  addWords(t.title);
  addWords(extractCoreTitle(t.title));
  addWords(t.artist);
  addWords(t.album);
  if (t.isrc) words.add(String(t.isrc).toLowerCase().trim());

  Object.defineProperty(t, '_searchWords', { value: words, enumerable: false, writable: true, configurable: true });
  Object.defineProperty(t, '_searchWordsArray', { value: rawWordsList, enumerable: false, writable: true, configurable: true });
  Object.defineProperty(t, '_searchFullText', {
    value: `${(t.title || '').toLowerCase()} ${(t.artist || '').toLowerCase()} ${(t.album || '').toLowerCase()}`,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return t;
}

function parseArtistTokens(artistStr) {
  if (!artistStr) return [];
  const parts = artistStr.toLowerCase().split(ARTIST_SEPARATORS_REGEX);
  const result = [];
  for (const p of parts) {
    const words = p.replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 0);
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

function scoreTrackMatch(track, qContext) {
  if (!qContext) return 100;
  const ctx = typeof qContext === 'string'
    ? {
        qClean: qContext.toLowerCase().trim(),
        queryCore: extractCoreTitle(qContext.toLowerCase().trim()),
        queryTokens: qContext.toLowerCase().trim().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 0),
        wordRegex: null,
        targetDuration: null,
      }
    : qContext;

  const { qClean, queryCore, queryTokens, wordRegex, targetDuration } = ctx;
  if (!qClean) return 100;

  // Exact ISRC match (if search query matches track ISRC)
  if (track.isrc && qClean && String(track.isrc).trim().toLowerCase() === qClean) {
    return 500;
  }

  const trackTitle = (track.title || '').toLowerCase();
  const trackTitleCore = extractCoreTitle(track.title);
  const titleTokens = trackTitleCore.split(/\s+/).filter(Boolean);
  const trackArtist = (track.artist || '').toLowerCase();
  const trackAlbum = (track.album || '').toLowerCase();

  const queryCoreCompact = queryCore.replace(/\s+/g, '');
  const trackTitleCoreCompact = trackTitleCore.replace(/\s+/g, '');

  const cleanRawTitle = trackTitle.replace(/[^\p{L}\p{N}]/gu, '');
  const cleanRawQuery = qClean.replace(/[^\p{L}\p{N}]/gu, '');

  let baseScore = 0;

  // Exact full title match (e.g. includes version tag like "(甜妹版)")
  if (cleanRawTitle && cleanRawTitle === cleanRawQuery) {
    baseScore = 350;
  } else if (queryCore && trackTitleCore) {
    // Query starts with title, followed by artist or extra keywords (e.g. "da da da 芊芊龍")
    const isTitlePrefix = queryCore.startsWith(trackTitleCore + ' ') ||
      (trackTitleCoreCompact && queryCore.startsWith(trackTitleCoreCompact + ' '));
    if (isTitlePrefix) {
      const extraWords = queryCore.startsWith(trackTitleCore + ' ')
        ? queryCore.slice(trackTitleCore.length).trim()
        : queryCore.slice(trackTitleCoreCompact.length).trim();
      if (!extraWords) {
        baseScore = 250;
      } else if (trackArtist.includes(extraWords) || sharesArtist(extraWords, track.artist)) {
        baseScore = 400; // Perfect match: Title + Artist!
      } else if (trackAlbum && trackAlbum.includes(extraWords)) {
        baseScore = 320;
      } else if (trackTitle.includes(extraWords)) {
        baseScore = 310;
      } else {
        const extraTokens = extraWords.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 0);
        const hasArtistToken = extraTokens.some((w) => trackArtist.includes(w) || sharesArtist(w, track.artist));
        const hasAlbumToken = extraTokens.some((w) => trackAlbum.includes(w));
        if (hasArtistToken) {
          baseScore = 380;
        } else if (hasAlbumToken) {
          baseScore = 300;
        } else {
          // Extra words belong to a different artist! Penalize so it cannot hijack the search
          baseScore = 120;
        }
      }
    }
  }

  // Exact core title match (e.g. "ada" matches "Ada (From Garam Masala)")
  if (baseScore === 0 && queryCore && (queryCore === trackTitleCore || (queryCoreCompact && queryCoreCompact === trackTitleCoreCompact))) {
    baseScore = (track.title || '').includes('(') || (track.title || '').includes('[') ? 295 : 300;
  }

  // Whole word match in title (e.g. "ada" as an isolated word)
  if (baseScore === 0 && wordRegex && (wordRegex.test(trackTitleCore) || wordRegex.test(trackTitle))) {
    baseScore = 200;
  }

  // Token matching: when track title is fully inside query tokens
  if (baseScore === 0 && titleTokens.length > 0 && titleTokens.every((tw) => queryTokens.includes(tw))) {
    const extraTokens = queryTokens.filter((qw) => !titleTokens.includes(qw));
    if (extraTokens.length === 0) {
      baseScore = 250;
    } else {
      const hasArtistToken = extraTokens.some((qw) => trackArtist.includes(qw) || sharesArtist(qw, track.artist));
      const hasAlbumToken = extraTokens.some((qw) => trackAlbum.includes(qw));
      if (hasArtistToken) baseScore = 380;
      else if (hasAlbumToken) baseScore = 300;
      else if (titleTokens.length >= 2 || trackTitleCore.length >= 8) baseScore = 170;
    }
  }

  // Token matching: whole-word matching across title, artist, album
  if (baseScore === 0) {
    const trackWords = [
      ...trackTitleCore.split(/[^\p{L}\p{N}]+/u),
      ...trackArtist.split(/[^\p{L}\p{N}]+/u),
      ...trackAlbum.split(/[^\p{L}\p{N}]+/u),
    ].filter(Boolean);
    const trackWordSet = new Set(trackWords);

    let matchCount = 0;
    for (let i = 0; i < queryTokens.length; i++) {
      const tok = queryTokens[i];
      if (trackWordSet.has(tok)) {
        matchCount++;
      } else if (tok.length >= 4 && trackWords.some((tw) => tw.startsWith(tok) || tok.startsWith(tw))) {
        matchCount++;
      }
    }
    const ratio = queryTokens.length > 0 ? matchCount / queryTokens.length : 0;
    if (ratio >= 0.6) {
      baseScore = Math.round(ratio * 120);
    } else if (qClean.length >= 5) {
      const fullText = `${trackTitle} ${trackArtist} ${trackAlbum}`;
      if (fullText.includes(qClean)) baseScore = 60;
    }
  }

  // Duration proximity scoring (if duration is provided by client or caller)
  if (baseScore > 0 && targetDuration && track.duration) {
    const diff = Math.abs(track.duration - targetDuration);
    if (diff <= 2) {
      baseScore += 50; // High confidence duration match (within 2s)
    } else if (diff <= 5) {
      baseScore += 25; // Moderate duration match (within 5s)
    } else if (diff > 15) {
      baseScore = Math.max(10, baseScore - 80); // Major mismatch penalty (> 15s)
    }
  }

  return baseScore;
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

function formatTrackForClient(t, base) {
  const isAtmos = Boolean(t.isAtmos);
  const fmt = (t.format || '').toLowerCase();
  const isLossless = ['flac', 'alac', 'wav'].includes(fmt);
  const isHiRes = isLossless && ((t.bitDepth && t.bitDepth > 16) || (t.sampleRate && t.sampleRate > 44100));
  const qualityTier = isAtmos ? 'DOLBY_ATMOS' : (isHiRes ? 'HI_RES' : (isLossless ? 'LOSSLESS' : 'HIGH'));

  return {
    id: String(t.id),
    title: t.title,
    artist: formatArtistForClient(t.artist),
    album: t.album || '',
    duration: t.duration ? Math.round(t.duration) : undefined,
    format: isAtmos ? 'eac3-joc' : t.format,
    audioQuality: qualityTier,
    quality: qualityTier,
    tier: qualityTier,
    bitDepth: t.bitDepth || (isHiRes ? 24 : 16),
    sampleRate: t.sampleRate || (isHiRes ? 96000 : 44100),
    audioModes: isAtmos ? ['DOLBY_ATMOS'] : ['STEREO'],
    atmos: isAtmos ? true : undefined,
    artworkURL: t.hasArtwork ? `${base}/artwork/${t.id}` : undefined,
    albumArtworkURL: t.hasArtwork ? `${base}/artwork/${t.id}` : undefined,
    stream: `${base}/stream/${t.id}`,
    streamURL: `${base}/audio/${t.id}`,
    streamUrl: `${base}/audio/${t.id}`,
    audio: `${base}/audio/${t.id}`,
    audioUrl: `${base}/audio/${t.id}`,
    isrc: t.isrc,
  };
}

app.get('/search', async (req, res) => {
  const startTime = Date.now();
  try {
    const q = (req.query.q || '').toLowerCase().trim();
    const base = getBaseUrl(req);
    const prefersAtmos = req.query.atmos === 'auto' || req.query.atmos === 'true';

    let matches = trackIndex;
    if (q) {
      const queryCore = extractCoreTitle(q);
      const queryTokens = q.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 0);
      const escapedCore = q.replace(/[^\p{L}\p{N}]/gu, '');
      const wordRegex = escapedCore ? new RegExp(`\\b${escapedCore}\\b`, 'i') : null;
      const targetDuration = parseInt(req.query.duration || req.query.d, 10) || null;
      const qContext = { qClean: q, queryCore, queryTokens, wordRegex, targetDuration };

      // Phase 1: Fast Gatekeeper Candidate Selection (<0.5ms filter)
      const candidates = [];
      for (let i = 0; i < trackIndex.length; i++) {
        const t = trackIndex[i];
        let isCandidate = false;

        if (t._searchWords) {
          for (let j = 0; j < queryTokens.length; j++) {
            const qTok = queryTokens[j];
            if (t._searchWords.has(qTok)) {
              isCandidate = true;
              break;
            }
            if (qTok.length >= 4 && t._searchWordsArray) {
              for (let k = 0; k < t._searchWordsArray.length; k++) {
                const tw = t._searchWordsArray[k];
                if (tw.startsWith(qTok) || qTok.startsWith(tw)) {
                  isCandidate = true;
                  break;
                }
              }
              if (isCandidate) break;
            }
          }
        } else {
          // Lazy index track on the fly if not indexed yet
          indexTrackKeywords(t);
          isCandidate = true;
        }

        if (!isCandidate && q.length >= 4 && t._searchFullText && t._searchFullText.includes(q)) {
          isCandidate = true;
        }

        if (isCandidate) {
          candidates.push(t);
        }
      }

      // Safety fallback: if no candidate matched (e.g. extreme typo or edge case), evaluate all tracks
      const pool = candidates.length > 0 ? candidates : trackIndex;

      // Phase 2: Surgical Multi-Token Scoring & Ranking
      const scoredCandidates = pool
        .map((t) => {
          let score = scoreTrackMatch(t, qContext);
          if (score > 0 && prefersAtmos && t.isAtmos) {
            score += 20;
          }
          return { track: t, score };
        })
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score);

      matches = scoredCandidates.map((item) => item.track);

      // Pre-warm top match on confident search hits (score >= 200: exact core title or title+artist match)
      if (scoredCandidates.length > 0 && scoredCandidates[0].score >= 200) {
        const top = scoredCandidates[0].track;
        const cached = fastStartCache.get(top.id);
        if (!cached || cached.length < FAST_START_BYTES) {
          setImmediate(() => {
            prewarmTrackPreamble(top.id, null, top.title).catch(() => {});
          });
        }
      }
    } else if (prefersAtmos) {
      matches = [...trackIndex].sort((a, b) => (b.isAtmos ? 1 : 0) - (a.isAtmos ? 1 : 0));
    }

    const elapsed = Date.now() - startTime;
    if (q) {
      const topMatch = matches[0];
      const topStr = topMatch
        ? ` -> ID: ${BOLD}${topMatch.id}${RESET}`
        : ` -> ${DIM}No match${RESET}`;
      logCli('SEARCH', `${ITALIC}"${q}"${RESET} ${DIM}(${matches.length} hits, ${elapsed}ms)${RESET}${topStr}`);
    }
    recordRequest({
      timestamp: new Date().toISOString(),
      type: 'search',
      query: req.query.q || '',
      tier: req.query.quality || 'NONE',
      atmos: prefersAtmos,
      resultsCount: matches.length,
      topResult: matches[0] ? `${matches[0].title} - ${matches[0].artist} (${matches[0].duration}s)` : null,
      elapsedMs: elapsed,
    });

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    res.json({
      tracks: matches.slice(0, 60).map((t) => formatTrackForClient(t, base)),
    });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: err.message });
  }
});

function handleIsrcLookup(req, res) {
  const rawCode = req.params.code || req.query.code || req.query.isrc || '';
  const cleanCode = String(rawCode).replace(/\.json$/i, '').trim().toUpperCase();

  if (!cleanCode) {
    if (req.path.includes('resolve-isrc')) {
      return res.status(400).json({ error: 'ISRC code required', trackId: null });
    }
    return res.status(400).json({ error: 'ISRC code required', tracks: [] });
  }

  const base = getBaseUrl(req);
  const matches = trackIndex.filter(
    (t) => t.isrc && String(t.isrc).trim().toUpperCase() === cleanCode
  );

  const topStr = matches[0] ? ` -> Matched: "${matches[0].title}" (ID: ${matches[0].id})` : ' -> No match';
  console.log(`[ISRC] "${cleanCode}" (${matches.length} found)${topStr}`);

  recordRequest({
    timestamp: new Date().toISOString(),
    type: 'isrc',
    query: cleanCode,
    resultsCount: matches.length,
    topResult: matches[0] ? `${matches[0].title} - ${matches[0].artist}` : null,
  });

  if (req.path.includes('resolve-isrc')) {
    if (matches.length > 0) {
      return res.json({ trackId: matches[0].id, id: matches[0].id });
    }
    return res.status(404).json({ error: 'Track not found', trackId: null });
  }

  res.json({
    tracks: matches.map((t) => formatTrackForClient(t, base)),
  });
}

app.get('/isrc/:code', handleIsrcLookup);
app.get('/isrc', handleIsrcLookup);
app.get('/resolve-isrc', handleIsrcLookup);

app.get('/stream/:id', (req, res) => {
  const track = findTrack(req.params.id);
  const base = getBaseUrl(req);
  const isAtmos = Boolean(track?.isAtmos);
  const fmt = (track?.format || '').toLowerCase();
  const isLossless = ['flac', 'alac', 'wav'].includes(fmt);
  const isHiRes = isLossless && ((track?.bitDepth && track.bitDepth > 16) || (track?.sampleRate && track.sampleRate > 44100));
  const qualityTier = isAtmos ? 'DOLBY_ATMOS' : (isHiRes ? 'HI_RES' : (isLossless ? 'LOSSLESS' : 'HIGH'));

  if (track) {
    const cached = fastStartCache.get(req.params.id);
    if (!cached || cached.length < FAST_START_BYTES) {
      setImmediate(() => {
        prewarmTrackPreamble(req.params.id, null, track.title).catch(() => {});
      });
    }
  }

  recordRequest({
    timestamp: new Date().toISOString(),
    type: 'stream',
    id: req.params.id,
    track: track ? `${track.title} - ${track.artist}` : 'NOT_FOUND',
    quality: track ? track.quality : 'UNKNOWN',
    tier: req.query.quality || 'NONE',
    atmos: isAtmos,
  });

  if (!track) {
    return res.status(404).json({ error: 'Track not found' });
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300');

  res.json({
    url: `${base}/audio/${req.params.id}`,
    format: isAtmos ? 'eac3-joc' : (track.format || 'flac'),
    codec: isAtmos ? 'eac3-joc' : (track.format || 'flac'),
    container: isAtmos ? 'mp4' : (track.format || 'flac'),
    manifest: 'none',
    encrypted: false,
    audioMode: isAtmos ? 'DOLBY_ATMOS' : 'STEREO',
    sampleRate: track.sampleRate || 44100,
    bitDepth: track.bitDepth || 16,
    quality: qualityTier,
    audioQuality: qualityTier,
    tier: qualityTier,
    streamQuality: isAtmos ? 'Dolby Atmos' : (track.quality || qualityTier),
    description: track.quality,
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

    const stripped = thumbs.find((t) => t instanceof Api.PhotoStrippedSize);
    if (stripped) {
      const jpg = utils.strippedPhotoToJpg(stripped.bytes);
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
      res.setHeader('ETag', `"${track.id}-art"`);
      return res.send(jpg);
    }

    let targetMedia = media;
    let thumbBuf = null;
    try {
      thumbBuf = await client.downloadMedia(targetMedia, { thumb: 0 });
    } catch (thumbErr) {
      if (isFileReferenceError(thumbErr)) {
        const freshMedia = await getMediaForTrack(req.params.id, true);
        if (freshMedia) {
          thumbBuf = await client.downloadMedia(freshMedia, { thumb: 0 });
        }
      } else {
        throw thumbErr;
      }
    }

    if (!thumbBuf || thumbBuf.length === 0) {
      return res.status(404).send('No artwork thumbnail');
    }

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.setHeader('ETag', `"${track.id}-art"`);
    res.send(thumbBuf);
  } catch (err) {
    console.error('Artwork fetch error:', err.message);
    res.status(404).send('Artwork not available');
  }
});

async function streamAudioTrack(trackId, req, res) {
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
    const track = findTrack(trackId);
    if (!track) return res.status(404).send('Track not found');

    const media = await getMediaForTrack(trackId);
    if (!media) return res.status(404).send('Media not found');

    if (isConnectionClosed) return;

    // If a background pre-warm is currently running for this track, cancel it to prevent duplicate MTProto downloads
    if (inFlightPrewarmIters.has(trackId)) {
      const bgIter = inFlightPrewarmIters.get(trackId);
      inFlightPrewarmIters.delete(trackId);
      if (bgIter) {
        bgIter.left = 0;
        if (typeof bgIter.close === 'function') bgIter.close().catch(() => {});
      }
    }

    const totalSize = Number(track.sizeBytes) || Number(media.document?.size) || 0;
    if (!totalSize || isNaN(totalSize)) {
      console.error(`Invalid totalSize for track ${trackId}`);
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

    start = Math.max(0, Math.min(start, totalSize - 1));
    end = Math.max(start, Math.min(end, totalSize - 1));
    const bytesNeeded = end - start + 1;

    // Detect if request originated from WebDAV (/dav)
    const isWebDav = Boolean(
      (req.originalUrl && req.originalUrl.includes('/dav')) ||
      (req.baseUrl && req.baseUrl.includes('/dav')) ||
      (req.path && req.path.includes('/dav'))
    );

    // Fast cache validation
    if (!isRange && req.headers['if-none-match'] === `"${track.id}-${totalSize}"`) {
      return res.status(304).end();
    }

    // Return cached header or tag slice when available
    if (tagSliceCache.has(trackId)) {
      const cachedTagBuf = tagSliceCache.get(trackId);
      if (cachedTagBuf && start < cachedTagBuf.length) {
        const availableInTagCache = cachedTagBuf.length - start;
        if (availableInTagCache >= bytesNeeded) {
          res.status(isRange ? 206 : 200);
          res.setHeader('Content-Type', track.isAtmos ? 'audio/mp4' : (track.mimeType || (track.format === 'flac' ? 'audio/flac' : 'application/octet-stream')));
          res.setHeader('Accept-Ranges', 'bytes');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('Keep-Alive', 'timeout=30, max=100');
          res.setHeader('Content-Length', bytesNeeded);
          if (isRange) {
            res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
          }
          res.setHeader('ETag', `"${track.id}-${totalSize}"`);
          res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
          if (req.method === 'HEAD') return res.end();
          return res.send(cachedTagBuf.slice(start, start + bytesNeeded));
        }
      }
    }

    const isAudition = (start === 0 && bytesNeeded <= 128 * 1024);
    const isPlaybackStart = (start === 0 && bytesNeeded > 128 * 1024);

    const durStr = formatTrackDuration(track.duration);
    const durPart = durStr ? `${durStr}, ` : '';

    const statusStr = isRange ? '206 Partial' : '200 OK';

    if (lastServedAudioTrackId !== track.id && (isAudition || isPlaybackStart)) {
      lastServedAudioTrackId = track.id;
    }

    let hasLoggedPlayback = false;
    const maybeLogPlayback = (deliveredBytes) => {
      if (hasLoggedPlayback || !isPlaybackStart) return;
      if (deliveredBytes < Math.min(256 * 1024, bytesNeeded)) return;
      hasLoggedPlayback = true;
      const now = Date.now();
      if (currentlyPlayingTrackId !== track.id || (now - lastPlaybackLogTime > 4000)) {
        currentlyPlayingTrackId = track.id;
        lastPlaybackLogTime = now;
        lastSeekLogTime = now;
        lastSeekStart = 0;
        const sizeMb = (totalSize / (1024 * 1024)).toFixed(1);
        const spec = track.isAtmos ? 'Dolby Atmos' : (track.quality || track.format);
        const durPartFormatted = durStr ? ` ${DIM}(${durStr})${RESET}` : '';
        const tag = isWebDav ? 'WEBDAV' : (isRange ? 'STREAM' : 'PRECACHE');
        logCli(tag, `${ITALIC}${track.title}${RESET} • ${BOLD}${spec}${RESET} • ${BOLD}${sizeMb} MB${RESET}${durPartFormatted} ${DIM}-> ${statusStr}${RESET}`);
      }
    };

    if (isAudition && !isWebDav && process.env.DEBUG_PROBES === 'true') {
      logCli('PROBE', `${ITALIC}${track.title}${RESET} ${DIM}(${Math.round(bytesNeeded / 1024)} KB header read)${RESET}`);
    } else if (isRange && start >= 10 * 1024 * 1024 && bytesNeeded > 128 * 1024) {
      const now = Date.now();
      if ((now - lastSeekLogTime > 2000) || Math.abs(start - lastSeekStart) > 2 * 1024 * 1024) {
        lastSeekLogTime = now;
        lastSeekStart = start;
        const seekRatio = totalSize > 0 ? (start / totalSize) : 0;
        const seekSec = Math.round(seekRatio * (track.duration || 0));
        const seekTimeStr = formatTrackDuration(seekSec) || '0:00';
        const percent = Math.round(seekRatio * 100);
        const seekMb = (start / (1024 * 1024)).toFixed(1);
        logCli('SEEK', `${ITALIC}${track.title}${RESET} • ${BOLD}Seeked to ~${seekTimeStr}${RESET} ${DIM}(${percent}%) • ${seekMb} MB${RESET}`);
      }
    }

    recordRequest({
      timestamp: new Date().toISOString(),
      type: 'audio',
      id: trackId,
      range: range || 'none',
      bytes: `${start}-${end}/${totalSize}`,
      bytesNeeded,
      track: `${track.title} - ${track.artist}`,
    });

    res.status(isRange ? 206 : 200);
    res.setHeader('Content-Type', track.isAtmos ? 'audio/mp4' : (track.mimeType || (track.format === 'flac' ? 'audio/flac' : 'application/octet-stream')));
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Keep-Alive', 'timeout=30, max=100');
    res.setHeader('Content-Length', bytesNeeded);
    if (isRange) {
      res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
    }
    res.setHeader('ETag', `"${track.id}-${totalSize}"`);
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');

    if (req.method === 'HEAD') {
      return res.end();
    }

    // Telegram MTProto upload.GetFile requires requestSize to be a power of 2 (up to 512KB)
    // and offset MUST be an exact multiple of requestSize (offset % requestSize === 0).
    const dynamicBlockSize = (bytesNeeded <= 128 * 1024) ? (128 * 1024) : (512 * 1024);

    // Fast-Start RAM cache check
    let bytesSent = 0;

    const waitForDrain = () => new Promise((resolve) => {
      const onDrain = () => { req.removeListener('close', onClose); resolve(); };
      const onClose = () => { res.removeListener('drain', onDrain); resolve(); };
      res.once('drain', onDrain);
      req.once('close', onClose);
    });

    const cachedPreamble = fastStartCache.get(trackId);
    const useFastStart = Boolean(cachedPreamble && start < cachedPreamble.length);

    if (useFastStart) {
      const preambleSlice = cachedPreamble.slice(start, Math.min(cachedPreamble.length, start + bytesNeeded));
      if (!tagSliceCache.has(trackId)) {
        tagSliceCache.set(trackId, cachedPreamble.slice(0, Math.min(cachedPreamble.length, 256 * 1024)));
      }
      const canContinue = res.write(preambleSlice);
      bytesSent += preambleSlice.length;
      maybeLogPlayback(bytesSent);

      if (!canContinue && !res.writableEnded && !res.destroyed && !isConnectionClosed) {
        await waitForDrain();
      }

      if (bytesSent >= bytesNeeded) {
        if (!res.writableEnded && !isConnectionClosed) {
          res.end();
        }
        return;
      }
    }

    // Stream remaining bytes live from Telegram MTProto
    let currentMedia = media;
    let hasRefreshedRef = false;
    let existingCacheBuf = fastStartCache.get(trackId);
    let cacheBytesCollected = existingCacheBuf ? existingCacheBuf.length : 0;
    const preambleChunks = existingCacheBuf ? [existingCacheBuf] : [];

    while (bytesSent < bytesNeeded && !isConnectionClosed && !res.writableEnded && !res.destroyed) {
      const currentBytePos = start + bytesSent;
      // Align request offset to dynamicBlockSize boundary to prevent MTProto 400: OFFSET_INVALID
      const alignedOffset = Math.floor(currentBytePos / dynamicBlockSize) * dynamicBlockSize;
      let skipBytes = currentBytePos - alignedOffset;

      iterator = client.iterDownload({
        file: currentMedia,
        offset: bigInt(alignedOffset),
        requestSize: dynamicBlockSize,
      });

      try {
        for await (const chunk of iterator) {
          if (isConnectionClosed || res.writableEnded || res.destroyed) {
            iterator.left = 0;
            await iterator.close().catch(() => {});
            break;
          }

          if (start === 0 && !tagSliceCache.has(trackId)) {
            const sliceLen = Math.min(256 * 1024, chunk.length);
            if (sliceLen > 0) {
              tagSliceCache.set(trackId, chunk.slice(0, sliceLen));
            }
          }

          // Populate/extend fastStartCache up to FAST_START_BYTES only for real playback starts (start === 0)
          // This prevents background tag reads from evicting playing songs from RAM cache!
          if (start === 0 && alignedOffset === cacheBytesCollected && cacheBytesCollected < FAST_START_BYTES) {
            const needed = FAST_START_BYTES - cacheBytesCollected;
            const slice = chunk.slice(0, needed);
            preambleChunks.push(slice);
            cacheBytesCollected += slice.length;
            if (cacheBytesCollected >= FAST_START_BYTES || cacheBytesCollected >= totalSize) {
              const fullPreamble = Buffer.concat(preambleChunks);
              fastStartCache.set(trackId, fullPreamble);
              tagSliceCache.set(trackId, fullPreamble.slice(0, Math.min(fullPreamble.length, 256 * 1024)));
              const sizeFormatted = fullPreamble.length >= 1024 * 1024
                ? `${(fullPreamble.length / (1024 * 1024)).toFixed(1)} MB`
                : `${Math.round(fullPreamble.length / 1024)} KB`;
              if (!isWebDav) {
                logCli('BUFFER', `Prewarmed ${BOLD}${sizeFormatted}${RESET} -> ID: ${BOLD}${trackId}${RESET}`);
              }
            } else {
              const partial = Buffer.concat(preambleChunks);
              fastStartCache.set(trackId, partial);
              tagSliceCache.set(trackId, partial.slice(0, Math.min(partial.length, 256 * 1024)));
            }
          }

          // Discard unaligned preamble if currentBytePos was not on a block boundary
          let usableChunk = chunk;
          if (skipBytes > 0) {
            if (chunk.length <= skipBytes) {
              skipBytes -= chunk.length;
              continue;
            }
            usableChunk = chunk.slice(skipBytes);
            skipBytes = 0;
          }

          let toSend = usableChunk;
          let shouldBreak = false;

          if (bytesSent + usableChunk.length > bytesNeeded) {
            toSend = usableChunk.slice(0, bytesNeeded - bytesSent);
            shouldBreak = true;
          }

          bytesSent += toSend.length;
          maybeLogPlayback(bytesSent);
          if (bytesSent >= bytesNeeded) {
            shouldBreak = true;
          }

          const canContinue = res.write(toSend);
          if (!canContinue && !res.writableEnded && !res.destroyed && !isConnectionClosed) {
            await waitForDrain();
          }

          if (shouldBreak || isConnectionClosed) {
            iterator.left = 0;
            await iterator.close().catch(() => {});
            break;
          }
        }
        break;
      } catch (iterErr) {
        if (!hasRefreshedRef && isFileReferenceError(iterErr)) {
          hasRefreshedRef = true;
          console.warn(`[FileRef] File reference expired for "${track.title}" (ID: ${trackId}). Refreshing from Telegram cloud...`);
          const freshMedia = await getMediaForTrack(trackId, true);
          if (freshMedia) {
            currentMedia = freshMedia;
            console.log(`[FileRef] Refreshed file reference for "${track.title}" (ID: ${trackId}). Resuming stream from byte ${start + bytesSent}...`);
            continue;
          }
        }
        throw iterErr;
      }
    }

    if (!res.writableEnded && !isConnectionClosed) {
      res.end();
    }
  } catch (err) {
    if (!isConnectionClosed && !res.destroyed) {
      console.error(`Audio stream error for track ${trackId}:`, err.message);
      if (!res.headersSent) res.status(500).send(err.message);
      else res.end();
    }
  }
}

app.get('/audio/:id', (req, res) => streamAudioTrack(req.params.id, req, res));
app.head('/audio/:id', (req, res) => streamAudioTrack(req.params.id, req, res));

// ── WebDAV Protocol Implementation (/dav) ───────────────────────────────────

function sanitizeWebDavName(name) {
  return String(name || '')
    .replace(/[/\\?%*:|"<>]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

const webDavFileMap = new Map();

function getTrackWebDavAlbum(track) {
  if (track && track._webDavAlbum) return track._webDavAlbum;
  const rawAlbum = (track && track.album) ? String(track.album).trim() : '';
  const album = sanitizeWebDavName(rawAlbum) || 'Singles';
  if (track) track._webDavAlbum = album;
  return album;
}

function getTrackWebDavFileName(track) {
  if (track && track._webDavFileName) return track._webDavFileName;
  const ext = track.format === 'flac' ? 'flac' : (track.format === 'alac' ? 'm4a' : (track.isAtmos || track.format === 'eac3-joc' ? 'm4a' : (track.format || 'flac')));
  const artist = sanitizeWebDavName(track.artist || 'Unknown Artist');
  const title = sanitizeWebDavName(track.title || 'Untitled');
  return `${artist} - ${title}.${ext}`;
}

function rebuildWebDavFileMap() {
  webDavFileMap.clear();
  const seenCount = new Map();
  for (const track of trackIndex) {
    const ext = track.format === 'flac' ? 'flac' : (track.format === 'alac' ? 'm4a' : (track.isAtmos || track.format === 'eac3-joc' ? 'm4a' : (track.format || 'flac')));
    const artist = sanitizeWebDavName(track.artist || 'Unknown Artist');
    const title = sanitizeWebDavName(track.title || 'Untitled');
    const album = getTrackWebDavAlbum(track);
    const baseClean = `${artist} - ${title}`;
    const baseKey = `${album.toLowerCase()}:::${baseClean.toLowerCase()}`;

    let finalName = `${baseClean}.${ext}`;
    if (seenCount.has(baseKey)) {
      const count = seenCount.get(baseKey) + 1;
      seenCount.set(baseKey, count);
      finalName = `${baseClean} (${count}).${ext}`;
    } else {
      seenCount.set(baseKey, 1);
    }

    track._webDavFileName = finalName;
    track._webDavAlbum = album;

    const fullPathKey = `${album.toLowerCase()}/${finalName.toLowerCase()}`;
    webDavFileMap.set(fullPathKey, track.id);
    webDavFileMap.set(`${encodeURIComponent(album).toLowerCase()}/${encodeURIComponent(finalName).toLowerCase()}`, track.id);

    webDavFileMap.set(finalName.toLowerCase(), track.id);
    webDavFileMap.set(encodeURIComponent(finalName).toLowerCase(), track.id);
  }
}

function getTrackIdFromWebDavPath(urlPath) {
  if (!urlPath) return null;
  let decoded = urlPath;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch (_) {}
  const segments = decoded.replace(/^\/+/, '').split('/').filter(Boolean);
  if (segments.length >= 2) {
    const albumFolder = segments[segments.length - 2].trim().toLowerCase();
    const fileName = segments[segments.length - 1].trim().toLowerCase();
    const combinedKey = `${albumFolder}/${fileName}`;
    if (webDavFileMap.has(combinedKey)) {
      return webDavFileMap.get(combinedKey);
    }
  }
  const targetFile = (segments[segments.length - 1] || '').trim().toLowerCase();
  if (webDavFileMap.has(targetFile)) {
    return webDavFileMap.get(targetFile);
  }
  const matchBracket = decoded.match(/\[(\d+)\]\.[a-zA-Z0-9]+$/);
  if (matchBracket) return matchBracket[1];
  const matchParen = decoded.match(/\((\d+)\)\.[a-zA-Z0-9]+$/);
  if (matchParen) return matchParen[1];
  const matchIdExt = decoded.match(/(?:^|\/)(\d+)\.[a-zA-Z0-9]+$/);
  if (matchIdExt) return matchIdExt[1];
  const matchDirect = decoded.match(/(?:^|\/)(\d+)$/);
  if (matchDirect) return matchDirect[1];
  return null;
}

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildWebDavCollectionXml(href, displayName, lastMod = new Date().toUTCString()) {
  let xml = `  <D:response>\n`;
  xml += `    <D:href>${href}</D:href>\n`;
  xml += `    <D:propstat>\n`;
  xml += `      <D:prop>\n`;
  xml += `        <D:resourcetype><D:collection/></D:resourcetype>\n`;
  xml += `        <D:displayname>${escapeXml(displayName)}</D:displayname>\n`;
  xml += `        <D:getlastmodified>${lastMod}</D:getlastmodified>\n`;
  xml += `      </D:prop>\n`;
  xml += `      <D:status>HTTP/1.1 200 OK</D:status>\n`;
  xml += `    </D:propstat>\n`;
  xml += `  </D:response>\n`;
  return xml;
}

function buildWebDavFileXml(href, fileName, track) {
  const sizeBytes = track.sizeBytes || 0;
  const mimeType = track.isAtmos ? 'audio/mp4' : (track.mimeType || (track.format === 'flac' ? 'audio/flac' : 'application/octet-stream'));
  let xml = `  <D:response>\n`;
  xml += `    <D:href>${href}</D:href>\n`;
  xml += `    <D:propstat>\n`;
  xml += `      <D:prop>\n`;
  xml += `        <D:resourcetype/>\n`;
  xml += `        <D:displayname>${escapeXml(fileName)}</D:displayname>\n`;
  xml += `        <D:getcontentlength>${sizeBytes}</D:getcontentlength>\n`;
  xml += `        <D:getcontenttype>${mimeType}</D:getcontenttype>\n`;
  xml += `        <D:getetag>&quot;${track.id}-${sizeBytes}&quot;</D:getetag>\n`;
  xml += `        <D:getlastmodified>Sat, 26 Sep 2026 00:00:00 GMT</D:getlastmodified>\n`;
  xml += `      </D:prop>\n`;
  xml += `      <D:status>HTTP/1.1 200 OK</D:status>\n`;
  xml += `    </D:propstat>\n`;
  xml += `  </D:response>\n`;
  return xml;
}

function getWebDavArtistMap() {
  const map = new Map();
  for (const track of trackIndex) {
    const artistName = sanitizeWebDavName(track.artist || 'Unknown Artist');
    if (!map.has(artistName)) {
      map.set(artistName, []);
    }
    map.get(artistName).push(track);
  }
  return map;
}

app.all(['/dav', '/dav/*'], async (req, res) => {
  const method = req.method.toUpperCase();
  const basePrefix = req.secretPrefix ? `/${req.secretPrefix}` : '';

  if (method === 'OPTIONS') {
    res.setHeader('DAV', '1, 2');
    res.setHeader('MS-Author-Via', 'DAV');
    res.setHeader('Allow', 'OPTIONS, GET, HEAD, PROPFIND');
    return res.status(200).end();
  }

  // Extract relative sub-path after /dav or /dav/
  let subPath = req.path.replace(/^\/dav\/?/, '');
  try {
    subPath = decodeURIComponent(subPath);
  } catch (_) {}
  // Clean leading/trailing slashes
  subPath = subPath.replace(/^\/+/, '').replace(/\/+$/, '');

  const segments = subPath ? subPath.split('/') : [];
  const firstSeg = segments[0] || '';

  if (method === 'PROPFIND') {
    res.setHeader('DAV', '1, 2');
    const depth = req.headers.depth || '1';

    // Root collection request: /dav or /dav/
    if (!subPath) {
      let xml = `<?xml version="1.0" encoding="utf-8" ?>\n<D:multistatus xmlns:D="DAV:">\n`;
      xml += `  <D:response>\n`;
      xml += `    <D:href>${basePrefix}/dav/</D:href>\n`;
      xml += `    <D:propstat>\n`;
      xml += `      <D:prop>\n`;
      xml += `        <D:resourcetype><D:collection/></D:resourcetype>\n`;
      xml += `        <D:displayname>TeleMusic Library</D:displayname>\n`;
      xml += `        <D:getlastmodified>${new Date().toUTCString()}</D:getlastmodified>\n`;
      xml += `      </D:prop>\n`;
      xml += `      <D:status>HTTP/1.1 200 OK</D:status>\n`;
      xml += `    </D:propstat>\n`;
      xml += `  </D:response>\n`;

      if (depth !== '0') {
        for (const track of trackIndex) {
          const fileName = getTrackWebDavFileName(track);
          const album = getTrackWebDavAlbum(track);
          const itemHref = `${basePrefix}/dav/${encodeURIComponent(album)}/${encodeURIComponent(fileName)}`;
          xml += buildWebDavFileXml(itemHref, fileName, track);
        }
      }

      xml += `</D:multistatus>`;
      return res.status(207).set('Content-Type', 'application/xml; charset="utf-8"').send(xml);
    }

    // Check if subPath is an album collection (e.g. /dav/House%20Of%20Balloons or /dav/House%20Of%20Balloons/)
    const matchingTracks = trackIndex.filter(t => getTrackWebDavAlbum(t).toLowerCase() === subPath.toLowerCase());
    if (matchingTracks.length > 0) {
      const albumName = getTrackWebDavAlbum(matchingTracks[0]);
      let xml = `<?xml version="1.0" encoding="utf-8" ?>\n<D:multistatus xmlns:D="DAV:">\n`;
      xml += buildWebDavCollectionXml(`${basePrefix}/dav/${encodeURIComponent(albumName)}/`, albumName);
      if (depth !== '0') {
        for (const track of matchingTracks) {
          const fileName = getTrackWebDavFileName(track);
          const itemHref = `${basePrefix}/dav/${encodeURIComponent(albumName)}/${encodeURIComponent(fileName)}`;
          xml += buildWebDavFileXml(itemHref, fileName, track);
        }
      }
      xml += `</D:multistatus>`;
      return res.status(207).set('Content-Type', 'application/xml; charset="utf-8"').send(xml);
    }

    // Specific file PROPFIND: /dav/Album/Artist - Title.flac or /dav/Artist - Title.flac
    const targetFile = segments.length > 0 ? segments[segments.length - 1] : subPath;
    const trackId = getTrackIdFromWebDavPath(subPath) || getTrackIdFromWebDavPath(targetFile);
    const track = trackId ? findTrack(trackId) : null;
    if (!track) {
      return res.status(404).send('Not found');
    }

    if (!tagSliceCache.has(String(track.id)) && !fastStartCache.has(String(track.id))) {
      prewarmTrackPreamble(String(track.id), null, track.title).catch(() => {});
    }

    const fileName = getTrackWebDavFileName(track);
    const album = getTrackWebDavAlbum(track);
    const itemHref = `${basePrefix}/dav/${encodeURIComponent(album)}/${encodeURIComponent(fileName)}`;
    let xml = `<?xml version="1.0" encoding="utf-8" ?>\n<D:multistatus xmlns:D="DAV:">\n`;
    xml += buildWebDavFileXml(itemHref, fileName, track);
    xml += `</D:multistatus>`;
    return res.status(207).set('Content-Type', 'application/xml; charset="utf-8"').send(xml);
  }

  if (method === 'GET' || method === 'HEAD') {
    if (!subPath) {
      if (method === 'HEAD') return res.status(200).end();
      return res.send(`TeleMusic WebDAV Server is active. ${trackIndex.length} tracks available.`);
    }

    const targetFile = segments.length > 0 ? segments[segments.length - 1] : subPath;
    const trackId = getTrackIdFromWebDavPath(subPath) || getTrackIdFromWebDavPath(targetFile);
    if (!trackId) {
      return res.status(404).send('File not found in library');
    }

    const track = findTrack(trackId);
    if (track && !tagSliceCache.has(String(trackId)) && !fastStartCache.has(String(trackId))) {
      prewarmTrackPreamble(String(trackId), null, track.title).catch(() => {});
    }

    return streamAudioTrack(trackId, req, res);
  }

  res.setHeader('Allow', 'OPTIONS, GET, HEAD, PROPFIND');
  return res.status(405).send('Method Not Allowed');
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

// Fast-Start & Media LRU cache inspection endpoint
app.get('/debug/faststart', (req, res) => {
  const cachedKeys = fastStartCache.keys();
  const cachedTracks = cachedKeys.map((id) => {
    const t = findTrack(id);
    const buf = fastStartCache.get(id);
    return {
      id,
      title: t?.title || 'Unknown',
      artist: t?.artist || 'Unknown',
      cachedBytes: buf ? buf.length : 0,
    };
  });
  res.json({
    fastStartCacheSize: fastStartCache.size,
    fastStartCapacity: 10,
    mediaCacheSize: mediaCache.size,
    mediaCacheCapacity: mediaCache.maxSize,
    totalTracksInLibrary: trackIndex.length,
    cachedTracks,
  });
});

// Clear Fast-Start RAM cache endpoint
app.get('/debug/faststart/clear', (req, res) => {
  fastStartCache.clear();
  res.json({
    status: 'ok',
    message: 'fastStartCache cleared successfully',
    fastStartCacheSize: fastStartCache.size,
  });
});

// Status / Health endpoint
app.get('/', (req, res) => {
  if (!isTelegramReady && !setupApi.isConfigured()) {
    return res.redirect('/setup');
  }
  res.json({
    status: isTelegramReady ? 'online' : 'setup_mode',
    version: pkg.version,
    app: 'BitChord Telegram Music Addon',
    tracksCount: trackIndex.length,
    manifest: `${getBaseUrl(req)}/manifest.json`,
  });
});

// ── Server & Telegram Initialization ──────────────────────────────────────

async function resolveChannel(channelInput = CHANNEL) {
  if (!channelInput) return null;
  const cleanInput = String(channelInput).trim();
  let target = cleanInput;
  const tmeMatch = cleanInput.match(/t\.me\/(?:c\/)?([a-zA-Z0-9_+-]+)/i);
  if (tmeMatch) {
    target = tmeMatch[1];
  }
  const stripped = target.replace(/^-100/, '').replace(/^@/, '').toLowerCase();

  try {
    // Automatically iterate through user dialogs until the target channel is matched
    for await (const d of client.iterDialogs({ limit: 1000 })) {
      const entity = d.entity;
      if (!entity) continue;
      const entityId = entity.id ? entity.id.toString() : '';
      const username = (entity.username || '').toLowerCase();
      const title = (entity.title || '').toLowerCase();

      if (
        entityId === cleanInput ||
        `-100${entityId}` === cleanInput ||
        entityId === target ||
        entityId === stripped ||
        `-100${entityId}` === target ||
        (username && (username === stripped || username === target.toLowerCase())) ||
        title === cleanInput.toLowerCase() ||
        title === target.toLowerCase()
      ) {
        return entity;
      }
    }
  } catch (_) {}

  // Fallback to direct resolution for public @usernames (do not query numeric IDs to avoid MTProto RPC errors)
  const isNumeric = /^-?\d+$/.test(target) || /^-?100\d+$/.test(target);
  if (!isNumeric) {
    try {
      return await client.getEntity(cleanInput);
    } catch (_) {
      if (cleanInput.startsWith('@')) {
        try {
          return await client.getEntity(cleanInput.slice(1));
        } catch (_) {}
      }
    }
  }
  return null;
}

const SYSTEM_PREFIXES = ['Searching for', '🎧', '🔍', '⏳', '🚀', '✅', '❌', 'ℹ️', '🧹', '⚠️', 'Duplicate detected', '**Duplicate detected', '<b>Duplicate detected'];

async function cleanupOrphanedDuplicateNotices() {
  if (!channelEntity) return;
  try {
    const recent = await client.getMessages(channelEntity, { limit: 100 });
    const toDelete = new Set();
    for (const msg of recent) {
      const text = msg.message || msg.text || '';
      if (text.includes('Duplicate detected:') || (text.includes('Deleting in') && text.includes('Send /keep to save'))) {
        toDelete.add(msg.id);
        const repliedMsgId = msg.replyTo?.replyToMsgId || msg.replyToMsgId;
        if (repliedMsgId) {
          toDelete.add(repliedMsgId);
        }
      }
    }
    if (toDelete.size > 0) {
      const deleteIds = Array.from(toDelete);
      logCli('CLEANUP', `Processing ${BOLD}${deleteIds.length}${RESET} duplicate notice/file(s) on server restart`);
      for (const id of deleteIds) {
        deleteMessageViaBot(id).catch(() => {});
      }
      await deleteTelegramMessages(deleteIds);
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

async function startTelegramService() {
  if (isTelegramReady) return;
  try {
    loadCache();
    loadNotificationState();

    const env = setupApi.readEnvMap();
    const apiId = API_ID || parseInt(env.TELEGRAM_API_ID, 10);
    const apiHash = API_HASH || env.TELEGRAM_API_HASH;
    const sessionString = SESSION_STRING || env.TELEGRAM_SESSION_STRING;

    if (!client && apiId && apiHash) {
      client = new TelegramClient(new StringSession(sessionString || ''), apiId, apiHash, {
        connectionRetries: 10,
        autoReconnect: true,
        useWSS: process.env.USE_WSS !== 'false',
        baseLogger: new Logger('none'),
      });
      client.setLogLevel('none');
    }

    if (!client) {
      console.warn('[Telegram Service] Cannot start: missing API ID or Hash.');
      return;
    }

    await client.connect();
    const currentChannel = cleanEnv(process.env.TELEGRAM_CHANNEL) || env.TELEGRAM_CHANNEL || CHANNEL;
    channelEntity = await resolveChannel(currentChannel);
    if (!channelEntity) {
      logCli('CHANNEL', `Could not access or find channel: ${BOLD}"${currentChannel}"${RESET}. Check permissions or channel ID.`);
      return;
    }
    const chanTitle = channelEntity.title || channelEntity.username || currentChannel;
    const chanId = channelEntity.id ? ` ${DIM}(ID: ${channelEntity.id})${RESET}` : '';
    logCli('CHANNEL', `Connected to ${BOLD}${chanTitle}${RESET}${chanId}`);

    if (teledrive) {
      await teledrive.initTeleDrive(client, channelEntity, resolveChannel);
    }

    await cleanupOrphanedDuplicateNotices();

    // Set up real-time listener for audio uploads, /keep flag, and auto-purge cleaner
    client.addEventHandler(async (event) => {
      try {
        const message = event.message;
        if (!message) return;

        const isMusicChannel = channelEntity && message.peerId && (utils.getPeerId(message.peerId).toString() === utils.getPeerId(channelEntity).toString());
        const trimmedText = (message.text || message.message || '').trim();

        // Handle /keep command
        if (/^[#/](?:keep|ig)(?:\s+.*)?$/i.test(trimmedText)) {
          if (isMusicChannel) {
            let targetKey = null;
            const repliedId = message.replyTo?.replyToMsgId || message.replyToMsgId ? String(message.replyTo?.replyToMsgId || message.replyToMsgId) : null;

            if (repliedId) {
              if (pendingDeletions.has(repliedId)) {
                targetKey = repliedId;
              } else {
                for (const [trackId, info] of pendingDeletions.entries()) {
                  if (info.noticeMsgId && String(info.noticeMsgId) === repliedId) {
                    targetKey = trackId;
                    break;
                  }
                }
              }
            }

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
                const confirmMsg = await sendChannelMessage(
                  `✅ <b>Preserved:</b> "${cancelled.track.title}" will be kept in your library.`,
                  { parseMode: 'html' }
                ).catch(() => null);
                if (confirmMsg) {
                  setTimeout(() => {
                    deleteMessageViaBot(confirmMsg.id).catch(() => {});
                    client.deleteMessages(channelEntity, [confirmMsg.id, message.id], { revoke: true }).catch(() => {
                      deleteMessageViaBot(message.id).catch(() => {});
                    });
                  }, 12000);
                }
              }
            } else {
              setTimeout(() => {
                client.deleteMessages(channelEntity, [message.id], { revoke: true }).catch(() => {
                  deleteMessageViaBot(message.id).catch(() => {});
                });
              }, 4000);
            }
            return;
          }
        }

        // Handle incoming audio uploads
        const doc = message.media?.document;
        if (doc && isAudioDocument(doc)) {
          if (teledrive) {
            const handled = await teledrive.handleTeleDriveUpload(message, client, channelEntity, {
              isAudioDocument,
              parseTrackMessage,
              processTrackUpload,
            });
            if (handled) return;
          }

          if (!isMusicChannel) return;

          const track = await parseTrackMessage(message);
          if (track) {
            await processTrackUpload(track);
          }
          return;
        }

        // Remove non-music chatter in channel
        if (isMusicChannel && !message.out && !message.post) {
          const isCommand = trimmedText.startsWith('/');
          const hasButtons = Boolean(message.replyMarkup);
          const isBotSender = await isFromBot(message);
          const isSystemText = SYSTEM_PREFIXES.some(p => trimmedText.startsWith(p));

          if (!isCommand && !hasButtons && !isBotSender && !isSystemText) {
            console.log(`[Channel Cleaner] Auto-purging user non-music message (msg ID: ${message.id}): "${trimmedText.slice(0, 30)}"`);
            client.deleteMessages(channelEntity, [message.id], { revoke: true }).catch(() => {
              deleteMessageViaBot(message.id).catch(() => {});
            });
          }
        }
      } catch (err) {
        console.warn('Real-time event error:', err.message);
      }
    }, new NewMessage({}));

    // Start 30-minute digest and 12-hour auto-deletion interval checker (checks every 5 minutes)
    setInterval(checkDigestSchedule, 5 * 60 * 1000);

    // Periodic TeleDrive catch-up scan of last 100 messages (every 10 minutes)
    setInterval(async () => {
      if (teledrive && isTelegramReady && client && channelEntity) {
        await teledrive.syncTeleDriveExistingTracks(client, channelEntity, {
          isAudioDocument,
          parseTrackMessage,
          isDuplicate,
          trackIndex,
          processTrackUpload,
        }).catch(() => {});
      }
    }, 10 * 60 * 1000);



    isTelegramReady = true;

    try {
      await buildTrackIndex();
      if (teledrive) {
        await teledrive.syncTeleDriveExistingTracks(client, channelEntity, {
          isAudioDocument,
          parseTrackMessage,
          isDuplicate,
          trackIndex,
          processTrackUpload,
        });
      }
      checkDigestSchedule();
      isStartupComplete = true;
      console.log('');
      hasInsertedStartupGap = true;
    } catch (err) {
      console.error('Initial indexing error:', err.message);
    }
  } catch (err) {
    console.error('[Telegram Init Error]:', err.message);
  }
}

function tryOpenBrowser(url) {
  try {
    const { exec } = require('child_process');
    const cmd =
      process.platform === 'win32'
        ? `start "" "${url}"`
        : process.platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`;
    const child = exec(cmd, () => {});
    if (child && typeof child.unref === 'function') {
      child.unref();
    }
  } catch (_) {}
}

function printUrlBanner(label, urlStr) {
  console.log('');
  console.log(`  ${label}:`);
  console.log(`  ${urlStr}`);
}

(async () => {
  try {
    app.listen(PORT, '0.0.0.0', async () => {
      const secretAtStart = getUrlSecret();
      const secretPath = secretAtStart ? `/${secretAtStart}` : '';
      const localManifest = `http://localhost:${PORT}${secretPath}/manifest.json`;

      console.log('');
      console.log(`  Telegram Music Addon server running on: http://0.0.0.0:${PORT}`);
      console.log(`  Setup Wizard: http://localhost:${PORT}/setup`);
      console.log(`  Local Manifest URL: ${localManifest}`);
      if (secretAtStart) {
        console.log(`  [Security] URL_SECRET protection active: unauthorized public requests will be blocked.`);
      }
      console.log('');

      const enableTunnel = process.env.ENABLE_CLOUDFLARE_TUNNEL !== 'false';
      if (enableTunnel) {
        tunnel.startTunnel(PORT).then(url => {
          const secret = getUrlSecret();
          const sPath = secret ? `/${secret}` : '';
          console.log(`[Cloudflare HTTPS Tunnel]: ${url}`);
          printUrlBanner('BitChord Addon URL (HTTPS for phone)', `${url}${sPath}/manifest.json`);
        }).catch(err => {
          console.warn('[Cloudflare Tunnel Warning]:', err.message);
        });
      }

      const configured = setupApi.isConfigured();
      const shouldOpenBrowser = !configured || process.env.OPEN_BROWSER === 'true' || process.argv.includes('--open');
      if (shouldOpenBrowser) {
        setTimeout(() => {
          tryOpenBrowser(`http://localhost:${PORT}/setup`);
        }, 1000);
      }

      if (configured) {
        await startTelegramService();
      } else {
        console.log('=================================================================');
        console.log('         Telegram Music Setup Required                           ');
        console.log('=================================================================');
        console.log(`\nOpening http://localhost:${PORT}/setup in your browser to complete onboarding.\n`);
      }

      setupApi.setOnConfigSaved(async (updates) => {
        console.log('[Setup] New configuration received. Initializing Telegram service...');
        for (const [k, v] of Object.entries(updates)) {
          if (v !== undefined && v !== null) {
            process.env[k] = v;
          }
        }
        if (updates.URL_SECRET !== undefined) {
          process.env.URL_SECRET = updates.URL_SECRET;
        }
        if (!client || !client.connected) {
          const parsedApiId = parseInt(updates.TELEGRAM_API_ID, 10);
          client = new TelegramClient(new StringSession(updates.TELEGRAM_SESSION_STRING), parsedApiId, updates.TELEGRAM_API_HASH, {
            connectionRetries: 10,
            autoReconnect: true,
            useWSS: process.env.USE_WSS !== 'false',
            baseLogger: new Logger('none'),
          });
          client.setLogLevel('none');
        }
        if (updates.ENABLE_CLOUDFLARE_TUNNEL !== 'false') {
          tunnel.startTunnel(parseInt(updates.PORT || PORT, 10)).then(url => {
            const secret = getUrlSecret();
            const secretPath = secret ? `/${secret}` : '';
            console.log(`[Cloudflare HTTPS Tunnel]: ${url}`);
            printUrlBanner('BitChord Addon URL (HTTPS for phone)', `${url}${secretPath}/manifest.json`);
          }).catch(err => {
            console.warn('[Cloudflare Tunnel Warning]:', err.message);
          });
        }
        await startTelegramService();
      });

      setupApi.setOnRestart(async () => {
        console.log('\n[Restart] Refreshing Telegram Music Addon services and cache...');
        require('dotenv').config({ override: true });
        mediaCache.clear();
        fastStartCache.clear();
        isTelegramReady = false;
        isStartupComplete = false;
        hasInsertedStartupGap = false;

        if (process.env.ENABLE_CLOUDFLARE_TUNNEL !== 'false') {
          console.log('[Restart] Refreshing Cloudflare HTTPS tunnel...');
          tunnel.stopTunnel();
          try {
            const url = await tunnel.startTunnel(parseInt(process.env.PORT || PORT, 10));
            const secret = getUrlSecret();
            const secretPath = secret ? `/${secret}` : '';
            console.log(`[Cloudflare HTTPS Tunnel]: ${url}`);
            printUrlBanner('BitChord Addon URL (HTTPS for phone)', `${url}${secretPath}/manifest.json`);
          } catch (tErr) {
            console.warn('[Cloudflare Tunnel Warning]:', tErr.message);
          }
        }

        await startTelegramService();
        console.log(`[Restart] Service restart complete. ${trackIndex.length} track(s) ready.\n`);
        return { tracksCount: trackIndex.length, tunnelUrl: tunnel.getTunnelUrl() };
      });
    });
  } catch (err) {
    console.error('Fatal startup error:', err);
    process.exit(1);
  }
})();
