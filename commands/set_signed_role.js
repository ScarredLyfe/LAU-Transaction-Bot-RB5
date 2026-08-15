const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { db, ensureGuild } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('set_signed_role')
    .setDescription('Set the role given to signed players')
    .addRoleOption(o => o.setName('role').setDescription('The signed role').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    ensureGuild(interaction.guildId);
    const role = interaction.options.getRole('role');
    db.prepare('UPDATE guild_settings SET signed_role_id = ? WHERE guild_id = ?').run(role.id, interaction.guildId);
    await interaction.reply({ content: `Signed role set to ${role}.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  },
};
