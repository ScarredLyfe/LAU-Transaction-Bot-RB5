const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, ChannelType } = require('discord.js');
const { db, ensureGuild } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('set_franchise')
    .setDescription('Set the channel for the auto-updating franchise board (teams + ADs + roster size)')
    .addChannelOption(o => o.setName('channel').setDescription('The franchise board channel').addChannelTypes(ChannelType.GuildText).setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    ensureGuild(interaction.guildId);
    const channel = interaction.options.getChannel('channel');

    db.prepare('UPDATE guild_settings SET franchise_channel_id = ?, franchise_message_id = NULL WHERE guild_id = ?')
      .run(channel.id, interaction.guildId);

    await interaction.reply({
      content: `✅ Franchise board will be posted in ${channel} and refreshed every hour.`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });

    try { await require('../franchiseBoard').postFranchiseBoard(interaction.client, interaction.guildId); } catch (e) {}
  },
};