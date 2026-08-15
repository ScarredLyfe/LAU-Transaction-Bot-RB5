const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const { db, ensureGuild } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('view_demands')
    .setDescription('View your (or another player\'s) demand count')
    .addUserOption(o => o.setName('user').setDescription('Leave blank to check yourself')),

  async execute(interaction) {
    ensureGuild(interaction.guildId);
    const settings = db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(interaction.guildId);
    const target = interaction.options.getUser('user') || interaction.user;

    const row = db.prepare('SELECT demands_used FROM players WHERE guild_id = ? AND user_id = ?').get(interaction.guildId, target.id);
    const used = row ? row.demands_used : 0;

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('🔁 Demand Count')
      .setDescription(`${target} has used **${used}/${settings.max_demands}** demands.`);

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  },
};
