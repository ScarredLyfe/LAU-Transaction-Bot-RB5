const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { db, ensureGuild } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('set_verified_role')
    .setDescription('Set the role given to members after they register on the website')
    .addRoleOption(o => o.setName('role').setDescription('The verified role').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  async execute(interaction) {
    ensureGuild(interaction.guildId);
    const role = interaction.options.getRole('role');
    db.prepare('UPDATE guild_settings SET verified_role_id = ? WHERE guild_id = ?').run(role.id, interaction.guildId);
    await interaction.reply({ content: `✅ Verified role set to ${role}.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  },
};