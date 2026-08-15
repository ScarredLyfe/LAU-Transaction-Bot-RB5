const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { db, ensureGuild } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('removeteam')
    .setDescription('Remove a registered team')
    .addRoleOption(o => o.setName('team').setDescription('The team to remove').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    ensureGuild(interaction.guildId);
    const teamRoleOpt = interaction.options.getRole('team');
    const teams = db.prepare('SELECT * FROM teams WHERE guild_id = ?').all(interaction.guildId);
    const team = teams.find(t => t.role_id === teamRoleOpt.id);
    if (!team) return interaction.reply({ content: 'That role isn\'t a registered team.', flags: MessageFlags.Ephemeral });

    db.prepare('DELETE FROM players WHERE guild_id = ? AND team_id = ?').run(interaction.guildId, team.id);
    db.prepare('DELETE FROM teams WHERE id = ?').run(team.id);

    await interaction.reply({ content: `Removed **${team.name}** from the database.`, flags: MessageFlags.Ephemeral });
  },
};
