const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { db, ensureGuild } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('set_unverified_role')
    .setDescription('Set the role automatically given to new members until they verify')
    .addRoleOption(o => o.setName('role').setDescription('The unverified role').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  async execute(interaction) {
    ensureGuild(interaction.guildId);
    const role = interaction.options.getRole('role');
    db.prepare('UPDATE guild_settings SET unverified_role_id = ? WHERE guild_id = ?').run(role.id, interaction.guildId);
    await interaction.reply({ content: `✅ Unverified role set to ${role}. New members will get this role automatically.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  },
};