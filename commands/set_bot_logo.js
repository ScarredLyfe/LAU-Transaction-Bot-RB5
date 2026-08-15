const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { db, ensureGuild } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('set_bot_logo')
    .setDescription('Set a fallback logo image (used when a team has no emoji/icon)')
    .addStringOption(o => o.setName('image').setDescription('Direct image URL').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    ensureGuild(interaction.guildId);
    const image = interaction.options.getString('image');
    db.prepare('UPDATE guild_settings SET bot_logo = ? WHERE guild_id = ?').run(image, interaction.guildId);
    await interaction.reply({ content: 'League logo updated.', flags: MessageFlags.Ephemeral });
  },
};
