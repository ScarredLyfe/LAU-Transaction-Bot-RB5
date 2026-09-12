const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { db, ensureGuild } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('set_media_ping')
    .setDescription('Set the role used for Media Ping opt-in/opt-out')
    .addRoleOption(o => o.setName('role').setDescription('The Media Ping role').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    ensureGuild(interaction.guildId);
    const role = interaction.options.getRole('role');
    db.prepare('UPDATE guild_settings SET media_ping_role_id = ? WHERE guild_id = ?').run(role.id, interaction.guildId);
    await interaction.reply({
      content: `✅ Media Ping role set to ${role}.`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  },
};