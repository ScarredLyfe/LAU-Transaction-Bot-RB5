const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, EmbedBuilder } = require('discord.js');
const { db, ensureGuild } = require('../database');

const FB = (process.env.FIREBASE_URL || 'https://laurb5data-production.up.railway.app').replace(/\/+$/, '');

// Direct comparison: the bot's own `players` table (updated by /appoint, /offer, /release,
// /demand, /disband, /sync -- the actual source of truth for "who's on this team") vs. what's
// really sitting in that team's roster array on the website. Reports both directions:
//   - MISSING: the bot thinks they're on the team, but the website roster doesn't have them
//     (a write never landed -- usually an unregistered player, a name mismatch, or the write
//     silently failing).
//   - STALE: the website roster lists someone the bot does NOT have on that team anymore
//     (a leftover name from before a release/transfer/Roblox username change that never got
//     cleaned out, because removal always searches by a player's CURRENT name, not whatever
//     name was written into the roster originally).
module.exports = {
  data: new SlashCommandBuilder()
    .setName('audit_rosters')
    .setDescription('Compare the bot\'s roster records against what\'s actually on the website, team by team')
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
    if (sid == null) return interaction.editReply('Couldn\'t determine the active season on the website.');

    let seasonRosters = {};
    try {
      const r = await fetch(`${FB}/rosters/season_${sid}.json`);
      const j = await r.json();
      seasonRosters = (j && j.rosters) || {};
    } catch (e) {
      return interaction.editReply('Couldn\'t reach the website\'s roster data for the active season.');
    }

    const nameByDiscordId = new Map();
    playerdb.forEach(p => { if (p && p.discordId) nameByDiscordId.set(String(p.discordId), p.name); });
    const abbrByTeamName = new Map();
    teamDefs.forEach(t => { if (t && t.name) abbrByTeamName.set(String(t.name).trim().toLowerCase(), t.abbr); });

    const lines = [];
    let totalIssues = 0;

    for (const team of teams) {
      const abbr = abbrByTeamName.get(String(team.name).trim().toLowerCase());
      if (!abbr) {
        lines.push(`⚠️ **${team.name}** — no matching website team (run /audit_roster_sync)`);
        totalIssues++;
        continue;
      }

      const botPlayers = db.prepare('SELECT user_id FROM players WHERE guild_id = ? AND team_id = ?').all(interaction.guildId, team.id);
      const botNames = new Set();
      const unresolvedIds = [];
      for (const { user_id } of botPlayers) {
        const nm = nameByDiscordId.get(user_id);
        if (nm) botNames.add(nm.toLowerCase());
        else unresolvedIds.push(user_id);
      }

      const siteRoster = Array.isArray(seasonRosters[abbr]) ? seasonRosters[abbr] : [];
      const siteNames = new Set(siteRoster.map(n => String(n || '').toLowerCase()));

      const missing = [...botNames].filter(n => !siteNames.has(n));
      const stale = siteRoster.filter(n => !botNames.has(String(n || '').toLowerCase()));

      if (missing.length || stale.length || unresolvedIds.length) {
        totalIssues++;
        let line = `❌ **${team.name}** (\`${abbr}\`)`;
        if (missing.length) line += `\n   Missing from website: ${missing.map(n => '`'+n+'`').join(', ')}`;
        if (stale.length) line += `\n   Stale on website (not on bot's roster): ${stale.map(n => '`'+n+'`').join(', ')}`;
        if (unresolvedIds.length) line += `\n   On bot's roster but not registered on the site: ${unresolvedIds.map(id => `<@${id}>`).join(', ')}`;
        lines.push(line);
      } else {
        lines.push(`✅ **${team.name}** (\`${abbr}\`) — matches`);
      }
    }

    let body = lines.join('\n\n');
    if (body.length > 3800) body = body.slice(0, 3800) + '\n…(truncated, fix these first)';

    const embed = new EmbedBuilder()
      .setColor(totalIssues ? 0xed4245 : 0x22c55e)
      .setTitle('Roster Accuracy Audit — Season ' + sid)
      .setDescription(body)
      .setFooter({ text: totalIssues ? totalIssues + ' team(s) have a mismatch.' : 'Every team matches exactly.' });

    await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
  },
};