const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } = require('discord.js');
const { db, ensureGuild } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('set_lfp')
    .setDescription('Set the Looking For Players channel')
    .addChannelOption(o => o.setName('channel').setDescription('The LFP channel').addChannelTypes(ChannelType.GuildText).setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    ensureGuild(interaction.guildId);
    const channel = interaction.options.getChannel('channel');
    db.prepare('UPDATE guild_settings SET lfp_channel_id = ? WHERE guild_id = ?').run(channel.id, interaction.guildId);
    await interaction.reply({ content: `LFP channel set to ${channel}.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  },
};
