const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { db, ensureGuild } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('set_streamer_role')
    .setDescription('Set the role required to claim a game as Web Streamer or Discord Streamer')
    .addRoleOption(o => o.setName('role').setDescription('The streamer role').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    ensureGuild(interaction.guildId);
    const role = interaction.options.getRole('role');
    db.prepare('UPDATE guild_settings SET streamer_role_id = ? WHERE guild_id = ?')
      .run(role.id, interaction.guildId);
    await interaction.reply({
      content: `Streamer role set to ${role}. This role can claim either Web Streamer or Discord Streamer on a posted game.`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  },
};