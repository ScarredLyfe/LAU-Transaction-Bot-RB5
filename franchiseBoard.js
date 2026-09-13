// Posts an auto-updating "franchise board" -- every team, its athletic director (owner),
// and current roster size -- to a configured channel, deleting the previous post before
// each refresh so there's only ever one live copy instead of the channel filling up.
const { EmbedBuilder } = require('discord.js');
const { db } = require('./database');

const REFRESH_MS = 60 * 60 * 1000; // every hour

async function postFranchiseBoard(client, guildId) {
  const settings = db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(guildId);
  if (!settings || !settings.franchise_channel_id) return;

  const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;
  const channel = await guild.channels.fetch(settings.franchise_channel_id).catch(() => null);
  if (!channel) return;

  const teams = db.prepare('SELECT * FROM teams WHERE guild_id = ? ORDER BY name').all(guildId);
  const rosterSize = settings.roster_size || 10;

  const lines = teams.map(t => {
    const count = db.prepare('SELECT COUNT(*) AS c FROM players WHERE guild_id = ? AND team_id = ?').get(guildId, t.id).c;
    const owner = t.owner_id ? `<@${t.owner_id}>` : 'Open';
    const roleTag = guild.roles.cache.has(t.role_id) ? `<@&${t.role_id}>` : t.name;
    return `${t.emoji || ''} ${roleTag}: ${owner} (${count}/${rosterSize})`;
  });

  const embed = new EmbedBuilder()
    .setColor(0x4f8ef7)
    .setTitle('Franchise Board')
    .setDescription(lines.length ? lines.join('\n') : 'No teams yet.')
    .setTimestamp();

  // Delete the previous board message before posting a fresh one, so there's only ever
  // one live copy in the channel instead of it filling up with an hourly post.
  if (settings.franchise_message_id) {
    try {
      const old = await channel.messages.fetch(settings.franchise_message_id);
      await old.delete();
    } catch (e) { /* already gone -- fine, nothing to clean up */ }
  }

  try {
    const posted = await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    db.prepare('UPDATE guild_settings SET franchise_message_id = ? WHERE guild_id = ?').run(posted.id, guildId);
  } catch (e) {
    console.error('[franchise] post failed', e);
  }
}

async function refreshAll(client) {
  const rows = db.prepare('SELECT guild_id FROM guild_settings WHERE franchise_channel_id IS NOT NULL').all();
  for (const row of rows) {
    try { await postFranchiseBoard(client, row.guild_id); }
    catch (e) { console.error('[franchise] refresh failed for', row.guild_id, e); }
  }
}

function start(client) {
  refreshAll(client).catch(() => {}); // post once immediately on startup, rather than waiting up to an hour
  setInterval(() => refreshAll(client), REFRESH_MS);
  console.log('[franchise] franchise board watcher started (refreshing every hour)');
}

module.exports = { start, postFranchiseBoard, refreshAll };