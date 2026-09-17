const { utils } = require('telegram');

// Anti-remix / junk penalties
const REMIX_KEYWORDS = [
  'remix', 'mix', 'dj', 'club', 'house', 'afro', 'lofi', 'flip',
  'slowed', 'reverb', 'sped up', 'instrumental', 'karaoke', 'cover', 'tribute'
];

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

  return results;
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

function escapeMarkdown(text) {
  if (!text) return '';
  return text.replace(/([_*`\[])/g, '\\$1');
}

/**
 * Formats the search menu text matching the reference screenshot:
 * 🎧 **Search Results for:** _"<query>"_ `[Deezer FLAC]`
 *
 * 1. Artist - Title `(mm:ss)`
 * 2. Artist - Title `(mm:ss)`
 * ...
 */
function formatPickerMenu(query, candidates, engine = 'deezer', page = 1) {
  const engineLabel = 'Deezer FLAC';
  const pageLabel = page > 1 ? ` • Page ${page}` : '';
  const cleanQuery = escapeMarkdown(query);
  const header = `🎧 **Search Results for:** _"${cleanQuery}"_ · [${engineLabel}${pageLabel}]`;

  const list = candidates.map((c) => {
    const dur = c.durationStr ? ` (${c.durationStr})` : '';
    const artist = c.artist ? `${escapeMarkdown(c.artist)} - ` : '';
    const title = escapeMarkdown(c.title);
    return `${c.optionNum}. ${artist}${title}${dur}`;
  }).join('\n');

  return `${header}\n\n${list}`;
}

/**
 * Builds the Telegram inline keyboard markup matching @MusicsHuntersbot:
 * Row 1: [ 1 ] [ 2 ] [ 3 ] [ 4 ] [ 5 ] [ 6 ] [ 7 ]
 * Row 2: [ ⬅️ ] [ ❌ ] [ ➡️ ]
 */
function buildMusicsHuntersKeyboard(candidates, searchMsg = null) {
  const numRow = candidates.map((c) => ({
    text: String(c.optionNum),
    callback_data: String(c.optionNum),
  }));

  const navRow = [];
  if (searchMsg?.replyMarkup?.rows?.[1]?.buttons) {
    for (const b of searchMsg.replyMarkup.rows[1].buttons) {
      if (b.text === '⬅️') {
        navRow.push({ text: '⬅️', callback_data: 'bot_prev' });
      } else if (b.text === '❌') {
        navRow.push({ text: '❌', callback_data: 'cancel' });
      } else if (b.text === '➡️') {
        navRow.push({ text: '➡️', callback_data: 'bot_next' });
      }
    }
  }

  if (navRow.length === 0) {
    navRow.push({ text: '❌', callback_data: 'cancel' });
    navRow.push({ text: '➡️', callback_data: 'bot_next' });
  }

  return [numRow, navRow];
}

/**
 * Edits a picker message seamlessly using Telegram Bot API (if bot token configured)
 * or MTProto user client fallback.
 */
async function editMenuMessage(client, channelEntity, menuMsgId, text, replyMarkup = null, parseMode = null) {
  const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (BOT_TOKEN) {
    try {
      const rawPeerId = utils.getPeerId(channelEntity).toString();
      const tgChatId = rawPeerId.startsWith('-100') ? rawPeerId : `-100${rawPeerId}`;
      const payload = {
        chat_id: tgChatId,
        message_id: menuMsgId,
        text,
      };
      if (parseMode) {
        payload.parse_mode = parseMode;
      }
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

function isPickerMenu(channelEntity, messageId) {
  if (!channelEntity || !messageId) return false;
  const channelId = utils.getPeerId(channelEntity).toString();
  const session = activePickers.get(channelId);
  return Boolean(session && session.menuMsgId === messageId);
}

async function deleteMessagesSafely(client, channelEntity, messageIds) {
  try {
    if (!channelEntity || !Array.isArray(messageIds) || messageIds.length === 0) return false;
    const ids = messageIds
      .map((id) => (typeof id === 'number' ? id : parseInt(id, 10)))
      .filter((id) => typeof id === 'number' && !isNaN(id) && id > 0);
    if (ids.length === 0) return false;
    await client.deleteMessages(channelEntity, ids, { revoke: true });
    return true;
  } catch (_) {
    for (const rawId of messageIds) {
      const singleId = typeof rawId === 'number' ? rawId : parseInt(rawId, 10);
      if (singleId && !isNaN(singleId) && singleId > 0) {
        await client.deleteMessages(channelEntity, [singleId], { revoke: true }).catch(() => {});
      }
    }
  }
  return false;
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
  deleteMessagesSafely(client, channelEntity, msgsToDelete).catch(() => {});
  return true;
}

async function navigateBotPicker(client, channelEntity, direction) {
  if (!channelEntity) return false;
  const channelId = utils.getPeerId(channelEntity).toString();
  const session = activePickers.get(channelId);
  if (!session || !session.searchMsg) return false;

  try {
    // Click the ➡️ or ⬅️ button on @MusicsHuntersbot
    await session.searchMsg.click({ text: direction });

    // Wait for @MusicsHuntersbot to update the message
    await new Promise((r) => setTimeout(r, 1000));

    // Fetch the updated searchMsg
    const updated = await client.getMessages(session.searchMsg.peerId, { ids: [session.searchMsg.id] });
    if (!updated || !updated[0]) return false;

    session.searchMsg = updated[0];
    const newCandidates = parseBotSearchResults(session.searchMsg.message);
    if (newCandidates.length > 0) {
      session.candidates = newCandidates;
    }

    // Extract page number from header e.g. from 'deezer':2
    const pageMatch = session.searchMsg.message.match(/:(\d+)\s*$/m);
    if (pageMatch) {
      session.page = parseInt(pageMatch[1], 10);
    } else {
      session.page = direction === '➡️' ? (session.page || 1) + 1 : Math.max(1, (session.page || 1) - 1);
    }

    const menuText = formatPickerMenu(session.query, session.candidates, 'deezer', session.page);
    const keyboard = buildMusicsHuntersKeyboard(session.candidates, session.searchMsg);

    await editMenuMessage(client, channelEntity, session.menuMsgId, menuText, { inline_keyboard: keyboard }, 'Markdown');
    return true;
  } catch (err) {
    console.warn('[Downloader] navigateBotPicker failed:', err.message);
    return false;
  }
}

async function handlePickerChoice(client, channelEntity, optionNum, onTrackForwarded = null) {
  if (!channelEntity) return false;
  const channelId = utils.getPeerId(channelEntity).toString();
  const session = activePickers.get(channelId);
  if (!session) return false;

  clearTimeout(session.timer);
  activePickers.delete(channelId);

  const candidate = session.candidates.find(c => c.optionNum === optionNum) || session.candidates[0];
  const candTitle = candidate?.title ? `"${candidate.title}"` : `Option ${optionNum}`;

  const updateStatus = async (msg) => {
    await editMenuMessage(client, channelEntity, session.menuMsgId, msg, null, 'Markdown');
  };

  try {
    await updateStatus(`⏳ **Downloading ${candTitle} in Lossless FLAC...**`);

    let audioDocMsg = null;
    if (session.searchMsg) {
      audioDocMsg = await downloadMusicsHuntersDocument(client, session.searchMsg, optionNum, updateStatus);
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

    let channelMsg = (forwarded && forwarded[0] && forwarded[0].id) ? forwarded[0] : null;
    if (!channelMsg) {
      // GramJS returns [undefined] for channel forwards — fetch the newly forwarded message from channel
      const recent = await client.getMessages(channelEntity, { limit: 1 });
      if (recent && recent[0] && recent[0].media?.document) {
        channelMsg = recent[0];
      }
    }

    let forwardResult = null;
    if (onTrackForwarded && channelMsg) {
      try {
        forwardResult = await onTrackForwarded(channelMsg);
      } catch (idxErr) {
        console.warn('[Downloader] Post-forward indexing error:', idxErr.message);
      }
    }

    if (forwardResult && forwardResult.discarded) {
      if (forwardResult.reason === 'lower_quality') {
        await updateStatus(`**Duplicate detected:** Lower quality (${forwardResult.deletedQuality}) than existing copy (${forwardResult.keptQuality}). Deleting in 15s... (Send \`/keep\` to save)`);
      } else {
        await updateStatus(`**Duplicate detected:** Identical copy already in library. Deleting in 15s... (Send \`/keep\` to save)`);
      }
    } else {
      await updateStatus(`✅ **Added ${candTitle} to Music Library!**`);
    }

    setTimeout(() => {
      const msgsToDelete = [session.menuMsgId];
      if (session.originalMsgId) msgsToDelete.push(session.originalMsgId);
      deleteMessagesSafely(client, channelEntity, msgsToDelete).catch(() => {});
    }, 18000);

    return true;
  } catch (err) {
    console.error('[Downloader] Picker choice failed:', err.message);
    await updateStatus(`❌ **Download Failed:** ${err.message}`);
    setTimeout(() => {
      const msgsToDelete = [session.menuMsgId];
      if (session.originalMsgId) msgsToDelete.push(session.originalMsgId);
      deleteMessagesSafely(client, channelEntity, msgsToDelete).catch(() => {});
    }, 10000);
    return false;
  }
}


/**
 * Handles `/s`, `/song`, `#s`, `#song` channel commands.
 * Supports direct URLs, explicit option numbers (`/s <query> <num>`),
 * and interactive 7-option selection menus (`/s <query>`).
 */
async function handleSongCommand(client, channelEntity, commandText, originalMsgId = null, onTrackForwarded = null) {
  const text = commandText.trim();
  const match = text.match(/^[#/](?:song|s)(?:\s+(.+))?$/i);
  if (!match || !match[1]) {
    const helpMsg = await client.sendMessage(channelEntity, {
      message: '**Usage:**\n• `/s <song name>` or `#s <song name>` — browse 7 choices\n• `/s <Spotify / Deezer / Tidal URL>` — direct download'
    });
    setTimeout(() => {
      deleteMessagesSafely(client, channelEntity, [helpMsg.id, originalMsgId]).catch(() => {});
    }, 10000);
    return;
  }

  const queryArg = match[1].trim();
  const channelId = utils.getPeerId(channelEntity).toString();

  // Clear any existing active picker for this channel
  if (activePickers.has(channelId)) {
    const prev = activePickers.get(channelId);
    clearTimeout(prev.timer);
    deleteMessagesSafely(client, channelEntity, [prev.menuMsgId]).catch(() => {});
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

    // CASE 1: Direct Spotify / Deezer / Qobuz / Tidal / Apple Music URL
    if (/^(https?:\/\/)?(open\.spotify\.com|deezer\.com|deezer\.page\.link|qobuz\.com|tidal\.com|music\.apple\.com)/i.test(queryArg)) {
      await updateStatus(`📥 **Downloading FLAC** via @MusicsHuntersbot...`);
      audioDocMsg = await downloadFromMusicsHunters(client, queryArg, 1, updateStatus);
    }
    // CASE 2: Keyword search with explicit option number (e.g. "/s Kesariya 2")
    else if (/^(.+?)\s+([1-9]\d?)$/.test(queryArg)) {
      const numMatch = queryArg.match(/^(.+?)\s+([1-9]\d?)$/);
      const query = numMatch[1].trim();
      const requestedOption = parseInt(numMatch[2], 10);

      await updateStatus(`🔍 Downloading Option ${requestedOption} for **"${query}"** in Lossless FLAC...`);
      audioDocMsg = await downloadFromMusicsHunters(client, query, requestedOption, updateStatus);
    }
    // CASE 3: Standard keyword search on Deezer (@MusicsHuntersbot)
    else {
      let engine = 'deezer';
      let searchResult = null;
      let candidates = [];

      try {
        searchResult = await searchMusicsHunters(client, queryArg, updateStatus);
        if (searchResult && searchResult.candidates.length > 0) {
          candidates = searchResult.candidates;
        }
      } catch (botErr) {
        console.warn('[Downloader] @MusicsHuntersbot search failed:', botErr.message);
      }

      if (candidates.length === 0) {
        throw new Error(`No tracks found for "${queryArg}" on Deezer`);
      }

      // Render interactive selection menu matching reference screenshot
      const menuText = formatPickerMenu(queryArg, candidates, engine, 1);
      const keyboard = buildMusicsHuntersKeyboard(candidates, searchResult?.searchMsg);
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

    let channelMsg = (forwarded && forwarded[0] && forwarded[0].id) ? forwarded[0] : null;
    if (!channelMsg) {
      // GramJS returns [undefined] for channel forwards — fetch the newly forwarded message from channel
      const recent = await client.getMessages(channelEntity, { limit: 1 });
      if (recent && recent[0] && recent[0].media?.document) {
        channelMsg = recent[0];
      }
    }

    let forwardResult = null;
    if (onTrackForwarded && channelMsg) {
      try {
        forwardResult = await onTrackForwarded(channelMsg);
      } catch (idxErr) {
        console.warn('[Downloader] Post-forward indexing error:', idxErr.message);
      }
    }

    if (forwardResult && forwardResult.discarded) {
      if (forwardResult.reason === 'lower_quality') {
        await updateStatus(`**Duplicate detected:** Lower quality (${forwardResult.deletedQuality}) than existing copy (${forwardResult.keptQuality}). Deleting in 15s... (Send \`/keep\` to save)`);
      } else {
        await updateStatus(`**Duplicate detected:** Identical copy already in library. Deleting in 15s... (Send \`/keep\` to save)`);
      }
    } else {
      await updateStatus(`✅ **Added to Music Library!**`);
    }

    setTimeout(() => {
      const msgsToDelete = [statusMsg.id];
      if (originalMsgId) msgsToDelete.push(originalMsgId);
      deleteMessagesSafely(client, channelEntity, msgsToDelete).catch(() => {});
    }, 18000);

  } catch (err) {
    console.error('[Downloader] Song command failed:', err.message);
    await updateStatus(`❌ **Download Failed:** ${err.message}`);
    setTimeout(() => {
      const msgsToDelete = [statusMsg.id];
      if (originalMsgId) msgsToDelete.push(originalMsgId);
      deleteMessagesSafely(client, channelEntity, msgsToDelete).catch(() => {});
    }, 12000);
  }
}

module.exports = {
  downloadFromMusicsHunters,
  handleSongCommand,
  parseBotSearchResults,
  formatPickerMenu,
  buildMusicsHuntersKeyboard,
  searchMusicsHunters,
  downloadMusicsHuntersDocument,
  hasActivePicker,
  isPickerMenu,
  handlePickerChoice,
  cancelPicker,
  navigateBotPicker,
  areCandidatesRelevant,
};

