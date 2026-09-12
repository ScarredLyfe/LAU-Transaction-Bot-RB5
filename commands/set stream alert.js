const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { db, ensureGuild } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('set_stream_alert')
    .setDescription('Set the role used for Stream Alert opt-in/opt-out')
    .addRoleOption(o => o.setName('role').setDescription('The Stream Alert role').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    ensureGuild(interaction.guildId);
    const role = interaction.options.getRole('role');
    db.prepare('UPDATE guild_settings SET stream_alert_role_id = ? WHERE guild_id = ?').run(role.id, interaction.guildId);
    await interaction.reply({
      content: `✅ Stream Alert role set to ${role}.`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  },
};