const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, EmbedBuilder } = require('discord.js');
const { db, ensureGuild } = require('../database');

const FB = (process.env.FIREBASE_URL || 'https://laurb5data-production.up.railway.app').replace(/\/+$/, '');
const DATA_KEY = process.env.DATA_API_KEY || '';
function writeHeaders(){
  const h = { 'Content-Type': 'application/json' };
  if (DATA_KEY) h['X-Api-Key'] = DATA_KEY;
  return h;
}

// Rewrites every team's website roster to match the bot's OWN `players` table exactly --
// the same trusted source /audit_rosters compares against. Unlike /sync (which rebuilds its
// roster list by re-scanning current Discord roles, and can miss someone if that scan
// doesn't turn them up for any reason), this reads directly from the bot's database, so it
// fixes both "missing from website" and "stale on website" in one pass without depending on
// a fresh role-scan finding everyone correctly.
module.exports = {
  data: new SlashCommandBuilder()
    .setName('repair_rosters')
    .setDescription('Rewrite every team\'s website roster to exactly match the bot\'s own records')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    ensureGuild(interaction.guildId);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const teams = db.prepare('SELECT * FROM teams WHERE guild_id = ? ORDER BY name').all(interaction.guildId);
    if (teams.length === 0) return interaction.editReply('No teams registered.');

    let playerdb = [], teamDefs = [], seasons = [], currentSeasonId = null;
    try {
      [playerdb, teamDefs, seasons, currentSeasonId] = await Promise.all([
        fetch(`${FB}/data/playerdb.json`).then(r => r.json()),
        fetch(`${FB}/data/team_defs.json`).then(r => r.json()),
        fetch(`${FB}/data/seasons.json`).then(r => r.json()),
        fetch(`${FB}/data/currentSeasonId.json`).then(r => r.json()),
      ]);
      if (!Array.isArray(playerdb)) playerdb = [];
      if (!Array.isArray(teamDefs)) teamDefs = [];
    } catch (e) {
      return interaction.editReply('Couldn\'t reach the website\'s data — check the data server is up.');
    }

    let sid = currentSeasonId;
    if (Array.isArray(seasons)) {
      const active = seasons.find(s => s && s.status === 'active');
      if (active && active.id != null) sid = active.id;
    }
    if (sid == null) return interaction.editReply('Couldn\'t determine the active season on the website. Nothing was changed.');

    let seasonData = {};
    try {
      const r = await fetch(`${FB}/rosters/season_${sid}.json`);
      seasonData = (await r.json()) || {};
    } catch (e) {
      return interaction.editReply('Couldn\'t reach the website\'s roster data. Nothing was changed.');
    }
    if (!seasonData.rosters || typeof seasonData.rosters !== 'object') seasonData.rosters = {};

    const nameByDiscordId = new Map();
    playerdb.forEach(p => { if (p && p.discordId) nameByDiscordId.set(String(p.discordId), p.name); });
    const abbrByTeamName = new Map();
    teamDefs.forEach(t => { if (t && t.name) abbrByTeamName.set(String(t.name).trim().toLowerCase(), t.abbr); });

    let teamsFixed = 0, playersPlaced = 0;
    const skippedNoWebsiteTeam = [];
    const skippedUnregistered = [];

    for (const team of teams) {
      const abbr = abbrByTeamName.get(String(team.name).trim().toLowerCase());
      if (!abbr) { skippedNoWebsiteTeam.push(team.name); continue; }

      const botPlayers = db.prepare('SELECT user_id FROM players WHERE guild_id = ? AND team_id = ?').all(interaction.guildId, team.id);
      const names = [];
      for (const { user_id } of botPlayers) {
        const nm = nameByDiscordId.get(user_id);
        if (nm) names.push(nm);
        else skippedUnregistered.push(user_id);
      }

      const before = JSON.stringify((seasonData.rosters[abbr] || []).slice().sort());
      const after = JSON.stringify(names.slice().sort());
      if (before !== after) teamsFixed++;

      seasonData.rosters[abbr] = names;
      playersPlaced += names.length;
    }

    const res = await fetch(`${FB}/rosters/season_${sid}.json`, {
      method: 'PUT', headers: writeHeaders(), body: JSON.stringify(seasonData),
    });
    if (!res.ok) {
      return interaction.editReply('The website rejected the write (HTTP ' + res.status + '). Nothing was saved — check the data server\'s API key.');
    }

    let msg = `✅ Rebuilt rosters for season ${sid}. ${teamsFixed} team${teamsFixed===1?'':'s'} changed, ${playersPlaced} player${playersPlaced===1?'':'s'} placed.`;
    if (skippedUnregistered.length) {
      msg += `\n\n⚠️ ${skippedUnregistered.length} player${skippedUnregistered.length===1?' is':'s are'} on a bot roster but have no registered website profile, so they couldn't be added: ` +
        [...new Set(skippedUnregistered)].slice(0, 20).map(id => `<@${id}>`).join(', ');
    }
    if (skippedNoWebsiteTeam.length) {
      msg += `\n\n⚠️ These teams have no matching website team, so were skipped entirely: ${skippedNoWebsiteTeam.join(', ')}`;
    }

    await interaction.editReply({ content: msg, allowedMentions: { parse: [] } });
  },
};