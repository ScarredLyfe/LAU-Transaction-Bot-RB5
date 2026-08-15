const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const { db, ensureGuild } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('viewteams')
    .setDescription('View all registered teams'),

  async execute(interaction) {
    ensureGuild(interaction.guildId);
    const teams = db.prepare('SELECT * FROM teams WHERE guild_id = ?').all(interaction.guildId);
    if (teams.length === 0) return interaction.reply({ content: 'No teams are registered yet.', flags: MessageFlags.Ephemeral });

    const lines = teams.map(t => {
      const count = db.prepare('SELECT COUNT(*) AS c FROM players WHERE guild_id = ? AND team_id = ?').get(interaction.guildId, t.id).c;
      return `${t.emoji} **${t.name}** — <@&${t.role_id}> (${count} on roster)`;
    });

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('📋 Registered Teams')
      .setDescription(lines.join('\n'));

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  },
};
