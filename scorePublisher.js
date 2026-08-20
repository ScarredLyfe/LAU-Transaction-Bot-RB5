// Polls Firebase for score-publish requests from the website and posts an embed
// (with the box-score image) to the configured scores channel.
const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { db } = require('./database');

const FB = 'https://laurh2-default-rtdb.firebaseio.com';
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
  const emojiOf = (t) => (t && t.emoji) ? t.emoji : '';
  const mentionOf = (t) => (t && t.role_id) ? `<@&${t.role_id}>` : null;

  const h = req.home || {}, a = req.away || {};
  const hTeam = teamOf(h.abbr, h.name), aTeam = teamOf(a.abbr, a.name);
  const hName = mentionOf(hTeam) || `**${h.name || h.abbr}**`;
  const aName = mentionOf(aTeam) || `**${a.name || a.abbr}**`;
  const hEmoji = emojiOf(hTeam), aEmoji = emojiOf(aTeam);

  // (Home Record) HomeEmoji @Home  vs  @Away AwayEmoji (Away Record)
  const homeSide = `${h.record ? '(' + h.record + ') ' : ''}${hEmoji ? hEmoji + ' ' : ''}${hName}`;
  const awaySide = `${aName}${aEmoji ? ' ' + aEmoji : ''}${a.record ? ' (' + a.record + ')' : ''}`;
  const content = `${homeSide} vs ${awaySide}`;

  const files = [];
  if (req.image) {
    try {
      const buf = Buffer.from(req.image, 'base64');
      files.push(new AttachmentBuilder(buf, { name: 'boxscore.png' }));
    } catch (e) { console.error('[scores] image decode failed', e); }
  }

  // Plain message (no embed). Suppress pings so the @team mentions render but don't notify.
  await channel.send({ content, files, allowedMentions: { parse: [] } });
  console.log(`[scores] posted ${h.name || h.abbr} vs ${a.name || a.abbr}`);
}

async function poll(client) {
  try {
    const res = await fetch(`${FB}/score_publish_queue.json`);
    const queue = await res.json();
    if (!queue) return;
    for (const [key, req] of Object.entries(queue)) {
      try { await processPublish(client, req); }
      catch (e) { console.error('[scores] process failed', e); }
      // Always remove the request so it isn't posted twice.
      await fetch(`${FB}/score_publish_queue/${key}.json`, { method: 'DELETE' }).catch(() => {});
    }
  } catch (e) { console.error('[scores] poll error', e); }
}

function start(client) {
  setInterval(() => poll(client), POLL_MS);
  console.log('[scores] score publisher started (polling every ' + (POLL_MS / 1000) + 's)');
}

module.exports = { start };