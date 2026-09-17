const { utils } = require('telegram');

// Anti-remix / junk penalties
const REMIX_KEYWORDS = [
  'remix', 'mix', 'dj', 'club', 'house', 'afro', 'lofi', 'flip',
  'slowed', 'reverb', 'sped up', 'instrumental', 'karaoke', 'cover', 'tribute'
];

/**
 * Searches Apple Music via the official, free iTunes Search API.
 * Uses country=IN by default for Indian releases, with fallback to US.
 */
async function searchAppleMusic(query, country = 'IN', limit = 20) {
  try {
    const cleanQuery = query.trim();
    let url = `https://itunes.apple.com/search?term=${encodeURIComponent(cleanQuery)}&country=${country}&entity=song&limit=${limit}`;
    let res = await fetch(url);
    let data = await res.json();

    if ((!data.results || data.results.length === 0) && country !== 'US') {
      url = `https://itunes.apple.com/search?term=${encodeURIComponent(cleanQuery)}&country=US&entity=song&limit=${limit}`;
      res = await fetch(url);
      data = await res.json();
    }

    return (data.results || []).map((r, idx) => {
      const durationSec = Math.round((r.trackTimeMillis || 0) / 1000);
      const mins = Math.floor(durationSec / 60);
      const secs = (durationSec % 60).toString().padStart(2, '0');
      return {
        optionNum: idx + 1,
        id: r.trackId,
        title: r.trackName,
        artist: r.artistName,
        album: r.collectionName,
        durationSec,
        durationStr: `${mins}:${secs}`,
        url: r.trackViewUrl,
        artwork: r.artworkUrl100 ? r.artworkUrl100.replace('100x100bb', '600x600bb') : null,
      };
    });
  } catch (err) {
    console.error('[AppleSearch] Error querying iTunes API:', err.message);
    return [];
  }
}

/**
 * Scores an Apple Music candidate to prioritize the authentic original movie/album version.
 */
function scoreAppleMusicCandidate(candidate, originalQuery) {
  let score = 100;
  const qLower = originalQuery.toLowerCase();
  const titleLower = (candidate.title || '').toLowerCase();
  const albumLower = (candidate.album || '').toLowerCase();

  // If the user did not specifically ask for remix/dj, penalize remix markers
  const userWantsRemix = REMIX_KEYWORDS.some(k => qLower.includes(k));
  if (!userWantsRemix) {
    for (const kw of REMIX_KEYWORDS) {
      if (titleLower.includes(kw) || albumLower.includes(kw)) {
        score -= 80;
        break;
      }
    }
  }

  // Boost original soundtrack or movie markers
  if (titleLower.includes('from "') || titleLower.includes('soundtrack') || albumLower.includes('original')) {
    score += 40;
  }

  // Bollywood/pop original songs are usually full length (>= 3:30)
  if (candidate.durationSec >= 210) {
    score += 20;
  } else if (candidate.durationSec < 150) {
    // Short edits / tik tok cuts
    score -= 30;
  }

  return score;
}

/**
 * Downloads ALAC Lossless (.m4a) from Apple Music via @applemusicdw_bot.
 */
async function downloadFromAppleMusic(client, appleMusicUrl, onProgress) {
  const botEntity = await client.getEntity('applemusicdw_bot');
  if (onProgress) onProgress('Sending Apple Music link to @applemusicdw_bot...');

  const sendMsg = await client.sendMessage(botEntity, { message: appleMusicUrl });
  const startId = sendMsg.id;

  const startTime = Date.now();
  const timeoutMs = 45000;

  while (Date.now() - startTime < timeoutMs) {
    await new Promise(r => setTimeout(r, 2000));
    const recentMsgs = await client.getMessages(botEntity, { limit: 5 });
    for (const m of recentMsgs) {
      if (m.id > startId && m.media?.document) {
        return m;
      }
    }
  }
  throw new Error('@applemusicdw_bot timed out waiting for audio file');
}

/**
 * Parses search result lines from bot text (e.g. "1. Artist - Title (03:45)" or "**1.** Artist - Title [3:45]")
 */
function parseBotSearchResults(text) {
  if (!text) return [];
  const lines = text.split('\n');
  const results = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const m = trimmed.match(/^(?:\*{0,2})([1-9]\d?)[.)\]]\s*(?:\*{0,2})\s*(.+)$/);
    if (m) {
      const optionNum = parseInt(m[1], 10);
      let rest = m[2].trim();

      let durationStr = '';
      const durMatch = rest.match(/[\(\[]\s*(\d{1,2}:\d{2})\s*[\)\]]$/);
      if (durMatch) {
        durationStr = durMatch[1];
        rest = rest.slice(0, durMatch.index).trim();
      }

      let artist = '';
      let title = rest;
      if (rest.includes(' - ')) {
        const parts = rest.split(' - ');
        artist = parts[0].trim();
        title = parts.slice(1).join(' - ').trim();
      } else if (rest.includes(' – ')) {
        const parts = rest.split(' – ');
        artist = parts[0].trim();
        title = parts.slice(1).join(' – ').trim();
      }

      results.push({
        optionNum,
        rawText: rest,
        artist,
        title,
        durationStr,
      });
    }
  }

  return results.slice(0, 10);
}

/**
 * Checks if the bot search results are genuinely relevant to the user query.
 * For multi-word queries (e.g. "brown rang"), at least the top candidate must contain the key words.
 */
function areCandidatesRelevant(candidates, query) {
  if (!candidates || candidates.length === 0) return false;
  const qTokens = query.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 1);
  if (qTokens.length <= 1) return true;

  const top = candidates[0];
  const combined = `${top.title} ${top.artist} ${top.rawText || ''}`.toLowerCase();
  const matchedTokens = qTokens.filter((t) => combined.includes(t));
  return (matchedTokens.length / qTokens.length) >= 0.6;
}

/**
 * Formats the selection menu for Telegram channel display with native clickable /number links and pagination.
 */
function formatPickerMenu(query, candidates, engine = 'musicshunters', page = 1) {
  const pageSize = 5;
  const totalPages = Math.ceil(candidates.length / pageSize) || 1;
  const currentPage = Math.min(Math.max(page, 1), totalPages);
  const startIdx = (currentPage - 1) * pageSize;
  const pageCandidates = candidates.slice(startIdx, startIdx + pageSize);

  const list = pageCandidates.map((c, i) => {
    const num = startIdx + i + 1;
    const dur = c.durationStr ? ` \`(${c.durationStr})\`` : '';
    const artist = c.artist ? `**${c.artist}** – ` : '';
    return `/${num} ${artist}${c.title}${dur}`;
  }).join('\n');

  const engineLabel = engine === 'applemusic' ? 'Apple Music ALAC' : 'Deezer / Qobuz FLAC';
  const pageLabel = totalPages > 1 ? ` • Page ${currentPage}/${totalPages}` : '';

  let footer = `👉 **Tap any /number to download**`;
  if (totalPages > 1) {
    if (currentPage === 1) {
      footer += `\n/next — Show next 5 results (6-10)`;
    } else {
      footer += `\n/prev — Show previous 5 results (1-5)`;
    }
  }
  footer += `\n/switch — Switch search catalog\n/cancel — Dismiss search`;

  return `🎧 **Search Results for:** _"${query}"_ \`[${engineLabel}${pageLabel}]\`\n\n${list}\n\n━━━━━━━━━━━━━━━━━━━━\n${footer}`;
}

/**
 * Builds the Telegram inline keyboard markup for bot interactive buttons with pagination and catalog switching.
 */
function buildInlineKeyboard(candidates, engine = 'musicshunters', page = 1) {
  const pageSize = 5;
  const totalPages = Math.ceil(candidates.length / pageSize) || 1;
  const currentPage = Math.min(Math.max(page, 1), totalPages);
  const startIdx = (currentPage - 1) * pageSize;
  const pageCandidates = candidates.slice(startIdx, startIdx + pageSize);

  const numberEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

  const numRow = pageCandidates.map((_, i) => {
    const num = startIdx + i + 1;
    return {
      text: numberEmojis[num - 1] || `${num}`,
      callback_data: String(num),
    };
  });

  const keyboard = [numRow];

  const navRow = [];
  if (currentPage > 1) {
    navRow.push({ text: '⬅️ Prev (1-5)', callback_data: 'page_1' });
  }
  if (currentPage < totalPages) {
    navRow.push({ text: '➡️ Next (6-10)', callback_data: 'page_2' });
  }
  if (navRow.length > 0) {
    keyboard.push(navRow);
  }

  const switchLabel = engine === 'applemusic' ? '🔄 Try Deezer FLAC' : '🔄 Try Apple Music ALAC';
  keyboard.push([
    { text: switchLabel, callback_data: 'switch_engine' },
    { text: '❌ Cancel', callback_data: 'cancel' },
  ]);

  return keyboard;
}

/**
 * Edits a picker message seamlessly using Telegram Bot API (if bot token configured)
 * or MTProto user client fallback.
 */
async function editMenuMessage(client, channelEntity, menuMsgId, text, replyMarkup = null) {
  const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (BOT_TOKEN) {
    try {
      const rawPeerId = utils.getPeerId(channelEntity).toString();
      const tgChatId = rawPeerId.startsWith('-100') ? rawPeerId : `-100${rawPeerId}`;
      const payload = {
        chat_id: tgChatId,
        message_id: menuMsgId,
        text,
        parse_mode: 'Markdown',
      };
      if (replyMarkup) {
        payload.reply_markup = replyMarkup;
      }
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.ok) return true;
    } catch (_) {}
  }

  try {
    await client.editMessage(channelEntity, { message: menuMsgId, text });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Sends a search query to @MusicsHuntersbot and awaits the search result message with option buttons.
 */
async function searchMusicsHunters(client, query, onProgress) {
  const botEntity = await client.getEntity('MusicsHuntersbot');
  if (onProgress) onProgress(`Searching "${query}" on @MusicsHuntersbot...`);
  const sendMsg = await client.sendMessage(botEntity, { message: query.trim() });
  const startId = sendMsg.id;

  let searchMsg = null;
  const searchStartTime = Date.now();
  while (Date.now() - searchStartTime < 15000) {
    await new Promise(r => setTimeout(r, 1500));
    const recentMsgs = await client.getMessages(botEntity, { limit: 5 });
    searchMsg = recentMsgs.find(m => m.id > startId && m.replyMarkup?.rows);
    if (searchMsg) break;
  }

  if (!searchMsg) return null;

  let candidates = parseBotSearchResults(searchMsg.message);
  if (candidates.length === 0) {
    // Fallback if message format is non-standard but buttons exist
    const rowButtons = (searchMsg.replyMarkup?.rows || []).flatMap(r => r.buttons || []);
    const count = Math.min(rowButtons.length || 10, 10);
    for (let i = 1; i <= count; i++) {
      candidates.push({
        optionNum: i,
        rawText: `Option ${i}`,
        artist: '',
        title: `${query} (Track #${i})`,
        durationStr: '',
      });
    }
  }

  return { searchMsg, candidates: candidates.slice(0, 10) };
}

/**
 * Clicks the selected option button on @MusicsHuntersbot and waits for the audio file.
 */
async function downloadMusicsHuntersDocument(client, searchMsg, optionNum, onProgress) {
  const optText = String(optionNum);
  if (onProgress) onProgress(`Requesting option ${optText} from @MusicsHuntersbot in FLAC...`);
  try {
    await searchMsg.click({ text: optText });
  } catch (_) {
    await searchMsg.click(Math.max(0, optionNum - 1));
  }

  const dlStartTime = Date.now();
  while (Date.now() - dlStartTime < 45000) {
    await new Promise(r => setTimeout(r, 2000));
    const recentMsgs = await client.getMessages(searchMsg.peerId, { limit: 5 });
    for (const m of recentMsgs) {
      if (m.id > searchMsg.id && m.media?.document) {
        return m;
      }
    }
  }
  throw new Error('@MusicsHuntersbot timed out waiting for audio file');
}

/**
 * Downloads FLAC from @MusicsHuntersbot (Deezer, Spotify, Qobuz, Tidal).
 */
async function downloadFromMusicsHunters(client, queryOrUrl, optionNum = 1, onProgress) {
  const botEntity = await client.getEntity('MusicsHuntersbot');
  const isDirectUrl = /^https?:\/\//i.test(queryOrUrl.trim());

  if (isDirectUrl) {
    if (onProgress) onProgress('Sending streaming link to @MusicsHuntersbot...');
    const sendMsg = await client.sendMessage(botEntity, { message: queryOrUrl.trim() });
    const startId = sendMsg.id;

    const startTime = Date.now();
    while (Date.now() - startTime < 45000) {
      await new Promise(r => setTimeout(r, 2000));
      const recentMsgs = await client.getMessages(botEntity, { limit: 5 });
      for (const m of recentMsgs) {
        if (m.id > startId && m.media?.document) {
          return m;
        }
      }
    }
    throw new Error('@MusicsHuntersbot timed out waiting for audio from link');
  }

  // Keyword search
  const searchResult = await searchMusicsHunters(client, queryOrUrl, onProgress);
  if (!searchResult || !searchResult.searchMsg) {
    throw new Error('@MusicsHuntersbot did not return search result buttons');
  }

  return await downloadMusicsHuntersDocument(client, searchResult.searchMsg, optionNum, onProgress);
}

// Active search picker sessions map: channelId -> session
const activePickers = new Map();

function hasActivePicker(channelEntity) {
  if (!channelEntity) return false;
  const channelId = utils.getPeerId(channelEntity).toString();
  return activePickers.has(channelId);
}

async function cancelPicker(client, channelEntity) {
  if (!channelEntity) return false;
  const channelId = utils.getPeerId(channelEntity).toString();
  const session = activePickers.get(channelId);
  if (!session) return false;

  clearTimeout(session.timer);
  activePickers.delete(channelId);

  const msgsToDelete = [session.menuMsgId];
  if (session.originalMsgId) msgsToDelete.push(session.originalMsgId);
  client.deleteMessages(channelEntity, msgsToDelete.filter(Boolean), { revoke: true }).catch(() => {});
  return true;
}

async function switchPickerPage(client, channelEntity, newPage) {
  if (!channelEntity) return false;
  const channelId = utils.getPeerId(channelEntity).toString();
  const session = activePickers.get(channelId);
  if (!session) return false;

  const pageSize = 5;
  const totalPages = Math.ceil((session.candidates || []).length / pageSize) || 1;
  const page = Math.min(Math.max(newPage, 1), totalPages);
  session.page = page;

  const menuText = formatPickerMenu(session.query, session.candidates, session.engine, page);
  const keyboard = buildInlineKeyboard(session.candidates, session.engine, page);

  await editMenuMessage(client, channelEntity, session.menuMsgId, menuText, { inline_keyboard: keyboard });
  return true;
}

async function switchPickerEngine(client, channelEntity) {
  if (!channelEntity) return false;
  const channelId = utils.getPeerId(channelEntity).toString();
  const session = activePickers.get(channelId);
  if (!session) return false;

  const newEngine = session.engine === 'applemusic' ? 'musicshunters' : 'applemusic';
  const newEngineLabel = newEngine === 'applemusic' ? 'Apple Music ALAC' : 'Deezer / Qobuz FLAC';

  await editMenuMessage(client, channelEntity, session.menuMsgId, `🔍 **Searching ${newEngineLabel} for "${session.query}"...**`);

  let candidates = [];
  let searchMsg = null;

  try {
    if (newEngine === 'applemusic') {
      const appleResults = await searchAppleMusic(session.query, 'IN', 20);
      if (appleResults.length > 0) {
        const scored = appleResults
          .map(c => ({ ...c, score: scoreAppleMusicCandidate(c, session.query) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, 10)
          .map((c, idx) => ({
            optionNum: idx + 1,
            artist: c.artist,
            title: c.title,
            durationStr: c.durationStr,
            url: c.url,
          }));
        candidates = scored;
      }
    } else {
      const result = await searchMusicsHunters(client, session.query);
      if (result && result.candidates.length > 0) {
        candidates = result.candidates.slice(0, 10);
        searchMsg = result.searchMsg;
      }
    }
  } catch (err) {
    console.warn(`[Downloader] Switch to ${newEngine} failed:`, err.message);
  }

  if (candidates.length === 0) {
    await editMenuMessage(client, channelEntity, session.menuMsgId, `⚠️ No tracks found on ${newEngineLabel} for "${session.query}".`);
    setTimeout(async () => {
      const menuText = formatPickerMenu(session.query, session.candidates, session.engine, session.page || 1);
      const keyboard = buildInlineKeyboard(session.candidates, session.engine, session.page || 1);
      await editMenuMessage(client, channelEntity, session.menuMsgId, menuText, { inline_keyboard: keyboard });
    }, 2500);
    return false;
  }

  session.engine = newEngine;
  session.candidates = candidates;
  session.searchMsg = searchMsg;
  session.page = 1;

  const menuText = formatPickerMenu(session.query, candidates, newEngine, 1);
  const keyboard = buildInlineKeyboard(candidates, newEngine, 1);
  await editMenuMessage(client, channelEntity, session.menuMsgId, menuText, { inline_keyboard: keyboard });
  return true;
}

async function handlePickerChoice(client, channelEntity, optionNum, onTrackForwarded = null) {
  if (!channelEntity) return false;
  const channelId = utils.getPeerId(channelEntity).toString();
  const session = activePickers.get(channelId);
  if (!session) return false;

  clearTimeout(session.timer);
  activePickers.delete(channelId);

  const candidate = session.candidates[optionNum - 1] || session.candidates[0];
  const candTitle = candidate?.title ? `"${candidate.title}"` : `Option ${optionNum}`;

  const updateStatus = async (msg) => {
    await editMenuMessage(client, channelEntity, session.menuMsgId, msg);
  };

  try {
    await updateStatus(`⏳ **Downloading ${candTitle} in Lossless...**`);

    let audioDocMsg = null;
    if (session.engine === 'musicshunters' && session.searchMsg) {
      audioDocMsg = await downloadMusicsHuntersDocument(client, session.searchMsg, optionNum, updateStatus);
    } else if (candidate?.url) {
      audioDocMsg = await downloadFromAppleMusic(client, candidate.url, updateStatus);
    } else {
      throw new Error(`Invalid candidate selection for option ${optionNum}`);
    }

    if (!audioDocMsg || !audioDocMsg.media?.document) {
      throw new Error('Failed to retrieve audio file from bot');
    }

    await updateStatus(`🚀 Uploading track to Music Library...`);
    const botPeer = audioDocMsg.peerId;
    const forwarded = await client.forwardMessages(channelEntity, {
      messages: [audioDocMsg.id],
      fromPeer: botPeer,
    });

    if (onTrackForwarded && forwarded && forwarded[0]) {
      try {
        await onTrackForwarded(forwarded[0]);
      } catch (idxErr) {
        console.warn('[Downloader] Post-forward indexing error:', idxErr.message);
      }
    }

    await updateStatus(`✅ **Added ${candTitle} to Music Library!**`);

    setTimeout(async () => {
      try {
        const msgsToDelete = [session.menuMsgId];
        if (session.originalMsgId) msgsToDelete.push(session.originalMsgId);
        await client.deleteMessages(channelEntity, msgsToDelete.filter(Boolean), { revoke: true });
      } catch (_) {}
    }, 6000);

    return true;
  } catch (err) {
    console.error('[Downloader] Picker choice failed:', err.message);
    await updateStatus(`❌ **Download Failed:** ${err.message}`);
    setTimeout(async () => {
      try {
        const msgsToDelete = [session.menuMsgId];
        if (session.originalMsgId) msgsToDelete.push(session.originalMsgId);
        await client.deleteMessages(channelEntity, msgsToDelete.filter(Boolean), { revoke: true });
      } catch (_) {}
    }, 10000);
    return false;
  }
}

/**
 * Handles `/song ...` channel command.
 * Supports direct URLs, explicit option numbers (`/song <query> <num>`),
 * and interactive 5-option selection menus (`/song <query>`).
 */
async function handleSongCommand(client, channelEntity, commandText, originalMsgId = null, onTrackForwarded = null) {
  const text = commandText.trim();
  const match = text.match(/^\/song(?:\s+(.+))?$/i);
  if (!match || !match[1]) {
    const helpMsg = await client.sendMessage(channelEntity, {
      message: 'ℹ️ **Usage:**\n• `/song <song name>` (shows top 5 choices)\n• `/song <song name> <option#>` (e.g. `/song Kesariya 2`)\n• `/song <Apple Music / Spotify URL>`'
    });
    setTimeout(() => {
      client.deleteMessages(channelEntity, [helpMsg.id, originalMsgId].filter(Boolean), { revoke: true }).catch(() => {});
    }, 10000);
    return;
  }

  const queryArg = match[1].trim();
  const channelId = utils.getPeerId(channelEntity).toString();

  // Clear any existing active picker for this channel
  if (activePickers.has(channelId)) {
    const prev = activePickers.get(channelId);
    clearTimeout(prev.timer);
    client.deleteMessages(channelEntity, [prev.menuMsgId], { revoke: true }).catch(() => {});
    activePickers.delete(channelId);
  }

  let statusMsg = await client.sendMessage(channelEntity, {
    message: `🔍 **Searching:** \`${queryArg}\`...`
  });

  const updateStatus = async (msg) => {
    try {
      await client.editMessage(channelEntity, { message: statusMsg.id, text: msg });
    } catch (_) {}
  };

  try {
    let audioDocMsg = null;

    // CASE 1: Direct Apple Music URL
    if (/music\.apple\.com/i.test(queryArg)) {
      await updateStatus(`📥 **Downloading Studio ALAC Lossless** via @applemusicdw_bot...`);
      audioDocMsg = await downloadFromAppleMusic(client, queryArg, updateStatus);
    }
    // CASE 2: Direct Spotify / Deezer / Qobuz / Tidal URL
    else if (/^(https?:\/\/)?(open\.spotify\.com|deezer\.com|deezer\.page\.link|qobuz\.com|tidal\.com)/i.test(queryArg)) {
      await updateStatus(`📥 **Downloading FLAC** via @MusicsHuntersbot...`);
      audioDocMsg = await downloadFromMusicsHunters(client, queryArg, 1, updateStatus);
    }
    // CASE 3: Keyword search with explicit option number (e.g. "/song Kesariya 2")
    else if (/^(.+?)\s+([1-9]\d?)$/.test(queryArg)) {
      const numMatch = queryArg.match(/^(.+?)\s+([1-9]\d?)$/);
      const query = numMatch[1].trim();
      const requestedOption = parseInt(numMatch[2], 10);

      await updateStatus(`🔍 Downloading Option ${requestedOption} for **"${query}"** in Lossless FLAC...`);
      try {
        audioDocMsg = await downloadFromMusicsHunters(client, query, requestedOption, updateStatus);
      } catch (flacErr) {
        console.warn('[Downloader] @MusicsHuntersbot failed, trying Apple Music fallback:', flacErr.message);
        await updateStatus(`⚠️ Deezer busy, checking Apple Music...`);
        const candidates = await searchAppleMusic(query);
        if (candidates.length >= requestedOption) {
          const selected = candidates[requestedOption - 1];
          audioDocMsg = await downloadFromAppleMusic(client, selected.url, updateStatus);
        } else if (candidates.length > 0) {
          audioDocMsg = await downloadFromAppleMusic(client, candidates[0].url, updateStatus);
        } else {
          throw flacErr;
        }
      }
    }
    // CASE 4: Standard keyword search -> Render interactive 5-option picker menu
    else {
      let engine = 'musicshunters';
      let searchResult = null;
      let candidates = [];

      try {
        searchResult = await searchMusicsHunters(client, queryArg, updateStatus);
        if (searchResult && searchResult.candidates.length > 0) {
          if (areCandidatesRelevant(searchResult.candidates, queryArg)) {
            candidates = searchResult.candidates;
          } else {
            console.log(`[Downloader] @MusicsHuntersbot results failed relevance check for "${queryArg}", falling back to Apple Music...`);
          }
        }
      } catch (botErr) {
        console.warn('[Downloader] @MusicsHuntersbot search failed:', botErr.message);
      }

      // If bot returned no candidates, fall back to Apple Music search
      if (candidates.length === 0) {
        engine = 'applemusic';
        await updateStatus(`🔍 Searching Apple Music catalog for **"${queryArg}"**...`);
        const appleResults = await searchAppleMusic(queryArg, 'IN', 20);
        if (appleResults.length > 0) {
          const scored = appleResults
            .map(c => ({ ...c, score: scoreAppleMusicCandidate(c, queryArg) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, 10)
            .map((c, idx) => ({
              optionNum: idx + 1,
              artist: c.artist,
              title: c.title,
              durationStr: c.durationStr,
              url: c.url,
            }));
          candidates = scored;
        }
      }

      if (candidates.length === 0) {
        throw new Error(`No tracks found for "${queryArg}" on Deezer or Apple Music`);
      }

      // Render interactive selection menu (Page 1)
      const menuText = formatPickerMenu(queryArg, candidates, engine, 1);
      const keyboard = buildInlineKeyboard(candidates, engine, 1);
      const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
      let menuMsgId = statusMsg.id;

      if (BOT_TOKEN) {
        try {
          const rawPeerId = utils.getPeerId(channelEntity).toString();
          const tgChatId = rawPeerId.startsWith('-100') ? rawPeerId : `-100${rawPeerId}`;
          const botRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: tgChatId,
              text: menuText,
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: keyboard,
              }
            })
          });
          const botJson = await botRes.json();
          if (botJson.ok && botJson.result) {
            client.deleteMessages(channelEntity, [statusMsg.id], { revoke: true }).catch(() => {});
            menuMsgId = botJson.result.message_id;
          } else {
            await client.editMessage(channelEntity, { message: statusMsg.id, text: menuText });
          }
        } catch (_) {
          await client.editMessage(channelEntity, { message: statusMsg.id, text: menuText });
        }
      } else {
        await client.editMessage(channelEntity, { message: statusMsg.id, text: menuText });
      }

      // Register active picker session with 60-second auto-purge timer
      const timer = setTimeout(async () => {
        try {
          const toDel = [menuMsgId];
          if (originalMsgId) toDel.push(originalMsgId);
          await client.deleteMessages(channelEntity, toDel, { revoke: true });
        } catch (_) {}
        activePickers.delete(channelId);
      }, 60000);

      activePickers.set(channelId, {
        query: queryArg,
        engine,
        searchMsg: searchResult?.searchMsg || null,
        candidates,
        page: 1,
        menuMsgId,
        originalMsgId,
        timer,
      });

      return; // Awaiting user's choice or navigation
    }

    if (!audioDocMsg || !audioDocMsg.media?.document) {
      throw new Error('Failed to retrieve audio file from bot');
    }

    // Forward direct download to channel
    await updateStatus(`🚀 Uploading track to Music Library...`);
    const botPeer = audioDocMsg.peerId;
    const forwarded = await client.forwardMessages(channelEntity, {
      messages: [audioDocMsg.id],
      fromPeer: botPeer,
    });

    if (onTrackForwarded && forwarded && forwarded[0]) {
      try {
        await onTrackForwarded(forwarded[0]);
      } catch (idxErr) {
        console.warn('[Downloader] Post-forward indexing error:', idxErr.message);
      }
    }

    await updateStatus(`✅ **Added to Music Library!**`);

    setTimeout(async () => {
      try {
        const msgsToDelete = [statusMsg.id];
        if (originalMsgId) msgsToDelete.push(originalMsgId);
        await client.deleteMessages(channelEntity, msgsToDelete, { revoke: true });
      } catch (_) {}
    }, 8000);

  } catch (err) {
    console.error('[Downloader] Song command failed:', err.message);
    await updateStatus(`❌ **Download Failed:** ${err.message}`);
    setTimeout(async () => {
      try {
        const msgsToDelete = [statusMsg.id];
        if (originalMsgId) msgsToDelete.push(originalMsgId);
        await client.deleteMessages(channelEntity, msgsToDelete, { revoke: true });
      } catch (_) {}
    }, 12000);
  }
}

module.exports = {
  searchAppleMusic,
  scoreAppleMusicCandidate,
  downloadFromAppleMusic,
  downloadFromMusicsHunters,
  handleSongCommand,
  parseBotSearchResults,
  formatPickerMenu,
  buildInlineKeyboard,
  searchMusicsHunters,
  downloadMusicsHuntersDocument,
  hasActivePicker,
  handlePickerChoice,
  cancelPicker,
  switchPickerPage,
  switchPickerEngine,
  areCandidatesRelevant,
};

