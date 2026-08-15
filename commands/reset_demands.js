const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { db, ensureGuild } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('reset_demands')
    .setDescription('Reset demand counts for one player or everyone')
    .addUserOption(o => o.setName('user').setDescription('Leave blank to reset everyone'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    ensureGuild(interaction.guildId);
    const user = interaction.options.getUser('user');

    if (user) {
      db.prepare('UPDATE players SET demands_used = 0 WHERE guild_id = ? AND user_id = ?').run(interaction.guildId, user.id);
      await interaction.reply({ content: `Reset demands for ${user}.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    } else {
      db.prepare('UPDATE players SET demands_used = 0 WHERE guild_id = ?').run(interaction.guildId);
      await interaction.reply({ content: 'Reset demands for everyone in this server.', flags: MessageFlags.Ephemeral });
    }
  },
};
