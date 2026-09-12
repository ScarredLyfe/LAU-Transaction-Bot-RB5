const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { db, ensureGuild } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('set_event_ping')
    .setDescription('Set the role used for Event Ping opt-in/opt-out')
    .addRoleOption(o => o.setName('role').setDescription('The Event Ping role').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    ensureGuild(interaction.guildId);
    const role = interaction.options.getRole('role');
    db.prepare('UPDATE guild_settings SET event_ping_role_id = ? WHERE guild_id = ?').run(role.id, interaction.guildId);
    await interaction.reply({
      content: `✅ Event Ping role set to ${role}.`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  },
};