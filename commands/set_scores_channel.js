const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, ChannelType } = require('discord.js');
const { db, ensureGuild } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('set_scores_channel')
    .setDescription('Set the channel where published game scores are posted')
    .addChannelOption(o => o.setName('channel').setDescription('The scores channel').addChannelTypes(ChannelType.GuildText).setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    ensureGuild(interaction.guildId);
    const channel = interaction.options.getChannel('channel');
    db.prepare('UPDATE guild_settings SET scores_channel_id = ? WHERE guild_id = ?')
      .run(channel.id, interaction.guildId);
    await interaction.reply({
      content: `✅ Scores will now be posted in ${channel}. Use the **Publish Score** button on a game's box score on the website.`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  },
};