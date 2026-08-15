const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { db, ensureGuild } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('set_admin_roles')
    .setDescription('Add a role that can use admin commands')
    .addRoleOption(o => o.setName('role').setDescription('The admin role').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    ensureGuild(interaction.guildId);
    const role = interaction.options.getRole('role');
    db.prepare('INSERT OR IGNORE INTO admin_roles (guild_id, role_id) VALUES (?, ?)').run(interaction.guildId, role.id);
    await interaction.reply({ content: `${role} can now use admin commands.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  },
};
