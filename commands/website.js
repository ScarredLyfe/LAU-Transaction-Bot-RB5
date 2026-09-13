const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const path = require('path');
const fs = require('fs');

// The banner is attached from a local file rather than a hosted URL -- a third-party image
// host going down or expiring a link breaks the embed silently, with no way for the bot to
// notice or recover.
//
// Rather than hardcoding one filename, this picks up whatever image is sitting in assets/.
// Preference order: a file whose name mentions "banner", then "website", then the first
// image found. Linux is case-sensitive, so matching is done lowercased -- that avoids the
// classic "works on my Windows machine, missing on the server" filename-casing trap.
const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

function findBanner() {
  let files;
  try {
    files = fs.readdirSync(ASSETS_DIR);
  } catch (err) {
    console.warn('[website] no assets folder at', ASSETS_DIR);
    return null;
  }
  const images = files.filter(f => IMAGE_EXTS.includes(path.extname(f).toLowerCase()));
  if (!images.length) {
    console.warn('[website] assets folder has no image files:', files.join(', ') || '(empty)');
    return null;
  }
  const pick =
    images.find(f => f.toLowerCase().includes('banner')) ||
    images.find(f => f.toLowerCase().includes('website')) ||
    images[0];
  console.log('[website] using banner:', pick);
  return path.join(ASSETS_DIR, pick);
}

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

    // Re-read the folder on every call so swapping the image out doesn't need a redeploy.
    const bannerPath = findBanner();
    const files = [];
    if (bannerPath) {
      // Attach under a fixed name so the embed reference below always matches, whatever
      // the file is actually called on disk.
      const ext = path.extname(bannerPath).toLowerCase();
      const attachName = 'website-banner' + ext;
      files.push(new AttachmentBuilder(bannerPath, { name: attachName }));
      embed.setImage('attachment://' + attachName);
    } else {
      console.warn('[website] posting without an image');
    }

    // No ephemeral flag -- this is meant to be visible to everyone in the channel, not
    // just the person running the command.
    await interaction.reply({ embeds: [embed], files });
  },
};