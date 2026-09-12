const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const path = require('path');
const fs = require('fs');

// Image is attached from a local file rather than an external URL -- avoids depending on
// any third-party image host staying up (a hosted-URL version breaks silently once that
// link expires or changes, with no way for the bot to detect or recover from it).
const BANNER_PATH = path.join(__dirname, '..', 'assets', 'website-banner.png');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('website')
    .setDescription('Post the LAU website links')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    const base = (process.env.WEBSITE_URL || 'https://laurb5.com').replace(/\/+$/, '');

    const embed = new EmbedBuilder()
      .setColor(0x4f8ef7)
      .setTitle('LAU Website')
      .setDescription(
        'Welcome to the LAU website. Here you will find all the statistical information you\'ll need to know for the Legacy Athletic Union.\n\n' +
        `**[Visit the website](${base})**`
      )
      .addFields(
        {
          name: '🏀 League',
          value: `[Teams](${base}/teams)\n[Players](${base}/players)\n[Betting](${base}/polls)`,
          inline: true,
        },
        {
          name: '📅 Games',
          value: `[Scores](${base}/scores)\n[Schedule](${base}/schedule)\n[Standings](${base}/standings)\n[Bracket](${base}/bracket)`,
          inline: true,
        },
        {
          name: '📊 Statistics',
          value: `[Stats](${base}/stats)\n[Leaders](${base}/leaders)\n[Records](${base}/records)\n[Power Rankings](${base}/rankings)\n[Compare](${base}/compare)\n[Analytics](${base}/analytics)`,
          inline: true,
        },
      );

    const files = [];
    if (fs.existsSync(BANNER_PATH)) {
      const attachment = new AttachmentBuilder(BANNER_PATH, { name: 'website-banner.png' });
      embed.setImage('attachment://website-banner.png');
      files.push(attachment);
    } else {
      console.warn('[website] banner not found at', BANNER_PATH, '-- posting without image');
    }

    // No ephemeral flag -- this is meant to be visible to everyone in the channel, not
    // just the person running the command.
    await interaction.reply({ embeds: [embed], files });
  },
};