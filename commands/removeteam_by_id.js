const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { db, ensureGuild } = require('../database');

// Fallback for /removeteam: that command requires picking a live Discord role, so a team
// row whose role was deleted (or never matched one) can never be selected there. This
// deletes a row directly by its internal database id (see /audit_teams for the ids).
module.exports = {
  data: new SlashCommandBuilder()
    .setName('removeteam_by_id')
    .setDescription('Remove a team row by its database id (use /audit_teams to find it)')
    .addIntegerOption(o => o.setName('id').setDescription('The team row id from /audit_teams').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    ensureGuild(interaction.guildId);
    const id = interaction.options.getInteger('id');

    const team = db.prepare('SELECT * FROM teams WHERE id = ? AND guild_id = ?').get(id, interaction.guildId);
    if (!team) {
      return interaction.reply({ content: `No team row with id #${id} in this server.`, flags: MessageFlags.Ephemeral });
    }

    db.prepare('DELETE FROM players WHERE guild_id = ? AND team_id = ?').run(interaction.guildId, team.id);
    db.prepare('DELETE FROM teams WHERE id = ?').run(team.id);

    await interaction.reply({
      content: `Removed team row \`#${id}\` (**${team.name || '(blank name)'}**, role \`${team.role_id}\`) from the database.`,
      flags: MessageFlags.Ephemeral,
    });

    try { await require('../franchiseBoard').postFranchiseBoard(interaction.client, interaction.guildId); } catch (e) {}
  },
};