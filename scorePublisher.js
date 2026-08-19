// Polls Firebase for score-publish requests from the website and posts a plain-text
// matchup line (with the box-score image) to the configured scores channel.
const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { db } = require('./database');

const FB = (process.env.FIREBASE_URL || 'https://lau-website-default-rtdb.firebaseio.com').replace(/\/+$/, '');
const POLL_MS = 8000;

async function processPublish(client, req) {
  const guildId = req.guildId || process.env.GUILD_ID;
  if (!guildId) return;
  const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;

  const settings = db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(guildId);
  const channelId = settings && settings.scores_channel_id;
  if (!channelId) { console.log('[scores] no scores channel set — run /set_scores_channel'); return; }
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel) { console.log('[scores] scores channel not found'); return; }

  const teams = db.prepare('SELECT * FROM teams WHERE guild_id = ?').all(guildId);
  const teamOf = (abbr, name) =>
    teams.find(x => x.name && abbr && String(x.name).toLowerCase() === String(abbr).toLowerCase())
    || teams.find(x => String(x.name).toLowerCase() === String(name || '').toLowerCase());
  const emojiFor = (t) => (t && t.emoji) ? t.emoji + ' ' : '';

  const h = req.home || {}, a = req.away || {};

  // Build the matchup line:
  // (Home Record) HomeEmoji @Home vs @Away AwayEmoji (Away Record)
  const teamStr = (t, side) => {
    const td = teamOf(t.abbr, t.name);
    const at = (td && td.role_id) ? `<@&${td.role_id}>` : `@${t.name || t.abbr}`;
    const emoji = emojiFor(td).trim();
    const rec = t.record ? `(${t.record})` : '';
    if (side === 'left') {
      // (Record) Emoji @Team
      return [rec, emoji, at].filter(Boolean).join(' ');
    } else {
      // @Team Emoji (Record)
      return [at, emoji, rec].filter(Boolean).join(' ');
    }
  };
  const content = `${teamStr(h, 'left')} vs ${teamStr(a, 'right')}`;

  const files = [];
  if (req.image) {
    try {
      const buf = Buffer.from(req.image, 'base64');
      files.push(new AttachmentBuilder(buf, { name: 'boxscore.png' }));
    } catch (e) { console.error('[scores] image decode failed', e); }
  }

  // Show the @team mentions as text without pinging the whole role on every score post.
  await channel.send({ content, files, allowedMentions: { parse: [] } });
  console.log(`[scores] posted ${h.name || h.abbr} vs ${a.name || a.abbr}`);
}

let _polling = false;
async function poll(client) {
  if (_polling) return;        // never let two polls overlap
  _polling = true;
  try {
    const res = await fetch(`${FB}/score_publish_queue.json`);
    const queue = await res.json();
    if (!queue) return;
    for (const [key, req] of Object.entries(queue)) {
      // CLAIM FIRST: delete the entry before posting. If the delete didn't actually remove
      // it (already gone), skip — this guarantees a request is posted at most once even if
      // posting is slow or a later poll overlaps.
      let claimed = false;
      try {
        const del = await fetch(`${FB}/score_publish_queue/${key}.json`, { method: 'DELETE' });
        claimed = del.ok;
      } catch (e) { claimed = false; }
      if (!claimed) continue;
      try { await processPublish(client, req); }
      catch (e) { console.error('[scores] process failed', e); }
    }
  } catch (e) { console.error('[scores] poll error', e); }
  finally { _polling = false; }
}

function start(client) {
  setInterval(() => poll(client), POLL_MS);
  console.log('[scores] score publisher started (polling every ' + (POLL_MS / 1000) + 's)');
}

module.exports = { start };