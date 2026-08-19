const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { db, ensureGuild } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('verify_panel')
    .setDescription('Post the verification panel in this channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  async execute(interaction) {
    ensureGuild(interaction.guildId);

    const embed = new EmbedBuilder()
      .setColor(0x4f8ef7)
      .setTitle(`Welcome to ${interaction.guild.name}!`)
      .setDescription('Click the button below to verify and gain access to the rest of the server.');
    const logo = interaction.guild.iconURL();
    if (logo) embed.setThumbnail(logo);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('verify_btn').setLabel('Verify').setStyle(ButtonStyle.Success),
    );

    await interaction.channel.send({ embeds: [embed], components: [row] });
    await interaction.reply({ content: '✅ Verification panel posted.', flags: MessageFlags.Ephemeral });
  },
};