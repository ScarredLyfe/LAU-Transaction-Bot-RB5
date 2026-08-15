const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } = require('discord.js');
const { db, ensureGuild } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('set_transaction_channel')
    .setDescription('Set the channel where transaction announcements are posted')
    .addChannelOption(o => o.setName('channel').setDescription('The channel').addChannelTypes(ChannelType.GuildText).setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    ensureGuild(interaction.guildId);
    const channel = interaction.options.getChannel('channel');
    db.prepare('UPDATE guild_settings SET transaction_channel_id = ? WHERE guild_id = ?').run(channel.id, interaction.guildId);
    await interaction.reply({ content: `Transaction channel set to ${channel}.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  },
};
