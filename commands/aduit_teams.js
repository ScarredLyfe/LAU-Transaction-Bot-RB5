const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, EmbedBuilder } = require('discord.js');
const { db, ensureGuild } = require('../database');

// Diagnostic command: lists every raw row in the teams table, including duplicates/orphans
// whose Discord role was deleted (or never matched one). Normal commands like /removeteam
// only let you pick a currently-existing role, so a row with a dead role_id can never be
// selected there -- this shows its internal database id so /removeteam_by_id can target it.
module.exports = {
  data: new SlashCommandBuilder()
    .setName('audit_teams')
    .setDescription('List every team row in the database, including broken/duplicate ones')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    ensureGuild(interaction.guildId);
    const teams = db.prepare('SELECT * FROM teams WHERE guild_id = ? ORDER BY name').all(interaction.guildId);

    if (teams.length === 0) {
      return interaction.reply({ content: 'No teams in the database.', flags: MessageFlags.Ephemeral });
    }

    const lines = teams.map(t => {
      const roleOk = interaction.guild.roles.cache.has(t.role_id);
      const count = db.prepare('SELECT COUNT(*) AS c FROM players WHERE guild_id = ? AND team_id = ?').get(interaction.guildId, t.id).c;
      const flag = roleOk ? '✅' : '❌ role missing';
      return `\`#${t.id}\` ${flag} — **${t.name || '(blank name)'}** \`role:${t.role_id}\` (${count} on roster)`;
    });

    let body = lines.join('\n');
    if (body.length > 3800) body = body.slice(0, 3800) + '\n…(truncated)';

    const embed = new EmbedBuilder()
      .setTitle('Team Rows (raw database)')
      .setDescription(body)
      .setFooter({ text: 'Rows marked ❌ have no matching Discord role — use /removeteam_by_id to delete a specific one.' });

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  },
};