// Polls Firebase for score-publish requests from the website and posts an embed
// (with the box-score image) to the configured scores channel, then deletes the request.
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

  const leagueName = guild.name;

  const h = req.home || {}, a = req.away || {};
  const line = (t) => {
    const rec = t.record ? '(' + t.record + ') ' : '';
    const td = teamOf(t.abbr, t.name);
    const who = (td && td.role_id) ? `<@&${td.role_id}>` : `**${t.name || t.abbr}**`;
    return `${rec}${emojiFor(td)}${who} \`${t.score}\``;
  };
  const headerLine = req.header || (req.preseason
    ? `Pre-Season · ${req.week}`
    : `Season ${req.season}, Week ${req.week}`);

  let pdb = [];
  try { pdb = (await (await fetch(`${FB}/data/playerdb.json`)).json()) || []; } catch (e) {}
  const idByName = {};
  if (Array.isArray(pdb)) pdb.forEach(p => { if (p && p.name && p.discordId) idByName[String(p.name).toLowerCase()] = p.discordId; });
  const mention = (robloxName, fallback) => {
    const id = robloxName ? idByName[String(robloxName).toLowerCase()] : null;
    return id ? `<@${id}>` : (fallback || '—');
  };
  const potgTxt = mention(req.potgName, req.potg);
  const lpotgTxt = mention(req.lpotgName, req.lpotg);

  const desc =
    `***__${leagueName}__***\n` +
    `${headerLine}\n` +
    `${line(h)}\n${line(a)}\n\n` +
    `**POTG:** ${potgTxt}\n` +
    `**LPOTG:** ${lpotgTxt}`;

  const embed = new EmbedBuilder().setColor(0x4f8ef7).setDescription(desc);

  const files = [];
  if (req.image) {
    try {
      const buf = Buffer.from(req.image, 'base64');
      files.push(new AttachmentBuilder(buf, { name: 'boxscore.png' }));
      embed.setImage('attachment://boxscore.png');
    } catch (e) { console.error('[scores] image decode failed', e); }
  }

  await channel.send({ embeds: [embed], files });
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