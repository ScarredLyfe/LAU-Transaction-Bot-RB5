const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, ChannelType } = require('discord.js');
const { db, ensureGuild } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('set_game_claims')
    .setDescription('Set the channel where /post_game_claim posts games')
    .addChannelOption(o => o.setName('channel').setDescription('The game claims channel').addChannelTypes(ChannelType.GuildText).setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    ensureGuild(interaction.guildId);
    const channel = interaction.options.getChannel('channel');
    db.prepare('UPDATE guild_settings SET game_claims_channel_id = ? WHERE guild_id = ?')
      .run(channel.id, interaction.guildId);
    await interaction.reply({
      content: `✅ Game claims will now be posted in ${channel}.`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  },
};