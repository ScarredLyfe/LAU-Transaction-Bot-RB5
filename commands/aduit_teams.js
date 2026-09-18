const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, EmbedBuilder } = require('discord.js');
const { db, ensureGuild } = require('../database');

const FB = (process.env.FIREBASE_URL || 'https://laurb5data-production.up.railway.app').replace(/\/+$/, '');

// Diagnostic: for every registered team, checks whether its NAME matches a team on the
// website exactly (case-insensitive) -- that match is REQUIRED for /appoint, /offer, and
// /sync to ever write that team's roster to the website. A mismatch here means the bot has
// been silently unable to update that team's website roster at all, no matter what commands
// are run, until the names line up.
module.exports = {
  data: new SlashCommandBuilder()
    .setName('audit_roster_sync')
    .setDescription('Check whether each team\'s name matches the website exactly (required for roster syncing)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    ensureGuild(interaction.guildId);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const teams = db.prepare('SELECT * FROM teams WHERE guild_id = ? ORDER BY name').all(interaction.guildId);
    if (teams.length === 0) return interaction.editReply('No teams registered.');

    let siteTeams = [];
    try {
      const res = await fetch(`${FB}/data/team_defs.json`);
      siteTeams = (await res.json()) || [];
      if (!Array.isArray(siteTeams)) siteTeams = [];
    } catch (e) {
      return interaction.editReply('Couldn\'t reach the website\'s team list — check the data server is up.');
    }

    const siteByLower = new Map(siteTeams.map(t => [String(t.name || '').trim().toLowerCase(), t]));

    const lines = [];
    let mismatches = 0;
    for (const t of teams) {
      const discordName = t.name || '';
      const key = discordName.trim().toLowerCase();
      const hit = siteByLower.get(key);
      if (hit) {
        lines.push(`✅ **${discordName}** → matches website team \`${hit.abbr}\``);
      } else {
        mismatches++;
        const normalize = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const norm = normalize(discordName);
        const near = siteTeams.find(s => normalize(s.name) === norm);
        const hint = near
          ? ` — close match found: website has "${near.name}" (check for extra spaces, punctuation, or an emoji in the Discord role name)`
          : ' — no similar name found on the website at all';
        lines.push(`❌ **${discordName}** → NO MATCH on the website${hint}`);
      }
    }

    let body = lines.join('\n');
    if (body.length > 3800) body = body.slice(0, 3800) + '\n…(truncated)';

    const embed = new EmbedBuilder()
      .setColor(mismatches ? 0xed4245 : 0x22c55e)
      .setTitle('Roster Sync Audit')
      .setDescription(body)
      .setFooter({
        text: mismatches
          ? mismatches + ' team' + (mismatches===1?'':'s') + ' can\'t sync to the website until its name matches exactly.'
          : 'All team names match — roster syncing should work for every team.'
      });

    await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
  },
};